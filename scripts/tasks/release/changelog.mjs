#!/usr/bin/env node
/**
 * release/changelog — 发版区间变更摘要（人类版 / Agent 版同源双视图）
 *
 * 用法：
 *   node scripts/tasks/release/changelog.mjs [--from <tag>] [--to <commit>] [--version <v>]
 *                                            [--pkg <dir|all>] [--agent] [--max <n>]
 *                                            [--apply] [--json] [--root <dir>] [--help]
 *
 * 数据源：lib/git.mjs logMessages（subject+body，--no-merges，hash 模式附带 8 位短哈希）
 *         + lib/conventional-bump.mjs classifyCommit（前缀分类 + BREAKING CHANGE 判定）。
 * 区间缺省 = 最近 tag..HEAD，与 calculate-version 版本推算同区间（版本/变更日志/门禁路由不漂移）。
 *
 * 视图（同一数据、两个 renderer）：
 *   人类版（默认）：`## v<version>（<date>）` + 分类分节（Breaking Changes / Features / Bug Fixes / 其他），
 *                   每条带 8 位短哈希；--pkg 时改为按包分节（行内保留 [type] 标记）。
 *   Agent 版（--agent）：每条一行 `[type][pkg|scope] 描述 🚨`，默认限 30 行（--max 可调），--pkg 时按包分组
 *                   ——给 Agent 的上下文压缩视图，发版后新任务首读。
 *
 * 写入（--apply）：把新版本段插入 docs/CHANGELOG.md（首个 `## ` 段之前，旧段落不动——只累积不重写）；
 *             同版本段已存在则拒绝；--apply 必须提供 --version（版本段标题），且随 chore(release) 同笔提交。
 *
 * 边界：非门禁——不规范提交归「其他」分组 + stderr warning，不阻塞、不改写；首版无 tag 回退全量历史 +
 *       warning；提交触达多包时在各包节内重复（与逐包推算语义一致）；不 commit / 不 tag / 不发 Release。
 * 退出码：0 成功 / 1 一般错误 / 2 参数错误。
 */

import { parseArgs } from 'node:util'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'
import { logMessages, describeLatestTag } from '../../lib/git.mjs'
import { classifyCommit } from '../../lib/conventional-bump.mjs'
import { runCapture } from '../../lib/process.mjs'
import { collectPackages } from './calculate-version.mjs'
import { formatJson } from '../../lib/output.mjs'

const DEFAULT_ROOT = resolveRepoRoot(import.meta.url)
const DEFAULT_AGENT_MAX = 30

/** 人类版分类分节标题（顺序即输出顺序） */
const SECTION_TITLES = [
  ['breaking', 'Breaking Changes'],
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['other', '其他'],
]

const CHANGELOG_HEADER = [
  '# 更新日志',
  '',
  '> 由 scripts/tasks/release/changelog.mjs 在发版收束时生成（--apply 追加，与 chore(release) 同笔提交）；只累积、不重写历史。',
  '> 与 docs/archive/INDEX.md 分工：INDEX = 计划完成索引；本文件 = 版本变更事实；决策记录归实施笔记/ADR。',
]

function usage() {
  console.log(`release/changelog — 发版区间变更摘要（人类版 / Agent 版同源双视图）

用法：
  node scripts/tasks/release/changelog.mjs [--from <tag>] [--to <commit>] [--version <v>]
                                           [--pkg <dir|all>] [--agent] [--max <n>]
                                           [--apply] [--json] [--root <dir>]

选项：
  --from <tag>      起始提交（exclusive，缺省 = 最近 vx.y.z tag；无 tag 回退全量历史 + warning）
  --to <commit>     结束提交（inclusive，缺省 = HEAD）
  --version <v>     版本段标题（人类版 \`## v<v>（<date>）\`）；--apply 时必填
  --pkg <dir|all>   多包分节：<dir> 为 packages/ 内完整相对路径（如 packages/tools/summarize）或 all；
                    提交触达多包时在各包节内重复（与逐包推算一致）
  --agent           Agent 紧凑视图：每条一行 \`[type][pkg|scope] 描述 🚨\`，按包分组（--pkg 时）；仅预览
  --max <n>         Agent 视图行数上限（默认 30），超出时末尾提示剩余条数
  --apply           把人类版版本段插入 docs/CHANGELOG.md（只累积；同版本段已存在则拒绝）；必须提供 --version
  --json            结构化 JSON 输出（human / agentLines / warnings）
  --root <dir>      仓库根覆盖（测试注入）
  --help            显示本帮助

缺省 dry-run 只输出。非门禁：不规范提交归「其他」+ warning，不阻塞。
退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

/** 今天（YYYY-MM-DD，本地时区） */
function today() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 解析起始提交：--from 显式指定；否则最近版本 tag；无 tag 回退全量历史 + warning */
async function resolveFrom(root, fromOpt) {
  if (fromOpt) return { from: fromOpt, warnings: [] }
  try {
    return { from: await describeLatestTag(root), warnings: [] }
  } catch {
    const r = await runCapture('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: root })
    if (r.code !== 0) throw new Error(`无法确定起始提交：git rev-list 失败：${r.stderr.trim()}`)
    const first = r.stdout.trim().split(/\r?\n/)[0]
    if (!first) throw new Error('无法确定起始提交：仓库无任何提交')
    return { from: first, warnings: [`未找到版本 tag，回退全量历史（起始 ${first.slice(0, 12)}）`] }
  }
}

/**
 * 提交消息 → 结构化条目（纯函数）。
 * @param {{hash?:string, subject:string, body:string}[]} messages git log 新→旧
 * @returns {{ entries: {hash?:string, type:string|null, scope:string|null, desc:string, breaking:boolean}[], warnings: string[] }}
 */
export function collectEntries(messages) {
  const entries = []
  const warnings = []
  // 与 lib/conventional-bump.mjs CONVENTIONAL_RE 同款前缀结构；此处额外捕获 scope 供展示
  const conventional = /^(feat|fix|refactor|docs|test|chore|style|perf|build|ci)(\(([^)]+)\))?(!)?:\s*/
  for (const m of messages) {
    const { type, breaking } = classifyCommit(m.subject, m.body)
    if (type === null) {
      warnings.push(`不规范提交（归入「其他」）：${m.subject}`)
      entries.push({ ...(m.hash ? { hash: m.hash } : {}), type: null, scope: null, desc: m.subject, breaking })
      continue
    }
    const scope = conventional.exec(m.subject)?.[3] ?? null
    const desc = m.subject.replace(conventional, '')
    entries.push({ ...(m.hash ? { hash: m.hash } : {}), type, scope, desc, breaking })
  }
  return { entries, warnings }
}

/** 单条 Agent 视图行：[type][pkg|scope] 描述 🚨 */
function agentLine(entry, group) {
  const type = entry.type ?? 'other'
  const parts = [`[${type}]`]
  if (group) parts.push(`[${group}]`)
  return `${parts.join('')} ${entry.desc}${entry.breaking ? ' 🚨' : ''}`
}

/**
 * Agent 视图 renderer：--pkg 按包分组（组名 = 包目录 basename），否则平铺（组名 = scope）。
 * 超出 max 行时截断并附剩余提示。
 * @returns {string[]}
 */
export function renderAgentLines({ entries, packages, max = DEFAULT_AGENT_MAX }) {
  let lines
  if (packages) {
    lines = []
    for (const p of packages) {
      for (const e of entries.filter(e => e.pkg === p.dir)) lines.push(agentLine(e, basename(p.dir)))
    }
  } else {
    lines = entries.map(e => agentLine(e, e.scope))
  }
  if (lines.length > max) {
    const hidden = lines.length - max
    return [...lines.slice(0, max), `…（另有 ${hidden} 条未显示，完整内容见 docs/CHANGELOG.md 或调大 --max）`]
  }
  return lines
}

/**
 * 人类版 renderer：输出 \`## v<version>（<date>）\` 版本段。
 * 无 --pkg 按类型分节（breaking/feat/fix/其他，空节跳过）；--pkg 按包分节（行内 [type] 标记）。
 * @param {{ version: string, date: string, entries: object[], packages: {dir:string,name:string}|null }} opts
 * @returns {string}
 */
export function renderHuman({ version, date, entries, packages }) {
  const lines = [`## v${version}（${date}）`]
  if (!packages) {
    const groups = Object.fromEntries(SECTION_TITLES.map(([key]) => [key, []]))
    for (const e of entries) {
      const key = e.breaking ? 'breaking' : e.type === 'feat' ? 'feat' : e.type === 'fix' ? 'fix' : 'other'
      groups[key].push(`- ${e.desc}${e.hash ? `（${e.hash}）` : ''}`)
    }
    for (const [key, title] of SECTION_TITLES) {
      if (groups[key].length === 0) continue
      lines.push('', `### ${title}`, '', ...groups[key])
    }
    if (entries.length === 0) lines.push('', '（区间内无提交）')
    return lines.join('\n')
  }
  for (const p of packages) {
    const pkgEntries = entries.filter(e => e.pkg === p.dir)
    if (pkgEntries.length === 0) continue
    lines.push('', `### ${basename(p.dir)}`, '')
    for (const e of pkgEntries) {
      const tag = e.type ? `[${e.type}] ` : ''
      const mark = e.breaking ? ' 🚨' : ''
      lines.push(`- ${tag}${e.desc}${mark}${e.hash ? `（${e.hash}）` : ''}`)
    }
  }
  if (lines.length === 1) lines.push('', '（区间内无提交）')
  return lines.join('\n')
}

/**
 * 追加版本段到 docs/CHANGELOG.md（只累积不重写）：文件不存在则创建（含头部说明）；
 * 已存在则把新段插入首个 `## ` 段之前（新版本在前、旧段不动）；同版本段已存在拒绝。
 * @param {string} root 仓库根
 * @param {string} version 版本段标题（如 1.42.2）
 * @param {string} sectionText renderHuman 输出
 * @returns {{ path: string, created: boolean }}
 */
export function appendChangelog(root, version, sectionText) {
  const target = join(root, 'docs', 'CHANGELOG.md')
  if (!existsSync(target)) {
    writeFileSync(target, `${CHANGELOG_HEADER.join('\n')}\n\n${sectionText}\n`, 'utf-8')
    return { path: 'docs/CHANGELOG.md', created: true }
  }
  const raw = readFileSync(target, 'utf-8')
  if (raw.includes(`## v${version}（`)) {
    throw new Error(`CHANGELOG 已存在版本段 v${version}，拒绝重复追加（如需重生成请手动删除该段后重试）`)
  }
  const lines = raw.split('\n')
  const idx = lines.findIndex(l => /^## /.test(l))
  if (idx === -1) {
    const base = raw.endsWith('\n') ? raw : `${raw}\n`
    writeFileSync(target, `${base}\n${sectionText}\n`, 'utf-8')
  } else {
    lines.splice(idx, 0, '', sectionText, '')
    writeFileSync(target, lines.join('\n'), 'utf-8')
  }
  return { path: 'docs/CHANGELOG.md', created: false }
}

function failUsage(message) {
  console.error(`用法错误：${message}`)
  process.exit(2)
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        version: { type: 'string' },
        pkg: { type: 'string' },
        agent: { type: 'boolean', default: false },
        max: { type: 'string' },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        root: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    }))
  } catch (e) {
    failUsage(e.message)
  }

  if (values.help) {
    usage()
    process.exit(0)
  }

  let max = DEFAULT_AGENT_MAX
  if (values.max !== undefined) {
    max = Number(values.max)
    if (!Number.isInteger(max) || max <= 0) failUsage('--max 需要正整数（行数）')
  }
  if (values.apply && values.agent) failUsage('--agent 视图仅预览；--apply 写入的是人类版版本段')
  if (values.apply && !values.version) failUsage('--apply 需要同时提供 --version <v>（版本段标题，与版本文件同笔收束）')

  const root = values.root ? resolve(values.root) : DEFAULT_ROOT
  const { from, warnings: fromWarnings } = await resolveFrom(root, values.from)
  const to = values.to ?? 'HEAD'
  const warnings = [...fromWarnings]

  let entries = []
  let packages = null
  if (values.pkg) {
    const all = await collectPackages(root)
    const selected = values.pkg === 'all' ? all : all.filter(p => p.dir === values.pkg)
    if (selected.length === 0) throw new Error(`未找到子包：${values.pkg}（需为 packages/ 内完整相对路径，如 packages/tools/summarize，或 all）`)
    packages = selected
    for (const p of packages) {
      const msgs = await logMessages(root, from, to, { noMerges: true, path: p.dir, hash: true })
      const r = collectEntries(msgs)
      for (const e of r.entries) entries.push({ ...e, pkg: p.dir })
      warnings.push(...r.warnings.map(w => `[${p.dir}] ${w}`))
    }
  } else {
    const msgs = await logMessages(root, from, to, { noMerges: true, hash: true })
    const r = collectEntries(msgs)
    entries = r.entries
    warnings.push(...r.warnings)
  }

  const version = values.version ?? '未发布'
  const date = today()
  const sectionText = renderHuman({ version, date, entries, packages })
  const agentLines = values.agent ? renderAgentLines({ entries, packages, max }) : null

  if (values.json) {
    console.log(formatJson({
      from,
      to,
      version,
      date,
      entryCount: entries.length,
      warnings,
      human: values.agent ? undefined : sectionText,
      agentLines: agentLines ?? undefined,
    }))
  } else if (values.agent) {
    console.log(agentLines.join('\n'))
  } else {
    console.log(sectionText)
  }

  // 警告走 stderr，stdout 保持可管道（与仓库 output 约定一致）
  for (const w of warnings) console.error(`警告：${w}`)
  if (!values.apply) {
    console.error('[dry-run] 写入 docs/CHANGELOG.md 需 --apply（并要求 --version <v>，与版本文件同笔收束）')
  } else {
    const r = appendChangelog(root, values.version, sectionText)
    console.error(`已${r.created ? '创建并写入' : '追加'}：${r.path}（版本段 v${values.version}）`)
  }
}

// isMain 守卫：直调时执行 CLI；被 import（测试）时仅暴露纯函数，无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main().catch(e => {
    console.error(`错误：${e.message ?? String(e)}`)
    process.exit(1)
  })
}
