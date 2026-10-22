/**
 * Drift nudging.
 *
 * The value of this feature is entirely in its restraint: it fires once per silent
 * streak, it says "ignore this if you are on plan", and it counts something concrete
 * (steps since an atlas call) rather than guessing relevance. What must be tested is
 * therefore mostly the restraint, not the detection.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildNudge, DRIFT_STEP_THRESHOLD, DriftTracker } from '../src/drift.ts'

describe('drift tracker', () => {
  it('stays quiet below the threshold', () => {
    const tracker = new DriftTracker()
    for (let step = 1; step < DRIFT_STEP_THRESHOLD; step += 1) {
      assert.equal(tracker.noteStep('s'), false, `step ${step} must not nudge`)
    }
  })

  it('nudges at the threshold, and only once', () => {
    const tracker = new DriftTracker()
    for (let step = 1; step < DRIFT_STEP_THRESHOLD; step += 1) tracker.noteStep('s')
    assert.equal(tracker.noteStep('s'), true)
    assert.equal(tracker.noteStep('s'), false, 'the same streak is not nudged twice')
    assert.equal(tracker.noteStep('s'), false)
  })

  it('goes quiet again as soon as the plan is touched', () => {
    const tracker = new DriftTracker()
    for (let step = 0; step < DRIFT_STEP_THRESHOLD + 5; step += 1) tracker.noteStep('s')
    tracker.noteActivity('s')
    assert.equal(tracker.stepsOf('s'), 0)
    // A fresh streak can nudge again, which is the point of resetting.
    for (let step = 1; step < DRIFT_STEP_THRESHOLD; step += 1) tracker.noteStep('s')
    assert.equal(tracker.noteStep('s'), true)
  })

  it('keeps sessions independent', () => {
    const tracker = new DriftTracker()
    tracker.noteActivity('a')
    for (let step = 0; step < DRIFT_STEP_THRESHOLD; step += 1) tracker.noteStep('b')
    assert.equal(tracker.stepsOf('a'), 0, 'activity in one session does not leak')
    assert.equal(tracker.stepsOf('b'), DRIFT_STEP_THRESHOLD)
  })
})

describe('the nudge text', () => {
  it('offers both plausible answers, including doing nothing', () => {
    const text = buildNudge(DRIFT_STEP_THRESHOLD)
    assert.match(text, /忽略这条/, 'being on plan must be an acceptable answer')
    assert.match(text, /atlas_branch_create/, 'off-plan work has a place to go')
    assert.match(text, /20 步/)
  })

  it('stays short', () => {
    assert.ok(buildNudge(DRIFT_STEP_THRESHOLD).length < 200)
  })
})
