/**
 * Three-way merge.
 *
 * These tests are about not losing a colleague's work, so the interesting cases are the
 * awkward ones: both sides editing, one side deleting what the other is editing, statuses
 * diverging. Where the merge cannot decide, it must say so rather than pick silently.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mergeDocuments } from '../src/collab/merge.ts'
import type { AtlasDocument, AtlasNode, NodeStatus } from '../src/model/types.ts'

const AT = 1_800_000_000_000

interface Spec {
  readonly id: string
  readonly title: string
  readonly status?: NodeStatus
  readonly updatedAt?: number
  readonly children?: readonly Spec[]
  readonly history?: AtlasNode['history']
}

function node(spec: Spec, at: number): AtlasNode {
  return {
    id: spec.id,
    kind: spec.children ? 'module' : 'task',
    title: spec.title,
    status: spec.status ?? 'pending',
    origin: 'ai',
    history: spec.history ?? [],
    createdAt: at,
    updatedAt: spec.updatedAt ?? at,
    children: (spec.children ?? []).map((child) => node(child, at)),
  }
}

function document(children: readonly Spec[], at = AT, participants?: readonly { id: string; name: string; joinedAt: number }[]): AtlasDocument {
  return {
    version: 1,
    workspaceKey: 'ws-merge',
    activeProjectId: 'p-1',
    projects: [
      {
        id: 'p-1',
        title: '项目',
        breakdown: null,
        root: node({ id: 'p-1', title: '项目', children }, at),
        createdAt: at,
        updatedAt: at,
      },
    ],
    pending: [],
    ...(participants ? { participants } : {}),
  }
}

describe('merging two copies', () => {
  it('changes nothing when neither side moved', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const result = mergeDocuments(base, base, base, AT)
    assert.equal(result.conflicts.length, 0)
    assert.deepEqual(result.stats, { added: 0, updated: 0, removed: 0, unchanged: 1 })
  })

  it('takes the side that changed', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const remote = document([{ id: 'a', title: '甲（改）', updatedAt: AT + 10 }])
    const result = mergeDocuments(base, base, remote, AT)
    const merged = result.document.projects[0]?.root.children[0]
    assert.equal(merged?.title, '甲（改）')
    assert.equal(result.conflicts.length, 0)
  })

  it('keeps the newer edit and reports the other side instead of dropping it', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const local = document([{ id: 'a', title: '甲（我的）', updatedAt: AT + 5 }])
    const remote = document([{ id: 'a', title: '甲（他的）', updatedAt: AT + 9 }])
    const result = mergeDocuments(base, local, remote, AT)
    const merged = result.document.projects[0]?.root.children[0]
    assert.equal(merged?.title, '甲（他的）', 'the newer edit wins')
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0]?.kind, 'both-edited')
    assert.match(result.conflicts[0]?.local ?? '', /甲（我的）/, 'the losing value is still shown')
  })

  it('reports a status divergence as such', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const local = document([{ id: 'a', title: '甲', status: 'done', updatedAt: AT + 5 }])
    const remote = document([{ id: 'a', title: '甲', status: 'blocked', updatedAt: AT + 9 }])
    const result = mergeDocuments(base, local, remote, AT)
    assert.equal(result.conflicts[0]?.kind, 'status-diverged')
    assert.equal(result.document.projects[0]?.root.children[0]?.status, 'blocked')
  })

  it('does not call identical edits a conflict', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const both = document([{ id: 'a', title: '甲', status: 'done', updatedAt: AT + 7 }])
    const result = mergeDocuments(base, both, both, AT)
    assert.equal(result.conflicts.length, 0)
  })

  it('takes a node added on the other side', () => {
    const base = document([{ id: 'a', title: '甲' }])
    const remote = document([
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙' },
    ])
    const result = mergeDocuments(base, base, remote, AT)
    assert.equal(result.document.projects[0]?.root.children.length, 2)
    assert.equal(result.stats.added, 1)
  })

  it('honours a deletion made on one side', () => {
    const base = document([
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙' },
    ])
    const remote = document([{ id: 'a', title: '甲' }])
    const result = mergeDocuments(base, base, remote, AT)
    assert.deepEqual(
      result.document.projects[0]?.root.children.map((child) => child.id),
      ['a'],
    )
    assert.equal(result.stats.removed, 1)
  })

  it('refuses to lose work when one side deletes what the other edits', () => {
    const base = document([
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙' },
    ])
    const local = document([
      { id: 'a', title: '甲' },
      { id: 'b', title: '乙（改）', updatedAt: AT + 3 },
    ])
    const remote = document([{ id: 'a', title: '甲' }])
    const result = mergeDocuments(base, local, remote, AT)
    const ids = result.document.projects[0]?.root.children.map((child) => child.id)
    assert.deepEqual(ids, ['a', 'b'], 'the edited node survives a deletion')
    assert.equal(result.conflicts[0]?.kind, 'deleted-vs-edited')
  })

  it('unions the history of both sides, oldest first', () => {
    const first = { at: AT + 1, by: 'user' as const, from: 'pending' as const, to: 'active' as const }
    const second = { at: AT + 2, by: 'ai' as const, from: 'active' as const, to: 'done' as const }
    const base = document([{ id: 'a', title: '甲' }])
    const local = document([{ id: 'a', title: '甲', updatedAt: AT + 2, history: [first] }])
    const remote = document([{ id: 'a', title: '甲', updatedAt: AT + 3, history: [second] }])
    const merged = mergeDocuments(base, local, remote, AT).document.projects[0]?.root.children[0]
    assert.equal(merged?.history.length, 2)
    assert.equal(merged?.history[0]?.at, AT + 1)
  })

  it('unions participants and keeps the earlier join order', () => {
    const local = document([{ id: 'a', title: '甲' }], AT, [
      { id: 'alice', name: 'Alice', joinedAt: AT },
    ])
    const remote = document([{ id: 'a', title: '甲' }], AT, [
      { id: 'bob', name: 'Bob', joinedAt: AT + 1 },
    ])
    const merged = mergeDocuments(undefined, local, remote, AT).document
    assert.deepEqual(
      merged.participants?.map((participant) => participant.id),
      ['alice', 'bob'],
    )
  })

  it('does not leave activeProjectId pointing at a project that is gone', () => {
    const local = document([{ id: 'a', title: '甲' }])
    const remote: AtlasDocument = { ...document([{ id: 'a', title: '甲' }]), projects: [] }
    const merged = mergeDocuments(local, local, remote, AT).document
    assert.equal(merged.projects.length, 1)
    assert.equal(merged.activeProjectId, 'p-1')
  })
})
