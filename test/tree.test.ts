/**
 * Tree operations: the 4-level ladder, immutability, the delete safety valve,
 * progress counting, and branch provenance.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestStatus } from '../src/model/status.ts'
import type { AtlasNode, NodeStatus } from '../src/model/types.ts'
import {
  addChild,
  attachBranch,
  checkAddChild,
  childKindOf,
  collectNodes,
  createNode,
  deleteNode,
  depthOfKind,
  findNode,
  findParent,
  isPristine,
  kindAtDepth,
  MAX_DEPTH,
  moveNode,
  pathOf,
  progressOf,
  replaceNode,
  resolveBranch,
  subtreeHeight,
  updateNode,
} from '../src/model/tree.ts'

const AT = 1_800_000_000_000

function mk(
  id: string,
  kind: AtlasNode['kind'],
  title = id,
  extra: Partial<Parameters<typeof createNode>[0]> = {},
): AtlasNode {
  return createNode({ id, kind, title, origin: 'ai', at: AT, ...extra })
}

/** Drive a node to a status through the real machine, so setup cannot cheat. */
function move(n: AtlasNode, to: NodeStatus, extra: { reason?: string; result?: string } = {}): AtlasNode {
  const outcome = requestStatus(n, {
    to,
    by: 'ai',
    at: AT,
    confirmedByUser: true,
    ...extra,
  })
  if (!outcome.ok || outcome.kind !== 'applied') {
    throw new Error(`setup: could not move ${n.id} to ${to}`)
  }
  return outcome.node
}

/**
 * Deliver a node the only legal way: start it, then finish it.
 * `pending -> done` is deliberately not an edge in the machine.
 */
function finish(n: AtlasNode, result = 'ok'): AtlasNode {
  return move(move(n, 'active'), 'done', { result })
}

describe('the level ladder', () => {
  it('maps each kind to its depth', () => {
    assert.equal(depthOfKind('project'), 1)
    assert.equal(depthOfKind('module'), 2)
    assert.equal(depthOfKind('task'), 3)
    assert.equal(depthOfKind('item'), 4)
    assert.equal(MAX_DEPTH, 4)
  })

  it('maps each kind to exactly one child kind', () => {
    assert.equal(childKindOf('project'), 'module')
    assert.equal(childKindOf('module'), 'task')
    assert.equal(childKindOf('task'), 'item')
    assert.equal(childKindOf('item'), null)
  })

  it('refuses children under the deepest level', () => {
    const check = checkAddChild(mk('i1', 'item'), 'item')
    assert.equal(check.ok, false)
    if (check.ok) return
    assert.match(check.message, /deepest level/)
  })

  it('refuses to skip a level', () => {
    const check = checkAddChild(mk('p', 'project'), 'task')
    assert.equal(check.ok, false)
    if (check.ok) return
    assert.match(check.message, /only hold 'module'/)
  })

  it('accepts the one legal child kind', () => {
    assert.deepEqual(checkAddChild(mk('m', 'module'), 'task'), { ok: true, kind: 'task' })
  })
})

describe('node creation', () => {
  it('starts every node pending with no history', () => {
    const n = mk('m1', 'module')
    assert.equal(n.status, 'pending')
    assert.deepEqual(n.history, [])
    assert.deepEqual(n.children, [])
    assert.equal(n.createdAt, AT)
    assert.equal(n.updatedAt, AT)
  })

  it('refuses a blank title', () => {
    assert.throws(() => mk('x', 'task', '   '), /title must not be blank/)
  })
})

describe('structural edits are immutable', () => {
  const base = addChild(mk('p', 'project'), 'p', mk('m1', 'module'))

  it('adds a child without touching the input tree', () => {
    const next = addChild(base, 'm1', mk('t1', 'task'))
    assert.equal(base.children[0]?.children.length, 0, 'original is untouched')
    assert.equal(next.children[0]?.children.length, 1)
    assert.notEqual(next, base)
  })

  it('refuses an illegal level', () => {
    assert.throws(() => addChild(base, 'p', mk('t9', 'task')), /only hold 'module'/)
  })

  it('refuses a duplicate id', () => {
    const withChild = addChild(base, 'm1', mk('t1', 'task'))
    assert.throws(() => addChild(withChild, 'm1', mk('t1', 'task')), /duplicate node id/)
  })

  it('refuses a missing parent', () => {
    assert.throws(() => addChild(base, 'nope', mk('t1', 'task')), /no such node/)
  })

  it('renames without touching siblings', () => {
    const twoKids = addChild(addChild(base, 'm1', mk('t1', 'task')), 'm1', mk('t2', 'task'))
    const renamed = updateNode(twoKids, 't1', { title: 'renamed' }, AT + 1)
    assert.equal(findNode(renamed, 't1')?.title, 'renamed')
    assert.equal(findNode(renamed, 't2')?.title, 't2')
    assert.equal(findNode(twoKids, 't1')?.title, 't1')
  })

  it('refuses a blank rename', () => {
    assert.throws(() => updateNode(base, 'm1', { title: '' }, AT), /must not be blank/)
  })

  it('replaces a node in place', () => {
    const patched = { ...mk('m1', 'module'), note: 'hello' }
    const next = replaceNode(base, 'm1', patched)
    assert.equal(findNode(next, 'm1')?.note, 'hello')
    assert.equal(findNode(base, 'm1')?.note, undefined)
  })
})

describe('lookups', () => {
  const tree = addChild(
    addChild(addChild(mk('p', 'project'), 'p', mk('m1', 'module')), 'm1', mk('t1', 'task')),
    't1',
    mk('i1', 'item'),
  )

  it('finds a deep node', () => {
    assert.equal(findNode(tree, 'i1')?.title, 'i1')
    assert.equal(findNode(tree, 'zz'), null)
  })

  it('finds its parent', () => {
    assert.equal(findParent(tree, 'i1')?.id, 't1')
    assert.equal(findParent(tree, 'p'), null)
  })

  it('returns the chain from the root', () => {
    assert.deepEqual(
      pathOf(tree, 'i1')?.map((n) => n.id),
      ['p', 'm1', 't1', 'i1'],
    )
    assert.equal(pathOf(tree, 'zz'), null)
  })

  it('collects the subtree in pre-order', () => {
    assert.deepEqual(
      collectNodes(tree).map((n) => n.id),
      ['p', 'm1', 't1', 'i1'],
    )
  })
})

describe('the delete safety valve', () => {
  const tree = addChild(mk('p', 'project'), 'p', mk('m1', 'module'))

  it('treats a fresh node as pristine', () => {
    assert.equal(isPristine(findNode(tree, 'm1') as AtlasNode), true)
  })

  it('deletes a pristine node', () => {
    const next = deleteNode(tree, 'm1')
    assert.deepEqual(next.children, [])
    assert.equal(tree.children.length, 1, 'original untouched')
  })

  it('refuses to delete a node that ever changed status', () => {
    const touched = replaceNode(tree, 'm1', move(findNode(tree, 'm1') as AtlasNode, 'active'))
    assert.equal(isPristine(findNode(touched, 'm1') as AtlasNode), false)
    assert.throws(() => deleteNode(touched, 'm1'), /not pristine.*mark it 'dropped'/)
  })

  it('refuses to delete a node that has children', () => {
    const withChild = addChild(tree, 'm1', mk('t1', 'task'))
    assert.throws(() => deleteNode(withChild, 'm1'), /not pristine/)
  })

  it('refuses to delete the root', () => {
    assert.throws(() => deleteNode(tree, 'p'), /cannot delete the project root/)
  })
})

describe('progress', () => {
  // p
  // └ m1
  //   ├ t1                    (heading: two items)
  //   │ ├ i1  done
  //   │ └ i2  active
  //   ├ t2  done              (leaf)
  //   └ t3  dropped           (leaf, leaves the denominator)
  let tree = addChild(mk('p', 'project'), 'p', mk('m1', 'module'))
  tree = addChild(tree, 'm1', mk('t1', 'task'))
  tree = addChild(tree, 't1', mk('i1', 'item'))
  tree = addChild(tree, 't1', mk('i2', 'item'))
  tree = addChild(tree, 'm1', mk('t2', 'task'))
  tree = addChild(tree, 'm1', mk('t3', 'task'))

  tree = replaceNode(tree, 'i1', finish(findNode(tree, 'i1') as AtlasNode))
  tree = replaceNode(tree, 't2', finish(findNode(tree, 't2') as AtlasNode))
  tree = replaceNode(tree, 'i2', move(findNode(tree, 'i2') as AtlasNode, 'active'))
  tree = replaceNode(
    tree,
    't3',
    move(findNode(tree, 't3') as AtlasNode, 'dropped', { reason: 'not needed' }),
  )

  it('counts only leaves', () => {
    const progress = progressOf(tree)
    // Leaves: i1, i2, t2, t3. Project root and headings never count.
    assert.equal(progress.countable, 3, 'i1 + i2 + t2 (t3 dropped)')
  })

  it('drops abandoned work out of the denominator', () => {
    const progress = progressOf(tree)
    assert.equal(progress.dropped, 1)
    assert.equal(progress.completion, 2 / 3)
  })

  it('reports per-status totals over every node', () => {
    const progress = progressOf(tree)
    assert.equal(progress.done, 2)
    assert.equal(progress.active, 1)
    assert.equal(progress.pending, 3, 'p, m1, t1')
    assert.equal(progress.rework, 0)
    assert.equal(progress.blocked, 0)
  })

  it('reports zero completion for an empty project', () => {
    const empty = progressOf(mk('p', 'project'))
    assert.equal(empty.countable, 0)
    assert.equal(empty.completion, 0)
  })
})

describe('branches', () => {
  const base = addChild(addChild(mk('p', 'project'), 'p', mk('m1', 'module')), 'm1', mk('t1', 'task'))

  const spec = {
    id: 'b1',
    kind: 'task' as const,
    title: 'fix the drag handle',
    parentId: 'm1',
    originId: 't1',
    trigger: 'user hit a bug while testing the panel',
    origin: 'ai' as const,
    at: AT,
  }

  it('records where, why and how it rejoins', () => {
    const tree = attachBranch(base, spec)
    const branch = findNode(tree, 'b1')
    assert.equal(branch?.branch?.originId, 't1')
    assert.equal(branch?.branch?.trigger, spec.trigger)
    assert.equal(branch?.status, 'pending')
  })

  it('refuses a branch with no reason to exist', () => {
    assert.throws(() => attachBranch(base, { ...spec, trigger: '  ' }), /requires a trigger/)
  })

  it('refuses an unknown origin', () => {
    assert.throws(() => attachBranch(base, { ...spec, originId: 'nope' }), /no such origin node/)
  })

  it('refuses an unknown resolvesTo', () => {
    assert.throws(
      () => attachBranch(base, { ...spec, resolvesTo: 'nope' }),
      /no such resolvesTo node/,
    )
  })

  it('resolves once, defaulting back to the origin', () => {
    const tree = attachBranch(base, spec)
    const resolved = resolveBranch(tree, 'b1', { at: AT + 10, resolution: 'fixed' })
    const branch = findNode(resolved, 'b1')
    assert.equal(branch?.branch?.resolvedAt, AT + 10)
    assert.equal(branch?.branch?.resolvesTo, 't1')
    assert.equal(branch?.branch?.resolution, 'fixed')
    assert.throws(
      () => resolveBranch(resolved, 'b1', { at: AT + 11, resolution: 'again' }),
      /already resolved/,
    )
  })

  it('refuses to resolve a non-branch', () => {
    assert.throws(
      () => resolveBranch(base, 't1', { at: AT, resolution: 'x' }),
      /is not a branch/,
    )
  })

  it('keeps the branch node after resolving, so the detour stays on record', () => {
    const tree = attachBranch(base, spec)
    const resolved = resolveBranch(tree, 'b1', { at: AT + 10, resolution: 'fixed' })
    assert.ok(findNode(resolved, 'b1'), 'the node is not removed')
  })
})

describe('moving a subtree', () => {
  // p
  // ├ m1
  // │ └ t1
  // │   └ i1
  // └ m2
  const build = () => {
    let tree = addChild(mk('p', 'project'), 'p', mk('m1', 'module'))
    tree = addChild(tree, 'p', mk('m2', 'module'))
    tree = addChild(tree, 'm1', mk('t1', 'task'))
    tree = addChild(tree, 't1', mk('i1', 'item'))
    return tree
  }

  it('reports the height of a subtree', () => {
    const tree = build()
    assert.equal(subtreeHeight(findNode(tree, 'i1') as AtlasNode), 1)
    assert.equal(subtreeHeight(findNode(tree, 't1') as AtlasNode), 2)
    assert.equal(subtreeHeight(findNode(tree, 'm1') as AtlasNode), 3)
  })

  it('maps depth to kind', () => {
    assert.equal(kindAtDepth(1), 'project')
    assert.equal(kindAtDepth(2), 'module')
    assert.equal(kindAtDepth(3), 'task')
    assert.equal(kindAtDepth(4), 'item')
    assert.equal(kindAtDepth(5), null)
  })

  it('moves a task and keeps its status', () => {
    const tree = build()
    const started = replaceNode(tree, 't1', move(findNode(tree, 't1') as AtlasNode, 'active'))
    const moved = moveNode(started, 't1', 'm2', AT + 1)
    assert.equal(findParent(moved, 't1')?.id, 'm2')
    assert.equal(findNode(moved, 't1')?.status, 'active', 'status survives the move')
    assert.equal(findParent(started, 't1')?.id, 'm1', 'source untouched')
  })

  it('refuses a move that would push the subtree past the depth limit', () => {
    const tree = build()
    assert.throws(() => moveNode(tree, 'm1', 'm2', AT), /exceed 4 levels|exceed 4/)
  })

  it('re-derives the levels when the subtree still fits', () => {
    let tree = build()
    tree = deleteNode(tree, 'i1') // m1 → t1 only
    const moved = moveNode(tree, 'm1', 'm2', AT + 1)
    assert.equal(findNode(moved, 'm1')?.kind, 'task', 'a module becomes a task by position')
    assert.equal(findNode(moved, 't1')?.kind, 'item', 'its child becomes an item')
    assert.equal(findParent(moved, 'm1')?.id, 'm2')
  })

  it('refuses a cycle', () => {
    const tree = build()
    assert.throws(() => moveNode(tree, 'm1', 'm1', AT), /under itself/)
    assert.throws(() => moveNode(tree, 'm1', 'i1', AT), /own descendants/)
  })

  it('refuses to move the project root', () => {
    const tree = build()
    assert.throws(() => moveNode(tree, 'p', 'm1', AT), /cannot move the project root/)
  })

  it('refuses an unknown destination', () => {
    const tree = build()
    assert.throws(() => moveNode(tree, 't1', 'nope', AT), /no such destination/)
  })

  it('refuses a destination that cannot hold children', () => {
    const tree = build()
    // `i1` is an item — the deepest level — and `m2` is not inside it, so the
    // cycle check does not fire first and the level refusal is what we see.
    assert.throws(() => moveNode(tree, 'm2', 'i1', AT), /deepest level/)
  })
})
