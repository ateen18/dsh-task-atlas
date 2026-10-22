// Count session event types in a multi-frame zstd session log.
//
// Why frame-by-frame: the log is thousands of independently compressed zstd frames
// concatenated, and Node's zstd *stream* stops after the first one ("Unknown frame
// descriptor"). An earlier script read that stream and concluded the log held only the
// header — a wrong conclusion produced by a tool nobody checked.
//
// So: find every frame magic (28 b5 2f fd), decompress each slice, drop slices that do
// not decompress, and count what is inside.
//
// Usage: node scripts/count-session-events.mjs <session.v4.jsonl.zstd>

import { readFileSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/count-session-events.mjs <log.zstd>')
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

const counts = new Map()
let atlasLines = 0
let compactionNotice = 0
let lines = 0
let parsed = 0
let framesOk = 0
let framesBad = 0

const mark = (type) => counts.set(type, (counts.get(type) ?? 0) + 1)

function consume(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    lines += 1
    let event
    try {
      event = JSON.parse(line)
      parsed += 1
    } catch {
      continue
    }
    if (typeof event?.type === 'string') mark(event.type)
    if (line.includes('[任务图谱]')) atlasLines += 1
    if (line.includes('上下文刚被压缩过')) compactionNotice += 1
  }
}

for (let index = 0; index < offsets.length; index += 1) {
  const start = offsets[index]
  const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
  try {
    const out = zstdDecompressSync(buf.subarray(start, end))
    framesOk += 1
    consume(out.toString('utf8'))
  } catch {
    // Either a false magic inside a payload (harmless: the real frame that contains
    // it decodes on its own) or a truncated tail frame being written right now.
    framesBad += 1
  }
}

console.log(`file: ${path}  (${(statSync(path).size / 1024 / 1024).toFixed(1)} MB)`)
console.log(`frames: ${offsets.length} found, ${framesOk} decoded, ${framesBad} skipped`)
console.log(`jsonl lines: ${lines}  (parsed as JSON: ${parsed})`)
console.log('')
console.log('event types (desc):')
for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(6)}  ${type}`)
}
console.log('')
const compaction = [...counts].filter(([type]) => type.startsWith('compaction/'))
console.log(
  `compaction events: ${compaction.length === 0 ? 'NONE' : compaction.map(([t, n]) => `${t}×${n}`).join(', ')}`,
)
console.log(`lines containing [任务图谱]: ${atlasLines}`)
console.log(`lines containing 上下文刚被压缩过: ${compactionNotice}`)
