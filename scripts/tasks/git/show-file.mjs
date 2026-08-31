#!/usr/bin/env node
/**
 * git/show-file — 提取指定提交中指定路径的文件内容（只读）
 *
 * 用法：
 *   node scripts/tasks/git/show-file.mjs --sha <commit> --path <path> [--json] [--max-bytes <n>]
 *
 * 用途：审查子 agent 对比重构/删除/移动的文件时，从历史提交提取单文件全文（git show <sha>:<path>）。
 * 只读边界：仅调用 git show，不修改工作树；二进制或超过 maxBytes 时抛中文错误。
 * 核心逻辑经 lib/git.mjs showFile 以参数数组执行，支持任意 ref（commit 哈希、分支、HEAD~N）。
 */

import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepoRoot } from '../../lib/repo-context.mjs'
import { showFile } from '../../lib/git.mjs'
import { formatJson } from '../../lib/output.mjs'

/**
 * 核心逻辑（可注入 root，便于 node:test）：提取文件内容并返回结构化结果。
 * @param {string} root 仓库根
 * @param {{ sha: string, path: string, maxBytes?: number }} opts
 * @returns {Promise<{ sha: string, path: string, bytes: number, content: string }>}
 */
export async function runShowFile(root, { sha, path, maxBytes }) {
  const content = await showFile(root, sha, path, maxBytes !== undefined ? { maxBytes } : {})
  return { sha, path, bytes: Buffer.byteLength(content, 'utf8'), content }
}

async function main() {
  const REPO_ROOT = resolveRepoRoot(import.meta.url)

  let values
  try {
    ;({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        sha: { type: 'string' },
        path: { type: 'string' },
        json: { type: 'boolean', default: false },
        'max-bytes': { type: 'string' },
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
    console.log(`git/show-file — 提取指定提交中指定路径的文件内容（只读）

用法：
  node scripts/tasks/git/show-file.mjs --sha <commit> --path <path> [--json] [--max-bytes <n>]

选项：
  --sha <commit>      提交引用（commit 哈希、分支名或 HEAD~N），必填
  --path <path>       仓库内文件路径（正斜杠），必填
  --json              输出结构化 JSON（含 bytes）
  --max-bytes <n>     内容大小上限（字节，默认 100KB）
  --help              显示本帮助

退出码：0 成功 / 1 一般错误 / 2 参数错误`)
    process.exit(0)
  }

  if (!values.sha || !values.path) {
    console.error('用法错误：--sha 与 --path 均必填')
    process.exit(2)
  }
  let maxBytes
  if (values['max-bytes'] !== undefined) {
    maxBytes = Number(values['max-bytes'])
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      console.error('用法错误：--max-bytes 应为正整数')
      process.exit(2)
    }
  }

  try {
    const result = await runShowFile(REPO_ROOT, {
      sha: values.sha,
      path: values.path,
      maxBytes,
    })
    if (values.json) {
      console.log(formatJson(result))
    } else {
      console.log(result.content)
    }
  } catch (e) {
    console.error(`错误：${e.message ?? String(e)}`)
    process.exit(1)
  }
}

// isMain 守卫：直调时执行 CLI；被 import（node:test）时仅暴露纯函数，无副作用
const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase()
if (isMain) {
  main()
}
