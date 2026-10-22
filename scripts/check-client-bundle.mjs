// Build guard: the client bundle may only require modules the shell provides.
//
// Why this exists as a hard failure: `lib/client.js` is loaded by the harness as a
// classic script and its `require` is resolved against the shell's frozen platform
// module table. A bare `require` for anything else does not degrade — it throws
// during client-module import, so the whole app fails to boot with
//   "1 entry did not activate ... import failed: client-modules: require(...) missed
//    the module table"
// and the user has to disable the plugin to get back in.
//
// That is far too expensive a mistake to catch at runtime, so it fails the build.
// If a third-party package is genuinely needed in the client, bundle it
// (`deps.alwaysBundle` in tsdown.config.ts) instead of requiring it.

import { readFileSync } from 'node:fs'

/** Modules the DSH shell materialises for client plugins. */
const PLATFORM_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

const source = readFileSync('lib/client.js', 'utf8')

const requested = new Set()
for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
  requested.add(match[1])
}
for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
  requested.add(match[1])
}

const offending = [...requested].filter((id) => !PLATFORM_MODULES.has(id))

if (offending.length > 0) {
  console.error('')
  console.error('client bundle requires modules the shell cannot provide:')
  for (const id of offending) console.error(`  - ${id}`)
  console.error('')
  console.error('These would throw at load time and stop the app from booting.')
  console.error('Either bundle them (tsdown.config.ts → deps.alwaysBundle) or remove the import.')
  console.error('')
  process.exit(1)
}

console.log(
  `client bundle OK: ${requested.size} platform request(s)` +
    (requested.size > 0 ? ` — ${[...requested].join(', ')}` : ''),
)
