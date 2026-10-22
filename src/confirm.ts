/**
 * Applying a queued status change.
 *
 * Shared by the `atlas_confirm` tool (the user said "yes" in the conversation)
 * and the panel's POST route (the user clicked confirm). One implementation means
 * the two authority paths cannot drift.
 */
import { requestStatus } from './model/status.ts'
import { findNode, replaceNode } from './model/tree.ts'
import {
  selectProject,
  takePending,
  withProject,
  type AtlasStore,
} from './store/document.ts'

/** Result of applying one confirmation; the same shape tools return. */
export interface ConfirmOutcome {
  readonly ok: boolean
  readonly summary: string
  readonly code?: string
}

const LABEL: Readonly<Record<string, string>> = {
  pending: '未开始',
  active: '进行中',
  done: '已完成',
  rework: '需返工',
  blocked: '阻塞',
  dropped: '已废弃',
}

/**
 * Apply one queued status change.
 * @param store - persistence seam.
 * @param workspaceKey - workspace whose document holds the queue.
 * @param confirmationId - the queued proposal's id.
 * @param at - epoch milliseconds.
 * @returns whether it applied, and a human-readable summary either way.
 */
export async function applyConfirmation(
  store: AtlasStore,
  workspaceKey: string,
  confirmationId: string,
  at: number,
): Promise<ConfirmOutcome> {
  let outcome: ConfirmOutcome = {
    ok: false,
    code: 'INTERNAL',
    summary: 'confirmation produced no result',
  }

  await store.update(workspaceKey, (doc) => {
    const taken = takePending(doc, confirmationId)
    if (!taken.confirmation) {
      outcome = {
        ok: false,
        code: 'NO_SUCH_CONFIRMATION',
        summary: `没有这条待确认：${confirmationId}`,
      }
      return doc
    }
    const confirmation = taken.confirmation
    const project = selectProject(taken.doc)
    if (!project) {
      outcome = { ok: false, code: 'NO_PROJECT', summary: '这个工作区还没有项目。' }
      return taken.doc
    }
    const node = findNode(project.root, confirmation.nodeId)
    if (!node) {
      outcome = {
        ok: false,
        code: 'NO_SUCH_NODE',
        summary: `节点已不存在：${confirmation.nodeId}`,
      }
      return taken.doc
    }
    const decision = requestStatus(node, {
      to: confirmation.to,
      by: 'ai',
      at,
      ...(confirmation.reason ? { reason: confirmation.reason } : {}),
      confirmedByUser: true,
    })
    if (!decision.ok || decision.kind !== 'applied') {
      outcome = {
        ok: false,
        code: 'CONFIRM_FAILED',
        summary: decision.ok ? '确认未能应用' : `${decision.code}: ${decision.message}`,
      }
      return taken.doc
    }
    outcome = {
      ok: true,
      summary:
        `已应用确认：「${node.title}」(${confirmation.nodeId}) → ` +
        `${LABEL[confirmation.to] ?? confirmation.to}` +
        `${confirmation.reason ? `：${confirmation.reason}` : ''}。`,
    }
    return withProject(
      taken.doc,
      project.id,
      (current) => ({
        ...current,
        root: replaceNode(current.root, confirmation.nodeId, decision.node),
      }),
      at,
    )
  })

  return outcome
}
