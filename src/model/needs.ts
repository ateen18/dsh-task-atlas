/**
 * Preconditions: what a node needs before it can start.
 *
 * Replaces "who came first in the conversation" as the meaning of a dependency edge. The
 * test is whether the thing can be *named*: if `B` needs `A`'s 字段口径表, the need is
 * "字段口径表" and it points at `A`. If nothing can be named, it was never a dependency.
 *
 * `dependsOn` is kept as a derived id list rather than replaced, so every existing consumer
 * — the tree's `⇢ 前置` badge, the cycle check, the injection text — keeps working without
 * knowing that needs exist.
 */
import type { AtlasNode, NodeNeed } from './types.ts'

/** The provider ids among a node's needs, de-duplicated and in order. */
export function providerIds(needs: readonly NodeNeed[] | undefined): string[] {
  const ids = (needs ?? [])
    .map((need) => need.fromNodeId?.trim())
    .filter((id): id is string => Boolean(id))
  return [...new Set(ids)]
}

/** Needs that nothing in the plan provides: the gaps worth surfacing. */
export function externalNeeds(needs: readonly NodeNeed[] | undefined): NodeNeed[] {
  return (needs ?? []).filter((need) => !need.fromNodeId?.trim())
}

/** Needs not marked as satisfied. "Not stated" counts as unmet — silence is not evidence. */
export function unmetNeeds(needs: readonly NodeNeed[] | undefined): NodeNeed[] {
  return (needs ?? []).filter((need) => need.satisfied !== true)
}

/**
 * Build the node fields for a set of needs, keeping `dependsOn` in sync.
 * @param needs - the preconditions, already normalised.
 * @returns the two fields to write onto a node.
 */
export function needsFields(needs: readonly NodeNeed[]): {
  needs: readonly NodeNeed[]
  dependsOn?: readonly string[]
} {
  const providers = providerIds(needs)
  return {
    needs,
    ...(providers.length > 0 ? { dependsOn: providers } : {}),
  }
}

/**
 * The label explaining why `to` depends on `from`, for the edge in the graph.
 * @param node - the dependent node.
 * @param fromId - the provider.
 * @returns the need's label, or undefined when the edge carries no explanation.
 */
export function edgeLabel(node: AtlasNode, fromId: string): string | undefined {
  const need = (node.needs ?? []).find((candidate) => candidate.fromNodeId?.trim() === fromId)
  return need?.label.trim() || undefined
}

/** One line summarising a node's readiness, or undefined when it has no needs. */
export function readinessLine(node: AtlasNode): string | undefined {
  const needs = node.needs ?? []
  if (needs.length === 0) return undefined
  const unmet = unmetNeeds(needs)
  const external = externalNeeds(needs)
  if (unmet.length === 0) return `开工条件 ${needs.length} 项，都已满足。`
  return (
    `开工条件 ${needs.length} 项，缺 ${unmet.length} 项` +
    (external.length > 0 ? `（其中 ${external.length} 项是外部条件）` : '') +
    '。'
  )
}
