/**
 * The state line injected into a turn.
 *
 * This is the AI-facing half of the plugin. The panel is for the person; this is what
 * keeps the model oriented when a long conversation has buried the plan under error
 * text and file dumps. It is deliberately tiny — a few lines that say where the work
 * is, what it waits on, and what is next — because the point is to *save* context, not
 * to spend it.
 *
 * Injection is deduplicated by a state signature: the same state is never injected
 * twice, so a run of ordinary edits costs nothing while switching task, finishing a
 * node or coming back from a compaction re-anchors the model.
 */
import { collectNodes } from './model/tree.ts'
import type { AtlasNode, AtlasProject } from './model/types.ts'

/** Prefix every injected line, so it is obvious the text is generated. */
export const INJECTION_PREFIX = '[任务图谱]'

/** Soft budget for the whole injected block, in characters. */
export const INJECTION_BUDGET = 420

const STATUS_TEXT: Readonly<Record<string, string>> = {
  pending: '未开始',
  active: '进行中',
  done: '已完成',
  rework: '需返工',
  blocked: '阻塞',
  dropped: '已废弃',
}

/** The node to anchor on: the explicit focus, else the first thing in progress. */
export function focusOf(project: AtlasProject): AtlasNode | undefined {
  const nodes = collectNodes(project.root).filter((node) => node.kind !== 'project')
  if (project.focusedNodeId) {
    const focused = nodes.find((node) => node.id === project.focusedNodeId)
    if (focused) return focused
  }
  return (
    nodes.find((node) => node.status === 'active') ??
    nodes.find((node) => node.status === 'rework') ??
    nodes.find((node) => node.status === 'blocked') ??
    nodes.find((node) => node.status === 'pending')
  )
}

/**
 * A cheap fingerprint of everything the injected line would say.
 *
 * Equal signatures mean "nothing the model needs to hear has changed", which is what
 * keeps this from adding a message to every single step.
 * @param project - the active project.
 * @returns a stable string.
 */
export function stateSignature(project: AtlasProject): string {
  const focus = focusOf(project)
  if (!focus) return 'empty'
  const nodes = collectNodes(project.root)
  const done = nodes.filter((node) => node.status === 'done').length
  const active = nodes.filter((node) => node.status === 'active').length
  const rework = nodes.filter((node) => node.status === 'rework').length
  const blocked = nodes.filter((node) => node.status === 'blocked').length
  return `${project.id}:${focus.id}:${focus.status}:${done}/${active}/${rework}/${blocked}`
}

/**
 * Path from the module level down to the node, joined for display.
 * @param project - the active project.
 * @param node - target node.
 * @returns e.g. `用户面 / 呈现`.
 */
function trailOf(project: AtlasProject, node: AtlasNode): string {
  const parts: string[] = []
  const walk = (current: AtlasNode): boolean => {
    if (current.id === node.id) return true
    for (const child of current.children) {
      if (walk(child)) {
        if (current.kind !== 'project') parts.unshift(current.title)
        return true
      }
    }
    return false
  }
  walk(project.root)
  return [...parts, node.title].join(' / ')
}

/** What can be done next under a node. */
function nextStepOf(node: AtlasNode): string | undefined {
  const order = ['active', 'rework', 'blocked', 'pending'] as const
  for (const status of order) {
    const hit = node.children.find((child) => child.status === status)
    if (hit) return `${hit.title}（${STATUS_TEXT[hit.status] ?? hit.status}）`
  }
  return undefined
}

/**
 * Build the text injected before a step.
 * @param project - the active project.
 * @param options - `afterCompaction` adds a reminder that the context was cut but the
 *   tree was not; `nudge` appends a drift warning when the plan has gone untouched.
 * @returns the block, or `undefined` when there is nothing worth saying.
 */
export function buildInjection(
  project: AtlasProject,
  options: {
    readonly afterCompaction?: boolean
    readonly nudge?: string
    /** An extra line from another detector (topic drift), appended last. */
    readonly notice?: string
  } = {},
): string | undefined {
  const focus = focusOf(project)
  if (!focus) return undefined

  const lines: string[] = []
  if (options.afterCompaction) {
    // The model just lost the conversation; the tree is the only surviving record, so
    // say that plainly instead of letting it rediscover the plan from scratch.
    lines.push(`${INJECTION_PREFIX} 上下文刚被压缩过；任务图谱没有被压缩，下面的进度仍然有效。`)
  }
  lines.push(
    `${INJECTION_PREFIX} 当前：${focus.title}（${focus.id}，${STATUS_TEXT[focus.status] ?? focus.status}）`,
    `位置：${trailOf(project, focus)}`,
  )

  const prerequisites = (focus.dependsOn ?? []).map((id) => {
    const found = collectNodes(project.root).find((node) => node.id === id)
    return found ? `${found.title}（${STATUS_TEXT[found.status] ?? found.status}）` : id
  })
  if (prerequisites.length > 0) lines.push(`前置：${prerequisites.join('；')}`)

  const next = nextStepOf(focus)
  if (next) lines.push(`下一步：${next}`)

  lines.push('需要完整上下文时调 atlas_status；完成时用 atlas_node_done 记产出与验收。')
  if (options.nudge) lines.push(options.nudge)
  if (options.notice) lines.push(options.notice)

  let text = lines.join('\n')
  if (text.length > INJECTION_BUDGET) {
    // Never grow without bound; the budget is the whole point of this feature.
    text = `${text.slice(0, INJECTION_BUDGET - 1)}…`
  }
  return text
}

/**
 * Decides when a state line is worth injecting.
 *
 * Two rules, both learned from the failure modes:
 *  - the same state is never injected twice, or a long editing run would fill the
 *    transcript with identical lines;
 *  - a compaction invalidates that memory, because afterwards the model has lost the
 *    plan even though the tree is unchanged — precisely the case a naive signature
 *    comparison would miss.
 */
export class InjectionTracker {
  private readonly lastSignature = new Map<string, string>()
  private readonly compacted = new Set<string>()

  /**
   * Whether this state should be injected now.
   * @param sessionId - the session the step belongs to.
   * @param signature - fingerprint of what would be said.
   * @returns true once per distinct signature.
   */
  shouldInject(sessionId: string, signature: string): boolean {
    if (this.lastSignature.get(sessionId) === signature) return false
    this.lastSignature.set(sessionId, signature)
    return true
  }

  /**
   * Record that a session's context was compacted.
   * @param sessionId - the session that was compacted.
   */
  noteCompaction(sessionId: string): void {
    this.lastSignature.delete(sessionId)
    this.compacted.add(sessionId)
  }

  /**
   * Whether the next injection should mention the compaction.
   * @param sessionId - the session about to be injected.
   * @returns true exactly once per compaction.
   */
  takeCompactionNotice(sessionId: string): boolean {
    return this.compacted.delete(sessionId)
  }
}
