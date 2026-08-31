#!/usr/bin/env node
/**
 * git/head-diff — Git 变更对比（只读）
 *
 * 用法：
 *   node scripts/tasks/git/head-diff.mjs [--base <commit>|--merge-base <commit>] [--patch] [--json]
 *
 * 三种比较模式：
 *   - 默认：工作区相对 HEAD
 *   - --base <commit>：<commit>→HEAD 提交区间
 *   - --merge-base <commit>：merge-base(<commit>, HEAD)→HEAD 提交区间
 *
 * 输出：summary + 文件列表（默认）；--patch 追加完整 diff；--json 输出结构化 JSON。
 * 大 patch（超过 1 MiB）写入 dev-temp/runs/git/head-diff/<run-id>/，避免撑爆终端。
 *
 * 只读边界：仅调用 git 只读命令（diff/log/merge-base/rev-parse），不执行 add/commit/reset；
 * 文件枚举经 lib/git.mjs，patch/shortstat 经 lib/process.mjs runCapture 以参数数组执行。
 */

import { parseArgs } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'
import { head, mergeBase, diffFiles, buildDiffArgs, parseShortstat } from '../../lib/git.mjs'
import { runCapture } from '../../lib/process.mjs'
import { createRunDir } from '../../lib/dev-workspace.mjs'
import { formatJson, writeOutput } from '../../lib/output.mjs'

/** 大 patch 阈值：超过该字节数时不打印到 stdout，写入 dev-temp/runs */
const PATCH_STDOUT_LIMIT = 1024 * 1024

function usage() {
  console.log(`git/head-diff — Git 变更对比（只读）

用法：
  node scripts/tasks/git/head-diff.mjs [--base <commit>|--merge-base <commit>] [--patch] [--json]

选项：
  --base <commit>        比较 <commit>→HEAD 提交区间（默认比较工作区相对 HEAD）
  --merge-base <commit>  比较 merge-base(<commit>, HEAD)→HEAD 提交区间
  --patch                输出完整 diff（超过 1 MiB 时写入 dev-temp/runs）
  --json                 输出结构化 JSON
  --help                 显示本帮助

退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

async function main() {
  const REPO_ROOT = resolveRepoRoot(import.meta.url)

  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        base: { type: 'string' },
        'merge-base': { type: 'string' },
        patch: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch (e) {
    console.error(`用法错误：${e.message}`)
    process.exit(2)
  }

  if (values.help) {
    usage()
    process.exit(0)
  }
  if (values.base && values['merge-base']) {
    console.error('用法错误：--base 与 --merge-base 互斥，只能指定其一')
    process.exit(2)
  }

  const headHash = await head(REPO_ROOT)

  // 解析比较区间：[from, to]，两者齐备 = from..HEAD；均省略 = 工作区 vs HEAD
  let mode = 'worktree'
  let from
  let to
  if (values['merge-base']) {
    from = await mergeBase(REPO_ROOT, values['merge-base'], headHash)
    to = headHash
    mode = 'merge-base'
  } else if (values.base) {
    from = values.base
    to = headHash
    mode = 'base'
  }

  const files = await diffFiles(REPO_ROOT, from && to ? { from, to } : {})

  const statR = await runCapture('git', buildDiffArgs(from, to, ['--shortstat']), { cwd: REPO_ROOT })
  if (statR.code !== 0) {
    throw new Error(`git diff --shortstat 失败：${statR.stderr.trim() || `退出码 ${statR.code}`}`)
  }
  const summary = parseShortstat(statR.stdout, { fallbackFiles: files.length })

  // 可选 patch：超过阈值时落盘 dev-temp/runs，不打印内容
  let patchOutput = null
  if (values.patch) {
    const patchR = await runCapture('git', buildDiffArgs(from, to, ['--patch']), { cwd: REPO_ROOT })
    if (patchR.code !== 0) {
      throw new Error(`git diff --patch 失败：${patchR.stderr.trim() || `退出码 ${patchR.code}`}`)
    }
    if (patchR.stdout.length > PATCH_STDOUT_LIMIT) {
      const runDir = createRunDir(REPO_ROOT, 'git/head-diff')
      const path = writeOutput(join(runDir, 'diff.patch'), patchR.stdout)
      patchOutput = { path, bytes: patchR.stdout.length }
    } else {
      patchOutput = patchR.stdout
    }
  }

  const modeLabel = mode === 'worktree' ? '工作区相对 HEAD' : mode === 'base' ? `${from}→HEAD` : `merge-base(${values['merge-base']})→HEAD`

  if (values.json) {
    console.log(
      formatJson({
        mode,
        head: headHash,
        base: from ?? null,
        summary,
        files,
        patch: patchOutput,
      }),
    )
  } else {
    console.log(`模式：${modeLabel}`)
    console.log(`HEAD：${headHash}`)
    if (from) console.log(`比较区间：${from}..${headHash}`)
    console.log(`变更 ${summary.filesChanged} 个文件，+${summary.insertions} -${summary.deletions}`)
    for (const f of files) console.log(`  ${f}`)
    if (values.patch) {
      if (typeof patchOutput === 'string') console.log(`\n${patchOutput}`)
      else console.log(`\npatch 已写入（${patchOutput.bytes} 字节）：${patchOutput.path}`)
    }
  }
}

// isMain 守卫：直调时执行 CLI；被 import（node:test）时仅暴露纯函数，无顶层副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main().catch(e => {
    console.error(`错误：${e.message ?? String(e)}`)
    process.exit(1)
  })
}
