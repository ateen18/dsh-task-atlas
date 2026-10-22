/**
 * Tidying titles that were written as sentences.
 *
 * Two properties matter: the dry run must not touch anything (otherwise "just looking" has
 * consequences), and the explanation that leaves the title must land in the note rather than
 * disappear.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tidyTitles } from '../src/collab/tidy.ts'
import { addChild, createNode } from '../src/model/tree.ts'
import type { AtlasDocument, AtlasNode } from '../src/model/types.ts'

const AT = 1_800_000_000_000

function document(): AtlasDocument {
  let root: AtlasNode = createNode({ id: 'p', kind: 'project', title: '项目', origin: 'ai', at: AT })
  root = addChild(root, 'p', createNode({ id: 'm', kind: 'module', title: '模块甲', origin: 'ai', at: AT }))
  root = addChild(
    root,
    'm',
    createNode({
      id: 'a',
      kind: 'task',
      title: '基线对齐与数据盘点：确认数据文件与视频文件的真实路径、字段口径、样本量、品类，标出缺口',
      origin: 'ai',
      at: AT,
    }),
  )
  root = addChild(
    root,
    'm',
    createNode({ id: 'b', kind: 'task', title: '节点状态', origin: 'ai', at: AT }),
  )
  root = addChild(
    root,
    'm',
    createNode({
      id: 'c',
      kind: 'task',
      title: '补齐缺失视频：102 条，用 Playwright 真实浏览器下载',
      note: '已有说明',
      origin: 'ai',
      at: AT,
    }),
  )
  return {
    version: 1,
    workspaceKey: 'ws-tidy',
    activeProjectId: 'p',
    projects: [
      {
        id: 'p',
        title: '项目',
        breakdown: null,
        root,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    pending: [],
  }
}

function titles(doc: AtlasDocument): string[] {
  return doc.projects[0]?.root.children[0]?.children.map((node) => node.title) ?? []
}

describe('tidyTitles', () => {
  it('reports without touching anything on a dry run', () => {
    const doc = document()
    const result = tidyTitles(doc, false, AT)
    assert.equal(result.changes.length, 2, 'two sentence-shaped titles')
    assert.equal(result.document, doc, 'a dry run returns the same document object')
    assert.equal(titles(result.document)[0], titles(doc)[0])
  })

  it('shortens titles and keeps the explanation in the note', () => {
    const result = tidyTitles(document(), true, AT)
    const nodes = result.document.projects[0]?.root.children[0]?.children ?? []
    assert.equal(nodes[0]?.title, '基线对齐与数据盘点')
    assert.match(nodes[0]?.note ?? '', /确认数据文件/)
    // An existing note is kept, with the explanation appended rather than replacing it.
    assert.equal(nodes[2]?.title, '补齐缺失视频')
    assert.match(nodes[2]?.note ?? '', /已有说明/)
    assert.match(nodes[2]?.note ?? '', /Playwright/)
  })

  it('leaves a short title alone', () => {
    const result = tidyTitles(document(), true, AT)
    const nodes = result.document.projects[0]?.root.children[0]?.children ?? []
    assert.equal(nodes[1]?.title, '节点状态')
    assert.equal(nodes[1]?.note, undefined)
  })

  it('is idempotent', () => {
    const once = tidyTitles(document(), true, AT)
    const twice = tidyTitles(once.document, true, AT + 1)
    assert.equal(twice.changes.length, 0, 'a second pass finds nothing to do')
    assert.equal(twice.document, once.document)
  })
})
