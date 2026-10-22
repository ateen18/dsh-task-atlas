/**
 * Data model for one workspace's project atlas.
 *
 * Everything here is plain JSON-serializable data: it is what `ctx.storageDomain`
 * persists, what the Markdown mirror renders, and what the browser panel reads.
 * No behaviour lives in this module except the type declarations.
 */

/** Fixed level of a node. Depth is 1-based and capped at {@link MAX_DEPTH}. */
export type NodeKind = 'project' | 'module' | 'task' | 'item'

/**
 * Node status. Deliberately richer than done/not-done:
 * the three "negative" states are the whole point of the plugin, because
 * "finished, but now needs rework, because X" is the state long tasks actually
 * spend their time in and no existing DSH plugin can express it.
 */
export type NodeStatus =
  | 'pending'
  | 'active'
  | 'done'
  | 'rework'
  | 'blocked'
  | 'dropped'

/** Who performed a change. */
export type Actor = 'ai' | 'user'

/**
 * One person sharing a project.
 *
 * The id is chosen by the person, not derived from a machine: machines get replaced and
 * responsibility has to follow a human. It also appears in every history entry, so it has
 * to stay small and stable.
 */
export interface Participant {
  readonly id: string
  readonly name: string
  /** Epoch milliseconds. */
  readonly joinedAt: number
}

/** One entry in a node's status history; the audit trail behind "why is it like this". */
export interface StatusChange {
  /** Epoch milliseconds. */
  readonly at: number
  /** Who asked for the change. */
  readonly by: Actor
  /**
   * Which person, when a human asked for it.
   *
   * Optional rather than folded into {@link Actor} on purpose: stored records say
   * `by: 'user'`, and turning that into a union would invalidate every document on disk.
   * An absent id reads as "a human whose identity predates sharing".
   */
  readonly participant?: string
  readonly from: NodeStatus
  readonly to: NodeStatus
  /** Why, for the states that require it. */
  readonly reason?: string
  /** Who confirmed it, when the target state needs user sign-off. */
  readonly confirmedBy?: Actor
  /** Which person confirmed it, when known. */
  readonly confirmedParticipant?: string
}

/**
 * Branch provenance: a temporary thing that was inserted into the plan.
 *
 * This is the second thing no existing plugin models. A branch is not just
 * another child — it remembers where it came from, why it exists, and how
 * (and where) it rejoins the main line.
 */
export interface BranchMeta {
  /** Node the branch was split off from (required). */
  readonly originId: string
  /** Why the branch exists: user interruption, discovered prerequisite, external blocker, … (required). */
  readonly trigger: string
  /** Condition that ends the branch and returns to the main line. */
  readonly returnCondition?: string
  /** Node the branch merges back into; defaults to {@link originId}. */
  readonly resolvesTo?: string
  /** When the branch was resolved back. */
  readonly resolvedAt?: number
  /** What the branch produced when it rejoined. */
  readonly resolution?: string
}

/**
 * One thing that must exist before a node can start.
 *
 * This replaced "the conversation did A before B" as the basis for the dependency graph,
 * because ordering is not dependency: doing the easy or urgent thing first is scheduling,
 * and drawing it as an edge makes the graph lie. A need has to be *nameable* — "要什么" —
 * and either produced by another node or external to the plan entirely.
 *
 * External needs matter as much as internal ones: they are usually the part of the project
 * nobody wrote down yet, so hiding them would hide exactly the gap worth seeing.
 */
export interface NodeNeed {
  /** What must exist, e.g. 「字段口径表」. */
  readonly label: string
  /** The node that provides it; absent means an external condition. */
  readonly fromNodeId?: string
  /** Whether it is already satisfied. Absent means "not stated". */
  readonly satisfied?: boolean
}

/** One node of the plan tree. */
/**
 * Something a node produced that a person may want to open again later.
 *
 * The failure this fixes is concrete: a node was marked done with "产出了一个带界面的分析终端，
 * 跑在 http://…:8511/", the address existed only inside a paragraph of the chat, and finding it
 * again meant scrolling the transcript. A result is prose; an output is a handle.
 */
export interface NodeOutput {
  /** What kind of handle this is; drives the icon and what a click does. */
  readonly kind: 'url' | 'file' | 'dir'
  /** Short human label, e.g. 「分析终端」. */
  readonly label: string
  /** The address or path itself. */
  readonly target: string
  /** Optional precision: how to run it, which command, caveats. */
  readonly note?: string
}

export interface AtlasNode {
  /** Stable short id, unique across the whole document (e.g. `m-3f2a`). */
  readonly id: string
  readonly kind: NodeKind
  /** Never truncated in the UI; wraps instead. */
  readonly title: string
  readonly note?: string
  readonly status: NodeStatus
  /** Required by — and meaningful for — `rework` / `blocked` / `dropped`. */
  readonly reason?: string
  /** For `blocked`: what would unblock it. */
  readonly returnCondition?: string
  /** Required by `done`: what was produced and how it is accepted. */
  readonly result?: string
  /**
   * Things this node produced that should be re-openable, not merely described.
   *
   * Kept separate from `result` on purpose: the prose explains, the outputs are the handles.
   * A URL that only exists inside a paragraph is a URL you have to search the transcript for.
   */
  readonly outputs?: readonly NodeOutput[]
  readonly branch?: BranchMeta
  /**
   * Node ids that must be finished before this one can start.
   *
   * The hierarchy says what a node *is part of*; this says what it *waits for*.
   * Those are different relations and a plan needs both: without this the only
   * readable question is "what is under what", never "what can I start now".
   */
  readonly dependsOn?: readonly string[]
  /**
   * Preconditions, the authoritative source for the dependency graph.
   *
   * dependsOn is kept as the derived list of provider ids so every existing consumer
   * (tree badge, cycle check, injection) keeps working unchanged.
   */
  readonly needs?: readonly NodeNeed[]
  /** Who is doing this piece. Absent means unassigned. */
  readonly assignee?: string
  /** How the node came to exist. */
  readonly origin: Actor
  /** Session message / tool-call ids that produced or last touched this node. */
  readonly evidence?: readonly string[]
  readonly history: readonly StatusChange[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly children: readonly AtlasNode[]
}

/** One core deliverable of the project breakdown, with its own acceptance test. */
export interface Deliverable {
  readonly text: string
  /** How you would check this is actually delivered. */
  readonly acceptance: string
}

/** Which kickoff interview the user chose. */
export type BreakdownMode = 'fast' | 'detailed'

/** Which breakdown field a revision touched. */
export type BreakdownField =
  | 'coreIntent'
  | 'deliverables'
  | 'decomposition'
  | 'acceptance'
  | 'outOfScope'
  | 'constraints'
  | 'priorityOrder'
  | 'mode'

/** One field's before/after, rendered for display rather than stored as data. */
export interface BreakdownFieldChange {
  readonly field: BreakdownField
  readonly from: string
  readonly to: string
}

/**
 * One amendment to the breakdown.
 *
 * The breakdown is a living document: understanding changes as the work happens, and
 * a breakdown that cannot move simply drifts out of date and stops being read. What
 * must not drift is the *record* of why it moved — so every amendment carries a
 * required reason, exactly like a status change does.
 */
export interface BreakdownRevision {
  /** Epoch milliseconds. */
  readonly at: number
  readonly by: Actor
  /** Why the breakdown changed. Required. */
  readonly reason: string
  /** What changed, field by field. */
  readonly changes: readonly BreakdownFieldChange[]
}

/**
 * The project breakdown: the answer to "what was this whole thing supposed to be",
 * pinned at the top of the panel so it survives any amount of conversation drift.
 */
export interface Breakdown {
  /** Q1 — what problem this project exists to solve. */
  readonly coreIntent: string
  /** Q2 — the things you hand over, each independently checkable. */
  readonly deliverables: readonly Deliverable[]
  /** Q3 — the module breakdown, in the user's own words. */
  readonly decomposition: readonly string[]
  /** Q4 — how the whole thing is judged finished. */
  readonly acceptance: string
  /** Q5 — explicitly out of scope, so the plan cannot creep. */
  readonly outOfScope: readonly string[]
  /** Q6 — technical constraints and prerequisites. */
  readonly constraints: readonly string[]
  /** Q7 — what goes first, what may run in parallel. */
  readonly priorityOrder: readonly string[]
  readonly mode: BreakdownMode
  readonly confirmedAt: number
  /** Every amendment since {@link confirmedAt}, oldest first. Absent when never amended. */
  readonly revisions?: readonly BreakdownRevision[]
}

/** One project (a workspace may hold several; exactly one is active). */
export interface AtlasProject {
  readonly id: string
  readonly title: string
  /** `null` until the kickoff breakdown is confirmed. */
  readonly breakdown: Breakdown | null
  /** Root node, always `kind: 'project'`, same id as the project. */
  readonly root: AtlasNode
  /**
   * The node the AI declared it is working on right now (`atlas_focus`).
   *
   * Status is a node property and several nodes may legitimately be `active` at
   * once; focus is "where attention is", which is singular by definition. The
   * panel highlights this node and auto-expands its path to the root. When it is
   * unset (fresh session, AI forgot to declare), the panel degrades to "the most
   * recently updated active node" rather than highlighting nothing.
   */
  readonly focusedNodeId?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * A status change the AI proposed but is not allowed to apply on its own
 * (see the tiered-authorization decision: `rework` / `blocked` / `dropped` need
 * user sign-off). The panel surfaces these in a "pending" strip.
 */
export interface PendingConfirmation {
  readonly id: string
  readonly nodeId: string
  readonly from: NodeStatus
  readonly to: NodeStatus
  readonly reason?: string
  readonly result?: string
  readonly proposedBy: Actor
  readonly at: number
}

/** The whole persisted document for one workspace. */
export interface AtlasDocument {
  readonly version: 1
  /** Derived from the workspace path; one document per workspace. */
  readonly workspaceKey: string
  readonly activeProjectId: string | null
  readonly projects: readonly AtlasProject[]
  readonly pending: readonly PendingConfirmation[]
  /**
   * People sharing this project.
   *
   * Absent on every document written before sharing existed, which reads as "just me".
   */
  readonly participants?: readonly Participant[]
}
