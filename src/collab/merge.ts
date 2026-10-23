/**
 * Three-way merge for one workspace's document.
 *
 * Two people editing the same plan is the whole point of the collaboration module, and a
 * whole-file last-write-wins would silently delete a colleague's work. So the merge is
 * per node, against a common base:
 *
 *   only one side changed   → take that side
 *   both changed identically → take it, no conflict
 *   both changed differently → take the newer one, but RECORD the loser in `conflicts`
 *   deleted on one side, edited on the other → keep the edit, record the conflict
 *
 * Nothing is thrown away silently. A merge whose result cannot be explained is worse than
 * no merge, because nobody can tell which decision was made on their behalf.
 *
 * Pure by construction: no IO, no clock (the caller passes `at`), no harness types. That is
 * what makes the nasty cases — deletions racing edits, status diverging — testable at all.
 */
import type {
  AtlasDocument,
  CanvasPoint,
  AtlasNode,
  AtlasProject,
  Breakdown,
  Participant,
} from '../model/types.ts'

/** Why two sides could not be merged automatically. */
export type ConflictKind = 'both-edited' | 'status-diverged' | 'deleted-vs-edited' | 'breakdown-diverged'

/** One thing a human has to decide. */
export interface MergeConflict {
  readonly kind: ConflictKind
  /** Node the conflict is about; absent for project-level conflicts. */
  readonly nodeId?: string
  readonly title?: string
  /** What each side said, for the panel to show side by side. */
  readonly local?: string
  readonly remote?: string
  /** What the merge kept, and why. */
  readonly resolution: string
}

/** What happened, for the summary the model reads. */
export interface MergeStats {
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly unchanged: number
}

/** Result of a merge. */
export interface MergeResult {
  readonly document: AtlasDocument
  readonly conflicts: readonly MergeConflict[]
  readonly stats: MergeStats
}

/** Counters while merging; the exported shape is readonly. */
interface MutableStats {
  added: number
  updated: number
  removed: number
  unchanged: number
}

/** Fields whose change means "this node was edited". */
const SIGNIFICANT = [
  'title',
  'note',
  'status',
  'reason',
  'returnCondition',
  'result',
  'dependsOn',
  'assignee',
  'branch',
] as const

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Shallow equality over the fields that count as an edit. */
function sameNode(a: AtlasNode, b: AtlasNode): boolean {
  if (a.id !== b.id) return false
  for (const field of SIGNIFICANT) {
    if (!same((a as unknown as Record<string, unknown>)[field], (b as unknown as Record<string, unknown>)[field])) {
      return false
    }
  }
  const aChildren = a.children.map((child) => child.id).join(',')
  const bChildren = b.children.map((child) => child.id).join(',')
  return aChildren === bChildren
}

/** Index every node in a tree by id. */
function indexById(root: AtlasNode, into = new Map<string, AtlasNode>()): Map<string, AtlasNode> {
  into.set(root.id, root)
  for (const child of root.children) indexById(child, into)
  return into
}

/** Key for one history entry, so the union can be de-duplicated. */
function historyKey(change: { at: number; by: string; from: string; to: string; participant?: string }): string {
  return `${change.at}|${change.by}|${change.participant ?? ''}|${change.from}|${change.to}`
}

/** Union two histories, oldest first. */
function mergeHistory(
  local: AtlasNode['history'],
  remote: AtlasNode['history'],
): AtlasNode['history'] {
  const seen = new Map<string, AtlasNode['history'][number]>()
  for (const change of [...local, ...remote]) {
    const key = historyKey(change)
    if (!seen.has(key)) seen.set(key, change)
  }
  return [...seen.values()].sort((a, b) => a.at - b.at)
}

/** Merge the children of one node. */
function mergeChildren(
  base: AtlasNode | undefined,
  local: AtlasNode,
  remote: AtlasNode,
  conflicts: MergeConflict[],
  stats: MutableStats,
): AtlasNode[] {
  const baseChildren = new Map((base?.children ?? []).map((child) => [child.id, child]))
  const localChildren = new Map(local.children.map((child) => [child.id, child]))
  const remoteChildren = new Map(remote.children.map((child) => [child.id, child]))
  const ids = new Set([...localChildren.keys(), ...remoteChildren.keys()])
  const merged: AtlasNode[] = []

  for (const id of ids) {
    const inLocal = localChildren.get(id)
    const inRemote = remoteChildren.get(id)
    const inBase = baseChildren.get(id)

    if (inLocal && inRemote) {
      merged.push(mergeNode(inBase, inLocal, inRemote, conflicts, stats))
      continue
    }

    // Present on one side only: either added there, or deleted on the other.
    const kept = inLocal ?? inRemote
    if (!kept) continue
    if (!inBase) {
      // Genuinely new on one side.
      stats.added += 1
      merged.push(kept)
      continue
    }
    const otherSideEdited = !sameNode(kept, inBase)
    if (otherSideEdited) {
      // One side deleted it while the other kept editing: keeping the work is the only
      // non-destructive default, and a human gets told about it.
      conflicts.push({
        kind: 'deleted-vs-edited',
        nodeId: id,
        title: kept.title,
        resolution: '保留被编辑的那一份（删除被忽略）',
      })
      merged.push(kept)
      continue
    }
    stats.removed += 1
  }

  return merged
}

/** Merge one node that exists on both sides. */
function mergeNode(
  base: AtlasNode | undefined,
  local: AtlasNode,
  remote: AtlasNode,
  conflicts: MergeConflict[],
  stats: MutableStats,
  /** The project root is scaffolding, not a work item; it must not inflate the counts. */
  countSelf = true,
): AtlasNode {
  const localChanged = !base || !sameNode(local, base)
  const remoteChanged = !base || !sameNode(remote, base)

  let winner = local
  if (localChanged && remoteChanged && !sameNode(local, remote)) {
    // Both moved. Keep the most recent edit, and say so; a silent pick is how work vanishes.
    winner = local.updatedAt >= remote.updatedAt ? local : remote
    const loser = winner === local ? remote : local
    conflicts.push({
      kind: local.status !== remote.status ? 'status-diverged' : 'both-edited',
      nodeId: local.id,
      title: winner.title,
      local: `${local.status} · ${local.title}`,
      remote: `${remote.status} · ${remote.title}`,
      resolution: `采用 ${winner === local ? '本地' : '对端'}（updatedAt 较新）；另一侧的状态为 ${
        loser.status
      }`,
    })
    stats.updated += 1
  } else if (remoteChanged && !localChanged) {
    winner = remote
    if (countSelf) stats.updated += 1
  } else if (localChanged) {
    if (countSelf) stats.updated += 1
  } else if (countSelf) {
    stats.unchanged += 1
  }

  return {
    ...winner,
    history: mergeHistory(local.history, remote.history),
    children: mergeChildren(base, local, remote, conflicts, stats),
  }
}

/** Merge two projects that share an id. */
function mergeProject(
  base: AtlasProject | undefined,
  local: AtlasProject,
  remote: AtlasProject,
  conflicts: MergeConflict[],
  stats: MutableStats,
): AtlasProject {
  const breakdown = mergeBreakdown(base?.breakdown ?? null, local.breakdown, remote.breakdown, conflicts)
  return {
    ...local,
    breakdown,
    // The tree itself is merged; `breakdown` above may come from either side.
    root: mergeNode(base?.root, local.root, remote.root, conflicts, stats, false),
  }
}

/** Take the breakdown whose latest revision is newer; record a conflict when they diverge. */
function mergeBreakdown(
  base: Breakdown | null,
  local: Breakdown | null,
  remote: Breakdown | null,
  conflicts: MergeConflict[],
): Breakdown | null {
  if (!local) return remote
  if (!remote) return local
  const localChanged = !base || !same(local, base)
  const remoteChanged = !base || !same(remote, base)
  if (!localChanged) return remote
  if (!remoteChanged) return local
  if (same(local, remote)) return local

  const localTail = local.revisions?.[local.revisions.length - 1]?.at ?? local.confirmedAt
  const remoteTail = remote.revisions?.[remote.revisions.length - 1]?.at ?? remote.confirmedAt
  const winner = localTail >= remoteTail ? local : remote
  conflicts.push({
    kind: 'breakdown-diverged',
    title: '拆解',
    local: `最后修订 ${new Date(localTail).toISOString()}`,
    remote: `最后修订 ${new Date(remoteTail).toISOString()}`,
    resolution: `采用 ${winner === local ? '本地' : '对端'}的拆解；另一侧的修订需要人工确认`,
  })
  // Revisions are append-only, so keep both sides' history even though one field set wins.
  const revisions = [...(local.revisions ?? []), ...(remote.revisions ?? [])]
  const seen = new Set<string>()
  const union = revisions
    .filter((revision) => {
      const key = `${revision.at}|${revision.reason}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => a.at - b.at)
  return { ...winner, ...(union.length > 0 ? { revisions: union } : {}) }
}

/** Merge two participant lists by id. */
function mergeParticipants(
  local: readonly Participant[] | undefined,
  remote: readonly Participant[] | undefined,
): Participant[] | undefined {
  const all = [...(local ?? []), ...(remote ?? [])]
  if (all.length === 0) return undefined
  const byId = new Map<string, Participant>()
  for (const participant of all) if (!byId.has(participant.id)) byId.set(participant.id, participant)
  return [...byId.values()].sort((a, b) => a.joinedAt - b.joinedAt)
}

/**
 * Merge a colleague's copy into yours.
 * @param base - the last synced state, when one is known; without it every difference reads as an edit on both sides.
 * @param local - your copy.
 * @param remote - theirs.
 * @param at - epoch milliseconds of the merge.
 * @returns the merged document plus everything a human should look at.
 */
export function mergeDocuments(
  base: AtlasDocument | undefined,
  local: AtlasDocument,
  remote: AtlasDocument,
  at: number,
): MergeResult {
  const conflicts: MergeConflict[] = []
  const stats = { added: 0, updated: 0, removed: 0, unchanged: 0 }

  const baseProjects = indexProjects(base)
  const localProjects = indexProjects(local)
  const remoteProjects = indexProjects(remote)
  const projectIds = new Set([...localProjects.keys(), ...remoteProjects.keys()])

  const projects: AtlasProject[] = []
  for (const id of projectIds) {
    const inLocal = localProjects.get(id)
    const inRemote = remoteProjects.get(id)
    if (inLocal && inRemote) {
      projects.push(mergeProject(baseProjects.get(id), inLocal, inRemote, conflicts, stats))
    } else {
      const kept = inLocal ?? inRemote
      if (!kept) continue
      if (!baseProjects.has(id)) stats.added += 1
      projects.push(kept)
    }
  }

  const pendingById = new Map(local.pending.map((item) => [item.id, item]))
  for (const item of remote.pending) if (!pendingById.has(item.id)) pendingById.set(item.id, item)

  // `activeProjectId` is a single choice, not mergeable: prefer the local one unless it no
  // longer exists after the merge.
  const activeProjectId = projects.some((project) => project.id === local.activeProjectId)
    ? local.activeProjectId
    : (projects[0]?.id ?? null)

  return {
    document: {
      version: 1,
      workspaceKey: local.workspaceKey,
      activeProjectId,
      projects,
      pending: [...pendingById.values()],
      ...(mergeParticipants(local.participants, remote.participants) === undefined
        ? {}
        : { participants: mergeParticipants(local.participants, remote.participants) }),
      // Positions are unioned with local priority: you keep the cards you moved, and gain
      // placements for nodes you never touched. A layout conflict is not worth a human's
      // attention, so it never becomes a conflict entry.
      ...(mergeLayout(local.layout, remote.layout) === undefined
        ? {}
        : { layout: mergeLayout(local.layout, remote.layout) }),
      ...(at === 0 ? {} : {}),
    },
    conflicts,
    stats,
  }
}


/** Union two canvases by node id, preferring the local position. */
function mergeLayout(
  local: Readonly<Record<string, CanvasPoint>> | undefined,
  remote: Readonly<Record<string, CanvasPoint>> | undefined,
): Readonly<Record<string, CanvasPoint>> | undefined {
  if (!local && !remote) return undefined
  return { ...(remote ?? {}), ...(local ?? {}) }
}

function indexProjects(document: AtlasDocument | undefined): Map<string, AtlasProject> {
  const map = new Map<string, AtlasProject>()
  for (const project of document?.projects ?? []) map.set(project.id, project)
  return map
}
