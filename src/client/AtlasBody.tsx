/**
 * The panel body: the one surface that answers "what was this, where am I, what
 * is left, and why is that thing there".
 *
 * Structure is fixed and shallow on purpose — a pinned breakdown on top, anything
 * waiting for you next, then the plan — because the panel is read while
 * distracted, mid-task.
 */
import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { collectNodes, findNode, pathOf, progressOf } from '../model/tree.ts'
import { CanvasView } from './canvas-view.tsx'
import { LAYOUT_VERSION } from './canvas-layout.ts'
import { shortLabel } from '../model/title.ts'
import { unmetNeeds } from '../model/needs.ts'
import { outputsLine } from '../model/outputs.ts'
import type { NodeOutput } from '../model/types.ts'
import type { AtlasNode, AtlasProject, Breakdown, NodeKind } from '../model/types.ts'
import type { WorkspaceHistory } from '../workspace-history.ts'
import { useAtlasState } from './api.ts'
import { STATUS_COLOR, STATUS_LABEL } from './labels.ts'
import { ProgressView } from './progress-view.tsx'
import { TreeView, initialCollapsed } from './tree-view.tsx'

const VIEW_KEY = 'dsh-task-atlas:view'

/**
 * The three ways to look at the same project.
 *
 * Each answers a different question, and that is the only reason all three exist:
 * `tree` — what is under what, and what is wrong with it; `graph` — what waits for
 * what; `progress` — how far along, and what changed.
 */
/**
 * Three views: the tree is for working, the progress list reports the run, and the canvas is
 * where dependencies become readable.
 */
type AtlasView = 'tree' | 'progress' | 'canvas'

const root: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '12px 12px 24px',
  height: '100%',
  boxSizing: 'border-box',
  fontFamily: 'var(--dsw-font-ui, system-ui, sans-serif)',
  color: 'var(--dsw-alias-text-primary, inherit)',
  overflowY: 'auto',
}

const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '9px 10px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.25))',
  background: 'var(--dsw-alias-surface-raised, rgba(128,128,128,0.06))',
}

const muted: CSSProperties = {
  fontSize: 11.5,
  lineHeight: '17px',
  color: 'var(--dsw-alias-text-secondary, #8b949e)',
}

const tiny: CSSProperties = {
  fontSize: 10.5,
  lineHeight: '15px',
  color: 'var(--dsw-alias-text-tertiary, #8b949e)',
}

const button: CSSProperties = {
  font: 'inherit',
  fontSize: 11.5,
  lineHeight: '18px',
  padding: '2px 9px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

function time(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Owner props this body uses. Only the session id is needed. */
export interface AtlasBodyProps {
  readonly sessionId?: string
  /**
   * The shell's public input actions for this session.
   *
   * Injected by the slot runtime as a *standard session prop*; absent in a
   * non-session scope, which is why every use of it has a clipboard fallback rather
   * than assuming it exists.
   */
  readonly inputActions?: InputActionsLike
  /**
   * Ask the shell for a wider column, called when the user opens the dependency canvas.
   *
   * Provided by the registration site, which has the sidebar service; optional so the body
   * still renders (just narrower) when it is absent.
   */
  readonly onExpand?: () => void
  /**
   * Presentation override, when a host chooses to pass one.
   *
   * The real decision is made from the measured width of this panel (see `AtlasBodyInner`):
   * the slot's own presentation flag arrives through a hook prop that throws while the tab is
   * not yet committed, and calling it under `try/catch` corrupts React's hook order — that
   * mistake blanked the panel once. Width is the condition that matters anyway.
   */
  readonly fullscreen?: boolean
}

/** The slice of the shell's input actions this panel uses. */
export interface InputActionsLike {
  /** Replace the composer's content. */
  setDraft(text: string): void
  /** Submit the composer as a normal user message. */
  submit(): void
}

const KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  project: '项目',
  module: '模块',
  task: '任务',
  item: '子项',
}

/**
 * The message that "continue from here" sends.
 *
 * Written as an instruction to the model, not as a description of the tree: the
 * point is that the conversation stops being about the panel and starts being about
 * that one task, with enough context that the model does not have to guess.
 * @param project - the active project.
 * @param node - the node to continue from.
 * @returns a ready-to-send prompt.
 */
function continuePrompt(project: AtlasProject, node: AtlasNode): string {
  const path = (pathOf(project.root, node.id) ?? [])
    .map((step) => step.title)
    .join(' / ')
  const prerequisites = (node.dependsOn ?? [])
    .map((id) => {
      const found = findNode(project.root, id)
      return found ? `${found.title}（${STATUS_LABEL[found.status]}）` : id
    })
    .join('；')
  const lines = [
    `从这里继续：${node.title}（${node.id}，${KIND_LABEL[node.kind]}，当前 ${STATUS_LABEL[node.status]}）`,
    `项目：${project.title}`,
    `位置：${path}`,
  ]
  lines.push(`说明：${node.note?.trim() ? node.note.trim() : '（这个节点还没写说明，请先向我确认它要做什么）'}`)
  if (node.result?.trim()) lines.push(`已有结果：${node.result.trim()}`)
  // Carrying the handles into the prompt is what stops the next turn from rebuilding
  // something that already exists at a known address.
  const existing = outputsLine(node.outputs)
  if (existing) lines.push(`已有产出（可直接复用，不要重复造）：${existing}`)
  if (prerequisites) lines.push(`前置：${prerequisites}`)
  lines.push(
    '请先 atlas_focus 到这个节点并用 atlas_status 拉一次上下文，确认你我的理解一致后再动手；',
    '做完用 atlas_node_done 记下产出与验收，遇到需要返工或阻塞的情况先问我。',
  )
  return lines.join('\n')
}

/**
 * First-run surface.
 *
 * Which options it offers is decided by whether this workspace already has
 * conversations: a workspace with prior work must NOT ask the user to re-explain
 * it, because that re-explaining is the exact cost this plugin exists to remove.
 * @param props - the kickoff verdict from the host, when it could be computed.
 */
function KickoffGuide(props: { readonly history: WorkspaceHistory | null }) {
  const [copied, setCopied] = useState<string | null>(null)
  const send = (mode: string, prompt: string): void => {
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopied(null)
      return
    }
    void clipboard.writeText(prompt).then(
      () => setCopied(mode),
      () => setCopied(null),
    )
  }
  const fromHistory =
    '这个工作区已经有前情。请先调 atlas_workspace_history 确认前情来自哪里（别的历史会话，还是当前这个会话本身），' +
    '然后把那些材料吃透，把项目蓝图（核心意图、核心交付物及验收、拆解、整体验收标准、明确不做什么、约束与前置依赖、优先级顺序）' +
    '从已有材料里重建出来，调 atlas_breakdown_draft 校验后 atlas_breakdown_confirm 落盘（mode 用 fast）。' +
    '最后明确告诉我：哪些是你从已有材料里读出来的，哪些是推断的、需要我纠正。'
  const fast =
    '请走快速拆解：先由你起草这个项目的拆解（核心意图、核心交付物及验收、1/2/3/4 拆解、整体验收标准、明确不做什么、约束与前置依赖、优先级顺序），我来校对调整，然后落盘。'
  const detailed =
    '请走详细拆解：按七个维度逐项问我（核心意图、核心交付物及验收、拆解、整体验收标准、明确不做什么、约束与前置依赖、优先级与先后顺序），把细节敲实后再落盘。'

  const history = props.history
  const hasHistory = history?.hasHistory === true
  const updated =
    history?.latestCreatedAt !== undefined ? time(history.latestCreatedAt) : undefined
  const priorCount = history?.priorSessionCount ?? 0
  const current = history?.currentSession
  const currentCounts =
    history?.reasons.includes('current-session') === true && current !== undefined

  return (
    <div style={card}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>这个工作区还没有项目蓝图</div>

      {hasHistory ? (
        <>
          <div style={muted}>
            {priorCount > 0 ? (
              <>
                检测到本工作区在本次对话之前有 <b>{priorCount}</b> 个会话
                {updated ? `，最近一次在 ${updated}` : ''}。
              </>
            ) : null}
            {currentCounts && current ? (
              <>
                当前这个会话本身已经很长（<b>{current.userMessages}</b> 条你的消息、
                {current.turns} 轮）。
              </>
            ) : null}
            {' '}工作已经说过了，所以默认从已有材料重建，不用你重讲。
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            <button style={button} onClick={() => send('history', fromHistory)}>
              从已有材料生成蓝图（推荐）
            </button>
            <button style={button} onClick={() => send('fast', fast)}>
              忽略前情，快速拆解
            </button>
            <button style={button} onClick={() => send('detailed', detailed)}>
              详细拆解（逐项问我）
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={muted}>
            先明确"这个项目到底要做什么、交付什么、拆成几步"，之后这棵树会跟着真实进展自动更新。
            {history === null
              ? '（无法读取会话记录，按全新工作区处理。）'
              : '（没有检测到前情：既没有别的会话，当前会话也还短。）'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            <button style={button} onClick={() => send('fast', fast)}>
              快速拆解（AI 起草，我改）
            </button>
            <button style={button} onClick={() => send('detailed', detailed)}>
              详细拆解（逐项问我）
            </button>
          </div>
        </>
      )}

      <div style={tiny}>
        {copied
          ? '已复制到剪贴板，粘到输入框发送即可。'
          : '点一下会把对应的话复制到剪贴板，粘到输入框发送即可。'}
      </div>
    </div>
  )
}

/**
 * The detail card for the selected node.
 *
 * This is where "clicking a node shows nothing useful" was happening: the card only
 * ever rendered fields that happened to be filled in, so an unfinished node rendered
 * as a bare title. It now always shows position and prerequisites, says so out loud
 * when the explanation is missing, and carries the one action worth having here —
 * handing this task to the conversation.
 */
function NodeDetail({
  project,
  node,
  onSelect,
  inputActions,
}: {
  readonly project: AtlasProject
  readonly node: AtlasNode
  readonly onSelect: (id: string) => void
  readonly inputActions?: InputActionsLike
  /**
   * Ask the shell for a wider column, called when the user opens the dependency canvas.
   *
   * Provided by the registration site, which has the sidebar service; optional so the body
   * still renders (just narrower) when it is absent.
   */
  readonly onExpand?: () => void
}) {
  const [feedback, setFeedback] = useState<'sent' | 'copied' | 'failed' | null>(null)
  const label = shortLabel(node.title)
  const needs = node.needs ?? []
  const outputs = node.outputs ?? []
  const trail = useMemo(() => pathOf(project.root, node.id) ?? [], [project.root, node.id])
  const ancestors = trail.slice(0, -1)
  const prerequisites = (node.dependsOn ?? [])
    .map((id) => findNode(project.root, id))
    .filter((found): found is AtlasNode => Boolean(found))

  const handOver = (): void => {
    const prompt = continuePrompt(project, node)
    if (inputActions) {
      try {
        inputActions.setDraft(prompt)
        inputActions.submit()
        setFeedback('sent')
        return
      } catch {
        /* fall through to the clipboard, which always works */
      }
    }
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setFeedback('failed')
      return
    }
    void clipboard.writeText(prompt).then(
      () => setFeedback('copied'),
      () => setFeedback('failed'),
    )
  }

  return (
    <div style={{ ...card, borderColor: STATUS_COLOR[node.status] }}>
      {ancestors.length > 0 ? (
        <div style={{ ...tiny, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {ancestors.map((step) => (
            <span key={step.id}>
              {step.title}
              <span style={{ opacity: 0.5 }}> / </span>
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label.label}</span>
        <span style={{ fontSize: 10.5, color: STATUS_COLOR[node.status] }}>
          {STATUS_LABEL[node.status]}
        </span>
        <span style={tiny}>
          {KIND_LABEL[node.kind]} · {node.id}
        </span>
      </div>
      {/* The rest of a sentence-shaped title used to be lost behind an ellipsis in the row;
          here it is, verbatim, where there is room for it. */}
      {label.remainder ? (
        <div style={{ ...tiny, whiteSpace: 'pre-wrap' }}>{label.remainder}</div>
      ) : null}

      {outputs.length > 0 ? <OutputsBlock outputs={outputs} /> : null}

      {node.note?.trim() ? <Clamped text={node.note} /> : null}

      {needs.length > 0 ? (
        // The list that makes the graph meaningful: what this node needs, who provides it,
        // and — separately — what nothing in the plan provides, because that gap is usually
        // the part of the project nobody has written down yet.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={tiny}>
            开工条件 {needs.length} 项
            {unmetNeeds(needs).length > 0 ? ` · 缺 ${unmetNeeds(needs).length} 项` : ' · 已满足'}
          </span>
          {needs.map((need, index) => {
            const provider = need.fromNodeId ? findNode(project.root, need.fromNodeId) : undefined
            return (
              <div
                key={`${need.label}:${index}`}
                style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}
              >
                <span style={{ color: need.satisfied === true ? STATUS_COLOR.done : STATUS_COLOR.rework }}>
                  {need.satisfied === true ? '✓' : '✗'}
                </span>
                <span style={muted}>{need.label}</span>
                {provider ? (
                  <button
                    style={{ ...chip, color: STATUS_COLOR[provider.status] }}
                    onClick={() => onSelect(provider.id)}
                  >
                    ← {provider.title}
                  </button>
                ) : (
                  <span style={{ ...tiny, fontStyle: 'italic' }}>外部条件（图谱里没有提供方）</span>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      {prerequisites.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={tiny}>本节点前置依赖（{prerequisites.length}）</span>
          {prerequisites.map((dependency) => {
            // The colour is the point: a glance at this list should tell you whether the
            // things this node waits for are done, running, or stuck — without opening each.
            const need = (node.needs ?? []).find((item) => item.fromNodeId === dependency.id)
            return (
              <div
                key={dependency.id}
                style={{ display: 'flex', gap: 5, alignItems: 'baseline', flexWrap: 'wrap' }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: STATUS_COLOR[dependency.status],
                    transform: 'translateY(1px)',
                  }}
                />
                <button
                  style={{ ...chip, color: STATUS_COLOR[dependency.status] }}
                  onClick={() => onSelect(dependency.id)}
                >
                  {shortLabel(dependency.title).label}
                </button>
                <span style={{ ...tiny, color: STATUS_COLOR[dependency.status] }}>
                  {STATUS_LABEL[dependency.status]}
                </span>
                {need?.label ? <span style={tiny}>· 需要：{need.label}</span> : null}
              </div>
            )
          })}
        </div>
      ) : null}

      {node.children.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={tiny}>{node.children.length} 个子项</span>
          {node.children.slice(0, 6).map((child) => (
            <button
              key={child.id}
              style={{ ...chip, color: STATUS_COLOR[child.status] }}
              onClick={() => onSelect(child.id)}
            >
              {child.title}
            </button>
          ))}
          {node.children.length > 6 ? <span style={tiny}>…</span> : null}
        </div>
      ) : null}

      {node.reason ? (
        <div style={{ ...muted, color: STATUS_COLOR[node.status] }}>原因：{node.reason}</div>
      ) : null}
      {node.returnCondition ? (
        <div style={muted}>解除条件：{node.returnCondition}</div>
      ) : null}
      {node.result ? (
        <div style={muted}>
          结果：<Clamped text={node.result} />
        </div>
      ) : null}
      {node.branch ? (
        <div style={muted}>
          分支：源自 <code>{node.branch.originId}</code>；为什么：{node.branch.trigger}
          {node.branch.returnCondition ? `；回归条件：${node.branch.returnCondition}` : ''}
          {node.branch.resolvedAt
            ? `；已于 ${time(node.branch.resolvedAt)} 合回 ${node.branch.resolvesTo ?? node.branch.originId}`
            : ''}
          {node.branch.resolution ? `；产出：${node.branch.resolution}` : ''}
        </div>
      ) : null}
      {node.history.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={tiny}>变更历史</span>
          {node.history.map((change, index) => (
            <span key={`${change.at}:${index}`} style={tiny}>
              {time(change.at)} {change.by === 'ai' ? 'AI' : '你'}：
              {STATUS_LABEL[change.from]} → {STATUS_LABEL[change.to]}
              {change.reason ? `（${change.reason}）` : ''}
              {change.confirmedBy ? '，经你确认' : ''}
            </span>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button style={primaryButton} onClick={handOver}>
          从这里继续
        </button>
        <span style={tiny}>
          {feedback === 'sent'
            ? '已发到这个会话'
            : feedback === 'copied'
              ? '指令已复制，粘贴到输入框发送即可'
              : feedback === 'failed'
                ? '复制失败，请手动选中详情文字'
                : inputActions
                  ? '把这句发进当前会话，让对话从这个节点接着走'
                  : '会复制一句指令，粘贴到输入框发送'}
        </span>
      </div>
    </div>
  )
}

const chip: CSSProperties = {
  padding: '0 6px',
  borderRadius: 5,
  border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.3))',
  background: 'transparent',
  fontSize: 10,
  lineHeight: '16px',
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const primaryButton: CSSProperties = {
  padding: '3px 10px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-accent, #2f81f7)',
  background: 'var(--dsw-alias-accent, #2f81f7)',
  color: '#fff',
  fontSize: 11.5,
  fontWeight: 600,
  cursor: 'pointer',
}

function ProjectHeader({ project }: { readonly project: AtlasProject }) {
  const progress = progressOf(project.root)
  const stats: string[] = []
  if (progress.active > 0) stats.push(`进行中 ${progress.active}`)
  if (progress.rework > 0) stats.push(`需返工 ${progress.rework}`)
  if (progress.blocked > 0) stats.push(`阻塞 ${progress.blocked}`)
  if (progress.dropped > 0) stats.push(`已废弃 ${progress.dropped}`)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 650 }}>{project.title}</span>
        <span style={tiny}>
          {Math.round(progress.completion * 100)}% · {progress.done}/{progress.countable}
        </span>
      </div>
      {project.breakdown ? (
        <>
          <div style={muted}>{project.breakdown.coreIntent}</div>
          <div style={tiny}>
            {project.breakdown.mode === 'fast' ? '快速拆解' : '详细拆解'} · 拆解已确认 ·{' '}
            {time(project.breakdown.confirmedAt)}
          </div>
          {stats.length > 0 ? <div style={tiny}>{stats.join(' · ')}</div> : null}
        </>
      ) : (
        <div style={muted}>拆解还没确认。</div>
      )}
      <div
        style={{
          height: 3,
          borderRadius: 2,
          background: 'var(--dsw-alias-surface-sunken, rgba(128,128,128,0.2))',
          overflow: 'hidden',
          marginTop: 2,
        }}
      >
        <div
          style={{
            width: `${Math.round(progress.completion * 100)}%`,
            height: '100%',
            background: STATUSBAR,
          }}
        />
      </div>
    </div>
  )
}

const STATUSBAR = 'var(--dsw-alias-accent, #2f81f7)'

/**
 * The panel body.
 * @param props - owner props; `sessionId` selects the workspace to show.
 */
export function AtlasBody(props: AtlasBodyProps) {
  return (
    <BodyBoundary>
      <AtlasBodyInner {...props} />
    </BodyBoundary>
  )
}

/**
 * Keep a crash inside the body from emptying the panel.
 *
 * An error thrown while rendering a slot body removes that body from the slot, and the user
 * sees an empty column with no explanation — which reads as "my plan was deleted". A boundary
 * costs a few lines and turns that into a visible message with a retry.
 */
class BodyBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null; readonly attempt: number }
> {
  constructor(init: { readonly children: ReactNode }) {
    super(init)
    this.state = { error: null, attempt: 0 }
  }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    if (typeof console !== 'undefined') console.error('[task-atlas] panel crashed', error)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div data-plugin="dsh-task-atlas" style={{ ...root, gap: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>任务图谱</div>
        <div style={{ ...card, borderColor: STATUS_COLOR.blocked }}>
          <div style={{ fontSize: 12 }}>面板渲染出错了（数据没有丢）</div>
          <div style={muted}>{this.state.error.message}</div>
          <button
            style={button}
            onClick={() => this.setState((current) => ({ error: null, attempt: current.attempt + 1 }))}
          >
            重试
          </button>
        </div>
      </div>
    )
  }
}

/** The real body, with the crash boundary above it. */
function AtlasBodyInner(props: AtlasBodyProps) {
  const feed = useAtlasState(props.sessionId)
  /**
   * The view is the entry point, not the panel's width.
   *
   * An earlier attempt gated the canvas on measured width so it would only appear when there
   * was room — that made the feature unreachable without knowing it existed. The toolbar's
   * 「依赖图」 button is the entry instead (it also asks the shell to widen the column); width
   * only affects how comfortable the result is.
   */
  const panel = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<AtlasView>(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY)
      // 'graph'/'map' were the old names of this same view, so a stored preference still works.
      if (saved === 'graph' || saved === 'map') return 'canvas'
      return saved === 'progress' ? 'progress' : 'tree'
    } catch {
      return 'tree'
    }
  })
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [showBuiltin, setShowBuiltin] = useState(false)
  const [showRevisions, setShowRevisions] = useState(false)
  /**
   * Which nodes are collapsed.
   *
   * Owned here rather than inside the tree because switching views unmounts it —
   * the user's expansion choices used to be thrown away every time they looked at
   * the map and came back.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const initialisedFor = useRef<string | undefined>(undefined)

  const switchView = (next: AtlasView): void => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      /* private mode: the choice just will not persist */
    }
  }

  const doc = feed.state?.document
  const project = useMemo(() => {
    if (!doc) return undefined
    return (
      doc.projects.find((candidate) => candidate.id === doc.activeProjectId) ??
      doc.projects[0]
    )
  }, [doc])

  const selectedNode = useMemo(() => {
    if (!project || !selected) return undefined
    return findNode(project.root, selected) ?? undefined
  }, [project, selected])

  // Seed the collapse set once per project: top two levels open, everything deeper
  // closed except the focused path. Re-seeding on every poll would fight the user.
  useEffect(() => {
    if (!project) return
    if (initialisedFor.current === project.id) return
    initialisedFor.current = project.id
    setCollapsed(initialCollapsed(project))
  }, [project])

  const toggleCollapsed = (id: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const builtin = feed.state?.builtin ?? null
  const pending = doc?.pending ?? []

  if (!project) {
    return (
      <div ref={panel} data-plugin="dsh-task-atlas" style={root}>
        <div style={{ fontSize: 13.5, fontWeight: 650 }}>任务图谱</div>
        {feed.error ? (
          <div style={{ ...card, borderColor: STATUS_COLOR.blocked }}>
            <div style={{ fontSize: 12 }}>读不到数据（{feed.error.code}）</div>
            <div style={muted}>{feed.error.summary}</div>
            <button style={button} onClick={feed.reload}>
              重试
            </button>
          </div>
        ) : feed.loading ? (
          <div style={muted}>正在读取…</div>
        ) : (
          <KickoffGuide history={feed.state?.history ?? null} />
        )}
      </div>
    )
  }

  const total = collectNodes(project.root).length

  // One toolbar for both presentations: the canvas is a view you can always get back from, not
  // a mode that traps you.
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 13.5, fontWeight: 650, flex: 1 }}>任务图谱</span>
      <button
        style={{ ...button, background: view === 'tree' ? 'rgba(128,128,128,0.18)' : 'transparent' }}
        onClick={() => switchView('tree')}
      >
        树
      </button>
      <button
        style={{
          ...button,
          background: view === 'progress' ? 'rgba(128,128,128,0.18)' : 'transparent',
        }}
        onClick={() => switchView('progress')}
      >
        进展
      </button>
      <button
        style={{
          ...button,
          background: view === 'canvas' ? 'rgba(128,128,128,0.18)' : 'transparent',
        }}
        // An explicit entry that also asks for the room the canvas needs. A view nobody can
        // find is not a feature; a canvas squeezed into a 400 px column is not readable.
        onClick={() => {
          props.onExpand?.()
          switchView('canvas')
        }}
        title="依赖画布：谁需要谁、需要什么"
      >
        依赖图
      </button>
    </div>
  )

  if (view === 'canvas') {
    return (
      <div
        ref={panel}
        data-plugin="dsh-task-atlas"
        style={{ ...root, height: '100%', gap: 6, overflow: 'hidden' }}
      >
        {toolbar}
        <div style={{ ...tiny, flexShrink: 0 }}>
          {project.title} · 拖动卡片调整位置，滚轮缩放；点「树」回到列表
        </div>
        {/*
         * `position: relative` is load-bearing: the canvas surface inside is
         * `position: absolute; inset: 0`, and without a positioned parent here it anchors to
         * the tab body instead — which drew the graph straight over the title and the view
         * switch.
         */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <CanvasView
            project={project}
            // Positions from a superseded arrangement are ignored, not applied: they belong to
            // a layout that no longer exists.
            layout={
              feed.state?.document.layoutVersion === LAYOUT_VERSION
                ? feed.state?.document.layout
                : undefined
            }
            onSaveLayout={(positions) => void feed.saveLayout(positions)}
            selectedId={selected}
            onSelect={setSelected}
          />
        </div>
      </div>
    )
  }

  return (
    <div ref={panel} data-plugin="dsh-task-atlas" style={root}>
      {toolbar}

      <ProjectHeader project={project} />

      {feed.state?.build && feed.state.build.at > feed.state.build.startedAt + 2000 ? (
        // The running app started before the code on disk was built, so nothing changed in
        // this build is actually active. Saying it here is the difference between "the
        // feature is broken" and "restart, then look again".
        <div
          style={{
            fontSize: 10.5,
            lineHeight: '15px',
            padding: '3px 6px',
            borderRadius: 4,
            color: '#92400e',
            background: 'rgba(245,158,11,0.14)',
            border: '1px solid rgba(245,158,11,0.4)',
          }}
        >
          正在运行旧构建：代码构建于 {time(feed.state.build.at)}，进程启动于{' '}
          {time(feed.state.build.startedAt)}。这个构建里的改动要重启应用才生效。
        </div>
      ) : null}

      {project.breakdown ? <BreakdownPanel breakdown={project.breakdown} /> : null}

      {project.breakdown && (project.breakdown.revisions?.length ?? 0) > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            style={{ ...button, alignSelf: 'flex-start' }}
            onClick={() => setShowRevisions((value) => !value)}
          >
            {showRevisions ? '▾' : '▸'} 拆解修订 {project.breakdown.revisions?.length} 次
          </button>
          {showRevisions ? (
            <div style={card}>
              {(project.breakdown.revisions ?? []).map((revision, index) => (
                <div key={`${revision.at}:${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={muted}>
                    {time(revision.at)} {revision.by === 'ai' ? 'AI' : '你'}修订：{revision.reason}
                  </span>
                  {revision.changes.map((change, changeIndex) => (
                    <span key={`${change.field}:${changeIndex}`} style={tiny}>
                      · {change.field}：「{change.from}」→「{change.to}」
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {feed.error ? (
        <div style={{ ...card, borderColor: STATUS_COLOR.blocked }}>
          <div style={{ fontSize: 12 }}>刷新失败（{feed.error.code}）</div>
          <div style={muted}>{feed.error.summary}</div>
          <button style={button} onClick={feed.reload}>
            重试
          </button>
        </div>
      ) : null}

      <TopicStrip
        topic={feed.state?.drift.topic ?? null}
        steps={feed.state?.drift.steps ?? 0}
        inputActions={props.inputActions}
      />

      {pending.length > 0 ? (
        <div style={{ ...card, borderColor: STATUS_COLOR.rework }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>待你确认（{pending.length}）</div>
          {pending.map((item) => (
            <div
              key={item.id}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' }}
            >
              <span style={{ ...muted, flex: 1, minWidth: 120 }}>
                <code>{item.nodeId}</code> → {STATUS_LABEL[item.to]}
                {item.reason ? `：${item.reason}` : ''}
              </span>
              <button
                style={button}
                disabled={feed.busy === item.id}
                onClick={() => void feed.confirm(item.id)}
              >
                {feed.busy === item.id ? '处理中…' : '确认'}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {view === 'tree' ? (
        <TreeView
          project={project}
          selectedId={selected}
          onSelect={setSelected}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
        />
      ) : (
        <ProgressView project={project} onSelect={setSelected} />
      )}

      {selectedNode ? (
        <NodeDetail
          project={project}
          node={selectedNode}
          onSelect={setSelected}
          inputActions={props.inputActions}
        />
      ) : null}

      {builtin || total > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            style={{ ...button, alignSelf: 'flex-start' }}
            onClick={() => setShowBuiltin((value) => !value)}
          >
            {showBuiltin ? '▾' : '▸'} 内置计划（只读）
          </button>
          {showBuiltin ? (
            <div style={card}>
              <div style={tiny}>来自 DSH 自己的待办与目标，插件只读不改。</div>
              {builtin?.goal ? (
                <div style={muted}>目标：{builtin.goal.objective}</div>
              ) : (
                <div style={muted}>目标：（无）</div>
              )}
              {builtin && builtin.todos.length > 0 ? (
                builtin.todos.map((todo, index) => (
                  <div key={`${todo.content}:${index}`} style={muted}>
                    [{todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}]{' '}
                    {todo.content}
                  </div>
                ))
              ) : (
                <div style={muted}>内置待办：（空）</div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {feed.state && feed.state.resolvedVia === 'latest' ? (
        <div style={{ ...tiny, color: STATUS_COLOR.rework }}>
          这个会话重启后还没产生新事件，工作区是按「最近活跃工作区」推断的：
          <code>{feed.state.cwd}</code>。发一条消息后会自动校准。
        </div>
      ) : null}

      <div style={tiny}>
        共 {total} 个节点 · 有变化即时刷新
        {feed.state ? ` · ${feed.state.cwd}` : ''}
        {feed.state ? ` · ${time(feed.state.now)}` : ''}
      </div>
    </div>
  )
}

/**
 * Drift strip.
 *
 * Two different signals, deliberately shown differently:
 *  - the step counter is always visible but quiet, so "the detector is watching" is
 *    something the user can verify instead of taking on faith;
 *  - the topic question is a *question*, because a wrong question costs one "no",
 *    while a wrong command would teach the model to ignore the next one.
 */
function TopicStrip({
  topic,
  steps,
  inputActions,
}: {
  readonly topic: { readonly streak: number; readonly flagged: boolean; readonly sample?: string } | null
  readonly steps: number
  readonly inputActions?: InputActionsLike
  /**
   * Ask the shell for a wider column, called when the user opens the dependency canvas.
   *
   * Provided by the registration site, which has the sidebar service; optional so the body
   * still renders (just narrower) when it is absent.
   */
  readonly onExpand?: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const [sent, setSent] = useState(false)

  const flagged = topic?.flagged === true && !dismissed
  if (!flagged && steps <= 0) return null

  const propose = (): void => {
    const prompt =
      '刚才那个话题和当前项目无关，请把它单独登记成一个新项目：用 atlas_breakdown_confirm 新建（会切换活动项目），' +
      `核心意图和第一条交付物先写出来，其余我来补。当前项目保持不动。` +
      (topic?.sample ? `\n那个话题是：${topic.sample}` : '')
    if (inputActions) {
      try {
        inputActions.setDraft(prompt)
        inputActions.submit()
        setSent(true)
        return
      } catch {
        /* fall through to the clipboard */
      }
    }
    const clipboard = navigator.clipboard
    if (clipboard) void clipboard.writeText(prompt).catch(() => {})
    setSent(true)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {topic?.flagged === true && !dismissed ? (
        <div style={{ ...card, borderColor: STATUS_COLOR.rework }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            最近的提问看起来和这个项目无关（连续 {topic.streak} 条）
          </div>
          {topic.sample ? <div style={muted}>例如：「{topic.sample}…」</div> : null}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button style={primaryButton} onClick={propose} disabled={sent}>
              {sent ? '已发出' : '登记成新项目'}
            </button>
            <button style={button} onClick={() => setDismissed(true)}>
              继续推进主线
            </button>
          </div>
          {sent ? (
            <div style={tiny}>
              已把立项指令发进会话；如果你只是想继续，直接忽略这条也行——下一条和项目相关的话会自动消掉它。
            </div>
          ) : null}
        </div>
      ) : null}
      {steps > 0 ? <div style={tiny}>图谱：已经 {steps} 步没有动过了</div> : null}
    </div>
  )
}

const BREAKDOWN_KEY = 'dsh-task-atlas:breakdown-open'

/**
 * The seven fields, in the panel.
 *
 * The header only ever showed the core intent, so five of the seven fields had no panel
 * outlet at all — they existed in `atlas_status` and in the Markdown mirror, which meant
 * "the breakdown is pinned where you can see it" was only half true. Collapsed by default
 * because this is reference material, not something to read every time.
 */
function BreakdownPanel({ breakdown }: { readonly breakdown: Breakdown }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(BREAKDOWN_KEY) === 'open'
    } catch {
      return false
    }
  })

  const toggle = (): void => {
    setOpen((value) => {
      const next = !value
      try {
        localStorage.setItem(BREAKDOWN_KEY, next ? 'open' : 'closed')
      } catch {
        /* private mode: the choice just will not persist */
      }
      return next
    })
  }

  const list = (label: string, items: readonly string[]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={tiny}>{label}</span>
      {items.length === 0 ? (
        <span style={{ ...muted, opacity: 0.7 }}>（未填）</span>
      ) : (
        items.map((item, index) => (
          <span key={`${label}:${index}`} style={muted}>
            · {item}
          </span>
        ))
      )}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button style={{ ...button, alignSelf: 'flex-start' }} onClick={toggle}>
        {open ? '▾' : '▸'} 完整拆解（七项）
      </button>
      {open ? (
        <div style={{ ...card, gap: 6 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={tiny}>核心意图</span>
            <span style={muted}>{breakdown.coreIntent}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={tiny}>核心交付物（{breakdown.deliverables.length}）</span>
            {breakdown.deliverables.length === 0 ? (
              <span style={{ ...muted, opacity: 0.7 }}>（未填）</span>
            ) : (
              breakdown.deliverables.map((deliverable, index) => (
                <div key={`${deliverable.text}:${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  <span style={muted}>
                    {index + 1}. {deliverable.text}
                  </span>
                  <span style={{ ...tiny, paddingLeft: 12 }}>
                    验收：{deliverable.acceptance?.trim() ? deliverable.acceptance : '（未写）'}
                  </span>
                </div>
              ))
            )}
          </div>

          {list('拆解', breakdown.decomposition)}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={tiny}>整体验收标准</span>
            <span style={muted}>{breakdown.acceptance?.trim() ? breakdown.acceptance : '（未填）'}</span>
          </div>

          {list('明确不做什么', breakdown.outOfScope)}
          {list('约束与前置依赖', breakdown.constraints)}
          {list('优先级与先后顺序', breakdown.priorityOrder)}
        </div>
      ) : null}
    </div>
  )
}

const CLAMP_LINES = 3

/**
 * Long text, truncated to a few lines with a toggle.
 *
 * The detail card is where the full explanation belongs — but a card that is a wall of text
 * is not read either. Three lines is enough to know what a node is; anything longer is a
 * deliberate act of opening.
 */
function Clamped({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false)
  const needsToggle = text.length > 160 || text.split('\n').length > CLAMP_LINES
  if (!needsToggle) {
    return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
  }
  return (
    <span style={{ display: 'block' }}>
      <span
        style={{
          display: open ? 'block' : '-webkit-box',
          WebkitLineClamp: open ? undefined : CLAMP_LINES,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
        }}
      >
        {text}
      </span>
      <button
        style={{ ...tiny, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '收起' : '展开'}
      </button>
    </span>
  )
}

/**
 * The handles a node produced.
 *
 * This is the block that makes the panel worth reopening: an address or a path that exists only
 * inside a paragraph of the conversation means scrolling back through the transcript to find it
 * again. A url opens; a path copies (the webview cannot launch a local file).
 */
function OutputsBlock({ outputs }: { readonly outputs: readonly NodeOutput[] }) {
  const [copied, setCopied] = useState<string | undefined>(undefined)

  const copy = (target: string): void => {
    const work = navigator.clipboard?.writeText(target)
    if (work) {
      work.then(
        () => setCopied(target),
        () => setCopied(undefined),
      )
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={tiny}>核心产出（{outputs.length}）</span>
      {outputs.map((output) => (
        <div
          key={output.target}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}
        >
          <span style={tiny}>{output.kind === 'url' ? '🌐' : output.kind === 'dir' ? '📁' : '📄'}</span>
          <span style={muted}>{output.label}</span>
          {output.kind === 'url' ? (
            <a
              href={output.target}
              target="_blank"
              rel="noreferrer noopener"
              style={{ fontSize: 10.5, color: 'var(--dsw-alias-text-link, #4a9eff)' }}
            >
              {output.target}
            </a>
          ) : (
            <>
              <code style={{ fontSize: 10, opacity: 0.85 }}>{output.target}</code>
              <button
                style={{ ...tiny, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
                onClick={() => copy(output.target)}
              >
                {copied === output.target ? '已复制' : '复制路径'}
              </button>
            </>
          )}
          {output.note ? <span style={{ ...tiny, opacity: 0.8 }}>· {output.note}</span> : null}
        </div>
      ))}
    </div>
  )
}
