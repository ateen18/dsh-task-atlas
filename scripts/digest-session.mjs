// Dev utility: dig a prior session's log out of DSH_HOME and print a digest.
//
// Session logs are zstd-compressed JSONL under
//   $DSH_HOME/sessions/<encoded-workspace>/<sessionId>/session.v<N>.jsonl.zstd
// and reading them is how kickoff reconstructs a project blueprint from work that
// already happened. Not shipped: package.json's `files` whitelist excludes this.

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const [, , sessionIdArg, maxCharsArg] = process.argv
const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const sessionsRoot = path.join(DSH_HOME, 'sessions')
const maxChars = Number(maxCharsArg ?? 1200)

if (!sessionIdArg) {
  console.error('usage: node scripts/digest-session.mjs <sessionId> [assistantChars]')
  process.exit(2)
}

function findSessionDir() {
  for (const workspace of readdirSync(sessionsRoot)) {
    const candidate = path.join(sessionsRoot, workspace, sessionIdArg)
    if (existsSync(candidate)) return { dir: candidate, workspace }
  }
  return undefined
}

function loadEvents(dir) {
  const files = readdirSync(dir).filter((name) => name.startsWith('session') && name.includes('.jsonl'))
  if (files.length === 0) throw new Error(`no session log in ${dir}`)
  // Newest generation wins.
  files.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  const file = path.join(dir, files[0])
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd')
    ? zstdDecompressSync(raw).toString('utf8')
    : raw.toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* torn tail line */
    }
  }
  return { file, events }
}

/** Best-effort text of one content value (string, block array, or message object). */
function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.content === 'string') return value.content
    if (value.content) return textOf(value.content)
    if (value.message) return textOf(value.message)
  }
  return ''
}

const found = findSessionDir()
if (!found) {
  console.error(`session ${sessionIdArg} not found under ${sessionsRoot}`)
  process.exit(1)
}

const { file, events } = loadEvents(found.dir)
const counts = new Map()
const userMessages = []
const assistantMessages = []
let lastTurnEnd

for (const event of events) {
  const type = typeof event.type === 'string' ? event.type : '(none)'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (type === 'user/message') {
    const text = textOf(event.data).trim()
    if (text) userMessages.push(text)
  }
  if (type === 'assistant/message') {
    const text = textOf(event.data).trim()
    if (text) assistantMessages.push(text)
  }
  if (type === 'turn/end') lastTurnEnd = event.data
}

console.log(`workspace : ${found.workspace}`)
console.log(`session   : ${sessionIdArg}`)
console.log(`log file  : ${path.basename(file)}  (${events.length} events)`)
console.log(`event mix : ${[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join('  ')}`)
console.log(`last turn : ${JSON.stringify(lastTurnEnd)?.slice(0, 200) ?? '(none)'}`)
console.log(`messages  : ${userMessages.length} user / ${assistantMessages.length} assistant`)

console.log('\n================ USER MESSAGES ================')
userMessages.forEach((text, index) => {
  console.log(`\n--- #${index + 1} (${text.length} chars) ---`)
  console.log(text.length > maxChars ? `${text.slice(0, maxChars)}\n…[+${text.length - maxChars}]` : text)
})

console.log('\n================ ASSISTANT MESSAGES (head) ================')
assistantMessages.forEach((text, index) => {
  const head = text.length > 400 ? `${text.slice(0, 400)}…` : text
  console.log(`\n--- A#${index + 1} (${text.length} chars) ---\n${head}`)
})
