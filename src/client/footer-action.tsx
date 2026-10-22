/**
 * Sidebar-footer entry point.
 *
 * Registering a tab TYPE is not the same as opening a tab: the type only shows up
 * on the right sidebar's guide page and in its new-tab control, and the column
 * starts collapsed after every reload. That is a discoverability dead end for a
 * panel whose whole value is being glanceable, so this button is the permanent
 * way in — one click opens (and reveals) the tab.
 *
 * It is deliberately defensive: if the slot or the navigation service is absent
 * on some build, the registration simply never fires and nothing breaks.
 */
import type { CSSProperties } from 'react'

const button: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '5px 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  textAlign: 'left',
  cursor: 'pointer',
}

const glyph: CSSProperties = {
  fontSize: 13,
  lineHeight: '18px',
  color: 'var(--dsw-alias-text-secondary, #8b949e)',
}

/** Props the registration injects. */
export interface AtlasFooterActionProps {
  /** Open the atlas tab and expand the right column. */
  readonly openAtlas?: () => void
}

/**
 * Footer button that opens the atlas tab.
 * @param props - injected navigation closure.
 * @returns the button.
 */
export function AtlasFooterAction(props: AtlasFooterActionProps) {
  return (
    <button
      type="button"
      style={button}
      title="打开任务图谱"
      aria-label="打开任务图谱"
      onClick={(event) => {
        event.stopPropagation()
        props.openAtlas?.()
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = 'var(--dsw-alias-surface-hover, rgba(128,128,128,0.14))'
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
      }}
    >
      <span style={glyph}>▤</span>
      <span>任务图谱</span>
    </button>
  )
}
