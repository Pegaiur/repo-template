/**
 * 输出格式化与文件落位：text / JSON / TSV
 *
 * 落位约定：完整中间结果 → dev-temp/runs（runOutputPath）；人工长期查看 → dev-temp/work；
 * 由调用方显式选择，本模块不隐式写盘。
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getRunDirRoot } from './dev-workspace.mjs'

/** 文本输出：数组按行连接，标量转字符串。@param {string|string[]} lines */
export function formatText(lines) {
  if (Array.isArray(lines)) return lines.join('\n')
  return String(lines)
}

/**
 * JSON 输出：默认 pretty，紧凑模式用于管道。
 * @param {unknown} data
 * @param {{ pretty?: boolean }} [opts]
 */
export function formatJson(data, { pretty = true } = {}) {
  return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
}

/**
 * TSV 输出：首行表头（可选），单元格转义制表符/换行。
 * @param {object[]} rows
 * @param {{ header?: boolean }} [opts]
 */
export function formatTsv(rows, { header = true } = {}) {
  if (rows.length === 0) return ''
  const cols = Object.keys(rows[0])
  const escape = v => String(v).replace(/\t/g, '\\t').replace(/\n/g, '\\n')
  const lines = []
  if (header) lines.push(cols.map(escape).join('\t'))
  for (const row of rows) {
    lines.push(cols.map(c => escape(row[c] ?? '')).join('\t'))
  }
  return lines.join('\n')
}

/**
 * 写文件（目录不存在时创建），返回绝对路径。
 * @param {string} filePath
 * @param {string} content
 */
export function writeOutput(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

/**
 * dev-temp/runs 落位路径：<root>/dev-temp/runs/<task>/<runId>/<name>。
 * @param {string} root 仓库根
 * @param {string} taskName 任务名（domain/name）
 * @param {string} runId run-id
 * @param {string} name 文件名
 */
export function runOutputPath(root, taskName, runId, name) {
  return join(getRunDirRoot(root), taskName, runId, name)
}
