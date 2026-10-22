/**
 * Dependency reasoning.
 *
 * A plan is not only a hierarchy — it is also a partial order. "B needs A done
 * first" is information the tree cannot express, and it is exactly what answers
 * "what can I start now" and "what is blocked by what". This module owns the graph
 * math; it is pure and knows nothing about rendering.
 *
 * Convention: `node.dependsOn = [a]` means **a must come before node**, so the
 * edge points from `a` to `node` (upstream → downstream).
 */

/** The two fields this module reads from a node. */
export interface DependencyNode {
  readonly id: string
  readonly dependsOn?: readonly string[]
}

/** Direct upstream and downstream neighbours of one node. */
export interface Neighbours {
  /** Nodes this one depends on. */
  readonly upstream: readonly string[]
  /** Nodes that depend on this one. */
  readonly downstream: readonly string[]
}

/** Result of a dependency check. */
export type DependencyCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DependencyIssue; readonly message: string }

/** Why a dependency edit was refused. */
export type DependencyIssue = 'UNKNOWN_NODE' | 'SELF_DEPENDENCY' | 'CYCLE'

/**
 * Find a dependency cycle that would be created by adding `edges`.
 *
 * A cycle is fatal, not cosmetic: if A needs B and B needs A, neither can ever
 * start, and the graph stops meaning anything. Detected before the write rather
 * than reported afterwards, because a cycle in the stored data would poison every
 * later read.
 * @param nodes - the whole graph after the proposed edit.
 * @returns the cycle as an id path (`[a, b, a]`), or `undefined` when acyclic.
 */
export function findCycle(
  nodes: readonly DependencyNode[],
): readonly string[] | undefined {
  const edges = new Map<string, readonly string[]>()
  for (const node of nodes) edges.set(node.id, node.dependsOn ?? [])

  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const walk = (id: string): readonly string[] | undefined => {
    const current = state.get(id)
    if (current === 'done') return undefined
    if (current === 'visiting') {
      // `dependsOn` edges point backwards, so the cycle reads in the stack order.
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue
      const cycle = walk(next)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    return undefined
  }

  for (const node of nodes) {
    const cycle = walk(node.id)
    if (cycle) return cycle
  }
  return undefined
}

/**
 * Validate a proposed `dependsOn` value for one node.
 * @param nodes - the whole graph, with the node's dependency list already replaced.
 * @param id - the node being edited.
 * @returns the verdict, with a message that can be shown verbatim.
 */
export function checkDependencies(
  nodes: readonly DependencyNode[],
  id: string,
): DependencyCheck {
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) {
    return { ok: false, code: 'UNKNOWN_NODE', message: `没有这个节点：${id}` }
  }
  const known = new Set(nodes.map((candidate) => candidate.id))
  for (const dependency of node.dependsOn ?? []) {
    if (dependency === id) {
      return {
        ok: false,
        code: 'SELF_DEPENDENCY',
        message: '一个节点不能以自己为前置条件',
      }
    }
    if (!known.has(dependency)) {
      return {
        ok: false,
        code: 'UNKNOWN_NODE',
        message: `前置节点不存在：${dependency}`,
      }
    }
  }
  const cycle = findCycle(nodes)
  if (cycle) {
    return {
      ok: false,
      code: 'CYCLE',
      message: `前置关系成环，会互相等待：[${cycle.join(' → ')}]`,
    }
  }
  return { ok: true }
}
