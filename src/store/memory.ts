/**
 * In-memory store: the test backend, and the reference for what `AtlasStore`
 * promises (notably that `update` hands the transform the *current* value).
 */
import type { AtlasDocument } from '../model/types.ts'
import { emptyDocument, type AtlasStore } from './document.ts'

/** A memory store plus a peeking helper for assertions. */
export interface MemoryStore extends AtlasStore {
  /** Read a workspace synchronously, bypassing the promise (for test assertions). */
  peek(workspaceKey: string): AtlasDocument | undefined
}

/**
 * Create an isolated in-memory store.
 * @param seed - optional initial documents keyed by workspace.
 * @returns the store.
 */
export function createMemoryStore(
  seed: Readonly<Record<string, AtlasDocument>> = {},
): MemoryStore {
  const documents = new Map<string, AtlasDocument>(Object.entries(seed))
  return {
    async read(workspaceKey) {
      return documents.get(workspaceKey)
    },
    async update(workspaceKey, fn) {
      const current = documents.get(workspaceKey) ?? emptyDocument(workspaceKey)
      const next = fn(current)
      if (next.workspaceKey !== workspaceKey) {
        throw new Error(
          `store transform changed workspaceKey from '${workspaceKey}' to '${next.workspaceKey}'`,
        )
      }
      documents.set(workspaceKey, next)
      return next
    },
    peek(workspaceKey) {
      return documents.get(workspaceKey)
    },
  }
}
