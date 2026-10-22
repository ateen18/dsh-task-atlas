/**
 * Title discipline.
 *
 * The tree is read at a glance, so a title has to be scannable. What actually happened in
 * practice: the model wrote `短标题：一长串解释` into `title`, the row wrapped to four
 * lines, and the whole graph became unreadable — the explanation belongs in `note`.
 *
 * So this is enforced at the write boundary rather than asked for in a prompt. Asking was
 * already tried (the skill says "标题不缩略"); the graph still filled with paragraphs. A
 * rule the tool applies is worth more than a rule the model is asked to remember.
 *
 * It never rejects: a too-long title is stored with a warning, because blocking a write
 * mid-turn is worse than a slightly long label, and the renderer truncates anyway.
 */

/** Titles longer than this get a warning in the tool result. */
export const TITLE_SOFT_LIMIT = 18

/** Boundaries an author actually typed: title, then explanation. */
const SEPARATORS = ['：', ':'] as const

/** Weaker boundaries: a bracket or a comma usually ends the label, not the sentence. */
const WEAK_SEPARATORS = ['（', '(', '，', ',', '、', '—'] as const

/** Shortest trailing text worth moving into a note. */
const MIN_NOTE = 8

/** Result of normalising one title. */
export interface TitleSplit {
  /** What should become the node title. */
  readonly title: string
  /** Text that was moved out of the title, when there was any. */
  readonly note?: string
  /** Whether the resulting title still exceeds {@link TITLE_SOFT_LIMIT}. */
  readonly tooLong: boolean
}

/**
 * Split `短标题：解释` into a title and a note.
 *
 * Only splits when the left part is plausibly a title and the right part is long enough to
 * be worth keeping — splitting `A:B` in a version string would be worse than the disease.
 * @param raw - the title the caller supplied.
 * @returns the normalised title, any extracted note, and whether it is still long.
 */
export function splitTitle(raw: string): TitleSplit {
  const text = raw.trim().replace(/[。；;]+$/u, '')
  for (const separator of SEPARATORS) {
    const index = text.indexOf(separator)
    if (index <= 0) continue
    const head = text.slice(0, index).trim()
    const tail = text.slice(index + 1).trim()
    if (head.length >= 2 && head.length <= TITLE_SOFT_LIMIT && tail.length >= MIN_NOTE) {
      return { title: head, note: tail, tooLong: false }
    }
  }
  return { title: text, tooLong: text.length > TITLE_SOFT_LIMIT }
}

/**
 * One line of advice for the model, or nothing when the title is fine.
 * @param title - the title that was stored.
 * @returns a hint to append to the tool result.
 */
export function titleHint(title: string): string | undefined {
  if (title.length <= TITLE_SOFT_LIMIT) return undefined
  return `标题 ${title.length} 字偏长（建议 ≤ ${TITLE_SOFT_LIMIT} 字）：树是用来扫的，解释请放进 note。`
}

/** A label short enough to scan, and whatever was left over. */
export interface Label {
  /** What the tree should show. */
  readonly label: string
  /** The part that belongs in the detail card rather than the row. */
  readonly remainder?: string
}

/**
 * Derive a scannable label from a stored title.
 *
 * Truncation alone was not enough: cutting a paragraph to thirty characters still shows the
 * front of a sentence, not a label. But these titles are `短标题：解释` — the author already
 * decided where the label ends, so the separator is the best boundary available, and it does
 * not require rewriting anyone's data.
 * @param title - the stored title, possibly a sentence.
 * @returns the label to render, plus the remainder for the detail card.
 */
export function shortLabel(title: string): Label {
  const text = title.trim().replace(/[。；;]+$/u, '')
  // A colon is the author's own boundary, so it is trusted even on a short title.
  for (const separator of SEPARATORS) {
    const index = text.indexOf(separator)
    if (index <= 0) continue
    const head = text.slice(0, index).trim()
    const tail = text.slice(index + 1).trim()
    if (head.length >= 2 && head.length <= TITLE_SOFT_LIMIT && tail.length > 0) {
      return { label: head, remainder: tail }
    }
  }
  // Already short enough to scan: leave it alone. This is what keeps "先做 A，再做 B" from
  // being cut at its comma — the guess is only worth making when the alternative is
  // truncation.
  if (text.length <= TITLE_SOFT_LIMIT) return { label: text }
  for (const separator of WEAK_SEPARATORS) {
    const index = text.indexOf(separator)
    if (index <= 0) continue
    const head = text.slice(0, index).trim()
    const tail = text.slice(index + 1).trim()
    if (head.length >= 6 && head.length <= TITLE_SOFT_LIMIT && tail.length > 3) {
      return { label: head, remainder: tail }
    }
  }
  if (text.length <= TITLE_SOFT_LIMIT) return { label: text }
  // No separator to lean on: cut, but keep the full text reachable in the detail card.
  return { label: `${text.slice(0, TITLE_SOFT_LIMIT)}…`, remainder: text }
}
