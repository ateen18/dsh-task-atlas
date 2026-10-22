/**
 * Titles are labels, enforced where they are written.
 *
 * The failure this guards against was visible in a real workspace: every node title held a
 * sentence, so the tree could not be scanned and the panel became a wall of text. Asking
 * the model to be brief had already failed, so the tool now splits `短标题：解释` itself.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { workspaceKeyOf } from '../src/store/ids.ts'

const AT = 1_800_000_000_000
const WORKSPACE = 'D:\\title-workspace'

function env(): ToolEnv {
  return {
    now: () => AT,
    workspaceKey: () => workspaceKeyOf(WORKSPACE),
    workspacePath: () => WORKSPACE,
    exportDir: '.dsh',
    rand: () => 0.4,
  }
}

async function seed() {
  const store = createMemoryStore()
  const tools = buildTools(store, env())
  const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
  assert.ok(confirm)
  await confirm.execute(
    {
      title: '标题纪律',
      coreIntent: '让树能扫',
      deliverables: [{ text: '短标题', acceptance: '一行能读完' }],
      decomposition: ['模块甲'],
      acceptance: '扫一眼看得出剩什么',
      mode: 'fast',
    },
    {} as never,
  )
  return { store, tools }
}

function findNode(store: ReturnType<typeof createMemoryStore>): import('../src/model/types.ts').AtlasNode {
  const document = store.peek(workspaceKeyOf(WORKSPACE))
  assert.ok(document)
  const project = document.projects[0]
  assert.ok(project)
  const module = project.root.children[0]
  assert.ok(module)
  return module
}

describe('title discipline at the write boundary', () => {
  it('moves an explanation out of the title into the note', async () => {
    const { store, tools } = await seed()
    const add = tools.find((tool) => tool.name === 'atlas_node_add')
    assert.ok(add)
    const result = (await add.execute(
      {
        parentId: findNode(store).id,
        kind: 'task',
        title: '基线对齐：确认数据文件与视频文件的真实路径、字段口径、样本量、品类，标出缺口',
      },
      {} as never,
    )) as { ok: boolean; summary: string }

    assert.equal(result.ok, true)
    assert.match(result.summary, /解释已移进 note/)

    const module = findNode(store)
    const child = module.children[0]
    assert.ok(child)
    assert.equal(child.title, '基线对齐')
    assert.match(child.note ?? '', /确认数据文件/)
  })

  it('keeps a short title untouched', async () => {
    const { store, tools } = await seed()
    const add = tools.find((tool) => tool.name === 'atlas_node_add')
    assert.ok(add)
    await add.execute(
      { parentId: findNode(store).id, kind: 'task', title: '节点状态' },
      {} as never,
    )
    assert.equal(findNode(store).children[0]?.title, '节点状态')
  })

  it('prefers an explicit note over the split', async () => {
    const { store, tools } = await seed()
    const add = tools.find((tool) => tool.name === 'atlas_node_add')
    assert.ok(add)
    await add.execute(
      {
        parentId: findNode(store).id,
        kind: 'task',
        title: '分支溯源：一长串本来会被搬走的解释文字',
        note: '我自己写的说明',
      },
      {} as never,
    )
    const child = findNode(store).children[0]
    assert.equal(child?.title, '分支溯源')
    assert.equal(child?.note, '我自己写的说明')
  })

  it('warns when a title is long and has nothing to split on', async () => {
    const { store, tools } = await seed()
    const add = tools.find((tool) => tool.name === 'atlas_node_add')
    assert.ok(add)
    const result = (await add.execute(
      {
        parentId: findNode(store).id,
        kind: 'task',
        title: '一个没有分隔符但明显过长的标题用来测试判定是否生效',
      },
      {} as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, true, 'a long title is a warning, not a rejection')
    assert.match(result.summary, /偏长/)
  })
})
