/**
 * Title discipline.
 *
 * The rule this protects: a tree row must be readable without reading a paragraph. The
 * split is deliberately conservative — it only fires when the left side looks like a title
 * and the right side is long enough to be worth keeping.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { shortLabel, splitTitle, TITLE_SOFT_LIMIT, titleHint } from '../src/model/title.ts'

describe('splitting a title from its explanation', () => {
  it('moves a long explanation into the note', () => {
    const result = splitTitle(
      '基线对齐与数据盘点：确认数据文件与视频文件的真实路径、字段口径、样本量、品类，标出缺口',
    )
    assert.equal(result.title, '基线对齐与数据盘点')
    assert.match(result.note ?? '', /确认数据文件/)
    assert.equal(result.tooLong, false)
  })

  it('accepts full-width and half-width separators', () => {
    assert.equal(splitTitle('节点状态: 不止做完和没做完，还要能表达返工与阻塞').title, '节点状态')
  })

  it('leaves a short title alone', () => {
    const result = splitTitle('节点状态')
    assert.equal(result.title, '节点状态')
    assert.equal(result.note, undefined)
    assert.equal(result.tooLong, false)
  })

  it('does not split when the right side is too short to matter', () => {
    const result = splitTitle('状态：好')
    assert.equal(result.title, '状态：好')
  })

  it('does not split when the left side is not a title', () => {
    const result = splitTitle('这个标题前半段就已经很长很长了不应该被当标题：后面还有一段解释性的文字')
    assert.equal(result.note, undefined)
    assert.equal(result.tooLong, true)
  })

  it('trims trailing punctuation', () => {
    assert.equal(splitTitle('任务拆解。').title, '任务拆解')
  })

  it('reports a long title that has no separator', () => {
    const result = splitTitle('一个没有分隔符但明显过长的标题用来测试判定是否生效')
    assert.equal(result.tooLong, true)
    assert.equal(result.note, undefined)
  })
})

describe('the hint', () => {
  it('stays quiet for a short title', () => {
    assert.equal(titleHint('节点状态'), undefined)
  })

  it('asks for the explanation to move when long', () => {
    const hint = titleHint('一'.repeat(TITLE_SOFT_LIMIT + 2))
    assert.ok(hint)
    assert.match(hint ?? '', /note/)
  })
})
  it('cuts at a bracket when the title is long and has no colon', () => {
    const label = shortLabel('补齐 102 条缺失视频（Playwright 真实浏览器下载）')
    assert.equal(label.label, '补齐 102 条缺失视频')
    assert.match(label.remainder ?? '', /Playwright/)
  })

  it('leaves a short title with a comma completely alone', () => {
    // The weak separators exist for long titles; applying them to a short one mangles it.
    const label = shortLabel('先做 A，再做 B')
    assert.equal(label.label, '先做 A，再做 B')
    assert.equal(label.remainder, undefined)
  })

  it('falls back to a cut when nothing else works', () => {
    const long = '一个没有分隔符但明显过长的标题用来测试判定是否生效'
    const label = shortLabel(long)
    assert.ok(label.label.length <= TITLE_SOFT_LIMIT + 1)
    assert.equal(label.remainder, long, 'the whole title stays reachable')
  })
