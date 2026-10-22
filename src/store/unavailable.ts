/**
 * A store that cannot store.
 *
 * When durable storage is unavailable — the domain failed to open, the harness
 * changed an API, the record is unreadable — the plugin must still come up far
 * enough to *say so*. Registering the tools and the panel route against this
 * store is what turns a silent disappearance into a readable error.
 */
import type { AtlasDocument } from '../model/types.ts'
import type { AtlasStore } from './document.ts'

/** A store whose writes always fail with the original reason. */
export interface UnavailableStore extends AtlasStore {
  /** Why storage is unavailable. */
  readonly reason: string
}

/**
 * Build the failure-reporting store.
 * @param reason - the original failure, shown verbatim to the user and the model.
 * @returns a store that reads as empty and refuses writes.
 */
export function unavailableStore(reason: string): UnavailableStore {
  return {
    reason,
    async read(): Promise<AtlasDocument | undefined> {
      return undefined
    },
    async update(): Promise<AtlasDocument> {
      throw new Error(`storage unavailable: ${reason}`)
    },
  }
}
