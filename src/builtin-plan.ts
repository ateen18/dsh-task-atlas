/**
 * Read-only view of the harness's own plan state.
 *
 * Decision D6 is "coexist, one-way projection": the built-in `todo_write` list
 * and the goal are shown inside the atlas panel as **read-only** children, and
 * this plugin never writes them. That is why this module only *observes* the
 * session event stream and keeps an in-memory mirror — nothing here is
 * persisted, and nothing here can affect the harness's own state.
 *
 * It also remembers each session's working directory, which is how an HTTP
 * request that only knows a `sessionId` can still find the right workspace
 * document.
 */

/** One built-in todo item, exactly as `todo/write` carries it. */
export interface BuiltinTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** The goal snapshot the harness exposes, narrowed to what the panel shows. */
export interface BuiltinGoal {
  readonly objective: string
  readonly phase?: string
  readonly blockerReason?: string
}

/** Everything the panel mirrors from the harness, per session. */
export interface BuiltinPlan {
  readonly sessionId: string
  readonly cwd?: string
  readonly todos: readonly BuiltinTodo[]
  readonly goal?: BuiltinGoal
  /** Epoch milliseconds of the last observed change. */
  readonly observedAt: number
}

const TODO_STATUSES: readonly BuiltinTodo['status'][] = [
  'pending',
  'in_progress',
  'completed',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTodos(value: unknown): readonly BuiltinTodo[] | undefined {
  if (!Array.isArray(value)) return undefined
  const todos: BuiltinTodo[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const content = item.content
    const status = item.status
    if (typeof content !== 'string') continue
    if (typeof status !== 'string') continue
    if (!TODO_STATUSES.includes(status as BuiltinTodo['status'])) continue
    todos.push({ content, status: status as BuiltinTodo['status'] })
  }
  return todos
}

function parseGoal(value: unknown): BuiltinGoal | undefined {
  if (!isRecord(value)) return undefined
  const goal = value.goal
  if (!isRecord(goal)) return undefined
  const objective = goal.objective
  if (typeof objective !== 'string') return undefined
  const phase = goal.phase
  const blockerReason = goal.blockerReason
  return {
    objective,
    ...(typeof phase === 'string' ? { phase } : {}),
    ...(typeof blockerReason === 'string' ? { blockerReason } : {}),
  }
}

/** The minimum a session must expose for this cache. */
export interface ObservedSession {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/**
 * In-memory mirror of every session's built-in plan.
 *
 * Nothing is persisted: the goal and the todo list are the harness's own durable
 * state, reconstructed by it on resume, and a restart here only means the panel
 * shows them again after the next event.
 */
export class BuiltinPlanCache {
  private readonly plans = new Map<string, BuiltinPlan>()

  /**
   * Fold one committed session event into the mirror.
   * @param session - the session the event belongs to.
   * @param event - the committed event; only `todo/write` and `goal/change` matter.
   * @param now - epoch milliseconds.
   */
  observe(session: ObservedSession, event: unknown, now: number): void {
    if (!isRecord(event)) return
    const type = event.type
    const data = event.data
    const previous = this.plans.get(session.id)
    const cwd = session.header?.cwd ?? previous?.cwd

    if (type === 'todo/write') {
      const todos = isRecord(data) ? parseTodos(data.todos) : undefined
      if (!todos) return
      this.plans.set(session.id, {
        sessionId: session.id,
        ...(cwd ? { cwd } : {}),
        todos,
        ...(previous?.goal ? { goal: previous.goal } : {}),
        observedAt: now,
      })
      return
    }

    if (type === 'goal/change') {
      const goal = parseGoal(data)
      const todos = previous?.todos ?? []
      this.plans.set(session.id, {
        sessionId: session.id,
        ...(cwd ? { cwd } : {}),
        todos,
        ...(goal ? { goal } : {}),
        observedAt: now,
      })
      return
    }

    // Remember the session the first time ANY event arrives for it, even when the
    // header carries no cwd: "seen this session, no cwd in its header" is a
    // different failure from "seen nothing at all", and the panel's error text
    // has to be able to tell them apart.
    if (!previous) {
      this.plans.set(session.id, {
        sessionId: session.id,
        ...(cwd ? { cwd } : {}),
        todos: [],
        observedAt: now,
      })
    }
  }

  /**
   * Read one session's mirror.
   * @param sessionId - session id.
   * @returns the mirrored plan, or `undefined` before the first observed event.
   */
  get(sessionId: string): BuiltinPlan | undefined {
    return this.plans.get(sessionId)
  }

  /**
   * Resolve a session's working directory.
   * @param sessionId - session id.
   * @returns the cwd last observed for it.
   */
  cwdOf(sessionId: string): string | undefined {
    return this.plans.get(sessionId)?.cwd
  }

  /** How many sessions are mirrored (diagnostics). */
  get size(): number {
    return this.plans.size
  }

  /**
   * The cwd of the most recently observed session that has one.
   *
   * Cold-start fallback: a harness restart resumes a conversation without
   * replaying its events, so right after a restart nothing is mirrored yet and a
   * session id resolves to nothing. One workspace is the normal case, so
   * answering with the most recent one beats showing an empty panel — as long as
   * the caller labels the answer as a guess, which this plugin does.
   * @returns the most recently observed cwd, or `undefined`.
   */
  latestCwd(): string | undefined {
    let best: BuiltinPlan | undefined
    for (const plan of this.plans.values()) {
      if (!plan.cwd) continue
      if (!best || plan.observedAt > best.observedAt) best = plan
    }
    return best?.cwd
  }

  /**
   * Every mirrored session id, with whether a cwd is known for it.
   *
   * Diagnostics only: a panel request that cannot resolve a workspace has two
   * very different causes — "no event for this session yet" and "events arrive
   * but the header carries no cwd" — and the error text has to say which.
   * @returns one entry per mirrored session.
   */
  describe(): { sessionId: string; hasCwd: boolean }[] {
    return [...this.plans.values()].map((plan) => ({
      sessionId: plan.sessionId,
      hasCwd: Boolean(plan.cwd),
    }))
  }
}
