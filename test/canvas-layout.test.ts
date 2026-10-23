/**
 * Mind map arrangement.
 *
 * A layout bug here is silent: nothing throws when a child sits left of its parent, or when two
 * siblings land on top of each other — the picture just stops meaning anything. So these
 * assertions are about the properties that carry meaning, not about exact pixel positions.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CARD_H,
  CARD_W,
  GAP_Y,
  ancestorPath,
  arrangeMindMap,
  hierarchyLinks,
  prune,
} from '../src/client/canvas-layout.ts'
import { addChild, createNode } from '../src/model/tree.ts'
import type { AtlasNode } from '../src/model/types.ts'

const AT = 1_800_000_000_000

interface Spec {
  readonly id: string
  readonly title: string
  readonly children?: readonly Spec[]
}

const KIND_AT_DEPTH = ['project', 'module', 'task', 'item'] as const

/**
 * Build one subtree, picking the legal kind for its depth (project → module → task → item).
 * @param spec - what to build.
 * @param depth - 0 for the project.
 * @returns the node.
 */
function build(spec: Spec, depth: number): AtlasNode {
  const kind = KIND_AT_DEPTH[depth] ?? 'item'
  let node = createNode({ id: spec.id, kind, title: spec.title, origin: 'ai', at: AT })
  for (const child of spec.children ?? []) {
    node = addChild(node, spec.id, build(child, depth + 1))
  }
  return node
}

/** The shape from the request: project → modules → tasks, and tasks → items. */
function sample(): AtlasNode {
  return build(
    {
      id: 'p',
      title: '会话结构化插件',
      children: [
        {
          id: 'm1',
          title: '用户面',
          children: [
            { id: 't1', title: '节点状态', children: [{ id: 'i1', title: '状态词表' }] },
            { id: 't2', title: '分支溯源' },
            { id: 't3', title: '呈现' },
          ],
        },
        {
          id: 'm2',
          title: 'AI 面',
          children: [{ id: 't4', title: '每轮注入' }],
        },
      ],
    },
    0,
  )
}

describe('mind map arrangement', () => {
  it('puts every child to the right of its parent', () => {
    const root = sample()
    const { positions } = arrangeMindMap(root)
    for (const link of hierarchyLinks(root)) {
      const from = positions[link.from]
      const to = positions[link.to]
      assert.ok(from && to)
      assert.ok((to?.x ?? 0) > (from?.x ?? 0), `${link.to} should be right of ${link.from}`)
    }
  })

  it('gives one level per depth step', () => {
    const root = sample()
    const { positions } = arrangeMindMap(root)
    assert.equal(positions.p?.x, 24)
    assert.ok((positions.m1?.x ?? 0) > (positions.p?.x ?? 0))
    assert.ok((positions.t1?.x ?? 0) > (positions.m1?.x ?? 0))
    assert.ok((positions.i1?.x ?? 0) > (positions.t1?.x ?? 0))
  })

  it('never puts two siblings on top of each other', () => {
    const root = sample()
    const { positions } = arrangeMindMap(root)
    const ys = ['t1', 't2', 't3'].map((id) => positions[id]?.y ?? 0).sort((a, b) => a - b)
    for (let index = 1; index < ys.length; index += 1) {
      // t1 has a child, so its subtree is taller than one card; the gap is at least one card.
      assert.ok((ys[index] ?? 0) - (ys[index - 1] ?? 0) >= CARD_H)
    }
  })

  it('centres a parent on the span of its children', () => {
    const root = sample()
    const { positions } = arrangeMindMap(root)
    const first = positions.t1
    const last = positions.t3
    const parent = positions.m1
    assert.ok(first && last && parent)
    const spanMiddle = ((first?.y ?? 0) + (last?.y ?? 0)) / 2
    assert.ok(
      Math.abs((parent?.y ?? 0) - spanMiddle) <= CARD_H,
      'a parent should sit near the middle of its children',
    )
  })

  it('reports a canvas big enough for every card', () => {
    const root = sample()
    const layout = arrangeMindMap(root)
    for (const [id, point] of Object.entries(layout.positions)) {
      assert.ok(point.x + CARD_W <= layout.width, `${id} exceeds the reported width`)
      assert.ok(point.y + CARD_H <= layout.height, `${id} exceeds the reported height`)
    }
  })

  it('folds a subtree without touching the original', () => {
    const root = sample()
    const folded = prune(root, new Set(['m1']))
    assert.deepEqual(
      folded.children.map((child) => child.id),
      ['m1', 'm2'],
      'the module itself stays',
    )
    assert.equal(folded.children[0]?.children.length, 0, 'its children are hidden')
    // The original still has them: folding is view state, not a change to the plan.
    assert.equal(root.children[0]?.children.length, 3)
  })

  it('keeps a collapsed node identifiable, so it can be expanded again', () => {
    const root = sample()
    const folded = prune(root, new Set(['m1']))
    const module1 = folded.children.find((child) => child.id === 'm1')
    assert.ok(module1, 'a collapsed node must still be present')
    // The count that drives the expand control has to come from the unfolded tree.
    const original = root.children.find((child) => child.id === 'm1')
    assert.equal(original?.children.length, 3)
  })

  it('lays a folded tree out shorter than the full one', () => {
    const root = sample()
    const full = arrangeMindMap(root)
    const folded = arrangeMindMap(prune(root, new Set(['m1'])))
    assert.ok(folded.height < full.height)
  })
  it('reuses the hierarchy path for an ancestor dependency, and invents nothing for siblings', () => {
    // p → m1 → t1;  m1 also holds t2 and t3 as siblings.
    const parents = new Map<string, string>([
      ['m1', 'p'],
      ['t1', 'm1'],
      ['t2', 'm1'],
      ['t3', 'm1'],
      ['i1', 't1'],
    ])
    assert.deepEqual(ancestorPath('m1', 't1', parents), ['m1->t1'])
    assert.deepEqual(ancestorPath('t1', 'm1', parents), ['m1->t1'])
    assert.deepEqual(ancestorPath('p', 'i1', parents), ['p->m1', 'm1->t1', 't1->i1'])
    // Siblings share a parent but neither is on the other's path.
    assert.equal(ancestorPath('t2', 't3', parents), undefined)
    // Unrelated nodes, and a node with itself.
    assert.equal(ancestorPath('t1', 'p2', parents), undefined)
    assert.equal(ancestorPath('t1', 't1', parents), undefined)
  })
  it('lists every parent → child link exactly once', () => {
    const links = hierarchyLinks(sample())
    assert.equal(links.length, 7)
    assert.equal(new Set(links.map((link) => `${link.from}->${link.to}`)).size, 7)
  })

  it('keeps sibling spacing controllable, so a dense tree can be tightened', () => {
    const root = sample()
    const roomy = arrangeMindMap(root, { gapY: GAP_Y })
    const tight = arrangeMindMap(root, { gapY: 4 })
    assert.ok(tight.height < roomy.height)
  })
})
