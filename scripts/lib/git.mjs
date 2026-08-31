/**
 * 只读 Git 封装：HEAD / merge-base / diff 文件枚举 / logRange / 单文件提取 / 最近版本 tag
 *
 * 边界：不执行 add/commit/reset 等写操作；全部命令经 process.runCapture 以参数数组执行，
 * 不拼 shell 字符串。diff 文件枚举语义与 git diff --name-only 一致（工作区相对 HEAD）。
 */

import { runCapture } from './process.mjs'

function fail(command, r) {
  return new Error(`git ${command} 失败：${r.stderr.trim() || `退出码 ${r.code}`}`)
}

/** 当前 HEAD 提交哈希（完整 40 位）。@param {string} cwd 仓库目录 */
export async function head(cwd) {
  const r = await runCapture('git', ['rev-parse', 'HEAD'], { cwd })
  if (r.code !== 0) throw fail('rev-parse HEAD', r)
  return r.stdout.trim()
}

/**
 * 两提交的 merge-base。
 * @param {string} cwd 仓库目录
 * @param {string} a 提交 A
 * @param {string} b 提交 B
 * @returns {Promise<string>}
 */
export async function mergeBase(cwd, a, b) {
  const r = await runCapture('git', ['merge-base', a, b], { cwd })
  if (r.code !== 0) throw fail(`merge-base ${a} ${b}`, r)
  return r.stdout.trim()
}

/**
 * 枚举 diff 文件（name-only，去重排序）。
 * @param {string} cwd 仓库目录
 * @param {{ from?: string, to?: string, cached?: boolean, untracked?: boolean }} [opts]
 *   均省略 = 工作区 vs HEAD（显式 HEAD，避免 `git diff` 默认比较工作区 vs 索引）；
 *   仅 from = from..工作区；两者齐备 = from..to；cached = 索引 vs HEAD（from/to 可收窄）；
 *   untracked = 工作区模式（无 from/to/cached）时追加未跟踪文件（`git ls-files --others --exclude-standard`，
 *   排除 .gitignore 忽略项），用于门禁等需要「工作区全部变更（含新文件）」的场景。
 * @returns {Promise<string[]>}
 */
export async function diffFiles(cwd, { from, to, cached = false, untracked = false } = {}) {
  const args = ['diff', '--name-only']
  if (cached) args.push('--cached')
  if (from) args.push(from)
  if (to) args.push(to)
  if (!cached && !from && !to) args.push('HEAD')
  const r = await runCapture('git', args, { cwd })
  if (r.code !== 0) throw fail('diff --name-only', r)
  const files = new Set(r.stdout.split(/\r?\n/).filter(Boolean))
  if (untracked && !cached && !from && !to) {
    const u = await runCapture('git', ['ls-files', '--others', '--exclude-standard'], { cwd })
    if (u.code !== 0) throw fail('ls-files --others --exclude-standard', u)
    for (const f of u.stdout.split(/\r?\n/).filter(Boolean)) files.add(f)
  }
  return [...files].sort()
}

/**
 * 组装 git diff 参数（from/to 齐备时比较提交区间；均省略时显式 HEAD，比较工作区 vs HEAD）。
 * 从 tasks/git/head-diff.mjs 下沉，head-diff 的 --shortstat / --patch 与 diffFiles 共用同一套区间语义。
 * @param {string|undefined} from 起始提交
 * @param {string|undefined} to 结束提交
 * @param {string[]} [extra] 追加参数（如 ['--shortstat']、['--patch']）
 * @returns {string[]}
 */
export function buildDiffArgs(from, to, extra = []) {
  const args = ['diff', ...extra]
  if (from && to) args.push(from, to)
  else if (!from && !to) args.push('HEAD')
  return args
}

/**
 * 解析 git diff --shortstat 输出（空输出 = 无变更）。
 * @param {string} text shortstat 输出文本
 * @param {{ fallbackFiles?: number }} [opts] 无法解析时回退的文件数（默认 0）
 * @returns {{ filesChanged: number, insertions: number, deletions: number }}
 */
export function parseShortstat(text, { fallbackFiles = 0 } = {}) {
  const m = /(\d+)\s+files? changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/.exec(text.trim())
  if (!m) return { filesChanged: fallbackFiles, insertions: 0, deletions: 0 }
  return {
    filesChanged: Number(m[1]),
    insertions: Number(m[2] ?? 0),
    deletions: Number(m[3] ?? 0),
  }
}

/**
 * 读取提交区间 subject 行。
 * @param {string} cwd 仓库目录
 * @param {string} from 起始（exclusive）
 * @param {string} to 结束（inclusive）
 * @param {{ noMerges?: boolean }} [opts]
 * @returns {Promise<string[]>} 新→旧顺序的 subject 列表
 */
export async function logRange(cwd, from, to, { noMerges = false } = {}) {
  const args = ['log', '--format=%s']
  if (noMerges) args.push('--no-merges')
  args.push(`${from}..${to}`)
  const r = await runCapture('git', args, { cwd })
  if (r.code !== 0) throw fail(`log ${from}..${to}`, r)
  return r.stdout.split(/\r?\n/).filter(Boolean)
}

/**
 * 提交区间日志（subject + body 原子分隔解析）。
 * 记录以 \x1e 分隔、subject 与 body 以 \x1f 分隔（git --format 原子转义，不与消息内容冲突）。
 * @param {string} cwd 仓库根
 * @param {string} from 起始提交（exclusive）
 * @param {string} to 结束提交（inclusive）
 * @param {{ noMerges?: boolean, path?: string, hash?: boolean }} [opts] path 存在时按路径过滤
 *   （git log -- <path>，供子包版本推算）；hash=true 时附带短哈希（--abbrev=8，供 changelog 等追溯消费），
 *   返回记录多出 hash 字段；缺省不含（保持既有消费方返回形状不变）
 */
export async function logMessages(cwd, from, to, { noMerges = false, path, hash = false } = {}) {
  const args = ['log', `--format=%x1e${hash ? '%h%x1f' : ''}%s%x1f%b`]
  if (hash) args.push('--abbrev=8')
  if (noMerges) args.push('--no-merges')
  args.push(`${from}..${to}`)
  if (path) args.push('--', path)
  const r = await runCapture('git', args, { cwd })
  if (r.code !== 0) throw fail(`log ${from}..${to}`, r)
  return r.stdout
    .split('\x1e')
    .filter(Boolean)
    .map(rec => {
      const fields = rec.split('\x1f')
      const recHash = hash ? (fields.shift() ?? '').trim() : undefined
      const subject = (fields.shift() ?? '').trim()
      const body = fields.join('\x1f').trim()
      return hash ? { hash: recHash, subject, body } : { subject, body }
    })
}

/**
 * 提取指定提交中指定路径的文件内容（文本，只读）。
 * 语义与 `git show <sha>:<path>` 一致；支持任意 ref（commit 哈希、分支、HEAD~N 等）。
 * @param {string} cwd 仓库目录
 * @param {string} sha 提交引用（commit 哈希、分支名或 HEAD~N）
 * @param {string} path 仓库内文件路径（正斜杠）
 * @param {{ maxBytes?: number }} [opts] maxBytes：内容大小上限（字节），超过抛错；默认 100KB，参照仓库既有先例
 * @returns {Promise<string>} 文件文本内容
 * @throws 提交/路径无效、内容为二进制或超过 maxBytes 时抛中文错误
 */
export async function showFile(cwd, sha, path, { maxBytes = 100 * 1024 } = {}) {
  const r = await runCapture('git', ['show', `${sha}:${path}`], { cwd })
  if (r.code !== 0) {
    // git show 对无效 ref/路径统一报错，无法区分，统一提示两者
    throw new Error(`无法读取 ${sha}:${path}：${r.stderr.trim() || `退出码 ${r.code}`}`)
  }
  const content = r.stdout
  if (content.includes('\0')) {
    throw new Error(`git show ${sha}:${path} 是二进制文件，不支持文本提取`)
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw new Error(`git show ${sha}:${path} 超过 ${maxBytes} 字节上限，可通过 maxBytes 调大或改用 head-diff`)
  }
  return content
}

/**
 * 最近语义化版本 tag（git describe --tags --abbrev=0）。
 * @param {string} cwd 仓库目录
 * @returns {Promise<string>} tag 名（如 v1.34.0）
 */
export async function describeLatestTag(cwd) {
  const r = await runCapture('git', ['describe', '--tags', '--abbrev=0'], { cwd })
  if (r.code !== 0) throw fail('describe --tags --abbrev=0', r)
  return r.stdout.trim()
}
