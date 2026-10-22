/**
 * Host-half dry run.
 *
 * `apply()` is where the plugin meets the harness, and it is the part unit tests
 * otherwise never touch: service names, effect ownership, route registration,
 * the event subscription, and the Markdown write. This drives the real `apply`
 * against a hand-built context, which catches wiring mistakes without a running
 * DSH (a restart is expensive and drops the user's session).
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { parseBackup } from '../src/backup.ts'
import type { AtlasDocument } from '../src/model/types.ts'

/** Fixed clock so corpus ordering assertions are stable. */
const START = 1_800_000_000_000

interface FakeTable {
  raw: Map<string, AtlasDocument>
  get(key: string): AtlasDocument | undefined
  put(key: string, value: AtlasDocument): Promise<void>
  update(key: string, fn: (current: AtlasDocument) => AtlasDocument): Promise<AtlasDocument>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, AtlasDocument]>
  keys(): IterableIterator<string>
  readonly size: number
}

function makeTable(): FakeTable {
  const raw = new Map<string, AtlasDocument>()
  return {
    raw,
    get: (key) => raw.get(key),
    async put(key, value) {
      raw.set(key, value)
    },
    async update(key, fn) {
      const current = raw.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      raw.set(key, next)
      return next
    },
    async delete(key) {
      return raw.delete(key)
    },
    entries: () => raw.entries(),
    keys: () => raw.keys(),
    get size() {
      return raw.size
    },
  }
}

interface FakeContext {
  tools: ToolDefinition[]
  routes: { kind: string; path: string }[]
  listeners: ((session: unknown, event: unknown) => void)[]
  opened: string[]
  closed: string[]
  effects: number
  info: string[]
  warnings: string[]
  /** Corpus the fake `sessionQuery` reports, as `listSessions()` would. */
  sessionRecords: { header: { id: string; cwd?: string; createdAt: number } }[]
  /** Events the fake `sessionQuery` reports for the asked session. */
  sessionEvents: { type: string }[]
}

function makeContext(): { ctx: Context; fake: FakeContext } {
  const fake: FakeContext = {
    tools: [],
    routes: [],
    listeners: [],
    opened: [],
    closed: [],
    effects: 0,
    info: [],
    warnings: [],
    sessionRecords: [],
    sessionEvents: [],
  }

  const ctx = {
    effect(fn: () => unknown) {
      fake.effects += 1
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
    on(event: string, listener: (session: unknown, event: unknown) => void) {
      if (event === 'session/event') fake.listeners.push(listener)
      return () => {}
    },
    // Mirrors cordis: run the callback once the named services exist.
    inject(dependencies: string[], callback: (scoped: unknown) => void) {
      if (dependencies.includes('sessionQuery')) {
        callback({
          sessionQuery: {
            listSessions: async () => fake.sessionRecords,
            listEvents: async () => fake.sessionEvents,
          },
        })
      }
      if (dependencies.includes('storageDomain')) {
        callback({
          storageDomain: ctx.storageDomain,
          effect: ctx.effect,
        })
      }
      if (dependencies.includes('webServer')) {
        callback({ webServer: ctx.webServer })
      }
      return () => {}
    },
    logger() {
      return {
        info: (message: string) => fake.info.push(message),
        warn: (message: string) => fake.warnings.push(message),
      }
    },
    tools: {
      register(definition: ToolDefinition) {
        fake.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(route: { kind: string; path: string }) {
        fake.routes.push({ kind: route.kind, path: route.path })
        return () => {}
      },
    },
    storageDomain: {
      async open(spec: { name: string }) {
        fake.opened.push(spec.name)
        const table = makeTable()
        return {
          name: spec.name,
          table: () => table,
          async close() {
            fake.closed.push(spec.name)
          },
        }
      },
    },
  }

  return { ctx: ctx as unknown as Context, fake }
}

function session(cwd: string) {
  return { id: 'sess-test', header: { cwd } }
}

describe('apply()', () => {
  let workspace: string

  before(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'atlas-apply-'))
  })

  after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('opens the storage domain, registers the tools and the route', async () => {
    const { ctx, fake } = makeContext()
    await apply(ctx, {})

    assert.deepEqual(fake.opened, ['dsh_task_atlas'], 'the domain name must satisfy UNIT_NAME_RE')
    assert.equal(fake.tools.length, 19)
    assert.deepEqual(
      fake.tools.map((tool) => tool.name).sort(),
      [
        'atlas_branch_create',
        'atlas_branch_resolve',
        'atlas_breakdown_amend',
        'atlas_breakdown_confirm',
        'atlas_breakdown_draft',
        'atlas_confirm',
        'atlas_focus',
        'atlas_node_add',
        'atlas_node_delete',
        'atlas_node_done',
        'atlas_node_move',
        'atlas_node_status',
        'atlas_node_update',
        'atlas_output_add',
        'atlas_output_remove',
        'atlas_restore',
        'atlas_status',
        'atlas_tidy_titles',
        'atlas_workspace_history',
      ],
    )
    assert.deepEqual(fake.routes, [{ kind: 'prefix', path: '/task-atlas' }])
    assert.equal(fake.listeners.length, 1, 'one session/event subscription')
    assert.ok(fake.info.length > 0, 'logs a load line')
    assert.ok(
      fake.info.some((line) => line.includes('session corpus wired')),
      'the session corpus must be wired when the service is present',
    )
  })

  it('survives a composition with no session-query service', async () => {
    const { ctx, fake } = makeContext()
    const base = ctx as unknown as {
      inject?: (deps: string[], cb: (scoped: unknown) => void) => unknown
      storageDomain: unknown
      webServer: unknown
      effect: unknown
    }
    const bare = {
      ...(ctx as unknown as Record<string, unknown>),
      inject(dependencies: string[], callback: (scoped: unknown) => void) {
        // Only `sessionQuery` never arrives; storage and the web server still do,
        // so the plugin must come up fully and merely lose the history probe.
        if (dependencies.includes('sessionQuery')) return () => {}
        if (dependencies.includes('storageDomain')) {
          callback({ storageDomain: base.storageDomain, effect: base.effect })
        }
        if (dependencies.includes('webServer')) callback({ webServer: base.webServer })
        return () => {}
      },
    } as unknown as Context
    await apply(bare, {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fake.tools.length, 19, 'tools still register')
    assert.equal(fake.routes.length, 1, 'routes still register')
    const history = fake.tools.find((tool) => tool.name === 'atlas_workspace_history')
    assert.ok(history)
    const result = (await history.execute({}, {} as never)) as {
      ok: boolean
      code?: string
      summary: string
    }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_HISTORY_PROBE')
  })

  it('reports prior sessions for the workspace through the corpus', async () => {    const { ctx, fake } = makeContext()
    fake.sessionRecords = [
      { header: { id: 'older-1', cwd: workspace, createdAt: START - 5000 } },
      { header: { id: 'older-2', cwd: workspace, createdAt: START - 9000 } },
      { header: { id: 'sess-test', cwd: workspace, createdAt: START } },
      { header: { id: 'elsewhere', cwd: 'D:\\other', createdAt: START - 100 } },
    ]
    await apply(ctx, {})
    const history = fake.tools.find((tool) => tool.name === 'atlas_workspace_history')
    assert.ok(history)
    const result = (await history.execute(
      {},
      { agent: { session: session(workspace) } } as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, true)
    assert.match(result.summary, /有 2 个会话/)
    assert.match(result.summary, /不要重新盘问用户/)
    assert.match(result.summary, /older-1/)
    assert.doesNotMatch(result.summary, /sess-test/, 'the current session is not history')
  })

  it('treats one long, dense current session as prior work', async () => {
    const { ctx, fake } = makeContext()
    // No other conversations: the only evidence is how thick this thread already is.
    fake.sessionEvents = [
      { type: 'user/message' },
      { type: 'turn/start' },
      { type: 'assistant/message' },
      { type: 'user/message' },
      { type: 'turn/start' },
      { type: 'assistant/message' },
      { type: 'user/message' },
      { type: 'turn/start' },
    ]
    await apply(ctx, {})
    const history = fake.tools.find((tool) => tool.name === 'atlas_workspace_history')
    assert.ok(history)
    const result = (await history.execute(
      {},
      { agent: { session: session(workspace) } } as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, true)
    assert.match(result.summary, /当前这个会话本身已经很长/)
    assert.match(result.summary, /3 条你的消息/)
    assert.match(result.summary, /不要重新盘问用户/)
  })

  it('still calls a genuinely blank workspace blank', async () => {
    const { ctx, fake } = makeContext()
    fake.sessionEvents = [{ type: 'user/message' }, { type: 'turn/start' }]
    await apply(ctx, {})
    const history = fake.tools.find((tool) => tool.name === 'atlas_workspace_history')
    assert.ok(history)
    const result = (await history.execute(
      {},
      { agent: { session: session(workspace) } } as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, true)
    assert.match(result.summary, /没有前情/)
    assert.match(result.summary, /问用户走「快速拆解」还是「详细拆解」/)
  })

  it('registers nothing when disabled', async () => {
    const { ctx, fake } = makeContext()
    await apply(ctx, { enabled: false })
    assert.equal(fake.tools.length, 0)
    assert.equal(fake.routes.length, 0)
    assert.equal(fake.opened.length, 0)
    assert.equal(fake.listeners.length, 0)
  })

  it('closes the domain on the ownership disposer', async () => {
    const { ctx, fake } = makeContext()
    const disposers: (() => void)[] = []
    const base = ctx as unknown as {
      inject?: (deps: string[], cb: (scoped: unknown) => void) => unknown
      storageDomain: unknown
      webServer: unknown
    }
    const collect = (fn: () => unknown): (() => void) => {
      const dispose = fn()
      disposers.push(() => {
        if (typeof dispose === 'function') (dispose as () => void)()
      })
      return () => {}
    }
    const trackedEffect = (fn: () => unknown) => collect(fn)
    const wrapped = {
      ...(ctx as unknown as Record<string, unknown>),
      effect: trackedEffect,
      inject(dependencies: string[], callback: (scoped: unknown) => void) {
        if (dependencies.includes('sessionQuery')) {
          callback({
            sessionQuery: {
              listSessions: async () => fake.sessionRecords,
              listEvents: async () => fake.sessionEvents,
            },
          })
        }
        if (dependencies.includes('storageDomain')) {
          // The domain's teardown is owned by the *scoped* context, so the scoped
          // effect must be the tracking one.
          callback({ storageDomain: base.storageDomain, effect: trackedEffect })
        }
        if (dependencies.includes('webServer')) callback({ webServer: base.webServer })
        return () => {}
      },
    } as unknown as Context

    await apply(wrapped, {})
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fake.closed.length, 0)
    for (const dispose of disposers) dispose()
    assert.deepEqual(fake.closed, ['dsh_task_atlas'])
  })

  it('mirrors the plan into the workspace on a turn boundary', async () => {
    const { ctx, fake } = makeContext()
    await apply(ctx, {})

    // A tool writes through the store the route/tools share.
    const breakdown = fake.tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
    assert.ok(breakdown)
    const exec = { agent: { session: session(workspace) } }
    const created = (await breakdown.execute(
      {
        title: '任务图谱',
        coreIntent: '让长对话不丢任务全貌',
        deliverables: [{ text: '右侧任务树', acceptance: '重启后出现 tab' }],
        decomposition: ['1 打通右侧栏', '2 启动拆解'],
        acceptance: '四个状态可回写',
        outOfScope: [],
        constraints: ['DSH 0.2.0-rc.2'],
        priorityOrder: [],
        mode: 'fast',
      },
      exec as never,
    )) as { ok: boolean; summary: string }
    assert.equal(created.ok, true, created.summary)

    // The harness's own plan, observed read-only.
    const listener = fake.listeners[0]
    assert.ok(listener)
    listener(session(workspace), {
      type: 'todo/write',
      data: { todos: [{ content: '读类型定义', status: 'completed' }] },
    })

    // A turn boundary schedules the debounced mirror write.
    listener(session(workspace), { type: 'turn/end', data: {} })
    await new Promise((resolve) => setTimeout(resolve, 400))

    const markdown = await readFile(path.join(workspace, '.dsh', 'task-atlas.md'), 'utf8')
    assert.match(markdown, /# 任务图谱/)
    assert.match(markdown, /让长对话不丢任务全貌/)
    assert.match(markdown, /1 打通右侧栏/)
    assert.match(markdown, /\[x\] 读类型定义/, 'the built-in todo is mirrored read-only')

    // The same boundary must also write the lossless copy: it is the only artifact the
    // restore path can read back, so "the mirror is written" has to mean both files.
    const backupText = await readFile(path.join(workspace, '.dsh', 'task-atlas.json'), 'utf8')
    const backup = parseBackup(backupText)
    assert.equal(backup.ok, true, backup.ok ? '' : backup.reason)
    if (backup.ok) {
      assert.equal(backup.document.projects[0]?.title, '任务图谱')
      assert.equal(backup.document.projects[0]?.breakdown?.coreIntent, '让长对话不丢任务全貌')
    }
    assert.equal(fake.warnings.length, 0, `no warnings: ${fake.warnings.join('; ')}`)
  })
})
