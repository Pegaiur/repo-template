---
name: release-workflow
description: 发版与版本管理——在 feature 分支收束发布元数据，经合并/发版门禁后合入主分支、创建 tag 并清理分支。触发词：发版、bump version、tag、release 分支、发布准备。不处理普通提交（见 commit-convention）。
---

# release-workflow

编排仓库既有 release 脚本与 verify 门禁完成发版。机械事实（版本算法、命令清单、归档逻辑）委托仓库脚本，本技能只保留时机、判断、确认与失败处理，不复制底层命令。

## 机械委托映射（命令唯一事实源）

| 职责 | 命令 | 说明 |
|------|------|------|
| 合并门禁 | `node scripts/verify.mjs merge -- --base <主分支>` | merge profile 唯一入口，按 feature 相对主分支的完整变更路由附加门禁 |
| 发版准备态检查 | `node scripts/tooling.mjs run release/check` | 复用 doc-check（D1-D4）+ 活动 plan/notes/inbox/archive INDEX 准备态（P1-P4） |
| plan 归档 | `node scripts/tooling.mjs run release/prepare -- --plan <path>` | archive → check → calculate 编排；默认 dry-run，`--apply` 真实归档 |
| 子包版本推算 | `node scripts/tooling.mjs run release/calculate-version -- --pkg <dir\|all>` | 逐包独立推算；`--apply` 写入子包版本文件 |
| 更新日志 | `node scripts/tooling.mjs run release/changelog -- --version <根版本> --apply` | 发版区间（最近 tag..HEAD）变更摘要追加 docs/CHANGELOG.md；`--agent` 紧凑视图供发版后新任务首读 |
| 根版本推算 | `node scripts/tooling.mjs run release/calculate-version` | 根版本；在 feature 分支执行，`--apply` 写入版本文件 |
| 发版门禁 | `node scripts/verify.mjs release` | release profile 全量门禁，tag 前执行 |
| 部署（可选） | 按仓库部署流程 | 独立授权动作；可复用门禁结果但须校验 SHA/profile/profileVersion 一致，不复制门禁命令 |

## 发版流程

一次发版只包含两个阶段：**发布元数据收束 → 合并发布**；部署保持可选且独立授权。

### 1. 发布元数据收束（feature 分支）

1. 确认当前位于待合并的 `feature/*` 分支，plan checklist 全部 [x]；没有 checklist 或没有实施证据时降级 draft/挂起，不机械补勾。
2. 先以根版本推算 dry-run 确定根目标版本，再执行 `node scripts/tooling.mjs run release/prepare -- --plan <待归档plan> --version <根版本> --apply` 冻结归档（合并 notes 为实施纪要、更新 archive INDEX）。
3. 清理 inbox [x] 条目、同步相关 ADR 与 INDEX 状态；核对 changed 子包的包级约定文档（如 PACKAGE.md）职责/接口。
4. 执行子包版本 `--pkg all --apply` 与根版本 `--apply`，将子包和根版本一并写入；子包版本每次发版只 apply 一次（单包仓库无 packages/ 目录时跳过 --pkg，仅执行根版本写入）。
5. 执行 `node scripts/tooling.mjs run release/changelog -- --version <根版本> --apply` 追加 docs/CHANGELOG.md 版本段（与版本文件同笔 chore(release) 提交；发版后新任务可用 `--agent --max <n>` 紧凑视图快速掌握变更面）。
6. 执行 `node scripts/tooling.mjs run release/check` 确认 P1-P4 已收束，将以上发布元数据作为一笔 `chore(release): 准备 v<根版本>` 提交。提交动作复用 commit-convention 的检查、审查与精准暂存要求，提交范围由本技能确定。

### 2. 合并发布

1. 在 feature 分支最终提交上执行 `node scripts/verify.mjs merge -- --base <主分支>`，覆盖该分支相对主分支的完整变更；通过后以 `--no-ff` 合入主分支。
2. 在主分支的 merge commit 上执行 `node scripts/verify.mjs release`；失败或 HEAD 意外变化立即终止 tag/push，保留 feature 分支用于修复。
3. 给通过门禁的 merge commit 创建 `git tag -a v<根版本> -m "v<根版本>: <变更摘要>"`，push 主分支与 tag 后删除 feature 分支。
4. 部署可选：按仓库部署流程与用户授权边界确认后执行。

## 授权边界

tag、push、删除远端分支、部署是独立高影响步骤，按用户授权边界逐项确认；不把本地「准备发版」自动扩张为推送或删远端分支。tag 不可移动，发布失败通过新版本修复，不覆盖旧 tag。
- `chore(release)` 只在 feature 分支收束发布元数据；主分支不再接受发版直提提交。
- **verify release 通过前不删除远端分支**：发版失败时保留分支作为修复与回退参照。

## 门禁与 SHA 保护

- `verify merge` / `verify release` 执行前记录 HEAD，返回后对比——仅拦截预期外变化（并发提交、rebase、pull、他人推送）。根/子包版本已在门禁前写入，tag 必须指向通过 `verify release` 的 merge commit。
- 任一门禁失败（退出码非 0）立即中止后续提交/tag 动作，不携带失败现场继续。
- 门禁结果以 `dev-temp/runs/verify/<run-id>/result.json` 与退出码为准。

## 版本管理（根 + 子包）

- **根版本**：最近 `vx.y.z` tag → feature HEAD，subject+body 约定式推算（pre-1.0 保护：0.x 阶段 breaking 只 bump minor；空区间/仅 docs 不变），基线为最近 tag；合并前写入，tag 指向内容一致且通过 release 门禁的 merge commit。
- **子包版本**：`--pkg <dir|all>` 逐包独立推算——基线 = 子包当前 `version` 字段（子包无独立 tag），区间内按包目录路径过滤提交日志，bump 规则同根。
- **写入**：`--apply` 程序化写入，复用源文件缩进、只改 version 字段；缺省 dry-run。版本文件适配器（Cargo.toml/pyproject.toml 等）见 calculate-version 文件头注释。
- **红线**：子包全部 private、不发布、依赖一律本地协议（如 workspace:*）时，版本仅供信息、不发布；任一子包改为对外发布或依赖解析到 registry 版本时，升级 changesets 类多包发版工具。
