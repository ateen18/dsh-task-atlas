/**
 * The panel's data plane.
 *
 * The right-sidebar tab is a browser component with no access to the host's
 * storage, and `domain/changed` is a single-process event that a connected GUI
 * never sees. So the panel pulls a snapshot over HTTP and polls it. That is the
 * same shape the task-board plugin uses, and it keeps the panel stateless: it
 * renders whatever the last response said.
 *
 * Routes are registered on the loopback-bound web server. They are read-mostly:
 * the single mutation is applying a queued confirmation, which is exactly the
 * action a click in the panel represents.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BuiltinPlanCache } from './builtin-plan.ts'
import { applyConfirmation } from './confirm.ts'
import { emptyDocument, type AtlasStore } from './store/document.ts'
import { workspaceKeyOf } from './store/ids.ts'
import type { WorkspaceHistory } from './workspace-history.ts'

/** Prefix every route of this plugin lives under. */
export const ROUTE_PREFIX = '/task-atlas'

/** The slice of `ctx.webServer` this module uses. */
export interface RouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** What the routes need from the plugin. */
export interface RouteDeps {
  readonly store: AtlasStore
  readonly builtin: BuiltinPlanCache
  /**
   * Subscribe to "the document changed" broadcasts.
   *
   * This is what replaces polling: every write goes through one helper in the tool
   * layer, so the panel can be told exactly when to refetch instead of asking every
   * few seconds forever.
   * @param listener - called with the new revision.
   * @returns the unsubscribe function.
   */
  readonly subscribe?: (listener: (revision: number) => void) => () => void
  /** Current change revision, sent to a client when its stream opens. */
  readonly revision?: () => number
  /**
   * Build time versus process start time.
   *
   * Reported so the panel can warn that the running code is older than the code on disk. A
   * stale build looks exactly like a broken feature — a rename, a service list and a tool
   * parameter have each been silently ignored this way — and the plugin already knows both
   * numbers, so it should say so.
   */
  readonly buildInfo?: () => { readonly at: number; readonly startedAt: number } | undefined
  /**
   * How long one long-poll may wait before answering "nothing changed".
   *
   * Exposed mainly so tests do not have to wait 25 seconds to exercise the timeout
   * path; the production value keeps a quiet panel from holding a socket too long.
   */
  readonly waitTimeoutMs?: number
  /**
   * Authoritative session → workspace lookup.
   *
   * This is what makes a cold start work: the harness session corpus knows every
   * session's `cwd` even when the live event stream has replayed nothing.
   * @param sessionId - session to resolve.
   */
  readonly resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>
  /**
   * Kickoff verdict for a workspace: does it have prior conversations?
   * @param cwd - the workspace path.
   * @param sessionId - the session asking, excluded from the count.
   */
  readonly workspaceHistory?: (
    cwd: string,
    sessionId: string | undefined,
  ) => Promise<WorkspaceHistory | undefined>
  /**
   * Why activation failed, when it did.
   *
   * The panel is the only surface the user actually looks at, so a startup failure
   * has to be able to appear there. Without this the failure is a log line nobody
   * reads and an empty panel that looks like data loss.
   */
  readonly startupFailure?: () => string | undefined
  /**
   * Steps since the plan was last touched.
   *
   * Surfaced so the user can watch the drift counter move: a detector the user cannot
   * see is indistinguishable from one that does not work.
   * @param sessionId - session to inspect.
   */
  readonly stepsSinceAtlas?: (sessionId: string) => number
  /**
   * Whether the conversation has left the project's subject.
   * @param sessionId - session to inspect.
   */
  readonly topicOf?: (
    sessionId: string,
  ) => { readonly streak: number; readonly flagged: boolean; readonly sample?: string } | undefined
  /** Epoch milliseconds. */
  now(): number
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/'
  const index = url.indexOf('?')
  return new URLSearchParams(index === -1 ? '' : url.slice(index + 1))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * How a workspace was resolved, so the panel can be honest about it.
 *
 * `session` is the authoritative case; `latest` means the answer is a guess from
 * another session in the same harness (see `BuiltinPlanCache.latestCwd`).
 */
export interface WorkspaceResolution {
  readonly workspaceKey: string
  readonly cwd: string
  readonly via: 'cwd' | 'session' | 'latest'
}

/**
 * Resolve the workspace a request is about.
 *
 * Order of authority matters. The session's own header wins, because a session
 * belongs to exactly one workspace and nothing the browser can send outranks
 * that. When the live mirror has not seen the session yet (a restart resumes a
 * conversation without replaying events), the harness session corpus is asked —
 * it knows every session's `cwd` durably. A caller-supplied `cwd` comes next: it
 * is how the panel survives even that lookup. The most recently observed
 * workspace is the last resort, and the caller is told the answer is a guess.
 * @param sessionId - session the request names.
 * @param explicitCwd - caller-supplied workspace path.
 * @param deps - mirror, corpus lookup, and clock.
 * @returns the resolution, or `undefined` when nothing can be inferred.
 */
async function resolveWorkspace(
  sessionId: string | undefined,
  explicitCwd: string | undefined,
  deps: RouteDeps,
): Promise<WorkspaceResolution | undefined> {
  const own = sessionId ? deps.builtin.cwdOf(sessionId) : undefined
  if (own) {
    return { workspaceKey: workspaceKeyOf(own), cwd: own, via: 'session' }
  }

  if (sessionId && deps.resolveSessionCwd) {
    try {
      const fromCorpus = await deps.resolveSessionCwd(sessionId)
      if (fromCorpus) {
        return { workspaceKey: workspaceKeyOf(fromCorpus), cwd: fromCorpus, via: 'session' }
      }
    } catch {
      // The corpus is a best-effort authority here; fall through to the rest.
    }
  }

  if (explicitCwd) {
    return { workspaceKey: workspaceKeyOf(explicitCwd), cwd: explicitCwd, via: 'cwd' }
  }
  const latest = deps.builtin.latestCwd()
  if (latest) {
    return { workspaceKey: workspaceKeyOf(latest), cwd: latest, via: 'latest' }
  }
  return undefined
}

/**
 * Register the panel routes.
 * @param host - the web server service.
 * @param deps - store, built-in mirror, and clock.
 * @returns a disposer removing every route.
 */
export function installRoutes(host: RouteHost, deps: RouteDeps): () => void {
  const disposers: (() => void)[] = []

  disposers.push(
    host.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const url = req.url ?? ''
        try {
          // ---- change notification: long poll ------------------------------
          //
          // Deliberately NOT server-sent events. The SSE logic here was correct —
          // a test against a real Node server opens the stream, holds it and pushes
          // frames — but the harness's own web server ends a streamed response, so in
          // the app every "push" arrived as an immediate close. A long poll is a plain
          // request that resolves the moment something changes (or at a ceiling),
          // which no request/response layer can break.
          if (req.method === 'GET' && url.startsWith(`${ROUTE_PREFIX}/wait`)) {
            const query = queryOf(req)
            const since = Number(asString(query.get('revision')) ?? '0') || 0
            // Ten seconds, not a minute: a change still arrives immediately, while an
            // idle panel costs six requests a minute instead of the twenty-four the
            // old 2.5 s poll made. Kept well under any plausible request timeout in
            // the harness's web layer, so the poll completes normally rather than
            // being cut off mid-wait.
            const timeoutMs = deps.waitTimeoutMs ?? 10_000
            const current = deps.revision?.() ?? 0
            if (current !== since || !deps.subscribe) {
              sendJson(res, 200, { ok: true, revision: current })
              return
            }
            const revision = await new Promise<number>((resolve) => {
              let done = false
              const finish = (value: number): void => {
                if (done) return
                done = true
                clearTimeout(timer)
                unsubscribe()
                resolve(value)
              }
              const unsubscribe = deps.subscribe?.(finish) ?? (() => {})
              // The ceiling keeps a quiet panel from holding a socket forever.
              const timer = setTimeout(() => finish(deps.revision?.() ?? current), timeoutMs)
              if (typeof timer.unref === 'function') timer.unref()
            })
            sendJson(res, 200, { ok: true, revision })
            return
          }

          if (req.method === 'GET' && url.startsWith(`${ROUTE_PREFIX}/state`)) {
            // A failed activation has to be the first thing reported, otherwise an
            // empty panel is indistinguishable from lost data.
            const failure = deps.startupFailure?.()
            if (failure) {
              sendJson(res, 200, {
                ok: false,
                code: 'STARTUP_FAILED',
                summary:
                  `插件启动失败，所以读不到任务树（数据本身没丢）：${failure}` +
                  '。详见 ~/.dsh/task-atlas-startup.log。',
              })
              return
            }
            const query = queryOf(req)
            const sessionId = asString(query.get('sessionId')) ?? undefined
            const explicitCwd = asString(query.get('cwd')) ?? undefined
            const resolution = await resolveWorkspace(sessionId, explicitCwd, deps)
            if (!resolution) {
              // This failure has two very different causes and the panel must be
              // able to say which, otherwise everyone (the user and the next
              // debugging agent) is guessing.
              const mirrored = deps.builtin.describe()
              const detail = [
                `sessionId=${sessionId ?? '(未收到)'}`,
                explicitCwd ? `cwd=${explicitCwd}` : 'cwd=(未收到)',
                mirrored.length === 0
                  ? '已观测会话：0 个（这个会话还没有产生任何事件）'
                  : `已观测会话 ${mirrored.length} 个：` +
                    mirrored
                      .slice(0, 6)
                      .map((entry) => `${entry.sessionId}${entry.hasCwd ? '' : '(无 cwd)'}`)
                      .join(', '),
              ].join('；')
              sendJson(res, 200, {
                ok: false,
                code: 'NO_WORKSPACE',
                summary: `无法确定这个会话的工作区。${detail}`,
              })
              return
            }
            const workspaceKey = resolution.workspaceKey
            const document = (await deps.store.read(workspaceKey)) ?? emptyDocument(workspaceKey)

            // Kickoff needs to know whether this workspace is a blank page or has
            // prior conversations to reconstruct from. Failure here is never fatal:
            // an unknown verdict makes the panel offer both paths.
            let history: WorkspaceHistory | undefined
            if (deps.workspaceHistory) {
              try {
                history = await deps.workspaceHistory(resolution.cwd, sessionId)
              } catch {
                history = undefined
              }
            }

            sendJson(res, 200, {
              ok: true,
              workspaceKey,
              cwd: resolution.cwd,
              resolvedVia: resolution.via,
              receivedSessionId: sessionId ?? null,
              now: deps.now(),
              // The panel echoes this back to /wait, so it can say "nothing has
              // changed since the snapshot I already have".
              revision: deps.revision?.() ?? 0,
              // Whether the code on disk is newer than the process running it.
              //
              // Three separate incidents came from this: a field rename, a service list, and
              // a tool parameter were each silently ignored because the app was still running
              // the previous build. The plugin already knows both numbers, so it should say so
              // instead of leaving the user to conclude the feature is broken.
              build: deps.buildInfo?.() ?? null,
              // Drift is reported even when it is zero: the panel renders the counter,
              // so "the detector is watching" is something the user can see.
              drift: {
                steps: sessionId ? (deps.stepsSinceAtlas?.(sessionId) ?? 0) : 0,
                topic: (sessionId ? deps.topicOf?.(sessionId) : undefined) ?? null,
              },
              document,
              history: history ?? null,
              builtin: sessionId ? (deps.builtin.get(sessionId) ?? null) : null,
            })
            return
          }

          if (req.method === 'POST' && url.startsWith(`${ROUTE_PREFIX}/confirm`)) {
            const body = await readJsonBody(req)
            const record = (typeof body === 'object' && body !== null ? body : {}) as Record<
              string,
              unknown
            >
            const confirmationId = asString(record.confirmationId)
            const sessionId = asString(record.sessionId)
            const explicitCwd = asString(record.cwd)
            const workspaceKey = (await resolveWorkspace(sessionId, explicitCwd, deps))?.workspaceKey
            if (!workspaceKey) {
              sendJson(res, 400, {
                ok: false,
                code: 'NO_WORKSPACE',
                summary: '无法确定工作区。',
              })
              return
            }
            if (!confirmationId) {
              sendJson(res, 400, {
                ok: false,
                code: 'MISSING_ARGUMENT',
                summary: '缺少 confirmationId。',
              })
              return
            }
            const outcome = await applyConfirmation(
              deps.store,
              workspaceKey,
              confirmationId,
              deps.now(),
            )
            sendJson(res, outcome.ok ? 200 : 409, outcome)
            return
          }

          sendJson(res, 404, {
            ok: false,
            code: 'NOT_FOUND',
            summary: `没有这个路由：${req.method} ${url}`,
          })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            code: 'INTERNAL',
            summary: (error as Error).message,
          })
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
