/**
 * Outputs: the re-openable handles a node produced.
 *
 * Pure helpers so the behaviour is testable without a store, and so "add the same path twice"
 * is a replace rather than a growing list — a duplicate handle is noise, not evidence.
 */
import type { NodeOutput } from './types.ts'

/** Infer the kind of a handle from its shape, when the caller did not say. */
export function guessKind(target: string): NodeOutput['kind'] {
  const text = target.trim()
  if (/^https?:\/\//i.test(text)) return 'url'
  if (/^file:\/\//i.test(text)) return 'file'
  // No dot in the last segment reads as a directory; everything else as a file. A wrong
  // guess only affects the icon, never whether the handle works.
  const last = text.split(/[\\/]/).filter(Boolean).pop() ?? ''
  return last.includes('.') ? 'file' : 'dir'
}

/**
 * Add a handle, replacing any existing entry with the same target.
 * @param outputs - current list.
 * @param output - the new handle.
 * @returns the new list.
 */
export function upsertOutput(
  outputs: readonly NodeOutput[] | undefined,
  output: NodeOutput,
): NodeOutput[] {
  const target = output.target.trim()
  const next = (outputs ?? []).filter((existing) => existing.target.trim() !== target)
  return [...next, { ...output, target }]
}

/**
 * Remove a handle by target.
 * @param outputs - current list.
 * @param target - what to drop.
 * @returns the new list; empty when the last handle was removed.
 */
export function removeOutput(
  outputs: readonly NodeOutput[] | undefined,
  target: string,
): NodeOutput[] {
  const key = target.trim()
  return (outputs ?? []).filter((existing) => existing.target.trim() !== key)
}

/**
 * The line for the continuation prompt, so "from here" inherits the handles.
 * @param outputs - the node's handles.
 * @returns one line, or undefined when there are none.
 */
export function outputsLine(outputs: readonly NodeOutput[] | undefined): string | undefined {
  if (!outputs || outputs.length === 0) return undefined
  return outputs
    .map((output) => `${output.label}（${output.kind}）${output.target}`)
    .join('；')
}
