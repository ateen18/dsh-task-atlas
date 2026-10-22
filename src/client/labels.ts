/**
 * Presentation vocabulary shared by both views.
 *
 * Kept in one place so the tree and the map can never disagree about what a
 * status looks like — a node that is amber in one view and grey in the other
 * reads as two different states.
 */
import type { NodeStatus } from '../model/types.ts'

/** Checklist mark, mirroring the Markdown mirror. */
export const STATUS_GLYPH: Readonly<Record<NodeStatus, string>> = {
  pending: ' ',
  active: '~',
  done: 'x',
  rework: '!',
  blocked: '!',
  dropped: '-',
}

/** Short Chinese label. */
export const STATUS_LABEL: Readonly<Record<NodeStatus, string>> = {
  pending: '未开始',
  active: '进行中',
  done: '已完成',
  rework: '需返工',
  blocked: '阻塞',
  dropped: '已废弃',
}

/**
 * Accent colour per status, expressed with theme tokens and a literal fallback.
 * `dropped` is intentionally low-contrast: abandoned work should recede.
 */
export const STATUS_COLOR: Readonly<Record<NodeStatus, string>> = {
  pending: 'var(--dsw-alias-text-tertiary, #8b949e)',
  active: 'var(--dsw-alias-accent, #2f81f7)',
  done: 'var(--dsw-alias-success, #3fb950)',
  rework: 'var(--dsw-alias-warning, #d29922)',
  blocked: 'var(--dsw-alias-danger, #f85149)',
  dropped: 'var(--dsw-alias-text-tertiary, #6e7681)',
}

/** Whether a status should pull the user's eye. */
export function isAttention(status: NodeStatus): boolean {
  return status === 'rework' || status === 'blocked'
}

/**
 * Background wash behind a status pill.
 *
 * Every row carries a pill, not just the interesting ones: if "未开始" is invisible
 * and "需返工" is not, the panel answers "anything wrong?" but not "what is the
 * state of this module" — and the second question is the one asked more often.
 */
export const STATUS_TINT: Readonly<Record<NodeStatus, string>> = {
  pending: 'var(--dsw-alias-surface-sunken, rgba(128,128,128,0.16))',
  active: 'rgba(47,129,247,0.16)',
  done: 'rgba(63,185,80,0.18)',
  rework: 'rgba(210,153,34,0.22)',
  blocked: 'rgba(248,81,73,0.18)',
  dropped: 'rgba(128,128,128,0.10)',
}
