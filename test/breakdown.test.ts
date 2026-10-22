/**
 * Breakdown validation and amendment: the kickoff bar, the promise that both
 * interview modes produce the same shape, and the revision log that makes the
 * breakdown a living document rather than a stale one.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  amendBreakdown,
  BREAKDOWN_QUESTIONS,
  confirmBreakdown,
  interviewFor,
  REQUIRED_BREAKDOWN_FIELDS,
  validateBreakdown,
} from '../src/model/breakdown.ts'
import type { Breakdown } from '../src/model/types.ts'

const AT = 1_800_000_000_000

function draft(overrides: Partial<Omit<Breakdown, 'confirmedAt'>> = {}) {
  return {
    coreIntent: 'stop the user losing the plot in long sessions',
    deliverables: [
      { text: 'a right-sidebar task tree', acceptance: 'tab appears after restart' },
    ],
    decomposition: ['1 wire the sidebar', '2 breakdown', '3 status', '4 branches'],
    acceptance: 'four statuses round-trip and survive a refresh',
    outOfScope: ['context folding'],
    constraints: ['DSH 0.2.0-rc.2'],
    priorityOrder: ['1', '2', '3', '4'],
    mode: 'fast' as const,
    ...overrides,
  }
}

describe('interview shape', () => {
  it('asks seven dimensions in the detailed mode', () => {
    assert.equal(interviewFor('detailed').length, 7)
    assert.equal(BREAKDOWN_QUESTIONS.length, 7)
    assert.deepEqual(
      BREAKDOWN_QUESTIONS.map((q) => q.order),
      [1, 2, 3, 4, 5, 6, 7],
    )
  })

  it('asks only the blocking dimensions in the fast mode', () => {
    const fast = interviewFor('fast')
    assert.equal(fast.length, 4)
    assert.deepEqual(
      fast.map((q) => q.field),
      ['coreIntent', 'deliverables', 'decomposition', 'acceptance'],
    )
  })

  it('names the same required fields either way', () => {
    assert.deepEqual(REQUIRED_BREAKDOWN_FIELDS, [
      'coreIntent',
      'deliverables',
      'decomposition',
      'acceptance',
    ])
  })

  it('keeps optional dimensions out of the blocking set', () => {
    const optional = BREAKDOWN_QUESTIONS.filter((q) => !q.required).map((q) => q.field)
    assert.deepEqual(optional, ['outOfScope', 'constraints', 'priorityOrder'])
  })
})

describe('validation', () => {
  it('passes a complete breakdown', () => {
    const result = validateBreakdown(draft())
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.warnings, [])
  })

  it('blocks on every required blank', () => {
    const result = validateBreakdown(
      draft({ coreIntent: '  ', deliverables: [], decomposition: [], acceptance: '' }),
    )
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [
      'coreIntent',
      'deliverables',
      'decomposition',
      'acceptance',
    ])
  })

  it('warns instead of blocking when a deliverable has no acceptance test', () => {
    const result = validateBreakdown(
      draft({ deliverables: [{ text: 'a task tree', acceptance: '  ' }] }),
    )
    assert.equal(result.ok, true, 'the user can still get started')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /no acceptance test/)
  })

  it('blocks on a deliverable with no text at all', () => {
    const result = validateBreakdown(draft({ deliverables: [{ text: ' ', acceptance: 'x' }] }))
    assert.equal(result.ok, false)
    assert.ok(result.missing.includes('deliverables[0].text'))
  })

  it('warns on a blank decomposition step without blocking', () => {
    const result = validateBreakdown(draft({ decomposition: ['1', '  ', '3'] }))
    assert.equal(result.ok, true)
    assert.match(result.warnings.join('\n'), /decomposition\[1\] is blank/)
  })

  it('lets the optional dimensions be empty', () => {
    const result = validateBreakdown(
      draft({ outOfScope: [], constraints: [], priorityOrder: [] }),
    )
    assert.equal(result.ok, true)
  })
})

describe('confirmation', () => {
  it('stamps the confirmation time', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    assert.equal(breakdown.confirmedAt, AT)
    assert.equal(breakdown.mode, 'fast')
  })

  it('refuses to stamp an incomplete breakdown', () => {
    assert.throws(
      () => confirmBreakdown(draft({ coreIntent: '' }), AT),
      /breakdown is incomplete.*coreIntent/,
    )
  })
})

describe('amendment', () => {
  const meta = { at: AT + 100, by: 'ai' as const, reason: '对齐后发现只覆盖了用户侧' }

  it('records what changed and why', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    const outcome = amendBreakdown(
      breakdown,
      { coreIntent: '同时兜住人和 AI 的注意力' },
      meta,
    )
    assert.equal(outcome.breakdown.coreIntent, '同时兜住人和 AI 的注意力')
    assert.equal(outcome.changes.length, 1)
    assert.equal(outcome.changes[0]?.field, 'coreIntent')
    assert.match(outcome.changes[0]?.from ?? '', /stop the user losing the plot/)
    assert.equal(outcome.breakdown.revisions?.length, 1)
    assert.equal(outcome.breakdown.revisions?.[0]?.reason, meta.reason)
    assert.equal(outcome.breakdown.confirmedAt, AT, 'the original confirmation is preserved')
  })

  it('accumulates revisions instead of replacing them', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    const once = amendBreakdown(breakdown, { coreIntent: '第二版' }, meta)
    const twice = amendBreakdown(
      once.breakdown,
      { acceptance: '第三版的验收' },
      { ...meta, at: AT + 200, reason: '验收标准太含糊' },
    )
    assert.equal(twice.breakdown.revisions?.length, 2)
    assert.equal(twice.breakdown.revisions?.[1]?.reason, '验收标准太含糊')
    assert.equal(twice.breakdown.coreIntent, '第二版', 'earlier amendments survive')
  })

  it('requires a reason', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    assert.throws(
      () => amendBreakdown(breakdown, { coreIntent: 'x' }, { ...meta, reason: '   ' }),
      /requires a reason/,
    )
  })

  it('is a no-op when nothing actually changes', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    const outcome = amendBreakdown(breakdown, { coreIntent: breakdown.coreIntent }, meta)
    assert.equal(outcome.breakdown, breakdown, 'same object, no revision')
    assert.deepEqual(outcome.changes, [])
  })

  it('refuses an amendment that would leave the breakdown incomplete', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    assert.throws(
      () => amendBreakdown(breakdown, { coreIntent: '  ' }, meta),
      /amended breakdown is incomplete/,
    )
  })

  it('refuses fields that are not editable', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    assert.throws(
      () =>
        amendBreakdown(
          breakdown,
          { confirmedAt: 1 } as unknown as Parameters<typeof amendBreakdown>[1],
          meta,
        ),
      /not an editable breakdown field/,
    )
  })

  it('warns when the decomposition disagrees with the tree', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    const outcome = amendBreakdown(
      breakdown,
      { decomposition: ['用户面', 'AI 面', '共享底座'] },
      meta,
      ['打通右侧栏与数据模型', '启动拆解'],
    )
    const warnings = outcome.warnings.join('\n')
    assert.match(warnings, /拆解有但树里没有/)
    assert.match(warnings, /树里有但拆解没写/)
  })

  it('stays quiet when the decomposition matches the tree', () => {
    const breakdown = confirmBreakdown(draft(), AT)
    const outcome = amendBreakdown(
      breakdown,
      { decomposition: ['用户面', 'AI 面'] },
      meta,
      ['用户面', 'AI 面'],
    )
    assert.doesNotMatch(outcome.warnings.join('\n'), /不一致/)
  })
})
