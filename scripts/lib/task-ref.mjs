/**
 * 任务引用规范化（tasks 目录发现唯一注册事实，domain/name 轻校验；设计源自 Concliude ADR-099）
 *
 * tooling.mjs 与 doc-check D4（lib/ref-check.mjs）共用；tooling 以 re-export 保持 API 稳定，
 * ref-check 直接从 lib 导入，避免 lib → 根级 CLI 层次倒挂。
 */

/**
 * 归一化 domain/name 引用：统一分隔符、剥离 .mjs 后缀、拒绝穿越路径。
 * @param {string} ref 原始引用，如 "git/head-diff" 或 "perf/load-run.mjs"
 * @returns {string|null} 规范化后的 "domain/name"；非法时返回 null
 */
export function normalizeTaskRef(ref) {
  if (typeof ref !== 'string') return null
  const clean = ref.replace(/\\/g, '/').replace(/\.mjs$/i, '')
  if (clean === '' || clean.startsWith('/') || clean.startsWith('.')) return null
  const parts = clean.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null
  return parts.join('/')
}
