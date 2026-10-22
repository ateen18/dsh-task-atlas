/**
 * "Is this workspace a blank page, or has work already happened here?"
 *
 * The answer changes how kickoff runs, so it has to be decided from durable
 * evidence — the harness's own session corpus — rather than from whatever the
 * current conversation happens to look like:
 *
 * - **Nothing came before** → nothing to reconstruct. Ask the user whether to
 *   draft a breakdown (fast) or be interviewed (detailed).
 * - **Work already happened** → the project has already been described, at
 *   length, in conversation. Making the user re-explain it is exactly the failure
 *   this plugin exists to prevent, so the plugin reconstructs the blueprint from
 *   that material instead.
 *
 * "Already happened" has two shapes, and both count:
 *
 * 1. **Other conversations in this workspace** — the user worked here before
 *    installing the plugin.
 * 2. **This conversation is already substantial** — a single long, dense session
 *    is just as much prior work as three short ones. This is the common case for
 *    a plugin installed mid-project: everything is in one very long thread.
 *
 * Pure and dependency-free so the judgement can be tested without a harness.
 */

/** The slice of a `SessionRecord` this module reads. */
export interface SessionRecordLike {
  readonly header: {
    readonly id: string
    /** Absolute working directory the session was created in. */
    readonly cwd?: string
    /** Epoch milliseconds. */
    readonly createdAt: number
    /**
     * Coarse product classification. `subagent` marks a delegation child.
     *
     * This matters: subagent sessions live in the same workspace and are created
     * while you work, so counting them as "history" makes every workspace look
     * like it has prior work the moment the agent delegates anything — and the
     * whole point of this verdict is telling real prior work from noise.
     */
    readonly origin?: 'subagent'
    /** The session this one was forked or seeded from, if any. */
    readonly parentSession?: string
  }
}

/** The slice of a `SessionEventRecord` this module reads. */
export interface SessionEventLike {
  /** Session event discriminant, e.g. `user/message` or `turn/start`. */
  readonly type: string
}

/** One prior conversation, as reported to the model and the panel. */
export interface PriorSession {
  readonly id: string
  /** Epoch milliseconds. */
  readonly createdAt: number
}

/** How much work one session already contains. */
export interface SessionRichness {
  /** How many `user/message` events the session has. */
  readonly userMessages: number
  /** How many `turn/start` events the session has. */
  readonly turns: number
  /** Total events, as a coarse size signal. */
  readonly events: number
}

/** Why kickoff decided this workspace has prior work. */
export type HistoryReason = 'prior-sessions' | 'current-session'

/** Verdict for one workspace. */
export interface WorkspaceHistory {
  /** How many independent conversations in this workspace predate the current one. */
  readonly priorSessionCount: number
  /** Newest first, capped at {@link MAX_REPORTED_PRIOR_SESSIONS}. */
  readonly priorSessions: readonly PriorSession[]
  /** Creation time of the newest prior session. */
  readonly latestCreatedAt?: number
  /** How much work the session being opened already contains. */
  readonly currentSession?: SessionRichness
  /** Which signals fired; empty when the workspace really is blank. */
  readonly reasons: readonly HistoryReason[]
  /** Whether kickoff should reconstruct from what came before instead of interviewing. */
  readonly hasHistory: boolean
}

/** Cap on how many prior sessions are enumerated back to the caller. */
export const MAX_REPORTED_PRIOR_SESSIONS = 20

/**
 * How many user messages make a session count as "work already happened".
 *
 * Three, not one: a single question ("装好了吗？") is not prior work, while three
 * exchanges means the model and the user have already established context that
 * the blueprint should absorb rather than ask for again.
 */
export const SUBSTANTIAL_USER_MESSAGES = 3

/**
 * Normalise a path for comparison.
 *
 * Sessions record `cwd` as the harness saw it, which can differ from a panel query
 * only by separators, casing, or a trailing slash.
 * @param value - a workspace path.
 * @returns the comparable form.
 */
export function normalisePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Count how much work one session already contains.
 * @param events - the session's event records.
 * @returns the counts.
 */
export function summariseSessionRichness(
  events: readonly SessionEventLike[],
): SessionRichness {
  let userMessages = 0
  let turns = 0
  for (const event of events) {
    if (event.type === 'user/message') userMessages += 1
    else if (event.type === 'turn/start') turns += 1
  }
  return { userMessages, turns, events: events.length }
}

/**
 * Whether a session is substantial enough to count as prior work.
 * @param richness - the counts, or `undefined` when unknown.
 * @returns whether the session already carries real context.
 */
export function isSubstantialSession(richness: SessionRichness | undefined): boolean {
  if (!richness) return false
  return richness.userMessages >= SUBSTANTIAL_USER_MESSAGES
}

/**
 * Decide whether a workspace has prior work, counting only other conversations.
 *
 * Use {@link withCurrentSession} to fold in the session being opened.
 * @param records - the harness's session corpus (live or persisted).
 * @param options - which workspace, and which session is "now".
 * @returns the verdict.
 */
export function summariseWorkspaceHistory(
  records: readonly SessionRecordLike[],
  options: { readonly workspacePath: string; readonly currentSessionId?: string },
): WorkspaceHistory {
  const wanted = normalisePath(options.workspacePath)
  const prior = records
    .filter((record) => {
      // The session asking is never its own history.
      if (record.header.id === options.currentSessionId) return false
      // Delegation children are internal machinery, not prior user work. Without
      // this, one `subagent` call is enough to make a brand-new workspace look
      // like it already has a project to reconstruct.
      if (record.header.origin === 'subagent') return false
      // A fork or seed of the current session is part of *this* conversation's
      // lineage, so it is not independent prior work either.
      if (
        options.currentSessionId &&
        record.header.parentSession === options.currentSessionId
      ) {
        return false
      }
      const cwd = record.header.cwd
      return typeof cwd === 'string' && normalisePath(cwd) === wanted
    })
    .map((record) => ({ id: record.header.id, createdAt: record.header.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)

  const hasPrior = prior.length > 0
  return {
    priorSessionCount: prior.length,
    priorSessions: prior.slice(0, MAX_REPORTED_PRIOR_SESSIONS),
    ...(prior[0] ? { latestCreatedAt: prior[0].createdAt } : {}),
    reasons: hasPrior ? ['prior-sessions'] : [],
    hasHistory: hasPrior,
  }
}

/**
 * Fold the current session's own weight into a verdict.
 *
 * A plugin installed mid-project usually meets one long thread rather than
 * several short ones, and that thread contains just as much to reconstruct from.
 * @param base - verdict from {@link summariseWorkspaceHistory}.
 * @param richness - counts for the session being opened, when known.
 * @returns the combined verdict.
 */
export function withCurrentSession(
  base: WorkspaceHistory,
  richness: SessionRichness | undefined,
): WorkspaceHistory {
  const substantial = isSubstantialSession(richness)
  const reasons: HistoryReason[] = [...base.reasons]
  if (substantial) reasons.push('current-session')
  return {
    ...base,
    ...(richness ? { currentSession: richness } : {}),
    reasons,
    hasHistory: base.hasHistory || substantial,
  }
}

/**
 * Find the workspace a session belongs to.
 *
 * This is the authoritative answer to "which workspace is this panel looking at",
 * and it is why a cold start no longer leaves the panel blank: the corpus knows
 * every session's `cwd` even when the live event stream has not replayed anything.
 * @param records - the harness's session corpus.
 * @param sessionId - the session to look up.
 * @returns its working directory, or `undefined`.
 */
export function cwdOfSession(
  records: readonly SessionRecordLike[],
  sessionId: string,
): string | undefined {
  for (const record of records) {
    if (record.header.id !== sessionId) continue
    const cwd = record.header.cwd
    if (typeof cwd === 'string' && cwd.length > 0) return cwd
  }
  return undefined
}
