/**
 * `ctx.storageDomain` adapter.
 *
 * The durable boundary is a zod-validated KV table: one record per workspace,
 * keyed by the hashed workspace path. Records are validated on read, so a
 * corrupted or hand-edited document fails loudly instead of half-loading.
 *
 * The adapter deliberately depends on a two-method structural view of the table
 * (`DocumentTable`) rather than the full `KvTable` generic dance: the only thing
 * this plugin needs is get/put/update, and keeping the surface that small is
 * what lets the same code be exercised without a storage backend.
 */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AtlasDocument, AtlasNode, Breakdown } from '../model/types.ts'
import { emptyDocument, type AtlasStore } from './document.ts'

const statusSchema = z.enum(['pending', 'active', 'done', 'rework', 'blocked', 'dropped'])
const kindSchema = z.enum(['project', 'module', 'task', 'item'])
const actorSchema = z.enum(['ai', 'user'])

const statusChangeSchema = z.object({
  at: z.number(),
  by: actorSchema,
  from: statusSchema,
  to: statusSchema,
  reason: z.string().optional(),
  confirmedBy: actorSchema.optional(),
})

const branchSchema = z.object({
  originId: z.string(),
  trigger: z.string(),
  returnCondition: z.string().optional(),
  resolvesTo: z.string().optional(),
  resolvedAt: z.number().optional(),
  resolution: z.string().optional(),
})

/** Recursive node schema; `z.lazy` keeps the self-reference legible. */
const nodeSchema: z.ZodType<AtlasNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: kindSchema,
    title: z.string(),
    note: z.string().optional(),
    status: statusSchema,
    reason: z.string().optional(),
    returnCondition: z.string().optional(),
    result: z.string().optional(),
    outputs: z
      .array(
        z.object({
          kind: z.enum(['url', 'file', 'dir']),
          label: z.string(),
          target: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    branch: branchSchema.optional(),
    dependsOn: z.array(z.string()).optional(),
    assignee: z.string().optional(),
    needs: z
      .array(
        z.object({
          label: z.string(),
          fromNodeId: z.string().optional(),
          satisfied: z.boolean().optional(),
        }),
      )
      .optional(),
    origin: actorSchema,
    evidence: z.array(z.string()).optional(),
    history: z.array(statusChangeSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
    children: z.array(nodeSchema),
  }),
) as z.ZodType<AtlasNode>

const breakdownFieldSchema = z.enum([
  'coreIntent',
  'deliverables',
  'decomposition',
  'acceptance',
  'outOfScope',
  'constraints',
  'priorityOrder',
  'mode',
])

const breakdownRevisionSchema = z.object({
  at: z.number(),
  by: actorSchema,
  reason: z.string(),
  changes: z.array(
    z.object({ field: breakdownFieldSchema, from: z.string(), to: z.string() }),
  ),
})

const breakdownSchema: z.ZodType<Breakdown> = z.object({
  coreIntent: z.string(),
  deliverables: z.array(z.object({ text: z.string(), acceptance: z.string() })),
  decomposition: z.array(z.string()),
  acceptance: z.string(),
  outOfScope: z.array(z.string()),
  constraints: z.array(z.string()),
  priorityOrder: z.array(z.string()),
  mode: z.enum(['fast', 'detailed']),
  confirmedAt: z.number(),
  revisions: z.array(breakdownRevisionSchema).optional(),
}) as z.ZodType<Breakdown>

/**
 * One project record.
 *
 * Accepts the legacy `charter` key and normalises it to `breakdown`: the field was
 * renamed in code while records on disk still used the old name, and because the
 * key was required the rename made every stored document fail validation and the
 * whole domain refused to open. Accepting both names costs four lines and means a
 * future rename of this field cannot brick the data that already exists.
 */
const projectSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    breakdown: breakdownSchema.nullable().optional(),
    /** Pre-rename name of {@link breakdown}; still present in records written before. */
    charter: breakdownSchema.nullable().optional(),
    root: nodeSchema,
    focusedNodeId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .transform((project) => ({
    id: project.id,
    title: project.title,
    breakdown: project.breakdown ?? project.charter ?? null,
    root: project.root,
    ...(project.focusedNodeId === undefined ? {} : { focusedNodeId: project.focusedNodeId }),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }))

const pendingSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  from: statusSchema,
  to: statusSchema,
  reason: z.string().optional(),
  result: z.string().optional(),
  proposedBy: actorSchema,
  at: z.number(),
})

/**
 * The stored-record schema, exported so the data on disk can be validated outside
 * the harness.
 *
 * That matters: when a record stops matching, the failure is a single line in a log
 * the user never sees, and the visible symptom is "my tree disappeared". Being able
 * to check a real record from a script is how that gets diagnosed in seconds
 * instead of hours.
 */
export const atlasDocumentSchema: z.ZodType<AtlasDocument> = z.object({
  version: z.literal(1),
  workspaceKey: z.string(),
  activeProjectId: z.string().nullable(),
  projects: z.array(projectSchema),
  pending: z.array(pendingSchema),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
  layoutVersion: z.number().optional(),
}) as z.ZodType<AtlasDocument>

const documentSchema = atlasDocumentSchema

/**
 * The declared domain: one `documents` table, one record per workspace.
 *
 * The name must match `^[a-z][a-z0-9_]*$` — no hyphens — and it doubles as the
 * backend unit name, so it is a durable on-disk identity: renaming it orphans
 * every existing document.
 */
export const ATLAS_DOMAIN = defineDomain({
  name: 'dsh_task_atlas',
  version: 1,
  layout: 'per-record',
  // A record that fails its schema must not be fatal. Rejecting is the library's
  // default and it is right for authoritative data — but "the plugin refuses to
  // start and the panel looks empty" is a worse outcome than "one workspace's
  // record was set aside and logged", and the schema now accepts the legacy key so
  // this is only about unknown future damage.
  invalidRecords: 'backup-and-skip',
  tables: {
    documents: domainTable<string, AtlasDocument>(documentSchema),
  },
})

/** The slice of a `KvTable` handle this plugin actually uses. */
export interface DocumentTable {
  get(key: string): AtlasDocument | undefined
  put(key: string, value: AtlasDocument): Promise<void>
  update(
    key: string,
    fn: (current: AtlasDocument) => AtlasDocument,
  ): Promise<AtlasDocument>
}

/**
 * Wrap an opened KV table as the plugin's storage seam.
 *
 * `KvTable.update` rejects with `missing-key` for a workspace nobody has written
 * yet, while the seam promises "current or empty". So the first touch writes the
 * empty document, which is also what makes `read` cheap afterwards.
 * @param table - the opened `documents` table handle.
 * @returns the store the tools use.
 */
export function domainStoreOf(table: DocumentTable): AtlasStore {
  return {
    async read(workspaceKey) {
      return table.get(workspaceKey)
    },
    async update(workspaceKey, fn) {
      if (table.get(workspaceKey) === undefined) {
        await table.put(workspaceKey, emptyDocument(workspaceKey))
      }
      const next = await table.update(workspaceKey, fn)
      return next
    },
  }
}
