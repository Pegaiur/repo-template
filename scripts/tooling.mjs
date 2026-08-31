#!/usr/bin/env node
/**
 * 通用开发脚本工具（tooling）
 *
 * 用法：
 *   node scripts/tooling.mjs list
 *   node scripts/tooling.mjs run <task> -- <args...>
 *   node scripts/tooling.mjs new <domain/name>
 *   node scripts/tooling.mjs promote <scratch> <domain/name>
 *   node scripts/tooling.mjs tmp path|list|clean [--older-than <n>] [--apply]
 *
 * 约定：
 *   - tasks 目录发现是唯一注册事实，不维护第二份 manifest；
 *   - 退出码：0 成功 / 1 一般错误 / 2 参数错误；
 *   - list/new/promote 核心逻辑为接受注入 root 的纯函数，CLI 只负责参数解析与退出码。
 */

import { parseArgs } from 'node:util'
import { existsSync, readdirSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot, isPathInside as isInside, tasksRoot, scratchRoot } from './lib/repo-context.mjs'
import { runStreaming } from './lib/process.mjs'
import { normalizeTaskRef } from './lib/task-ref.mjs'
import { getDevTmpRoot, getRunDirRoot } from './lib/dev-workspace.mjs'

export { normalizeTaskRef }

// ── 常量 ──────────────────────────────────────────────────────

/** 退出码：成功 */
export const EXIT_OK = 0
/** 退出码：一般错误 */
export const EXIT_ERROR = 1
/** 退出码：参数/用法错误 */
export const EXIT_USAGE = 2

/** CLI 入口从本文件位置定位仓库根（lib/repo-context.mjs 向上查找仓库标志文件，默认 .git） */
const CLI_ROOT = resolveRepoRoot(import.meta.url)

// ── 核心纯函数（接受注入 root，无顶层副作用，便于 node:test） ──

/**
 * 校验 child 是否位于 parent 之内（等值视为越界）。
 * 委托 lib/repo-context.mjs 的 isPathInside（路径内收检查单一实现）。
 */
export { isInside }

/**
 * 目录发现：递归枚举 scripts/tasks/**\/*.mjs，返回相对 tasks 根的排序路径。
 * @param {string} root 仓库根
 * @returns {string[]}
 */
export function listTasks(root) {
  const tasksDir = tasksRoot(root)
  if (!existsSync(tasksDir)) return []
  const found = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
      } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
        found.push(prefix ? `${prefix}/${entry.name}` : entry.name)
      }
    }
  }
  walk(tasksDir, '')
  return found.sort()
}

/**
 * 枚举 lib 模块：scripts/lib/*.mjs 文件名 + 头部 JSDoc 摘要首行。
 * @param {string} root 仓库根
 * @returns {{name:string, summary:string}[]}
 */
export function listLibModules(root) {
  const libRoot = resolve(root, 'scripts', 'lib')
  if (!existsSync(libRoot)) return []
  const out = []
  for (const f of readdirSync(libRoot).filter(f => f.endsWith('.mjs')).sort()) {
    const content = readFileSync(resolve(libRoot, f), 'utf-8')
    // 取文件头 `/**` 后首个 ` * 描述` 行作摘要
    const summary = content.match(/^\s*\*\s+([^*].+)$/m)?.[1] ?? ''
    out.push({ name: f.replace(/\.mjs$/, ''), summary })
  }
  return out
}

/**
 * 计算从目标脚本（scripts/{scratch|tasks}/<norm>.mjs）到 lib 指定模块的相对导入路径。
 * scratch 与 promote 后位于相同层级的同名文件相对路径一致，promote 无需重写。
 * @param {string} norm 规范化任务名（不含 .mjs）
 * @param {string} [file] lib 模块文件名（默认 repo-context.mjs）
 */
function relativeLibImport(norm, file = 'repo-context.mjs') {
  const depth = norm.split('/').length
  return `${'../'.repeat(depth)}lib/${file}`
}

/**
 * 渲染 scratch 最小模板（promote 后 task 的质量基线）。
 * 固定包含：repo-context、dev-workspace（createRunDir）、parseArgs、中文错误、标准退出码、dev-temp/runs 示例与 lib 基元清单。
 * @param {string} norm 规范化任务名（不含 .mjs）
 */
export function renderScratchTemplate(norm) {
  const libImport = relativeLibImport(norm, 'repo-context.mjs')
  const wsImport = relativeLibImport(norm, 'dev-workspace.mjs')
  return `/**
 * ${norm} — 在此替换为简短描述
 *
 * 用法：
 *   node scripts/scratch/${norm}.mjs [参数...]
 *
 * 模板骨架（promote 后 task 的质量基线）：
 *   - repo-context：从模块位置定位仓库根，不手写路径拼接
 *   - dev-workspace：createRunDir 生成并发安全的 dev-temp/runs/<task>/<run-id>/ 目录
 *   - parseArgs：统一参数解析（'--' 之后的参数进入 positionals）
 *   - 中文错误：面向用户的错误消息使用中文
 *   - 标准退出码：0 成功 / 1 一般错误 / 2 参数错误
 *   - 更多可用 lib 基元（见 scripts/INDEX.md lib 模块表）：
 *       process.runCapture/runStreaming  —— 子进程执行（参数数组 + windowsHide，不拼 shell）
 *       git.diffFiles/logRange          —— 只读 git 封装
 *       output.formatJson/formatTsv/writeOutput —— 结构化输出与文件落位
 */

import { parseArgs } from 'node:util'
import { resolveRepoRoot } from '${libImport}'
import { createRunDir } from '${wsImport}'

// repo-context：从模块位置定位仓库根
const root = resolveRepoRoot(import.meta.url)

// 临时产物：完整中间结果写入 dev-temp/runs/<task>/<run-id>/（createRunDir 含时间戳+PID+随机后缀，并发安全）
const runDir = createRunDir(root, '${norm}')

// parseArgs：统一参数解析（'--' 之后的参数进入 positionals）
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { verbose: { type: 'boolean', default: false } },
  allowPositionals: true,
})

// 标准退出码：0 成功 / 1 一般错误 / 2 参数错误
function fail(message, code = 1) {
  console.error(\`错误：\${message}\`)
  process.exit(code)
}

if (positionals.length === 0) {
  fail('缺少必要参数', 2)
}

if (values.verbose) {
  console.log(\`参数：\${JSON.stringify(positionals)}\`)
}

// TODO：在此实现任务主体逻辑；面向用户的错误与日志使用中文
console.log(\`${norm} 运行中，run 目录：\${runDir}\`)
`
}

/**
 * new：从最小模板创建 scratch。拒绝覆盖与路径穿越。
 * @param {string} root 仓库根
 * @param {string} ref 任务引用，如 "perf/load-run"
 * @returns {string} 创建的相对路径（scripts/scratch/<norm>.mjs）
 */
export function createScratch(root, ref) {
  const norm = normalizeTaskRef(ref)
  if (!norm) throw new Error(`非法任务路径：${ref}`)

  const scratchDir = scratchRoot(root)
  const target = resolve(scratchDir, `${norm}.mjs`)
  if (!isInside(scratchDir, target)) {
    throw new Error(`路径越界：拒绝写入 scratch 目录之外（${ref}）`)
  }
  if (existsSync(target)) {
    throw new Error(`已存在，拒绝覆盖：scripts/scratch/${norm}.mjs`)
  }

  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, renderScratchTemplate(norm), 'utf-8')
  return `scripts/scratch/${norm}.mjs`
}

/**
 * promote：将 scratch 移动到 tasks。
 * 仅移动文件：不重写内容、不生成测试、不修改构建清单。
 * @param {string} root 仓库根
 * @param {string} scratchRef scratch 引用（相对 scripts/scratch/）
 * @param {string} taskRef 目标任务引用（相对 scripts/tasks/）
 * @returns {string} 移动后的相对路径（scripts/tasks/<norm>.mjs）
 */
export function promoteScratch(root, scratchRef, taskRef) {
  const scratchNorm = normalizeTaskRef(scratchRef)
  const taskNorm = normalizeTaskRef(taskRef)
  if (!scratchNorm) throw new Error(`非法 scratch 路径：${scratchRef}`)
  if (!taskNorm) throw new Error(`非法任务路径：${taskRef}`)

  const scratchDir = scratchRoot(root)
  const tasksDir = tasksRoot(root)
  const src = resolve(scratchDir, `${scratchNorm}.mjs`)
  const dst = resolve(tasksDir, `${taskNorm}.mjs`)

  if (!isInside(scratchDir, src)) throw new Error(`路径越界：scratch 来源非法（${scratchRef}）`)
  if (!isInside(tasksDir, dst)) throw new Error(`路径越界：任务目标非法（${taskRef}）`)
  if (!existsSync(src)) throw new Error(`scratch 不存在：scripts/scratch/${scratchNorm}.mjs`)
  if (existsSync(dst)) throw new Error(`目标已存在，拒绝覆盖：scripts/tasks/${taskNorm}.mjs`)

  mkdirSync(dirname(dst), { recursive: true })
  renameSync(src, dst)
  return `scripts/tasks/${taskNorm}.mjs`
}

/**
 * run：解析任务文件绝对路径，仅允许 scripts/tasks/ 目录内。
 * @param {string} root 仓库根
 * @param {string} ref 任务引用，如 "git/head-diff"
 * @returns {{norm:string, target:string}}
 */
export function resolveTaskPath(root, ref) {
  const norm = normalizeTaskRef(ref)
  if (!norm) throw new Error(`非法任务路径：${ref}`)

  const tasksDir = tasksRoot(root)
  const target = resolve(tasksDir, `${norm}.mjs`)
  if (!isInside(tasksDir, target)) {
    throw new Error(`路径越界：拒绝运行 tasks 目录之外的文件（${ref}）`)
  }
  return { norm, target }
}

/**
 * 递归收集 dev-temp 工作区下的全部条目（相对 dev-temp 根的路径）。
 * @param {string} root 仓库根
 * @returns {{rel:string, isDir:boolean}[]}
 */
export function listTmpEntries(root) {
  const tmpRoot = getDevTmpRoot(root)
  if (!existsSync(tmpRoot)) return []
  const entries = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        entries.push({ rel, isDir: true })
        walk(resolve(dir, entry.name), rel)
      } else {
        entries.push({ rel, isDir: false })
      }
    }
  }
  walk(tmpRoot, '')
  return entries
}

/**
 * 收集 tmp clean 的目标：tmpRoot 下的顶层条目（绝不包含仓库根或 dev-temp 根自身）。
 * @param {string} root 仓库根
 * @returns {{rel:string, abs:string}[]}
 */
export function collectTmpCleanTargets(root) {
  const tmpRoot = getDevTmpRoot(root)
  if (!existsSync(tmpRoot)) return []
  return readdirSync(tmpRoot)
    .map(name => ({ rel: name, abs: resolve(tmpRoot, name) }))
    .filter(t => isInside(tmpRoot, t.abs))
}

/**
 * 清理 tmp 工作区全部顶层条目；返回被删除的条目数。
 * @param {string} root 仓库根
 */
export function cleanTmp(root) {
  return cleanTmpTargets(collectTmpCleanTargets(root))
}

/**
 * 通用删除：删除给定 targets 数组中的全部条目；返回删除数。
 * @param {{rel:string, abs:string}[]} targets
 */
export function cleanTmpTargets(targets) {
  for (const t of targets) {
    rmSync(t.abs, { recursive: true, force: true })
  }
  return targets.length
}

/**
 * 解析 run-id 目录名前缀时间戳（run-id 格式：时间戳-PID-随机后缀）。
 * @param {string} name 目录名
 * @returns {number|null} 毫秒时间戳；非 run-id 命名返回 null
 */
export function parseRunIdTimestamp(name) {
  const m = /^(\d{13})-/.exec(name)
  if (!m) return null
  const ts = Number(m[1])
  return Number.isFinite(ts) ? ts : null
}

/**
 * 按龄期收集过期 run：递归扫描 dev-temp/runs 下全部 run-id 命名目录（run-id 格式：时间戳-PID-随机）。
 * 支持任务名带域的三层结构（如 runs/git/head-diff/<run-id>）：目录条目若为 run-id 命名且超过
 * cutoff 则收集，否则若是目录则继续下探；work/cache 非 run 目录不受影响。
 * @param {string} root 仓库根
 * @param {number} olderThanDays 超过 N 天视为过期（正整数）
 * @returns {{rel:string, abs:string}[]} 相对 dev-temp 根的路径与绝对路径
 */
export function collectTmpOldRunTargets(root, olderThanDays) {
  const runsRoot = getRunDirRoot(root)
  if (!existsSync(runsRoot)) return []
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  const targets = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const ts = parseRunIdTimestamp(entry.name)
      const abs = resolve(dir, entry.name)
      if (!isInside(runsRoot, abs)) continue
      if (ts !== null) {
        if (ts < cutoff) targets.push({ rel: rel ? `${rel}/${entry.name}` : entry.name, abs })
      } else {
        walk(abs, rel ? `${rel}/${entry.name}` : entry.name)
      }
    }
  }
  walk(runsRoot, 'runs')
  return targets
}

// ── CLI（只负责参数解析与退出码） ──────────────────────────────

function usage() {
  console.log(`开发脚本工具

用法：
  node scripts/tooling.mjs <命令> [参数...]

命令：
  list                     列出 scripts/tasks/ 下的可运行任务（目录发现）
  list --lib               列出 scripts/lib/ 共享基元（文件名 + 头部摘要，能力发现）
  run <task> -- <args...>  以独立 Node 子进程运行任务，args 透传给任务
  new <domain/name>        从最小模板创建 scratch（拒绝覆盖）
  promote <scratch> <domain/name>
                           将 scratch 移动到 tasks（不重写、不生成测试、不改构建清单）
  tmp path                 显示仓库内开发工作区根路径（dev-temp/）
  tmp list                 列出 dev-temp/runs|work|cache 内容
  tmp clean [--older-than <n>] [--apply]
                           清理工作区；默认 dry-run；--older-than 只淘汰超过 n 天的 run；
                           --apply 才真实删除

退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

function fail(message, code = EXIT_ERROR) {
  console.error(`错误：${message}`)
  process.exit(code)
}

function failUsage(message) {
  console.error(`用法错误：${message}`)
  process.exit(EXIT_USAGE)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    usage()
    process.exit(EXIT_USAGE)
  }

  // run 命令的任务参数可能以 `-` 开头（如 --scope/--iterations），且经包管理器 script
  // 或 shell 别名调用时 `--` 分隔符可能被中间层消费，因此 run 命令完全绕过 parseArgs 的 strict 校验，
  // 任务名之后（含可选显式 `--`）的参数原样透传给任务脚本。
  if (argv[0] === 'run') {
    const task = argv[1]
    if (!task) failUsage('run 缺少任务名（tooling run <task> -- <args...>）')
    let taskArgs = argv.slice(2)
    if (taskArgs[0] === '--') taskArgs = taskArgs.slice(1) // 直调时的显式分隔
    try {
      const { target } = resolveTaskPath(CLI_ROOT, task)
      if (!existsSync(target)) {
        fail(`任务不存在：${task}（可用 tooling list 查看）`)
      }
      process.exit(await runStreaming(process.execPath, [target, ...taskArgs]))
    } catch (e) {
      fail(e.message ?? String(e))
    }
  }

  let values
  let positionals
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        apply: { type: 'boolean', default: false },
        lib: { type: 'boolean', default: false },
        'older-than': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    }))
  } catch (e) {
    failUsage(`${e.message}；向任务传参请使用：tooling run <task> -- <args...>`)
  }

  const [cmd, ...rest] = positionals
  if (!cmd) {
    usage()
    process.exit(EXIT_USAGE)
  }

  try {
    switch (cmd) {
      case 'list': {
        if (values.lib) {
          // 能力发现：列出 scripts/lib/ 共享基元（文件名 + 头部摘要），不 import 任何模块
          const mods = listLibModules(CLI_ROOT)
          if (mods.length === 0) {
            console.log('（scripts/lib/ 下无模块）')
          } else {
            for (const m of mods) console.log(`${m.name} — ${m.summary}`)
          }
          break
        }
        const tasks = listTasks(CLI_ROOT)
        if (tasks.length === 0) {
          console.log('（暂无任务：scripts/tasks/ 尚未注册任何任务）')
        } else {
          for (const t of tasks) console.log(t)
        }
        break
      }

      case 'new': {
        if (rest.length !== 1) failUsage('new 需要一个任务名（tooling new <domain/name>）')
        const created = createScratch(CLI_ROOT, rest[0])
        console.log(`已创建 scratch：${created}`)
        console.log('提示：第二次复用时执行 node scripts/tooling.mjs promote 提升为 task；可用 lib 基元见 scripts/INDEX.md')
        break
      }

      case 'promote': {
        if (rest.length !== 2) failUsage('promote 需要 scratch 与目标任务名（tooling promote <scratch> <domain/name>）')
        const moved = promoteScratch(CLI_ROOT, rest[0], rest[1])
        console.log(`已提升为 task：${moved}`)
        console.log('注意：promote 仅移动文件，未生成测试、未修改构建清单')
        break
      }

      case 'tmp': {
        const sub = rest[0] ?? ''
        const tmpRoot = getDevTmpRoot(CLI_ROOT)
        if (sub === 'path') {
          console.log(tmpRoot)
        } else if (sub === 'list') {
          if (!existsSync(tmpRoot)) {
            console.log('（dev-temp/ 尚未创建）')
          } else {
            const entries = listTmpEntries(CLI_ROOT)
            if (entries.length === 0) {
              console.log('（dev-temp/ 下无内容）')
            } else {
              for (const e of entries) {
                console.log(`${e.isDir ? '[目录] ' : '[文件] '}${e.rel}`)
              }
            }
          }
        } else if (sub === 'clean') {
          // --older-than <n>：只按龄期淘汰 dev-temp/runs 下过期 run；否则全清顶层条目
          if (values['older-than'] !== undefined) {
            const days = Number(values['older-than'])
            if (!Number.isInteger(days) || days <= 0) {
              failUsage('--older-than 需要正整数（天）')
            }
            const targets = collectTmpOldRunTargets(CLI_ROOT, days)
            if (targets.length === 0) {
              console.log(`dev-temp/runs 下无超过 ${days} 天的 run 可清理`)
              break
            }
            if (!values.apply) {
              console.log(`[dry-run] 将清理 ${targets.length} 个过期 run（真实删除需 --apply）：`)
              for (const t of targets) console.log(`  - ${t.rel}`)
            } else {
              const n = cleanTmpTargets(targets)
              console.log(`已清理 ${n} 个过期 run（超过 ${days} 天）`)
            }
            break
          }
          const targets = collectTmpCleanTargets(CLI_ROOT)
          if (targets.length === 0) {
            console.log('dev-temp/ 下无内容可清理')
            break
          }
          if (!values.apply) {
            console.log(`[dry-run] 将清理 ${targets.length} 个顶层条目（真实删除需 --apply）：`)
            for (const t of targets) console.log(`  - ${t.rel}`)
          } else {
            const n = cleanTmp(CLI_ROOT)
            console.log(`已清理 ${n} 个顶层条目`)
          }
        } else {
          failUsage('tmp 需要子命令：path | list | clean')
        }
        break
      }

      default:
        usage()
        process.exit(EXIT_USAGE)
    }
  } catch (e) {
    fail(e.message ?? String(e))
  }
}

// 大小写不敏感判定直接调用：import.meta.url 与 argv[1] 分别 resolve 后归一比对，兼容 Windows 盘符大小写
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main()
}
