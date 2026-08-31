/**
 * 仓库上下文：从模块位置定位仓库根，提供路径内收检查
 *
 * 定位方式：从调用模块路径向上查找标志文件（默认 .git，泛语言通用；
 * monorepo 可传入 marker 如 pnpm-workspace.yaml / Cargo.toml 精确锚定），
 * 与调用者所在层级无关（scripts/、scripts/tasks/<domain>/、scripts/scratch/... 均可用）。
 * 测试可注入 root 直接覆盖推导。
 */

import { existsSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 从模块位置定位仓库根。
 * @param {string} moduleUrl 调用模块的 import.meta.url 或绝对路径
 * @param {{ marker?: string, root?: string }} [opts] marker：根标志文件（默认 .git）；root：注入仓库根（测试用）
 * @returns {string} 仓库根绝对路径
 * @throws 向上未找到 marker 时抛中文错误
 */
export function resolveRepoRoot(moduleUrl, { marker = '.git', root } = {}) {
  if (root) return resolve(root)
  if (typeof moduleUrl !== 'string') {
    throw new Error('resolveRepoRoot 需要 import.meta.url 或显式注入 root')
  }
  const start = moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : resolve(moduleUrl)
  let dir = dirname(start)
  for (;;) {
    if (existsSync(resolve(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) break // 已到文件系统根
    dir = parent
  }
  throw new Error(`无法定位仓库根：从 ${start} 向上未找到标志文件 ${marker}`)
}

/**
 * 路径内收检查：child 必须严格位于 parent 之内（等值视为越界）。
 * Windows 路径大小写不敏感由 path.relative 保证。
 * @param {string} parent 父目录绝对路径
 * @param {string} child 待校验路径
 * @returns {boolean}
 */
export function isPathInside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** tasks 目录根：<root>/scripts/tasks（scripts 平铺结构单点持有，tooling/ref-check/prepare 统一引用） */
export function tasksRoot(root) {
  return join(root, 'scripts', 'tasks')
}

/** scratch 目录根：<root>/scripts/scratch */
export function scratchRoot(root) {
  return join(root, 'scripts', 'scratch')
}
