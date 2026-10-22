/**
 * Change feed for the panel.
 *
 * The panel used to poll every 2.5 seconds. That costs no model tokens — it is a
 * local HTTP request — but it is still pure waste: almost every poll returns exactly
 * what the previous one did, and the interesting moment (a node changed) arrives up
 * to 2.5 s late anyway.
 *
 * The plugin already knows every write: they all go through one `mutate()` helper.
 * So writes publish here, the panel holds one long-lived `EventSource` connection,
 * and it refetches only when a revision actually moved.
 *
 * Deliberately not a cordis service: it is a per-process broadcast for this plugin's
 * own route, with no cross-plugin contract to honour.
 */

/** One open subscription. */
export type ChangeListener = (revision: number) => void

/** Broadcast of "the document changed". */
export interface ChangeFeed {
  /**
   * Subscribe to changes.
   * @param listener - called with the new revision on every publish.
   * @returns the unsubscribe function.
   */
  subscribe(listener: ChangeListener): () => void
  /** Publish that the document changed; no-op when nothing is listening. */
  notify(): void
  /** Current revision (monotonic, starts at 0). */
  readonly revision: number
  /** Open subscription count, for diagnostics. */
  readonly size: number
}

/**
 * Build a change feed.
 * @returns a feed whose revision increases once per {@link ChangeFeed.notify}.
 */
export function createChangeFeed(): ChangeFeed {
  const listeners = new Set<ChangeListener>()
  let revision = 0

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify() {
      revision += 1
      // Copy before iterating: a listener may unsubscribe itself (closed socket).
      for (const listener of [...listeners]) {
        try {
          listener(revision)
        } catch {
          /* one dead socket must not stop the others */
        }
      }
    },
    get revision() {
      return revision
    },
    get size() {
      return listeners.size
    },
  }
}
