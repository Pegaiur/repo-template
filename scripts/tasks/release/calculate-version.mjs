#!/usr/bin/env node
/**
 * release/calculate-version — 推算目标版本（默认只输出，--apply 可写入版本文件）
 *
 * 用法：
 *   node scripts/tasks/release/calculate-version.mjs [--from <tag>] [--to <commit>] [--root <dir>]
 *   node scripts/tasks/release/calculate-version.mjs --pkg <dir|all> [--apply]
 *   调用契约固定为：node scripts/tooling.mjs run release/calculate-version（默认最近 tag → HEAD 根版本）
 *
 * 根版本流程：最近 tag（vx.y.z）→ 读取 tag..HEAD 的 subject+body（--no-merges）→
 *       以 tag 版本为基准，lib/conventional-bump 推算目标版本（pre-1.0 保护、空区间不变）。
 * 子包流程（--pkg）：基线 = 子包当前版本字段（子包无独立 tag）；
 *       区间内按包目录路径过滤日志（git log --no-merges -- <dir>），逐包独立推算。
 * --pkg all 输出 { dir, name, current, target, changed, reviewDocs? }[]；
 *       changed（版本发生 bump）包附 reviewDocs: true 软提醒——发版 agent 应核对包级约定文档
 *       （如 PACKAGE.md / README）职责段是否过期（不阻塞发版）。
 * --apply：实际写入版本文件，默认 dry-run 只输出。
 * 本任务不 commit、不 tag（由发版流程负责）。
 *
 * ★ 版本文件适配器（换语言/生态时的唯一改动点）：
 *   - 默认实现面向 npm 系 package.json；Cargo.toml / pyproject.toml / Gradle 等替换三处：
 *     collectPackages（子包发现）、读版本（collectPackages 内 version 字段）、
 *     writePackageVersion（写版本，保持"只改 version、复用源文件缩进"的最小 diff 原则）；
 *   - 版本推算核心（lib/conventional-bump + git log 路径过滤）与生态无关，无需改动。
 */

import { parseArgs } from 'node:util'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'
import { logMessages, describeLatestTag } from '../../lib/git.mjs'
import { calculateBump } from '../../lib/conventional-bump.mjs'
import { formatJson } from '../../lib/output.mjs'

const DEFAULT_ROOT = resolveRepoRoot(import.meta.url)

function usage() {
  console.log(`release/calculate-version — 推算目标版本（--apply 可写入版本文件）

用法：
  node scripts/tasks/release/calculate-version.mjs [--from <tag>] [--to <commit>] [--apply]
  node scripts/tasks/release/calculate-version.mjs --pkg <dir|all> [--apply]
  调用契约：node scripts/tooling.mjs run release/calculate-version（默认最近 tag → HEAD 根版本）

选项：
  --from <tag>         起始版本 tag（exclusive，缺省 = 最近 vx.y.z tag）
  --to <commit>        结束提交（inclusive，缺省 = HEAD）
  --pkg <dir|all>      子包逐包推算：<dir> 单包（packages/ 内目录）或 all（全部）；
                       基线 = 子包当前版本，区间内按包目录过滤日志；
                       changed 包附 reviewDocs: true 软提醒（核对包级约定文档）
  --apply              写入版本文件（根 / changed 子包）；缺省 dry-run 只输出
  --root <dir>         仓库根覆盖（测试注入）
  --help               显示本帮助

默认只输出目标版本（单包输出纯版本号，--pkg all 输出 JSON 清单）；不 commit、不 tag。
退出码：0 成功 / 1 一般错误 / 2 参数错误`)
}

/**
 * 递归发现 packages/ 下全部子包（排除 node_modules）。
 * ★ 适配点：非 npm 生态替换此函数为对应清单发现器（返回 {dir, name, version}[] 即可）。
 * @param {string} root 仓库根
 * @returns {{dir:string, name:string, version:string}[]} dir 为相对 root 的正斜杠路径（如 packages/tools/image）
 */
export function collectPackages(root) {
  // 单包仓库守卫：无 packages/ 目录时给出中文指引，而非 ENOENT 堆栈
  const packagesDir = resolve(root, 'packages')
  if (!existsSync(packagesDir)) {
    throw new Error('packages/ 目录不存在：单包仓库请跳过 --pkg 子包推算，仅执行根版本推算')
  }
  const pkgs = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const abs = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.name === 'package.json') {
        const rel = relative(root, abs).replaceAll('\\', '/')
        const pkg = JSON.parse(readFileSync(abs, 'utf-8'))
        pkgs.push({
          dir: rel.replace(/\/package\.json$/, ''),
          name: pkg.name ?? rel,
          version: pkg.version,
        })
      }
    }
  }
  walk(packagesDir)
  return pkgs.sort((a, b) => a.dir.localeCompare(b.dir))
}

/**
 * 根版本推算（可注入 root/from/to，便于测试）。
 * @param {string} root 仓库根
 * @param {{ from: string, to: string }} opts from 为 vx.y.z tag（exclusive）
 * @returns {Promise<string>} 目标版本
 */
export async function calculateRoot(root, { from, to }) {
  const messages = await logMessages(root, from, to, { noMerges: true })
  return calculateBump({ subjects: messages.map(m => m.subject), bodies: messages.map(m => m.body), currentVersion: from.replace(/^v/, '') })
}

/**
 * 子包逐包推算。
 * @param {string} root 仓库根
 * @param {{ from: string, to: string, filter: string }} opts filter 为 'all' 或具体包目录
 * @returns {Promise<{dir:string,name:string,current:string,target:string,changed:boolean,reviewDocs?:true}[]>}
 *   reviewDocs 仅 changed 包输出：软提醒发版 agent 核对包级约定文档是否过期
 */
export async function calculatePackages(root, { from, to, filter }) {
  const all = collectPackages(root)
  const pkgs = filter === 'all' ? all : all.filter(p => p.dir === filter)
  if (pkgs.length === 0) throw new Error(`未找到子包：${filter}（需为 packages/ 内目录或 all）`)
  const out = []
  for (const p of pkgs) {
    // 子包无独立 tag：基线 = 当前 version 字段；区间内仅该包目录的提交参与推算
    const messages = await logMessages(root, from, to, { noMerges: true, path: p.dir })
    const target = calculateBump({ subjects: messages.map(m => m.subject), bodies: messages.map(m => m.body), currentVersion: p.version })
    const changed = target !== p.version
    // 软提醒：版本发生 bump 的包，发版 agent 应核对包级约定文档是否过期（不阻塞）
    out.push({ dir: p.dir, name: p.name, current: p.version, target, changed, ...(changed ? { reviewDocs: true } : {}) })
  }
  return out
}

/**
 * 写入 package.json 的 version 字段（只改 version，复用源文件缩进，保持格式不漂移）。
 * ★ 适配点：非 npm 生态替换此写入器，保持"只改版本字段、最小 diff"原则。
 * @param {string} pkgJsonPath 绝对路径
 * @param {string} version 目标版本
 */
export function writePackageVersion(pkgJsonPath, version) {
  const raw = readFileSync(pkgJsonPath, 'utf-8')
  const obj = JSON.parse(raw)
  const indent = /^\n?(\s+)"(?:name|version)"/m.exec(raw)?.[1] ?? '  '
  obj.version = version
  writeFileSync(pkgJsonPath, `${JSON.stringify(obj, null, indent)}\n`, 'utf-8')
}

async function main() {
  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        pkg: { type: 'string' },
        apply: { type: 'boolean', default: false },
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
  const from = values.from ?? (await describeLatestTag(root))
  const to = values.to ?? 'HEAD'
  if (!/^v?\d+\.\d+\.\d+$/.test(from)) {
    throw new Error(`起始版本不是 vx.y.z tag：${from}（--from 需指向版本 tag）`)
  }

  if (values.pkg) {
    const results = await calculatePackages(root, { from, to, filter: values.pkg })
    if (values.apply) {
      for (const r of results) {
        if (r.changed) writePackageVersion(resolve(root, r.dir, 'package.json'), r.target)
      }
    }
    if (values.pkg === 'all') {
      console.log(formatJson(results))
    } else {
      console.log(results[0].target)
    }
    return
  }

  const target = await calculateRoot(root, { from, to })
  if (values.apply) {
    writePackageVersion(resolve(root, 'package.json'), target)
  }
  console.log(target)
}

// isMain 守卫：直调时执行 CLI；被 import（测试）时无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main().catch(e => {
    console.error(`错误：${e.message ?? String(e)}`)
    process.exit(1)
  })
}
