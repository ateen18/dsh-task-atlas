/**
 * The agent-facing tool surface.
 *
 * Design notes that matter more than the individual schemas:
 *
 * - **One read tool, one writer per verb.** `atlas_status` is the only way to
 *   look; the writers are narrow so their descriptions can be prescriptive.
 * - **"Needs my confirmation" is not an error.** A parked change returns
 *   `ok: true` with a `summary` that tells the model what it is waiting for, so
 *   the model's turn is never blocked on a human.
 * - **`atlas_confirm` exists** because the user's verbal "yes, block it" in the
 *   conversation is real authority, not a second-class path next to the panel.
 * - Every result is `{ ok, summary, code? }` and the model reads `summary`.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { BACKUP_FILE, isBlank, parseBackup } from '../backup.ts'
import { applyConfirmation } from '../confirm.ts'
import { amendBreakdown, validateBreakdown, type BreakdownPatch } from '../model/breakdown.ts'
import { checkDependencies } from '../model/dependency.ts'
import { splitTitle, titleHint } from '../model/title.ts'
import { tidyTitles } from '../collab/tidy.ts'
import { guessKind, removeOutput, upsertOutput } from '../model/outputs.ts'
import type { WorkspaceHistory } from '../workspace-history.ts'
import { requestStatus, toPendingConfirmation } from '../model/status.ts'
import type {
  AtlasDocument,
  AtlasNode,
  AtlasProject,
  Breakdown,
  NodeStatus,
} from '../model/types.ts'
import {
  addChild,
  attachBranch,
  checkAddChild,
  collectNodes,
  createNode,
  deleteNode,
  findNode,
  moveNode,
  progressOf,
  replaceNode,
  resolveBranch,
  updateNode,
} from '../model/tree.ts'
import {
  emptyDocument,
  flattenProject,
  locateNode,
  pushPending,
  selectProject,
  takePending,
  withProject,
  type AtlasStore,
} from '../store/document.ts'
import { makeConfirmationId, makeNodeId, type Rand } from '../store/ids.ts'

/** Everything a tool needs from the outside world; injected so tests stay hermetic. */
export interface ToolEnv {
  /** Epoch milliseconds. */
  now(): number
  /**
   * The workspace a given call belongs to.
   *
   * Resolved per execution rather than once at registration: one harness process
   * serves many sessions in many workspaces, so a captured key would leak one
   * project's tree into another's turn.
   * @param exec - the running execution, when the caller has one.
   */
  workspaceKey(exec?: unknown): string
  /**
   * The workspace path, when the host can resolve one.
   *
   * Only the restore path needs it: the backup lives on disk under the workspace, so the
   * tool has to know where that is. Absent is a legitimate answer — the tool then says so
   * instead of guessing a directory.
   * @param exec - the running execution, when the caller has one.
   */
  workspacePath?(exec?: unknown): string | undefined
  /**
   * Directory (relative to the workspace) where the mirrors are written.
   *
   * Shared with the host so the restore tool and the exporter cannot disagree about where
   * the backup lives.
   */
  readonly exportDir?: string
  /**
   * What this workspace already contains, from the harness's own session corpus.
   *
   * Kickoff needs it: a workspace with prior conversations already has its work
   * described, so the blueprint is reconstructed from that history rather than
   * interviewed out of the user all over again. Absent when the query service is
   * unavailable, in which case kickoff falls back to asking.
   * @param exec - the running execution, when the caller has one.
   */
  workspaceHistory?(exec?: unknown): Promise<WorkspaceHistory | undefined>
  /**
   * Called after a mutation actually changed the document.
   *
   * The panel subscribes to this instead of polling: the plugin already knows every
   * write, so "something changed" is information it has, not something a timer has
   * to guess at.
   * @param workspaceKey - the workspace whose document changed.
   */
  onWrite?(workspaceKey: string): void
  /** Random source. */
  rand: Rand
}

/** Uniform tool result. `summary` is the only field the model reads. */
interface ToolResult {
  ok: boolean
  summary: string
  code?: string
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    summary: { type: 'string', required: true },
    code: { type: 'string' },
  },
} as const

const text = (value: string) => [{ type: 'text' as const, text: value }]

function ok(summary: string): ToolResult {
  return { ok: true, summary }
}

function fail(code: string, summary: string): ToolResult {
  return { ok: false, code, summary }
}

/** Read `summary` out of an unknown result for rendering. */
function summaryOf(value: unknown): string {
  const record = value as { summary?: unknown }
  return typeof record.summary === 'string' ? record.summary : '(no summary)'
}

const STATUS_GLYPH: Readonly<Record<NodeStatus, string>> = {
  pending: ' ',
  active: '~',
  done: 'x',
  rework: '!',
  blocked: '!',
  dropped: '-',
}

const STATUS_LABEL: Readonly<Record<NodeStatus, string>> = {
  pending: '未开始',
  active: '进行中',
  done: '已完成',
  rework: '需返工',
  blocked: '阻塞',
  dropped: '已废弃',
}

/** Render one project as the Markdown checklist the model reads. */
function renderProject(
  project: AtlasProject,
  options: { includeDone: boolean; limit: number },
): string {
  const progress = progressOf(project.root)
  const focusId = project.focusedNodeId ?? fallbackFocus(project.root)
  const lines: string[] = [`# ${project.title}`]

  if (project.breakdown) {
    lines.push('', `意图：${project.breakdown.coreIntent}`)
    lines.push(
      `进度：${Math.round(progress.completion * 100)}%（${progress.countable} 个可计叶子）· ` +
        `进行中 ${progress.active} · 需返工 ${progress.rework} · 阻塞 ${progress.blocked} · ` +
        `已废弃 ${progress.dropped}`,
    )
    if (project.breakdown.decomposition.length > 0) {
      lines.push(`拆解：${project.breakdown.decomposition.join(' / ')}`)
    }
  } else {
    lines.push('', '（尚未确认任务拆解：还没有 coreIntent / 交付物 / 拆解。）')
  }

  lines.push('')

  const nodes = collectNodes(project.root).filter(
    (node) =>
      node.kind !== 'project' &&
      (options.includeDone || node.status !== 'done') &&
      node.status !== 'dropped',
  )
  const shown = nodes.slice(0, options.limit)

  for (const node of shown) {
    const depth = depthInTree(project.root, node.id)
    const indent = '  '.repeat(Math.max(0, depth - 1))
    const marker = node.id === focusId ? ' ← 当前' : ''
    const reason = node.reason ? ` —— ${node.reason}` : ''
    const branch = node.branch
      ? ` 〔分支，源自 ${node.branch.originId}：${node.branch.trigger}${
          node.branch.resolvedAt ? '，已合回' : ''
        }〕`
      : ''
    // Dependencies are part of the model's picture of the work, not just a picture
    // for humans: "what is this waiting on" is the question the graph renders.
    const dependencies =
      node.dependsOn && node.dependsOn.length > 0
        ? ` 〔前置：${node.dependsOn.join(' / ')}〕`
        : ''
    lines.push(
      `${indent}- [${STATUS_GLYPH[node.status]}] ${node.title} (${node.id})` +
        `${node.status === 'pending' ? '' : ` ·${STATUS_LABEL[node.status]}`}${reason}${branch}${dependencies}${marker}`,
    )
    if (node.status === 'done' && node.result) {
      lines.push(`${indent}  - 结果：${node.result}`)
    }
  }

  if (nodes.length > shown.length) {
    lines.push('', `… 还有 ${nodes.length - shown.length} 个节点未显示（用 atlas_status 指定 nodeId 查看）。`)
  }
  if (shown.length === 0) {
    lines.push('（还没有任何节点。下一步：atlas_breakdown_draft → atlas_breakdown_confirm 建立拆解与拆解。）')
  }
  return lines.join('\n')
}

/** Depth of a node inside a project root, 1-based. */
function depthInTree(root: AtlasNode, id: string): number {
  let depth = 0
  const walk = (node: AtlasNode, level: number): boolean => {
    if (node.id === id) {
      depth = level
      return true
    }
    return node.children.some((child) => walk(child, level + 1))
  }
  walk(root, 1)
  return depth
}

/**
 * The node the panel falls back to when the AI never declared focus: the most
 * recently touched `active` node, else the newest non-done leaf.
 */
function fallbackFocus(root: AtlasNode): string | undefined {
  const candidates = collectNodes(root).filter(
    (node) => node.kind !== 'project' && node.status !== 'dropped' && node.status !== 'done',
  )
  const active = candidates.filter((node) => node.status === 'active')
  const pool = active.length > 0 ? active : candidates
  return pool.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id
}

/** Breakdown fields shared by draft and confirm. */
const BREAKDOWN_PARAMETERS = {
  title: { type: 'string', required: true, description: '项目名，显示在面板顶部' },
  coreIntent: {
    type: 'string',
    required: true,
    description: '核心意图：这个项目到底要解决什么，一到两句',
  },
  deliverables: {
    type: 'array',
    required: true,
    description: '核心交付物。每项都要能被独立验收',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', required: true, description: '交付物是什么' },
        acceptance: {
          type: 'string',
          description: '怎么验证它真的交付了。留空会得到一条警告，但不会阻断',
        },
      },
    },
  },
  decomposition: {
    type: 'array',
    required: true,
    description: '拆解：把项目拆成 1/2/3/4 这样的模块，按执行顺序',
    items: { type: 'string' },
  },
  acceptance: {
    type: 'string',
    required: true,
    description: '整体验收标准：整个项目做到什么程度算完成',
  },
  outOfScope: {
    type: 'array',
    description: '明确不做的事，用来防止范围膨胀',
    items: { type: 'string' },
  },
  constraints: {
    type: 'array',
    description: '约束与前置依赖：技术限制、必须先完成的事',
    items: { type: 'string' },
  },
  priorityOrder: {
    type: 'array',
    description: '优先级与先后顺序',
    items: { type: 'string' },
  },
  mode: {
    type: 'string',
    required: true,
    enum: ['fast', 'detailed'],
    description: 'fast = AI 起草后用户校对；detailed = 走过七维访谈',
  },
} as const

/**
 * Build the whole tool set bound to one store.
 * @param store - persistence seam.
 * @param env - injected clock, workspace identity, and randomness.
 * @returns the tool definitions, ready to register (or to call directly in tests).
 */
export function buildTools(store: AtlasStore, env: ToolEnv): ToolDefinition[] {
  /** Run a mutation and return the result the closure computed. */
  async function mutate(
    exec: unknown,
    fn: (doc: AtlasDocument) => { doc: AtlasDocument; result: ToolResult },
  ): Promise<ToolResult> {
    let result: ToolResult = fail('INTERNAL', 'mutation produced no result')
    let changed = false
    const workspaceKey = env.workspaceKey(exec)
    await store.update(workspaceKey, (current) => {
      const applied = fn(current)
      result = applied.result
      // Structural sharing means an unchanged document is the same object, so a
      // refused mutation does not wake every connected panel.
      changed = applied.doc !== current
      return applied.doc
    })
    if (changed) env.onWrite?.(workspaceKey)
    return result
  }

  /** The active project, or a failure result. */
  function activeProject(doc: AtlasDocument): AtlasProject | ToolResult {
    const project = selectProject(doc)
    if (!project) {
      return fail(
        'NO_PROJECT',
        '这个工作区还没有项目。先用 atlas_breakdown_draft 把核心意图/交付物/拆解敲定，再 atlas_breakdown_confirm 落盘。',
      )
    }
    return project
  }

  const isFailure = (value: AtlasProject | ToolResult): value is ToolResult =>
    (value as ToolResult).summary !== undefined && (value as ToolResult).ok === false

  function breakdownOf(args: {
    coreIntent: string
    deliverables: readonly { text: string; acceptance?: string }[]
    decomposition: readonly string[]
    acceptance: string
    outOfScope?: readonly string[]
    constraints?: readonly string[]
    priorityOrder?: readonly string[]
    mode: 'fast' | 'detailed'
  }): Omit<Breakdown, 'confirmedAt'> {
    return {
      coreIntent: args.coreIntent,
      deliverables: args.deliverables.map((item) => ({
        text: item.text,
        acceptance: item.acceptance ?? '',
      })),
      decomposition: [...args.decomposition],
      acceptance: args.acceptance,
      outOfScope: [...(args.outOfScope ?? [])],
      constraints: [...(args.constraints ?? [])],
      priorityOrder: [...(args.priorityOrder ?? [])],
      mode: args.mode,
    }
  }

  const tools: ToolDefinition[] = []

  // ── read ────────────────────────────────────────────────────────────────
  tools.push(
    defineTool({
      name: 'atlas_status',
      description:
        '读取当前工作区的项目蓝图与任务树。这是本插件的唯一读取入口：想知道"原计划是什么、做到哪、还剩什么、为什么有分支"就调它。默认不显示已完成节点，因为它们不占注意力。',
      parameters: {
        includeDone: {
          type: 'boolean',
          description: '是否把已完成的节点也列出来（默认 false）',
        },
        limit: {
          type: 'integer',
          description: '最多列出多少个节点（默认 120）',
        },
      },
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => text(summaryOf(value)),
      },
      execute: async (args, exec) => {
        const workspaceKey = env.workspaceKey(exec)
        const doc = (await store.read(workspaceKey)) ?? emptyDocument(workspaceKey)
        const project = activeProject(doc)
        if (isFailure(project)) return project
        const body = renderProject(project, {
          includeDone: args.includeDone === true,
          limit: Math.min(Math.max(args.limit ?? 120, 10), 400),
        })
        const pendingNote =
          doc.pending.length > 0
            ? `\n\n待用户确认 ${doc.pending.length} 项：` +
              doc.pending
                .map((p) => `${p.id} → ${p.nodeId} 改 ${p.to}${p.reason ? `（${p.reason}）` : ''}`)
                .join('；')
            : ''
        const focusNote = project.focusedNodeId
          ? `\n当前专注：${project.focusedNodeId}`
          : '\n当前专注：（未声明，面板按最近更新的进行中节点推断）'
        return ok(`${body}${focusNote}${pendingNote}`)
      },
    }),
  )

  // ── kickoff ─────────────────────────────────────────────────────────────
  tools.push(
    defineTool({
      name: 'atlas_breakdown_draft',
      description:
        '校验一份任务拆解草案，不落盘。用于启动阶段：先按用户选的方式（快速=AI 起草 / 详细=七维访谈）把 coreIntent、交付物、拆解、验收标准等填出来，调本工具检查还缺什么、有哪些警告，改好后调 atlas_breakdown_confirm。',
      parameters: BREAKDOWN_PARAMETERS,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => text(summaryOf(value)),
      },
      execute: async (args) => {
        const validation = validateBreakdown(breakdownOf(args))
        if (!validation.ok) {
          return fail(
            'BREAKDOWN_INCOMPLETE',
            `拆解还不完整，缺：${validation.missing.join(', ')}。补齐后重新调用。`,
          )
        }
        const lines = ['拆解草案通过校验，可以 atlas_breakdown_confirm 落盘。']
        if (validation.warnings.length > 0) {
          lines.push('', '警告（不阻断，但值得补）：')
          for (const warning of validation.warnings) lines.push(`- ${warning}`)
        }
        lines.push('', `拆解共 ${args.decomposition.length} 个模块。`)
        return ok(lines.join('\n'))
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_breakdown_confirm',
      description:
        '把任务拆解落盘，并按拆解建立模块节点。这是新项目的起点：之后所有节点都挂在这些模块下。如果该工作区已有活动项目，会新建一个并列项目并切换为活动。',
      parameters: BREAKDOWN_PARAMETERS,
      output: {
        schema: RESULT_SCHEMA,
        render: (_args, value) => text(summaryOf(value)),
      },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const validation = validateBreakdown(breakdownOf(args))
          if (!validation.ok) {
            return {
              doc,
              result: fail(
                'BREAKDOWN_INCOMPLETE',
                `拆解还不完整，缺：${validation.missing.join(', ')}`,
              ),
            }
          }
          const at = env.now()
          const projectId = makeNodeId('project', env.rand)
          const projectTitle = args.title.trim()
          let root = createNode({
            id: projectId,
            kind: 'project',
            title: projectTitle,
            origin: 'ai',
            at,
          })
          const moduleIds: string[] = []
          for (const step of args.decomposition) {
            const moduleNode = createNode({
              id: makeNodeId('module', env.rand),
              kind: 'module',
              title: step,
              origin: 'ai',
              at,
            })
            root = addChild(root, projectId, moduleNode)
            moduleIds.push(moduleNode.id)
          }
          const project: AtlasProject = {
            id: projectId,
            title: projectTitle,
            breakdown: { ...breakdownOf(args), confirmedAt: at },
            root,
            focusedNodeId: moduleIds[0],
            createdAt: at,
            updatedAt: at,
          }
          const next: AtlasDocument = {
            ...doc,
            activeProjectId: projectId,
            projects: [...doc.projects, project],
          }
          const warningNote =
            validation.warnings.length > 0
              ? `\n警告 ${validation.warnings.length} 条，建议之后补：${validation.warnings.join('；')}`
              : ''
          return {
            doc: next,
            result: ok(
              `已建立项目「${projectTitle}」(${projectId})，拆解已确认，拆出 ${moduleIds.length} 个模块：` +
                `${moduleIds.join(', ')}。\n当前专注设为 ${moduleIds[0] ?? '无'}。${warningNote}`,
            ),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_breakdown_amend',
      description:
        '修订已确认的任务拆解，并记录为什么改。拆解是活文档——理解变了就该改，但每次修订都要写 reason，这样将来能查"当初为什么这么定、后来为什么改成这样"。只传要改的字段，没传的保持不动。改「拆解」不会自动改树，两者不一致时工具会提醒你。',
      parameters: {
        reason: {
          type: 'string',
          required: true,
          description: '为什么改：是理解变了、范围变了，还是发现了新的约束',
        },
        coreIntent: { type: 'string', description: '新的核心意图' },
        acceptance: { type: 'string', description: '新的整体验收标准' },
        mode: {
          type: 'string',
          enum: ['fast', 'detailed'],
          description: '拆解的产生方式（一般不用改）',
        },
        deliverables: {
          type: 'array',
          description: '新的核心交付物清单（整体替换，不是追加）',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true, description: '交付物是什么' },
              acceptance: { type: 'string', description: '怎么验收' },
            },
          },
        },
        decomposition: {
          type: 'array',
          description: '新的拆解（模块清单，整体替换）',
          items: { type: 'string' },
        },
        outOfScope: {
          type: 'array',
          description: '新的「明确不做什么」（整体替换）',
          items: { type: 'string' },
        },
        constraints: {
          type: 'array',
          description: '新的约束与前置依赖（整体替换）',
          items: { type: 'string' },
        },
        priorityOrder: {
          type: 'array',
          description: '新的优先级与先后顺序（整体替换）',
          items: { type: 'string' },
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          if (!project.breakdown) {
            return { doc, result: fail('NO_CHARTER', '这个项目还没有确认过拆解，先用 atlas_breakdown_confirm 落盘。') }
          }
          const at = env.now()
          const patch: BreakdownPatch = {
            ...(args.coreIntent === undefined ? {} : { coreIntent: args.coreIntent }),
            ...(args.acceptance === undefined ? {} : { acceptance: args.acceptance }),
            ...(args.mode === undefined ? {} : { mode: args.mode }),
            ...(args.deliverables === undefined
              ? {}
              : {
                  deliverables: args.deliverables.map((item) => ({
                    text: item.text,
                    acceptance: item.acceptance ?? '',
                  })),
                }),
            ...(args.decomposition === undefined
              ? {}
              : { decomposition: [...args.decomposition] }),
            ...(args.outOfScope === undefined ? {} : { outOfScope: [...args.outOfScope] }),
            ...(args.constraints === undefined ? {} : { constraints: [...args.constraints] }),
            ...(args.priorityOrder === undefined
              ? {}
              : { priorityOrder: [...args.priorityOrder] }),
          }
          try {
            const outcome = amendBreakdown(
              project.breakdown,
              patch,
              { at, by: 'ai', reason: args.reason },
              project.root.children.map((child) => child.title),
            )
            if (outcome.changes.length === 0) {
              return { doc, result: ok('拆解没有实质变化，未记录修订。') }
            }
            const lines = [
              `拆解已修订（第 ${(project.breakdown.revisions?.length ?? 0) + 1} 次），改了 ${outcome.changes.length} 个字段：`,
            ]
            for (const change of outcome.changes) {
              lines.push(`- ${change.field}：「${change.from}」→「${change.to}」`)
            }
            lines.push(`原因：${args.reason.trim()}`)
            if (outcome.warnings.length > 0) {
              lines.push('', '提醒：')
              for (const warning of outcome.warnings) lines.push(`- ${warning}`)
            }
            return {
              doc: withProject(
                doc,
                project.id,
                (p) => ({ ...p, breakdown: outcome.breakdown }),
                at,
              ),
              result: ok(lines.join('\n')),
            }
          } catch (error) {
            return { doc, result: fail('AMEND_REFUSED', (error as Error).message) }
          }
        }),
    }),
  )

  // ── structure ───────────────────────────────────────────────────────────
  tools.push(
    defineTool({
      name: 'atlas_node_add',
      description:
        '新增一个节点。层级固定四级：项目 → 模块 → 任务 → 子项，不能跳级也不能超过四级。省略 parentId 时挂在活动项目的根下。',
      parameters: {
        parentId: { type: 'string', description: '父节点 id；省略则用活动项目的根' },
        kind: {
          type: 'string',
          required: true,
          enum: ['module', 'task', 'item'],
          description: '节点层级，必须正好是父节点的下一级',
        },
        title: { type: 'string', required: true, description: '标题，不缩略' },
        note: { type: 'string', description: '补充说明' },
        dependsOn: {
          type: 'array',
          description:
            '前置节点 id 列表：这些节点得先完成，本节点才可能开始。用来建立上下游逻辑关系，成环会被拒绝。',
          items: { type: 'string' },
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const parentId = args.parentId ?? project.root.id
          const parent = findNode(project.root, parentId)
          if (!parent) {
            return { doc, result: fail('NO_SUCH_NODE', `没有这个父节点：${parentId}`) }
          }
          const check = checkAddChild(parent, args.kind)
          if (!check.ok) return { doc, result: fail('BAD_LEVEL', check.message) }
          const at = env.now()
          const dependencies = [
            ...new Set((args.dependsOn ?? []).map((dependency) => dependency.trim())),
          ].filter(Boolean)
          // A title is a label, not a sentence: `短标题：解释` is split at the write boundary
          // so the tree stays scannable even when the model writes an explanation.
          const split = splitTitle(args.title)
          const note = args.note ?? split.note
          const node = createNode({
            id: makeNodeId(args.kind, env.rand),
            kind: args.kind,
            title: split.title,
            ...(note ? { note } : {}),
            origin: 'ai',
            at,
            ...(dependencies.length > 0 ? { dependsOn: dependencies } : {}),
          })
          const root = addChild(project.root, parentId, node)
          if (dependencies.length > 0) {
            // Checked after insertion so "is this a real node" is answered against the
            // tree the node now lives in.
            const verdict = checkDependencies(collectNodes(root), node.id)
            if (!verdict.ok) return { doc, result: fail(verdict.code, verdict.message) }
          }
          const hint = titleHint(split.title)
          return {
            doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
            result: ok(
              `已新增 ${args.kind}「${node.title}」(${node.id})，父节点 ${parentId}。` +
                (dependencies.length > 0 ? `前置：${dependencies.join(', ')}。` : '') +
                (split.note && !args.note ? '（标题里的解释已移进 note）' : '') +
                (hint ? ` ${hint}` : ''),
            ),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_node_update',
      description:
        '修改节点的标题、说明或前置依赖。改需求之后用它让树上的文字跟上现实；传 dependsOn 会整体替换前置列表（传空数组即清除），成环会被拒。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '节点 id' },
        title: { type: 'string', description: '新标题' },
        note: { type: 'string', description: '新说明' },
        dependsOn: {
          type: 'array',
          description: '新的前置节点 id 列表（整体替换）；传 [] 表示清除所有前置',
          items: { type: 'string' },
        },
        needs: {
          type: 'array',
          description:
            '开工条件（推荐，替代 dependsOn）：每条说清「这块开工前需要什么」；能指向提供它的节点就填 fromNodeId，指不出就是外部条件。写入后自动推导 dependsOn。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true, description: '需要什么，例如「字段口径表」' },
              fromNodeId: { type: 'string', description: '由哪个节点提供；外部条件留空' },
              satisfied: { type: 'boolean', description: '是否已满足；不确定就别传' },
            },
          },
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          try {
            const at = env.now()
            const split = args.title === undefined ? undefined : splitTitle(args.title)
            // Same rule as `add`: shorten the label, keep the explanation in the note.
            const note = args.note ?? split?.note
            const root = updateNode(
              project.root,
              args.nodeId,
              {
                ...(split === undefined ? {} : { title: split.title }),
                ...(note === undefined ? {} : { note }),
                ...(args.dependsOn === undefined
                  ? {}
                  : { dependsOn: [...new Set(args.dependsOn.map((dep) => dep.trim()))].filter(Boolean) }),
                // Needs win over a bare id list: they carry the "what" that makes an edge
                // meaningful, and the provider ids are derived from them.
                ...(args.needs === undefined
                  ? {}
                  : {
                      needs: args.needs
                        .map((need) => ({
                          label: need.label.trim(),
                          ...(need.fromNodeId?.trim() ? { fromNodeId: need.fromNodeId.trim() } : {}),
                          ...(need.satisfied === undefined ? {} : { satisfied: need.satisfied }),
                        }))
                        .filter((need) => need.label.length > 0),
                    }),
              },
              at,
            )
            const hint = split ? titleHint(split.title) : undefined
            return {
              doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
              result: ok(
                `已更新节点 ${args.nodeId}。` +
                  (split?.note && args.note === undefined ? '（标题里的解释已移进 note）' : '') +
                  (hint ? ` ${hint}` : ''),
              ),
            }
          } catch (error) {
            return {
              doc,
              result: fail('UPDATE_FAILED', (error as Error).message),
            }
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_focus',
      description:
        '声明"我现在在做这个节点"。树上的状态可以有多个"进行中"，但注意力只能有一个：面板据此高亮并把该节点到根的路径自动展开。开工前调一次，切换工作时再调。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '当前正在做的节点 id' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const node = findNode(project.root, args.nodeId)
          if (!node) {
            return { doc, result: fail('NO_SUCH_NODE', `没有这个节点：${args.nodeId}`) }
          }
          const at = env.now()
          return {
            doc: withProject(
              doc,
              project.id,
              (p) => ({ ...p, focusedNodeId: args.nodeId }),
              at,
            ),
            result: ok(`当前专注已切到「${node.title}」(${args.nodeId})。`),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_node_done',
      description:
        '把一个节点标记为已完成。必须提交 result：产出了什么、怎么验收。这个过程不会自动发生——没开始过的事不能直接宣布完成（需要先 atlas_node_status 到 active）。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '节点 id' },
        result: {
          type: 'string',
          required: true,
          description: '产出了什么、怎么验收。写成能独立看懂的样子，不要写过程',
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const node = findNode(project.root, args.nodeId)
          if (!node) {
            return { doc, result: fail('NO_SUCH_NODE', `没有这个节点：${args.nodeId}`) }
          }
          const outcome = requestStatus(node, {
            to: 'done',
            by: 'ai',
            at: env.now(),
            result: args.result,
          })
          if (!outcome.ok) return { doc, result: fail(outcome.code, outcome.message) }
          if (outcome.kind === 'pending') {
            return { doc, result: fail('UNEXPECTED_PENDING', 'done 不应需要确认') }
          }
          return {
            doc: withProject(
              doc,
              project.id,
              (p) => ({ ...p, root: replaceNode(p.root, args.nodeId, outcome.node) }),
              env.now(),
            ),
            result: ok(`「${node.title}」(${args.nodeId}) 已完成，结果已记录。`),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_node_status',
      description:
        '把节点移动到 active / pending / rework / blocked / dropped。规则：rework（需要返工）、blocked（阻塞）、dropped（废弃）必须写 reason 说明原因；这三个状态还必须得到用户确认——不传 confirm 时本工具只排队，返回"待确认"，节点本身不会改变。用户在对话里明确同意了才传 confirm=true。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '节点 id' },
        status: {
          type: 'string',
          required: true,
          enum: ['pending', 'active', 'rework', 'blocked', 'dropped'],
          description: '目标状态',
        },
        reason: {
          type: 'string',
          description: 'rework / blocked / dropped 必填：具体什么问题、为什么要改，用用户的说法',
        },
        returnCondition: {
          type: 'string',
          description: 'blocked 时建议填：什么条件下能解除',
        },
        confirm: {
          type: 'boolean',
          description: '用户已在对话中明确确认这次变更。仅在这种情况下传 true',
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const node = findNode(project.root, args.nodeId)
          if (!node) {
            return { doc, result: fail('NO_SUCH_NODE', `没有这个节点：${args.nodeId}`) }
          }
          const at = env.now()
          const outcome = requestStatus(node, {
            to: args.status,
            by: 'ai',
            at,
            ...(args.reason ? { reason: args.reason } : {}),
            ...(args.confirm === true ? { confirmedByUser: true } : {}),
          })
          if (!outcome.ok) return { doc, result: fail(outcome.code, outcome.message) }

          if (outcome.kind === 'pending') {
            const confirmation = toPendingConfirmation(
              outcome.proposal,
              makeConfirmationId(env.rand),
            )
            const withQueue = pushPending(doc, confirmation)
            const nextRoot =
              args.status === 'blocked' && args.returnCondition
                ? replaceNode(
                    project.root,
                    args.nodeId,
                    { ...node, returnCondition: args.returnCondition },
                  )
                : project.root
            return {
              doc: withProject(withQueue, project.id, (p) => ({ ...p, root: nextRoot }), at),
              result: ok(
                `已排队待确认：把「${node.title}」(${args.nodeId}) 改为 ${STATUS_LABEL[args.status]}。` +
                  `确认 id = ${confirmation.id}。节点状态暂未改变——请把这个改动告诉用户，` +
                  `用户同意后调 atlas_confirm，或在右侧面板点确认。`,
              ),
            }
          }

          const nextNode =
            args.status === 'blocked' && args.returnCondition
              ? { ...outcome.node, returnCondition: args.returnCondition }
              : outcome.node
          return {
            doc: withProject(
              doc,
              project.id,
              (p) => ({ ...p, root: replaceNode(p.root, args.nodeId, nextNode) }),
              at,
            ),
            result: ok(
              `「${node.title}」(${args.nodeId}) 已改为 ${STATUS_LABEL[args.status]}` +
                `${args.reason ? `：${args.reason}` : ''}。`,
            ),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_confirm',
      description:
        '应用一条待确认的状态变更。只在用户明确同意之后调用（对话里说了同意，或他在右侧面板点了确认）。',
      parameters: {
        confirmationId: {
          type: 'string',
          required: true,
          description: 'atlas_node_status 返回的确认 id',
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) => {
        // Delegated on purpose: the panel's confirm route applies the same
        // function, so the two authority paths cannot drift apart.
        const outcome = await applyConfirmation(
          store,
          env.workspaceKey(exec),
          args.confirmationId,
          env.now(),
        )
        return {
          ok: outcome.ok,
          summary: outcome.summary,
          ...(outcome.code ? { code: outcome.code } : {}),
        }
      },
    }),
  )

  // ── branches ────────────────────────────────────────────────────────────
  tools.push(
    defineTool({
      name: 'atlas_branch_create',
      description:
        '登记一个临时分支。当工作进行中插进来一件原本不在计划里的事（用户临时要求、发现前置问题、外部依赖阻挡），用它而不是普通 atlas_node_add：分支会记住"从哪分出来、为什么分、什么条件回归"。trigger 必填，因为"为什么分支"正是用户回头最想不起来的那件事。',
      parameters: {
        parentId: { type: 'string', required: true, description: '分支节点挂在谁下面' },
        originId: {
          type: 'string',
          required: true,
          description: '从哪个节点分出来的（通常是当前正在做的那个）',
        },
        kind: {
          type: 'string',
          required: true,
          enum: ['module', 'task', 'item'],
          description: '分支节点的层级，必须正好是 parentId 的下一级',
        },
        title: { type: 'string', required: true, description: '分支要做什么' },
        trigger: {
          type: 'string',
          required: true,
          description: '为什么分支：用户临时插进来的 / 发现前置问题 / 外部阻塞 / 其他',
        },
        returnCondition: { type: 'string', description: '什么条件算分支结束、回到主线' },
        resolvesTo: { type: 'string', description: '完成后合回哪个节点，默认=originId' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          try {
            const root = attachBranch(project.root, {
              id: makeNodeId(args.kind, env.rand),
              kind: args.kind,
              title: args.title,
              parentId: args.parentId,
              originId: args.originId,
              trigger: args.trigger,
              ...(args.returnCondition ? { returnCondition: args.returnCondition } : {}),
              ...(args.resolvesTo ? { resolvesTo: args.resolvesTo } : {}),
              origin: 'ai',
              at,
            })
            const branch = collectNodes(root).find(
              (node) => node.branch !== undefined && node.title === args.title.trim(),
            )
            return {
              doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
              result: ok(
                `已登记分支「${args.title.trim()}」${branch ? `(${branch.id})` : ''}，` +
                  `源自 ${args.originId}。为什么：${args.trigger}` +
                  `${args.returnCondition ? `；回归条件：${args.returnCondition}` : ''}。`,
              ),
            }
          } catch (error) {
            return { doc, result: fail('BRANCH_FAILED', (error as Error).message) }
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_branch_resolve',
      description:
        '把分支合回主线。节点不会被删除——"分出去做了什么、最后合回哪里"留在树上，这正是用户不再困惑"这段横插进来的活是什么"的记录。它只记录合回，状态还要另外用 atlas_node_done 收尾。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '分支节点 id' },
        resolution: { type: 'string', required: true, description: '这个分支产出了什么' },
        resolvesTo: { type: 'string', description: '合回哪个节点，默认按分支登记时的 resolvesTo 或 originId' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          try {
            const root = resolveBranch(project.root, args.nodeId, {
              at,
              resolution: args.resolution,
              ...(args.resolvesTo ? { resolvesTo: args.resolvesTo } : {}),
            })
            return {
              doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
              result: ok(`分支 ${args.nodeId} 已合回主线：${args.resolution}`),
            }
          } catch (error) {
            return { doc, result: fail('RESOLVE_FAILED', (error as Error).message) }
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_node_delete',
      description:
        '彻底删除一个节点。只对"刚建出来、从未改过状态、没有子节点"的节点有效——用来清理写错的条目。任何承载过决定的节点只能 atlas_node_status 到 dropped，因为"当初为什么放弃"本身就是要留下的信息。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '要删除的节点 id' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          try {
            const root = deleteNode(project.root, args.nodeId)
            return {
              doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
              result: ok(`已删除节点 ${args.nodeId}。`),
            }
          } catch (error) {
            return { doc, result: fail('DELETE_REFUSED', (error as Error).message) }
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_node_move',
      description:
        '把节点连同整棵子树挪到另一个父节点下。层级是按位置推导的，所以挪动会把子树的层级整体重算（原来当模块的，挪进去就变成任务）。用于重整结构——第一版切法很少是对的，而重建结构会丢掉所有状态和已记录的结果。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '要挪动的节点 id' },
        newParentId: { type: 'string', required: true, description: '新的父节点 id' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          try {
            const root = moveNode(project.root, args.nodeId, args.newParentId, at)
            const moved = findNode(root, args.nodeId)
            return {
              doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
              result: ok(
                `已把「${moved?.title ?? args.nodeId}」(${args.nodeId}) 挪到 ${args.newParentId} 下，` +
                  `当前层级：${moved?.kind ?? '未知'}。`,
              ),
            }
          } catch (error) {
            return { doc, result: fail('MOVE_REFUSED', (error as Error).message) }
          }
        }),
    }),
  )

  // ── workspace history (kickoff input) ───────────────────────────────────
  tools.push(
    defineTool({
      name: 'atlas_workspace_history',
      description:
        '查看这个工作区有没有前情（用户装插件之前就已经积累的工作）。启动时必须先调它。判定包含两种情况：本工作区有别的历史会话；或者当前这个会话本身已经很长很密。有前情 → 不要重新盘问用户，把蓝图从已有材料里重建出来。没前情 → 问用户走快速还是详细拆解。',
      parameters: {},
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (_args, exec) => {
        if (!env.workspaceHistory) {
          return fail(
            'NO_HISTORY_PROBE',
            '宿主没有提供会话查询能力，无法判断是否有前情。按「没有前情」处理：问用户走快速还是详细拆解。',
          )
        }
        const history = await env.workspaceHistory(exec)
        if (!history) {
          return fail('NO_HISTORY_PROBE', '查询会话失败。按「没有前情」处理。')
        }
        if (!history.hasHistory) {
          const counts = history.currentSession
            ? `（当前会话只有 ${history.currentSession.userMessages} 条你的消息，还算不上前情）`
            : ''
          return ok(
            `这个工作区没有前情${counts}：既没有别的历史会话，当前会话也还短。\n` +
              '下一步：问用户走「快速拆解」还是「详细拆解」，然后 atlas_breakdown_draft → atlas_breakdown_confirm。',
          )
        }

        const evidence: string[] = []
        if (history.priorSessionCount > 0) {
          evidence.push(
            `本次对话之前有 ${history.priorSessionCount} 个会话，最近一次在 ` +
              `${history.latestCreatedAt ? new Date(history.latestCreatedAt).toISOString() : '未知时间'}`,
          )
        }
        if (history.currentSession && history.reasons.includes('current-session')) {
          evidence.push(
            `当前这个会话本身已经很长：${history.currentSession.userMessages} 条你的消息、` +
              `${history.currentSession.turns} 轮、${history.currentSession.events} 个事件`,
          )
        }

        const lines = [
          `这个工作区有前情：${evidence.join('；')}。`,
          '',
          '**不要重新盘问用户。** 工作已经在这些对话里描述过了，重新问一遍正是这个插件要消灭的浪费。',
          '',
          '下一步：',
          '1. 把已有材料的来源吃透：别的历史会话用会话检索/读取工具（session_search / session_event_search / session_event_read）读；如果前情就在当前会话里，直接看上面的对话。抓住：真实做了什么、交付了什么、还在做什么、卡在哪、为什么有分歧。',
          '2. 用 atlas_breakdown_draft 起草拆解，然后 atlas_breakdown_confirm（mode 用 fast）。',
          '3. 明确告诉用户：哪些是**从已有材料里读出来的**，哪些是**推断的**、需要他纠正。不要假装确定。',
          '',
          '历史会话（新→旧，最多列出前若干条）：',
        ]
        for (const session of history.priorSessions) {
          lines.push(`- ${session.id} · ${new Date(session.createdAt).toISOString()}`)
        }
        if (history.priorSessionCount > history.priorSessions.length) {
          lines.push(`- …另有 ${history.priorSessionCount - history.priorSessions.length} 个未列出`)
        }
        return ok(lines.join('\n'))
      },
    }),
  )

  // ---- outputs: the handles a node produced --------------------------------
  tools.push(
    defineTool({
      name: 'atlas_output_add',
      description:
        '登记这个节点产出的可打开的东西（网页地址、文件、目录）。做完一次交付就登一次：产出只在对话里说，回头找就得翻记录。同一个 target 重复登记会覆盖而不是重复。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '节点 id' },
        label: { type: 'string', required: true, description: '短标签，例如「分析终端」' },
        target: {
          type: 'string',
          required: true,
          description: '地址或路径本身，例如 http://127.0.0.1:8511/ 或 D:\\x\\report.md',
        },
        kind: {
          type: 'string',
          enum: ['url', 'file', 'dir'],
          description: '不填则按 target 的形状推断（http→url，末段带点→file，否则 dir）',
        },
        note: { type: 'string', description: '怎么用：启动命令、注意事项' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const target = args.target.trim()
          if (target.length === 0) return { doc, result: fail('BAD_TARGET', '地址不能为空。') }
          const at = env.now()
          const node = findNode(project.root, args.nodeId)
          if (!node) return { doc, result: fail('UNKNOWN_NODE', `没有这个节点：${args.nodeId}`) }
          const output = {
            kind: (args.kind ?? guessKind(target)) as 'url' | 'file' | 'dir',
            label: args.label.trim() || target,
            target,
            ...(args.note?.trim() ? { note: args.note.trim() } : {}),
          }
          const outputs = upsertOutput(node.outputs, output)
          const root = updateNode(project.root, node.id, { outputs }, at)
          return {
            doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
            result: ok(
              `已登记产出「${output.label}」（${output.kind}）：${target}。` +
                `该节点现在有 ${outputs.length} 个产出。`,
            ),
          }
        }),
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_output_remove',
      description: '删掉节点上某个已登记的产出（按 target 精确匹配）。用于登记错了或地址失效。',
      parameters: {
        nodeId: { type: 'string', required: true, description: '节点 id' },
        target: { type: 'string', required: true, description: '要删掉的地址或路径' },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          const node = findNode(project.root, args.nodeId)
          if (!node) return { doc, result: fail('UNKNOWN_NODE', `没有这个节点：${args.nodeId}`) }
          const outputs = removeOutput(node.outputs, args.target)
          if (outputs.length === (node.outputs?.length ?? 0)) {
            return { doc, result: fail('NO_SUCH_OUTPUT', '这个节点上没有登记过这个地址。') }
          }
          const root = updateNode(project.root, node.id, { outputs }, at)
          return {
            doc: withProject(doc, project.id, (p) => ({ ...p, root }), at),
            result: ok(`已删除，剩余 ${outputs.length} 个产出。`),
          }
        }),
    }),
  )

  // ---- recovery -----------------------------------------------------------
  tools.push(
    defineTool({
      name: 'atlas_restore',
      description:
        '从工作区的备份文件（.dsh/task-atlas.json）恢复整份任务图谱。用于存储不可用、记录损坏或换机之后。默认只在当前文档为空时写入；确要覆盖现有数据必须显式传 overwrite: true。',
      parameters: {
        overwrite: {
          type: 'boolean',
          description: '当前文档非空时是否覆盖。默认 false，遇到非空会拒绝并说明。',
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) => {
        const cwd = env.workspacePath?.(exec)
        if (!cwd) {
          return fail('NO_WORKSPACE', '定位不到这个会话的工作区路径，无法找到备份文件。')
        }
        const file = path.join(cwd, env.exportDir ?? '.dsh', BACKUP_FILE)
        let text: string
        try {
          text = await readFile(file, 'utf8')
        } catch {
          return fail(
            'NO_BACKUP',
            `没有找到备份文件：${file}。备份在每个回合结束时写入，工作区还没跑过回合时不会有。`,
          )
        }
        const parsed = parseBackup(text)
        if (!parsed.ok) {
          return fail('BAD_BACKUP', `备份文件不可用：${parsed.reason}`)
        }
        const workspaceKey = env.workspaceKey(exec)
        const current = await store.read(workspaceKey)
        if (current && !isBlank(current) && args.overwrite !== true) {
          return fail(
            'BACKUP_EXISTS',
            `当前文档已有 ${current.projects.length} 个项目，不会自动覆盖。确认要用备份替换就传 overwrite: true。`,
          )
        }
        await store.update(workspaceKey, () => ({
          ...parsed.document,
          // A backup can come from a directory that has since been moved or renamed, and
          // the store keys documents by path. Adopting the current key is what makes this
          // work as a recovery path instead of refusing exactly when it is needed.
          workspaceKey,
        }))
        const project = selectProject(parsed.document)
        const nodes = project ? collectNodes(project.root).length : 0
        return ok(
          `已从备份恢复：${parsed.document.projects.length} 个项目、${nodes} 个节点、` +
            `${parsed.document.pending.length} 条待确认。备份导出于 ${
              parsed.exportedAt ? new Date(parsed.exportedAt).toISOString() : '未知时间'
            }。`,
        )
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'atlas_tidy_titles',
      description:
        '把写成句子的节点标题收紧成短标签，并把冒号后面的解释移进该节点的说明。用于修整旧数据（写入端的自动拆分只对之后新增的节点生效）。默认只报告不改，传 apply: true 才落盘。可重复执行，第二次不会有变化。',
      parameters: {
        apply: {
          type: 'boolean',
          description: '是否真的改写。默认 false，只报告会改哪些。',
        },
      },
      output: { schema: RESULT_SCHEMA, render: (_args, value) => text(summaryOf(value)) },
      execute: async (args, exec) =>
        mutate(exec, (doc) => {
          const project = activeProject(doc)
          if (isFailure(project)) return { doc, result: project }
          const at = env.now()
          const outcome = tidyTitles(doc, args.apply === true, at)
          if (outcome.changes.length === 0) {
            return { doc, result: ok('所有标题都已经足够短，不需要整理。') }
          }
          const sample = outcome.changes
            .slice(0, 5)
            .map((change) => `「${change.from.slice(0, 24)}…」→「${change.to}」`)
            .join('；')
          if (args.apply !== true) {
            return {
              doc,
              result: ok(
                `有 ${outcome.changes.length} 个标题偏长（未改动）。例如：${sample}。` +
                  '确认要改就带 apply: true。',
              ),
            }
          }
          return {
            doc: outcome.document,
            result: ok(
              `已收紧 ${outcome.changes.length} 个标题，冒号后的解释已移进各自的说明。例如：${sample}。`,
            ),
          }
        }),
    }),
  )

  return tools
}

/** Minimal host-side context this registration needs. */
export interface ToolsHost {
  readonly tools: { register(definition: ToolDefinition): () => void }
}

/**
 * Register every tool on the host runtime.
 * @param ctx - host context carrying the tool registry.
 * @param store - persistence seam.
 * @param env - injected clock, workspace identity, and randomness.
 * @returns a disposer that removes the whole set.
 */
export function registerTools(
  ctx: ToolsHost,
  store: AtlasStore,
  env: ToolEnv,
): () => void {
  const disposers = buildTools(store, env).map((definition) =>
    ctx.tools.register(definition),
  )
  return () => {
    for (const dispose of disposers) dispose()
  }
}

export { locateNode, flattenProject }
