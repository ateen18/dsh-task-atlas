// Dev utility: validate a stored atlas record against the schema the plugin uses.
//
//   node scripts/check-storage.mjs [workspaceKey]
//
// Reads $DSH_HOME/storages/dsh_task_atlas/documents/*.json. A record that stops
// matching its schema does not produce a visible error — the domain refuses to
// open, the plugin reports STARTUP_FAILED, and the tree looks lost. This turns
// "which field broke" into one command.
//
// Not shipped: package.json's `files` whitelist excludes this directory.

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atlasDocumentSchema } from '../src/store/domain.ts'

const DSH_HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh')
const directory = path.join(DSH_HOME, 'storages', 'dsh_task_atlas', 'documents')
const wanted = process.argv[2]

const files = readdirSync(directory).filter(
  (name) => name.endsWith('.json') && (wanted === undefined || name.includes(wanted)),
)

if (files.length === 0) {
  console.error(`no records in ${directory}${wanted ? ` matching ${wanted}` : ''}`)
  process.exit(1)
}

let bad = 0
for (const name of files) {
  const raw = readFileSync(path.join(directory, name), 'utf8')
  const parsed = JSON.parse(raw)
  const record = parsed?.record ?? parsed
  const result = atlasDocumentSchema.safeParse(record)
  if (result.success) {
    const projects = result.data.projects.length
    const pending = result.data.pending.length
    console.log(`OK    ${name}  projects=${projects} pending=${pending}`)
    for (const project of result.data.projects) {
      const revisions = project.breakdown?.revisions?.length ?? 0
      console.log(
        `        project ${project.id} "${project.title}"  breakdown=${project.breakdown ? 'yes' : 'null'} revisions=${revisions}`,
      )
    }
  } else {
    bad += 1
    console.error(`BAD   ${name}`)
    for (const issue of result.error.issues.slice(0, 8)) {
      console.error(`        ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
  }
}

process.exit(bad === 0 ? 0 : 2)
