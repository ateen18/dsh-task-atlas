/**
 * Progress view: the project as a moving thing rather than as a structure.
 *
 * The tree answers "what is this made of". This answers "how far along is it, and
 * what changed lately" — a different question, and mixing the two is what makes a
 * map read like a roadmap. Everything here is derived from the same stored tree,
 * so there is nothing extra to keep in sync.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { collectNodes, progressOf } from '../model/tree.ts'
import type { AtlasNode, AtlasProject } from '../model/types.ts'
import { STATUS_COLOR, STATUS_LABEL, STATUS_TINT } from './labels.ts'

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 2px',
  fontSize: 12,
  lineHeight: '18px',
}

const name: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'normal',
  wordBreak: 'break-word',
}

const bar: CSSProperties = {
  width: 64,
  height: 4,
  borderRadius: 2,
  background: 'var(--dsw-alias-surface-sunken, rgba(128,128,128,0.22))',
  overflow: 'hidden',
  flexShrink: 0,
}

const meta: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--dsw-alias-text-tertiary, #8b949e)',
  flexShrink: 0,
}

function pillStyle(status: AtlasNode['status']): CSSProperties {
  return {
    flexShrink: 0,
    fontSize: 10.5,
    lineHeight: '15px',
    padding: '1px 6px',
    borderRadius: 4,
    color: STATUS_COLOR[status],
    background: STATUS_TINT[status],
    fontWeight: 500,
  }
}

function time(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Props for {@link ProgressView}. */
export interface ProgressViewProps {
  readonly project: AtlasProject
  readonly onSelect: (id: string) => void
}

/** One history entry, flattened with the node it belongs to. */
interface TimelineEntry {
  readonly nodeId: string
  readonly nodeTitle: string
  readonly at: number
  readonly from: AtlasNode['status']
  readonly to: AtlasNode['status']
  readonly reason?: string
  readonly by: 'ai' | 'user'
  readonly confirmed: boolean
}

/**
 * Render per-module progress plus a change timeline.
 * @param props - project and selection callback.
 * @returns the view.
 */
export function ProgressView(props: ProgressViewProps) {
  const { project, onSelect } = props
  const [showAll, setShowAll] = useState(false)

  const modules = project.root.children
  const all = collectNodes(project.root)
  const timeline: TimelineEntry[] = []
  for (const node of all) {
    if (node.kind === 'project') continue
    for (const change of node.history) {
      timeline.push({
        nodeId: node.id,
        nodeTitle: node.title,
        at: change.at,
        from: change.from,
        to: change.to,
        ...(change.reason ? { reason: change.reason } : {}),
        by: change.by,
        confirmed: change.confirmedBy === 'user',
      })
    }
  }
  timeline.sort((a, b) => b.at - a.at)
  const shown = showAll ? timeline : timeline.slice(0, 12)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>各模块进度</div>
        {modules.length === 0 ? (
          <div style={meta}>还没有模块。</div>
        ) : (
          modules.map((module) => {
            const progress = progressOf(module)
            const percent = Math.round(progress.completion * 100)
            return (
              <div
                key={module.id}
                style={{ ...row, cursor: 'pointer' }}
                onClick={() => onSelect(module.id)}
              >
                <span style={name}>{module.title}</span>
                <span style={pillStyle(module.status)}>{STATUS_LABEL[module.status]}</span>
                <span style={bar}>
                  <span
                    style={{
                      display: 'block',
                      width: `${percent}%`,
                      height: '100%',
                      background: STATUS_COLOR[module.status],
                    }}
                  />
                </span>
                <span style={meta}>
                  {percent}% · {progress.done}/{progress.countable}
                </span>
              </div>
            )
          })
        )}
        <div style={meta}>
          完成度只统计叶子节点；被废弃的节点不计入分子分母，所以计划变动不会让百分比倒退。
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>变更时间线</span>
          {timeline.length > 12 ? (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              style={{
                font: 'inherit',
                fontSize: 10.5,
                padding: '0 6px',
                borderRadius: 4,
                border: '1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,0.35))',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              {showAll ? '只看最近 12 条' : `看全部 ${timeline.length} 条`}
            </button>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <div style={meta}>还没有任何状态变更。节点一开始都是「未开始」。</div>
        ) : (
          shown.map((entry, index) => (
            <div
              key={`${entry.nodeId}:${entry.at}:${index}`}
              style={{ ...row, alignItems: 'flex-start', cursor: 'pointer' }}
              onClick={() => onSelect(entry.nodeId)}
            >
              <span style={{ ...meta, width: 88 }}>{time(entry.at)}</span>
              <span style={name}>
                {entry.nodeTitle}
                <span style={{ color: STATUS_COLOR[entry.to] }}>
                  {' '}
                  {STATUS_LABEL[entry.from]} → {STATUS_LABEL[entry.to]}
                </span>
                {entry.reason ? (
                  <span style={meta}> —— {entry.reason}</span>
                ) : null}
                {entry.confirmed ? <span style={meta}>（你确认）</span> : null}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
