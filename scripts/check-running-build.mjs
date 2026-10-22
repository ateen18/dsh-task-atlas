// Is the *running* app serving the *current* build?
//
// Tonight's failures shared one shape: a command reported success while nothing had
// happened. Restarts were the worst case — the script that killed the harness was
// itself a child of that harness, so it died mid-kill and the old build kept serving
// while the log said "relaunched".
//
// This turns that guess into a measurement:
//   1. compare the build timestamps with the serving process's start time;
//   2. probe the plugin's own routes and report what actually answered.
//
// Exit code 0 means "the running app has this build", 1 means "it does not".

import { readdirSync, statSync } from 'node:fs'

const PORT = process.argv[2]
if (!PORT) {
  console.error('usage: node scripts/check-running-build.mjs <port>')
  process.exit(2)
}

// ---- 1. build time ------------------------------------------------------------
const artefacts = ['lib/index.js', 'lib/client.js']
let newest = 0
for (const file of artefacts) {
  try {
    const at = statSync(file).mtimeMs
    newest = Math.max(newest, at)
    console.log(`${file.padEnd(16)} ${new Date(at).toISOString()}`)
  } catch {
    console.error(`${file} is missing — run pnpm run build`)
    process.exit(2)
  }
}

// ---- 2. who is serving, and when did it start --------------------------------
// The GUI port is passed in, so we compare against the process that owns it.
const { execFileSync } = await import('node:child_process')
let servingStart = 0
let servingPid = 0
try {
  const raw = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `$c = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($c) { $p = Get-Process -Id $c.OwningProcess; "$($p.Id)|$($p.StartTime.ToUniversalTime().ToString('o'))" }`,
    ],
    { encoding: 'utf8' },
  ).trim()
  if (raw) {
    const [pid, started] = raw.split('|')
    servingPid = Number(pid)
    servingStart = Date.parse(started)
    console.log(`serving pid ${servingPid} started ${new Date(servingStart).toISOString()}`)
  }
} catch (error) {
  console.error(`could not read the serving process: ${error.message}`)
}

if (servingStart > 0) {
  // A process cannot load code written after it started.
  const stale = servingStart < newest
  console.log(
    stale
      ? `STALE: the app started ${Math.round((newest - servingStart) / 1000)}s BEFORE this build — it is running old code`
      : 'build is older than the process: the app is running this build',
  )
  if (stale) process.exitCode = 1
}

// ---- 3. what the routes actually answer --------------------------------------
async function probeState() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/task-atlas/state`)
    const body = await response.json()
    console.log(`/task-atlas/state  ${response.status} ${body.ok ? 'ok' : body.code}`)
    return response.status === 200 && body.ok === true
  } catch (error) {
    console.log(`/task-atlas/state  FAILED ${error.message}`)
    return false
  }
}

/**
 * The change stream never completes by design, so a timeout means success and a
/**
 * The long-poll route must answer *immediately* when the caller is behind — that is
 * the whole contract. Asking with a deliberately impossible revision exercises the
 * route, the change feed and the JSON shape in one request; a 404 here means the
 * running build predates the route.
 */
async function probeWait() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/task-atlas/wait?revision=999999`)
    const body = await response.json()
    if (body.ok === true && typeof body.revision === 'number') {
      console.log(`/task-atlas/wait ${response.status} revision=${body.revision} — change feed is live`)
      return true
    }
    console.log(`/task-atlas/wait ${response.status} ${body.code ?? JSON.stringify(body)}`)
    return false
  } catch (error) {
    console.log(`/task-atlas/wait FAILED ${error.message}`)
    return false
  }
}

const stateOk = await probeState()
const waitOk = await probeWait()
if (!stateOk || !waitOk) process.exitCode = 1

// ---- 4. how many documents are on disk --------------------------------------
try {
  const home = process.env.DSH_HOME ?? `${process.env.USERPROFILE}\\.dsh`
  const dir = `${home}/storages/dsh_task_atlas/documents`
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  console.log(`stored documents: ${files.length} (${files.join(', ')})`)
} catch {
  console.log('stored documents: could not read the storage directory')
}
