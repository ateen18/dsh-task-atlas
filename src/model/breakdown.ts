/**
 * Project-breakdown validation and amendment.
 *
 * The breakdown is the plugin's answer to "what was this whole thing supposed to
 * be". It is filled in once at kickoff, then pinned at the top of the panel — and
 * it is a **living** document: understanding moves as the work moves, so it can be
 * amended, with every amendment recording why.
 */
import type {
  Actor,
  Breakdown,
  BreakdownField,
  BreakdownFieldChange,
  BreakdownMode,
  BreakdownRevision,
  Deliverable,
} from './types.ts'

/** One breakdown field, as the interview asks it. */
export interface BreakdownQuestion {
  readonly field: keyof Omit<Breakdown, 'mode' | 'confirmedAt' | 'revisions'>
  /** Interview order; the 1..7 the user sees. */
  readonly order: number
  /** Whether kickoff may finish without it. */
  readonly required: boolean
  /** Short label for the panel. */
  readonly label: string
}

/** The seven interview dimensions, in the order the detailed mode asks them. */
export const BREAKDOWN_QUESTIONS: readonly BreakdownQuestion[] = [
  { field: 'coreIntent', order: 1, required: true, label: '核心意图' },
  { field: 'deliverables', order: 2, required: true, label: '核心交付物' },
  { field: 'decomposition', order: 3, required: true, label: '拆解' },
  { field: 'acceptance', order: 4, required: true, label: '整体验收标准' },
  { field: 'outOfScope', order: 5, required: false, label: '明确不做什么' },
  { field: 'constraints', order: 6, required: false, label: '约束与前置依赖' },
  { field: 'priorityOrder', order: 7, required: false, label: '优先级与先后顺序' },
]

/** Fields a breakdown cannot do without. */
export const REQUIRED_BREAKDOWN_FIELDS: readonly BreakdownQuestion['field'][] =
  BREAKDOWN_QUESTIONS.filter((q) => q.required).map((q) => q.field)

/** Outcome of validating a drafted breakdown. */
export interface BreakdownValidation {
  readonly ok: boolean
  /** Required fields that are blank. */
  readonly missing: readonly string[]
  /** Non-blocking problems, e.g. a deliverable with no acceptance test. */
  readonly warnings: readonly string[]
}

function blank(value: string | undefined): boolean {
  return !value || value.trim().length === 0
}

/**
 * Check a drafted breakdown against the kickoff bar.
 *
 * A deliverable without an acceptance test is reported as a warning rather than
 * an error: refusing to save a nearly-complete breakdown is how kickoff turns into
 * a questionnaire. The panel shows the warning so it can be fixed later.
 * @param breakdown - the draft.
 * @returns whether it may be confirmed, plus exactly what is missing.
 */
export function validateBreakdown(breakdown: Omit<Breakdown, 'confirmedAt'>): BreakdownValidation {
  const missing: string[] = []
  const warnings: string[] = []

  if (blank(breakdown.coreIntent)) missing.push('coreIntent')
  if (breakdown.deliverables.length === 0) missing.push('deliverables')
  if (breakdown.decomposition.length === 0) missing.push('decomposition')
  if (blank(breakdown.acceptance)) missing.push('acceptance')

  breakdown.deliverables.forEach((deliverable, index) => {
    if (blank(deliverable.text)) {
      missing.push(`deliverables[${index}].text`)
    } else if (blank(deliverable.acceptance)) {
      warnings.push(
        `deliverable ${index + 1} ("${deliverable.text}") has no acceptance test`,
      )
    }
  })

  breakdown.decomposition.forEach((step, index) => {
    if (blank(step)) warnings.push(`decomposition[${index}] is blank`)
  })

  return { ok: missing.length === 0, missing, warnings }
}

/**
 * Build the storable breakdown once the user has confirmed the draft.
 * @param draft - validated draft minus the confirmation timestamp.
 * @param at - epoch milliseconds of confirmation.
 * @returns the breakdown to persist.
 */
export function confirmBreakdown(
  draft: Omit<Breakdown, 'confirmedAt'>,
  at: number,
): Breakdown {
  const result = validateBreakdown(draft)
  if (!result.ok) {
    throw new Error(`breakdown is incomplete; missing: ${result.missing.join(', ')}`)
  }
  return { ...draft, confirmedAt: at }
}

/**
 * Which interview a kickoff should run.
 *
 * `fast` drafts the whole breakdown and asks the user to correct it; `detailed`
 * walks the seven dimensions. The user picks, so both modes must produce the
 * same shape.
 * @param mode - the chosen mode.
 * @returns the fields that mode walks in order.
 */
export function interviewFor(mode: BreakdownMode): readonly BreakdownQuestion[] {
  return mode === 'fast'
    ? BREAKDOWN_QUESTIONS.filter((q) => q.required)
    : BREAKDOWN_QUESTIONS
}

/** The fields an amendment may touch. `confirmedAt` and `revisions` are not editable. */
export type BreakdownPatch = Partial<Omit<Breakdown, 'confirmedAt' | 'revisions'>>

/** Outcome of an amendment. */
export interface AmendOutcome {
  /** The amended breakdown; the same object when nothing actually changed. */
  readonly breakdown: Breakdown
  /** Field-level diff, empty when the patch was a no-op. */
  readonly changes: readonly BreakdownFieldChange[]
  /** Non-blocking notes, e.g. the module list now disagrees with the tree. */
  readonly warnings: readonly string[]
}

const MAX_RENDERED = 120

/** Render one field value for the revision log. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > MAX_RENDERED ? `${value.slice(0, MAX_RENDERED)}…` : value
  }
  if (Array.isArray(value)) {
    const rendered = value.map((item) =>
      typeof item === 'string'
        ? item
        : typeof item === 'object' && item !== null && 'text' in item
          ? String((item as { text: unknown }).text)
          : JSON.stringify(item),
    )
    const joined = rendered.join(' / ')
    return joined.length > MAX_RENDERED ? `${joined.slice(0, MAX_RENDERED)}…` : joined
  }
  return String(value)
}

/** Structural equality good enough for breakdown fields (strings, arrays, plain objects). */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const EDITABLE: readonly BreakdownQuestion['field'][] = BREAKDOWN_QUESTIONS.map((q) => q.field)

/**
 * Amend a confirmed breakdown and record why.
 *
 * A breakdown that cannot move goes stale, and a stale breakdown stops being read — so
 * it may change. What must not change silently is the reason, which is why
 * `reason` is mandatory and every amendment lands in `revisions`.
 *
 * `decomposition` is the one field whose edits can silently disagree with the tree
 * (it is a module list, and modules are nodes). When the caller supplies the
 * current module titles, a mismatch is reported as a warning instead of being
 * silently accepted.
 * @param breakdown - the confirmed breakdown.
 * @param patch - fields to change; absent fields are left alone.
 * @param meta - when, by whom, and why.
 * @param currentModuleTitles - module titles currently in the tree, for the drift check.
 * @returns the amended breakdown plus the diff.
 * @throws {Error} when the reason is blank, the result fails validation, or a patch
 *   field is not editable.
 */
export function amendBreakdown(
  breakdown: Breakdown,
  patch: BreakdownPatch,
  meta: { readonly at: number; readonly by: Actor; readonly reason: string },
  currentModuleTitles?: readonly string[],
): AmendOutcome {
  const reason = meta.reason.trim()
  if (reason.length === 0) {
    throw new Error('an amendment requires a reason: what changed in your understanding?')
  }

  for (const key of Object.keys(patch)) {
    if (!EDITABLE.includes(key as BreakdownQuestion['field'])) {
      throw new Error(`'${key}' is not an editable breakdown field`)
    }
  }

  const changes: BreakdownFieldChange[] = []
  const next: Record<string, unknown> = { ...breakdown }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = (breakdown as unknown as Record<string, unknown>)[key]
    if (sameValue(current, value)) continue
    changes.push({
      field: key as BreakdownField,
      from: renderValue(current),
      to: renderValue(value),
    })
    next[key] = value
  }

  const warnings: string[] = []
  if (changes.length === 0) return { breakdown, changes, warnings }

  const merged = {
    coreIntent: next.coreIntent as string,
    deliverables: next.deliverables as readonly Deliverable[],
    decomposition: next.decomposition as readonly string[],
    acceptance: next.acceptance as string,
    outOfScope: next.outOfScope as readonly string[],
    constraints: next.constraints as readonly string[],
    priorityOrder: next.priorityOrder as readonly string[],
    mode: next.mode as BreakdownMode,
  }
  const validation = validateBreakdown(merged)
  if (!validation.ok) {
    throw new Error(`amended breakdown is incomplete; missing: ${validation.missing.join(', ')}`)
  }
  warnings.push(...validation.warnings)

  if (currentModuleTitles && changes.some((change) => change.field === 'decomposition')) {
    const declared = new Set(merged.decomposition.map((item) => item.trim()))
    const actual = new Set(currentModuleTitles.map((title) => title.trim()))
    const missing = [...declared].filter((item) => !actual.has(item))
    const extra = [...actual].filter((title) => !declared.has(title))
    if (missing.length > 0 || extra.length > 0) {
      warnings.push(
        `拆解的「拆解」和树里的模块不一致：拆解有但树里没有 [${missing.join(', ') || '无'}]；` +
          `树里有但拆解没写 [${extra.join(', ') || '无'}]。拆解不会自动改树，需要的话用 atlas_node_add / atlas_node_move 调整。`,
      )
    }
  }

  const revision: BreakdownRevision = {
    at: meta.at,
    by: meta.by,
    reason,
    changes,
  }

  return {
    breakdown: {
      ...breakdown,
      ...merged,
      revisions: [...(breakdown.revisions ?? []), revision],
    },
    changes,
    warnings,
  }
}
