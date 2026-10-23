/**
 * Canvas arrangement — a mind map, not a layered graph.
 *
 * The plan is a tree first: the project splits into modules, a module into its tasks, a task into
 * its items. That is containment, and drawing it as one flat dependency layer made two thirds of
 * it look like an unordered list. So the canvas draws the tree — root on the left, children
 * stepping right, every parent centred on its children — and dependency edges go on top as a
 * separate, coloured overlay.
 *
 * Two kinds of line, deliberately different:
 *
 *   hierarchy   thin, neutral — "this is under that"; structural, always true;
 *   dependency  coloured, thicker, arrowed — "this waits for that"; a claim worth noticing.
 *
 * Pure geometry, no React: a layout bug is silent, so it has to be testable without a DOM.
 */
import type { AtlasNode, CanvasPoint } from '../model/types.ts'

/**
 * Bumped whenever the arrangement changes shape.
 *
 * Saved positions belong to the arrangement that produced them; without this, coordinates from a
 * retired layout pin a handful of cards somewhere random in the new one.
 */
export const LAYOUT_VERSION = 2

/** Card width, mirrored by the view's styles. */
export const CARD_W = 168
/** Card height, mirrored by the view's styles. */
export const CARD_H = 50
/** Horizontal gap between a parent and its children. */
export const GAP_X = 64
/** Vertical gap between sibling cards. */
export const GAP_Y = 14
/** Left/top origin of the whole canvas. */
export const ORIGIN = 24

/** Where every card goes, plus the room the drawing needs. */
export interface MindMapLayout {
  readonly positions: Record<string, CanvasPoint>
  readonly width: number
  readonly height: number
}

/** One hierarchy link, resolved by the view against the positions. */
export interface HierarchyLink {
  readonly from: string
  readonly to: string
}

/**
 * How tall a node's subtree is: one card when it has no children, otherwise the stacked height
 * of its children. A parent is then centred on that span, which is what makes a mind map read as
 * "these belong together".
 * @param node - subtree root.
 * @param heights - output map, filled as it recurses.
 * @param cardH - height of one card.
 * @param gapY - vertical gap between siblings.
 * @returns the subtree's height in pixels.
 */
function measure(
  node: AtlasNode,
  heights: Map<string, number>,
  cardH: number,
  gapY: number,
): number {
  if (node.children.length === 0) {
    heights.set(node.id, cardH)
    return cardH
  }
  const children = node.children.map((child) => measure(child, heights, cardH, gapY))
  const span =
    children.reduce((total, height) => total + height, 0) + gapY * (node.children.length - 1)
  heights.set(node.id, Math.max(cardH, span))
  return Math.max(cardH, span)
}

/**
 * Lay the plan out as a mind map.
 * @param root - the project node; it is drawn as the centre card.
 * @param options - spacing overrides, mostly for tests and for a very shallow panel.
 * @returns positions and canvas size.
 */
export function arrangeMindMap(
  root: AtlasNode,
  options: { readonly cardH?: number; readonly gapY?: number } = {},
): MindMapLayout {
  const cardH = options.cardH ?? CARD_H
  const gapY = options.gapY ?? GAP_Y
  const heights = new Map<string, number>()
  measure(root, heights, cardH, gapY)

  const positions: Record<string, CanvasPoint> = {}
  let cursor = ORIGIN
  let widest = ORIGIN

  /** Place one subtree; leaves advance the cursor, parents centre on what they placed. */
  const place = (node: AtlasNode, depth: number): void => {
    const x = ORIGIN + depth * (CARD_W + GAP_X)
    widest = Math.max(widest, x + CARD_W)
    if (node.children.length === 0) {
      positions[node.id] = { x, y: cursor }
      cursor += cardH + gapY
      return
    }
    const start = cursor
    for (const child of node.children) place(child, depth + 1)
    const span = cursor - start - gapY
    positions[node.id] = { x, y: start + Math.max(0, (span - cardH) / 2) }
  }
  place(root, 0)

  return {
    positions,
    width: widest + ORIGIN,
    height: Math.max(cardH + ORIGIN, cursor - gapY + ORIGIN),
  }
}

/**
 * Copy the tree with collapsed subtrees emptied.
 *
 * Collapsing is view state: it changes what is drawn, never the document. The pruned copy is what
 * the arrangement runs on, so folding a branch also re-flows the cards instead of leaving a gap.
 *
 * Note that a collapsed node keeps its own children count in the *original* tree — which is why
 * the view reads counts from there. Asking the pruned copy "do you have children?" is how the
 * expand control disappeared and a branch could never be reopened.
 * @param node - subtree root.
 * @param collapsed - ids whose children should be hidden.
 * @returns a pruned copy.
 */
export function prune(node: AtlasNode, collapsed: ReadonlySet<string>): AtlasNode {
  if (collapsed.has(node.id)) return { ...node, children: [] }
  return { ...node, children: node.children.map((child) => prune(child, collapsed)) }
}

/**
 * The chain of hierarchy links between two nodes, when one is an ancestor of the other.
 *
 * A dependency between an ancestor and its own descendant does not need a wire of its own: the
 * hierarchy line is already drawn between them, so the dependency recolours that line instead of
 * adding one that would merely cross the tree.
 *
 * Only true ancestor/descendant pairs qualify. Siblings share a parent but neither is on the
 * other's path — treating them as "connected through the parent" would invent a link that the
 * tree never drew.
 * @param a - one node id.
 * @param b - the other node id.
 * @param parents - child → parent map.
 * @returns link keys (`"parent->child"`), ancestor first, or undefined when unrelated.
 */
export function ancestorPath(
  a: string,
  b: string,
  parents: ReadonlyMap<string, string>,
): string[] | undefined {
  if (a === b) return undefined
  const chain = (id: string): string[] => {
    const up: string[] = [id]
    let cursor = parents.get(id)
    while (cursor !== undefined && up.length < 64) {
      up.push(cursor)
      cursor = parents.get(cursor)
    }
    return up
  }
  /** Links from `ancestor` down to `descendant`, when it really is above it. */
  const linksDown = (ancestor: string, descendant: string): string[] | undefined => {
    const up = chain(descendant)
    const index = up.indexOf(ancestor)
    if (index <= 0) return undefined
    const path = up.slice(0, index + 1).reverse()
    return path.slice(1).map((child, position) => `${path[position]}->${child}`)
  }

  return linksDown(b, a) ?? linksDown(a, b)
}

/**
 * Every parent → child link, in document order.
 * @param root - the subtree to walk.
 * @returns the links.
 */
export function hierarchyLinks(root: AtlasNode): HierarchyLink[] {
  const links: HierarchyLink[] = []
  const walk = (node: AtlasNode): void => {
    for (const child of node.children) {
      links.push({ from: node.id, to: child.id })
      walk(child)
    }
  }
  walk(root)
  return links
}
