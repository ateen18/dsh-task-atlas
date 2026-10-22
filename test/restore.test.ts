/**
 * Backup and restore.
 *
 * The recovery path exists because a field rename once made every stored record fail its
 * schema and the tree looked lost. A backup that cannot be validated is worse than none:
 * restoring from it would corrupt the document a second time. So the tests cover the
 * refusals (wrong file, wrong version, schema mismatch, non-empty target) as carefully as
 * the happy path.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BACKUP_FILE, isBlank, parseBackup, renderBackup } from '../src/backup.ts'
import { buildTools, type ToolEnv } from '../src/tools/index.ts'
import { createMemoryStore } from '../src/store/memory.ts'
import { emptyDocument } from '../src/store/document.ts'
import { domainStoreOf } from '../src/store/domain.ts'
import { workspaceKeyOf } from '../src/store/ids.ts'

const AT = 1_800_000_000_000

function envFor(workspace: string): ToolEnv {
  return {
    now: () => AT,
    workspaceKey: () => workspaceKeyOf(workspace),
    workspacePath: () => workspace,
    exportDir: '.dsh',
    rand: () => 0.5,
  }
}

async function seed(workspace: string) {
  const store = createMemoryStore()
  const tools = buildTools(store, envFor(workspace))
  const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
  assert.ok(confirm)
  const created = (await confirm.execute(
    {
      title: '备份测试',
      coreIntent: '验证备份能被读回来',
      deliverables: [{ text: '一份备份', acceptance: '能恢复' }],
      decomposition: ['模块甲'],
      acceptance: '恢复后节点数一致',
      mode: 'fast',
    },
    {} as never,
  )) as { ok: boolean }
  assert.equal(created.ok, true)
  const document = await store.read(workspaceKeyOf(workspace))
  assert.ok(document)
  return { store, tools, document }
}

describe('backup envelope', () => {
  it('round-trips a document exactly', async () => {
    const workspace = path.join(tmpdir(), 'atlas-backup-roundtrip')
    const { document } = await seed(workspace)
    const parsed = parseBackup(renderBackup(document, AT))
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.deepEqual(parsed.document, document)
      assert.equal(parsed.exportedAt, AT)
    }
  })

  it('refuses a file that is not a backup', () => {
    const result = parseBackup(JSON.stringify({ projects: [] }))
    assert.equal(result.ok, false)
  })

  it('refuses an unknown version', () => {
    const result = parseBackup(
      JSON.stringify({ kind: 'dsh-task-atlas-backup', version: 99, document: {} }),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /版本 99/)
  })

  it('refuses a document that fails the storage schema', () => {
    const result = parseBackup(
      JSON.stringify({ kind: 'dsh-task-atlas-backup', version: 1, document: { version: 2 } }),
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.reason, /schema/)
  })

  it('refuses malformed JSON', () => {
    assert.equal(parseBackup('{not json').ok, false)
  })

  it('treats an empty document as blank, and a seeded one as not', async () => {
    assert.equal(isBlank(emptyDocument('ws-x')), true)
    const workspace = path.join(tmpdir(), 'atlas-backup-blank')
    const { document } = await seed(workspace)
    assert.equal(isBlank(document), false)
  })
})

describe('atlas_restore', () => {
  /** Build a real document for one workspace, using a throwaway store. */
  async function makeDocument(workspace: string) {
    const store = createMemoryStore()
    const tools = buildTools(store, envFor(workspace))
    const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
    assert.ok(confirm)
    await confirm.execute(
      {
        title: '备份测试',
        coreIntent: '验证备份能被读回来',
        deliverables: [{ text: '一份备份', acceptance: '能恢复' }],
        decomposition: ['模块甲'],
        acceptance: '恢复后节点数一致',
        mode: 'fast',
      },
      {} as never,
    )
    const document = await store.read(workspaceKeyOf(workspace))
    assert.ok(document)
    return document
  }

  /**
   * A fresh workspace and store per test.
   *
   * Sharing one temp directory made "there is no backup file" fail once an earlier test
   * had written one, and reusing one store made the overwrite case impossible to set up.
   */
  async function prepare(options: { backupText?: string; seedStore?: boolean } = {}) {
    const workspace = await mkdtemp(path.join(tmpdir(), 'atlas-restore-'))
    const store = createMemoryStore()
    const tools = buildTools(store, envFor(workspace))
    const restore = tools.find((tool) => tool.name === 'atlas_restore')
    assert.ok(restore)
    await mkdir(path.join(workspace, '.dsh'), { recursive: true })

    if (options.backupText !== undefined) {
      await writeFile(path.join(workspace, '.dsh', BACKUP_FILE), options.backupText, 'utf8')
    }
    if (options.seedStore) {
      // Same workspace, so the document's workspaceKey matches the store key.
      const confirm = tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
      assert.ok(confirm)
      await confirm.execute(
        {
          title: '库里已有的项目',
          coreIntent: '占位',
          deliverables: [{ text: '占位交付物', acceptance: '占位验收' }],
          decomposition: ['占位模块'],
          acceptance: '占位',
          mode: 'fast',
        },
        {} as never,
      )
    }
    return { store, restore, workspace }
  }

  it('restores an empty workspace from the file', async () => {
    const source = await mkdtemp(path.join(tmpdir(), 'atlas-restore-src-'))
    const document = await makeDocument(source)
    const { store, restore, workspace } = await prepare({ backupText: renderBackup(document, AT) })

    const result = (await restore.execute({}, {} as never)) as { ok: boolean; summary: string }
    assert.equal(result.ok, true)
    assert.match(result.summary, /1 个项目/)
    // Read the *target* key: the backup was taken elsewhere, and restore adopts the
    // current workspace key so a moved directory can still be recovered.
    const restored = await store.read(workspaceKeyOf(workspace))
    assert.deepEqual(
      restored?.projects.map((project) => project.title),
      document.projects.map((project) => project.title),
    )
    assert.equal(restored?.workspaceKey, workspaceKeyOf(workspace))
  })

  it('refuses to overwrite a non-empty document without permission', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'atlas-restore-src-'))
    const document = await makeDocument(workspace)
    const { restore } = await prepare({
      backupText: renderBackup(document, AT),
      seedStore: true,
    })

    const refused = (await restore.execute({}, {} as never)) as { ok: boolean; code?: string }
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'BACKUP_EXISTS')

    const allowed = (await restore.execute({ overwrite: true }, {} as never)) as { ok: boolean }
    assert.equal(allowed.ok, true)
  })

  it('says so when there is no backup file', async () => {
    const { restore } = await prepare()
    const result = (await restore.execute({}, {} as never)) as { ok: boolean; code?: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'NO_BACKUP')
  })

  it('refuses a corrupt backup instead of half-writing it', async () => {
    const { store, restore, workspace } = await prepare({
      backupText: '{"kind":"dsh-task-atlas-backup","version":1}',
    })
    const result = (await restore.execute({}, {} as never)) as { ok: boolean; code?: string }
    assert.equal(result.ok, false)
    assert.equal(result.code, 'BAD_BACKUP')
    const still = await store.read(workspaceKeyOf(workspace))
    assert.equal(still, undefined, 'a refused restore must not touch the store')
  })
})