/**
 * Wiring test: does a compaction event actually cause a re-injection?
 *
 * The unit tests already prove `InjectionTracker` forgets a signature when told to. What
 * they cannot prove is that anything ever tells it — that is the `session/event` →
 * pre-step wiring, which previously had no test at all and was therefore only ever
 * "unverified". Waiting for a real compaction to occur is not a test plan; this drives
 * the real `apply()` against a hand-built context and fires the event itself.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import type { AtlasDocument } from '../src/model/types.ts'

const WORKSPACE = 'D:\\wiring-workspace'
const SESSION_ID = 'sess-wiring'

type Listener = (...args: never[]) => unknown

interface Fake {
  tools: ToolDefinition[]
  listeners: Map<string, Listener[]>
}

function makeTable() {
  const raw = new Map<string, AtlasDocument>()
  return {
    get: (key: string) => raw.get(key),
    async put(key: string, value: AtlasDocument) {
      raw.set(key, value)
    },
    async update(key: string, fn: (current: AtlasDocument) => AtlasDocument) {
      const current = raw.get(key)
      if (current === undefined) throw new Error('missing-key')
      const next = fn(current)
      raw.set(key, next)
      return next
    },
    async delete(key: string) {
      return raw.delete(key)
    },
    entries: () => raw.entries(),
    keys: () => raw.keys(),
  }
}

function makeContext(): { ctx: Context; fake: Fake } {
  const fake: Fake = { tools: [], listeners: new Map() }
  const ctx = {
    effect(fn: () => unknown) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') (dispose as () => void)()
      }
    },
    on(event: string, listener: Listener) {
      const list = fake.listeners.get(event) ?? []
      list.push(listener)
      fake.listeners.set(event, list)
      return () => {}
    },
    inject(dependencies: string[], callback: (scoped: unknown) => void) {
      // Only storage is needed here: the injection path does not use the corpus.
      if (dependencies.includes('storageDomain')) {
        callback({ storageDomain: ctx.storageDomain, effect: ctx.effect })
      }
      return () => {}
    },
    logger() {
      return { info: () => {}, warn: () => {} }
    },
    tools: {
      register(definition: ToolDefinition) {
        fake.tools.push(definition)
        return () => {}
      },
    },
    webServer: {
      register() {
        return () => {}
      },
    },
    storageDomain: {
      async open(spec: { name: string }) {
        const table = makeTable()
        return {
          name: spec.name,
          table: () => table,
          async close() {},
        }
      },
    },
  }
  return { ctx: ctx as unknown as Context, fake }
}

function session() {
  return { id: SESSION_ID, header: { cwd: WORKSPACE } }
}

/** Text of one message object, as the harness stores it. */
function textOf(message: unknown): string {
  const content = (message as { content?: readonly { type?: string; text?: string }[] })?.content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block?.type === 'text' ? (block.text ?? '') : '')).join('\n')
}

/** Run one pre-step through the registered hook. */
async function preStep(fake: Fake, text: string) {
  const hook = fake.listeners.get('agent/pre-step')?.[0] as
    | ((payload: unknown, next: unknown) => Promise<{ kind: string; messages?: unknown[] }>)
    | undefined
  assert.ok(hook, 'the plugin must register an agent/pre-step hook')
  const advance = async () => ({ kind: 'enter' as const, messages: [] })
  return hook(
    {
      agent: { session: session() },
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      turn: 1,
      step: 1,
    },
    advance,
  )
}

describe('compaction re-anchoring (wiring)', () => {
  it('re-injects with the compaction line after a compaction event', async () => {
    const { ctx, fake } = makeContext()
    await apply(ctx, { exportMarkdown: false })

    const confirm = fake.tools.find((tool) => tool.name === 'atlas_breakdown_confirm')
    assert.ok(confirm, 'atlas_breakdown_confirm must be registered')
    const created = (await confirm.execute(
      {
        title: '接线测试项目',
        coreIntent: '让长对话不丢主线',
        deliverables: [{ text: '面板', acceptance: '能看到树' }],
        decomposition: ['面板'],
        acceptance: '刷新后仍在',
        mode: 'fast',
      },
      { agent: { session: session() } } as never,
    )) as { ok: boolean }
    assert.equal(created.ok, true)

    // 1. first step injects the state (nothing seen yet)
    const first = await preStep(fake, '继续推进面板')
    const firstText = textOf(first.messages?.[0])
    assert.match(firstText, /\[任务图谱\]/)
    assert.doesNotMatch(firstText, /上下文刚被压缩过/, 'no compaction has happened yet')

    // 2. the same state does not inject again — this is the dedupe the feature must beat
    const second = await preStep(fake, '继续推进面板')
    assert.equal(second.messages?.length ?? 0, 0, 'unchanged state must not re-inject')

    // 3. a compaction arrives through the same event bus the harness uses
    const sessionListeners = fake.listeners.get('session/event') ?? []
    assert.ok(sessionListeners.length > 0, 'the plugin must subscribe to session/event')
    for (const listener of sessionListeners) {
      ;(listener as unknown as (s: unknown, e: unknown) => void)(session(), { type: 'compaction/end' })
    }

    // 4. the very next step must re-inject, and say why
    const third = await preStep(fake, '继续推进面板')
    const thirdText = textOf(third.messages?.[0])
    assert.match(thirdText, /上下文刚被压缩过/, 'the re-anchored injection must carry the line')
    assert.match(thirdText, /任务图谱没有被压缩/)

    // 5. the reminder is consumed: the following step is quiet again
    const fourth = await preStep(fake, '继续推进面板')
    assert.equal(fourth.messages?.length ?? 0, 0, 'the compaction notice is not repeated')
  })
})
