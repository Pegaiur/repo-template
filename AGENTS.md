# <仓库名> — 项目代理指南

> 本文件为过程管理模板的 AGENTS.md 骨架。
> 标注 **【可选】** 的段落为特定语言/包管理策略示例，按仓库实际取舍；其余骨架通用。

## 项目概述

**<仓库名>** 是<一句话定位>。

<!-- 【可选-技术栈】按仓库实际填写语言、框架、包管理器、运行平台等一行概述。示例：
- TypeScript / Node.js · pnpm workspaces monorepo · 仅支持 Windows 平台
- Rust · Cargo workspace · 跨平台
-->

## 全局规则

以下规则适用于所有子模块，AI 代理在任何地方修改代码时必须遵守。

> 编码核心约束内联于下方（常驻上下文，全仓生效）；其余复杂规则定义在 `docs/rules/` 目录（软件中立权威目录，不依赖任何 IDE/Agent 专属目录），任务开始前按需读取（触发场景见下方规则索引表）。AGENTS.md 仅保留本段编码约束、规则索引和工作流路由。

### 编码核心约束（常驻上下文，全仓生效）

1. **中文注释与提交**：代码注释和提交信息使用中文
2. **密钥与敏感信息**：API Key 等敏感配置统一经仓库约定的配置模块读取，禁止硬编码；日志和输出不得暴露密钥、内网地址或内部服务 URL，敏感配置值必须脱敏
3. **错误提示中文**：面向用户的错误消息和日志输出使用中文
4. **依赖方向单向**：按仓库分层约定保持依赖方向（如 `apps → tools → platform`），底层不得反向依赖上层
5. **无全局副作用**：模块顶层不得执行网络请求、文件写入等运行时副作用
6. **无调试与死代码残留**：提交前清理 `console.log`/`debugger`、注释掉的代码、未使用的 import/变量/函数

<!-- 【可选-平台】Windows 专属仓库追加：
7. **安全与操作**：禁止 `rm -rf`/`Remove-Item -Recurse -Force` 等销毁性命令；批量修改超 3 个文件前先展示变更摘要；`git add` 前确认暂存区仅含目标文件；临时文件写仓库根 `dev-temp/`（开发脚本临时区）并任务结束经 `node scripts/tooling.mjs tmp clean` 清理；任务完成前执行收尾守卫脚本（如 check-agent-guard）
   非 Windows 仓库可将守卫脚本替换为等价 shell 脚本或省略本条。
-->

| # | 规则                                                                                                                                                          | 详情                                 |
| - | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1 | 提交必须通过 `commit-convention` 技能，禁止直接使用 `git commit`                                                                                                           | 见下方「工作流路由」                         |
| 2 | 分支工作流：禁止直接在主分支提交，走 `feature/<描述>` 分支；合并后删除分支                                                                                                                | —                                  |
| 3 | 合并门槛：合并前一律执行 `node scripts/verify.mjs merge -- --base <主分支>`（门禁唯一入口，命令清单见 `scripts/gates.mjs`）；通过后 `--no-ff` 合入主分支，发版以通过 release 门禁的 merge commit 作为 tag 目标 | `docs/rules/document-lifecycle.md` |
| 4 | 文档模板：ADR 参照 `docs/templates/adr.md`，plan 参照 `docs/templates/plan.md`，实施笔记参照 `docs/templates/notes.md`                                                       | —                                  |

<!-- 【可选-数据库】涉及 SQLite 的仓库追加数据库操作规则（单例连接、Schema 迁移仅前滚、参数化查询、事务包裹、测试隔离），沉淀为 docs/rules/database-operations.md 并在此表登记。 -->

## 工作流路由

> 提交/发版等仓库工作流由 `skills/` 目录下的开放格式技能承载（`skills/<name>/SKILL.md`，不依赖宿主技能发现）；机械事实委托仓库脚本，技能只保留时机、判断与确认。

| 工作流     | 入口                                                                                |
| ------- | --------------------------------------------------------------------------------- |
| 提交      | `skills/commit-convention`（禁止直接 `git commit`）                                     |
| 发版 | `skills/release-workflow` + `node scripts/tooling.mjs run release/*`（版本推算/写入；tag 由 release-workflow 手动创建） |
| 技术债治理   | `skills/tech-debt-governance`（三维扫描 → 双 agent 交叉审查 → ROI 分批收敛）                     |
| 验证（合并前） | `node scripts/verify.mjs merge`（门禁唯一入口）                                           |
| 文档生命周期  | `docs/rules/document-lifecycle`（ADR/plan/notes 模板见 `docs/templates/`）             |

## 仓库结构

```
<repo>/
├── AGENTS.md                       ← 本文件（规则索引 + 结构导航 + 工作流路由）
├── scripts/                        ← 开发脚本（导航见 scripts/INDEX.md；tooling.mjs 管理 tasks/lib 生命周期）
│   ├── verify.mjs                  ← 合并/发版门禁唯一入口（引擎）
│   ├── gates.mjs                   ← 门禁命令清单（适配层，换技术栈必改）
│   ├── doc-check.mjs               ← 文档一致性校验（合并门禁组成部分）
│   ├── tooling.mjs                 ← 开发任务工具（list/run/new/promote/tmp）
│   ├── lib/                        ← 共享基元（只读 git、版本推算、skill 校验等）
│   └── tasks/                      ← 开发任务（release 发版四件套、git 只读取证）
├── docs/
│   ├── rules/                      ← 复杂规则权威目录
│   ├── templates/                  ← ADR/plan/notes 机械模板唯一权威目录
│   ├── inbox.md                    ← 需求唯一入口（待评估 → [x] 完成 → 发版删除）
│   ├── plan-*.md                   ← 已定稿版本计划
│   ├── draft-*.md                  ← 未定稿提案
│   ├── *-notes.md                  ← 施工期实施笔记
│   ├── adr/                        ← 架构决策记录（INDEX.md 为状态权威索引）
│   └── archive/                    ← 已归档的计划（INDEX.md 按完成日期降序）
├── skills/                         ← 仓库工作流唯一权威目录（开放 Agent Skills 格式）
│   └── <skill-name>/SKILL.md       ← 提交/发版/技术债等工作流正文
└── dev-temp/                       ← 开发脚本临时区（不入版本控制，可清理）
```

<!-- 【可选-monorepo】多包仓库在此追加包结构树与职责注释，包级约定放 `packages/<scope>/<dir>/PACKAGE.md`；包名→目录名映射不总是直接时，定位兜底按序使用：目录树 → Glob 全量枚举 PACKAGE.md → Grep 反查。 -->

## AI 代理发现流程

1. **首先**：阅读本文件，了解全局规则和项目架构
2. **按需读取复杂规则**：任务涉及文档/ADR/发版/合并 → 读 `docs/rules/document-lifecycle.md`；其余场景按规则索引表从 `docs/rules/` 挑选匹配描述。该目录为软件中立目录，宿主不自动注入时必须显式读取
3. **新需求入口**：所有新需求/决策从 `docs/inbox.md` 起步，评估后路由到 `docs/plan-*.md`（定稿）或 `docs/adr/ADR-NNN.md`
4. **确定任务范围**：判断当前任务涉及哪些模块/子包
5. **跨模块契约**：【可选】有跨模块契约 spec 的仓库，按下表找到权威 spec（各 spec 的完整 schema/接口/状态机定义见 `docs/specs/<name>.md`）；无则删除本步与下表。

   | Spec | 版本 | 状态 | 关联 ADR | 关联模块 | 日期 |
   |------|------|------|----------|----------|------|
   | （示例占位，登记时替换）`<spec 名称>` | `0.1` | 草稿 | `<ADR-NNN>` | `<模块>` | `<YYYY-MM-DD>` |

6. **加载包级约定**：【可选-monorepo】包级约定在 `packages/<scope>/<dir>/PACKAGE.md`（包名→目录名映射不总是直接时，按 目录树 → Glob 枚举 PACKAGE.md → Grep 反查 兜底定位）；无则删除本步。
7. **阅读代码**：参考同模块内其他实现风格

## 版本管理

- 根版本号由 Conventional Commits 驱动自动推算（`node scripts/tooling.mjs run release/calculate-version`，pre-1.0 保护：0.x 阶段 breaking 只 bump minor）；各子包版本独立基线，逐包按路径过滤提交推算，随发版独立 bump。

<!-- 【可选-monorepo-私有多包】子包全部 private、不发布、依赖一律 workspace:* 时，子包版本仅作独立基线随发版推算（无发布语义）；
   任一子包改为对外发布或依赖解析到 registry 版本时，升级 changesets 类多包发版工具。 -->

## Git 环境

首次 git 操作前执行以下配置（仓库约定，不依赖用户级规则）：

- 必选：`git config i18n.commitEncoding utf-8`、`git config i18n.logOutputEncoding utf-8`、`git config core.quotepath false`（保证中文提交/日志/路径显示正确）
- 可选：`git config --global core.pager cat`（全局影响本机所有仓库的 git 显示行为，git 永久不分页；由使用者自行决定是否设置）

## 运行与验证

```bash
node scripts/tooling.mjs list                        # 列出可复用开发任务（scripts/tasks/）
node scripts/tooling.mjs list --lib                  # 枚举共享基元
node scripts/tooling.mjs run <task> -- <args>        # 运行任务
node scripts/doc-check.mjs                           # 文档一致性校验
node scripts/verify.mjs merge -- --base <主分支>      # 合并门禁
node scripts/verify.mjs release                      # 发版门禁（全量）
```

> 验证命令以 `scripts/gates.mjs` 门禁清单为准。按变更类型选择验证：普通代码修改运行受影响模块的 typecheck + test；修改文档/skills 先跑 `node scripts/doc-check.mjs`；合并前一律 `node scripts/verify.mjs merge -- --base <主分支>`；发版/tag 走 `verify release`（见 skills/release-workflow）。

## 文档导航

| 文档                                               | 用途                                                  |
| ------------------------------------------------ | --------------------------------------------------- |
| [`docs/inbox.md`](docs/inbox.md)                 | 待办事项需求唯一入口                                          |
| [`docs/rules/`](docs/rules/)                     | 复杂规则权威目录                                            |
| [`docs/templates/`](docs/templates/)             | ADR/plan/notes 机械模板唯一权威目录                           |
| [`docs/adr/INDEX.md`](docs/adr/INDEX.md)         | ADR 状态索引                                            |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md)         | 版本变更事实（发版收束时由脚本追加；发版后新任务可先读最近版本段或用 changelog --agent 视图） |
| [`docs/archive/INDEX.md`](docs/archive/INDEX.md) | 已完成计划归档索引（按日期降序）                                    |
| [`scripts/INDEX.md`](scripts/INDEX.md)           | 开发脚本体系导航（scratch→tasks→lib 生命周期、lib 模块表、tooling 用法） |
