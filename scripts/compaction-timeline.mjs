// Timeline of compaction and atlas-injection events in a session log.
//
// Answers one question with evidence instead of inference: did the plugin re-inject the
// state *after* a real compaction? So it prints the compaction brackets and every
// user/message that carries the plugin's injected text, in seq order.
//
// Usage: node scripts/compaction-timeline.mjs <session.v4.jsonl.zstd>

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/compaction-timeline.mjs <log.zstd>')
  process.exit(2)
}

const buf = readFileSync(path)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 4 <= buf.length; i += 1) {
  if (
    buf[i] === MAGIC[0] &&
    buf[i + 1] === MAGIC[1] &&
    buf[i + 2] === MAGIC[2] &&
    buf[i + 3] === MAGIC[3]
  ) {
    offsets.push(i)
  }
}

const events = []
for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
  let out
  try {
    out = zstdDecompressSync(buf.subarray(start, end))
  } catch {
    continue
  }
  for (const line of out.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a torn line at a frame boundary */
    }
  }
}

/** Flatten a message event's content to plain text. */
function textOf(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

const stamp = (event) => new Date(event.time).toISOString().replace('T', ' ').slice(0, 19)

console.log(`events: ${events.length}`)
console.log('')
console.log('--- compaction brackets ---')
const compactions = events.filter((event) => String(event.type).startsWith('compaction/'))
for (const event of compactions) {
  if (event.type === 'compaction/prune') continue
  console.log(`  seq ${String(event.seq).padStart(6)}  ${stamp(event)}  ${event.type}`)
}
const prunes = compactions.filter((event) => event.type === 'compaction/prune').length
console.log(`  (+ ${prunes} compaction/prune)`)

console.log('')
console.log('--- user/message events carrying injected text ---')
// The prefix must be at position 0. A quoted note, a copied prompt, or a transcript
// that merely *mentions* the line would otherwise count as an injection — which is
// exactly how an earlier run of this script "verified" a path that never ran.
const injections = events.filter(
  (event) => event.type === 'user/message' && textOf(event).trimStart().startsWith('[任务图谱]'),
)
for (const event of injections) {
  const text = textOf(event).replace(/\s+/g, ' ')
  const notice = textOf(event).includes('上下文刚被压缩过') ? '  ← 带压缩提醒' : ''
  console.log(`  seq ${String(event.seq).padStart(6)}  ${stamp(event)}  ${text.slice(0, 60)}…${notice}`)
}
console.log(`  total injections: ${injections.length}`)

console.log('')
console.log('--- verdict ---')
const end = compactions.find((event) => event.type === 'compaction/end')
const firstInjection = injections[0]
if (!end) {
  console.log('  no compaction/end in this log: nothing to verify yet')
} else if (firstInjection && end.seq < firstInjection.seq) {
  // The handling code cannot have run before the feature that carries it existed. If the
  // compaction predates the very first injection, this log simply has no evidence either
  // way — calling it a failure would be as wrong as calling it verified.
  console.log(`  compaction/end at seq ${end.seq} (${stamp(end)})`)
  console.log(`  first injection at seq ${firstInjection.seq} (${stamp(firstInjection)})`)
  console.log('  UNEXERCISED: the compaction happened before any injection existed,')
  console.log('  so the re-anchor path was not running yet. Re-run after the next compaction.')
} else {
  const after = injections.filter((event) => event.seq > end.seq)
  const noticed = after.filter((event) => textOf(event).includes('上下文刚被压缩过'))
  console.log(`  compaction/end at seq ${end.seq} (${stamp(end)})`)
  console.log(`  injections after it: ${after.length}`)
  if (noticed.length > 0) {
    console.log(
      `  RE-ANCHORED: injection at seq ${noticed[0].seq} carried the compaction line — verified`,
    )
  } else {
    console.log('  NOT re-anchored: injections exist after the compaction but none carried the line')
  }
}

console.log('')
console.log('--- what triggered the compaction ---')
const commands = events.filter((event) => event.type === 'command/run' || event.type === 'command/done')
for (const event of commands) {
  console.log(
    `  seq ${String(event.seq).padStart(6)}  ${stamp(event)}  ${event.type}  ${JSON.stringify(event.data).slice(0, 120)}`,
  )
}
