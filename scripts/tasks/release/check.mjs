#!/usr/bin/env node
/**
 * release/check — 发版准备态检查
 *
 * 用法：
 *   node scripts/tasks/release/check.mjs [--json] [--root <dir>]
 *
 * 检查项（不改变 doc-check D1-D4 语义，仅调用并叠加发版准备态）：
 *   D 检查：调用 node scripts/doc-check.mjs --json（D1-D4 原样展示）
 *   P1 活动 plan：docs/plan-*.md 施工中条目数与冻结待归档状态
 *   P2 notes：docs/*-notes.md 待合并清单（发版前应经 archive-plan 合并归档）
 *   P3 inbox：已勾选 [x] 条目数（发版时应清理）
 *   P4 archive INDEX：每行引用的归档文件存在性（缺失为 error）
 *
 * 退出码：0 无 error（warning 不阻塞）/ 1 存在 error
 */

import { parseArgs } from 'node:util'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'
import { runCapture } from '../../lib/process.mjs'
import { formatJson } from '../../lib/output.mjs'

const DEFAULT_ROOT = resolveRepoRoot(import.meta.url)

function usage() {
  console.log(`release/check — 发版准备态检查

用法：
  node scripts/tasks/release/check.mjs [--json] [--root <dir>]

检查项：
  D  调用 node scripts/doc-check.mjs --json（D1-D4 原样展示，作用于真实仓库）
  P1 活动 plan：施工中条目与冻结待归档状态
  P2 docs/*-notes.md 待合并清单
  P3 inbox 已勾选条目
  P4 archive INDEX 引用文件存在性

选项：
  --root <dir>  P 检查的仓库根覆盖（测试注入，指向完整仓库副本）；D 检查始终作用于真实仓库
  --json        输出结构化 JSON

退出码：0 无 error（warning 不阻塞）/ 1 存在 error`)
}

/**
 * 发版准备态检查（纯逻辑，接受注入 root）。
 * @param {string} root 仓库根
 * @returns {{ errors: {check:string,message:string}[], warnings: {check:string,message:string}[] }}
 */
export function collectReleaseChecks(root) {
  const errors = []
  const warnings = []
  const docsDir = join(root, 'docs')

  // P1 活动 plan（排除 *-notes.md）
  const planFiles = existsSync(docsDir)
    ? readdirSync(docsDir).filter(f => f.startsWith('plan-') && f.endsWith('.md') && !f.endsWith('-notes.md'))
    : []
  for (const f of planFiles) {
    const content = readFileSync(join(docsDir, f), 'utf-8')
    const open = content.match(/^\s*-\s*\[ \]/gm) ?? []
    const done = content.match(/^\s*-\s*\[x\]/gm) ?? []
    if (open.length > 0) {
      warnings.push({ check: 'P1', message: `活动 plan ${f} 施工中（${open.length} 项未勾选），发版前需完成或归档` })
    } else if (done.length === 0) {
      // 无 checkbox（无 [x] 也无 [ ]）：疑似草案，与「存在 checklist 且全部完成」严格区分
      warnings.push({ check: 'P1', message: `活动 plan ${f} 无验收清单段（疑似草案），发版前需定稿或降级为 draft` })
    } else if (content.includes('已完成于')) {
      warnings.push({ check: 'P1', message: `活动 plan ${f} 已冻结待归档（执行 release/archive-plan）` })
    } else {
      warnings.push({ check: 'P1', message: `活动 plan ${f} 已勾选全部条目但未冻结归档` })
    }
  }

  // P2 notes 待合并
  const notesFiles = existsSync(docsDir)
    ? readdirSync(docsDir).filter(f => f.endsWith('-notes.md'))
    : []
  for (const f of notesFiles) {
    warnings.push({ check: 'P2', message: `实施笔记 ${f} 待合并归档（执行 release/archive-plan）` })
  }

  // P3 inbox 已勾选条目
  const inboxPath = join(docsDir, 'inbox.md')
  if (existsSync(inboxPath)) {
    const inbox = readFileSync(inboxPath, 'utf-8')
    const done = inbox.match(/^\s*-\s*\[x\]/gm) ?? []
    if (done.length > 0) {
      warnings.push({ check: 'P3', message: `inbox.md 存在 ${done.length} 个已完成 [x] 条目，发版时应清理` })
    }
  }

  // P4 archive INDEX 引用存在性
  const indexPath = join(docsDir, 'archive', 'INDEX.md')
  if (existsSync(indexPath)) {
    const index = readFileSync(indexPath, 'utf-8')
    const refs = [...index.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    const seen = new Set()
    for (const m of refs) {
      if (seen.has(m[2])) continue
      seen.add(m[2])
      if (!existsSync(join(docsDir, 'archive', m[2]))) {
        errors.push({ check: 'P4', message: `archive INDEX.md 引用文件不存在：${m[2]}` })
      }
    }
  }

  return { errors, warnings }
}

async function runMain() {
  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        json: { type: 'boolean', default: false },
        root: { type: 'string' },
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

  const root = values.root ? resolve(values.root) : DEFAULT_ROOT

  // 调用 doc-check 获取 D 检查结果（独立子进程，原样复用不改变语义；始终作用于真实仓库）
  // doc-check --json 输出为纯 JSON（stdout 无 banner；verbose 细节走 stderr）
  const docR = await runCapture(process.execPath, [join(DEFAULT_ROOT, 'scripts', 'doc-check.mjs'), '--json'], {
    cwd: DEFAULT_ROOT,
  })
  let doc
  if (docR.code !== 0) {
    console.error(`错误：doc-check 启动失败（退出码 ${docR.code}）：${docR.stderr.trim() || '无错误输出'}`)
    process.exit(1)
  }
  try {
    doc = JSON.parse(docR.stdout)
  } catch {
    console.error('错误：doc-check 输出非 JSON，无法解析')
    process.exit(1)
  }

  const p = collectReleaseChecks(root)

  if (values.json) {
    console.log(
      formatJson({
        doc: { errors: doc.errors, warnings: doc.warnings, summary: doc.summary },
        release: { errors: p.errors, warnings: p.warnings },
        summary: { errors: doc.summary.errors + p.errors.length, warnings: doc.summary.warnings + p.warnings.length },
      }),
    )
  } else {
    console.log('发版准备态检查')
    console.log('================\n')
    console.log('[D 检查] 文档一致性（doc-check.mjs --json）')
    if (doc.summary.errors === 0 && doc.summary.warnings === 0) {
      console.log('  ✅ 全部通过')
    } else {
      if (doc.summary.warnings > 0) console.log(`  ⚡ ${doc.summary.warnings} 个警告`)
      if (doc.summary.errors > 0) console.log(`  ❌ ${doc.summary.errors} 个错误`)
      for (const i of [...doc.errors, ...doc.warnings]) {
        const icon = i.severity === 'error' ? '❌' : '⚠️ '
        console.log(`  ${icon}[${i.check}] ${i.message}`)
      }
    }
    console.log('\n[P 检查] 发版准备态')
    if (p.errors.length === 0 && p.warnings.length === 0) {
      console.log('  ✅ 全部通过')
    } else {
      if (p.warnings.length > 0) console.log(`  ⚡ ${p.warnings.length} 个警告`)
      if (p.errors.length > 0) console.log(`  ❌ ${p.errors.length} 个错误`)
      for (const i of [...p.errors, ...p.warnings]) {
        const icon = i.check === 'P4' ? '❌' : '⚠️ '
        console.log(`  ${icon}[${i.check}] ${i.message}`)
      }
    }
  }

  process.exit(doc.summary.errors > 0 || p.errors.length > 0 ? 1 : 0)
}

// isMain 守卫：直调时执行 CLI；被 import（测试）时仅暴露 collectReleaseChecks，无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) runMain()
