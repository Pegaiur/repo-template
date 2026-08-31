/**
 * 子进程执行基元：runCapture / runStreaming / resolveCommandPrefix
 *
 * 统一约定（Windows 兼容）：
 *   - 参数数组，不拼 shell 字符串；
 *   - windowsHide: true 隐藏子进程窗口；
 *   - 显式 env 注入（合并 process.env）；
 *   - 返回退出码（捕获模式附带 stdout/stderr），spawn 失败抛中文错误；
 *   - 非零退出码不抛错——由调用者按业务决定。
 */

import { spawn } from 'node:child_process'

/** 合并显式 env：undefined 表示继承父进程环境 */
function mergeEnv(env) {
  return env ? { ...process.env, ...env } : undefined
}

/**
 * 捕获式执行：收集 stdout/stderr，返回 { code, stdout, stderr }。
 * @param {string} command 可执行文件（如 node / git）
 * @param {string[]} args 参数数组
 * @param {{ env?: object, cwd?: string, input?: string, onStdout?: (chunk:string) => void, onStderr?: (chunk:string) => void }} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runCapture(command, args, { env, cwd, input, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: mergeEnv(env),
      windowsHide: true,
      stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      onStdout?.(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
      onStderr?.(chunk)
    })
    child.on('error', err => reject(new Error(`无法启动进程 ${command}：${err.message}`)))
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    if (input !== undefined) {
      // 子进程提前退出时管道已关闭，忽略 EPIPE 避免未处理事件
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/**
 * 平台命令前缀解析：Windows 下 npm 系 CLI（pnpm/npm/yarn/npx 等）是 .cmd 垫片，
 * spawn 不能直接执行，须经 cmd /c 包装（仍是参数数组，不拼 shell 字符串）；
 * 其它命令（node/git/python 等）原样执行。非 Windows 平台一律原样。
 * verify 门禁等消费方统一引用，避免平台适配分散。
 * @param {string} cmd 命令名（如 pnpm / npm / git）
 * @returns {string[]} 前缀 argv（win32 且为 .cmd 垫片: [ComSpec, /d, /c, xxx.cmd]；否则: [cmd]）
 */
export function resolveCommandPrefix(cmd) {
  if (process.platform !== 'win32') return [cmd]
  if (/^(pnpm|npm|yarn|npx|pnpx)$/i.test(cmd)) {
    return [process.env.ComSpec ?? 'cmd.exe', '/d', '/c', `${cmd.toLowerCase()}.cmd`]
  }
  return [cmd]
}

/**
 * 流式执行：继承父进程 stdio，返回退出码（交互式任务实时输出）。
 * @param {string} command 可执行文件（如 node / git）
 * @param {string[]} args 参数数组
 * @param {{ env?: object, cwd?: string }} [opts]
 * @returns {Promise<number>}
 */
export function runStreaming(command, args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: mergeEnv(env),
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', err => reject(new Error(`无法启动进程 ${command}：${err.message}`)))
    child.on('close', code => resolve(code ?? 1))
  })
}
