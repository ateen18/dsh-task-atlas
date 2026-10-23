/**
 * `dsh-task-atlas` — browser half.
 *
 * Loaded from `/plugins/dsh-task-atlas/client.js` as a lazy CJS factory (see
 * `tsdown.config.ts`). Registers the plugin's right-sidebar tab in the two
 * stages the sidebar contract requires:
 *
 *   1. the tab TYPE into `ctx.sidebarRightTabs` (static: what it is, how it ranks,
 *      what its chip says, whether it appears on the guide page);
 *   2. the tab BODY into the keyed `sidebar.right.pane.tab` seat, under the same
 *      definition `id`.
 *
 * Runtime information (which pane, which tab, is it visible, its navigator) is
 * pushed into the body by the framework through `useTabInfo()`; components never
 * receive `ctx`.
 */
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { AtlasBody } from './AtlasBody.tsx'
import { AtlasFooterAction } from './footer-action.tsx'

/** Cordis plugin name (matches the host half and the patch row id). */
export const name = 'task-atlas'

/** Services this plugin waits for before `apply` runs. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

/** Implementation identity of our tab type; also the key our body registers under. */
const TAB_TYPE_ID = 'dsh-task-atlas'

/** Type discriminator `ctx.sidebarRight.openTab()` names. */
const TAB_KIND = 'task-atlas'

/** Tab chip text, captured into the layout record at open time. */
const TAB_TITLE = '任务图谱'

/**
 * Browser-half entry point.
 * @param ctx - client root context carrying the slot registry and the sidebar face.
 */
export function apply(ctx: Context): void {
  // ---- stage 1: the tab type ------------------------------------------------
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_TYPE_ID,
        kind: TAB_KIND,
        // Lazily keep a visited body mounted across hiding, Session switches and
        // docking, so in-panel state (expanded nodes, view mode) survives a
        // session switch within the same page.
        keepMounted: true,
        // A page type: it is opened by `kind`, and recognizes no resource address.
        title: () => TAB_TITLE,
        guide: [
          {
            id: TAB_TYPE_ID,
            order: 60,
            title: () => TAB_TITLE,
            description: () => '项目蓝图与任务树：当前做到哪、还剩什么、为什么分支',
          },
        ],
      }),
    'task-atlas: tab type',
  )

  // ---- stage 2: the tab body ----------------------------------------------
  /**
   * The body, plus the one shell action it cannot reach itself.
   *
   * Opening the dependency canvas wants a wider column. `ctx.sidebarRight` is only available
   * here (components never receive `ctx`), so the widening request is passed in as a prop
   * rather than reached for from inside the render.
   */
  const BodyWithShell = (props: Parameters<typeof AtlasBody>[0]) => {
    const expand = (): void => {
      try {
        if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
      } catch {
        // No session on screen: the canvas still opens, just at the width it has.
      }
    }
    return createElement(AtlasBody, { ...props, onExpand: expand })
  }
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: TAB_TYPE_ID },
          BodyWithShell,
        ),
      ),
    'task-atlas: tab body',
  )

  // ---- stage 3: a permanent way in ---------------------------------------
  // A registered tab TYPE does not open a tab, and the right column starts
  // collapsed after every reload. Without this button the only ways in are the
  // guide page and the tab strip's new-tab control — both of which a user has to
  // already know about.
  const openAtlas = (): void => {
    try {
      ctx.sidebarRight.openTab(TAB_KIND)
    } catch {
      // No mounted session surface yet (first paint, or no conversation open).
      // Nothing to do: the button is still there once one is.
    }
  }

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: TAB_TYPE_ID,
            order: 40,
            label: () => TAB_TITLE,
            inject: () => ({ openAtlas }),
          },
          AtlasFooterAction,
        ),
      ),
    'task-atlas: footer action',
  )
}
