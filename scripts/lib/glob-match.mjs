/**
 * glob 模式 → 正则（verify.mjs 路径路由使用；纯函数，无顶层副作用）
 *
 * 与 lib/ref-check.mjs 的 glob 段匹配语义不同：本模块为全路径 glob（`**` 递归跨段、
 * 匹配完整相对路径）；ref-check 的 globSegmentToRegExp/globSegmentsMatch 为 D8 引用校验
 * （`*`、`?`、`[abc]` 均按段匹配、不跨段）。verify.mjs 只做编排，匹配逻辑下沉 lib 便于 node:test。
 * 支持的语法子集：
 *   ** 递归跨段 / * 单段通配 / ? 单字符 / 其余为字面量（含 . 转义）。
 * 匹配以 / 开头的规范化相对路径。
 */

/**
 * glob 模式 → 正则（匹配以 / 开头的路径）。
 * @param {string} pattern 规范化（/ 分隔）glob
 * @returns {RegExp}
 */
export function globToRegex(pattern) {
  let p = pattern
    .replace(/\./g, '\\.') // . → \.
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp('^/' + p + '$')
}
