/**
 * Preconditions (`needs`) as the meaning of a dependency edge.
 *
 * The point of the change: "who came first in the conversation" is not a dependency, so an
 * edge now has to carry a nameable thing ("字段口径表") together with who provides it. These
 * tests pin the parts that would silently rot: the derived id list, the treatment of
 * external conditions, and whether the whole thing survives a storage round-trip.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { edgeLabel, externalNeeds, needsFields, providerIds, unmetNeeds } from '../src/model/needs.ts'
import { atlasDocumentSchema } from '../src/store/domain.ts'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { workspaceKeyOf } from '../src/store/ids.ts'
import type { AtlasNode } from '../src/model/types.ts'

const AT = 1_800_000_000_000
const WORKSPACE = 'D:\\needs-workspace'

function env(): ToolEnv {
  return {
    now: () => AT,
    workspaceKey: () => workspaceKeyOf(WORKSPACE),
    workspacePath: () => WORKSPACE,
    exportDir: '.dsh',
    rand: () => 0.3,
  }
}

async function seed() {
  const store = createMemoryStore()
  const tools = buildTools(store, env())
  const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
  assert.ok(confirm)
  await confirm.execute(
    {
      title: '开工条件',
      coreIntent: '依赖要说清需要什么',
      deliverables: [{ text: '条件清单', acceptance: '每块都能列出' }],
      decomposition: ['模块甲'],
      acceptance: '写不出需要什么就不是依赖',
      mode: 'fast',
    },
    {} as never,
  )
  const document = store.peek(workspaceKeyOf(WORKSPACE))
  assert.ok(document)
  const moduleNode = document.projects[0]?.root.children[0]
  assert.ok(moduleNode)

  const add = tools.find((tool) => tool.name === 'atlas_node_add')
  assert.ok(add)
  const first = (await add.execute(
    { parentId: moduleNode.id, kind: 'task', title: '产出字段口径表' },
    {} as never,
  )) as { ok: boolean; summary: string }
  assert.equal(first.ok, true)
  const second = (await add.execute(
    { parentId: moduleNode.id, kind: 'task', title: '按口径做指标' },
    {} as never,
  )) as { ok: boolean; summary: string }
  assert.equal(second.ok, true)

  const refreshed = store.peek(workspaceKeyOf(WORKSPACE))
  const children = refreshed?.projects[0]?.root.children[0]?.children ?? []
  assert.equal(children.length, 2)
  return { store, tools, provider: children[0] as AtlasNode, consumer: children[1] as AtlasNode }
}

describe('needs helpers', () => {
  it('derives provider ids in order, without duplicates', () => {
    assert.deepEqual(
      providerIds([
        { label: 'A', fromNodeId: 'm-1' },
        { label: 'B', fromNodeId: 'm-1' },
        { label: 'C' },
        { label: 'D', fromNodeId: 'm-2' },
      ]),
      ['m-1', 'm-2'],
    )
  })

  it('separates external conditions', () => {
    const needs = [{ label: '客户确认报价' }, { label: '口径表', fromNodeId: 'm-1' }]
    assert.deepEqual(
      externalNeeds(needs).map((need) => need.label),
      ['客户确认报价'],
    )
  })

  it('treats "not stated" as unmet rather than satisfied', () => {
    const needs = [{ label: 'a', satisfied: true }, { label: 'b' }, { label: 'c', satisfied: false }]
    assert.deepEqual(
      unmetNeeds(needs).map((need) => need.label),
      ['b', 'c'],
    )
  })

  it('keeps dependsOn in sync with the providers', () => {
    const fields = needsFields([{ label: '口径表', fromNodeId: 'm-1' }, { label: '外部' }])
    assert.deepEqual(fields.dependsOn, ['m-1'])
    assert.equal(fields.needs.length, 2)
  })

  it('reads the label for one edge back out again', () => {
    const node = { needs: [{ label: '口径表', fromNodeId: 'm-1' }] } as unknown as AtlasNode
    assert.equal(edgeLabel(node, 'm-1'), '口径表')
    assert.equal(edgeLabel(node, 'm-9'), undefined)
  })
})

describe('needs through the tool layer', () => {
  it('writes needs and derives dependsOn from them', async () => {
    const { store, tools, provider, consumer } = await seed()
    const update = tools.find((tool) => tool.name === 'atlas_node_update')
    assert.ok(update)
    const result = (await update.execute(
      {
        nodeId: consumer.id,
        needs: [
          { label: '字段口径表', fromNodeId: provider.id, satisfied: true },
          { label: '客户确认报价区间' },
        ],
      },
      {} as never,
    )) as { ok: boolean }
    assert.equal(result.ok, true)

    const document = store.peek(workspaceKeyOf(WORKSPACE))
    const node = document?.projects[0]?.root.children[0]?.children.find((item) => item.id === consumer.id)
    assert.equal(node?.needs?.length, 2)
    assert.deepEqual(node?.dependsOn, [provider.id])

    // The stored record must still satisfy the storage schema: a feature that writes
    // something the domain rejects would only fail on restart, in the user's workspace.
    assert.equal(atlasDocumentSchema.safeParse(document).success, true)
  })

  it('rejects a need pointing at a node that does not exist', async () => {
    const { tools, consumer } = await seed()
    const update = tools.find((tool) => tool.name === 'atlas_node_update')
    assert.ok(update)
    const result = (await update.execute(
      { nodeId: consumer.id, needs: [{ label: '不存在的东西', fromNodeId: 'm-nope' }] },
      {} as never,
    )) as { ok: boolean; summary: string }
    assert.equal(result.ok, false)
    assert.match(result.summary, /不存在|UNKNOWN/i)
  })

  it('leaves dependsOn alone when only labels change', async () => {
    const { store, tools, provider, consumer } = await seed()
    const update = tools.find((tool) => tool.name === 'atlas_node_update')
    assert.ok(update)
    await update.execute(
      { nodeId: consumer.id, needs: [{ label: '口径表', fromNodeId: provider.id }] },
      {} as never,
    )
    await update.execute(
      { nodeId: consumer.id, needs: [{ label: '口径表（新版）', fromNodeId: provider.id }] },
      {} as never,
    )
    const document = store.peek(workspaceKeyOf(WORKSPACE))
    const node = document?.projects[0]?.root.children[0]?.children.find((item) => item.id === consumer.id)
    assert.equal(node?.needs?.[0]?.label, '口径表（新版）')
    assert.deepEqual(node?.dependsOn, [provider.id])
  })
})
