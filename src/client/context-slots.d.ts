/**
 * Ambient type face for the `slots` service the DSH web shell provides.
 *
 * Why this file exists: the service is real at runtime — DSH's own client
 * plugins call `ctx.slots.inject(...)` / `ctx.slots.register(...)` (see
 * `@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js`) — but none of the
 * `@deepseek-ai/*` type packages published for 0.2.0-rc.2 declares
 * `Context.slots`, so a third-party plugin has to supply the declaration
 * itself. Supplying it locally also keeps our own typechecking honest: the
 * two members below are the entire surface this plugin touches, and widening
 * them is a deliberate act rather than an accidental `any`.
 *
 * `SlotCore` comes from the real package, so `register` keeps its full
 * key/entry-key/children/store/locale generic checking against the `SlotMap`
 * augmentations contributed by the packages we import for types.
 */
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The browser slot registry: declare children, then register components into them. */
    slots: SlotCore & {
      /**
       * Run `callback` once the slot named by `key` is declared, and again for
       * every later declaration lifecycle; the returned disposer is released
       * automatically with the owner's fiber.
       * @param key - slot name to wait for.
       * @param callback - contributes into that slot and returns its disposer.
       * @returns disposer that cancels the wait.
       */
      inject(key: string, callback: () => () => void): () => void
    }
  }
}
