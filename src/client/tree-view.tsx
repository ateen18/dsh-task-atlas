/**
 * Compact tree view.
 *
 * The default view, because the question the panel answers most often is "where
 * am I and what is left", and an indented list answers that faster than any
 * diagram. Density is the feature: one line per node, reason text inline, no
 * truncation of titles.
 */
import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { collectNodes } from '../model/tree.ts'
import type { AtlasNode, AtlasProject } from '../model/types.ts'
import { shortLabel } from '../model/title.ts'
import { STATUS_COLOR, STATUS_LABEL, STATUS_TINT } from './labels.ts'

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 6,
  padding: '3px 4px',
  borderRadius: 5,
  cursor: 'pointer',
  lineHeight: '18px',
  fontSize: 12.5,
}

const twisty: CSSProperties = {
  width: 12,
  flexShrink: 0,
  textAlign: 'center',
  color: 'var(--dsw-alias-text-tertiary, #8b949e)',
  fontSize: 10,
  lineHeight: '18px',
  userSelect: 'none',
}

/**
 * One line, always.
 *
 * Titles used to wrap, and a node whose title was a sentence made the whole tree
 * unreadable — four-line rows mean you cannot scan for "what is left". The full text is
 * still there on hover and in the detail card; the row is for scanning.
 */
const titleText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const chip: CSSProperties = {
  flexShrink: 0,
  fontSize: 10.5,
  lineHeight: '14px',
  padding: '1px 5px',
  borderRadius: 4,
  border: '1px solid currentColor',
  opacity: 0.9,
}

const badge: CSSProperties = {
  ...chip,
  border: 'none',
  background: 'var(--dsw-alias-surface-sunken, rgba(128,128,128,0.18))',
  color: 'var(--dsw-alias-text-secondary, #8b949e)',
}

/**
 * The ids to start collapsed: everything except the top two levels and the focused
 * path, so the current work is visible without a single click.
 *
 * Exported because the collapse state lives in the panel shell, not in this
 * component: switching views used to unmount the tree and throw the user's
 * expansion choices away.
 * @param project - the project to inspect.
 * @returns the collapsed set to hand to {@link TreeView}.
 */
export function initialCollapsed(project: AtlasProject): Set<string> {
  const keep = new Set<string>()
  for (const node of collectNodes(project.root)) {
    if (node.children.length === 0) continue
    const depth = node.kind === 'project' ? 0 : node.kind === 'module' ? 1 : 2
    if (depth <= 1) keep.add(node.id)
  }
  // Always reveal the focused path, whatever its depth.
  const all = collectNodes(project.root)
  const cursor: AtlasNode | undefined = project.focusedNodeId
    ? all.find((node) => node.id === project.focusedNodeId)
    : undefined
  if (cursor) {
    const parentOf = new Map<string, string>()
    for (const node of all) for (const child of node.children) parentOf.set(child.id, node.id)
    let id: string | undefined = cursor.id
    while (id) {
      keep.add(id)
      id = parentOf.get(id)
    }
  }
  return new Set(
    all.filter((node) => node.children.length > 0 && !keep.has(node.id)).map((node) => node.id),
  )
}

/** Props for {@link TreeView}. */
export interface TreeViewProps {
  readonly project: AtlasProject
  readonly selectedId?: string
  readonly onSelect: (id: string) => void
  /** Collapsed node ids; owned by the panel so the choice survives view switches. */
  readonly collapsed: ReadonlySet<string>
  /** Toggle one node's children. */
  readonly onToggle: (id: string) => void
}

/**
 * Render the project as a collapsible indented tree.
 *
 * This is the *working* view: dense, reasons inline, titles never truncated, and the
 * focused path opened automatically. The mind map is the structural view; the two
 * are deliberately not the same.
 * @param props - project, selection, and the shared collapse control.
 * @returns the tree.
 */
export function TreeView(props: TreeViewProps) {
  const { project, selectedId, onSelect, collapsed, onToggle } = props
  const toggle = onToggle

  const renderNode = (node: AtlasNode, depth: number): JSX.Element[] => {
    const isCollapsed = collapsed.has(node.id)
    const selected = node.id === selectedId
    const focused = node.id === project.focusedNodeId
    const rows: JSX.Element[] = []

    rows.push(
      <div
        key={node.id}
        role="treeitem"
        aria-selected={selected}
        onClick={() => onSelect(node.id)}
        // The row shows one line; hovering gives the whole title back.
        title={node.title}
        style={{
          ...row,
          paddingLeft: 4 + depth * 12,
          background: selected
            ? 'var(--dsw-alias-surface-selected, rgba(47,129,247,0.16))'
            : undefined,
        }}
      >
        <span
          style={twisty}
          onClick={(event) => {
            if (node.children.length === 0) return
            event.stopPropagation()
            toggle(node.id)
          }}
        >
          {node.children.length === 0 ? '·' : isCollapsed ? '▸' : '▾'}
        </span>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            marginTop: 6,
            flexShrink: 0,
            background: STATUS_COLOR[node.status],
            // The current node gets a halo so "where am I" needs no reading.
            boxShadow: focused ? `0 0 0 2px ${STATUS_COLOR[node.status]}` : undefined,
          }}
          title={STATUS_LABEL[node.status]}
        />
        <span style={titleText}>{shortLabel(node.title).label}</span>
        {node.branch ? <span style={badge}>⑂ 分支</span> : null}
        {/* Upstream count, so "what this waits for" is visible in the tree too and
            you do not have to switch to the graph to notice it. */}
        {node.dependsOn && node.dependsOn.length > 0 ? (
          <span style={badge} title={node.dependsOn.join(', ')}>
            ⇢ 前置 {node.dependsOn.length}
          </span>
        ) : null}
        {/* Always shown: the state of a module is a headline fact, not a detail
            revealed after a click. */}
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            lineHeight: '15px',
            padding: '1px 6px',
            borderRadius: 4,
            fontWeight: 500,
            color: STATUS_COLOR[node.status],
            background: STATUS_TINT[node.status],
          }}
        >
          {STATUS_LABEL[node.status]}
        </span>
      </div>,
    )

    if (node.reason) {
      rows.push(
        <div
          key={`${node.id}:reason`}
          title={node.reason}
          style={{
            paddingLeft: 22 + depth * 12,
            fontSize: 11.5,
            lineHeight: '16px',
            color: STATUS_COLOR[node.status],
            opacity: 0.95,
            // One line: a long "why" is worth reading in the detail card, not in the
            // middle of a list you are scanning.
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {node.reason}
        </div>,
      )
    }

    if (!isCollapsed) {
      for (const child of node.children) rows.push(...renderNode(child, depth + 1))
    }
    return rows
  }

  const content = useMemo(
    () => renderNode(project.root, 0),
    // Re-render when the tree or the collapse set changes.
    [project, collapsed, selectedId, onSelect],
  )

  return (
    <div role="tree" style={{ display: 'flex', flexDirection: 'column' }}>
      {content}
    </div>
  )
}
