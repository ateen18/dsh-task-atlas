# dsh-task-atlas · 任务图谱

[![CI](https://github.com/ateen18/dsh-task-atlas/actions/workflows/ci.yml/badge.svg)](https://github.com/ateen18/dsh-task-atlas/actions/workflows/ci.yml)

给 DeepSeek Harness 的**项目拆解 + 任务树**，同时服务于两个人：你和 AI。

它解决的是长对话里的一个具体失效：**上下文越长，主线越淡**。过程信息（报错、文件内容、试错）会把「原本要做什么、现在做到哪、这件事为什么在这儿」淹掉。人靠翻记录找不回来，模型靠读历史也抓不住。

所以插件做两件事：在右侧栏常驻一棵**跟着真实进展变化**的树，并在每一步开始前，把「当前在哪」用一小段话递给模型。

## 它做什么

### 给人看的

- **拆解钉在顶部**：核心意图、核心交付物（含各自验收）、拆解清单、整体验收标准、明确不做什么、约束、优先级。开工时定一次，之后随时可看、可改（改动留修订历史）。
- **三个视图**，各回答一个问题，渲染同一份数据：
  - **树**（默认）：密集、带原因、自动展开当前路径 —— 干活和扫问题用
  - **进展**：模块级进度条 + 变更时间线 —— 看走势用
  - **依赖图**：思维导图式的结构 + 彩色依赖线 —— 看全貌和"谁在等谁"用。层级用中性细线，依赖用琥珀色线；点一个节点，它等的和等它的节点一起点亮；分支可折叠
- **状态不止做完/没做完**：`未开始 / 进行中 / 已完成 / 需返工 / 阻塞 / 已废弃`。负向状态**强制写原因**并保留完整历史；乱序状态**必须你确认**才能生效。
- **分支溯源**：临时插进来的事登记为分支，记住从哪分出、为什么分、什么条件回归、合回哪里。合回后节点保留。
- **前置关系**：`B.dependsOn = [A]` 读作「A 是 B 的前置」。成环会被拒。每个前置还能带一句「需要 A 的什么」，所以连线不是"谁先谁后"的猜测，而是可核对的依赖。
- **详情卡**：面包屑位置、**核心产出（可点开）**、完整说明、**本节点前置依赖（按状态上色）**、开工条件、原因、解除条件、结果、分支、变更历史。
- **「从这里继续」**：点一下，把一段结构化指令（节点、路径、状态、说明、前置、已有产出）发进当前会话，让对话从那个节点接着走。
- **Markdown 镜像**：每回合结束写 `<工作区>/.dsh/task-atlas.md`，可读、可 diff、可进版本库。
- **内置计划只读投影**：DSH 自己的 `todo_write` 与 goal 只读显示，插件从不改写。

### 给模型看的（自动，不需要它想起来）

在 `agent/pre-step` 里注入一段状态，**只在真正有必要时**：

| 何时 | 内容 |
|---|---|
| 状态签名变了（换节点、标完成、计数变化） | 当前节点、路径、前置、下一步（实测约 35 token，硬预算 420 字） |
| 上下文刚被压缩 | 上面那段 + 「任务图谱没有被压缩，进度仍然有效」 |
| 连续 20 步没碰过图谱 | 「如果还在当前节点上就忽略这条；否则登记成分支或更新状态」 |
| 用户连续 2 条消息与项目无关 | **先问再答**：「这是项目外的临时问题，还是要立项？拿到答复再继续」 |

注入失败一律降级为「不注入」，绝不弄坏任何一轮对话。

## 安装

### 前置

| 需要 | 说明 |
|---|---|
| Node.js **≥ 22.19**（或 24+） | 仓库的 `engines` 要求 |
| pnpm | 下面所有命令都用它 |
| DSH Desktop 或 `dsh web` | 实测于 `0.2.1-rc.2` |

### 方式一：让 agent 装（推荐，一条口令）

把下面这段原样发给你的 DSH agent：

```text
帮我安装 DSH 插件「任务图谱」（dsh-task-atlas），仓库是 https://github.com/ateen18/dsh-task-atlas
按这个顺序做，每步做完告诉我结果：

1. 克隆到 ~/dsh-plugins/dsh-task-atlas（目录不存在就先建）。如果 HTTPS 连不上 GitHub，改用 git@github.com:ateen18/dsh-task-atlas.git。
2. 在克隆目录里执行 pnpm install，然后 pnpm run build。
   这一步不能省：仓库里没有 lib/（构建产物不进版本库），而 package.json 的 main 指向 lib/index.js，跳过它插件会加载失败。
3. 进入 ~/.dsh/profiles/desktop，执行 pnpm add link:<克隆目录的绝对路径>。
   如果你用的是 web profile，把 desktop 换成 web。
4. 编辑同目录的 package.json，把 "dsh-task-atlas" 加进 dsh.profile.bundles 数组；已经在里面就不要重复加。
   漏了这一步，宿主按包名找不到插件，重启后面板不出现也不报错。
5. 可选：把 <克隆目录>/skills/task-atlas 整个目录复制到 ~/.dsh/skills/，这是配套的 skill。

装完请报告三件事：lib/index.js 是否存在、profile 的 bundles 里是否已包含 dsh-task-atlas、以及我接下来该怎么重启应用。
不要用 pnpm add dsh-task-atlas —— 这个包没有发布到 npm，会 404。也不要改动存储域名 dsh_task_atlas 或工作区里的 .dsh/task-atlas.* 文件，那些是已有数据。
```

agent 做完后，你只需要**彻底退出应用再启动**（关窗口只是收进托盘）。

### 方式二：自己装（五步）

**1. 克隆并构建**

```sh
git clone https://github.com/ateen18/dsh-task-atlas.git
cd dsh-task-atlas
pnpm install
pnpm run build
```

> **必须构建。** 仓库里没有 `lib/`（构建产物不进版本库），而 `package.json` 的 `main` 指向 `lib/index.js`。跳过这步，插件会加载失败。

**2. 装进 profile**

```sh
cd ~/.dsh/profiles/desktop
pnpm add link:<克隆下来的绝对路径>
```

**3. 让 profile 加载它**

编辑 `~/.dsh/profiles/desktop/package.json`，把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "dsh-task-atlas"
  ] } }
}
```

> 只做了第 2 步、没做第 3 步时，宿主按包名找不到插件，**重启后面板直接不出现，也不报错**。这是安装环节唯一容易漏的一步。

**4. 退出应用再启动**

彻底退出（不是关窗口——关窗口只是收进托盘）。

**5. 验证**

左栏底部出现「▤ 任务图谱」，或右侧栏引导页出现卡片。

### 为什么不直接 `pnpm add github:ateen18/dsh-task-atlas`

试过，**在 pnpm 11 上不可靠**：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
The git-hosted package "dsh-task-atlas@0.0.1" needs to execute build scripts
but is not in the "allowBuilds" allowlist.
```

pnpm 11 默认禁止运行 git 依赖的构建脚本（因为 `lib/` 不在仓库里，必须现场构建）。要这么装就得先在自己的 `pnpm-workspace.yaml` 里 allowlist 这个包，还得你的网络能连 GitHub。仓库里带了 `prepare` 脚本，`npm install` 从 git 装时能自动构建；pnpm 用户建议走上面的五步。

### 升级

```sh
cd <克隆路径>
git pull
pnpm install && pnpm run build
```

然后重启应用。**改了源码必须重新 build**——装上的是 `lib/`，不是 `src/`。

### 卸载

```sh
cd ~/.dsh/profiles/desktop
pnpm remove dsh-task-atlas
```

再把 `dsh.profile.bundles` 里的 `dsh-task-atlas` 删掉，重启。

### 配套 skill（强烈建议）

工具会自己说明用法，但**判断纪律**写在 skill 里：什么时候该拆、`result` 怎么写、为什么不能自己把节点标成需返工、核心产出要登记成可点的把手、以及**怎么对待 `[任务图谱]` 开头的那条消息**（它是插件生成的上下文，不是用户说的话）。

```sh
mkdir -p ~/.dsh/skills
cp -r <克隆路径>/skills/task-atlas ~/.dsh/skills/
```

Windows PowerShell 等价写法（`cp -r` 在 PowerShell 里能用，但参数解析靠缩写，容易踩坑）：

```powershell
Copy-Item -Recurse <克隆路径>\skills\task-atlas $HOME\.dsh\skills\
```

## 工具（19 个）

| 工具 | 权限 | 作用 |
|---|---|---|
| `atlas_status` | 读 | 唯一读取入口：拆解 + 进度 + 树 + 前置 + 当前专注 + 待确认 |
| `atlas_breakdown_draft` | — | 校验拆解草案，不落盘 |
| `atlas_breakdown_confirm` | — | 建项目 + 落拆解 + 按拆解建模块 |
| `atlas_breakdown_amend` | AI 自主 | 修订拆解，**必须写 reason**，逐字段记录「原来 → 现在」 |
| `atlas_node_add` / `atlas_node_update` | AI 自主 | 增改节点（层级由父节点强制；可设 `needs` 开工条件与 `dependsOn` 前置，整体替换） |
| `atlas_node_move` | AI 自主 | 连带子树挪到新父节点；层级按位置重算，状态与历史保留 |
| `atlas_focus` | AI 自主 | 声明「现在在做这个」 |
| `atlas_node_done` | AI 自主 | 完成，`result` 必填 |
| `atlas_node_status` | **分级** | `active`/`pending` 自主；`rework`/`blocked`/`dropped` 需你确认；`dropped → active` 恢复同样需确认 |
| `atlas_confirm` | 用户授权 | 应用一条待确认 |
| `atlas_branch_create` / `atlas_branch_resolve` | AI 自主 | 分支登记与合回 |
| `atlas_output_add` / `atlas_output_remove` | AI 自主 | 节点产出的**可打开把手**（URL / 文件 / 目录）；同一地址重复登记会覆盖 |
| `atlas_node_delete` | 安全阀 | 只删「从未承载过决定」的节点 |
| `atlas_workspace_history` | 读 | 开工前判定这个工作区有没有前情 |
| `atlas_tidy_titles` | AI 自主 | 把写成句子的标题收紧成短标签，解释移进说明；默认只报告，`apply: true` 才落盘 |
| `atlas_restore` | 用户授权 | 从 `<工作区>/.dsh/task-atlas.json` 恢复整份图谱；非空时需显式 `overwrite` |

## 配置

在 profile 的 `cordis.patch.yml` 里按行覆盖（`config` 是整体替换，不是深合并）：

```yaml
- id: task-atlas
  config:
    enabled: true          # 总开关
    exportMarkdown: true   # 是否写 Markdown 镜像
    exportDir: .dsh        # 镜像目录（相对工作区）
    inject: true           # 是否向模型注入状态；嫌吵可以关，面板不受影响
```

## 几个刻意的设计选择

- **`done` 不是终态**。`done → rework` 合法。整件事的理由就是让「做完了但还得改」有正当表达。
- **废弃几乎终态**。唯一出路是 `dropped → active`，且必须写原因 + 你确认——恢复原因进历史，不留成节点的「当前原因」。
- **负向状态必须你确认**。树上变红必须可信；一个会自己变红的树，第二次就没人看了。
- **进度只数叶子**，废弃的节点同时离开分子和分母——否则计划一变，百分比永远爬不上去，你就开始不信这个数。
- **依赖图删过一版，又做回来了，但形态不同**。第一版是 dagre 分层图：真实工作区的图读不动，删了（客户端从 158 kB 降到 70 kB）。现在这一版是**思维导图**——结构是树（项目→模块→任务→子项），依赖是**叠在上面的彩色线**，默认还隐藏，选中节点才显示它的上下游。结论：依赖该在结构之上做一层标注，而不是把结构本身画成一张依赖图。
- **依赖线与层级线是两种东西，必须长得不一样**。层级线细、中性、永远在；依赖线粗、琥珀色、有箭头、点击才出现。同层的两个节点用右侧 C 形连（否则线会绕回去压住两张卡片）；祖先和后代之间的依赖直接复用已有层级线，只把它染色，不再另画一条横穿整棵树的线。
- **面板刷新用长轮询，不是定时轮询**。写入时宿主广播修订号，挂起的请求立刻返回：空闲约 6 次/分钟（原来 24 次），有变化时即时到达。
- **服务端推送（SSE）实现过、单测通过，但没采用**：宿主的 web 服务会结束流式响应，到了应用里每次「推送」都变成「连上就断」。
- **客户端产物只能 require 平台白名单模块**（react 等）。第三方库必须内联，构建护栏会在有人破坏这条时让构建失败。
- **注入只走 user 角色**：`agent/pre-step` 接受用户消息，`agent/pre-call` 明确不能改消息。所以注入内容会出现在对话记录里，前缀 `[任务图谱]` 就是用来区分「这不是你说的」。

## 数据

- **真源**：`ctx.storageDomain` 的 `dsh_task_atlas` 域 `documents` 表，一个工作区一条记录（zod 校验）。
- **镜像**：`<工作区>/.dsh/task-atlas.md`，每回合结束覆盖写，只输出不读入。
- **数据面**：`GET /task-atlas/state`（快照，含 `revision` 与 `drift`）、`GET /task-atlas/wait?revision=N`（长轮询）、`POST /task-atlas/confirm`。
- **兼容旧键**：记录里历史上叫 `charter` 的字段会被归一化成 `breakdown`——改名时没有迁移数据，所以读取端必须认旧键，否则整个域打不开。

## 开发

```sh
pnpm install
pnpm run typecheck    # tsc --noEmit
pnpm test             # node --test test/*.test.ts（273 项）
pnpm run build        # tsdown + 客户端依赖护栏
```

两个诊断脚本（都不是猜，是测量）：

```sh
node scripts/check-storage.mjs            # 存储记录是否仍符合 schema，并打印项目/拆解/修订
node scripts/check-running-build.mjs 端口  # 运行的进程是不是当前构建 + 路由是否真的应答
```

`scripts/restart-desktop.ps1` **不再杀进程**。原因写在文件头：关窗口只是收进托盘，强杀宿主会让桌面端弹「host exited」错误框，而脚本本身又是宿主的子进程，会跟着一起死。

## 兼容性

面向 DSH `0.2.1-rc.2`（`@deepseek-ai/*@0.2.1-rc.2`，cordis `~4.0.5`，zod 固定 `4.4.3`）。DSH 走夜间通道自动更新，插件面变动频繁，所以：

- 只有 `tools` 是硬依赖，其余服务（存储、web server、会话语料）都晚绑定；缺了就在面板上明说，而不是整个插件静默消失。
- 存储不可用时插件仍会启动，并在面板显示失败原因 + 写 `~/.dsh/task-atlas-startup.log`。

## 已知未验证

诚实列出来，免得把「应该能工作」当「已经工作」：

- **压缩后重注**：触发信号是 `compaction/end`，事件名来自运行时事件表，但没观察到真实压缩发生过。
- **话题离题**：单元测试覆盖充分，真实对话里的误报率未知。已知脆弱点：同义词（说「侧边栏」而不是「面板」）会被判离题。
- **视觉验收**：面板的观感只在开发者视角检查过，没有做过真实使用反馈。

## 许可

MIT
