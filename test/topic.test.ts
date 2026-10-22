/**
 * Topic drift.
 *
 * This heuristic decides whether to ask the user "is this a different subject?".
 * Being wrong in one direction is cheap (a dismissal) and in the other is expensive
 * (the user stops trusting the panel), so the tests pin both edges: genuine off-topic
 * questions must be caught, and ordinary on-topic work must never be flagged.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildTopicNotice,
  buildTopicQuestion,
  judgeTopic,
  OFF_TOPIC_STREAK,
  projectTerms,
  TopicWatcher,
} from '../src/drift.ts'
import { addChild, createNode } from '../src/model/tree.ts'
import type { AtlasNode, AtlasProject } from '../src/model/types.ts'

const AT = 1_800_000_000_000

function project(): AtlasProject {
  let root: AtlasNode = createNode({ id: 'p', kind: 'project', title: '插件', origin: 'ai', at: AT })
  root = addChild(root, 'p', createNode({ id: 'm', kind: 'module', title: '面板呈现', origin: 'ai', at: AT }))
  root = addChild(root, 'm', createNode({ id: 't', kind: 'task', title: '状态注入', origin: 'ai', at: AT }))
  return {
    id: 'p',
    title: '插件',
    breakdown: {
      coreIntent: '让长对话不丢失主线',
      deliverables: [{ text: '右侧栏任务图谱面板', acceptance: '能看到树' }],
      decomposition: ['用户面', 'AI 面'],
      acceptance: '刷新后仍在',
      outOfScope: ['跨项目看板'],
      constraints: ['只能 require react'],
      priorityOrder: ['先做面板'],
      mode: 'fast',
      confirmedAt: AT,
    },
    root,
    createdAt: AT,
    updatedAt: AT,
  }
}

describe('vocabulary', () => {
  const terms = projectTerms(project())

  it('includes fragments of the project’s own words', () => {
    for (const fragment of ['面板', '注入', '状态', '主线']) {
      assert.ok(terms.includes(fragment), `expected '${fragment}' in the vocabulary`)
    }
  })

  it('drops fragments that would match anything', () => {
    for (const stop of ['任务', '项目', '这个', '继续']) {
      assert.equal(terms.includes(stop), false, `'${stop}' must not be a term`)
    }
  })
})

describe('judging one message', () => {
  const terms = projectTerms(project())

  it('calls an unrelated question off-topic', () => {
    const verdict = judgeTopic('有哪些吸尘器推荐', terms)
    assert.equal(verdict.onTopic, false)
    assert.deepEqual(verdict.hits, [])
  })

  it('calls an on-topic request on-topic', () => {
    const verdict = judgeTopic('把面板的状态注入改成压缩后才触发', terms)
    assert.equal(verdict.onTopic, true)
    assert.ok(verdict.hits.length > 0)
  })

  it('never judges a short directive', () => {
    // "继续" carries no subject at all; judging it would produce constant noise.
    const verdict = judgeTopic('继续', terms)
    assert.equal(verdict.tooShort, true)
    assert.equal(verdict.onTopic, true)
  })
})

describe('the streak', () => {
  const terms = projectTerms(project())

  it('needs more than one message before asking', () => {
    const watcher = new TopicWatcher()
    const first = watcher.observe('s', '有哪些吸尘器推荐', terms)
    assert.equal(first.streak, 1)
    assert.equal(first.flagged, false)
    const second = watcher.observe('s', '预算2000以内有什么推荐', terms)
    assert.equal(second.streak, OFF_TOPIC_STREAK)
    assert.equal(second.flagged, true)
    assert.ok(second.sample)
  })

  it('is cleared by a single on-topic message', () => {
    const watcher = new TopicWatcher()
    watcher.observe('s', '有哪些吸尘器推荐', terms)
    watcher.observe('s', '预算2000以内有什么推荐', terms)
    const reset = watcher.observe('s', '把面板的注入改成压缩后触发', terms)
    assert.equal(reset.streak, 0)
    assert.equal(reset.flagged, false)
  })

  it('tells the model once, not every step', () => {
    const watcher = new TopicWatcher()
    watcher.observe('s', '有哪些吸尘器推荐', terms)
    watcher.observe('s', '预算2000以内有什么推荐', terms)
    assert.equal(watcher.takeModelNotice('s'), true)
    assert.equal(watcher.takeModelNotice('s'), false)
  })
})

describe('the two messages', () => {
  it('asks the user a question it can be wrong about', () => {
    const question = buildTopicQuestion({ streak: 2, flagged: true, sample: '有哪些吸尘器推荐' })
    assert.match(question, /无关/)
    assert.match(question, /有哪些吸尘器推荐/)
    assert.match(question, /继续推进主线/, 'the user must be able to say "no"')
  })

  it('tells the model to ask before answering, not just to behave', () => {
    // Ordering is the point: "answer, then mention it" is what the user objected to.
    const notice = buildTopicNotice()
    assert.match(notice, /和当前项目无关/)
    assert.match(notice, /先不要开始解答或动手/)
    assert.match(notice, /拿到答复后再继续/)
    assert.match(notice, /立项/)
  })
})

describe('grammar fragments', () => {
  it('does not treat a fragment of grammar as evidence of the subject', () => {
    // "的问" used to match "…无关的问题" and quietly declare an off-topic message
    // on-topic. One such false negative resets the streak and hides the whole point.
    const terms = projectTerms(project())
    assert.equal(terms.some((term) => term.startsWith('的')), false)
    const verdict = judgeTopic('我连着问了两个和主任务无关的问题，并没有提示', terms)
    assert.equal(verdict.onTopic, false)
  })

  it('still matches real subject words', () => {
    const terms = projectTerms(project())
    const verdict = judgeTopic('把面板的注入逻辑改成只在压缩后触发', terms)
    assert.equal(verdict.onTopic, true)
    assert.ok(verdict.hits.includes('面板') || verdict.hits.includes('注入'))
  })
})

describe('notice timing', () => {
  it('does not re-ask while the same off-topic streak continues', () => {
    const terms = projectTerms(project())
    const watcher = new TopicWatcher()
    watcher.observe('s', '有哪些吸尘器推荐', terms)
    watcher.observe('s', '预算2000以内有什么推荐', terms)
    assert.equal(watcher.takeModelNotice('s'), true)
    // A third off-topic message keeps the streak alive but must not nag again.
    const third = watcher.observe('s', '今天天气怎么样呢', terms)
    assert.equal(third.streak, 3)
    assert.equal(third.flagged, true)
    assert.equal(watcher.takeModelNotice('s'), false)
  })

  it('starts over after the user returns to the subject', () => {
    const terms = projectTerms(project())
    const watcher = new TopicWatcher()
    watcher.observe('s', '有哪些吸尘器推荐', terms)
    watcher.observe('s', '预算2000以内有什么推荐', terms)
    watcher.takeModelNotice('s')
    watcher.observe('s', '把面板的注入改成压缩后触发', terms)
    watcher.observe('s', '有哪些吸尘器推荐', terms)
    const again = watcher.observe('s', '今天天气怎么样呢', terms)
    assert.equal(again.flagged, true, 'a fresh streak can be flagged again')
    assert.equal(watcher.takeModelNotice('s'), true)
  })
})
