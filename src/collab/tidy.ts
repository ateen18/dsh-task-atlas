/**
 * One-shot tidy-up for titles that were written as sentences.
 *
 * The write boundary now splits `短标题：解释` on the way in, but documents written before
 * that still hold sentences, and no renderer can turn a paragraph into a label. Rewriting
 * the text is the only real fix — and it is safe because the part that moves is kept, not
 * dropped: it becomes the node's note.
 *
 * Idempotent by construction: running it twice changes nothing the second time.
 */
import type { AtlasDocument, AtlasNode } from '../model/types.ts'
import { collectNodes } from '../model/tree.ts'
import { shortLabel } from '../model/title.ts'

/** One node whose title would change. */
export interface TidyChange {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly moved: boolean
}

/** Result of a tidy pass. */
export interface TidyResult {
  readonly document: AtlasDocument
  readonly changes: readonly TidyChange[]
}

/**
 * Rewrite every project's node titles to their short form, moving the remainder into notes.
 * @param document - the document to tidy.
 * @param apply - when false, compute the changes but return the document untouched.
 * @param at - epoch milliseconds; used only when something actually changes.
 * @returns the (possibly) tidied document plus what changed.
 */
export function tidyTitles(
  document: AtlasDocument,
  apply: boolean,
  at: number,
): TidyResult {
  const changes: TidyChange[] = []

  const tidyNode = (node: AtlasNode): AtlasNode => {
    const label = shortLabel(node.title)
    const remainder = label.remainder?.trim()
    if (label.label === node.title) {
      // Still recurse: children may need it even when the parent does not.
      return { ...node, children: node.children.map(tidyNode) }
    }
    changes.push({
      id: node.id,
      from: node.title,
      to: label.label,
      moved: Boolean(remainder),
    })
    const children = node.children.map(tidyNode)
    if (!apply) return { ...node, children }
    const note = remainder
      ? node.note?.trim()
        ? `${node.note.trim()}\n${remainder}`
        : remainder
      : node.note
    return {
      ...node,
      title: label.label,
      ...(note ? { note } : {}),
      children,
      updatedAt: at,
    }
  }

  if (!apply) {
    // Count without mutating anything, so a dry run is honest by construction.
    for (const project of document.projects) {
      for (const node of collectNodes(project.root)) {
        if (node.kind === 'project') continue
        const label = shortLabel(node.title)
        if (label.label === node.title) continue
        changes.push({
          id: node.id,
          from: node.title,
          to: label.label,
          moved: Boolean(label.remainder),
        })
      }
    }
    return { document, changes }
  }

  const projects = document.projects.map((project) => ({
    ...project,
    root: tidyNode(project.root),
    updatedAt: at,
  }))

  // Nothing to do: return the same document so a repeated run is a true no-op — no
  // `updatedAt` bump, no rewritten objects, no merge conflicts caused by a tidy pass that
  // changed nothing.
  if (changes.length === 0) return { document, changes }

  return { document: { ...document, projects }, changes }
}

