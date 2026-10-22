/**
 * The status machine.
 *
 * Three rules make this the plugin's core rather than a formality:
 *
 * 1. **`done` is not terminal.** `done → rework` is legal and is the single most
 *    important transition here: a finished module discovered to need
 *    optimisation must be expressible without pretending it was never done.
 * 2. **The three negative states require a reason.** A red icon with no text
 *    teaches the user nothing; the reason is the deliverable.
 * 3. **Those same three states require user confirmation** (tiered
 *    authorization), so the AI can keep progress moving but can never quietly
 *    drop or block its own work.
 */
import type {
  Actor,
  AtlasNode,
  NodeStatus,
  PendingConfirmation,
  StatusChange,
} from './types.ts'

/** Every status, in presentation order. */
export const STATUSES: readonly NodeStatus[] = [
  'pending',
  'active',
  'done',
  'rework',
  'blocked',
  'dropped',
]

/**
 * Legal transitions, keyed by the current status.
 *
 * `dropped` is almost terminal: the only way out is a deliberate restore, which needs
 * both a written reason and the user's confirmation (see {@link requiresRestore}). The
 * alternative — delete-and-recreate — throws away the history of why the node existed,
 * which is the one thing the tree is for.
 */
const TRANSITIONS: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  pending: ['active', 'dropped'],
  active: ['pending', 'done', 'rework', 'blocked', 'dropped'],
  done: ['rework', 'dropped'],
  rework: ['active', 'blocked', 'dropped'],
  blocked: ['active', 'dropped'],
  dropped: ['active'],
}

/** A restore is the transition out of `dropped`, which is always exceptional. */
function requiresRestore(from: NodeStatus): boolean {
  return from === 'dropped'
}

/**
 * Does this change need a written reason?
 *
 * Entering a negative status does. So does *leaving* `dropped`: the useful record is
 * not "it is active again" but "why we changed our mind".
 * @param from - current status.
 * @param to - target status.
 * @returns whether a reason is mandatory.
 */
export function requiresReasonFor(from: NodeStatus, to: NodeStatus): boolean {
  return REASON_REQUIRED.includes(to) || requiresRestore(from)
}

/**
 * Does this change need the user's explicit confirmation?
 * @param from - current status.
 * @param to - target status.
 * @returns whether the AI may not do it alone.
 */
export function requiresConfirmationFor(from: NodeStatus, to: NodeStatus): boolean {
  return CONFIRMATION_REQUIRED.includes(to) || requiresRestore(from)
}


/** Statuses that cannot be entered without a written reason. */
export const REASON_REQUIRED: readonly NodeStatus[] = [
  'rework',
  'blocked',
  'dropped',
]

/** Statuses that cannot be entered on the AI's own authority. */
export const CONFIRMATION_REQUIRED: readonly NodeStatus[] = [
  'rework',
  'blocked',
  'dropped',
]

/** Why a proposed change was refused. */
export type StatusErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'REASON_REQUIRED'
  | 'RESULT_REQUIRED'

/** One request to move a node to `to`. */
export interface StatusChangeInput {
  readonly to: NodeStatus
  readonly by: Actor
  /** Epoch milliseconds; injected so the call stays pure and testable. */
  readonly at: number
  readonly reason?: string
  readonly result?: string
  /** The user pressed confirm for this exact proposal. */
  readonly confirmedByUser?: boolean
}

/** A refusal, with a code a tool result can surface verbatim. */
export interface StatusRejection {
  readonly ok: false
  readonly code: StatusErrorCode
  readonly message: string
}

/**
 * Outcome of a status request.
 *
 * `pending` is not a failure: the AI proposed something it is not allowed to
 * decide alone, and the change waits for the user. The tool call still succeeds,
 * so the model's turn is never blocked on a human.
 */
export type StatusOutcome =
  | { readonly ok: true; readonly kind: 'applied'; readonly node: AtlasNode }
  | {
      readonly ok: true
      readonly kind: 'pending'
      readonly node: AtlasNode
      readonly proposal: Omit<PendingConfirmation, 'id'>
    }
  | StatusRejection

/**
 * Whether `from → to` is a legal move.
 * @param from - current status.
 * @param to - requested status.
 * @returns whether the edge exists in the machine.
 */
export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/**
 * Every status reachable from `from` in one step.
 * @param from - current status.
 * @returns the legal targets, in {@link STATUSES} order.
 */
export function nextStatuses(from: NodeStatus): readonly NodeStatus[] {
  return STATUSES.filter((to) => canTransition(from, to))
}

/**
 * Whether a node currently has enough recorded information for `to`.
 * @param to - target status.
 * @param result - proposed result text.
 * @returns whether `done` would be satisfied.
 */
export function satisfiesResult(to: NodeStatus, result: string | undefined): boolean {
  return to !== 'done' || Boolean(result && result.trim().length > 0)
}

/**
 * Build the node after an accepted status change.
 *
 * `reason` is kept only while the node sits in a reason-bearing status and
 * `returnCondition` only while blocked; earlier explanations are not lost —
 * they remain in `history`, which is what the panel's "why" view reads.
 * @param node - node before the change.
 * @param input - the accepted change.
 * @returns a new node; the input node is untouched.
 */
export function applyStatus(node: AtlasNode, input: StatusChangeInput): AtlasNode {
  const { to, by, at, reason, result } = input
  // Two different questions, deliberately answered separately:
  //  - does the *history entry* need to carry a reason? (a restore does — otherwise the
  //    record of why we changed our mind is lost);
  //  - does the *node* stay in a reason-bearing status? (only negative statuses do; a
  //    restored node is `active`, which carries no live reason).
  const reasonRecorded = requiresReasonFor(node.status, to)
  const liveReason = REASON_REQUIRED.includes(to)
  const change: StatusChange = {
    at,
    by,
    from: node.status,
    to,
    ...(reasonRecorded && reason ? { reason } : {}),
    ...(requiresConfirmationFor(node.status, to) && input.confirmedByUser
      ? { confirmedBy: 'user' as Actor }
      : {}),
  }
  return {
    ...node,
    status: to,
    reason: liveReason ? reason : undefined,
    returnCondition: to === 'blocked' ? node.returnCondition : undefined,
    ...(to === 'done' ? { result } : {}),
    history: [...node.history, change],
    updatedAt: at,
  }
}

/**
 * Validate and classify one status request without mutating anything.
 *
 * Order matters: legality, then the required text, then authorization. Asking a
 * user to confirm a transition that is illegal anyway would be noise.
 * @param node - node being changed.
 * @param input - the request.
 * @returns the outcome; only `applied` carries a new node.
 */
export function requestStatus(node: AtlasNode, input: StatusChangeInput): StatusOutcome {
  const { to, by, at, reason, result } = input

  // Idempotent re-assertion: no history entry, no updatedAt bump.
  if (to === node.status) {
    return { ok: true, kind: 'applied', node }
  }

  if (!canTransition(node.status, to)) {
    const allowed = nextStatuses(node.status)
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message: `cannot move ${node.id} from '${node.status}' to '${to}'${
        allowed.length ? `; legal targets: ${allowed.join(', ')}` : '; it is terminal'
      }`,
    }
  }

  if (requiresReasonFor(node.status, to) && !(reason && reason.trim().length > 0)) {
    return {
      ok: false,
      code: 'REASON_REQUIRED',
      message: `'${to}' requires a reason: say what needs doing and why, in the user's terms`,
    }
  }

  if (!satisfiesResult(to, result)) {
    return {
      ok: false,
      code: 'RESULT_REQUIRED',
      message: `'done' requires a result: what was produced, and how it is accepted`,
    }
  }

  if (requiresConfirmationFor(node.status, to) && input.confirmedByUser !== true) {
    return {
      ok: true,
      kind: 'pending',
      node,
      proposal: {
        nodeId: node.id,
        from: node.status,
        to,
        ...(reason ? { reason } : {}),
        ...(result ? { result } : {}),
        proposedBy: by,
        at,
      },
    }
  }

  return { ok: true, kind: 'applied', node: applyStatus(node, input) }
}

/**
 * Render a proposal as the record stored in the document's pending queue.
 * @param proposal - the proposal from {@link requestStatus}.
 * @param id - caller-generated confirmation id.
 * @returns the storable pending confirmation.
 */
export function toPendingConfirmation(
  proposal: Omit<PendingConfirmation, 'id'>,
  id: string,
): PendingConfirmation {
  return { ...proposal, id }
}

/**
 * Whether a node is finished in the sense that matters for counting progress:
 * a leaf that is `done` and not since reopened.
 * @param status - node status.
 * @returns whether the status counts as delivered.
 */
export function isDelivered(status: NodeStatus): boolean {
  return status === 'done'
}

/**
 * Whether the node needs the user's attention (something is wrong or waiting).
 * @param status - node status.
 * @returns whether the panel should mark it.
 */
export function needsAttention(status: NodeStatus): boolean {
  return status === 'rework' || status === 'blocked'
}
