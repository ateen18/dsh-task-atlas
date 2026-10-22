/**
 * `dsh-task-atlas` — host half.
 *
 * Wiring, in the order it matters:
 *   1. open the storage domain (one zod-validated document per workspace);
 *   2. mirror the harness's own `todo_write` / `goal` state, read-only;
 *   3. register the twelve `atlas_*` tools;
 *   4. serve the panel's snapshot + confirm routes;
 *   5. mirror the plan into the workspace as Markdown on every turn boundary.
 *
 * Everything is an effect owned by this plugin's fiber, so unloading the plugin
 * closes the domain, removes the routes, and unregisters the tools.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import { BACKUP_FILE, renderBackup } from './backup.ts'
import { BuiltinPlanCache } from './builtin-plan.ts'
import { createChangeFeed } from './change-feed.ts'
import { renderWorkspaceMarkdown } from './markdown.ts'
import { installRoutes } from './routes.ts'
import {
  buildInjection,
  INJECTION_PREFIX,
  InjectionTracker,
  stateSignature,
} from './injection.ts'
import {
  buildNudge,
  buildTopicNotice,
  DriftTracker,
  projectTerms,
  TopicWatcher,
  type TopicState,
} from './drift.ts'
import { ATLAS_DOMAIN, domainStoreOf } from './store/domain.ts'
import { emptyDocument, selectProject } from './store/document.ts'
import { workspaceKeyOf } from './store/ids.ts'
import { unavailableStore } from './store/unavailable.ts'
import { DelegatingStore } from './store/delegating.ts'
import type { RouteHost } from './routes.ts'
import { registerTools, type ToolEnv } from './tools/index.ts'
import {
  cwdOfSession,
  summariseSessionRichness,
  summariseWorkspaceHistory,
  withCurrentSession,
  type SessionRecordLike,
  type WorkspaceHistory,
} from './workspace-history.ts'

/** Cordis plugin name (matches the patch row id). */
export const name = 'task-atlas'

/**
 * Host services required before `apply` runs.
 *
 * Only `tools`. Everything else — storage, the web server, the session corpus —
 * is picked up through `ctx.inject` later. That distinction matters: a cordis
 * inject that never resolves is *invisible* (no error, no log, no tools, no route),
 * so naming an optional service here means one missing service silently removes
 * the entire plugin. Declaring only the hard dependency makes the rest degrade
 * loudly instead.
 */
/** Wall-clock instant this process started; used to detect a stale build. */
const processStartAt = Date.now() - process.uptime() * 1000

export const inject = ['tools']

/** Plugin configuration, overridable from the profile's `cordis.patch.yml`. */
export interface Config {
  /** Master switch; `false` registers nothing at all. */
  enabled?: boolean
  /** Write the Markdown mirror into the workspace on every turn boundary. */
  exportMarkdown?: boolean
  /** Directory (relative to the workspace) the mirror is written into. */
  exportDir?: string
  /**
   * Inject a short "where the work is" line before a step, when the state changed.
   *
   * On by default. Turn it off if the extra message in the transcript bothers you —
   * the panel keeps working either way, only the model's automatic anchoring stops.
   */
  inject?: boolean
}

/**
 * Session shape this plugin reads. Narrow on purpose: the harness session object
 * is much larger, and depending only on these two fields keeps the plugin
 * resilient to unrelated session changes.
 */
interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
}

/** The slice of `ctx.sessionQuery` this plugin uses. */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecordLike[]>
  /**
   * Lightweight per-event metadata for one session.
   *
   * Optional: it is only used to weigh the session being opened when the workspace
   * has no other conversations, and a composition without it degrades to "this
   * session does not count as prior work".
   */
  listEvents?(sessionId: string): Promise<readonly { readonly type: string }[]>
}

/** What the session corpus lets the plugin answer. */
interface CorpusProbe {
  /** Authoritative session → workspace lookup. */
  resolveSessionCwd(sessionId: string): Promise<string | undefined>
  /** Kickoff verdict for one workspace. */
  workspaceHistory(
    cwd: string,
    sessionId: string | undefined,
  ): Promise<WorkspaceHistory>
}

/** The agent's session for one tool execution, when there is one. */
function sessionOf(exec: unknown): SessionLike | undefined {
  return (exec as { agent?: { session?: SessionLike } } | undefined)?.agent?.session
}

/** The id of the session a tool call runs for. */
function sessionIdFor(exec: unknown): string | undefined {
  return sessionOf(exec)?.id
}

/**
 * The workspace path of one tool call, without a fallback.
 * @param exec - the running tool execution.
 * @param builtin - mirror used as a fallback for the cwd.
 * @returns the path, or `undefined` when nothing knows it.
 */
function workspacePathFor(exec: unknown, builtin: BuiltinPlanCache): string | undefined {
  const session = sessionOf(exec)
  return session?.header?.cwd ?? (session?.id ? builtin.cwdOf(session.id) : undefined)
}

/**
 * Resolve the workspace of one tool call.
 *
 * Per-execution, not per-registration: one harness process serves several
 * workspaces, and a captured key would show one project's tree in another's turn.
 * @param exec - the running tool execution (carries the agent, and through it the session).
 * @param builtin - mirror used as a fallback for the cwd.
 * @returns the storage key for that workspace.
 */
function workspaceKeyFor(exec: unknown, builtin: BuiltinPlanCache): string {
  return workspaceKeyOf(workspacePathFor(exec, builtin) ?? process.cwd())
}

/**
 * Host-half entry point.
 * @param ctx - harness context.
 * @param config - plugin config from the patch row.
 */
/**
 * Host-half entry point.
 *
 * Deliberately total: any internal failure is logged and swallowed. A throw out of
 * `apply` fails this Loader row, and a failed row is reported as a startup problem
 * — so one bad record, one missing service or one API rename in a harness update
 * would take the whole plugin down with no explanation in the UI. Degrading to
 * "quiet" is strictly better than "startup is broken".
 * @param ctx - harness context.
 * @param config - plugin config from the patch row.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  try {
    await startAtlas(ctx, config)
  } catch (error) {
    const logger = ctx.logger?.('task-atlas')
    logger?.warn?.(`failed to start: ${(error as Error)?.message ?? String(error)}`)
  }
}

/** The slice of an opened storage domain this plugin uses. */
interface OpenedDomain {
  table(name: string): Parameters<typeof domainStoreOf>[0]
  close(): Promise<void>
}

/**
 * The visible text of a batch of messages.
 *
 * Only text blocks count: images and file attachments carry no words to judge, and a
 * message that is only an attachment should not be called off-topic. The plugin's own
 * injected lines arrive as user messages and are dropped by their prefix, otherwise
 * every injection would look like a new off-topic message.
 * @param messages - the messages admitted for this step.
 * @returns the joined text, or an empty string.
 */
function textOfMessages(messages: readonly unknown[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  const parts: string[] = []
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const typed = block as { type?: string; text?: unknown }
      if (typed?.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    }
  }
  return parts
    .filter((text) => !text.trimStart().startsWith(INJECTION_PREFIX))
    .join('\n')
    .trim()
}

/** The parts of the pre-step payload this plugin reads. */
interface PreStepPayload {
  readonly agent?: {
    readonly session?: {
      readonly id?: string
      readonly header?: { readonly cwd?: string }
    }
  }
  /** The user messages this step is about to answer. */
  readonly messages?: readonly unknown[]
}

/** The machine's own decision for one step; only `enter` carries messages. */
interface PreStepDecision {
  readonly kind: 'reject' | 'enter'
  readonly messages?: readonly unknown[]
}

/**
 * Wrap injected text as a user-role message.
 *
 * The role is not a choice: `agent/pre-step` accepts user messages, and the pre-call
 * waterfall explicitly cannot mutate messages. The prefix in the text is what tells a
 * reader it was generated rather than typed.
 * @param text - the state line.
 * @returns a message shaped as the harness expects.
 */
function injectionMessage(text: string): unknown {
  const id = `atlas-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

/** The DSH home directory, derived from the profile the plugin was loaded from. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    const base = (ctx as unknown as { baseUrl?: string }).baseUrl
    if (typeof base === 'string' && base.startsWith('file:')) {
      // <home>/profiles/<name> → <home>
      return path.resolve(fileURLToPath(base), '..', '..')
    }
  } catch {
    /* fall through to the caller's fallback */
  }
  return undefined
}

/**
 * Append one activation failure to a log the user can actually find.
 *
 * Console output from the harness is not inspectable from the desktop app, so an
 * activation failure would otherwise vanish; the whole point of this file is that a
 * later "where did my tree go?" has a written answer.
 */
async function writeStartupLog(
  ctx: Context,
  message: string,
  stack: string | undefined,
): Promise<void> {
  try {
    const home = dshHomeOf(ctx) ?? path.join(homedir(), '.dsh')
    await mkdir(home, { recursive: true })
    await appendFile(
      path.join(home, 'task-atlas-startup.log'),
      `\n[${new Date().toISOString()}] ${message}\n${stack ?? ''}\n`,
      'utf8',
    )
  } catch {
    /* diagnostics must never become the failure */
  }
}

/**
 * The real activation path.
 * @param ctx - harness context.
 * @param config - plugin config from the patch row.
 */
async function startAtlas(ctx: Context, config: Config): Promise<void> {
  const settings = {
    enabled: config.enabled !== false,
    exportMarkdown: config.exportMarkdown !== false,
    exportDir: config.exportDir ?? '.dsh',
    inject: config.inject !== false,
  }
  if (!settings.enabled) {
    ctx.logger?.('task-atlas')?.info?.('disabled by config; nothing registered')
    return
  }

  const logger = ctx.logger?.('task-atlas')
  const builtin = new BuiltinPlanCache()
  const now = () => Date.now()
  /** Decides when the AI-facing state line is worth injecting (see section 6). */
  const injector = new InjectionTracker()
  /** Watches for long stretches of steps that never touch the plan. */
  const drift = new DriftTracker()
  /** Judges whether the conversation has left the project's subject. */
  const topic = new TopicWatcher()

  // ---- 1. durable storage -------------------------------------------------
  //
  // Storage arrives late and optionally. Nothing waits on it: the tools are bound
  // immediately to a delegating store, and the real domain is swapped in when
  // `storageDomain` shows up. A missing or failing backend therefore degrades to a
  // readable error instead of an inactive plugin.
  let failure: string | undefined
  const store = new DelegatingStore(
    () => failure ?? 'storageDomain 服务没有出现（可能是 DSH 版本不匹配）',
  )

  const injectService = (
    ctx as unknown as {
      inject?: (deps: string[], cb: (scoped: Context) => unknown) => unknown
    }
  ).inject

  const openStorage = (scoped: Context): void => {
    void (async () => {
      try {
        const domain = (await scoped.storageDomain.open(ATLAS_DOMAIN)) as unknown as OpenedDomain
        scoped.effect(
          () => () => {
            void domain.close().catch(() => {})
          },
          'task-atlas: storage domain',
        )
        store.bind(domainStoreOf(domain.table('documents')))
        failure = undefined
        logger?.info?.('storage domain opened')
      } catch (error) {
        const cause = error as Error
        failure = `${cause?.name ?? 'Error'}: ${cause?.message ?? String(error)}`
        logger?.warn?.(`storage domain failed to open: ${failure}`)
        await writeStartupLog(ctx, failure, cause?.stack)
      }
    })()
  }

  if (typeof injectService === 'function') {
    ctx.inject(['storageDomain'], openStorage)
  } else {
    openStorage(ctx)
  }

  // ---- 2. read-only mirror of the harness's own plan ----------------------
  const exportTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const exportMarkdownFor = async (cwd: string, sessionId: string): Promise<void> => {
    if (!settings.exportMarkdown) return
    try {
      const workspaceKey = workspaceKeyOf(cwd)
      const document = (await store.read(workspaceKey)) ?? emptyDocument(workspaceKey)
      const markdown = renderWorkspaceMarkdown(document, builtin.get(sessionId), now())
      const directory = path.join(cwd, settings.exportDir)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'task-atlas.md'), markdown, 'utf8')
      // A second, lossless copy next to the readable one. The Markdown is for humans and
      // cannot be parsed back exactly; this one can, and `atlas_restore` reads it.
      await writeFile(path.join(directory, BACKUP_FILE), renderBackup(document, now()), 'utf8')
    } catch (error) {
      logger?.warn?.(`markdown mirror failed: ${(error as Error).message}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    const subject = session as unknown as SessionLike
    builtin.observe(subject, event, now())

    // A completed compaction means the model has just lost the conversation while the
    // tree survived. Forgetting the signature here is what makes the next step
    // re-anchor instead of trusting a "nothing changed" comparison.
    //
    // Compared through a string cast on purpose: this build's typed event union does
    // not contain the compaction brackets even though the session log does, so the
    // narrow comparison is invisible to the compiler. If the events never arrive, this
    // simply never fires — the injection still works, it just will not re-anchor.
    if (String(event.type) === 'compaction/end') injector.noteCompaction(subject.id)

    // Any atlas__* call means the plan is being maintained, which resets the drift
    // counter. Reading the name from the event payload keeps this honest: it counts
    // what actually happened in the session, not what a tool claims afterwards.
    if (String(event.type) === 'tool/call') {
      const payload = event as unknown as { name?: unknown; data?: { name?: unknown } }
      const name = typeof payload.name === 'string' ? payload.name : payload.data?.name
      if (typeof name === 'string' && name.startsWith('atlas_')) drift.noteActivity(subject.id)
    }

    // Topic drift is NOT judged here. It is judged in the pre-step handler on the
    // messages that step is about to answer, because an asynchronous observation could
    // land after that step's decision — the model then answered first and was asked
    // about it a turn too late. Counting it in both places would also double the streak.

    // One debounce per workspace: a turn can emit many events, and the file only
    // needs to be current, not written on every one of them.
    if (event.type !== 'turn/end') return
    const cwd = subject.header?.cwd
    if (!cwd) return
    const existing = exportTimers.get(cwd)
    if (existing) clearTimeout(existing)
    exportTimers.set(
      cwd,
      setTimeout(() => {
        exportTimers.delete(cwd)
        void exportMarkdownFor(cwd, subject.id)
      }, 250),
    )
  })

  // ---- 3. session corpus: workspace history + authoritative cwd -----------
  //
  // `sessionQuery` is wired optionally rather than declared in `inject`: it is a
  // genuine enhancement (kickoff can tell a blank workspace from one with prior
  // work, and a cold start can resolve the panel's workspace) but the plugin must
  // still activate on a composition that does not provide it.
  let corpus: CorpusProbe | undefined

  const wireCorpus = (engine: SessionQueryLike | undefined): void => {
    if (!engine || typeof engine.listSessions !== 'function') return

    // One short-lived cache: kickoff and the panel poll within seconds of each
    // other, and listing the whole corpus per request is wasteful.
    let cached: { at: number; records: readonly SessionRecordLike[] } | undefined
    let inFlight: Promise<readonly SessionRecordLike[]> | undefined

    const records = async (): Promise<readonly SessionRecordLike[]> => {
      const at = now()
      if (cached && at - cached.at < 5000) return cached.records
      if (inFlight) return inFlight
      inFlight = engine
        .listSessions()
        .then((list) => {
          cached = { at: now(), records: list }
          return list
        })
        .catch((error: unknown) => {
          logger?.warn?.(`session corpus unavailable: ${(error as Error).message}`)
          return cached?.records ?? []
        })
        .finally(() => {
          inFlight = undefined
        })
      return inFlight
    }

    corpus = {
      resolveSessionCwd: async (sessionId) => cwdOfSession(await records(), sessionId),
      workspaceHistory: async (cwd, sessionId) => {
        const base = summariseWorkspaceHistory(await records(), {
          workspacePath: cwd,
          ...(sessionId ? { currentSessionId: sessionId } : {}),
        })
        // Other conversations already decided it; the current thread adds nothing.
        if (base.hasHistory || !sessionId || typeof engine.listEvents !== 'function') {
          return base
        }
        // One long, dense thread is as much prior work as several short ones —
        // which is exactly what a plugin installed mid-project meets.
        try {
          const events = await engine.listEvents(sessionId)
          return withCurrentSession(base, summariseSessionRichness(events))
        } catch {
          return base
        }
      },
    }
    logger?.info?.('session corpus wired: workspace history + authoritative cwd available')
  }

  // `ctx.inject` waits for a service; guard it so an older composition without
  // that API degrades to "no corpus" instead of failing the whole plugin.
  const injectFn = (ctx as unknown as { inject?: (deps: string[], cb: (scoped: Context) => void) => unknown })
    .inject
  if (typeof injectFn === 'function') {
    ctx.inject(['sessionQuery'], (scoped) => {
      wireCorpus((scoped as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery)
    })
  } else {
    wireCorpus((ctx as unknown as { sessionQuery?: SessionQueryLike }).sessionQuery)
  }

  // ---- 4. tools ----------------------------------------------------------
  // One broadcast for "the document changed", fed by the single write path and read
  // by the panel's event stream. This is what let the 2.5 s poll go away.
  const changes = createChangeFeed()
  /**
   * When this build was produced, versus when the process running it started.
   *
   * A stale build is indistinguishable from a broken feature: a renamed field, a shortened
   * service list and an unknown tool parameter have each been dropped in silence because the
   * app was still executing the previous build. The plugin knows both numbers, so the panel
   * can stop asking the user to guess.
   */
  const buildInfo = (): { at: number; startedAt: number } | undefined => {
    try {
      const at = statSync(fileURLToPath(import.meta.url)).mtimeMs
      return { at, startedAt: processStartAt }
    } catch {
      return undefined
    }
  }
  const env: ToolEnv = {
    now,
    workspaceKey: (exec) => workspaceKeyFor(exec, builtin),
    workspacePath: (exec) => workspacePathFor(exec, builtin),
    exportDir: settings.exportDir,
    workspaceHistory: async (exec) => {
      if (!corpus) return undefined
      const cwd = workspacePathFor(exec, builtin)
      if (!cwd) return undefined
      const sessionId = sessionIdFor(exec)
      return corpus.workspaceHistory(cwd, sessionId)
    },
    onWrite: () => changes.notify(),
    rand: Math.random,
  }
  ctx.effect(() => registerTools(ctx, store, env), 'task-atlas: tools')

  // ---- 5. panel routes ---------------------------------------------------
  const installPanelRoutes = (scoped: Context): (() => void) =>
    installRoutes(scoped.webServer as unknown as RouteHost, {
      store,
      builtin,
      resolveSessionCwd: async (sessionId) => corpus?.resolveSessionCwd(sessionId),
      workspaceHistory: async (cwd, sessionId) => corpus?.workspaceHistory(cwd, sessionId),
      startupFailure: () => failure,
      subscribe: (listener) => changes.subscribe(listener),
      revision: () => changes.revision,
      buildInfo: () => buildInfo(),
      stepsSinceAtlas: (sessionId) => drift.stepsOf(sessionId),
      topicOf: (sessionId) => topic.stateOf(sessionId),
      now,
    })

  if (typeof injectService === 'function') {
    ctx.inject(['webServer'], installPanelRoutes)
  } else {
    ctx.effect(() => installPanelRoutes(ctx), 'task-atlas: panel routes')
  }

  // ---- 6. AI-facing state line -------------------------------------------
  //
  // Appended to the step's admitted messages when — and only when — the state the
  // line describes has actually changed. Every failure path returns the machine's own
  // decision untouched: a bug in here must degrade to "no injection", never to a
  // broken turn, so the whole handler is wrapped and the decision is captured first.
  if (settings.inject) {
    const onHook = (
      ctx as unknown as {
        on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown
      }
    ).on
    if (typeof onHook === 'function') {
      onHook.call(
        ctx,
        'agent/pre-step',
        async (payload: unknown, next: unknown) => {
          const advance = next as () => Promise<PreStepDecision>
          const decision = await advance()
          try {
            if (decision.kind !== 'enter') return decision
            const session = (payload as PreStepPayload | undefined)?.agent?.session
            const cwd = session?.header?.cwd
            const sessionId = session?.id ?? 'unknown'
            if (!cwd) return decision

            const key = workspaceKeyOf(cwd)
            const document = await store.read(key)
            const project = document ? selectProject(document) : undefined
            if (!project) return decision

            // Topic drift is judged HERE, on the messages this very step is about to
            // answer. Judging it from the session event instead raced with this step:
            // the observation could land after the decision, so the model answered
            // first and was asked about it a turn later.
            const incoming = textOfMessages((payload as PreStepPayload | undefined)?.messages)
            if (incoming) topic.observe(sessionId, incoming, projectTerms(project))

            // Counted every step, before the signature gate: a nudge is due on its own
            // schedule, and a long silent stretch is exactly when the signature will
            // not have changed.
            const nudgeDue = drift.noteStep(sessionId)
            // Once per streak, and before the gate: being asked "is this off topic?"
            // must not wait for the tree to change.
            const topicNotice = topic.takeModelNotice(sessionId)
            const changed = injector.shouldInject(sessionId, stateSignature(project))
            if (!changed && !nudgeDue && !topicNotice) return decision

            const text = buildInjection(project, {
              afterCompaction: injector.takeCompactionNotice(sessionId),
              ...(nudgeDue ? { nudge: buildNudge(drift.stepsOf(sessionId)) } : {}),
              ...(topicNotice ? { notice: buildTopicNotice() } : {}),
            })
            if (!text) return decision

            return {
              ...decision,
              messages: [...(decision.messages ?? []), injectionMessage(text)],
            }
          } catch (error) {
            logger?.warn?.(`state injection skipped: ${(error as Error).message}`)
            return decision
          }
        },
      )
    }
  }

  logger?.info?.(
    `loaded: storage=domain, routes=${'`/task-atlas`'}, markdown=${settings.exportMarkdown ? `${settings.exportDir}/task-atlas.md` : 'off'}`,
  )
}
