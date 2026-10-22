/**
 * Long poll: how the panel learns that the document changed.
 *
 * The interesting cases are all timing cases, so this drives a real HTTP server rather
 * than a fake request object: "returns immediately when it is already stale" and
 * "returns at the ceiling when nothing happens" are the two ways a long poll can
 * quietly turn into a busy loop or a hang.
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createChangeFeed } from '../src/change-feed.ts'
import { installRoutes, type RouteHost } from '../src/routes.ts'
import { BuiltinPlanCache } from '../src/builtin-plan.ts'
import { createMemoryStore } from '../src/store/memory.ts'

/** A minimal host that dispatches by prefix, like the harness's web server. */
function hostOf(server: ReturnType<typeof createServer>): RouteHost {
  type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const routes: { kind: 'exact' | 'prefix'; path: string; handler: Handler }[] = []
  server.on('request', (req, res) => {
    const url = req.url ?? ''
    for (const route of routes) {
      const match = route.kind === 'exact' ? url === route.path : url.startsWith(route.path)
      if (!match) continue
      void route.handler(req, res)
      return
    }
    res.writeHead(404).end('no route')
  })
  return {
    register(definition: { kind: 'exact' | 'prefix'; path: string; handler: Handler }) {
      routes.push(definition)
      return () => {
        const index = routes.indexOf(definition)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  } as unknown as RouteHost
}

/** Boot a server with the routes mounted, and hand back its base URL. */
async function serve(
  feed: ReturnType<typeof createChangeFeed>,
  waitTimeoutMs = 150,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer()
  installRoutes(hostOf(server), {
    store: createMemoryStore(),
    builtin: new BuiltinPlanCache(),
    subscribe: (listener) => feed.subscribe(listener),
    revision: () => feed.revision,
    waitTimeoutMs,
    now: () => 1_800_000_000_000,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe('long poll', () => {
  it('answers immediately when the caller is already behind', async () => {
    const feed = createChangeFeed()
    feed.notify()
    feed.notify()
    feed.notify()
    const { base, close } = await serve(feed)
    try {
      const started = Date.now()
      const response = await fetch(`${base}/task-atlas/wait?revision=0`)
      const body = (await response.json()) as { ok: boolean; revision: number }
      assert.equal(body.ok, true)
      assert.equal(body.revision, 3)
      assert.ok(Date.now() - started < 100, 'a stale caller must not wait')
    } finally {
      await close()
    }
  })

  it('waits for a change and returns the new revision', async () => {
    const feed = createChangeFeed()
    const { base, close } = await serve(feed, 5_000)
    try {
      const pending = fetch(`${base}/task-atlas/wait?revision=0`).then(
        (response) => response.json() as Promise<{ ok: boolean; revision: number }>,
      )
      // Give the request time to actually be waiting before publishing.
      await new Promise((resolve) => setTimeout(resolve, 100))
      feed.notify()
      const body = await pending
      assert.equal(body.ok, true)
      assert.equal(body.revision, 1)
    } finally {
      await close()
    }
  })

  it('gives up at the ceiling when nothing changes', async () => {
    const feed = createChangeFeed()
    const { base, close } = await serve(feed, 140)
    try {
      const started = Date.now()
      const response = await fetch(`${base}/task-atlas/wait?revision=0`)
      const body = (await response.json()) as { ok: boolean; revision: number }
      const elapsed = Date.now() - started
      assert.equal(body.ok, true)
      assert.equal(body.revision, 0, 'no change happened, so the revision is unchanged')
      assert.ok(elapsed >= 120, `the ceiling should have been honoured (waited ${elapsed}ms)`)
      assert.ok(elapsed < 2_000, 'and it must not hang')
    } finally {
      await close()
    }
  })

  it('reports a revision on the snapshot, which is what the poll cursor uses', async () => {
    const feed = createChangeFeed()
    feed.notify()
    const { base, close } = await serve(feed)
    try {
      // An explicit cwd is needed: without a session, a corpus, or an observed event
      // there is no workspace to report, and /state would answer NO_WORKSPACE.
      const response = await fetch(
        `${base}/task-atlas/state?cwd=${encodeURIComponent('D:\\somewhere')}`,
      )
      const body = (await response.json()) as { ok: boolean; revision?: number; code?: string }
      assert.equal(body.ok, true, `state should resolve: ${body.code ?? ''}`)
      assert.equal(body.revision, 1)
    } finally {
      await close()
    }
  })
})
