# 过程管理 repo 模板

从 Concliude 仓库提炼的**泛语言/包管理无关**过程管理模板：文档生命周期、分支合并脚本门槛、发版 auto bump、Agent 工作流技能与脚本基建。脚本引擎只用 Node 内置模块（零 npm 依赖），只依赖 git 与可执行命令；目标仓库可以是任何语言/技术栈。

## 目录结构

```
repo-template/
├── README.md                  ← 本文件（用后可删）
├── AGENTS.md                  ← Agent 引导骨架（【可选】标注段为语言/包管理策略占位）
├── .gitignore                 ← 最小忽略项，按仓库合并
├── docs/
│   ├── inbox.md               ← 需求收件箱（唯一入口 + 路由分流 + ADR 判据）
│   ├── templates/             ← adr.md / plan.md / notes.md 机械模板
│   ├── rules/document-lifecycle.md  ← 文档生命周期规则（含合并门槛与发版流程）
│   ├── adr/INDEX.md           ← ADR 状态权威索引
│   ├── CHANGELOG.md           ← 版本变更事实（首次发版 --apply 时创建，只累积不重写）
│   └── archive/INDEX.md       ← 归档索引（完成日期降序 + 版本列；与 CHANGELOG 分工：INDEX=计划索引，CHANGELOG=版本变更事实）
├── skills/                    ← 开放 Agent Skills 格式（不依赖宿主技能发现）
│   ├── commit-convention/     ← 原子提交（约定式前缀 + 审查能力探测 + 精准暂存）
│   ├── release-workflow/      ← 发版编排（机械委托映射 + 授权边界 + SHA 保护）
│   └── tech-debt-governance/  ← 技术债治理（三维扫描 + 双 agent 交叉审查 + ROI 分批）
└── scripts/
    ├── verify.mjs             ← 合并/发版门禁唯一入口（引擎，不含具体命令）
    ├── gates.mjs              ← ★ 门禁命令清单（适配层，换技术栈唯一必改）
    ├── doc-check.mjs          ← 文档一致性校验（D1-D4 + S）
    ├── tooling.mjs            ← 开发任务工具（list/run/new/promote/tmp）
    ├── INDEX.md               ← 脚本体系导航
    ├── lib/                   ← 11 个共享基元（git 只读封装、bump 纯函数、skill 校验等）
    └── tasks/
        ├── git/               ← head-diff / show-file（只读取证）
        └── release/           ← prepare / check / calculate-version / archive-plan
```

## 快速开始

1. 将本模板内容复制到目标仓库根（或按需摘取子目录）。
2. **改 `scripts/gates.mjs`**：把 BASE_STEPS / ROUTE_GROUPS 里的命令换成你仓库的 typecheck/test/lint 等命令；单仓可置 `FAILOVER_ROOTS = []`。
3. 按 `AGENTS.md` 中【可选】标注填入项目概述、技术栈、包管理器策略，删除不适用的可选段。
4. 语法自检：`node --check scripts/verify.mjs`（或直接跑一次 `node scripts/doc-check.mjs`）。
5. （可选）在 package.json / Makefile / justfile 中登记常用命令，例如：

```json
{
  "scripts": {
    "tooling": "node scripts/tooling.mjs",
    "verify:merge": "node scripts/verify.mjs merge",
    "verify:release": "node scripts/verify.mjs release",
    "release:prepare": "node scripts/tooling.mjs run release/prepare",
    "release:check": "node scripts/tooling.mjs run release/check",
    "release:calculate-version": "node scripts/tooling.mjs run release/calculate-version",
    "release:archive-plan": "node scripts/tooling.mjs run release/archive-plan"
  }
}
```

## 适配点清单（泛语言化时唯一要改的地方）

| # | 位置 | 内容 | 说明 |
|---|------|------|------|
| 1 | `scripts/gates.mjs` | 门禁命令清单 + 路由 glob | 引擎与命令分离的核心；npm/cargo/uv/go 等示例在文件注释中 |
| 2 | `scripts/lib/repo-context.mjs` | 仓库根标志文件 | 默认 `.git`；monorepo 可传 marker（如 pnpm-workspace.yaml） |
| 3 | `scripts/tasks/release/calculate-version.mjs` | 版本文件适配器 | 默认 package.json；Cargo.toml/pyproject.toml 替换 collectPackages + 写入器（文件头注释标明） |
| 4 | `scripts/lib/process.mjs` | Windows .cmd 垫片名单 | pnpm/npm/yarn/npx 之外的语言工具链一般无需改动 |
| 5 | `AGENTS.md` | 【可选】标注段 | 项目概述、技术栈、数据库/平台专属规则 |
| 6 | `doc-check.mjs` | 扩展点注释 | monorepo PACKAGE.md 校验、spec↔rule 双向引用等可按需加回 |

## 命令速查

```bash
node scripts/verify.mjs merge -- --base master      # 合并门禁（变更路由 + fail-closed）
node scripts/verify.mjs release                     # 发版门禁（全量，tag 前在 merge commit 上执行）
node scripts/tooling.mjs run release/prepare -- --plan docs/plan-xxx.md --apply   # 冻结归档 plan
node scripts/tooling.mjs run release/check          # 发版准备态检查（D + P1-P4）
node scripts/tooling.mjs run release/calculate-version -- --pkg all --apply       # 版本推算并写入
node scripts/tooling.mjs run release/archive-plan -- --plan docs/plan-xxx.md --apply
node scripts/tooling.mjs run release/changelog -- --version <v> --apply   # 追加更新日志版本段（--agent 紧凑视图仅预览）
node scripts/doc-check.mjs                          # 文档一致性（合并门禁组成部分）
node scripts/tooling.mjs new <domain/name>          # 一次性脚本 → 二次复用 promote 成 task
```

## 核心机制速览

- **文档生命周期**：`draft-*`（未定稿）→ 重命名 → `plan-*`（checkbox 唯一进度信号）→ 冻结标记（`已完成于`）→ `archive/`；notes 五段式（决策偏离/实现调整/债务+偿还条件/意外发现/阻塞+预防）流式追加，归档时由脚本合并为「实施纪要」段——禁止手动拼接。
- **合并门槛（profile 模式）**：BASE_STEPS 固定顺序失败即停 + 变更路径路由追加 ROUTE_GROUPS + 未知跨模块路径 fail-closed 升级宽 profile；结构化结果（result.json）含 profile 版本与 HEAD SHA，可作为部署复用证据。
- **发版 auto bump**：`git describe` 最近 tag → `tag..HEAD` 约定式提交推算（breaking→major、feat→minor、fix→patch、pre-1.0 保护、空区间/仅 docs 不变）；子包按目录路径过滤提交、基线为当前 version 字段；dry-run/--apply 双模式，写入只改版本字段并复用原缩进。
- **Changelog（同源双视图）**：release/changelog 与版本推算同区间（tag..HEAD）聚合提交事实——人类版分类分节带短哈希、`--agent` 限行紧凑视图供发版后新任务首读；`--apply` 追加 docs/CHANGELOG.md（只累积、同笔 chore(release) 提交、同版本段拒绝重复）；非门禁，不规范提交归「其他」+ warning。
- **两阶段发版**：feature 分支收束发布元数据（归档 + inbox 清理 + ADR 状态 + 版本写入，一笔 `chore(release)`）→ `verify merge --base` → `--no-ff` 合入 → merge commit 上 `verify release` → tag（不可移动）→ 删分支（verify release 通过前不删远端分支）。
- **开放技能格式**：`skills/<name>/SKILL.md` + frontmatter（name/description 含触发词与负向边界）+ S1-S5 机械校验（含禁宿主专属措辞）；机械事实委托脚本，技能只保留时机、判断与确认。

## 未收录的进阶模式（可从原仓 Concliude 参考）

| 模式 | 原仓位置 | 说明 |
|------|----------|------|
| 视觉基线记录校验 | `scripts/verify.mjs` visual-record 子命令 | 截图基线变更必须伴随 spec/notes 说明记录（fail-closed） |
| PACKAGE.md 路径校验与 spec↔rule 双向引用（原仓编号 D3/D6，勿与模板自身 D 编号混淆） | `scripts/doc-check.mjs` | monorepo 包级约定与跨包契约门禁 |
| 部署复用门禁证据 | `scripts/prod.mjs` | 校验 SHA/profile/profileVersion 三元组一致后才允许部署 |
| Agent 收尾守卫 | `scripts/check-agent-guard.ps1` | G1 孤儿脚本（提示）/ G2 临时残留（阻塞+白名单）/ G3 git 编码配置（Windows/pwsh） |
| 测试卫生门禁 | `scripts/test-hygiene.mjs` | 测试共享状态隔离扫描 + 正反例夹具自测（绑定 Vitest） |
| 数据库操作规则 | `docs/rules/database-operations.md` | 单例连接、迁移仅前滚、事务包裹（SQLite 特定） |

## 设计来源

- 门禁 profile / 单一事实源：Concliude ADR-100（merge-release-gate-single-entry）
- 脚本生命周期 / 最小工具哲学：Concliude ADR-099（development-tooling-and-workspace）
- 逐包独立 semver：Concliude ADR-010（independent-semver）
- 文档生命周期 / plan 纯度 / notes 五段：Concliude `docs/rules/document-lifecycle.md`
