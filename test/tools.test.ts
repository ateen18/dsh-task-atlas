/**
 * Tool layer, exercised end to end against the in-memory store.
 *
 * These are the tests that matter most for the plugin's actual behaviour: they
 * drive the same `execute` functions the model will call, so a regression here
 * is a regression the user feels.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'
import { createMemoryStore } from '../src/store/memory.ts'

const START = 1_800_000_000_000

interface ToolResult {
  ok: boolean
  summary: string
  code?: string
}

function harness() {
  const store = createMemoryStore()
  let clock = START
  let seed = 0.1
  const env: ToolEnv = {
    now: () => clock,
    workspaceKey: () => 'ws-test',
    rand: () => {
      seed = (seed + 0.137) % 1
      return seed
    },
  }
  const registry = new Map<string, ToolDefinition>(
    buildTools(store, env).map((tool) => [tool.name, tool]),
  )

  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = registry.get(name)
    if (!tool) throw new Error(`no tool named ${name}`)
    return (await tool.execute(args, {} as never)) as ToolResult
  }

  const tick = (ms = 1) => {
    clock += ms
    return clock
  }

  return { store, env, call, tick, registry }
}

function breakdownArgs(overrides: Record<string, unknown> = {}) {
  return {
    title: '会话结构化插件',
    coreIntent: '解决长对话里用户忘记任务全貌的问题',
    deliverables: [
      { text: '右侧任务树插件', acceptance: '重启后右侧出现 tab' },
      { text: 'AI 自动维护状态', acceptance: '四个状态都能写入' },
    ],
    decomposition: ['1 打通右侧栏', '2 启动拆解', '3 状态语义', '4 分支语义'],
    acceptance: '四个状态可回写且刷新后仍在',
    outOfScope: ['上下文折叠'],
    constraints: ['DSH 0.2.0-rc.2'],
    priorityOrder: ['1', '2', '3', '4'],
    mode: 'fast',
    ...overrides,
  }
}

/** Boot a project and return its module ids, in decomposition order. */
async function bootProject(h: ReturnType<typeof harness>) {
  const result = await h.call('atlas_breakdown_confirm', breakdownArgs())
  assert.equal(result.ok, true, result.summary)
  const ids = [...result.summary.matchAll(/\(([mit]-[0-9a-z]+)\)/g)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id))
  const project = h.store.peek('ws-test')
  assert.ok(project)
  const modules = project.projects[0]?.root.children.map((child) => child.id) ?? []
  return { result, projectId: project.activeProjectId, modules, ids }
}

describe('atlas_status', () => {
  it('reports the absence of a project instead of failing', async () => {
    const h = harness()
    const result = await h.call('atlas_status')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_PROJECT')
    assert.match(result.summary, /atlas_breakdown_draft/)
  })

  it('renders the breakdown, progress and the tree once a project exists', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    await h.call('atlas_node_add', {
      parentId: modules[0],
      kind: 'task',
      title: '读官方类型定义',
    })
    const result = await h.call('atlas_status')
    assert.equal(result.ok, true)
    assert.match(result.summary, /意图：/)
    assert.match(result.summary, /进度：/)
    assert.match(result.summary, /读官方类型定义/)
    assert.match(result.summary, /当前专注：/)
  })

  it('hides finished nodes unless asked', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const added = await h.call('atlas_node_add', {
      parentId: modules[0],
      kind: 'task',
      title: '可被完成的节点',
    })
    const nodeId = /\(([ti]-[0-9a-z]+)\)/.exec(added.summary)?.[1]
    assert.ok(nodeId)
    await h.call('atlas_node_status', { nodeId, status: 'active' })
    await h.call('atlas_node_done', { nodeId, result: '做完了' })

    const lean = await h.call('atlas_status')
    assert.doesNotMatch(lean.summary, /可被完成的节点/)
    const full = await h.call('atlas_status', { includeDone: true })
    assert.match(full.summary, /可被完成的节点/)
  })
})

describe('kickoff', () => {
  it('refuses an incomplete breakdown and names what is missing', async () => {
    const h = harness()
    const result = await h.call(
      'atlas_breakdown_draft',
      breakdownArgs({ coreIntent: '  ', decomposition: [] }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BREAKDOWN_INCOMPLETE')
    assert.match(result.summary, /coreIntent/)
    assert.match(result.summary, /decomposition/)
  })

  it('warns without blocking when a deliverable has no acceptance test', async () => {
    const h = harness()
    const result = await h.call(
      'atlas_breakdown_draft',
      breakdownArgs({ deliverables: [{ text: '一个任务树' }] }),
    )
    assert.equal(result.ok, true)
    assert.match(result.summary, /警告/)
    assert.match(result.summary, /no acceptance test/)
  })

  it('builds the project root plus one module per decomposition step', async () => {
    const h = harness()
    const { projectId, modules } = await bootProject(h)
    assert.equal(modules.length, 4, 'one module per decomposition step')
    const doc = h.store.peek('ws-test')
    assert.equal(doc?.projects[0]?.id, projectId)
    assert.equal(doc?.projects[0]?.breakdown?.mode, 'fast')
    assert.equal(doc?.activeProjectId, projectId)
    assert.equal(doc?.projects[0]?.focusedNodeId, modules[0], 'focus starts on the first module')
  })
})

describe('structure', () => {
  it('adds a child at the level the parent demands', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_node_add', {
      parentId: modules[0],
      kind: 'task',
      title: '任务一',
    })
    assert.equal(result.ok, true)
  })

  it('refuses to skip a level', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_node_add', {
      parentId: modules[0],
      kind: 'item',
      title: '越级',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BAD_LEVEL')
  })

  it('refuses an unknown parent', async () => {
    const h = harness()
    await bootProject(h)
    const result = await h.call('atlas_node_add', {
      parentId: 'm-nope',
      kind: 'task',
      title: 'x',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_SUCH_NODE')
  })

  it('renames a node', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_node_update', {
      nodeId: modules[0],
      title: '改了的需求',
    })
    assert.equal(result.ok, true)
    const doc = h.store.peek('ws-test')
    assert.equal(doc?.projects[0]?.root.children[0]?.title, '改了的需求')
  })

  it('moves focus and refuses an unknown node', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const moved = await h.call('atlas_focus', { nodeId: modules[2] })
    assert.equal(moved.ok, true)
    assert.equal(h.store.peek('ws-test')?.projects[0]?.focusedNodeId, modules[2])

    const bad = await h.call('atlas_focus', { nodeId: 'm-nope' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'NO_SUCH_NODE')
  })
})

describe('finishing and reopening', () => {
  it('refuses to finish a node that never started', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_node_done', {
      nodeId: modules[0],
      result: '假装做完了',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'ILLEGAL_TRANSITION')
  })

  it('finishes a started node and records the result', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    await h.call('atlas_node_status', { nodeId: modules[0], status: 'active' })
    const result = await h.call('atlas_node_done', {
      nodeId: modules[0],
      result: '右侧 tab 已出现，重启验证通过',
    })
    assert.equal(result.ok, true)
    const node = h.store.peek('ws-test')?.projects[0]?.root.children[0]
    assert.equal(node?.status, 'done')
    assert.match(node?.result ?? '', /重启验证通过/)
  })

  it('cannot be called without a result at all', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    await h.call('atlas_node_status', { nodeId: modules[0], status: 'active' })
    // `result` is `required: true` in the parameter schema, so defineTool rejects
    // the call before `execute` ever runs. The RESULT_REQUIRED branch in the
    // model stays as defence in depth for non-model callers (panel, panel routes).
    await assert.rejects(
      () => h.call('atlas_node_done', { nodeId: modules[0] }),
      /missing required property "result"/,
    )
  })
})

describe('tiered authorization over the tool surface', () => {
  it('parks rework as pending and leaves the node untouched', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const nodeId = modules[0]
    await h.call('atlas_node_status', { nodeId, status: 'active' })
    await h.call('atlas_node_done', { nodeId, result: '第一版完成' })

    const parked = await h.call('atlas_node_status', {
      nodeId,
      status: 'rework',
      reason: '右侧树在窄窗口下会横向溢出',
    })
    assert.equal(parked.ok, true)
    assert.match(parked.summary, /已排队待确认/)

    const node = h.store.peek('ws-test')?.projects[0]?.root.children[0]
    assert.equal(node?.status, 'done', 'nothing changed yet')
    assert.equal(h.store.peek('ws-test')?.pending.length, 1)
  })

  it('applies the parked change once the user confirms', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const nodeId = modules[0]
    await h.call('atlas_node_status', { nodeId, status: 'active' })
    await h.call('atlas_node_done', { nodeId, result: '第一版完成' })
    const parked = await h.call('atlas_node_status', {
      nodeId,
      status: 'rework',
      reason: '窄窗口下溢出',
    })
    const confirmationId = /确认 id = (c-[0-9a-z]+)/.exec(parked.summary)?.[1]
    assert.ok(confirmationId, 'the summary must carry the confirmation id')

    const confirmed = await h.call('atlas_confirm', { confirmationId })
    assert.equal(confirmed.ok, true)
    const doc = h.store.peek('ws-test')
    assert.equal(doc?.projects[0]?.root.children[0]?.status, 'rework')
    assert.equal(doc?.projects[0]?.root.children[0]?.reason, '窄窗口下溢出')
    assert.equal(doc?.pending.length, 0, 'the queue is drained')
  })

  it('applies immediately when the user already agreed in the conversation', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    // `pending -> blocked` is not an edge: work has to be under way before it
    // can be reported blocked. Start it first.
    await h.call('atlas_node_status', { nodeId: modules[0], status: 'active' })
    const result = await h.call('atlas_node_status', {
      nodeId: modules[0],
      status: 'blocked',
      reason: '等 mind-elixir 体积评估',
      returnCondition: '评估完成',
      confirm: true,
    })
    assert.equal(result.ok, true)
    assert.doesNotMatch(result.summary, /已排队待确认/)
    const node = h.store.peek('ws-test')?.projects[0]?.root.children[0]
    assert.equal(node?.status, 'blocked')
    assert.equal(node?.returnCondition, '评估完成')
  })

  it('refuses a reason-bearing status without a reason', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_node_status', {
      nodeId: modules[0],
      status: 'dropped',
      confirm: true,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'REASON_REQUIRED')
  })

  it('refuses an unknown confirmation id', async () => {
    const h = harness()
    await bootProject(h)
    const result = await h.call('atlas_confirm', { confirmationId: 'c-nope' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_SUCH_CONFIRMATION')
  })
})

describe('branches over the tool surface', () => {
  it('records why the branch exists', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_branch_create', {
      parentId: modules[0],
      originId: modules[0],
      kind: 'task',
      title: '修窄窗口溢出',
      trigger: '用户在试用时发现面板撑破布局',
      returnCondition: '窄窗口下不再横向滚动',
    })
    assert.equal(result.ok, true)
    assert.match(result.summary, /为什么：用户在试用时发现面板撑破布局/)
    const branch = h.store
      .peek('ws-test')
      ?.projects[0]?.root.children[0]?.children.find((node) => node.branch !== undefined)
    assert.equal(branch?.branch?.returnCondition, '窄窗口下不再横向滚动')
  })

  it('refuses a branch with no trigger', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const result = await h.call('atlas_branch_create', {
      parentId: modules[0],
      originId: modules[0],
      kind: 'task',
      title: '来路不明的分支',
      trigger: '   ',
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BRANCH_FAILED')
  })

  it('resolves a branch without deleting it', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    await h.call('atlas_branch_create', {
      parentId: modules[0],
      originId: modules[0],
      kind: 'task',
      title: '临时修一下',
      trigger: '用户临时要求',
    })
    const branchId = h.store
      .peek('ws-test')
      ?.projects[0]?.root.children[0]?.children[0]?.id
    assert.ok(branchId)

    const resolved = await h.call('atlas_branch_resolve', {
      nodeId: branchId,
      resolution: '已修好并合回',
    })
    assert.equal(resolved.ok, true)

    const branch = h.store
      .peek('ws-test')
      ?.projects[0]?.root.children[0]?.children.find((node) => node.id === branchId)
    assert.ok(branch, 'the node survives resolution')
    assert.equal(branch?.branch?.resolvesTo, modules[0])
    assert.match(branch?.branch?.resolution ?? '', /已修好并合回/)
  })
})

describe('deleting', () => {
  it('deletes a pristine node', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    const added = await h.call('atlas_node_add', {
      parentId: modules[0],
      kind: 'task',
      title: '写错了',
    })
    const nodeId = /\(([ti]-[0-9a-z]+)\)/.exec(added.summary)?.[1]
    assert.ok(nodeId)
    const result = await h.call('atlas_node_delete', { nodeId })
    assert.equal(result.ok, true)
    const kids = h.store.peek('ws-test')?.projects[0]?.root.children[0]?.children ?? []
    assert.equal(kids.length, 0)
  })

  it('refuses to delete a node that ever changed status', async () => {
    const h = harness()
    const { modules } = await bootProject(h)
    await h.call('atlas_node_status', { nodeId: modules[0], status: 'active' })
    const result = await h.call('atlas_node_delete', { nodeId: modules[0] })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DELETE_REFUSED')
    assert.match(result.summary, /dropped/)
  })
})

describe('registration', () => {
  it('exposes the whole surface under the atlas_ prefix', () => {
    const h = harness()
    const names = [...h.registry.keys()].sort()
    assert.deepEqual(names, [
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
    ])
  })

  it('unregisters cleanly', async () => {
    const { registerTools } = await import('../src/tools/index.ts')
    const h = harness()
    const disposed: string[] = []
    const ctx = {
      tools: {
        register(definition: ToolDefinition) {
          return () => {
            disposed.push(definition.name)
          }
        },
      },
    }
    const dispose = registerTools(ctx, h.store, h.env)
    assert.equal(disposed.length, 0)
    dispose()
    assert.equal(disposed.length, 19)
  })
})
