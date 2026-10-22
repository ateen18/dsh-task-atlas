/**
 * Drift nudging.
 *
 * The temptation is to judge whether a tool call is "relevant" to the focused node.
 * That is a semantic guess, it misfires constantly, and a nudge that misfires is
 * worse than no nudge: the model learns to ignore it.
 *
 * So this counts something it can actually know: how many steps have passed since the
 * last `atlas_*` call. Twenty steps without touching the tree is a real signal that
 * work has moved somewhere the plan does not describe — and the fix is cheap either
 * way (record a branch, or update the status).
 *
 * A nudge fires at most once per streak, and any atlas call resets it, so the cost is
 * one short line in an unusual situation.
 */

import { collectNodes } from './model/tree.ts'
import type { AtlasProject } from './model/types.ts'

/** Steps without any atlas call before a single nudge is offered. */
export const DRIFT_STEP_THRESHOLD = 20

/** Tracks per-session step counts since the plan was last touched. */
export class DriftTracker {
  private readonly stepsSinceActivity = new Map<string, number>()
  private readonly nudged = new Set<string>()

  /**
   * An `atlas_*` tool ran, so the plan is being maintained.
   * @param sessionId - the session the call belongs to.
   */
  noteActivity(sessionId: string): void {
    this.stepsSinceActivity.set(sessionId, 0)
    this.nudged.delete(sessionId)
  }

  /**
   * Record one step and say whether a nudge is due.
   * @param sessionId - the session the step belongs to.
   * @param threshold - steps of silence required first.
   * @returns true at most once per silent streak.
   */
  noteStep(sessionId: string, threshold = DRIFT_STEP_THRESHOLD): boolean {
    const next = (this.stepsSinceActivity.get(sessionId) ?? 0) + 1
    this.stepsSinceActivity.set(sessionId, next)
    if (next < threshold || this.nudged.has(sessionId)) return false
    this.nudged.add(sessionId)
    return true
  }

  /**
   * How many steps since the plan was last touched.
   * @param sessionId - the session to inspect.
   * @returns the count, 0 when it was just touched.
   */
  stepsOf(sessionId: string): number {
    return this.stepsSinceActivity.get(sessionId) ?? 0
  }
}

/**
 * The one line appended when a nudge is due.
 *
 * Written so that "I am on plan" is a valid answer: the model is told it may ignore
 * this, which is what keeps it from inventing work to satisfy the nudge.
 * @param steps - steps since the last atlas call.
 * @returns the nudge line.
 */
export function buildNudge(steps: number): string {
  return (
    `[任务图谱] 已经 ${steps} 步没有动过图谱了。如果还在当前节点上，忽略这条；` +
    '如果这段时间做的是计划外的事，用 atlas_branch_create 登记成分支，或把当前节点状态更新到实际进度。'
  )
}

// ---------------------------------------------------------------------------
// Topic drift
//
// Step counting answers "how long since the plan was touched". It cannot answer
// "did the conversation leave the subject", and those are different failures: a user
// can go completely off-topic on the first question of a turn, long before any step
// threshold is reached.
//
// So topic drift is judged separately, from the user's own words, with a blunt but
// explainable rule: take 2–4 character fragments of the project's own vocabulary and
// see whether any of them appear in the message. No model call, no embeddings, and
// every input to the verdict can be shown to the user.
//
// Two asymmetries drive the design:
//  - a prompt *to the user* may be wrong, because a wrong question costs one "no";
//  - a prompt *to the model* must not be wrong, because a wrong command teaches it to
//    ignore the next one.
// Hence two different thresholds and two different sentences.
// ---------------------------------------------------------------------------

/** Words that would match almost any sentence; excluded from the vocabulary. */
const STOP_TERMS = new Set([
  '任务', '项目', '这个', '那个', '现在', '需要', '可以', '一个', '我们', '你们',
  '什么', '怎么', '为什么', '已经', '还是', '就是', '不是', '没有', '继续',
  '图谱', '工作', '问题', '方式', '时候', '东西', '情况', '内容', '部分',
])

/** Shortest message that can count as a real question or request. */
const MIN_MESSAGE = 8

/**
 * Characters that begin grammatical glue rather than a term.
 *
 * A fragment starting with one of these carries no subject on its own, so it can only
 * produce accidental matches. See the note where this is applied.
 */
const FUNCTION_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '而', '但', '就', '不', '也', '都',
  '会', '要', '能', '个', '把', '被', '为', '很', '太', '更', '最', '从', '到',
  '对', '给', '让', '使', '这', '那', '我', '你', '他', '它', '们', '有', '没',
])

/** Fragments of this length are extracted from the project's vocabulary. */
const MIN_NGRAM = 2
const MAX_NGRAM = 4

/**
 * The project's own vocabulary, as short fragments.
 * @param project - the active project.
 * @returns fragments that are specific enough to mean something when they match.
 */
export function projectTerms(project: AtlasProject): string[] {
  const pieces: string[] = []
  const add = (text: string | undefined): void => {
    if (!text) return
    for (const part of text.split(/[\s，。、；：！？,.;:!?（）()「」『』【】\/·—]/)) {
      const trimmed = part.trim()
      if (trimmed.length >= MIN_NGRAM) pieces.push(trimmed)
    }
  }
  for (const node of collectNodes(project.root)) {
    if (node.kind !== 'project') add(node.title)
  }
  const breakdown = project.breakdown
  if (breakdown) {
    add(breakdown.coreIntent)
    for (const item of breakdown.decomposition) add(item)
    for (const item of breakdown.deliverables) add(item.text)
    for (const item of breakdown.outOfScope) add(item)
  }

  const terms = new Set<string>()
  for (const piece of pieces) {
    const longest = Math.min(MAX_NGRAM, piece.length)
    for (let size = MIN_NGRAM; size <= longest; size += 1) {
      for (let start = 0; start + size <= piece.length; start += 1) {
        const fragment = piece.slice(start, start + size)
        if (STOP_TERMS.has(fragment)) continue
        // A fragment that begins with a function word is a fragment of *grammar*, not
        // of meaning: "的问" was matching "…无关的问题" and silently declaring an
        // off-topic message on-topic. That single false negative is enough to reset
        // the streak and make the detector useless, so the rule is blunt on purpose.
        if (FUNCTION_CHARS.has(fragment[0] ?? '')) continue
        terms.add(fragment)
      }
    }
  }
  return [...terms]
}

/** One verdict about a user message. */
export interface TopicVerdict {
  /** Whether the message touches the project's vocabulary at all. */
  readonly onTopic: boolean
  /** Fragments that matched, for display. */
  readonly hits: readonly string[]
  /** Whether the message was too short to judge. */
  readonly tooShort: boolean
}

/**
 * Judge one user message against the project's vocabulary.
 * @param message - the user's text.
 * @param terms - output of {@link projectTerms}.
 * @returns the verdict, including which fragments matched.
 */
export function judgeTopic(message: string, terms: readonly string[]): TopicVerdict {
  const text = message.trim()
  if (text.length < MIN_MESSAGE) {
    return { onTopic: true, hits: [], tooShort: true }
  }
  const hits = terms.filter((term) => text.includes(term))
  // One shared fragment is enough: the project ships Chinese vocabulary, and a false
  // "on topic" only costs a missed question, while a false "off topic" costs trust.
  return { onTopic: hits.length > 0, hits, tooShort: false }
}

/** Consecutive off-topic messages required before the user is asked. */
export const OFF_TOPIC_STREAK = 2

/** What the panel and the injection need to know about one session's topic drift. */
export interface TopicState {
  /** Consecutive off-topic messages, reset by any on-topic one. */
  readonly streak: number
  /** True once the streak reached {@link OFF_TOPIC_STREAK}. */
  readonly flagged: boolean
  /** Whether the model has already been asked about this streak. */
  readonly notified?: boolean
  /** A short excerpt of the most recent off-topic message. */
  readonly sample?: string
}

/** Tracks consecutive off-topic user messages per session. */
export class TopicWatcher {
  private readonly states = new Map<string, TopicState>()

  /**
   * Fold one user message into the session's state.
   * @param sessionId - the session.
   * @param message - the user's text.
   * @param terms - the project's vocabulary.
   * @returns the new state.
   */
  observe(sessionId: string, message: string, terms: readonly string[]): TopicState {
    const verdict = judgeTopic(message, terms)
    if (verdict.onTopic) {
      const reset: TopicState = { streak: 0, flagged: false }
      this.states.set(sessionId, reset)
      return reset
    }
    const previous = this.states.get(sessionId)
    const streak = (previous?.streak ?? 0) + 1
    const state: TopicState = {
      streak,
      flagged: streak >= OFF_TOPIC_STREAK,
      ...(previous?.notified ? { notified: true } : {}),
      sample: message.trim().slice(0, 40),
    }
    this.states.set(sessionId, state)
    return state
  }

  /**
   * Read a session's state without changing it.
   * @param sessionId - the session.
   * @returns the state, or a neutral one.
   */
  stateOf(sessionId: string): TopicState {
    return this.states.get(sessionId) ?? { streak: 0, flagged: false }
  }

  /**
   * Whether the model still needs to be asked about this streak.
   *
   * The streak itself is *not* reset here. Clearing it would mean the next off-topic
   * message starts counting from one again, so the model would be asked, then not
   * asked, then asked — and the user would experience the detector as broken.
   * @param sessionId - the session.
   * @returns true once per streak.
   */
  takeModelNotice(sessionId: string): boolean {
    const state = this.states.get(sessionId)
    if (!state?.flagged || state.notified) return false
    this.states.set(sessionId, { ...state, notified: true })
    return true
  }
}

/**
 * The question shown to the user in the panel.
 * @param state - the session's topic state.
 * @returns the sentence, with the sample so the user knows what triggered it.
 */
export function buildTopicQuestion(state: TopicState): string {
  return (
    `最近 ${state.streak} 条提问看起来和这个项目无关` +
    (state.sample ? `（例如「${state.sample}…」）` : '') +
    '。要把它登记成新项目/分支，还是继续推进主线？'
  )
}

/** The statement injected for the model, once per flag. */
export function buildTopicNotice(): string {
  return (
    '[任务图谱] 用户这条消息看起来和当前项目无关。**先不要开始解答或动手**：' +
    '先用一句话问清——这是项目外的临时问题（直接答完再回主线），还是要作为新项目/分支立项？' +
    '拿到答复后再继续。'
  )
}
