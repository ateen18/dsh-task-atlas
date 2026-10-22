/** Kickoff verdict: does this workspace have prior work to reconstruct from? */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cwdOfSession,
  isSubstantialSession,
  MAX_REPORTED_PRIOR_SESSIONS,
  normalisePath,
  summariseSessionRichness,
  summariseWorkspaceHistory,
  SUBSTANTIAL_USER_MESSAGES,
  withCurrentSession,
} from '../src/workspace-history.ts'

const AT = 1_800_000_000_000

function record(id: string, cwd: string | undefined, createdAt: number) {
  return { header: { id, ...(cwd ? { cwd } : {}), createdAt } }
}

/** A delegation child of another session, which must never count as history. */
function subagentRecord(id: string, cwd: string, createdAt: number, parentSession: string) {
  return {
    header: { id, cwd, createdAt, origin: 'subagent' as const, parentSession },
  }
}

describe('path normalisation', () => {  it('ignores separators, casing and trailing slashes', () => {
    assert.equal(normalisePath('D:\\Coding\\Demo\\'), normalisePath('d:/coding/demo'))
  })
})

describe('session richness', () => {
  it('counts user messages and turns', () => {
    const richness = summariseSessionRichness([
      { type: 'user/message' },
      { type: 'turn/start' },
      { type: 'assistant/message' },
      { type: 'user/message' },
      { type: 'turn/start' },
      { type: 'tool/call' },
    ])
    assert.deepEqual(richness, { userMessages: 2, turns: 2, events: 6 })
  })

  it('needs at least three user messages to count as prior work', () => {
    assert.equal(SUBSTANTIAL_USER_MESSAGES, 3)
    assert.equal(isSubstantialSession(undefined), false)
    assert.equal(isSubstantialSession({ userMessages: 2, turns: 2, events: 99 }), false)
    assert.equal(isSubstantialSession({ userMessages: 3, turns: 3, events: 9 }), true)
  })
})

describe('folding the current session in', () => {
  const blank = summariseWorkspaceHistory([], { workspacePath: 'D:\\proj' })

  it('leaves a short session as a blank workspace', () => {
    const verdict = withCurrentSession(blank, { userMessages: 1, turns: 1, events: 4 })
    assert.equal(verdict.hasHistory, false)
    assert.deepEqual(verdict.reasons, [])
    assert.ok(verdict.currentSession, 'the counts are still reported')
  })

  it('promotes a long current session to prior work', () => {
    const verdict = withCurrentSession(blank, { userMessages: 5, turns: 5, events: 42 })
    assert.equal(verdict.hasHistory, true)
    assert.deepEqual(verdict.reasons, ['current-session'])
  })

  it('keeps both reasons when other conversations exist too', () => {
    const withPrior = summariseWorkspaceHistory([record('older', 'D:\\proj', AT)], {
      workspacePath: 'D:\\proj',
    })
    const verdict = withCurrentSession(withPrior, { userMessages: 4, turns: 4, events: 20 })
    assert.deepEqual(verdict.reasons, ['prior-sessions', 'current-session'])
    assert.equal(verdict.hasHistory, true)
  })
})

describe('workspace history verdict', () => {
  it('reports a blank workspace', () => {
    const verdict = summariseWorkspaceHistory([], { workspacePath: 'D:\\proj' })
    assert.equal(verdict.priorSessionCount, 0)
    assert.equal(verdict.hasHistory, false)
    assert.deepEqual(verdict.priorSessions, [])
    assert.equal(verdict.latestCreatedAt, undefined)
  })

  it('counts only sessions of the same workspace', () => {
    const verdict = summariseWorkspaceHistory(
      [
        record('s1', 'D:\\proj', AT - 3000),
        record('s2', 'D:\\proj\\', AT - 2000),
        record('other', 'D:\\elsewhere', AT - 1000),
      ],
      { workspacePath: 'd:/proj' },
    )
    assert.equal(verdict.priorSessionCount, 2)
    assert.equal(verdict.hasHistory, true)
    assert.deepEqual(
      verdict.priorSessions.map((s) => s.id),
      ['s2', 's1'],
      'newest first',
    )
    assert.equal(verdict.latestCreatedAt, AT - 2000)
  })

  it('excludes the current session, so its own turns never look like history', () => {
    const verdict = summariseWorkspaceHistory(
      [record('current', 'D:\\proj', AT), record('older', 'D:\\proj', AT - 5000)],
      { workspacePath: 'D:\\proj', currentSessionId: 'current' },
    )
    assert.equal(verdict.priorSessionCount, 1)
    assert.deepEqual(
      verdict.priorSessions.map((s) => s.id),
      ['older'],
    )
  })

  it('treats a workspace whose only session is the current one as blank', () => {
    const verdict = summariseWorkspaceHistory([record('current', 'D:\\proj', AT)], {
      workspacePath: 'D:\\proj',
      currentSessionId: 'current',
    })
    assert.equal(verdict.hasHistory, false)
  })

  it('ignores sessions with no recorded cwd', () => {
    const verdict = summariseWorkspaceHistory([record('s1', undefined, AT)], {
      workspacePath: 'D:\\proj',
    })
    assert.equal(verdict.hasHistory, false)
  })

  it('ignores subagent sessions, which are internal delegation not prior work', () => {
    const verdict = summariseWorkspaceHistory(
      [subagentRecord('child', 'D:\\proj', AT, 'current'), record('current', 'D:\\proj', AT - 1)],
      { workspacePath: 'D:\\proj', currentSessionId: 'current' },
    )
    assert.equal(verdict.priorSessionCount, 0, 'a subagent call must not invent a history')
    assert.equal(verdict.hasHistory, false)
  })

  it('ignores a fork of the current session', () => {
    const verdict = summariseWorkspaceHistory(
      [
        { header: { id: 'fork', cwd: 'D:\\proj', createdAt: AT, parentSession: 'current' } },
        record('current', 'D:\\proj', AT - 1),
      ],
      { workspacePath: 'D:\\proj', currentSessionId: 'current' },
    )
    assert.equal(verdict.hasHistory, false)
  })

  it('still counts a genuine earlier conversation', () => {
    const verdict = summariseWorkspaceHistory(
      [
        subagentRecord('child', 'D:\\proj', AT, 'current'),
        record('earlier', 'D:\\proj', AT - 100_000),
        record('current', 'D:\\proj', AT - 1),
      ],
      { workspacePath: 'D:\\proj', currentSessionId: 'current' },
    )
    assert.equal(verdict.priorSessionCount, 1)
    assert.deepEqual(
      verdict.priorSessions.map((s) => s.id),
      ['earlier'],
    )
  })

  it('caps how many prior sessions it reports', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      record(`s${index}`, 'D:\\proj', AT - index * 1000),
    )
    const verdict = summariseWorkspaceHistory(many, { workspacePath: 'D:\\proj' })
    assert.equal(verdict.priorSessionCount, 30, 'the count is honest')
    assert.equal(verdict.priorSessions.length, MAX_REPORTED_PRIOR_SESSIONS)
    assert.equal(verdict.priorSessions[0]?.id, 's0', 'newest kept')
  })
})

describe('session to workspace lookup', () => {
  it('finds the cwd of a known session', () => {
    const records = [record('a', 'D:\\one', AT), record('b', 'D:\\two', AT)]
    assert.equal(cwdOfSession(records, 'b'), 'D:\\two')
  })

  it('returns undefined for an unknown session or a cwd-less header', () => {
    assert.equal(cwdOfSession([record('a', 'D:\\one', AT)], 'zzz'), undefined)
    assert.equal(cwdOfSession([record('a', undefined, AT)], 'a'), undefined)
  })
})
