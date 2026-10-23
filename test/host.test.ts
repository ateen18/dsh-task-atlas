/**
 * Host layer: the storage adapter, the built-in plan mirror, the Markdown
 * mirror, the confirmation path shared by tool and route, and the routes
 * themselves driven through fake req/res objects.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BuiltinPlanCache } from '../src/builtin-plan.ts'
import { applyConfirmation } from '../src/confirm.ts'
import { renderWorkspaceMarkdown } from '../src/markdown.ts'
import { installRoutes, type RouteHost } from '../src/routes.ts'
import { emptyDocument } from '../src/store/document.ts'
import { domainStoreOf, atlasDocumentSchema, type DocumentTable } from '../src/store/domain.ts'
import { workspaceKeyOf } from '../src/store/ids.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import type { AtlasDocument } from '../src/model/types.ts'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'

const AT = 1_800_000_000_000

function fakeTable(): DocumentTable & { raw: Map<string, AtlasDocument>; puts: string[] } {
  const raw = new Map<string, AtlasDocument>()
  const puts: string[] = []
  const table: DocumentTable & { raw: Map<string, AtlasDocument>; puts: string[] } = {
    raw,
    puts,
    get: (key) => raw.get(key),
    async put(key, value) {
      puts.push(key)
      raw.set(key, value)
    },
    async update(key, fn) {
      const current = raw.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      raw.set(key, next)
      return next
    },
  }
  return table
}

describe('storageDomain adapter', () => {
  it('returns undefined before the first write', async () => {
    const store = domainStoreOf(fakeTable())
    assert.equal(await store.read('ws-a'), undefined)
  })

  it('materialises an empty document on first update, then updates in place', async () => {
    const table = fakeTable()
    const store = domainStoreOf(table)
    const first = await store.update('ws-a', (doc) => ({ ...doc, activeProjectId: 'p-1' }))
    assert.equal(first.activeProjectId, 'p-1')
    assert.deepEqual(table.puts, ['ws-a'], 'the empty document was written exactly once')

    const second = await store.update('ws-a', (doc) => ({ ...doc, activeProjectId: 'p-2' }))
    assert.equal(second.activeProjectId, 'p-2')
    assert.deepEqual(table.puts, ['ws-a'], 'no extra seed write')
  })

  it('keeps workspaces apart', async () => {
    const store = domainStoreOf(fakeTable())
    await store.update('ws-a', (doc) => ({ ...doc, activeProjectId: 'p-a' }))
    await store.update('ws-b', (doc) => ({ ...doc, activeProjectId: 'p-b' }))
    assert.equal((await store.read('ws-a'))?.activeProjectId, 'p-a')
    assert.equal((await store.read('ws-b'))?.activeProjectId, 'p-b')
  })
})

describe('workspace key', () => {
  it('is stable across separators, case and trailing slashes', () => {
    const a = workspaceKeyOf('D:\\Coding\\Demo')
    const b = workspaceKeyOf('d:/coding/demo/')
    assert.equal(a, b)
  })

  it('separates different paths', () => {
    assert.notEqual(workspaceKeyOf('D:\\a'), workspaceKeyOf('D:\\b'))
  })
})

describe('built-in plan mirror', () => {
  it('records a todo list and the session cwd', () => {
    const cache = new BuiltinPlanCache()
    cache.observe(
      { id: 's1', header: { cwd: 'D:\\proj' } },
      {
        type: 'todo/write',
        data: {
          todos: [
            { content: '读类型定义', status: 'completed' },
            { content: '写工具', status: 'in_progress' },
            { content: '垃圾项', status: 'bogus' },
          ],
        },
      },
      AT,
    )
    const plan = cache.get('s1')
    assert.equal(plan?.cwd, 'D:\\proj')
    assert.equal(plan?.todos.length, 2, 'the unknown status is dropped')
    assert.equal(plan?.todos[1]?.status, 'in_progress')
  })

  it('records a goal without losing the todo list', () => {
    const cache = new BuiltinPlanCache()
    const session = { id: 's1', header: { cwd: 'D:\\proj' } }
    cache.observe(
      session,
      { type: 'todo/write', data: { todos: [{ content: 'x', status: 'pending' }] } },
      AT,
    )
    cache.observe(
      session,
      {
        type: 'goal/change',
        data: {
          operation: 'edit',
          goal: { objective: '把插件做出来', phase: 'implementing' },
        },
      },
      AT + 1,
    )
    const plan = cache.get('s1')
    assert.equal(plan?.goal?.objective, '把插件做出来')
    assert.equal(plan?.todos.length, 1, 'todos survive a goal event')
    assert.equal(plan?.observedAt, AT + 1)
  })

  it('captures the cwd from any first event', () => {
    const cache = new BuiltinPlanCache()
    cache.observe({ id: 's2', header: { cwd: 'D:\\other' } }, { type: 'turn/start' }, AT)
    assert.equal(cache.cwdOf('s2'), 'D:\\other')
    assert.equal(cache.get('s2')?.todos.length, 0)
  })

  it('ignores malformed payloads instead of throwing', () => {
    const cache = new BuiltinPlanCache()
    const session = { id: 's3', header: { cwd: 'D:\\p' } }
    cache.observe(session, { type: 'todo/write', data: { todos: 'nope' } }, AT)
    cache.observe(session, { type: 'goal/change', data: { goal: { objective: 42 } } }, AT)
    cache.observe(session, 'not-an-event', AT)
    assert.equal(cache.get('s3')?.todos.length, 0)
    assert.equal(cache.get('s3')?.goal, undefined)
  })
})

/** Boot one project through the real tools so the document is realistic. */
async function seeded(workspaceKey = 'ws-md') {
  const store = createMemoryStore()
  let clock = AT
  const env: ToolEnv = {
    now: () => clock++,
    workspaceKey: () => workspaceKey,
    rand: () => 0.42,
  }
  const registry = new Map(buildTools(store, env).map((tool) => [tool.name, tool]))
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = registry.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    return (await tool.execute(args, {} as never)) as { ok: boolean; summary: string; code?: string }
  }
  const booted = await call('atlas_breakdown_confirm', {
    title: '任务图谱',
    coreIntent: '让长对话不丢任务全貌',
    deliverables: [{ text: '右侧任务树', acceptance: '重启后出现 tab' }],
    decomposition: ['1 打通右侧栏', '2 启动拆解', '3 状态语义'],
    acceptance: '四个状态可回写',
    outOfScope: ['上下文折叠'],
    constraints: ['DSH 0.2.0-rc.2'],
    priorityOrder: ['1', '2', '3'],
    mode: 'fast',
  })
  assert.equal(booted.ok, true, booted.summary)
  const doc = store.peek(workspaceKey)
  assert.ok(doc)
  return { store, call, doc, modules: doc.projects[0]?.root.children.map((c) => c.id) ?? [] }
}

describe('markdown mirror', () => {
  it('renders the breakdown, progress and the tree', async () => {
    const { doc } = await seeded()
    const markdown = renderWorkspaceMarkdown(doc, undefined, AT)
    assert.match(markdown, /# 任务图谱/)
    assert.match(markdown, /核心意图.*让长对话不丢任务全貌/)
    assert.match(markdown, /核心交付物/)
    assert.match(markdown, /验收：重启后出现 tab/)
    assert.match(markdown, /完成度：\*\*0%\*\*/)
    assert.match(markdown, /1 打通右侧栏/)
    assert.match(markdown, /内置计划（只读）/)
  })

  it('renders reasons, results and history', async () => {
    const { call, modules, store } = await seeded('ws-md2')
    const nodeId = modules[0] as string
    await call('atlas_node_status', { nodeId, status: 'active' })
    await call('atlas_node_done', { nodeId, result: '右侧 tab 已出现' })
    await call('atlas_node_status', {
      nodeId,
      status: 'rework',
      reason: '窄窗口溢出',
      confirm: true,
    })
    const doc = store.peek('ws-md2')
    assert.ok(doc)
    const markdown = renderWorkspaceMarkdown(doc, undefined, AT)
    assert.match(markdown, /结果：右侧 tab 已出现/)
    assert.match(markdown, /需返工 —— 窄窗口溢出/)
    assert.match(markdown, /变更历史/)
    assert.match(markdown, /已完成 → 需返工（窄窗口溢出）/)
  })

  it('renders the built-in plan as read-only', async () => {
    const { doc } = await seeded('ws-md3')
    const builtin = {
      sessionId: 's1',
      todos: [{ content: '读类型定义', status: 'completed' as const }],
      goal: { objective: '把插件做出来' },
      observedAt: AT,
    }
    const markdown = renderWorkspaceMarkdown(doc, builtin, AT)
    assert.match(markdown, /\[x\] 读类型定义/)
    assert.match(markdown, /目标\*\*：把插件做出来/)
    assert.match(markdown, /插件从不修改它们/)
  })

  it('lists pending confirmations', async () => {
    const { call, modules, store } = await seeded('ws-md4')
    const nodeId = modules[0] as string
    await call('atlas_node_status', { nodeId, status: 'active' })
    await call('atlas_node_status', {
      nodeId,
      status: 'blocked',
      reason: '等体积评估',
    })
    const doc = store.peek('ws-md4')
    assert.ok(doc)
    const markdown = renderWorkspaceMarkdown(doc, undefined, AT)
    assert.match(markdown, /待你确认/)
    assert.match(markdown, /等体积评估/)
  })
})

describe('confirmation shared by tool and route', () => {
  it('applies a parked change and drains the queue', async () => {
    const { call, modules, store } = await seeded('ws-c')
    const workspaceKey = 'ws-c'
    const nodeId = modules[0] as string
    await call('atlas_node_status', { nodeId, status: 'active' })
    await call('atlas_node_status', {
      nodeId,
      status: 'blocked',
      reason: '等体积评估',
    })
    const parked = store.peek(workspaceKey)?.pending[0]
    assert.ok(parked)

    const outcome = await applyConfirmation(store, workspaceKey, parked.id, AT + 100)
    assert.equal(outcome.ok, true)
    const doc = store.peek(workspaceKey)
    assert.equal(doc?.projects[0]?.root.children[0]?.status, 'blocked')
    assert.equal(doc?.pending.length, 0)
  })

  it('reports an unknown confirmation without touching the document', async () => {
    const { store } = await seeded('ws-c2')
    const before = store.peek('ws-c2')
    const outcome = await applyConfirmation(store, 'ws-c2', 'c-nope', AT)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.code, 'NO_SUCH_CONFIRMATION')
    assert.equal(store.peek('ws-c2'), before, 'document untouched')
  })
})

// ── routes ────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as IncomingMessage
}

function makeRes(): { res: ServerResponse; state: { status: number; body: string } } {
  const state = { status: 0, body: '' }
  const res = {
    set statusCode(value: number) {
      state.status = value
    },
    get statusCode() {
      return state.status
    },
    setHeader() {},
    end(payload?: string) {
      state.body = payload ?? ''
    },
  }
  return { res: res as unknown as ServerResponse, state }
}

function harness() {
  const store = createMemoryStore()
  const builtin = new BuiltinPlanCache()
  const captured: { handler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> } =
    {}
  const host: RouteHost = {
    register(route) {
      captured.handler = route.handler
      return () => {}
    },
  }
  const dispose = installRoutes(host, { store, builtin, now: () => AT })
  const handler = captured.handler
  if (!handler) throw new Error('no route handler captured')
  return { store, builtin, handler, dispose }
}

describe('panel routes', () => {
  it('serves an empty document for a fresh workspace', async () => {
    const h = harness()
    const cwd = 'D:\\proj'
    const { res, state } = makeRes()
    await h.handler(makeReq('GET', `/task-atlas/state?cwd=${encodeURIComponent(cwd)}`), res)
    assert.equal(state.status, 200)
    const body = JSON.parse(state.body) as { ok: boolean; workspaceKey: string; document: AtlasDocument }
    assert.equal(body.ok, true)
    assert.equal(body.workspaceKey, workspaceKeyOf(cwd))
    assert.equal(body.document.projects.length, 0)
  })

  it('refuses to guess a workspace it has never seen', async () => {
    const h = harness()
    const { res, state } = makeRes()
    await h.handler(makeReq('GET', '/task-atlas/state?sessionId=unknown'), res)
    const body = JSON.parse(state.body) as { ok: boolean; code: string }
    assert.equal(body.ok, false)
    assert.equal(body.code, 'NO_WORKSPACE')
  })

  it('resolves the workspace from an observed session', async () => {
    const h = harness()
    h.builtin.observe(
      { id: 'sess-1', header: { cwd: 'D:\\proj' } },
      { type: 'todo/write', data: { todos: [{ content: 'x', status: 'pending' }] } },
      AT,
    )
    const { res, state } = makeRes()
    await h.handler(makeReq('GET', '/task-atlas/state?sessionId=sess-1'), res)
    const body = JSON.parse(state.body) as {
      ok: boolean
      workspaceKey: string
      builtin: { todos: unknown[] } | null
    }
    assert.equal(body.ok, true)
    assert.equal(body.workspaceKey, workspaceKeyOf('D:\\proj'))
    assert.equal(body.builtin?.todos.length, 1)
  })

  it('applies a confirmation over POST', async () => {
    const h = harness()
    const cwd = 'D:\\proj'
    const workspaceKey = workspaceKeyOf(cwd)
    // Seed a document with one queued confirmation.
    await h.store.update(workspaceKey, () => ({
      ...emptyDocument(workspaceKey),
      activeProjectId: 'p-1',
      projects: [
        {
          id: 'p-1',
          title: 't',
          breakdown: null,
          root: {
            id: 'p-1',
            kind: 'project',
            title: 't',
            status: 'pending',
            origin: 'ai',
            history: [],
            createdAt: AT,
            updatedAt: AT,
            children: [
              {
                id: 'm-1',
                kind: 'module',
                title: 'm',
                status: 'active',
                origin: 'ai',
                history: [],
                createdAt: AT,
                updatedAt: AT,
                children: [],
              },
            ],
          },
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      pending: [
        {
          id: 'c-1',
          nodeId: 'm-1',
          from: 'active',
          to: 'blocked',
          reason: '等评估',
          proposedBy: 'ai',
          at: AT,
        },
      ],
    }))

    const { res, state } = makeRes()
    await h.handler(
      makeReq('POST', '/task-atlas/confirm', { cwd, confirmationId: 'c-1' }),
      res,
    )
    assert.equal(state.status, 200)
    const body = JSON.parse(state.body) as { ok: boolean; summary: string }
    assert.equal(body.ok, true)
    assert.match(body.summary, /阻塞/)
    assert.equal((await h.store.read(workspaceKey))?.pending.length, 0)
  })

  it('404s an unknown path and 400s a missing confirmation id', async () => {
    const h = harness()
    const missingPath = makeRes()
    await h.handler(makeReq('GET', '/task-atlas/nope'), missingPath.res)
    assert.equal(missingPath.state.status, 404)

    const missingArg = makeRes()
    await h.handler(
      makeReq('POST', '/task-atlas/confirm', { cwd: 'D:\\proj' }),
      missingArg.res,
    )
    assert.equal(missingArg.state.status, 400)
  })

  it('persists canvas positions without touching node timestamps', async () => {
    const h = harness()
    const cwd = 'D:\\proj'
    // Positions are only meaningful once a plan exists; the route refuses to create a
    // document just to hold them.
    await h.store.update(workspaceKeyOf(cwd), (document) => ({ ...document, activeProjectId: null }))
    const { res, state } = makeRes()
    await h.handler(
      makeReq('POST', '/task-atlas/layout', {
        cwd,
        positions: { 'm-1': { x: 120.4, y: 40 }, 'm-2': { x: 'nope', y: 1 } },
      }),
      res,
    )
    assert.equal(state.status, 200)
    const body = JSON.parse(state.body) as { ok: boolean; count: number }
    assert.equal(body.ok, true)
    // An invalid point is dropped rather than stored as NaN.
    assert.equal(body.count, 1)

    const stored = await h.store.read(workspaceKeyOf(cwd))
    assert.deepEqual(stored?.layout, { 'm-1': { x: 120, y: 40 } })
    // A layout save must not invent a project, and must not touch the plan: positions are
    // view state, so nothing here can look like an edit to the work.
    assert.equal(stored?.projects.length, 0)
  })

  it('400s a layout save with no positions', async () => {
    const h = harness()
    await h.store.update(workspaceKeyOf('D:\\proj'), (document) => document)
    const missing = makeRes()
    await h.handler(makeReq('POST', '/task-atlas/layout', { cwd: 'D:\\proj' }), missing.res)
    assert.equal(missing.state.status, 400)
  })

  it('refuses to save positions for a workspace with no plan', async () => {
    const h = harness()
    const { res, state } = makeRes()
    await h.handler(
      makeReq('POST', '/task-atlas/layout', { cwd: 'D:\\empty-ws', positions: { a: { x: 1, y: 2 } } }),
      res,
    )
    assert.equal(state.status, 409)
    assert.equal((JSON.parse(state.body) as { code: string }).code, 'NO_DOCUMENT')
    // And it did not create the document it refused to write to.
    assert.equal(await h.store.read(workspaceKeyOf('D:\\empty-ws')), undefined)
  })

  it('unregisters cleanly', () => {
    const h = harness()
    h.dispose()
  })
})

describe('stored record schema', () => {
  const node = {
    id: 'p-1',
    kind: 'project',
    title: 't',
    status: 'pending',
    origin: 'ai',
    history: [],
    createdAt: 1,
    updatedAt: 1,
    children: [],
  }
  const breakdown = {
    coreIntent: 'i',
    deliverables: [],
    decomposition: [],
    acceptance: 'a',
    outOfScope: [],
    constraints: [],
    priorityOrder: [],
    mode: 'fast',
    confirmedAt: 1,
  }

  function recordWith(project: Record<string, unknown>) {
    return {
      version: 1,
      workspaceKey: 'ws-x',
      activeProjectId: 'p-1',
      projects: [{ id: 'p-1', title: 't', root: node, createdAt: 1, updatedAt: 1, ...project }],
      pending: [],
    }
  }

  it('accepts the legacy `charter` key and normalises it to `breakdown`', () => {
    // This is the failure that made a whole workspace look like lost data: the field
    // was renamed in code, records on disk still said `charter`, and because the new
    // key was required every stored document failed validation and the domain
    // refused to open.
    const parsed = atlasDocumentSchema.parse(recordWith({ charter: breakdown }))
    assert.equal(parsed.projects[0]?.breakdown?.coreIntent, 'i')
    assert.equal(
      Object.hasOwn(parsed.projects[0] as object, 'charter'),
      false,
      'the legacy key does not survive normalisation',
    )
  })

  it('still accepts the current `breakdown` key', () => {
    const parsed = atlasDocumentSchema.parse(recordWith({ breakdown }))
    assert.equal(parsed.projects[0]?.breakdown?.acceptance, 'a')
  })

  it('treats a missing breakdown as null rather than failing', () => {
    const parsed = atlasDocumentSchema.parse(recordWith({}))
    assert.equal(parsed.projects[0]?.breakdown, null)
  })

  it('rejects a record that is structurally wrong', () => {
    const broken = { ...recordWith({ breakdown }), version: 2 }
    assert.equal(atlasDocumentSchema.safeParse(broken).success, false)
  })
})
