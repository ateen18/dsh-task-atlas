/**
 * A store whose backing arrives later.
 *
 * The plugin must register its tools and its panel route *before* durable storage
 * exists, because a cordis `inject` that never resolves is invisible: no error, no
 * log, no tool, no route — just a plugin that silently does nothing. So the tools
 * are bound to this proxy, and storage is swapped in when `storageDomain` appears.
 * Until then every write fails with a message that says exactly that.
 */
import type { AtlasDocument } from '../model/types.ts'
import type { AtlasStore } from './document.ts'

/** A store that forwards to whatever backing is currently bound. */
export class DelegatingStore implements AtlasStore {
  private backing: AtlasStore | undefined

  /**
   * Supplies the current "why unavailable" text on each call.
   *
   * Declared as a plain field rather than a constructor parameter property on
   * purpose: Node's type-stripping cannot erase parameter properties, and this file
   * is executed directly by the test runner.
   */
  private readonly reasonFor: () => string

  /**
   * @param reasonFor - supplies the current "why unavailable" text on each call.
   */
  constructor(reasonFor: () => string) {
    this.reasonFor = reasonFor
  }

  /** Install the real backing store. */
  bind(store: AtlasStore): void {
    this.backing = store
  }

  /** Whether a backing store is bound. */
  get ready(): boolean {
    return this.backing !== undefined
  }

  /**
   * Read through the current backing (empty while unbound).
   * @param workspaceKey - workspace identity.
   */
  async read(workspaceKey: string): Promise<AtlasDocument | undefined> {
    if (!this.backing) return undefined
    return this.backing.read(workspaceKey)
  }

  /**
   * Write through the current backing; refuses with a readable reason while unbound.
   * @param workspaceKey - workspace identity.
   * @param fn - pure transform.
   */
  async update(
    workspaceKey: string,
    fn: (current: AtlasDocument) => AtlasDocument,
  ): Promise<AtlasDocument> {
    const backing = this.backing
    if (!backing) {
      throw new Error(`持久化还不可用：${this.reasonFor()}。工具已注册，但暂时存不了数据。`)
    }
    return backing.update(workspaceKey, fn)
  }
}
