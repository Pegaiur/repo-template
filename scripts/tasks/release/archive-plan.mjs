#!/usr/bin/env node
/**
 * release/archive-plan — plan 文档归档（发版 checklist 的机械部分）
 *
 * 用法：
 *   node scripts/tasks/release/archive-plan.mjs --plan <path> [--notes <path> ...] [--summary <text>] [--version <v>] [--date <date>] [--root <dir>] [--apply]
 *
 * 流程（document-lifecycle 发版 checklist 的 1/2/7 + archive INDEX 更新）：
 *   1. 校验 plan checklist：唯一可归档条件是「至少一个 checkbox 且全部 [x]」（无 checkbox 或存在 [ ] 均拒绝，无文件副作用；已冻结禁止重复归档）
 *   2. 状态行 施工中 → 已完成，追加 "> ✅ 已完成于 {date}" 冻结标记
 *   3. 合并自动推导或显式指定的 notes 为 "## 实施纪要" 段，归档后删除 notes
 *   4. 移动 plan 到 docs/archive/
 *   5. 更新 docs/archive/INDEX.md（按完成日期降序插入新行）
 *
 * 副作用默认 dry-run（--apply 才真实写入）；核心逻辑接受注入 root，临时 fixture 可覆盖真实仓库。
 * 不执行 commit/tag/部署——归档后的人工动作由调用方负责。
 */

import { parseArgs } from 'node:util'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join, basename, dirname, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'

const DEFAULT_ROOT = resolveRepoRoot(import.meta.url)

function usage() {
  console.log(`release/archive-plan — plan 文档归档（发版 checklist 机械部分）

用法：
  node scripts/tasks/release/archive-plan.mjs --plan <path> [--notes <path> ...] [--summary <text>] [--version <v>] [--date <date>] [--apply]

选项：
  --plan <path>      plan 文档路径（docs/plan-xxx.md 或绝对路径，必填）
  --notes <path>     显式指定 notes；可重复传入以按顺序合并多份实施笔记
  --summary <text>   archive INDEX 摘要（缺省从 plan「## 目标」段首条 bullet 提取）
  --version <v>      archive INDEX 版本列（缺省 "—"）
  --date <date>      完成日期（缺省今天，YYYY-MM-DD）
  --root <dir>       仓库根覆盖（测试注入；缺省从模块位置推导）
  --apply            真实执行归档（默认 dry-run）
  --help             显示本帮助

流程：校验 checklist 至少一个 checkbox 且全部勾选 → 状态行改已完成 + 冻结标记 → 合并 *-notes.md → 移动 archive → 更新 INDEX。
边界：不执行 commit/tag/部署。退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

/** 今天（YYYY-MM-DD，本地时区） */
function today() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 解析 plan 路径：绝对路径直接用，相对路径相对 root */
function resolvePlanPath(root, ref) {
  return resolve(root, ref)
}

/** 显式 notes 仅允许仓库 docs/ 直属的普通 *-notes.md 文件，避免归档参数扩大删除边界。 */
function resolveExplicitNotesPath(root, ref) {
  const requestedPath = resolvePlanPath(root, ref)
  if (!existsSync(requestedPath)) throw new Error(`显式指定的 notes 不存在：${ref}`)
  if (!lstatSync(requestedPath).isFile()) throw new Error(`显式指定的 notes 不是普通文件：${ref}`)

  const docsRoot = realpathSync(join(root, 'docs'))
  const notesPath = realpathSync(requestedPath)
  const relativePath = relative(docsRoot, notesPath)
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    relativePath === '..' ||
    dirname(relativePath) !== '.' ||
    !basename(relativePath).endsWith('-notes.md')
  ) {
    throw new Error(`显式 notes 必须是 docs/ 直属的 *-notes.md 普通文件：${ref}`)
  }
  return notesPath
}

/** 提取已完成 checklist 行 */
function doneChecklist(content) {
  return content.match(/^\s*-\s*\[x\]/gm) ?? []
}

/** 提取未勾选 checklist 行 */
function openChecklist(content) {
  return content.match(/^\s*-\s*\[ \]/gm) ?? []
}

/** 从 plan「## 目标」段提取首条 bullet 作缺省摘要 */
function extractSummary(content, basename) {
  const goal = /##\s*目标\s*\n([\s\S]*?)(?=\n##\s|\n---|$)/.exec(content)
  if (goal) {
    const bullet = goal[1].match(/^\s*-\s+(.+)$/m)
    if (bullet) return bullet[1].trim()
  }
  return basename.replace(/\.md$/, '')
}

/**
 * 构建归档内容：状态行改已完成 → 追加 notes 实施纪要 → 文末冻结标记。
 * @param {string} planContent plan 原文
 * @param {string|null} notesContent notes 原文（无则 null）
 * @param {{ date: string }} opts
 * @returns {string}
 */
export function buildArchivedContent(planContent, notesContent, { date }) {
  const statusUpdated = planContent.replace(/^(>\s*状态：).*$/m, `$1已完成`)
  const body = notesContent
    ? `${statusUpdated.replace(/\s*$/, '')}\n\n## 实施纪要\n\n${notesContent.trim()}\n`
    : statusUpdated
  return `${body.replace(/\s*$/, '')}\n\n> ✅ 已完成于 ${date}\n`
}

/**
 * 在 archive INDEX.md 中按完成日期降序插入新行（返回更新后的完整内容）。
 * @param {string} indexContent INDEX.md 原文
 * @param {string} row 新表格行（含行首 |）
 * @returns {string}
 */
export function insertIndexRow(indexContent, row) {
  const lines = indexContent.split('\n')
  const sepIdx = lines.findIndex(l => /^\s*\|[\s|\-:]+\|\s*$/.test(l))
  if (sepIdx < 0) throw new Error('archive INDEX.md 缺少表格分隔行')
  const date = /^\|\s*(\d{4}-\d{2}-\d{2})/.exec(row)?.[1]
  if (!date) throw new Error(`INDEX 新行缺少完成日期：${row}`)
  let insertAt = lines.length // 默认末尾（日期最小）
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/.exec(lines[i])
    if (m && m[1] < date) {
      insertAt = i
      break
    }
  }
  lines.splice(insertAt, 0, row)
  return lines.join('\n')
}

/**
 * plan 归档主流程（纯逻辑，接受注入 root；dry-run 或 apply 返回执行计划/结果）。
 * @param {string} root 仓库根
 * @param {string} planRef plan 文档引用（docs/plan-xxx.md 或绝对路径）
 * @param {{ summary?: string, version?: string, date?: string, notes?: string|string[], apply?: boolean }} opts
 * @returns {object} 执行计划（dry-run）或执行结果（apply）
 */
export function archivePlan(root, planRef, { summary, version = '—', date = today(), notes, apply = false } = {}) {
  const planPath = resolvePlanPath(root, planRef)
  if (!existsSync(planPath)) throw new Error(`plan 不存在：${planRef}`)
  const planBasename = basename(planPath)
  if (!planBasename.startsWith('plan-')) throw new Error(`不是 plan 文档：${planRef}`)

  const planContent = readFileSync(planPath, 'utf-8')

  // 1. 校验 checklist 与冻结状态：唯一可归档条件是「至少一个 checkbox 且全部 [x]」；
  //    存在 [ ] 或无 checkbox（疑似草案）均拒绝，校验发生在任何写操作之前，无文件副作用
  const open = openChecklist(planContent)
  const done = doneChecklist(planContent)
  if (open.length > 0) throw new Error(`plan 存在 ${open.length} 个未勾选条目，禁止归档（${planRef}）`)
  if (done.length === 0) throw new Error(`plan 无验收清单段（疑似草案），禁止归档：${planRef}`)
  if (planContent.includes('已完成于')) throw new Error(`plan 已冻结，勿重复归档：${planRef}`)

  // 2. notes（显式指定或自动推导 docs/plan-<name>-notes.md）
  const notesPaths = notes
    ? (Array.isArray(notes) ? notes : [notes]).map(ref => resolveExplicitNotesPath(root, ref))
    : [join(root, 'docs', `${planBasename.replace(/\.md$/, '')}-notes.md`)]
  const seenNotesPaths = new Set()
  const uniqueNotesPaths = notesPaths.filter(notesPath => {
    const key = process.platform === 'win32' ? notesPath.toLowerCase() : notesPath
    if (seenNotesPaths.has(key)) return false
    seenNotesPaths.add(key)
    return true
  })
  const existingNotesPaths = uniqueNotesPaths.filter(notesPath => existsSync(notesPath))
  const notesContent = existingNotesPaths.length > 0
    ? existingNotesPaths.map(notesPath => readFileSync(notesPath, 'utf-8').trim()).join('\n\n')
    : null

  // 3. archive 目标（拒绝覆盖）
  const archivePath = join(root, 'docs', 'archive', planBasename)
  if (existsSync(archivePath)) throw new Error(`archive 已存在同名文件，拒绝覆盖：docs/archive/${planBasename}`)

  // 4. archive INDEX
  const indexPath = join(root, 'docs', 'archive', 'INDEX.md')
  if (!existsSync(indexPath)) throw new Error(`archive INDEX.md 不存在：${indexPath}`)

  const finalSummary = summary ?? extractSummary(planContent, planBasename)
  const archivedContent = buildArchivedContent(planContent, notesContent, { date })
  const indexRow = `| ${date} | ${version} | [${planBasename}](${planBasename}) | ${finalSummary} |`
  const indexContent = insertIndexRow(readFileSync(indexPath, 'utf-8'), indexRow)

  const planResult = {
    apply,
    plan: planRef,
    archive: `docs/archive/${planBasename}`,
    notes: existingNotesPaths,
    notesMerged: Boolean(notesContent),
    date,
    version,
    summary: finalSummary,
  }

  if (!apply) return planResult

  // apply：写 archive → 删源 plan/notes → 更新 INDEX
  writeFileSync(archivePath, archivedContent, 'utf-8')
  rmSync(planPath, { force: true })
  for (const notesPath of existingNotesPaths) {
    if (notes) resolveExplicitNotesPath(root, notesPath)
    rmSync(notesPath, { force: true })
  }
  writeFileSync(indexPath, indexContent, 'utf-8')
  return planResult
}

function main() {
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
  try {
    const r = archivePlan(root, values.plan, {
      summary: values.summary,
      version: values.version,
      date: values.date,
      notes: values.notes,
      apply: values.apply,
    })
    if (!r.apply) {
      console.log('[dry-run] 归档计划（真实执行需 --apply）：')
    } else {
      console.log('已归档：')
    }
    console.log(`  源 plan：${r.plan}`)
    console.log(`  归档位置：${r.archive}`)
    for (const notesPath of r.notes) console.log(`  合并 notes：${notesPath}`)
    console.log(`  完成日期：${r.date}${r.version !== '—' ? `（版本 ${r.version}）` : ''}`)
    console.log(`  INDEX 摘要：${r.summary}`)
  } catch (e) {
    console.error(`错误：${e.message}`)
    process.exit(1)
  }
}

// isMain 守卫：直调时执行 CLI；被 import（node:test）时仅暴露纯函数，无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) main()
