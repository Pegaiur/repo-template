/**
 * 文档一致性校验脚本
 *
 * 用法：
 *   node scripts/doc-check.mjs             # 全量检查
 *   node scripts/doc-check.mjs --verbose   # 详细输出
 *   node scripts/doc-check.mjs --json      # JSON 输出（CI / release:check 用）
 *
 * 检查项（文档生命周期规则 docs/rules/document-lifecycle.md 的机械门禁）：
 *   D1: 活动 plan（docs/ 下）checklist 全部 [x]；archive 内不回溯检查
 *   D2: ADR 状态与 INDEX.md 一致
 *   D3: 文档交叉引用有效（docs/ 下引用的 ADR-NNN 存在）
 *   D4: 脚本引用路径有效（package scripts / 源码静态 import / spawn 字符串 / rules/templates）
 *   S:  skills/ 技能结构（目录名 / YAML name/description / 名称一致性 / 相对引用 / 禁用宿主措辞）
 *
 * 扩展点：monorepo 子包约定文档校验（如 PACKAGE.md 路径）、spec↔rule 双向引用等，
 * 可按仓库需要新增 D 检查。
 *
 * 退出码：0 = 全绿，1 = 有错误
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { collectRefIssues } from './lib/ref-check.mjs'
import { checkSkillStructure } from './lib/skill-check.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const verbose = process.argv.includes('--verbose')
const jsonOut = process.argv.includes('--json')

/** @typedef {{severity:'error'|'warning',check:string,message:string}} Issue */
/** @type {Issue[]} */
const issues = []

function error(check, message) {
  issues.push({ severity: 'error', check, message })
  if (verbose) console.error(`  ❌ [${check}] ${message}`)
}

function warn(check, message) {
  issues.push({ severity: 'warning', check, message })
  if (verbose) console.warn(`  ⚠️  [${check}] ${message}`)
}

function ok(check) {
  // 与 error/warn 一致走 stderr：stdout 保持纯净（--json 模式可由管道直接消费）
  if (verbose) console.error(`  ✅ ${check}`)
}

function exitWithReport() {
  const errors = issues.filter(i => i.severity === 'error')
  const warnings = issues.filter(i => i.severity === 'warning')

  if (jsonOut) {
    console.log(JSON.stringify({ errors, warnings, summary: { errors: errors.length, warnings: warnings.length } }, null, 2))
  } else {
    if (errors.length === 0 && warnings.length === 0) {
      console.log('✅ 文档校验全部通过')
    } else {
      if (warnings.length > 0) console.log(`⚡ ${warnings.length} 个警告`)
      if (errors.length > 0) console.log(`❌ ${errors.length} 个错误`)
      for (const i of issues) {
        const icon = i.severity === 'error' ? '❌' : '⚠️ '
        console.log(`${icon} [${i.check}] ${i.message}`)
      }
    }
  }

  process.exit(errors.length > 0 ? 1 : 0)
}

function readFile(relPath) {
  const full = resolve(root, relPath)
  if (!existsSync(full)) return null
  return readFileSync(full, 'utf-8')
}

function grepLines(content, regex) {
  /** @type {{index:number,line:number,text:string}[]} */
  const matches = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = regex.exec(lines[i])
    if (m) matches.push({ index: m.index, line: i + 1, text: m[0].trim() })
  }
  return matches
}

/**
 * 归一化 ADR 状态值
 * "✅ 已决策并实施" → "已实施"
 * "已决策" / "已实施" / "已废弃" / "待重评" / "提议" → 直接返回
 */
function normalizeStatus(raw) {
  const s = raw.replace(/^[✅❌⚠️🔄\s]+/, '').trim()
  if (s.includes('已实施') || s.includes('已决策并实施')) return '已实施'
  if (s.includes('已废弃')) return '已废弃'
  if (s.includes('待重评')) return '待重评'
  if (s.includes('已决策')) return '已决策'
  if (s.includes('提议')) return '提议'
  return s
}

// ══════════════════════════════════════════════════════════════
// D1: 活动 plan 文档 checklist 全部 [x]（archive 内已归档，不回溯检查）
// ══════════════════════════════════════════════════════════════
function checkD1() {
  const docsDir = resolve(root, 'docs')
  if (!existsSync(docsDir)) {
    ok('D1 规划文档 — 无 docs/ 目录')
    return
  }

  // 活动 plan 指 docs/ 下以 plan- 开头、.md 结尾、非 -notes.md（实施笔记）的正式计划；
  // 只看名称与位置判定，不维护冻结/施工中状态；archive 内已归档即完成，不参与检查
  const activePlanFiles = readdirSync(docsDir)
    .filter(f => f.startsWith('plan-') && f.endsWith('.md') && !f.endsWith('-notes.md'))
    .sort()

  if (activePlanFiles.length === 0) {
    ok('D1 规划文档 — 无活动 plan')
    return
  }

  for (const file of activePlanFiles) {
    const content = readFile(`docs/${file}`)
    if (!content) {
      error('D1', `无法读取 ${file}`)
      continue
    }

    const openChecklist = grepLines(content, /^\s*-\s*\[ \]/)
    if (openChecklist.length > 0) {
      // 活动 plan 存在未勾选条目 → 阻塞（合并/发版前必须全部 [x]）
      for (const { line, text } of openChecklist) {
        error('D1', `${file}:${line} 活动 plan 存在未勾选条目: ${text}`)
      }
    } else {
      const completedChecklist = grepLines(content, /^\s*-\s*\[x\]/)
      if (completedChecklist.length === 0) warn('D1', `${file} 疑似草案——无验收清单段`)
      else if (content.includes('已完成于'))
        // 已冻结但未归档：冻结标记（已完成于）出现即应移入 archive（发版 checklist 原子动作），
        // 阻塞合并/发版；判定口径与 release/archive-plan 一致（includes 子串），杜绝口径分裂
        error('D1', `${file} 已冻结但未归档，应经 release/archive-plan 移入 docs/archive/`)
      else ok(`D1 ${file} — 全部 ${completedChecklist.length} 项已完成`)
    }
  }
}

// ══════════════════════════════════════════════════════════════
// D2: ADR 状态一致性
// ══════════════════════════════════════════════════════════════
function checkD2() {
  const indexPath = resolve(root, 'docs/adr/INDEX.md')
  if (!existsSync(indexPath)) {
    error('D2', 'ADR INDEX.md 不存在')
    return
  }

  const indexContent = readFileSync(indexPath, 'utf-8')
  const adrDir = resolve(root, 'docs/adr')
  const adrFiles = readdirSync(adrDir).filter(f => f.startsWith('ADR-') && f.endsWith('.md'))

  // 解析 INDEX.md 表格
  const indexRows = []
  const tableRegex = /\|\s*\[(\d+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|/g
  let match
  while ((match = tableRegex.exec(indexContent)) !== null) {
    indexRows.push({ num: match[1], file: match[2], status: match[3].trim() })
  }

  // 检查每个 ADR 文件
  for (const row of indexRows) {
    const adrContent = readFile(`docs/adr/${row.file}`)
    if (!adrContent) {
      error('D2', `INDEX.md 引用的 ADR 文件不存在: ${row.file}`)
      continue
    }

    // 提取 ADR 文件内的状态行（兼容两种格式）
    let fileStatusMatch = /^-\s*状态：\s*(.+)$/m.exec(adrContent)
    // 兼容旧格式：- **状态**：✅ 已决策并实施
    if (!fileStatusMatch) {
      fileStatusMatch = /^-\s*\*\*状态\*\*：(.+)$/m.exec(adrContent)
    }
    if (!fileStatusMatch) {
      error('D2', `${row.file} 缺少状态字段，需更新为标准格式 "- 状态：已实施"`)
      continue
    }

    const rawStatus = fileStatusMatch[1].trim()
    // 归一化状态值 — 去除 emoji 前缀和修饰词
    const fileStatus = normalizeStatus(rawStatus)
    const indexStatus = normalizeStatus(row.status)

    if (fileStatus !== indexStatus) {
      error('D2', `${row.file} 状态不一致: INDEX.md="${row.status}" 文件="${rawStatus}"`)
    }
  }

  // 检查 ADR 文件中有但 INDEX.md 中没有的
  for (const file of adrFiles) {
    const numMatch = /^ADR-(\d+)-/.exec(file)
    if (!numMatch) continue
    const found = indexRows.find(r => r.num === numMatch[1])
    if (!found) {
      error('D2', `ADR 文件存在但未在 INDEX.md 中登记: ${file}`)
    }
  }

  // 检查 INDEX.md 中的 ADR 是否都有对应文件
  for (const row of indexRows) {
    if (!adrFiles.includes(row.file)) {
      error('D2', `INDEX.md 登记了不存在的 ADR: ${row.file}`)
    }
  }

  // 已废弃 是合法终态，所有 ADR 可追溯，不警告
  // 待重评 是不确定状态，提醒确认
  const needsReview = indexRows.filter(r => r.status.startsWith('待重评'))
  for (const d of needsReview) {
    warn('D2', `${d.file} 状态为 "${d.status}"，待重新评估`)
  }

  ok(`D2 ADR 索引 — ${indexRows.length} 条记录，${adrFiles.length} 个文件`)
}

// ══════════════════════════════════════════════════════════════
// D3: 文档交叉引用有效（docs/ 下引用的 ADR-NNN 必须存在）
// ══════════════════════════════════════════════════════════════
function checkD3() {
  const adrDir = resolve(root, 'docs/adr')
  const adrFiles = existsSync(adrDir) ? readdirSync(adrDir).filter(f => f.startsWith('ADR-')) : []

  const docsDir = resolve(root, 'docs')
  if (!existsSync(docsDir)) {
    ok('D3 交叉引用 — 无 docs/ 目录')
    return
  }
  const docFiles = readdirSync(docsDir).filter(f => f.endsWith('.md'))

  for (const file of docFiles) {
    const content = readFile(`docs/${file}`)
    if (!content) continue

    // 查找 ADR-NNN 引用（支持任意位数编号）
    const adrRefs = [...content.matchAll(/ADR-(\d+)/g)]
    for (const ref of adrRefs) {
      const expectedFile = `ADR-${ref[1]}`
      const found = adrFiles.find(f => f.startsWith(expectedFile))
      if (!found) {
        warn('D3', `${file} 引用了不存在的 ADR: ${expectedFile}`)
      }
    }
  }

  ok('D3 交叉引用 — 已检查')
}

// ══════════════════════════════════════════════════════════════
// D4: 脚本引用路径有效
// ══════════════════════════════════════════════════════════════
function checkD4() {
  const refIssues = collectRefIssues(root)
  if (refIssues.length === 0) {
    ok('D4 脚本引用 — 全部有效')
    return
  }
  // 失效引用恒为 error（archive 历史快照不扫描）
  for (const i of refIssues) {
    // ref-check 的 file 已包含定位（文件:行 或 package.json scripts.<key>）
    error('D4', `${i.file} ${i.message}`)
  }
  ok(`D4 脚本引用 — ${refIssues.length} 个错误`)
}

// ══════════════════════════════════════════════════════════════
// S: skills/ 技能结构（契约唯一实现于 lib/skill-check.mjs）
// ══════════════════════════════════════════════════════════════
function checkS() {
  const { errors: skillErrors, warnings: skillWarnings } = checkSkillStructure(root)
  for (const e of skillErrors) error(e.check, e.message)
  for (const w of skillWarnings) warn(w.check, w.message)
  ok('S skills/ 技能结构')
}

// ══════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════
if (!jsonOut) {
  console.log('文档一致性校验')
  console.log('================\n')
}

checkD1()
checkD2()
checkD3()
checkD4()
checkS()

if (!jsonOut) console.log()
exitWithReport()
