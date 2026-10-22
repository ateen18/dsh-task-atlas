/**
 * Lossless backup of one workspace's document.
 *
 * The Markdown mirror is for humans: readable, diffable, but lossy — it renders ids,
 * statuses and reasons, yet it cannot be parsed back into an exact document without
 * inventing a parser that would then become a second source of truth.
 *
 * So the machine-readable copy is a separate artifact next to it. Both are written on
 * the same turn boundary; only this one can be restored from.
 *
 * Why it exists at all: a rename of one field once made every stored record fail its
 * schema, the domain refused to open, and the whole tree looked lost. It was not lost —
 * but there was no path back if it had been.
 */
import type { AtlasDocument } from './model/types.ts'
import { atlasDocumentSchema } from './store/domain.ts'

/** Name of the backup file inside the mirror directory. */
export const BACKUP_FILE = 'task-atlas.json'

/** The wrapper written to disk, so a stray JSON file cannot be mistaken for a backup. */
export interface BackupEnvelope {
  readonly kind: 'dsh-task-atlas-backup'
  readonly version: 1
  readonly exportedAt: number
  readonly document: AtlasDocument
}

/**
 * Render the backup file body.
 * @param document - the document to preserve.
 * @param at - export time, epoch milliseconds.
 * @returns pretty JSON, so a human can still read a diff.
 */
export function renderBackup(document: AtlasDocument, at: number): string {
  const envelope: BackupEnvelope = {
    kind: 'dsh-task-atlas-backup',
    version: 1,
    exportedAt: at,
    document,
  }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/** Outcome of reading a backup. */
export type BackupRead =
  | { readonly ok: true; readonly document: AtlasDocument; readonly exportedAt: number }
  | { readonly ok: false; readonly reason: string }

/**
 * Parse and validate a backup file.
 *
 * Validation goes through the same schema the storage domain uses: a backup that would
 * fail on write is worse than no backup, because it turns "recover" into "corrupt it a
 * second time".
 * @param text - file contents.
 * @returns the document, or why it was rejected.
 */
export function parseBackup(text: string): BackupRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${(error as Error).message}` }
  }
  const envelope = parsed as Partial<BackupEnvelope>
  if (envelope?.kind !== 'dsh-task-atlas-backup') {
    return { ok: false, reason: '不是任务图谱的备份文件（缺少 kind 标记）' }
  }
  if (envelope.version !== 1) {
    return { ok: false, reason: `备份版本 ${String(envelope.version)} 不认识（只支持 1）` }
  }
  const result = atlasDocumentSchema.safeParse(envelope.document)
  if (!result.success) {
    const first = result.error.issues[0]
    return {
      ok: false,
      reason: `备份内容不符合 schema：${first?.path.join('.') ?? '(root)'} ${first?.message ?? ''}`,
    }
  }
  return {
    ok: true,
    document: result.data,
    exportedAt: typeof envelope.exportedAt === 'number' ? envelope.exportedAt : 0,
  }
}

/**
 * Whether a document carries nothing worth losing.
 * @param document - document to inspect.
 * @returns true when there is no project and nothing pending.
 */
export function isBlank(document: AtlasDocument): boolean {
  return document.projects.length === 0 && document.pending.length === 0
}
