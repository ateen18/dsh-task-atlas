/**
 * The injected state line: small, deduplicated, and honest about the budget.
 *
 * The size bound is not cosmetic. The whole reason this feature exists is to keep a
 * long conversation's attention on the plan, so an injection that grows with the tree
 * would defeat itself.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildInjection, focusOf, INJECTION_BUDGET, InjectionTracker, stateSignature } from '../src/injection.ts'
import { addChild, createNode, updateNode } from '../src/model/tree.ts'
import type { AtlasNode, AtlasProject } from '../src/model/types.ts'

const AT = 1_800_000_000_000

function build(): AtlasProject {
  let root: AtlasNode = createNode({ id: 'p', kind: 'project', title: '项目', origin: 'ai', at: AT })
  root = addChild(root, 'p', createNode({ id: 'm', kind: 'module', title: '用户面', origin: 'ai', at: AT }))
  root = addChild(
    root,
    'm',
    createNode({
      id: 'a',
      kind: 'task',
      title: '呈现',
      note: '让面板一眼可读',
      origin: 'ai',
      at: AT,
    }),
  )
  root = addChild(root, 'a', createNode({ id: 'a1', kind: 'item', title: '三视图', origin: 'ai', at: AT }))
  root = addChild(
    root,
    'm',
    createNode({ id: 'b', kind: 'task', title: '节点状态', origin: 'ai', at: AT }),
  )
  return {
    id: 'p',
    title: '项目',
    breakdown: null,
    root,
    focusedNodeId: 'a',
    createdAt: AT,
    updatedAt: AT,
  }
}

describe('focus', () => {
  it('prefers the explicit focus', () => {
    assert.equal(focusOf(build())?.id, 'a')
  })

  it('falls back to work in progress when nothing is focused', () => {
    const project = build()
    const root = updateNode(project.root, 'b', { title: '节点状态' }, AT + 1)
    const status = (node: AtlasNode): AtlasNode =>
      node.id === 'b'
        ? { ...node, status: 'active' as const }
        : { ...node, children: node.children.map(status) }
    const withStatus = { ...project, root: status(root), focusedNodeId: undefined }
    assert.equal(focusOf(withStatus)?.id, 'b')
  })

  it('returns nothing for a project with no work items', () => {
    const bare: AtlasProject = {
      id: 'p',
      title: 'p',
      breakdown: null,
      root: createNode({ id: 'p', kind: 'project', title: 'p', origin: 'ai', at: AT }),
      createdAt: AT,
      updatedAt: AT,
    }
    assert.equal(focusOf(bare), undefined)
    assert.equal(buildInjection(bare), undefined)
  })
})

describe('state signature', () => {
  it('is stable across an unrelated edit', () => {
    const project = build()
    const edited = updateNode(project.root, 'a1', { note: '改了个说明' }, AT + 1)
    assert.equal(
      stateSignature(project),
      stateSignature({ ...project, root: edited }),
      'a note edit must not trigger an injection',
    )
  })

  it('changes when the focus moves', () => {
    const project = build()
    assert.notEqual(stateSignature(project), stateSignature({ ...project, focusedNodeId: 'b' }))
  })

  it('changes when a node changes status', () => {
    const project = build()
    const mark = (node: AtlasNode): AtlasNode =>
      node.id === 'a'
        ? { ...node, status: 'done' as const }
        : { ...node, children: node.children.map(mark) }
    assert.notEqual(stateSignature(project), stateSignature({ ...project, root: mark(project.root) }))
  })
})

describe('the injected text', () => {
  it('names the node, its status, its place and the next step', () => {
    const text = buildInjection(build())
    assert.ok(text, 'a project with work produces text')
    assert.match(text ?? '', /呈现/)
    assert.match(text ?? '', /进行中|未开始/)
    assert.match(text ?? '', /用户面 \/ 呈现/, 'the trail shows where it sits')
    assert.match(text ?? '', /下一步：三视图/)
    assert.match(text ?? '', /atlas_status/)
  })

  it('stays inside the budget', () => {
    const text = buildInjection(build()) ?? ''
    assert.ok(text.length <= INJECTION_BUDGET, `got ${text.length} chars, budget ${INJECTION_BUDGET}`)
  })

  it('does not grow without bound on a large tree', () => {
    const project = build()
    let root = project.root
    for (let index = 0; index < 200; index += 1) {
      root = addChild(
        root,
        'm',
        createNode({ id: `t${index}`, kind: 'task', title: `任务${index}`, origin: 'ai', at: AT }),
      )
    }
    const text = buildInjection({ ...project, root }) ?? ''
    assert.ok(text.length <= INJECTION_BUDGET, `got ${text.length} chars on a 200-node tree`)
  })
})

describe('compaction re-anchoring', () => {
  it('injects once per distinct signature', () => {
    const tracker = new InjectionTracker()
    assert.equal(tracker.shouldInject('s', 'a'), true)
    assert.equal(tracker.shouldInject('s', 'a'), false, 'the same state is not repeated')
    assert.equal(tracker.shouldInject('s', 'b'), true)
    assert.equal(tracker.shouldInject('other', 'a'), true, 'sessions are independent')
  })

  it('re-injects the same state after a compaction', () => {
    // The tree did not change, but the model lost the conversation: this is exactly
    // the case a plain signature comparison would swallow.
    const tracker = new InjectionTracker()
    assert.equal(tracker.shouldInject('s', 'a'), true)
    tracker.noteCompaction('s')
    assert.equal(tracker.shouldInject('s', 'a'), true)
  })

  it('mentions the compaction exactly once', () => {
    const tracker = new InjectionTracker()
    tracker.noteCompaction('s')
    assert.equal(tracker.takeCompactionNotice('s'), true)
    assert.equal(tracker.takeCompactionNotice('s'), false)
  })

  it('adds the reminder line and stays inside the budget', () => {
    const text = buildInjection(build(), { afterCompaction: true }) ?? ''
    assert.match(text, /上下文刚被压缩过/)
    assert.match(text, /任务图谱没有被压缩/)
    assert.ok(text.length <= INJECTION_BUDGET, `got ${text.length} chars`)
  })
})

describe('no duplicated lines', () => {
  it('adds the topic notice exactly once', () => {
    // The line appeared twice in a real turn because the push existed twice in source;
    // a doubled instruction reads like nagging, and the cause was invisible in tests.
    const text = buildInjection(build(), { notice: 'NOTICE-SENTINEL' }) ?? ''
    assert.equal(text.split('NOTICE-SENTINEL').length - 1, 1)
  })

  it('adds the nudge once, and both together stay ordered', () => {
    const text = buildInjection(build(), { nudge: 'NUDGE-SENTINEL', notice: 'NOTICE-SENTINEL' }) ?? ''
    assert.equal(text.split('NUDGE-SENTINEL').length - 1, 1)
    assert.equal(text.split('NOTICE-SENTINEL').length - 1, 1)
    assert.ok(text.indexOf('NUDGE-SENTINEL') < text.indexOf('NOTICE-SENTINEL'))
  })
})
