/**
 * Tree operations: all pure, all immutable, all structural-sharing.
 *
 * The tree is 4 levels deep by construction — `project → module → task → item` —
 * because an unbounded tree is how long plans turn into another thing the user
 * gets lost in. A node's level is implied by its parent, and `checkAddChild`
 * refuses anything that would break the ladder.
 */
import type { Actor, AtlasNode, NodeKind, NodeStatus, NodeNeed, NodeOutput } from './types.ts'
import { providerIds } from './needs.ts'
import { checkDependencies } from './dependency.ts'

/** Levels from the root, 1-based. */
const DEPTH: Readonly<Record<NodeKind, number>> = {
  project: 1,
  module: 2,
  task: 3,
  item: 4,
}

/** The deepest level the tree allows. */
export const MAX_DEPTH = 4

/**
 * Depth of a kind from the root.
 * @param kind - node kind.
 * @returns 1 for `project` … 4 for `item`.
 */
export function depthOfKind(kind: NodeKind): number {
  return DEPTH[kind]
}

/**
 * The only kind allowed directly under `kind`, or `null` at the bottom.
 * @param kind - parent kind.
 * @returns the child kind, or `null` for a leaf level.
 */
export function childKindOf(kind: NodeKind): NodeKind | null {
  switch (kind) {
    case 'project':
      return 'module'
    case 'module':
      return 'task'
    case 'task':
      return 'item'
    case 'item':
      return null
  }
}

/** Everything needed to create one node. Timestamps and ids are injected. */
export interface NodeSpec {
  readonly id: string
  readonly kind: NodeKind
  readonly title: string
  readonly note?: string
  readonly origin: Actor
  /** Epoch milliseconds. */
  readonly at: number
  readonly evidence?: readonly string[]
  /** Ids that must be finished before this node can start; validated by the caller. */
  readonly dependsOn?: readonly string[]
}

/**
 * Build a fresh node in `pending` with no history.
 * @param spec - the node's initial data.
 * @returns the new node, childless.
 * @throws {Error} when the title is blank.
 */
export function createNode(spec: NodeSpec): AtlasNode {
  const title = spec.title.trim()
  if (title.length === 0) throw new Error('node title must not be blank')
  return {
    id: spec.id,
    kind: spec.kind,
    title,
    ...(spec.note ? { note: spec.note } : {}),
    status: 'pending',
    origin: spec.origin,
    ...(spec.evidence ? { evidence: spec.evidence } : {}),
    ...(spec.dependsOn && spec.dependsOn.length > 0 ? { dependsOn: spec.dependsOn } : {}),
    history: [],
    createdAt: spec.at,
    updatedAt: spec.at,
    children: [],
  }
}

/**
 * Depth-first search for a node.
 * @param root - subtree to search.
 * @param id - target id.
 * @returns the node, or `null`.
 */
export function findNode(root: AtlasNode, id: string): AtlasNode | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const hit = findNode(child, id)
    if (hit) return hit
  }
  return null
}

/**
 * The parent of a node, if any.
 * @param root - subtree to search.
 * @param id - target id.
 * @returns the parent node, or `null` for the root or a missing id.
 */
export function findParent(root: AtlasNode, id: string): AtlasNode | null {
  for (const child of root.children) {
    if (child.id === id) return root
    const hit = findParent(child, id)
    if (hit) return hit
  }
  return null
}

/**
 * The chain from the root down to `id`, inclusive.
 * @param root - subtree to search.
 * @param id - target id.
 * @returns root…node, or `null` when the id is absent.
 */
export function pathOf(root: AtlasNode, id: string): AtlasNode[] | null {
  if (root.id === id) return [root]
  for (const child of root.children) {
    const tail = pathOf(child, id)
    if (tail) return [root, ...tail]
  }
  return null
}

/**
 * Every node of the subtree, in depth-first pre-order.
 * @param root - subtree root.
 * @returns all nodes including `root`.
 */
export function collectNodes(root: AtlasNode): AtlasNode[] {
  const out: AtlasNode[] = []
  const walk = (node: AtlasNode): void => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

/** Result of testing whether a child may be attached. */
export type AddChildCheck =
  | { readonly ok: true; readonly kind: NodeKind }
  | { readonly ok: false; readonly message: string }

/**
 * Whether `parent` may take a new child of `kind`.
 * @param parent - prospective parent.
 * @param kind - prospective child kind.
 * @returns the verdict.
 */
export function checkAddChild(parent: AtlasNode, kind: NodeKind): AddChildCheck {
  const expected = childKindOf(parent.kind)
  if (!expected) {
    return {
      ok: false,
      message: `'${parent.kind}' is the deepest level (${MAX_DEPTH}); it cannot hold children`,
    }
  }
  if (kind !== expected) {
    return {
      ok: false,
      message: `'${parent.kind}' can only hold '${expected}' children, not '${kind}'`,
    }
  }
  return { ok: true, kind }
}

/**
 * Replace one node inside a subtree, preserving reference identity elsewhere.
 * @param node - subtree root.
 * @param id - target id.
 * @param fn - transform applied to the matched node.
 * @returns the new subtree.
 */
function mapNode(
  node: AtlasNode,
  id: string,
  fn: (found: AtlasNode) => AtlasNode,
): AtlasNode {
  if (node.id === id) return fn(node)
  let changed = false
  const children = node.children.map((child) => {
    const next = mapNode(child, id, fn)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

/**
 * Attach `child` under `parentId`.
 * @param root - subtree root.
 * @param parentId - parent node id.
 * @param child - the node to attach.
 * @returns the new tree.
 * @throws {Error} when the parent is missing, the level is full, or the kind is wrong.
 */
export function addChild(
  root: AtlasNode,
  parentId: string,
  child: AtlasNode,
): AtlasNode {
  const parent = findNode(root, parentId)
  if (!parent) throw new Error(`no such node: ${parentId}`)
  const check = checkAddChild(parent, child.kind)
  if (!check.ok) throw new Error(check.message)
  if (findNode(root, child.id)) throw new Error(`duplicate node id: ${child.id}`)
  return mapNode(root, parentId, (found) => ({
    ...found,
    children: [...found.children, child],
    updatedAt: Math.max(found.updatedAt, child.createdAt),
  }))
}

/**
 * Patch a node's title, note and/or prerequisites.
 * @param root - subtree root.
 * @param id - target id.
 * @param patch - fields to change; blank titles are refused, and so are dependency
 *   edits that would create a cycle or point at a missing node.
 * @param at - epoch milliseconds of the edit.
 * @returns the new tree.
 * @throws {Error} when the node is missing, the title is blank, or the dependency
 *   list is invalid.
 */
export function updateNode(
  root: AtlasNode,
  id: string,
  patch: {
    readonly title?: string
    readonly note?: string | undefined
    readonly dependsOn?: readonly string[]
    readonly needs?: readonly NodeNeed[]
    readonly outputs?: readonly NodeOutput[]
  },
  at: number,
): AtlasNode {
  const target = findNode(root, id)
  if (!target) throw new Error(`no such node: ${id}`)
  const nextTitle = patch.title === undefined ? target.title : patch.title.trim()
  if (nextTitle.length === 0) throw new Error('node title must not be blank')

  // `needs` is authoritative when given: it decides the edge labels and re-derives the
  // provider id list, so the two can never disagree.
  const derivedFromNeeds = patch.needs === undefined ? undefined : providerIds(patch.needs)
  const requested = derivedFromNeeds ?? patch.dependsOn

  let nextDependencies: readonly string[] | undefined
  if (requested !== undefined) {
    // Deduplicate and drop blanks first: a repeated id is harmless but would render
    // as two overlapping edges.
    const cleaned = [...new Set(requested.map((dep) => dep.trim()).filter(Boolean))]
    const proposed = collectNodes(root).map((node) =>
      node.id === id ? { id: node.id, dependsOn: cleaned } : node,
    )
    const verdict = checkDependencies(proposed, id)
    if (!verdict.ok) throw new Error(verdict.message)
    nextDependencies = cleaned
  }

  return mapNode(root, id, (found) => {
    const next: AtlasNode = {
      ...found,
      title: nextTitle,
      note: patch.note,
      updatedAt: at,
      ...(patch.needs === undefined ? {} : { needs: patch.needs }),
      ...(patch.outputs === undefined ? {} : { outputs: patch.outputs }),
    }
    if (nextDependencies === undefined) return next
    if (nextDependencies.length === 0) {
      const { dependsOn: _dropped, ...rest } = next
      return rest
    }
    return { ...next, dependsOn: nextDependencies }
  })
}

/**
 * Apply an already-computed node replacement (e.g. a status change) in place.
 * @param root - subtree root.
 * @param id - target id.
 * @param next - the replacement node, normally `fn(target)`.
 * @returns the new tree.
 */
export function replaceNode(root: AtlasNode, id: string, next: AtlasNode): AtlasNode {
  return mapNode(root, id, () => next)
}

/**
 * Whether a node may be hard-deleted rather than dropped.
 *
 * The safety valve: only a node that never carried a decision can vanish.
 * Anything with history stays behind as `dropped`, because the record of
 * "why we abandoned this" is what makes the plan auditable later.
 * @param node - the candidate.
 * @returns whether it is still pristine.
 */
export function isPristine(node: AtlasNode): boolean {
  return (
    node.status === 'pending' &&
    node.history.length === 0 &&
    node.children.length === 0
  )
}

/**
 * Remove a subtree entirely.
 * @param root - subtree root.
 * @param id - id to remove; the root itself cannot be removed.
 * @returns the new tree.
 * @throws {Error} when the id is the root, missing, or the node is not pristine.
 */
export function deleteNode(root: AtlasNode, id: string): AtlasNode {
  if (root.id === id) throw new Error('cannot delete the project root')
  const target = findNode(root, id)
  if (!target) throw new Error(`no such node: ${id}`)
  if (!isPristine(target)) {
    throw new Error(
      `node ${id} is not pristine (status '${target.status}', ${target.history.length} history entries, ${target.children.length} children); mark it 'dropped' instead`,
    )
  }
  const strip = (node: AtlasNode): AtlasNode => {
    const kept = node.children.filter((child) => child.id !== id)
    return kept.length === node.children.length
      ? { ...node, children: node.children.map(strip) }
      : { ...node, children: kept }
  }
  return strip(root)
}

/** Aggregate counts and completion for a subtree. */
export interface Progress {
  readonly pending: number
  readonly active: number
  readonly done: number
  readonly rework: number
  readonly blocked: number
  readonly dropped: number
  /** Leaves that still count: not the project root, not dropped. */
  readonly countable: number
  /** `done / countable`, 0 when nothing counts yet. */
  readonly completion: number
}

/**
 * Count a subtree's state.
 *
 * Only **leaves** count toward completion: a parent is a heading, not a unit of
 * work, so counting it would double-count its children. Dropped subtrees leave
 * the denominator entirely — abandoning a task should not lower the percentage,
 * which is what makes the number survivable on a plan that changes.
 * @param root - subtree root.
 * @returns the aggregate.
 */
export function progressOf(root: AtlasNode): Progress {
  const counts: Record<NodeStatus, number> = {
    pending: 0,
    active: 0,
    done: 0,
    rework: 0,
    blocked: 0,
    dropped: 0,
  }
  let countable = 0
  let delivered = 0
  for (const node of collectNodes(root)) {
    counts[node.status] += 1
    const isLeaf = node.children.length === 0
    if (isLeaf && node.kind !== 'project' && node.status !== 'dropped') {
      countable += 1
      if (node.status === 'done') delivered += 1
    }
  }
  return {
    ...counts,
    countable,
    completion: countable === 0 ? 0 : delivered / countable,
  }
}

/** Everything needed to insert a branch node into the tree. */
export interface BranchSpec {
  readonly id: string
  readonly kind: NodeKind
  readonly title: string
  readonly parentId: string
  /** Node the work was split off from. */
  readonly originId: string
  /** Why the branch exists. */
  readonly trigger: string
  readonly returnCondition?: string
  readonly resolvesTo?: string
  readonly origin: Actor
  readonly at: number
}

/**
 * Insert a branch node recorded with its provenance.
 * @param root - subtree root.
 * @param spec - the branch and where it hangs.
 * @returns the new tree.
 * @throws {Error} when the parent or origin is missing, the trigger is blank, or the level is wrong.
 */
export function attachBranch(root: AtlasNode, spec: BranchSpec): AtlasNode {
  const trigger = spec.trigger.trim()
  if (trigger.length === 0) {
    throw new Error('a branch requires a trigger: why was this split off?')
  }
  const origin = findNode(root, spec.originId)
  if (!origin) throw new Error(`no such origin node: ${spec.originId}`)
  if (spec.resolvesTo && !findNode(root, spec.resolvesTo)) {
    throw new Error(`no such resolvesTo node: ${spec.resolvesTo}`)
  }
  const node: AtlasNode = {
    ...createNode({
      id: spec.id,
      kind: spec.kind,
      title: spec.title,
      origin: spec.origin,
      at: spec.at,
    }),
    branch: {
      originId: spec.originId,
      trigger,
      ...(spec.returnCondition ? { returnCondition: spec.returnCondition } : {}),
      ...(spec.resolvesTo ? { resolvesTo: spec.resolvesTo } : {}),
    },
  }
  return addChild(root, spec.parentId, node)
}

/**
 * Mark a branch as merged back into the main line.
 *
 * The node is not removed: "we split off to fix X and it merged back here" is
 * exactly the history that stops the user from wondering what that stray work
 * was. The status is left alone — finishing the work is a separate transition.
 * @param root - subtree root.
 * @param id - branch node id.
 * @param detail - when, what it produced, and where it rejoins (defaults to the origin).
 * @returns the new tree.
 * @throws {Error} when the node is not a branch, is already resolved, or the target is missing.
 */
export function resolveBranch(
  root: AtlasNode,
  id: string,
  detail: { readonly at: number; readonly resolution: string; readonly resolvesTo?: string },
): AtlasNode {
  const node = findNode(root, id)
  if (!node) throw new Error(`no such node: ${id}`)
  if (!node.branch) throw new Error(`node ${id} is not a branch`)
  if (node.branch.resolvedAt !== undefined) {
    throw new Error(`node ${id} is already resolved`)
  }
  const resolution = detail.resolution.trim()
  const target = detail.resolvesTo ?? node.branch.resolvesTo ?? node.branch.originId
  if (!findNode(root, target)) throw new Error(`no such resolvesTo node: ${target}`)
  return mapNode(root, id, (found) => ({
    ...found,
    branch: {
      ...(found.branch as NonNullable<typeof found.branch>),
      resolvesTo: target,
      resolvedAt: detail.at,
      ...(resolution ? { resolution } : {}),
    },
    updatedAt: detail.at,
  }))
}

/** One kind per depth, or `null` past the bottom. */
const KIND_AT_DEPTH: readonly (NodeKind | null)[] = [
  null,
  'project',
  'module',
  'task',
  'item',
]

/**
 * The kind that lives at a given depth.
 * @param depth - 1-based depth from the project root.
 * @returns the kind, or `null` beyond {@link MAX_DEPTH}.
 */
export function kindAtDepth(depth: number): NodeKind | null {
  return KIND_AT_DEPTH[depth] ?? null
}

/**
 * How many levels a subtree spans, counting itself.
 * @param node - subtree root.
 * @returns 1 for a leaf.
 */
export function subtreeHeight(node: AtlasNode): number {
  let deepest = 0
  for (const child of node.children) {
    deepest = Math.max(deepest, subtreeHeight(child))
  }
  return deepest + 1
}

/**
 * Re-derive every kind in a subtree from the subtree root's new kind.
 *
 * Level is positional, not intrinsic: the same content is a "module" only because
 * it sits one level under the project. Moving a subtree therefore renames its
 * levels, and that has to happen all the way down or the ladder breaks.
 * @param node - subtree root, already carrying its new kind.
 * @param fromDepth - depth of the subtree root after the move.
 * @returns the rewritten subtree.
 * @throws {Error} when the subtree no longer fits within {@link MAX_DEPTH}.
 */
function rederiveKinds(node: AtlasNode, fromDepth: number): AtlasNode {
  const rewrite = (current: AtlasNode, depth: number): AtlasNode => {
    const kind = kindAtDepth(depth)
    if (!kind) {
      throw new Error(
        `moving this subtree would exceed ${MAX_DEPTH} levels (deepest node: '${current.title}')`,
      )
    }
    return {
      ...current,
      kind,
      children: current.children.map((child) => rewrite(child, depth + 1)),
    }
  }
  return rewrite(node, fromDepth)
}

/**
 * Move a node and its whole subtree under a different parent.
 *
 * Reorganising a plan is normal — the first cut is rarely the right one — and
 * without this the only way to fix a structure is to rebuild it, which throws away
 * every status and every recorded result. Because level is positional, the moved
 * subtree has its kinds re-derived: what was a module can become a task.
 * @param root - subtree root (the project).
 * @param nodeId - node to move.
 * @param newParentId - destination parent.
 * @param at - epoch milliseconds.
 * @returns the new tree.
 * @throws {Error} when either id is missing, the destination is the node itself or
 *   one of its descendants, the destination cannot hold children, or the subtree
 *   would exceed the depth limit.
 */
export function moveNode(
  root: AtlasNode,
  nodeId: string,
  newParentId: string,
  at: number,
): AtlasNode {
  if (nodeId === root.id) throw new Error('cannot move the project root')
  const node = findNode(root, nodeId)
  if (!node) throw new Error(`no such node: ${nodeId}`)
  const newParent = findNode(root, newParentId)
  if (!newParent) throw new Error(`no such destination: ${newParentId}`)
  if (newParentId === nodeId) throw new Error('cannot move a node under itself')
  if (findNode(node, newParentId)) {
    throw new Error('cannot move a node under one of its own descendants')
  }
  const newKind = childKindOf(newParent.kind)
  if (!newKind) {
    throw new Error(
      `'${newParent.kind}' is the deepest level (${MAX_DEPTH}); it cannot hold children`,
    )
  }
  const newDepth = depthOfKind(newKind)
  const height = subtreeHeight(node)
  if (newDepth + height - 1 > MAX_DEPTH) {
    throw new Error(
      `this subtree is ${height} level(s) deep; at depth ${newDepth} it would exceed ${MAX_DEPTH}`,
    )
  }

  const moved = rederiveKinds({ ...node, kind: newKind, updatedAt: at }, newDepth)

  // Detach first: an adjacent move (sibling → sibling) would otherwise still find
  // the old copy in place and `addChild` would refuse the duplicate id.
  const detach = (current: AtlasNode): AtlasNode => ({
    ...current,
    children: current.children.filter((child) => child.id !== nodeId).map(detach),
  })
  return addChild(detach(root), newParentId, moved)
}
