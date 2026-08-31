---
description: 修改文档、操作 ADR、发版、合并分支时生效
---
# 文档生命周期规则

> 此规则在文档/ADR/发版/合并场景下生效，确保文档修改行为一致。

## 文档角色与生命周期

| 文档 | 角色 | 创建时机 | 修改时机 | 删除/冻结时机 |
|------|------|----------|----------|-------------|
| `AGENTS.md` | 入口（规则索引 + 结构导航 + 工作流路由） | 项目初始化 | 随仓库规则演进 | 不删除 |
| `docs/inbox.md` | 收件箱（需求捕获与路由） | 项目初始化 | 每次有新需求/想法时 | 发版时删除 `[x]` 条目 |
| `docs/plan-*.md` | 蓝图（已定稿，仅 checklist `[ ]` → `[x]`） | 立项 | 开发中待办状态变化 | 冻结时全部 `[x]` + 标记完成日期 → 移入 `docs/archive/` |
| `docs/draft-*.md` | 蓝图提案（未定稿，scope 讨论中） | 立项 | 计划定稿前任意修改 | 定稿后重命名为 `plan-*.md` |
| `docs/adr/ADR-*.md` | 决策记录（前因/why） | 架构决策时 | 状态变更时 | 被替代时标 `已废弃` |
| `docs/adr/INDEX.md` | ADR 索引 | 项目初始化 | 新增/修改 ADR | 不删除 |
| `docs/*-notes.md` | 实施笔记（spec→代码的决策/变更/权衡日志） | 开始实施 spec 时 | 流式追加，每完成一个决策/变更立即记录 | 归档时合并到 plan 末尾（新增 `## 实施纪要` 段）→ 删除 notes 文件 |
| `docs/archive/` | 归档（已冻结版本计划） | 项目初始化 | 发版时移入已冻结 plan | 不删除 |
| `docs/CHANGELOG.md` | 更新日志（版本变更事实，与 archive INDEX 分工：INDEX=计划索引） | 首个发版由脚本创建 | 发版收束时追加新版本段 | 只累积、不重写历史 |
| `docs/templates/` | 模板（机械格式） | 一次性创建 | 格式升级 | 不删除 |

> monorepo 可追加 `PACKAGE.md`（子包约定）一行：子包创建时建立、发版前统一更新、不删除。

### Plan 状态与执行顺序

Plan 是供人和 Agent 共同阅读的 Markdown 蓝图，不承载执行器状态、任务 prompt 或调度 DAG，禁止使用 `phases/task_prompt/depends_on` 一类 YAML frontmatter 维护第二份实施方案。实施顺序与真实依赖直接写在正文；施工进度以「验收清单」checkbox 为唯一机械信号，状态行与冻结标记只表示文档生命周期。历史归档保持原貌，不为模板升级批量回写。

## ADR 判定与维护

以下变更需要 ADR：引入或替换架构级第三方依赖、修改跨模块公共接口或依赖方向、拆分/合并子模块、改变构建或分发策略、废弃已生效方案、调整锁或测试策略等横切机制。

Bug 修复、向后兼容的可选字段、单模块内部重构、配置值调整、注释和文档同步不单独创建 ADR。一个 ADR 应覆盖同一主题下的一组关联决策。

新增 ADR 时：

1. 从 `docs/adr/INDEX.md` 获取最大编号并递增，文件名使用 `ADR-NNN-<kebab-case>.md`。
2. 复制 `docs/templates/adr.md` 填写，不在规则或技能中维护模板副本。
3. 同步更新 `docs/adr/INDEX.md`；状态变更时 ADR 文件与 INDEX 必须保持一致。

## 实施笔记维护

实施笔记（`docs/*-notes.md`）是 spec 到代码的决策/变更/权衡日志，记录 spec 之外的决策、偏离、意外发现与阻塞解决。以下任一场景发生时创建或更新：开始按 spec（`docs/plan-*.md` / `docs/adr/ADR-*.md`）实施编码、做出 spec 未覆盖的决策、实施方式与 spec 不一致、发现 spec 遗漏的依赖/边界/风险、在两个可行方案中做权衡、解决阻塞问题。

新增或更新笔记时：

1. 与对应 spec 同目录，命名 `{spec文件名}-notes.md`（如 `docs/plan-v1-notes.md`）；开始实施 spec 的第一步时创建。
2. **流式追加**：每完成一个决策/变更/权衡立即记录，不批处理攒到最后。
3. 复制 `docs/templates/notes.md` 填写，不在规则中维护模板副本（与 ADR 模板同口径）。

归档合并（发版时执行，由 `release/archive-plan` **自动完成**，禁止手动拼接）：

- **触发**：执行 `node scripts/tooling.mjs run release/prepare -- --plan docs/plan-xxx.md --apply`（或单独 `run release/archive-plan`）时，脚本自动推导同目录 `docs/plan-xxx-notes.md`，将其五段（决策偏离、实现调整、债务记录、意外发现、阻塞与解决）作为 `## 实施纪要` 段合并到 plan 末尾（空段跳过），归档后删除 notes 文件，不在 `docs/archive/` 留独立文件。
- **正确姿势**：直接运行脚本归档即可，**不要**预先手动把 notes 内容拼进 plan 或手动删除 notes——那会绕过脚本的 notes 合并逻辑（脚本检测不到 notes 便静默跳过，归档结果看似正确但流程失真，notes 存在性校验失效，且手动拼接与脚本输出格式易漂移）。

notes 中发现的重大架构决策应升级为正式 ADR（见上「ADR 判定与维护」），新需求追加到 `docs/inbox.md`。

常见陷阱：只记成功不记失败、把 notes 写成代码注释替代品、spec 修订后未在 notes 对应条目标注"已回馈 spec"。

## 合并门槛（gate-check）

合并 feature 分支到主分支前，**必须**通过 `node scripts/verify.mjs merge`（merge profile 唯一入口，命令清单见 `scripts/gates.mjs` 与 `scripts/verify.mjs`，不在此复制底层命令）；其中文档一致性校验由 `node scripts/doc-check.mjs` 承担（verify merge 内含该步骤）：

| 检查项 | 阻塞级 | 说明 |
|--------|:---:|------|
| 活动 plan checklist 全部 `[x]` | ❌ 阻塞 | 活动 plan（`docs/` 下）不能有未勾选条目；archive 内已归档不回溯检查（doc-check D1） |
| 活动 plan 冻结归档 | ❌ 阻塞 | 活动 plan 含冻结标记（`已完成于`）即应已移入 `docs/archive/`（发版 checklist 原子动作，doc-check D1）；已冻结未归档阻塞合并/发版 |
| ADR 状态与 INDEX.md 一致 | ❌ 阻塞 | 两处状态字段必须相同（doc-check D2） |
| 脚本引用路径有效（D4） | ❌ 阻塞 | package scripts / 源码静态 import / spawn 字符串 / docs/rules、docs/templates 引用的 `.mjs` 必须存在 |

**plan 归档判定依据**：验收清单全部 `[x]`（实施完成）的 plan 应在待合并 feature 分支的发布元数据收束阶段，经 `release/archive-plan --apply` 移入 `docs/archive/`，与版本信息一并提交后再执行合并门禁。判定链：施工中（存在 `[ ]`）→ D1 error，阻塞合并与发版（doc-check 规定活动 plan 不得有未勾选条目；release/check P1 对应 warning 不阻塞退出码）；全勾选且含「已完成于」冻结标记 → D1 强制已归档；全勾选未冻结 → P1「已勾选全部条目但未冻结归档」，发版收束时必须归档消解。

## 合并与发版流程

一次发版收敛为：**发布元数据收束 → 合并发布 → 部署（可选）**。

1. **发布元数据收束（feature 分支）**：
   - plan 文档：全部 `[x]` 后经 `node scripts/tooling.mjs run release/prepare -- --plan <path> --apply` 冻结归档（追加 `> ✅ 已完成于 {日期}` → 移入 `docs/archive/` → 更新 archive INDEX）
   - 实施笔记：随归档合并到 plan 末尾（`## 实施纪要` 段），删除 notes 文件
   - inbox.md：删除所有 `[x]` 条目
   - ADR INDEX.md：相关 ADR 状态改为 `已实施`
   - 版本：dry-run 确定根目标版本后，执行 `node scripts/tooling.mjs run release/calculate-version -- --pkg all --apply` 与根版本 `--apply`（单包仓库跳过 --pkg）；核对 changed 子包的包级约定文档（如 PACKAGE.md）
   - 更新日志：执行 `node scripts/tooling.mjs run release/changelog -- --version <根版本> --apply` 追加 docs/CHANGELOG.md 版本段（与版本文件同笔提交）
   - 提交：以上内容作为一笔 `chore(release): 准备 v<根版本>` 提交，不在主分支补交发布元数据
2. **合并发布**：在 feature 最终提交上执行 `node scripts/verify.mjs merge -- --base <主分支>`（覆盖该分支相对主分支的完整变更）→ `--no-ff` 合入主分支 → 在 merge commit 上执行 `node scripts/verify.mjs release` → 给该 merge commit 创建 `v<版本>` tag → push 主分支与 tag → 删除 feature 分支。**verify release 通过前不删除远端分支**。
3. **部署（可选）**：按仓库自身部署流程执行，独立授权动作，与发版门禁分离。
