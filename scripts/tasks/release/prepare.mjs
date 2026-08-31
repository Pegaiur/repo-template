#!/usr/bin/env node
/**
 * release/prepare — 发版文档准备编排（archive → check → calculate）
 *
 * 用法：
 *   node scripts/tasks/release/prepare.mjs --plan <path> [--notes <path> ...] [--apply] [--summary <text>] [--version <v>] [--date <date>]
 *
 * 流程：
 *   1. release/archive-plan：校验 checklist、合并 notes、追加完成日期、移动 archive、更新 INDEX（默认 dry-run，--apply 真实执行）
 *   2. release/check：doc-check + 发版准备态检查
 *   3. release/calculate-version：最近 tag → HEAD 推算目标版本（只输出建议）
 *
 * 边界：本任务只做文档归档、检查与版本建议，不执行 typecheck/test/commit/tag/部署。
 */

import { parseArgs } from 'node:util'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot, tasksRoot } from '../../lib/repo-context.mjs'
import { runCapture } from '../../lib/process.mjs'

const DEFAULT_ROOT = resolveRepoRoot(import.meta.url)

function usage() {
  console.log(`release/prepare — 发版文档准备编排（archive → check → calculate）

用法：
  node scripts/tasks/release/prepare.mjs --plan <path> [--notes <path> ...] [--apply] [--summary <text>] [--version <v>] [--date <date>]

流程：
  1. release/archive-plan：归档 plan（校验 checklist 全部 [x]；自动合并同名 -notes.md 为「实施纪要」段后删除 notes；追加完成日期；移动 archive；更新 INDEX。默认 dry-run，--apply 真实执行）
  2. release/check：发版准备态检查
  3. release/calculate-version：推算目标版本（只输出建议）

选项（透传 archive-plan）：
  --plan <path>      plan 文档路径（必填）
  --notes <path>     显式指定 notes；可重复传入以按顺序合并多份实施笔记
  --summary <text>   archive INDEX 摘要
  --version <v>      archive INDEX 版本列
  --date <date>      完成日期（缺省今天）
  --apply            真实执行归档（默认 dry-run）

边界：不覆盖 typecheck/test/commit/tag/部署。退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

/** 运行子任务：参数数组 + 透传 root，code!==0 时终止 */
async function runStep(root, tasksDir, label, script, args) {
  console.log(`\n[${label}]`)
  const r = await runCapture(process.execPath, [join(tasksDir, script), ...args], { cwd: root })
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  if (r.code !== 0) {
    console.error(`\n[${label}] 失败，退出码 ${r.code}；release/prepare 终止`)
    process.exit(r.code)
  }
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        plan: { type: 'string' },
        notes: { type: 'string', multiple: true },
        summary: { type: 'string' },
        version: { type: 'string' },
        date: { type: 'string' },
        root: { type: 'string' },
        apply: { type: 'boolean', default: false },
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
  if (!values.plan) {
    console.error('用法错误：缺少 --plan <path>')
    process.exit(2)
  }

  const root = values.root ? resolve(values.root) : DEFAULT_ROOT
  const tasksDir = join(tasksRoot(root), 'release')

  console.log('release/prepare — 发版文档准备（archive → check → calculate）')
  console.log('=============================================================')

  // 1. archive-plan（透传归档参数；--apply 由调用方显式给出）
  const archiveArgs = ['--plan', values.plan]
  for (const notesPath of values.notes ?? []) archiveArgs.push('--notes', notesPath)
  if (values.apply) archiveArgs.push('--apply')
  if (values.summary) archiveArgs.push('--summary', values.summary)
  if (values.version) archiveArgs.push('--version', values.version)
  if (values.date) archiveArgs.push('--date', values.date)
  if (values.root) archiveArgs.push('--root', values.root)
  await runStep(root, tasksDir, '1/3 归档 plan', 'archive-plan.mjs', archiveArgs)

  // 2. check
  const checkArgs = []
  if (values.root) checkArgs.push('--root', values.root)
  await runStep(root, tasksDir, '2/3 发版准备态检查', 'check.mjs', checkArgs)

  // 3. calculate-version（只输出目标版本建议）
  const calcArgs = []
  if (values.root) calcArgs.push('--root', values.root)
  await runStep(root, tasksDir, '3/3 推算目标版本', 'calculate-version.mjs', calcArgs)

  console.log('\nrelease/prepare 完成。提示：版本计算仅输出建议，不修改版本文件；commit/tag/部署由后续发版流程负责。')
}

// isMain 守卫：直调时执行 CLI；被 import（node:test）时无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main().catch(e => {
    console.error(`错误：${e.message ?? String(e)}`)
    process.exit(1)
  })
}
