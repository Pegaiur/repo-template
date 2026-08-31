# scripts 体系导航

> 本文件是 scripts 体系的唯一导航入口：生命周期、lib 基元、临时路径边界、清理约定、tooling 用法。
> 写 scratch 或 task 前先查 lib 模块表，能力已存在则直接 import，不要重复实现。

## 目录职责

| 路径 | 职责 | 入版本控制 |
|------|------|:---:|
| `scripts/tooling.mjs` | 开发任务工具 CLI（list/run/new/promote/tmp） | ✅ |
| `scripts/verify.mjs` | 合并/发版门禁唯一入口（执行引擎，命令清单见 gates.mjs） | ✅ |
| `scripts/gates.mjs` | 门禁命令清单（适配层：换技术栈唯一必改文件） | ✅ |
| `scripts/doc-check.mjs` | 文档一致性校验（合并门禁组成部分） | ✅ |
| `scripts/lib/` | 共享基元（单一职责、只读边界显式、接受注入依赖便于测试） | ✅ |
| `scripts/tasks/` | 可复用开发任务（目录发现即注册，无 manifest） | ✅ |
| `scripts/scratch/` | 一次性脚本（`tooling new` 生成，不入库） | ❌ |

## 脚本生命周期：scratch → tasks → lib

- **scratch**：`node scripts/tooling.mjs new <domain/name>` 从模板生成，包含质量基线骨架（repo-context、createRunDir、parseArgs、标准退出码）。
- **tasks**：第二次复用时 `node scripts/tooling.mjs promote <scratch> <domain/name>` 升迁（仅移动文件；scratch 与 tasks 同层级同名文件的相对导入路径一致，promote 无需重写内容）。
- **lib**：基础逻辑出现**两个真实消费者**时下沉 lib——没有消费者的能力不进 lib（防过度抽象）。
- tasks 的注册事实就是目录本身，不维护第二份 manifest；构建清单（package.json 等）不承担任务注册表职责。

## lib 模块表

| 模块 | 核心导出 | 用途 | 现有消费者 |
|------|----------|------|-----------|
| repo-context | resolveRepoRoot / isPathInside / tasksRoot / scratchRoot | 仓库根定位（向上找标志文件，默认 .git）、路径内收 | 全部脚本 |
| process | runCapture / runStreaming / resolveCommandPrefix | 子进程执行（参数数组 + windowsHide，不拼 shell）、Windows .cmd 垫片前缀 | verify、git、tooling |
| git | head / diffFiles / logMessages / describeLatestTag / showFile 等 | 只读 git 封装（不执行 add/commit/reset） | verify、git/*、release/* |
| conventional-bump | calculateBump / classifyCommit | 约定式提交版本推算（pre-1.0 保护） | release/calculate-version |
| dev-workspace | createRunDir / getWorkDir / getCacheDir | dev-temp 落位（run-id：时间戳-PID-随机） | verify、tooling、git/* |
| output | formatJson / formatTsv / writeOutput | 结构化输出与文件落位 | verify、release/*、git/* |
| glob-match | globToRegex | 全路径 glob（** 递归跨段）→ 正则 | verify 路由 |
| task-ref | normalizeTaskRef | domain/name 引用规范化（防穿越） | tooling、ref-check |
| ref-check | collectRefIssues | 文档/脚本引用存在性检查（doc-check D4） | doc-check |
| skill-check | checkSkillStructure | skills/ 开放格式结构校验（S1-S5） | doc-check |
| verify-profile | PROFILE_VERSION | 门禁 profile 版本事实源（命令构成变化时递增） | verify |

## 临时路径边界（所有权分离 + 清理白名单）

| 路径 | 所有权 | 可否清理 |
|------|--------|:---:|
| `dev-temp/runs/` | 开发脚本完整中间结果（含 verify 诊断现场） | ✅ `tooling tmp clean` |
| `dev-temp/work/` | 人工长期查看产物 | ✅ `tooling tmp clean` |
| `dev-temp/cache/` | 可重建缓存 | ✅ `tooling tmp clean` |
| 应用运行时临时目录 | 应用自身 | ❌ 不归 tooling 管 |
| 测试 tmpdir（os.tmpdir） | 测试框架 | ❌ 不归 tooling 管 |

> 清理约定：安全语义不同，不合并清理命令。显式清理优于自动删除；失败现场可保留（runs/ 按 run-id 隔离）。

## 范例 task

- `tasks/git/head-diff.mjs` — 多 lib 基元组合范例（git + process + dev-workspace + output）
- `tasks/git/show-file.mjs` — 只读边界 + 核心逻辑可测（runShowFile 注入 root）范例
- `tasks/release/archive-plan.mjs` — 文档状态机机械实现 + dry-run/--apply 范例
- `tasks/release/changelog.mjs` — 同源双视图 renderer（人类分类分节 / Agent 限行单行）+ 追加写防重范例

## tooling 用法

```bash
node scripts/tooling.mjs list                     # 列出 tasks（目录发现）
node scripts/tooling.mjs list --lib               # 枚举 lib 基元（文件名 + 头部摘要）
node scripts/tooling.mjs run <task> -- <args>     # 独立 Node 子进程运行，args 原样透传
node scripts/tooling.mjs new <domain/name>        # 生成 scratch（拒绝覆盖）
node scripts/tooling.mjs promote <scratch> <ref>  # scratch → tasks（仅移动）
node scripts/tooling.mjs tmp path|list|clean      # 临时区管理（clean 默认 dry-run，--apply 才删）
```

退出码约定：0 成功 / 1 一般错误 / 2 参数错误。
