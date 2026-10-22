/**
 * Status machine: the legality table, the reason/result requirements, and the
 * tiered-authorization split that lets the AI keep moving but never quietly
 * drop or block its own work.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyStatus,
  canTransition,
  nextStatuses,
  requestStatus,
  STATUSES,
} from '../src/model/status.ts'
import type { AtlasNode, NodeStatus } from '../src/model/types.ts'

const AT = 1_800_000_000_000

function node(status: NodeStatus, extra: Partial<AtlasNode> = {}): AtlasNode {
  return {
    id: 'n-1',
    kind: 'task',
    title: 'do the thing',
    status,
    origin: 'ai',
    history: [],
    createdAt: AT - 1000,
    updatedAt: AT - 1000,
    children: [],
    ...extra,
  }
}

/** The intended graph, written out independently of the implementation. */
const EXPECTED: Readonly<Record<NodeStatus, readonly NodeStatus[]>> = {
  pending: ['active', 'dropped'],
  active: ['pending', 'done', 'rework', 'blocked', 'dropped'],
  done: ['rework', 'dropped'],
  rework: ['active', 'blocked', 'dropped'],
  blocked: ['active', 'dropped'],
  // Almost terminal: the only way back is a deliberate restore, which needs a reason
  // and the user's confirmation.
  dropped: ['active'],
}

describe('transition table', () => {
  it('matches the intended graph for every ordered pair', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const expected = from !== to && EXPECTED[from].includes(to)
        assert.equal(canTransition(from, to), expected, `${from} -> ${to}`)
      }
    }
  })

  it('never lists a status as its own successor', () => {
    for (const status of STATUSES) {
      assert.equal(canTransition(status, status), false)
      assert.equal(nextStatuses(status).includes(status), false)
    }
  })

  it('reports reachable targets in presentation order', () => {
    assert.deepEqual(nextStatuses('active'), [
      'pending',
      'done',
      'rework',
      'blocked',
      'dropped',
    ])
  })

  it('treats done as non-terminal, so finished work can reopen', () => {
    assert.equal(canTransition('done', 'rework'), true)
    assert.equal(canTransition('done', 'active'), false)
  })

  it('lets a dropped node come back, and nothing else out of it', () => {
    // Restoring is the one way out, and it is deliberately narrow: a dropped node
    // cannot jump straight to done, or quietly slide back to pending.
    assert.deepEqual(nextStatuses('dropped'), ['active'])
    assert.equal(canTransition('dropped', 'active'), true)
    for (const to of STATUSES) {
      if (to !== 'active' && to !== 'dropped') {
        assert.equal(canTransition('dropped', to), false, `dropped → ${to} must stay illegal`)
      }
    }
  })

  it('makes a restore cost a reason and the user’s confirmation', () => {
    const dropped: AtlasNode = {
      ...node('dropped'),
      reason: '当初判断这个方向没必要',
    }
    const withoutReason = requestStatus(dropped, { to: 'active', by: 'ai', at: AT })
    assert.equal(withoutReason.ok, false)
    if (!withoutReason.ok) assert.equal(withoutReason.code, 'REASON_REQUIRED')

    const withReason = requestStatus(dropped, {
      to: 'active',
      by: 'ai',
      at: AT,
      reason: '用户改主意了，这个方向重新需要',
    })
    assert.equal(withReason.ok, true)
    if (withReason.ok) {
      assert.equal(withReason.kind, 'pending', 'the AI may propose, not apply')
      if (withReason.kind === 'pending') assert.equal(withReason.proposal.from, 'dropped')
    }

    const confirmed = requestStatus(dropped, {
      to: 'active',
      by: 'ai',
      at: AT,
      reason: '用户改主意了，这个方向重新需要',
      confirmedByUser: true,
    })
    assert.equal(confirmed.ok, true)
    if (confirmed.ok && confirmed.kind === 'applied') {
      assert.equal(confirmed.node.status, 'active')
      assert.equal(confirmed.node.reason, undefined, 'the old reason is not a live reason')
      assert.equal(
        confirmed.node.history.at(-1)?.reason,
        '用户改主意了，这个方向重新需要',
        'but why it came back is kept',
      )
    }
  })
})

describe('required text', () => {
  for (const to of ['rework', 'blocked', 'dropped'] as const) {
    it(`refuses '${to}' without a reason`, () => {
      const outcome = requestStatus(node('active'), {
        to,
        by: 'ai',
        at: AT,
        confirmedByUser: true,
      })
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(outcome.code, 'REASON_REQUIRED')
    })
  }

  it('refuses a reason that is only whitespace', () => {
    const outcome = requestStatus(node('active'), {
      to: 'rework',
      by: 'ai',
      at: AT,
      reason: '   ',
      confirmedByUser: true,
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'REASON_REQUIRED')
  })

  it("refuses 'done' without a result", () => {
    const outcome = requestStatus(node('active'), { to: 'done', by: 'ai', at: AT })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'RESULT_REQUIRED')
  })

  it("accepts 'done' with a result and needs no confirmation", () => {
    const outcome = requestStatus(node('active'), {
      to: 'done',
      by: 'ai',
      at: AT,
      result: 'shipped lib/index.js; verified by node --check',
    })
    assert.equal(outcome.ok, true)
    if (!outcome.ok || outcome.kind !== 'applied') return assert.fail('expected applied')
    assert.equal(outcome.node.status, 'done')
    assert.match(outcome.node.result ?? '', /shipped/)
  })
})

describe('tiered authorization', () => {
  for (const to of ['rework', 'blocked', 'dropped'] as const) {
    it(`parks '${to}' as pending until the user confirms`, () => {
      const before = node('active')
      const outcome = requestStatus(before, { to, by: 'ai', at: AT, reason: 'because' })
      assert.equal(outcome.ok, true)
      if (!outcome.ok || outcome.kind !== 'pending') {
        return assert.fail('expected pending')
      }
      // The node itself is untouched: nothing happened yet.
      assert.equal(outcome.node, before)
      assert.equal(outcome.node.status, 'active')
      assert.equal(outcome.node.history.length, 0)
      assert.equal(outcome.proposal.to, to)
      assert.equal(outcome.proposal.reason, 'because')
      assert.equal(outcome.proposal.from, 'active')
    })

    it(`applies '${to}' when the user confirmed`, () => {
      const outcome = requestStatus(node('active'), {
        to,
        by: 'ai',
        at: AT,
        reason: 'because',
        confirmedByUser: true,
      })
      if (!outcome.ok || outcome.kind !== 'applied') return assert.fail('expected applied')
      assert.equal(outcome.node.status, to)
      assert.equal(outcome.node.reason, 'because')
      const last = outcome.node.history.at(-1)
      assert.equal(last?.to, to)
      assert.equal(last?.reason, 'because')
      assert.equal(last?.confirmedBy, 'user')
    })
  }

  it("lets the AI move forward without confirmation", () => {
    for (const [from, to] of [
      ['pending', 'active'],
      ['active', 'pending'],
      ['rework', 'active'],
      ['blocked', 'active'],
    ] as const) {
      const outcome = requestStatus(node(from), { to, by: 'ai', at: AT })
      if (!outcome.ok || outcome.kind !== 'applied') {
        return assert.fail(`${from} -> ${to} should apply directly`)
      }
      assert.equal(outcome.node.status, to)
    }
  })
})

describe('applying a change', () => {
  it('is idempotent when the status already matches', () => {
    const before = node('active')
    const outcome = requestStatus(before, { to: 'active', by: 'ai', at: AT })
    if (!outcome.ok || outcome.kind !== 'applied') return assert.fail('expected applied')
    assert.equal(outcome.node, before, 'no new object, no history entry')
    assert.equal(outcome.node.history.length, 0)
  })

  it('refuses an illegal move instead of coercing it', () => {
    const outcome = requestStatus(node('pending'), {
      to: 'done',
      by: 'ai',
      at: AT,
      result: 'x',
    })
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'ILLEGAL_TRANSITION')
    assert.match(outcome.message, /pending/)
  })

  it('clears the reason when the node returns to active', () => {
    const reworked = applyStatus(node('active'), {
      to: 'rework',
      by: 'ai',
      at: AT,
      reason: 'panel width drag is broken',
      confirmedByUser: true,
    })
    assert.equal(reworked.reason, 'panel width drag is broken')
    const resumed = applyStatus(reworked, { to: 'active', by: 'ai', at: AT + 1 })
    assert.equal(resumed.reason, undefined)
    assert.equal(resumed.history.length, 2)
    // The earlier explanation survives in history, not on the node.
    assert.equal(resumed.history[0]?.reason, 'panel width drag is broken')
  })

  it('accumulates history and bumps updatedAt', () => {
    let current = node('pending')
    current = applyStatus(current, { to: 'active', by: 'ai', at: AT })
    current = applyStatus(current, {
      to: 'done',
      by: 'ai',
      at: AT + 5,
      result: 'ok',
    })
    assert.equal(current.history.length, 2)
    assert.deepEqual(
      current.history.map((h) => `${h.from}->${h.to}`),
      ['pending->active', 'active->done'],
    )
    assert.equal(current.updatedAt, AT + 5)
  })
})
