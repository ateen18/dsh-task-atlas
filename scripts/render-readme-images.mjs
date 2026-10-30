/**
 * Render the README figures.
 *
 * These are drawn from the plugin's own layout code rather than captured from a screen, for two
 * reasons: a screenshot goes stale the moment the panel changes, and a re-render cannot show a
 * state the code would never produce. The data below is a representative plan, so the figures do
 * not depend on any local workspace.
 *
 * Output: docs/images/*.svg (committed; this script is a build-time convenience, not a dependency).
 *
 * Usage: node scripts/render-readme-images.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'docs', 'images')
mkdirSync(outDir, { recursive: true })

const INK = '#1f2328'
const MUTED = '#6b7280'
const FAINT = '#9ca3af'
const LINE = '#d0d7de'
const SURFACE = '#f6f8fa'
const CARD = '#ffffff'
const DEP = '#d97706'
const FOCUS = '#b91c1c'
const DISPLAY = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif`

const STATUS = {
  done: { label: '已完成', color: '#1a7f37' },
  active: { label: '进行中', color: '#0969da' },
  pending: { label: '未开始', color: '#8b949e' },
  rework: { label: '需返工', color: '#bf8700' },
  blocked: { label: '阻塞', color: '#cf222e' },
  dropped: { label: '已废弃', color: '#afb8c1' },
}

const esc = (text) =>
  String(text).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])

/** Rough width of a string at a given size: CJK is one em, latin about half. */
function textWidth(text, size) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u3000-\u9fff\uff00-\uffef]/.test(char) ? size : size * 0.58
  }
  return width
}

/** Cut a label to fit, with an ellipsis. */
function clip(text, size, maxWidth) {
  if (textWidth(text, size) <= maxWidth) return String(text)
  let out = ''
  for (const char of String(text)) {
    if (textWidth(`${out}${char}…`, size) > maxWidth) break
    out += char
  }
  return `${out}…`
}

const frame = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${DISPLAY}">
<defs>
  <marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L8,4 L0,8 Z" fill="${DEP}"/>
  </marker>
</defs>
<rect width="${width}" height="${height}" fill="${SURFACE}"/>
${body}
</svg>
`

// ---------------------------------------------------------------- panel figure

const tree = [
  { depth: 0, title: '会话结构化插件', status: 'active', count: '2/8' },
  { depth: 1, title: '用户面', status: 'done' },
  { depth: 2, title: '节点状态', status: 'done' },
  { depth: 2, title: '分支溯源', status: 'done' },
  { depth: 2, title: '呈现：右侧栏一眼看见全貌', status: 'active', focus: true },
  { depth: 1, title: 'AI 面', status: 'active' },
  { depth: 2, title: '给 AI 的主线保持', status: 'active', badge: '⇢2' },
  { depth: 3, title: '每轮开头自动注入', status: 'done' },
  { depth: 3, title: '压缩之后重注', status: 'done' },
  { depth: 1, title: '共享底座', status: 'done' },
  { depth: 2, title: '任务拆解', status: 'done', badge: '⇢1' },
]

function panelFigure() {
  const width = 520
  const rowH = 26
  const top = 96
  const rows = tree
    .map((node, index) => {
      const y = top + index * rowH
      const indent = 14 + node.depth * 16
      const status = STATUS[node.status]
      const marker = node.focus
        ? `<text x="${indent}" y="${y + 12}" font-size="13" fill="${FOCUS}">★</text>`
        : `<circle cx="${indent + 4}" cy="${y + 8}" r="4" fill="${status.color}"/>`
      const label = clip(node.title, 12, 250 - node.depth * 16)
      const badge = node.badge
        ? `<text x="${width - 96}" y="${y + 11}" font-size="10" fill="${MUTED}">${esc(node.badge)}</text>`
        : ''
      const pill = `<text x="${width - 58}" y="${y + 11}" font-size="10" fill="${status.color}">${status.label}</text>`
      return `${marker}
      <text x="${indent + 16}" y="${y + 12}" font-size="12" fill="${node.focus ? INK : '#24292f'}">${esc(label)}</text>
      ${badge}${pill}`
    })
    .join('\n')

  const detailY = top + tree.length * rowH + 14

  return frame(
    width,
    760,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="759" fill="${CARD}" stroke="${LINE}"/>
<text x="16" y="26" font-size="13.5" font-weight="650" fill="${INK}">任务图谱</text>
<text x="${width - 128}" y="26" font-size="10.5" fill="${MUTED}">[树] [进展] [依赖图]</text>
<line x1="0" y1="40" x2="${width}" y2="40" stroke="${LINE}"/>
<text x="16" y="58" font-size="12" font-weight="600" fill="${INK}">会话结构化插件</text>
<text x="132" y="58" font-size="10.5" fill="${MUTED}">62% · 8/13</text>
<text x="16" y="74" font-size="10.5" fill="${MUTED}">长对话里人和 AI 会丢失同一批东西：任务原本要做什么、现在做到哪、为什么分支。</text>
<rect x="16" y="82" width="${width - 32}" height="3" rx="1.5" fill="#eaeef2"/>
<rect x="16" y="82" width="${Math.round((width - 32) * 0.62)}" height="3" rx="1.5" fill="#1a7f37"/>
<line x1="0" y1="92" x2="${width}" y2="92" stroke="${LINE}"/>
${rows}
<line x1="0" y1="${detailY - 8}" x2="${width}" y2="${detailY - 8}" stroke="${LINE}"/>
<rect x="16" y="${detailY}" width="${width - 32}" height="196" rx="6" fill="#ffffff" stroke="${LINE}"/>
<text x="28" y="${detailY + 20}" font-size="12.5" font-weight="600" fill="${INK}">呈现：右侧栏一眼看见全貌</text>
<text x="222" y="${detailY + 20}" font-size="10.5" fill="#0969da">进行中</text>
<text x="28" y="${detailY + 36}" font-size="10.5" fill="${MUTED}">核心产出（2）</text>
<text x="28" y="${detailY + 52}" font-size="10.5" fill="${MUTED}">URL</text>
<text x="58" y="${detailY + 52}" font-size="10.5" fill="${INK}">分析终端</text>
<text x="112" y="${detailY + 52}" font-size="10.5" fill="#0969da">http://127.0.0.1:8511/</text>
<text x="28" y="${detailY + 68}" font-size="10.5" fill="${MUTED}">FILE</text>
<text x="58" y="${detailY + 68}" font-size="10.5" fill="${INK}">月度复盘报告   D:\\产出\\报告.md</text>
<text x="292" y="${detailY + 68}" font-size="10" fill="${MUTED}">[复制路径]</text>
<text x="28" y="${detailY + 92}" font-size="10.5" fill="${MUTED}">本节点前置依赖（2）</text>
<circle cx="34" cy="${detailY + 106}" r="3.5" fill="#1a7f37"/>
<text x="44" y="${detailY + 110}" font-size="10.5" fill="#1a7f37">节点状态</text>
<text x="96" y="${detailY + 110}" font-size="10" fill="${MUTED}">已完成 · 需要：状态词表</text>
<circle cx="34" cy="${detailY + 124}" r="3.5" fill="#0969da"/>
<text x="44" y="${detailY + 128}" font-size="10.5" fill="#0969da">分支溯源</text>
<text x="96" y="${detailY + 128}" font-size="10" fill="${MUTED}">进行中 · 需要：节点直系父链</text>
<text x="28" y="${detailY + 152}" font-size="10.5" fill="${MUTED}">开工条件 2 项 · 已满足</text>
<rect x="28" y="${detailY + 162}" width="132" height="22" rx="4" fill="#f6f8fa" stroke="${LINE}"/>
<text x="46" y="${detailY + 177}" font-size="10.5" fill="${INK}">从这里继续</text>
<text x="170" y="${detailY + 177}" font-size="10" fill="${MUTED}">把这个节点发进当前会话</text>`,
  )
}

// --------------------------------------------------------------- canvas figure

const canvasNodes = [
  { id: 'p', x: 24, y: 300, title: '会话结构化插件', status: 'active', w: 150 },
  { id: 'm1', x: 250, y: 120, title: '用户面', status: 'done', w: 130 },
  { id: 'm2', x: 250, y: 360, title: 'AI 面', status: 'active', w: 130 },
  { id: 'm3', x: 250, y: 600, title: '共享底座', status: 'done', w: 130 },
  { id: 't1', x: 470, y: 60, title: '节点状态', status: 'done' },
  { id: 't2', x: 470, y: 160, title: '分支溯源', status: 'done' },
  { id: 't3', x: 470, y: 260, title: '呈现', status: 'active', focus: true },
  { id: 't4', x: 470, y: 360, title: '每轮注入', status: 'done' },
  { id: 't5', x: 470, y: 460, title: '压缩后重注', status: 'done' },
  { id: 't6', x: 470, y: 600, title: '拆解结构', status: 'done' },
  { id: 't7', x: 470, y: 700, title: '持久化', status: 'done' },
]
const CARD_H = 46
const hierarchy = [
  ['p', 'm1'],
  ['p', 'm2'],
  ['p', 'm3'],
  ['m1', 't1'],
  ['m1', 't2'],
  ['m1', 't3'],
  ['m2', 't4'],
  ['m2', 't5'],
  ['m3', 't6'],
  ['m3', 't7'],
]
const dependencies = [
  { from: 't4', to: 't5', label: '注入通道与预算' },
  { from: 't6', to: 't7', label: '树的序列化结构' },
  { from: 't1', to: 't2', label: '状态词表' },
]

function canvasFigure() {
  const width = 780
  const height = 800
  const byId = new Map(canvasNodes.map((node) => [node.id, node]))
  const cardW = (node) => node.w ?? 140

  const hierarchyPaths = hierarchy
    .map(([fromId, toId]) => {
      const from = byId.get(fromId)
      const to = byId.get(toId)
      const x1 = from.x + cardW(from)
      const y1 = from.y + CARD_H / 2
      const x2 = to.x
      const y2 = to.y + CARD_H / 2
      const bend = Math.max(30, Math.abs(x2 - x1) / 2)
      return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" fill="none" stroke="${LINE}" stroke-width="1.2"/>`
    })
    .join('\n')

  // Same-column dependencies route right-edge to right-edge; here every case is a sibling pair.
  const dependencyPaths = dependencies
    .map(({ from: fromId, to: toId, label }) => {
      const from = byId.get(fromId)
      const to = byId.get(toId)
      const x1 = from.x + cardW(from)
      const y1 = from.y + CARD_H / 2
      const x2 = to.x + cardW(to)
      const y2 = to.y + CARD_H / 2
      const bulge = 46 + Math.min(90, Math.abs(y2 - y1) / 2)
      const apexX = Math.max(from.x, to.x) + Math.max(cardW(from), cardW(to)) + bulge * 0.72
      return `<path d="M ${x1} ${y1} C ${x1 + bulge} ${y1}, ${x2 + bulge} ${y2}, ${x2} ${y2}" fill="none" stroke="${DEP}" stroke-width="1.9" marker-end="url(#dep-arrow)"/>
      <text x="${apexX}" y="${(y1 + y2) / 2 - 4}" text-anchor="middle" font-size="9" fill="${DEP}">${esc(label)}</text>`
    })
    .join('\n')

  const cards = canvasNodes
    .map((node) => {
      const status = STATUS[node.status]
      const selected = node.id === 't2'
      // Neighbours of the selection: its upstream (t1) and downstream (none).
      const neighbour = node.id === 't1'
      const dimmed = !selected && !neighbour
      const marker = node.focus
        ? `<text x="${node.x + 9}" y="${node.y + 19}" font-size="11" fill="${FOCUS}">★</text>`
        : `<circle cx="${node.x + 13}" cy="${node.y + 15}" r="3.5" fill="${status.color}"/>`
      return `<g opacity="${dimmed ? 0.45 : 1}">
        <rect x="${node.x}" y="${node.y}" width="${cardW(node)}" height="${CARD_H}" rx="6" fill="${CARD}" stroke="${selected ? '#0969da' : LINE}" stroke-width="${selected ? 2 : 1}"/>
        ${marker}
        <text x="${node.x + 22}" y="${node.y + 19}" font-size="11.5" fill="${INK}">${esc(clip(node.title, 11.5, cardW(node) - 32))}</text>
        <text x="${node.x + 22}" y="${node.y + 34}" font-size="9.5" fill="${status.color}">${status.label}</text>
      </g>`
    })
    .join('\n')

  return frame(
    width,
    height,
    `<text x="24" y="28" font-size="12" fill="${MUTED}">结构：项目 → 模块 → 任务（细线） 　依赖：谁等谁（<tspan fill="${DEP}" font-weight="600">琥珀色</tspan>，点节点才显示）</text>
${hierarchyPaths}
${dependencyPaths}
${cards}
<text x="24" y="${736}" font-size="10" fill="${MUTED}">★ 当前在做的节点 · 蓝框为选中节点 · 它的上游（节点状态）一起点亮，其余变暗</text>`,
  )
}

// ------------------------------------------------------------------- the loop

function loopFigure() {
  const width = 780
  const height = 250
  const boxes = [
    { x: 24, y: 70, w: 168, h: 74, title: '拆解', lines: ['核心意图 · 交付物', '验收 · 不做什么'] },
    { x: 218, y: 70, w: 168, h: 74, title: '任务树', lines: ['状态 · 原因 · 历史', '分支 · 前置 · 产出'] },
    { x: 412, y: 70, w: 168, h: 74, title: '每步注入', lines: ['[任务图谱] 一小段', '按签名去重'] },
    { x: 606, y: 70, w: 150, h: 74, title: '模型', lines: ['知道自己在哪', '不用重读全部历史'] },
  ]
  const arrows = [
    [192, 107, 218, 107],
    [386, 107, 412, 107],
    [580, 107, 606, 107],
  ]
    .map(
      ([x1, y1, x2, y2]) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${MUTED}" stroke-width="1.4" marker-end="url(#loop-arrow)"/>`,
    )
    .join('\n')
  const cards = boxes
    .map(
      (box) => `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="${CARD}" stroke="${LINE}"/>
      <text x="${box.x + 14}" y="${box.y + 26}" font-size="12.5" font-weight="600" fill="${INK}">${esc(box.title)}</text>
      <text x="${box.x + 14}" y="${box.y + 46}" font-size="10.5" fill="${MUTED}">${esc(box.lines[0])}</text>
      <text x="${box.x + 14}" y="${box.y + 62}" font-size="10.5" fill="${MUTED}">${esc(box.lines[1])}</text>`,
    )
    .join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${DISPLAY}">
<defs>
  <marker id="loop-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L8,4 L0,8 Z" fill="${MUTED}"/>
  </marker>
</defs>
<rect width="${width}" height="${height}" fill="${SURFACE}"/>
${cards}
${arrows}
<path d="M 681 144 L 681 196 L 108 196 L 108 144" fill="none" stroke="${FAINT}" stroke-width="1.3" stroke-dasharray="4 3" marker-end="url(#loop-arrow)"/>
<text x="330" y="214" font-size="10.5" fill="${MUTED}">回合结束时回写真实进展：完成、返工、阻塞、分支、产出</text>
</svg>
`
}

const write = (name, content) => {
  writeFileSync(path.join(outDir, name), content, 'utf8')
  console.log(`  wrote docs/images/${name}`)
}

write('panel.svg', panelFigure())
write('canvas.svg', canvasFigure())
write('loop.svg', loopFigure())
console.log('done')
