/**
 * Identifier generation.
 *
 * Two requirements pull against each other: ids should be short enough to read in
 * a tool argument, and they must never collide inside one document. Randomness
 * alone cannot guarantee the second — a constant or badly seeded source would
 * repeat, and a collision surfaces as a mid-mutation throw (`duplicate node id`)
 * rather than something recoverable. So uniqueness comes from a monotonic
 * counter and the random part only adds noise on top.
 *
 * The counter is seeded from the clock so a restarted process does not resume at
 * a value an earlier run already used.
 */
import type { NodeKind } from '../model/types.ts'

const PREFIX: Readonly<Record<NodeKind, string>> = {
  project: 'p',
  module: 'm',
  task: 't',
  item: 'i',
}

/** Default source: `Math.random`. */
export type Rand = () => number

/** Process-local monotonic counter; the uniqueness guarantee. */
let sequence = (Date.now() & 0xffffff) >>> 0

function nextToken(rand: Rand): string {
  sequence = (sequence + 1) >>> 0
  // Two random chars of noise so ids from two processes started in the same
  // millisecond still rarely agree; the counter carries correctness.
  const noise = Math.floor(rand() * 1296)
    .toString(36)
    .padStart(2, '0')
  return `${sequence.toString(36)}${noise}`
}

/**
 * Build a node id for one level.
 * @param kind - the node's level, which sets the prefix.
 * @param rand - random source in `[0, 1)`.
 * @returns e.g. `m-2x7f`.
 */
export function makeNodeId(kind: NodeKind, rand: Rand = Math.random): string {
  return `${PREFIX[kind]}-${nextToken(rand)}`
}

/**
 * Build a pending-confirmation id.
 * @param rand - random source in `[0, 1)`.
 * @returns e.g. `c-2x7f`.
 */
export function makeConfirmationId(rand: Rand = Math.random): string {
  return `c-${nextToken(rand)}`
}

/**
 * Stable identity for one workspace's document.
 *
 * Uses the resolved workspace path with backslashes normalised and the whole
 * thing lowercased, so the same project opened as `D:\x` and `d:/x` shares one
 * document. A short hash keeps the storage key readable while still bounded.
 * @param workspacePath - absolute workspace directory.
 * @returns the storage key.
 */
export function workspaceKeyOf(workspacePath: string): string {
  const normalised = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  // FNV-1a, 32-bit: tiny, deterministic, and good enough to separate paths.
  let hash = 0x811c9dc5
  for (let index = 0; index < normalised.length; index += 1) {
    hash ^= normalised.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `ws-${hash.toString(16).padStart(8, '0')}`
}
