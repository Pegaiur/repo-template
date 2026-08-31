#!/usr/bin/env node
/**
 * verify — 仓库级合并与发布门禁单一入口（profile 模式）
 *
 * 用法：
 *   node scripts/verify.mjs <merge|release> [--base <sha>] [--all] [--json] [--output <path>]
 *
 * Profile：
 *   merge   始终执行 gates.mjs 的 BASE_STEPS，再按变更路径路由追加 ROUTE_GROUPS 命中项；
 *           未知跨模块路径失败关闭到较宽 profile（见 gates.mjs FAILOVER_*）。
 *   release 全量门禁（BASE_STEPS + 全部 ROUTE_GROUPS），tag 前在 merge commit 上执行。
 *
 * 命令清单唯一事实源是 scripts/gates.mjs（适配层）；本文件是执行引擎，不含具体命令。
 *
 * 结构化结果：每步记录命令、开始/结束时间、退出码、profile 版本与 HEAD SHA；不记录环境变量与密钥。
 * 诊断产物：默认写入 dev-temp/runs/verify/<run-id>/（命令日志、失败摘要、result.json），可安全重建与清理。
 *
 * 边界：
 *   - CLI 参数解析与 profile 解析分离，核心接受注入 root/runner，便于 node:test；
 *   - 基础命令按固定顺序失败即停，不提供通用 --skip-* 组合；
 *   - --all 绕过路径裁剪但不绕过任何门禁；
 *   - 不通过 tooling run 间接调用，本文件与 gates.mjs 是门禁命令唯一事实源。
 */

import { parseArgs } from 'node:util'
import { resolve, join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from './lib/repo-context.mjs'
import { head, diffFiles } from './lib/git.mjs'
import { runCapture, resolveCommandPrefix } from './lib/process.mjs'
import { createRunDir } from './lib/dev-workspace.mjs'
import { formatJson, writeOutput } from './lib/output.mjs'
import { globToRegex } from './lib/glob-match.mjs'
import { PROFILE_VERSION } from './lib/verify-profile.mjs'
import { BASE_STEPS, ROUTE_GROUPS, FAILOVER_ROOTS, FAILOVER_ROUTE_IDS } from './gates.mjs'

// re-export 保兼容：消费方可统一从 verify.mjs 导入 PROFILE_VERSION
export { PROFILE_VERSION }

/** 退出码：0 通过 / 1 门禁失败 / 2 参数错误 */
export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_USAGE = 2

const FAILURE_SUMMARY_LIMIT = 4_000

/** 规范化相对路径是否命中 glob（匹配以 / 开头的路径，与 lib/glob-match.mjs 同构） */
export function pathMatchesGlob(pattern, relPath) {
  const norm = String(relPath).replace(/\\/g, '/')
  return globToRegex(pattern).test('/' + norm)
}

/**
 * 分类单个变更路径 → 命中哪些路由组。
 * @param {string} relPath 相对仓库根的路径（/ 分隔）
 * @returns {{ hit: Record<string, boolean>, unknown: boolean }} hit 以路由组 id 为键；unknown 为失败关闭判定
 */
export function classifyPath(relPath) {
  const norm = String(relPath).replace(/\\/g, '/')
  /** @type {Record<string, boolean>} */
  const hit = {}
  let known = false
  for (const g of ROUTE_GROUPS) {
    hit[g.id] = g.globs.some(p => pathMatchesGlob(p, norm))
    if (hit[g.id]) known = true
  }
  // 未知跨模块路径：位于 FAILOVER_ROOTS 下但未命中任何已知路由 → 失败关闭到较宽 profile
  const unknown = FAILOVER_ROOTS.some(root => norm.startsWith(root)) && !known
  return { hit, unknown }
}

/**
 * 汇总变更文件的路由结果。
 * @param {string[]} files 相对仓库根路径数组
 * @returns {{ hit: Record<string, boolean>, failedClosed: boolean }}
 */
export function routeChangedFiles(files) {
  /** @type {Record<string, boolean>} */
  const hit = {}
  let failedClosed = false
  for (const f of files) {
    const c = classifyPath(f)
    for (const [id, v] of Object.entries(c.hit)) hit[id] = hit[id] || v
    // 未知跨模块路径失败关闭：追加 failover 路由全量，不静默跳过
    if (c.unknown) {
      failedClosed = true
      for (const id of FAILOVER_ROUTE_IDS) hit[id] = true
    }
  }
  return { hit, failedClosed }
}

/**
 * 按 profile 与路由结果展开命令步骤（清单来自 gates.mjs）。
 * @param {string} profile 'merge' | 'release'
 * @param {{ all?: boolean, hit?: Record<string, boolean> }} [opts]
 * @returns {import('./gates.mjs').StepDef[]}
 */
export function buildStepList(profile, { all = false, hit = {} } = {}) {
  const steps = [...BASE_STEPS]
  for (const g of ROUTE_GROUPS) {
    if (profile === 'release' || all || hit[g.id]) steps.push(...g.steps)
  }
  return steps
}

/** 将毫秒耗时格式化为适合门禁进度行的短文本。 */
export function formatDuration(durationMs) {
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

/**
 * 只设置最终退出码，让 stdout/stderr 管道自然排空。
 * 直接 process.exit() 会在消费方捕获 --json 输出时截断尚未刷新的 JSON。
 */
export function applyResultExitCode(passed) {
  process.exitCode = passed ? EXIT_OK : EXIT_FAIL
}

/**
 * 失败摘要同时消费 stdout/stderr 尾部：主断言常写 stdout，warning 常写 stderr。
 * 完整内容由逐步日志保留，result.json 只保存有界摘要。
 */
export function summarizeFailure(stdout, stderr, limit = FAILURE_SUMMARY_LIMIT) {
  const out = String(stdout ?? '').trim()
  const err = String(stderr ?? '').trim()
  const sections = [out && `[stdout]\n${out}`, err && `[stderr]\n${err}`].filter(Boolean)
  const combined = sections.join('\n\n')
  if (combined.length <= limit) return combined

  const notice = '…失败摘要已截断，完整输出见步骤日志\n'
  const labelsLength = (out ? '[stdout]\n'.length : 0) + (err ? '[stderr]\n'.length : 0)
  const separatorLength = out && err ? 2 : 0
  const contentBudget = Math.max(2, limit - notice.length - labelsLength - separatorLength)
  const outBudget = out && err ? Math.max(1, Math.floor(contentBudget * 0.7)) : contentBudget
  const errBudget = out && err ? Math.max(1, contentBudget - outBudget) : contentBudget
  const tail = (text, budget) => text.length <= budget
    ? text
    : `…${text.slice(-(Math.max(1, budget) - 1))}`
  const boundedSections = []
  if (out) boundedSections.push(`[stdout]\n${tail(out, outBudget)}`)
  if (err) boundedSections.push(`[stderr]\n${tail(err, errBudget)}`)
  return `${notice}${boundedSections.join('\n\n')}`
}

function durationBetween(startedAt, finishedAt) {
  const duration = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) ? Math.max(0, duration) : 0
}

/**
 * 顺序执行命令步骤，失败即停（不执行后续步骤）。
 * @param {import('./gates.mjs').StepDef[]} steps
 * @param {{ run: (command: string[], cwd: string, observer?: {onStdout?:(chunk:string)=>void,onStderr?:(chunk:string)=>void}) => Promise<{code: number, stdout?: string, stderr?: string}> }} runner 注入执行器
 * @param {{ cwd: string, now?: () => string, logPathFor?: (step:import('./gates.mjs').StepDef,index:number) => string|undefined, onStepStart?: (event:object)=>void, onStepOutput?: (event:object)=>void, onStepFinish?: (event:object)=>void }} [opts]
 * @returns {Promise<{ steps: {id:string,label:string,command:string[],startedAt:string,finishedAt:string,durationMs:number,code:number,logPath?:string,error?:string}[], passed: boolean }>}
 */
export async function executeSteps(steps, runner, {
  cwd,
  now = () => new Date().toISOString(),
  logPathFor = () => undefined,
  onStepStart = () => {},
  onStepOutput = () => {},
  onStepFinish = () => {},
} = {}) {
  const executed = []
  let passed = true
  for (const [index, step] of steps.entries()) {
    const startedAt = now()
    const logPath = logPathFor(step, index)
    const context = { index, total: steps.length, step, startedAt, logPath }
    onStepStart(context)
    let result
    try {
      result = await runner.run(step.command, cwd, {
        onStdout: chunk => onStepOutput({ ...context, stream: 'stdout', chunk }),
        onStderr: chunk => onStepOutput({ ...context, stream: 'stderr', chunk }),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const diagnostic = `[verify] 步骤执行异常：${message}\n`
      onStepOutput({ ...context, stream: 'stderr', chunk: diagnostic })
      result = { code: -1, stdout: '', stderr: diagnostic }
    }
    const finishedAt = now()
    const entry = {
      id: step.id,
      label: step.label,
      command: step.command,
      startedAt,
      finishedAt,
      durationMs: durationBetween(startedAt, finishedAt),
      code: result.code,
      ...(logPath ? { logPath } : {}),
    }
    if (result.code !== 0) {
      entry.error = summarizeFailure(result.stdout, result.stderr) || `退出码 ${result.code}`
      passed = false
    }
    executed.push(entry)
    onStepFinish({ ...context, entry, result })
    if (!passed) break
  }
  return { steps: executed, passed }
}

/**
 * 组装结构化结果（含 profile 版本、HEAD SHA、命令与退出码；不含环境变量）。
 * @param {string} profile
 * @param {{ head: string, base: string|null, startedAt: string, finishedAt: string, passed: boolean, diagnosticsDir?: string, steps: unknown[], failedClosed: boolean, hit: Record<string, boolean> }} data
 */
export function buildResult(profile, data) {
  return {
    profile,
    profileVersion: PROFILE_VERSION,
    head: data.head,
    base: data.base,
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    passed: data.passed,
    diagnosticsDir: data.diagnosticsDir,
    failedClosed: data.failedClosed,
    hit: data.hit,
    steps: data.steps,
  }
}

// ── CLI ──────────────────────────────────────────────────────────

function usage() {
  console.log(`verify — 仓库级合并与发布门禁单一入口

用法：
  node scripts/verify.mjs <merge|release> [--base <sha>] [--all] [--json] [--output <path>]

Profile：
  merge    基础门禁（gates.mjs BASE_STEPS）+ 按变更路径路由追加门禁；未知跨模块路径失败关闭
  release  全量门禁（BASE_STEPS + 全部 ROUTE_GROUPS），tag 前执行

选项：
  --base <sha>      指定合并基（默认工作区相对 HEAD，含未提交修改与未跟踪新文件，均参与路由）
  --all             绕过路径裁剪，执行 profile 全部门禁（不绕过任何门禁本身）
  --json            最终结构化结果写 stdout；实时进度与命令输出仍写 stderr
  --output <path>   结果落盘路径（目录不存在时自动创建；默认 dev-temp/runs/verify/<run-id>/result.json）
  --help            显示本帮助

退出码：0 通过 / 1 门禁失败 / 2 参数错误`)
}

/** 命令执行器（CLI 真实实现）：平台前缀经 lib/process.mjs 单点持有 */
function createCliRunner() {
  return {
    async run(command, cwd, observer = {}) {
      const [cmd, ...args] = command
      if (cmd === 'node') {
        return runCapture(process.execPath, args, { cwd, ...observer })
      }
      const [headCmd, ...prefix] = resolveCommandPrefix(cmd)
      return runCapture(headCmd, [...prefix, ...args], { cwd, ...observer })
    },
  }
}

function formatCommand(command) {
  return command.map(arg => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')
}

/** CLI 观察器：实时写 stderr，并把每步完整 stdout/stderr tee 到独立日志。 */
export function createStepObserver(runDir, stderr = process.stderr) {
  const states = new Map()
  return {
    logPathFor(step, index) {
      const safeId = step.id.replace(/[^a-zA-Z0-9._-]+/g, '-')
      return `logs/${String(index + 1).padStart(2, '0')}-${safeId}.log`
    },
    onStepStart(event) {
      const fullPath = join(runDir, event.logPath)
      writeOutput(fullPath, [
        `步骤：${event.step.label} (${event.step.id})`,
        `命令：${formatCommand(event.step.command)}`,
        `开始：${event.startedAt}`,
        '',
      ].join('\n'))
      states.set(event.index, { fullPath, lastStream: null, lineOpen: false })
      stderr.write(`[${event.index + 1}/${event.total}] ▶ ${event.step.label}：${formatCommand(event.step.command)}\n`)
    },
    onStepOutput(event) {
      const state = states.get(event.index)
      if (!state) return
      if (state.lastStream !== event.stream) {
        appendFileSync(state.fullPath, `${state.lastStream === null ? '' : '\n'}[${event.stream}]\n`, 'utf-8')
        state.lastStream = event.stream
      }
      appendFileSync(state.fullPath, event.chunk, 'utf-8')
      state.lineOpen = !event.chunk.endsWith('\n')
      stderr.write(event.chunk)
    },
    onStepFinish(event) {
      const state = states.get(event.index)
      const prefix = state?.lineOpen ? '\n' : ''
      const icon = event.entry.code === 0 ? '✅' : '❌'
      const summary = `${icon} ${event.step.label}（退出码 ${event.entry.code}，${formatDuration(event.entry.durationMs)}）`
      if (state) {
        appendFileSync(state.fullPath, `${prefix}\n[verify]\n${summary}\n结束：${event.entry.finishedAt}\n`, 'utf-8')
        states.delete(event.index)
      }
      stderr.write(`${prefix}[${event.index + 1}/${event.total}] ${summary}\n`)
    },
  }
}

async function runMain() {
  // 兼容两种调用方式：经包管理器 script（npm/pnpm run）转发时首个 `--` 已被中间层剥离；
  // 直接 node 调用（node scripts/verify.mjs merge -- --base <主分支>）时 `--` 会进入 argv，
  // parseArgs 会把其后的参数当 positionals 而丢失 --base（门禁路由静默失效）。此处剥离首个 `--`。
  const argv = process.argv.slice(2)
  const sepIdx = argv.indexOf('--')
  if (sepIdx !== -1) argv.splice(sepIdx, 1)

  let values
  let positionals
  try {
    ;({ values, positionals } = parseArgs({
      args: argv,
      options: {
        base: { type: 'string' },
        all: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        output: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    }))
  } catch (e) {
    console.error(`用法错误：${e.message}`)
    process.exit(EXIT_USAGE)
  }

  if (values.help) {
    usage()
    process.exit(EXIT_OK)
  }

  const root = resolveRepoRoot(import.meta.url)
  const [profileArg] = positionals
  if (profileArg !== 'merge' && profileArg !== 'release') {
    console.error('用法错误：缺少 profile（merge|release）')
    usage()
    process.exit(EXIT_USAGE)
  }

  const startedAt = new Date().toISOString()
  const headSha = await head(root)
  const base = values.base ?? null
  const runDir = createRunDir(root, 'verify')

  // 收集变更文件：默认工作区相对 HEAD（含未提交修改与未跟踪新文件，避免新建文件漏路由假绿）；
  // --base 指定提交区间（已提交内容，无需枚举未跟踪文件）
  const files = base
    ? await diffFiles(root, { from: base, to: headSha })
    : await diffFiles(root, { untracked: true })
  const { hit, failedClosed } = routeChangedFiles(files)

  const steps = buildStepList(profileArg, { all: values.all, hit })

  const runner = createCliRunner()
  const observer = createStepObserver(runDir)
  console.error(`verify:${profileArg} — profile v${PROFILE_VERSION}，HEAD ${headSha.slice(0, 12)}`)
  console.error(`诊断目录：${runDir}`)
  const { steps: executed, passed } = await executeSteps(steps, runner, {
    cwd: root,
    ...observer,
  })
  const finishedAt = new Date().toISOString()

  const result = buildResult(profileArg, {
    head: headSha,
    base,
    startedAt,
    finishedAt,
    passed,
    diagnosticsDir: runDir,
    steps: executed,
    failedClosed,
    hit,
  })

  // 诊断产物：dev-temp/runs/verify/<run-id>/（命令日志 + result.json），可安全重建与清理
  const defaultOutput = join(runDir, 'result.json')
  const outputPath = values.output ? resolve(values.output) : defaultOutput
  writeOutput(outputPath, formatJson(result))

  if (values.json) {
    console.log(formatJson(result))
  } else {
    console.log(`verify:${profileArg} — profile v${PROFILE_VERSION}，HEAD ${headSha.slice(0, 12)}`)
    for (const s of executed) {
      const icon = s.code === 0 ? '✅' : '❌'
      console.log(`  ${icon} ${s.label}（${s.id}，退出码 ${s.code}）`)
      if (s.error) console.log(`       ${s.error.replace(/\n/g, '\n       ')}`)
    }
    console.log(`结果：${passed ? '通过' : '失败'}${passed ? '' : '，诊断产物：' + outputPath}`)
  }

  applyResultExitCode(passed)
}

// isMain 守卫：直调时执行 CLI；被 import（node:test）时仅暴露纯函数，无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) runMain()
