/**
 * Dependency graph math: cycle detection, layering, and neighbour lookup.
 *
 * These are the rules that keep the graph readable — every arrow must point right,
 * and nothing may wait on itself.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  checkDependencies,
  findCycle,
} from '../src/model/dependency.ts'

describe('cycle detection', () => {
  it('accepts an acyclic chain', () => {
    const nodes = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }]
    assert.equal(findCycle(nodes), undefined)
  })

  it('finds a direct two-node cycle', () => {
    const nodes = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]
    const cycle = findCycle(nodes)
    assert.ok(cycle, 'a cycle must be reported')
    assert.equal(cycle?.[0], cycle?.[cycle.length - 1], 'the path closes on itself')
  })

  it('finds a longer cycle', () => {
    const nodes = [
      { id: 'a', dependsOn: ['c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]
    assert.ok(findCycle(nodes))
  })

  it('ignores dependencies on nodes outside the graph', () => {
    // An edge with nowhere to land is a layout concern, not a cycle.
    const nodes = [{ id: 'a', dependsOn: ['ghost'] }]
    assert.equal(findCycle(nodes), undefined)
  })
})

describe('checking a proposed dependency list', () => {
  it('accepts a valid edit', () => {
    const nodes = [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }]
    assert.deepEqual(checkDependencies(nodes, 'b'), { ok: true })
  })

  it('refuses a self dependency', () => {
    const verdict = checkDependencies([{ id: 'a', dependsOn: ['a'] }], 'a')
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.equal(verdict.code, 'SELF_DEPENDENCY')
  })

  it('refuses a missing prerequisite', () => {
    const verdict = checkDependencies([{ id: 'a', dependsOn: ['nope'] }], 'a')
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.equal(verdict.code, 'UNKNOWN_NODE')
  })

  it('refuses a cycle and names the path', () => {
    const nodes = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]
    const verdict = checkDependencies(nodes, 'a')
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.equal(verdict.code, 'CYCLE')
      assert.match(verdict.message, /成环/)
    }
  })

  it('refuses an unknown node', () => {
    const verdict = checkDependencies([{ id: 'a' }], 'ghost')
    assert.equal(verdict.ok, false)
    if (!verdict.ok) assert.equal(verdict.code, 'UNKNOWN_NODE')
  })
})
