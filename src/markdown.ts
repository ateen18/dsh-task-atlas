/**
 * Human-readable mirror of the atlas.
 *
 * Why it exists: D9 chose `ctx.storageDomain` as the source of truth, which is
 * opaque to you — you cannot open it, diff it, or keep it in a repository. The
 * mirror is written into the workspace on every turn boundary so the plan is
 * inspectable, greppable, and survives the plugin being uninstalled.
 *
 * It is a *mirror*, never an input: nothing reads it back. Editing it by hand is
 * harmless and will simply be overwritten.
 */
import { progressOf } from './model/tree.ts'
import type { AtlasDocument, AtlasNode, AtlasProject } from './model/types.ts'
import type { BuiltinPlan } from './builtin-plan.ts'

const GLYPH: Readonly<Record<string, string>> = {
  pending: ' ',
  active: '~',
  done: 'x',
  rework: '!',
  blocked: '!',
  dropped: '-',
}

const LABEL: Readonly<Record<string, string>> = {
  pending: '未开始',
  active: '进行中',
  done: '已完成',
  rework: '需返工',
  blocked: '阻塞',
  dropped: '已废弃',
}

function timestamp(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

function renderNode(node: AtlasNode, depth: number, focusId: string | undefined): string[] {
  const indent = '  '.repeat(Math.max(0, depth - 1))
  const lines: string[] = []
  const marker = node.id === focusId ? ' ← 当前' : ''
  const state = node.status === 'pending' ? '' : ` ·${LABEL[node.status] ?? node.status}`
  const reason = node.reason ? ` —— ${node.reason}` : ''
  const branch = node.branch
    ? ` 〔分支，源自 ${node.branch.originId}；为什么：${node.branch.trigger}` +
      `${node.branch.resolvedAt ? `；已合回 ${node.branch.resolvesTo ?? node.branch.originId}` : ''}〕`
    : ''
  const dependencies =
    node.dependsOn && node.dependsOn.length > 0
      ? ` 〔前置：${node.dependsOn.join(' / ')}〕`
      : ''
  lines.push(
    `${indent}- [${GLYPH[node.status] ?? ' '}] ${node.title} (${node.id})${state}${reason}${branch}${dependencies}${marker}`,
  )
  if (node.result) {
    lines.push(`${indent}  - 结果：${node.result}`)
  }
  if (node.status === 'blocked' && node.returnCondition) {
    lines.push(`${indent}  - 解除条件：${node.returnCondition}`)
  }
  if (node.history.length > 0) {
    lines.push(`${indent}  - 变更历史：`)
    for (const change of node.history) {
      lines.push(
        `${indent}    - ${timestamp(change.at)} ${change.by === 'ai' ? 'AI' : '你'}：` +
          `${LABEL[change.from] ?? change.from} → ${LABEL[change.to] ?? change.to}` +
          `${change.reason ? `（${change.reason}）` : ''}` +
          `${change.confirmedBy ? `，经${change.confirmedBy === 'user' ? '你' : 'AI'}确认` : ''}`,
      )
    }
  }
  for (const child of node.children) {
    lines.push(...renderNode(child, depth + 1, focusId))
  }
  return lines
}

function renderProject(project: AtlasProject): string[] {
  const progress = progressOf(project.root)
  const lines: string[] = [`## ${project.title}`, '']
  if (project.breakdown) {
    lines.push(`- **核心意图**：${project.breakdown.coreIntent}`)
    lines.push(`- **整体验收标准**：${project.breakdown.acceptance}`)
    lines.push(`- **拆解模式**：${project.breakdown.mode === 'fast' ? '快速拆解' : '详细拆解'}`)
    lines.push(`- **确认时间**：${timestamp(project.breakdown.confirmedAt)}`)
    if (project.breakdown.deliverables.length > 0) {
      lines.push('', '### 核心交付物')
      for (const [index, deliverable] of project.breakdown.deliverables.entries()) {
        lines.push(
          `${index + 1}. ${deliverable.text}` +
            `${deliverable.acceptance ? ` —— 验收：${deliverable.acceptance}` : ' —— 验收：*（未写）*'}`,
        )
      }
    }
    const optional: [string, readonly string[]][] = [
      ['明确不做什么', project.breakdown.outOfScope],
      ['约束与前置依赖', project.breakdown.constraints],
      ['优先级与先后顺序', project.breakdown.priorityOrder],
    ]
    for (const [heading, items] of optional) {
      if (items.length === 0) continue
      lines.push('', `### ${heading}`)
      for (const item of items) lines.push(`- ${item}`)
    }

    const revisions = project.breakdown.revisions ?? []
    if (revisions.length > 0) {
      lines.push('', `### 拆解修订（${revisions.length} 次）`)
      for (const revision of revisions) {
        lines.push(
          '',
          `- **${timestamp(revision.at)}** ${revision.by === 'ai' ? 'AI' : '你'}修订：${revision.reason}`,
        )
        for (const change of revision.changes) {
          lines.push(`  - ${change.field}：「${change.from}」→「${change.to}」`)
        }
      }
    }
  } else {
    lines.push('*（尚未确认任务拆解）*')
  }

  lines.push(
    '',
    '### 进度',
    '',
    `- 完成度：**${Math.round(progress.completion * 100)}%**（${progress.countable} 个可计叶子）`,
    `- 进行中 ${progress.active} · 已完成 ${progress.done} · 需返工 ${progress.rework} · ` +
      `阻塞 ${progress.blocked} · 已废弃 ${progress.dropped} · 未开始 ${progress.pending}`,
    '',
    '### 任务树',
    '',
  )
  lines.push(...renderNode(project.root, 1, project.focusedNodeId))
  return lines
}

function renderBuiltin(builtin: BuiltinPlan | undefined): string[] {
  const lines: string[] = ['', '## 内置计划（只读）', '']
  if (!builtin) {
    lines.push('*（本会话还没有观测到内置待办或目标）*')
    return lines
  }
  if (builtin.goal) {
    lines.push(`- **目标**：${builtin.goal.objective}`)
    if (builtin.goal.phase) lines.push(`  - 阶段：${builtin.goal.phase}`)
    if (builtin.goal.blockerReason) lines.push(`  - 阻塞原因：${builtin.goal.blockerReason}`)
  } else {
    lines.push('- **目标**：（无）')
  }
  if (builtin.todos.length === 0) {
    lines.push('- **内置待办**：（空）')
  } else {
    lines.push('- **内置待办**：')
    for (const todo of builtin.todos) {
      const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '
      lines.push(`  - [${mark}] ${todo.content}`)
    }
  }
  lines.push('', '*这一节由插件只读投影，来自 DSH 自己的 todo_write / goal；插件从不修改它们。*')
  return lines
}

/**
 * Render the whole workspace document as Markdown.
 * @param doc - the workspace document.
 * @param builtin - the mirrored built-in plan for the requesting session, if any.
 * @param at - epoch milliseconds of the export.
 * @returns the file content.
 */
export function renderWorkspaceMarkdown(
  doc: AtlasDocument,
  builtin: BuiltinPlan | undefined,
  at: number,
): string {
  const lines: string[] = [
    '# 任务图谱',
    '',
    `> 由 dsh-task-atlas 自动生成，请勿手工编辑（每次回合结束会被覆盖）。`,
    `> 工作区：\`${doc.workspaceKey}\` · 导出时间：${timestamp(at)}`,
    '',
  ]

  if (doc.projects.length === 0) {
    lines.push('*这个工作区还没有项目。让 AI 走一次启动拆解即可建立。*')
  }

  for (const project of doc.projects) {
    const isActive = project.id === doc.activeProjectId
    lines.push(isActive ? '（当前活动项目）' : '', ...renderProject(project), '')
  }

  if (doc.pending.length > 0) {
    lines.push('## 待你确认', '')
    for (const item of doc.pending) {
      lines.push(
        `- \`${item.id}\`：把 \`${item.nodeId}\` 改为 **${LABEL[item.to] ?? item.to}**` +
          `${item.reason ? ` —— ${item.reason}` : ''}`,
      )
    }
    lines.push('')
  }

  lines.push(...renderBuiltin(builtin))
  lines.push('', '---', '')
  return lines.join('\n')
}
