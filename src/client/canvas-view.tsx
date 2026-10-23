/**
 * The canvas: a mind map of the plan, with dependencies drawn on top.
 *
 * Two kinds of line, and the difference is the whole point:
 *
 *   hierarchy   thin, neutral, parent→child — the structure, always true;
 *   dependency  coloured, thicker, arrowed — something waits for something, a claim to notice.
 *
 * Clicking a card lights its dependency neighbourhood: the node itself brightest, the nodes it
 * waits for and the nodes waiting for it next (so "what is holding this up" is one click away),
 * everything else recedes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { CARD_H, CARD_W, ancestorPath, arrangeMindMap, hierarchyLinks, prune } from './canvas-layout.ts'
import { collectNodes } from '../model/tree.ts'
import { shortLabel } from '../model/title.ts'
import type { AtlasNode, AtlasProject, CanvasPoint } from '../model/types.ts'
import { FOCUS_COLOR, STATUS_COLOR, STATUS_LABEL } from './labels.ts'

const MIN_SCALE = 0.3
const MAX_SCALE = 2.2

/**
 * The dependency colour.
 *
 * A mid-tone amber reads on both a dark and a light panel, and it is none of the six status
 * colours — so a coloured line never looks like a status claim.
 */
const DEPENDENCY_COLOR = '#d97706'

const tiny: CSSProperties = {
  fontSize: 10,
  lineHeight: '13px',
  color: 'var(--dsw-alias-text-tertiary, #8b949e)',
}

const buttonStyle: CSSProperties = {
  fontSize: 10.5,
  lineHeight: '16px',
  padding: '1px 7px',
  borderRadius: 4,
  border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  borderRadius: 6,
  background:
    'radial-gradient(circle at 1px 1px, var(--dsw-alias-border-secondary, rgba(128,128,128,0.22)) 1px, transparent 0) 0 0 / 22px 22px',
  touchAction: 'none',
  cursor: 'grab',
}

/** One dependency wire, resolved to two cards. */
interface Wire {
  readonly from: string
  readonly to: string
  readonly label?: string
}

export interface CanvasViewProps {
  readonly project: AtlasProject
  readonly layout: Readonly<Record<string, CanvasPoint>> | undefined
  readonly onSaveLayout: (positions: Record<string, CanvasPoint>) => void
  readonly selectedId?: string
  readonly onSelect: (id: string) => void
}

/** Dependency wires: stated needs first, then legacy edges that carry no explanation. */
function wiresOf(nodes: readonly AtlasNode[]): Wire[] {
  const ids = new Set(nodes.map((node) => node.id))
  const wires: Wire[] = []
  for (const node of nodes) {
    const needs = node.needs ?? []
    for (const need of needs) {
      const from = need.fromNodeId?.trim()
      if (from && ids.has(from) && from !== node.id) {
        wires.push({ from, to: node.id, label: need.label })
      }
    }
    for (const from of node.dependsOn ?? []) {
      if (!ids.has(from) || from === node.id) continue
      if (needs.some((need) => need.fromNodeId?.trim() === from)) continue
      wires.push({ from, to: node.id })
    }
  }
  return wires
}

/** Cubic from a card's right edge to another card's left edge — the hierarchy direction. */
function curve(from: CanvasPoint, to: CanvasPoint): string {
  const x1 = from.x + CARD_W
  const y1 = from.y + CARD_H / 2
  const x2 = to.x
  const y2 = to.y + CARD_H / 2
  const bend = Math.max(36, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

/**
 * Cubic between two cards in the same column, bulging out to the right of both.
 *
 * Two nodes at the same depth sit one above the other. Drawing that as right → left made the
 * wire loop back across both cards, which is worse than useless: it hides the very cards it is
 * trying to relate. Going right edge → right edge keeps the whole wire outside the column.
 * @param from - the provider.
 * @param to - the dependent.
 * @returns the path data.
 */
function sideCurve(from: CanvasPoint, to: CanvasPoint): string {
  const x1 = from.x + CARD_W
  const y1 = from.y + CARD_H / 2
  const x2 = to.x + CARD_W
  const y2 = to.y + CARD_H / 2
  const bulge = 46 + Math.min(110, Math.abs(y2 - y1) / 2)
  return `M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}`
}

/** Where to put a caption on the side curve: its apex, which is its right-most point. */
function sideCurveApex(from: CanvasPoint, to: CanvasPoint): CanvasPoint {
  const bulge = 46 + Math.min(110, Math.abs(to.y - from.y) / 2)
  return {
    x: Math.max(from.x, to.x) + CARD_W + bulge * 0.75,
    y: (from.y + to.y) / 2 + CARD_H / 2,
  }
}

/**
 * Render the mind map.
 * @param props - project, saved positions, save callback and selection.
 * @returns the canvas.
 */
export function CanvasView(props: CanvasViewProps) {
  /** Subtrees the user has folded away. View state, so it stays local. */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  /** Child counts from the ORIGINAL tree: the pruned copy has emptied the collapsed ones. */
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const node of collectNodes(props.project.root)) counts.set(node.id, node.children.length)
    return counts
  }, [props.project.root])
  const prunedRoot = useMemo(
    () => prune(props.project.root, collapsed),
    [props.project.root, collapsed],
  )
  const nodes = useMemo(() => collectNodes(prunedRoot), [prunedRoot])
  const base = useMemo(() => arrangeMindMap(prunedRoot), [prunedRoot])
  const links = useMemo(() => hierarchyLinks(prunedRoot), [prunedRoot])
  const wires = useMemo(() => wiresOf(nodes), [nodes])
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const [moved, setMoved] = useState<Record<string, CanvasPoint>>({})
  const positions = useMemo(
    () => ({ ...base.positions, ...(props.layout ?? {}), ...moved }),
    [base.positions, props.layout, moved],
  )

  /** The selected node's dependency neighbourhood: what it waits for, and what waits for it. */
  const neighbourhood = useMemo(() => {
    if (!props.selectedId) return { upstream: new Set<string>(), downstream: new Set<string>() }
    const upstream = new Set<string>()
    const downstream = new Set<string>()
    for (const wire of wires) {
      if (wire.to === props.selectedId) upstream.add(wire.from)
      if (wire.from === props.selectedId) downstream.add(wire.to)
    }
    return { upstream, downstream }
  }, [props.selectedId, wires])

  const isNeighbour = (id: string): boolean =>
    neighbourhood.upstream.has(id) || neighbourhood.downstream.has(id)

  const [view, setView] = useState({ x: 0, y: 0, scale: 0.8 })
  const [dragging, setDragging] = useState<string | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const pan = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Positions also live in a ref: `pointerup` can arrive before React re-renders. */
  const movedRef = useRef<Record<string, CanvasPoint>>({})
  const latest = useRef({ layout: props.layout, onSaveLayout: props.onSaveLayout })
  latest.current = { layout: props.layout, onSaveLayout: props.onSaveLayout }

  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = movedRef.current
    if (Object.keys(pending).length === 0) return
    latest.current.onSaveLayout({ ...(latest.current.layout ?? {}), ...pending })
  }, [])

  useEffect(() => {
    if (Object.keys(moved).length === 0) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 500)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [moved, flush])

  const toCanvas = useCallback(
    (clientX: number, clientY: number): CanvasPoint => {
      const box = surface.current?.getBoundingClientRect()
      if (!box) return { x: 0, y: 0 }
      return {
        x: (clientX - box.left - view.x) / view.scale,
        y: (clientY - box.top - view.y) / view.scale,
      }
    },
    [view],
  )

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (drag.current) {
        const point = toCanvas(event.clientX, event.clientY)
        const next = {
          x: Math.round(point.x - drag.current.offsetX),
          y: Math.round(point.y - drag.current.offsetY),
        }
        movedRef.current = { ...movedRef.current, [drag.current.id]: next }
        setMoved(movedRef.current)
        return
      }
      if (pan.current) {
        setView((current) => ({
          ...current,
          x: pan.current!.originX + (event.clientX - pan.current!.startX),
          y: pan.current!.originY + (event.clientY - pan.current!.startY),
        }))
      }
    },
    [toCanvas],
  )

  const endDrag = useCallback(() => {
    if (drag.current) {
      setDragging(null)
      drag.current = null
      flush()
      return
    }
    if (pan.current) pan.current = null
  }, [flush])

  useEffect(() => {
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
    }
  }, [onPointerMove, endDrag])

  const zoomBy = useCallback((factor: number) => {
    setView((current) => ({
      ...current,
      scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor)),
    }))
  }, [])

  const fit = useCallback(() => {
    const points = Object.values(positions)
    if (points.length === 0) return
    const minX = Math.min(...points.map((point) => point.x))
    const minY = Math.min(...points.map((point) => point.y))
    const maxX = Math.max(...points.map((point) => point.x + CARD_W))
    const maxY = Math.max(...points.map((point) => point.y + CARD_H))
    const box = surface.current?.getBoundingClientRect()
    if (!box) return
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(box.width / (maxX - minX + 48), box.height / (maxY - minY + 48))),
    )
    setView({
      scale,
      x: box.width / 2 - ((minX + maxX) / 2) * scale,
      y: box.height / 2 - ((minY + maxY) / 2) * scale,
    })
  }, [positions])

  const unexplained = wires.filter((wire) => !wire.label).length
  const showLabels = view.scale >= 0.62
  /**
   * Which dependency wires to draw.
   *
   * With nothing selected: none. A plan of thirty nodes with eleven dependencies does not need
   * eleven permanent lines crossing a tree; it needs "click this, see what it waits for". The
   * count in the header still says how many exist.
   */
  /** child → parent, for deciding whether a dependency is already drawn as a hierarchy link. */
  const parents = useMemo(() => {
    const map = new Map<string, string>()
    for (const node of collectNodes(props.project.root)) {
      for (const child of node.children) map.set(child.id, node.id)
    }
    return map
  }, [props.project.root])

  const visibleWires = useMemo(
    () =>
      props.selectedId
        ? wires.filter((wire) => wire.from === props.selectedId || wire.to === props.selectedId)
        : [],
    [props.selectedId, wires],
  )

  /**
   * How each visible dependency should be drawn.
   *
   * Three cases, and each exists for a reason:
   *   ancestor ↔ descendant  reuse the hierarchy links on the path, recoloured — a second line
   *                          would only cross the tree to say what the tree already says;
   *   same column            right edge → right edge, bulging outside the column, because the
   *                          right → left form looped back across both cards;
   *   otherwise              the ordinary left-to-right wire.
   */
  const routing = useMemo(() => {
    /** Hierarchy links that stand in for a dependency, with that dependency's own wording. */
    const carried = new Map<string, { final: boolean; dashed: boolean; label?: string }>()
    const side: Wire[] = []
    for (const wire of visibleWires) {
      const path = ancestorPath(wire.from, wire.to, parents)
      if (path && path.length > 0) {
        path.forEach((key, index) => {
          const isLast = index === path.length - 1
          carried.set(key, {
            final: isLast,
            dashed: !wire.label,
            // The wording goes on the last hop, so one dependency yields one caption rather
            // than one per segment.
            ...(isLast && wire.label ? { label: wire.label } : {}),
          })
        })
        continue
      }
      side.push(wire)
    }
    return { carried, side }
  }, [visibleWires, parents])
  const carriedLinks = routing.carried
  const sideWires = routing.side

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ ...tiny, flex: 1 }}>
          {nodes.length} 个节点 ·{' '}
          <span style={{ color: DEPENDENCY_COLOR }}>{wires.length} 条依赖</span>
          {unexplained > 0 ? `（${unexplained} 条未说明需要什么）` : ''} · 点节点看它的上下游
        </span>
        <button style={buttonStyle} onClick={() => zoomBy(1.15)} title="放大">
          +
        </button>
        <button style={buttonStyle} onClick={() => zoomBy(1 / 1.15)} title="缩小">
          −
        </button>
        <button style={buttonStyle} onClick={fit} title="适配窗口">
          适配
        </button>
        <button
          style={buttonStyle}
          onClick={() => {
            movedRef.current = {}
            setMoved({})
            props.onSaveLayout({})
          }}
          title="丢弃手动位置，回到自动排布"
        >
          重排
        </button>
      </div>

      <div
        ref={surface}
        style={layerStyle}
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget) return
          pan.current = {
            startX: event.clientX,
            startY: event.clientY,
            originX: view.x,
            originY: view.y,
          }
        }}
        onWheel={(event) => {
          const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08
          setView((current) => ({
            ...current,
            scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor)),
          }))
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            transformOrigin: '0 0',
            width: 1,
            height: 1,
          }}
        >
          <svg
            style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible' }}
          >
            <defs>
              <marker
                id="atlas-dep-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L8,4 L0,8 Z" fill={DEPENDENCY_COLOR} />
              </marker>
            </defs>

            {/* Structure: thin and neutral, so it reads as scaffolding rather than a claim.
                A hierarchy link that carries a dependency is recoloured instead of being
                duplicated by a second wire — the line is already there. */}
            {links.map((link) => {
              const from = positions[link.from]
              const to = positions[link.to]
              if (!from || !to) return null
              const key = `${link.from}->${link.to}`
              const carried = carriedLinks.get(key)
              const lit =
                !props.selectedId || link.from === props.selectedId || link.to === props.selectedId
              const caption = carried?.label
                ? carried.label.length > 16
                  ? `${carried.label.slice(0, 16)}…`
                  : carried.label
                : undefined
              const midX = (from.x + CARD_W + to.x) / 2
              const midY = (from.y + to.y) / 2 + CARD_H / 2 - 3
              return (
                <g key={`h:${key}`}>
                  <path
                    d={curve(from, to)}
                    fill="none"
                    stroke={
                      carried ? DEPENDENCY_COLOR : 'var(--dsw-alias-border-default, rgba(128,128,128,0.45))'
                    }
                    strokeWidth={carried ? 2 : 1.1}
                    strokeDasharray={carried?.dashed ? '4 3' : undefined}
                    opacity={carried ? 1 : lit ? 0.9 : 0.4}
                    {...(carried?.final ? { markerEnd: 'url(#atlas-dep-arrow)' } : {})}
                  />
                  {/* A reused link has to carry the dependency's wording, or the colour says
                      "something is needed here" without saying what. */}
                  {caption && showLabels ? (
                    <text x={midX} y={midY} textAnchor="middle" fontSize={9} fill={DEPENDENCY_COLOR}>
                      {caption}
                    </text>
                  ) : null}
                </g>
              )
            })}

            {/* Dependencies wait for a click: on a large plan every wire at once is a thicket.
                Selecting a node shows exactly the wires that touch it — what it waits for, and
                what waits for it. */}
            {sideWires.map((wire) => {
              const from = positions[wire.from]
              const to = positions[wire.to]
              if (!from || !to) return null
              const caption = wire.label
                ? wire.label.length > 16
                  ? `${wire.label.slice(0, 16)}…`
                  : wire.label
                : undefined
              const apex = sideCurveApex(from, to)
              return (
                <g key={`d:${wire.from}->${wire.to}`} opacity={1}>
                  <path
                    d={sideCurve(from, to)}
                    fill="none"
                    stroke={DEPENDENCY_COLOR}
                    strokeWidth={1.9}
                    strokeDasharray={wire.label ? undefined : '4 3'}
                    markerEnd="url(#atlas-dep-arrow)"
                  />
                  {caption && showLabels ? (
                    <text
                      x={apex.x}
                      y={apex.y}
                      textAnchor="middle"
                      fontSize={9}
                      fill={DEPENDENCY_COLOR}
                    >
                      {caption}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </svg>

          {nodes.map((node) => {
            const point = positions[node.id]
            if (!point) return null
            const selected = node.id === props.selectedId
            const neighbour = !selected && isNeighbour(node.id)
            const dimmed = Boolean(props.selectedId) && !selected && !neighbour
            const isModule = node.kind === 'module'
            const isRoot = node.kind === 'project'
            const childCount = childCounts.get(node.id) ?? 0
            return (
              <div
                key={node.id}
                style={{
                  position: 'absolute',
                  left: point.x,
                  top: point.y,
                  width: CARD_W,
                  minHeight: CARD_H,
                  boxSizing: 'border-box',
                  padding: '5px 7px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  borderRadius: 6,
                  // A neutral translucent fill instead of a hardcoded dark surface: the same
                  // card has to be legible on a light panel and a dark one, and a fixed colour
                  // made one of them unreadable (the labels vanished into the card).
                  background: 'var(--dsw-alias-surface-raised, rgba(127,127,127,0.14))',
                  color: 'var(--dsw-alias-text-primary, inherit)',
                  // Three tiers, so "which one am I looking at" never needs re-reading.
                  border: `1px solid ${
                    selected
                      ? STATUS_COLOR[node.status]
                      : neighbour
                        ? 'var(--dsw-alias-text-secondary, #8b949e)'
                        : 'var(--dsw-alias-border-default, rgba(128,128,128,0.35))'
                  }`,
                  boxShadow: selected
                    ? `0 0 0 2px ${STATUS_COLOR[node.status]}55`
                    : neighbour
                      ? '0 0 0 1px var(--dsw-alias-text-secondary, #8b949e)'
                      : undefined,
                  opacity: dimmed ? 0.45 : 1,
                  cursor: dragging === node.id ? 'grabbing' : 'grab',
                  userSelect: 'none',
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  const point2 = toCanvas(event.clientX, event.clientY)
                  drag.current = {
                    id: node.id,
                    offsetX: point2.x - point.x,
                    offsetY: point2.y - point.y,
                  }
                  setDragging(node.id)
                }}
                onClick={() => props.onSelect(node.id)}
                title={node.title}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: isRoot ? 12 : isModule ? 11.5 : 11,
                    lineHeight: '15px',
                    fontWeight: isRoot ? 700 : isModule ? 620 : 520,
                  }}
                >
                  {node.id === props.project.focusedNodeId ? (
                    // Same marker as the tree: a star means "the live node", a dot means status.
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: 11,
                        lineHeight: '14px',
                        color: FOCUS_COLOR,
                      }}
                      title="当前在做的节点"
                    >
                      ★
                    </span>
                  ) : (
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                        background: STATUS_COLOR[node.status],
                      }}
                    />
                  )}
                  <span
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {shortLabel(node.title).label}
                  </span>
                  {childCount > 0 ? (
                    // On the right, and big enough to hit: the previous 9 px caret on the left
                    // was both hard to click and the only way back out of a collapsed branch.
                    <button
                      style={{
                        marginLeft: 'auto',
                        flexShrink: 0,
                        minWidth: 20,
                        height: 16,
                        padding: '0 4px',
                        borderRadius: 3,
                        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.45))',
                        background: 'transparent',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 10,
                        lineHeight: '14px',
                        opacity: 0.9,
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleCollapse(node.id)
                      }}
                      title={collapsed.has(node.id) ? `展开 ${childCount} 个` : '收起'}
                    >
                      {collapsed.has(node.id) ? `▸${childCount}` : '▾'}
                    </button>
                  ) : null}
                </span>
                <span style={tiny}>
                  {STATUS_LABEL[node.status]}
                  {(node.needs?.length ?? 0) > 0 ? ` · 需 ${node.needs?.length}` : ''}
                  {(node.outputs?.length ?? 0) > 0 ? ` · 产出 ${node.outputs?.length}` : ''}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
