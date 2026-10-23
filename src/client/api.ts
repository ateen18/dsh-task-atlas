/**
 * Panel data access.
 *
 * Refresh is driven by the host, not by a timer. Every write goes through one helper
 * in the tool layer, which publishes on a change feed; the panel holds one
 * Server-Sent-Events connection and refetches only when that feed ticks.
 *
 * The previous 2.5 s poll cost no model tokens — it was a local HTTP request — but it
 * was still waste: almost every response was identical to the last, and a real change
 * still arrived late. Polling now exists only as a fallback for when the stream
 * cannot be established, and at 30 s it is a safety net rather than a heartbeat.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LAYOUT_VERSION } from './canvas-layout.ts'
import type { AtlasDocument } from '../model/types.ts'
import type { BuiltinPlan } from '../builtin-plan.ts'
import type { WorkspaceHistory } from '../workspace-history.ts'

/** One snapshot from the host. */
export interface AtlasState {
  readonly workspaceKey: string
  readonly cwd: string
  /**
   * How the host decided which workspace this is.
   *
   * `latest` means the answer is inferred from another session because this one
   * has not produced an event since the harness started — the panel says so
   * rather than pretending to be certain.
   */
  readonly resolvedVia: 'cwd' | 'session' | 'latest'
  readonly receivedSessionId: string | null
  /**
   * Kickoff verdict: `null` when the host could not inspect the session corpus.
   *
   * `hasHistory` is what decides whether kickoff interviews the user or
   * reconstructs the blueprint from conversations that already happened.
   */
  readonly history: WorkspaceHistory | null
  readonly document: AtlasDocument
  readonly builtin: BuiltinPlan | null
  /** Monotonic change revision, echoed back to the long poll. */
  readonly revision: number
  /**
   * Drift signals, reported even when they are quiet.
   *
   * The counter is rendered in the panel: a detector the user cannot see is
   * indistinguishable from one that is not running.
   */
  readonly drift: {
    /** Steps since the plan was last touched. */
    readonly steps: number
    /** Topic verdict for the current streak, if any. */
    readonly topic: {
      readonly streak: number
      readonly flagged: boolean
      readonly sample?: string
    } | null
  }
  readonly now: number
  /**
   * Build time versus process start time.
   *
   * When `at` is later than `startedAt` the running code is older than the code on disk, and
   * whatever was just changed is not actually in effect. The panel says so, because a stale
   * build otherwise looks exactly like a broken feature.
   */
  readonly build: { readonly at: number; readonly startedAt: number } | null
}

/** A failure the panel can render verbatim. */
export interface AtlasError {
  readonly code: string
  readonly summary: string
}

const CWD_KEY = 'dsh-task-atlas:cwd'

/** The workspace this panel resolved last time, used to survive a cold start. */
function rememberedCwd(): string | undefined {
  try {
    return localStorage.getItem(CWD_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function rememberCwd(cwd: string): void {
  try {
    localStorage.setItem(CWD_KEY, cwd)
  } catch {
    /* private mode: the cold-start hint just will not persist */
  }
}

function stateUrl(sessionId: string | undefined): string {
  const url = new URL('task-atlas/state', document.baseURI)
  if (sessionId) url.searchParams.set('sessionId', sessionId)
  // A harness restart resumes the conversation without replaying its events, so
  // the host has observed nothing for this session yet. Sending the workspace we
  // resolved last time turns a dead panel into a correct one; the host still
  // prefers the session's own header when it has one.
  const cwd = rememberedCwd()
  if (cwd) url.searchParams.set('cwd', cwd)
  return url.toString()
}

function confirmUrl(): string {
  return new URL('task-atlas/confirm', document.baseURI).toString()
}

/** Where canvas positions are written. */
function layoutUrl(): string {
  return new URL('task-atlas/layout', document.baseURI).toString()
}

/** The long-poll endpoint: answers when the document changes, or at a ceiling. */
function waitUrl(revision: number, sessionId: string | undefined): string {
  const url = new URL('task-atlas/wait', document.baseURI)
  url.searchParams.set('revision', String(revision))
  if (sessionId) url.searchParams.set('sessionId', sessionId)
  return url.toString()
}

/** What `useAtlasState` hands the views. */
export interface AtlasFeed {
  readonly state: AtlasState | null
  readonly error: AtlasError | null
  readonly loading: boolean
  /** Force a refresh now (used after a successful mutation). */
  readonly reload: () => void
  /** Apply one queued confirmation. */
  readonly confirm: (confirmationId: string) => Promise<void>
  /** Persist canvas positions (debounced by the caller). */
  readonly saveLayout: (positions: Record<string, { x: number; y: number }>) => Promise<void>
  /** The confirmation id currently in flight, for per-row spinners. */
  readonly busy: string | null
}

/**
 * Keep one session's snapshot current.
 *
 * Refetches when the host says the document changed, when the panel becomes visible
 * again, and when the user asks. Only if the change stream cannot be established does
 * a slow timer take over, so a broken stream degrades to "slightly stale" rather than
 * "silently frozen".
 * @param sessionId - the session whose workspace should be shown.
 * @returns the feed.
 */
export function useAtlasState(sessionId: string | undefined): AtlasFeed {
  const [state, setState] = useState<AtlasState | null>(null)
  const [error, setError] = useState<AtlasError | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const mounted = useRef(true)
  /** Latest request wins; an older in-flight response is discarded, not rendered. */
  const requestSeq = useRef(0)
  /** Revision of the snapshot currently rendered, used as the long-poll cursor. */
  const revisionRef = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const seq = (requestSeq.current += 1)
    try {
      const response = await fetch(stateUrl(sessionId), {
        headers: { accept: 'application/json' },
      })
      const body = (await response.json()) as
        | {
            ok: true
            workspaceKey: string
            cwd: string
            resolvedVia: 'cwd' | 'session' | 'latest'
            receivedSessionId: string | null
            history: WorkspaceHistory | null
            document: AtlasDocument
            builtin: BuiltinPlan | null
            revision: number
            drift?: {
              steps?: number
              topic?: { streak?: number; flagged?: boolean; sample?: string } | null
            }
            now: number
            build?: { at: number; startedAt: number } | null
          }
        | { ok: false; code: string; summary: string }
      if (seq !== requestSeq.current || !mounted.current) return
      if (body.ok) {
        if (body.resolvedVia !== 'latest') rememberCwd(body.cwd)
        revisionRef.current = body.revision ?? revisionRef.current
        setState({
          workspaceKey: body.workspaceKey,
          cwd: body.cwd,
          resolvedVia: body.resolvedVia,
          receivedSessionId: body.receivedSessionId,
          history: body.history,
          document: body.document,
          builtin: body.builtin,
          revision: body.revision ?? 0,
          drift: {
            steps: body.drift?.steps ?? 0,
            topic: body.drift?.topic
              ? {
                  streak: body.drift.topic.streak ?? 0,
                  flagged: body.drift.topic.flagged === true,
                  ...(body.drift.topic.sample === undefined
                    ? {}
                    : { sample: body.drift.topic.sample }),
                }
              : null,
          },
          now: body.now,
          build: body.build ?? null,
        })
        setError(null)
      } else {
        setError({ code: body.code, summary: body.summary })
      }
    } catch (cause) {
      if (seq !== requestSeq.current || !mounted.current) return
      const name = (cause as { name?: string }).name
      if (name === 'AbortError') return
      setError({ code: 'NETWORK', summary: (cause as Error).message })
    } finally {
      if (seq === requestSeq.current && mounted.current) setLoading(false)
    }
  }, [sessionId])

  // Initial load, and every explicit refresh (manual, or after a confirm).
  useEffect(() => {
    void load()
  }, [load, tick])

  // Host-driven refresh: one long poll at a time.
  //
  // The request stays open on the host until the document actually changes (or the
  // host's ceiling expires), so a quiet panel costs one request per ceiling instead
  // of twelve per half-minute — and a change arrives immediately rather than at the
  // next tick. This replaces both the old 2.5 s poll and the SSE attempt, which could
  // not survive the harness's web server.
  useEffect(() => {
    let cancelled = false

    const loop = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const response = await fetch(waitUrl(revisionRef.current, sessionId))
          const body = (await response.json()) as { ok?: boolean; revision?: number }
          if (cancelled) return
          if (
            body?.ok === true &&
            typeof body.revision === 'number' &&
            body.revision !== revisionRef.current
          ) {
            // Adopt the new revision immediately: the next wait must not re-report
            // a change we already know about, or the loop spins.
            revisionRef.current = body.revision
            setTick((value) => value + 1)
          }
        } catch {
          // A failed long poll must not become a hot loop.
          await new Promise((resolve) => setTimeout(resolve, 4000))
        }
        // Keeps the loop from spinning if the host answers instantly for any reason.
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
    void loop()

    // Coming back to a backgrounded panel should not show yesterday's tree.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [sessionId])

  const reload = useCallback(() => setTick((value) => value + 1), [])

  const confirm = useCallback(
    async (confirmationId: string): Promise<void> => {
      setBusy(confirmationId)
      try {
        const response = await fetch(confirmUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, confirmationId }),
        })
        const body = (await response.json()) as
          | { ok: true; summary: string }
          | { ok: false; code: string; summary: string }
        if (!body.ok) setError({ code: body.code, summary: body.summary })
        else setError(null)
        setTick((value) => value + 1)
      } catch (cause) {
        setError({ code: 'NETWORK', summary: (cause as Error).message })
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [sessionId],
  )

  /**
   * Persist canvas positions.
   *
   * Deliberately silent on failure: losing a card position is not worth an error banner over
   * the graph, and the next drag retries anyway.
   */
  const saveLayout = useCallback(
    async (positions: Record<string, { x: number; y: number }>): Promise<void> => {
      try {
        await fetch(layoutUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, positions, version: LAYOUT_VERSION }),
        })
      } catch {
        /* the canvas keeps working from local state */
      }
    },
    [sessionId],
  )

  return { state, error, loading, reload, confirm, saveLayout, busy }
}
