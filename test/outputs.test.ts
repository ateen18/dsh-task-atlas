/**
 * Outputs: the re-openable handles a node produced.
 *
 * The case that motivated this: a node was marked done with the address of a running tool
 * buried in a paragraph of the result. Re-finding it meant scrolling the transcript, which is
 * exactly the failure the plugin exists to remove.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { guessKind, outputsLine, removeOutput, upsertOutput } from '../src/model/outputs.ts'
import { atlasDocumentSchema } from '../src/store/domain.ts'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { workspaceKeyOf } from '../src/store/ids.ts'

const AT = 1_800_000_000_000
const WORKSPACE = 'D:\\outputs-workspace'

function env(): ToolEnv {
  return {
    now: () => AT,
    workspaceKey: () => workspaceKeyOf(WORKSPACE),
    workspacePath: () => WORKSPACE,
    exportDir: '.dsh',
    rand: () => 0.6,
  }
}

async function seed() {
  const store = createMemoryStore()
  const tools = buildTools(store, env())
  const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
  assert.ok(confirm)
  await confirm.execute(
    {
      title: '产出登记',
      coreIntent: '核心产出要能被点开',
      deliverables: [{ text: '可点的地址', acceptance: '点一下能开会话外的东西' }],
      decomposition: ['模块甲'],
      acceptance: '不需要回翻对话',
      mode: 'fast',
    },
    {} as never,
  )
  const document = store.peek(workspaceKeyOf(WORKSPACE))
  const moduleNode = document?.projects[0]?.root.children[0]
  assert.ok(moduleNode)
  const add = tools.find((tool) => tool.name === 'atlas_node_add')
  assert.ok(add)
  await add.execute({ parentId: moduleNode.id, kind: 'task', title: '分析终端' }, {} as never)
  const refreshed = store.peek(workspaceKeyOf(WORKSPACE))
  const node = refreshed?.projects[0]?.root.children[0]?.children[0]
  assert.ok(node)
  return { store, tools, node }
}

describe('output helpers', () => {
  it('infers the kind from the shape', () => {
    assert.equal(guessKind('http://127.0.0.1:8511/'), 'url')
    assert.equal(guessKind('D:\\报告\\月度复盘.md'), 'file')
    assert.equal(guessKind('D:\\项目\\产出'), 'dir')
  })

  it('replaces a duplicate target instead of stacking it', () => {
    const first = upsertOutput(undefined, { kind: 'url', label: 'A', target: 'http://x' })
    const second = upsertOutput(first, { kind: 'url', label: 'B', target: 'http://x' })
    assert.equal(second.length, 1)
    assert.equal(second[0]?.label, 'B')
  })

  it('removes by target', () => {
    const list = [
      { kind: 'url' as const, label: 'A', target: 'http://x' },
      { kind: 'file' as const, label: 'B', target: 'c:\\b.md' },
    ]
    assert.deepEqual(
      removeOutput(list, 'http://x').map((item) => item.label),
      ['B'],
    )
  })

  it('renders the line the continuation prompt carries', () => {
    assert.equal(outputsLine(undefined), undefined)
    assert.match(
      outputsLine([{ kind: 'url', label: '分析终端', target: 'http://127.0.0.1:8511/' }]) ?? '',
      /分析终端（url）http:\/\/127\.0\.0\.1:8511\//,
    )
  })
})

describe('outputs through the tool layer', () => {
  it('registers a url and survives the storage schema', async () => {
    const { store, tools, node } = await seed()
    const addOutput = tools.find((tool) => tool.name === 'atlas_output_add')
    assert.ok(addOutput)
    const result = (await addOutput.execute(
      {
        nodeId: node.id,
        label: '分析终端',
        target: 'http://127.0.0.1:8511/',
        note: '启动命令 npm run dev',
      },
      {} as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, true)
    assert.match(result.summary, /1 个产出/)

    const document = store.peek(workspaceKeyOf(WORKSPACE))
    const stored = document?.projects[0]?.root.children[0]?.children[0]
    assert.equal(stored?.outputs?.length, 1)
    assert.equal(stored?.outputs?.[0]?.kind, 'url')
    assert.equal(atlasDocumentSchema.safeParse(document).success, true)
  })

  it('does not stack the same address twice', async () => {
    const { store, tools, node } = await seed()
    const addOutput = tools.find((tool) => tool.name === 'atlas_output_add')
    assert.ok(addOutput)
    for (const label of ['分析终端', '分析终端（新）']) {
      await addOutput.execute(
        { nodeId: node.id, label, target: 'http://127.0.0.1:8511/' },
        {} as never,
      )
    }
    const stored = store.peek(workspaceKeyOf(WORKSPACE))?.projects[0]?.root.children[0]?.children[0]
    assert.equal(stored?.outputs?.length, 1)
    assert.equal(stored?.outputs?.[0]?.label, '分析终端（新）')
  })

  it('removes a handle, and says so when there is nothing to remove', async () => {
    const { tools, node } = await seed()
    const addOutput = tools.find((tool) => tool.name === 'atlas_output_add')
    const removeOutputTool = tools.find((tool) => tool.name === 'atlas_output_remove')
    assert.ok(addOutput && removeOutputTool)
    await addOutput.execute(
      { nodeId: node.id, label: 'A', target: 'D:\\x\\report.md' },
      {} as never,
    )
    const removed = (await removeOutputTool.execute(
      { nodeId: node.id, target: 'D:\\x\\report.md' },
      {} as never,
    )) as { ok: boolean }
    assert.equal(removed.ok, true)

    const missing = (await removeOutputTool.execute(
      { nodeId: node.id, target: 'D:\\nope.md' },
      {} as never,
    )) as { ok: boolean; code?: string }
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'NO_SUCH_OUTPUT')
  })

  it('refuses an unknown node', async () => {
    const { tools } = await seed()
    const addOutput = tools.find((tool) => tool.name === 'atlas_output_add')
    assert.ok(addOutput)
    const result = (await addOutput.execute(
      { nodeId: 'm-nope', label: 'A', target: 'http://x' },
      {} as never,
    )) as { ok: boolean; code?: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_NODE')
  })
})
