/**
 * The persistence seam.
 *
 * Tools talk to `AtlasStore` and nothing else, so the same tool code runs
 * against an in-memory map in tests and against `ctx.storageDomain` in the
 * harness. That split is what keeps the tool layer unit-testable without a
 * harness, a browser, or a durable medium.
 */
import type {
  AtlasDocument,
  AtlasNode,
  AtlasProject,
  PendingConfirmation,
} from '../model/types.ts'

/** One workspace's document store. */
export interface AtlasStore {
  /** Read a workspace's document, or `undefined` before its first write. */
  read(workspaceKey: string): Promise<AtlasDocument | undefined>
  /**
   * Atomic read-modify-write. `fn` must be pure: the store may replay it against
   * a newer value if another writer got there first.
   * @param workspaceKey - workspace identity.
   * @param fn - pure transform from current to next document.
   * @returns the stored document after the write.
   */
  update(
    workspaceKey: string,
    fn: (current: AtlasDocument) => AtlasDocument,
  ): Promise<AtlasDocument>
}

/**
 * Build the document for a workspace that has never been touched.
 * @param workspaceKey - workspace identity.
 * @returns an empty document with no projects.
 */
export function emptyDocument(workspaceKey: string): AtlasDocument {
  return {
    version: 1,
    workspaceKey,
    activeProjectId: null,
    projects: [],
    pending: [],
  }
}

/**
 * Find the active project, or the one named by `projectId` when given.
 * @param doc - the document.
 * @param projectId - explicit project id, optional.
 * @returns the project, or `undefined` when absent.
 */
export function selectProject(
  doc: AtlasDocument,
  projectId?: string,
): AtlasProject | undefined {
  const wanted = projectId ?? doc.activeProjectId
  if (!wanted) return undefined
  return doc.projects.find((project) => project.id === wanted)
}

/**
 * Rewrite one project in place.
 * @param doc - the document.
 * @param projectId - project to replace.
 * @param fn - pure transform.
 * @param at - epoch milliseconds, stamped on the project.
 * @returns the new document.
 * @throws {Error} when the project is absent.
 */
export function withProject(
  doc: AtlasDocument,
  projectId: string,
  fn: (project: AtlasProject) => AtlasProject,
  at: number,
): AtlasDocument {
  let found = false
  const projects = doc.projects.map((project) => {
    if (project.id !== projectId) return project
    found = true
    return { ...fn(project), updatedAt: at }
  })
  if (!found) throw new Error(`no such project: ${projectId}`)
  return { ...doc, projects }
}

/**
 * Queue a status change that needs the user's confirmation.
 * @param doc - the document.
 * @param confirmation - the proposal to remember.
 * @returns the new document.
 */
export function pushPending(
  doc: AtlasDocument,
  confirmation: PendingConfirmation,
): AtlasDocument {
  return { ...doc, pending: [...doc.pending, confirmation] }
}

/**
 * Remove one queued confirmation.
 * @param doc - the document.
 * @param id - confirmation id.
 * @returns the document and the removed record, if any.
 */
export function takePending(
  doc: AtlasDocument,
  id: string,
): { readonly doc: AtlasDocument; readonly confirmation: PendingConfirmation | undefined } {
  const confirmation = doc.pending.find((entry) => entry.id === id)
  if (!confirmation) return { doc, confirmation: undefined }
  return {
    doc: { ...doc, pending: doc.pending.filter((entry) => entry.id !== id) },
    confirmation,
  }
}

/** A node plus the project it lives in — the shape most tools need. */
export interface NodeLocation {
  readonly project: AtlasProject
  readonly node: AtlasNode
}

/**
 * Locate a node across every project of a document.
 * @param doc - the document.
 * @param nodeId - node id, or `null` for the active project's root.
 * @returns the project and node, or `undefined`.
 */
export function locateNode(
  doc: AtlasDocument,
  nodeId: string | null,
): NodeLocation | undefined {
  if (nodeId === null) {
    const project = selectProject(doc)
    return project ? { project, node: project.root } : undefined
  }
  for (const project of doc.projects) {
    const stack: AtlasNode[] = [project.root]
    while (stack.length > 0) {
      const node = stack.pop() as AtlasNode
      if (node.id === nodeId) return { project, node }
      stack.push(...node.children)
    }
  }
  return undefined
}

/**
 * Every node of the active (or named) project, flattened.
 * @param doc - the document.
 * @param projectId - explicit project id, optional.
 * @returns the flattened nodes, or `[]`.
 */
export function flattenProject(
  doc: AtlasDocument,
  projectId?: string,
): readonly AtlasNode[] {
  const project = selectProject(doc, projectId)
  if (!project) return []
  const out: AtlasNode[] = []
  const walk = (node: AtlasNode): void => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(project.root)
  return out
}
