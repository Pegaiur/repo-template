/**
 * 仓库内开发工作区：dev-temp/runs|work|cache
 *
 * 生命周期：runs=完整中间结果（按任务/run-id 保留失败现场）；work=人工长期查看；
 *           cache=可重建缓存。三者均由 tmp clean --apply 显式清理。
 * 不替代应用 runtimeDir、Session output/.tmp 或测试 os.tmpdir()。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 开发工作区根：<root>/dev-temp */
export function getDevTmpRoot(root) {
  return join(root, 'dev-temp')
}

/** run 目录根：<root>/dev-temp/runs */
export function getRunDirRoot(root) {
  return join(getDevTmpRoot(root), 'runs')
}

/** 人工长期查看目录根：<root>/dev-temp/work */
export function getWorkDirRoot(root) {
  return join(getDevTmpRoot(root), 'work')
}

/** 缓存目录根：<root>/dev-temp/cache */
export function getCacheDirRoot(root) {
  return join(getDevTmpRoot(root), 'cache')
}

/**
 * 生成 run-id：时间戳 + PID + 随机后缀，避免并发冲突。
 * @returns {string}
 */
export function createRunId() {
  return `${Date.now()}-${process.pid}-${randomBytes(3).toString('hex')}`
}

/**
 * 创建 run 目录并返回路径。
 * @param {string} root 仓库根
 * @param {string} taskName 任务名（domain/name）
 * @param {{ runId?: string }} [opts] 自定义 run-id（默认 createRunId()）
 * @returns {string}
 */
export function createRunDir(root, taskName, { runId = createRunId() } = {}) {
  const dir = join(getRunDirRoot(root), taskName, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 获取人工长期查看目录（默认不自动创建）。
 * @param {string} root 仓库根
 * @param {string} topic 主题名
 * @param {{ ensure?: boolean }} [opts] ensure=true 时创建目录
 * @returns {string}
 */
export function getWorkDir(root, topic, { ensure = false } = {}) {
  const dir = join(getWorkDirRoot(root), topic)
  if (ensure) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 获取可重建缓存目录（默认不自动创建）。
 * @param {string} root 仓库根
 * @param {string} taskName 任务名
 * @param {{ ensure?: boolean }} [opts] ensure=true 时创建目录
 * @returns {string}
 */
export function getCacheDir(root, taskName, { ensure = false } = {}) {
  const dir = join(getCacheDirRoot(root), taskName)
  if (ensure) mkdirSync(dir, { recursive: true })
  return dir
}
