/**
 * 约定式提交版本推算：只计算，不写版本
 *
 * 识别 type(scope)!: 头部与 BREAKING CHANGE: 正文；
 * pre-1.0 保护（0.x.y 阶段 breaking 只 bump minor）；空区间与仅 docs/refactor 不变。
 * Phase 4 release/calculate-version 消费。
 */

const CONVENTIONAL_RE = /^(feat|fix|refactor|docs|test|chore|style|perf|build|ci)(\([^)]+\))?(!)?:\s/
const BREAKING_BODY_RE = /^BREAKING CHANGE:/m

/**
 * 分类单条提交。
 * @param {string} subject 提交标题
 * @param {string} [body] 提交正文（用于 BREAKING CHANGE: 检测）
 * @returns {{ type: string|null, breaking: boolean }}
 */
export function classifyCommit(subject, body = '') {
  const m = CONVENTIONAL_RE.exec(subject)
  if (!m) return { type: null, breaking: false }
  return { type: m[1], breaking: Boolean(m[3]) || BREAKING_BODY_RE.test(body) }
}

/**
 * 按提交区间推算目标版本。
 * @param {{ subjects: string[], bodies?: string[], currentVersion: string }} input
 *   subjects 按 git log 顺序（新→旧）；bodies 与 subjects 同序。
 * @returns {string} 目标版本；无变化时返回 currentVersion
 */
export function calculateBump({ subjects, bodies = [], currentVersion }) {
  if (subjects.length === 0) return currentVersion // 空区间不变

  const parts = currentVersion.split('.').map(Number)
  if (parts.length !== 3 || parts.some(p => !Number.isInteger(p))) {
    throw new Error(`无法解析版本号：${currentVersion}（需要 x.y.z 格式）`)
  }
  const [major, minor, patch] = parts

  let hasFeat = false
  let hasFix = false
  let hasBreaking = false
  for (let i = 0; i < subjects.length; i++) {
    const { type, breaking } = classifyCommit(subjects[i], bodies[i] ?? '')
    if (breaking) hasBreaking = true
    if (type === 'feat') hasFeat = true
    else if (type === 'fix') hasFix = true
  }

  if (hasBreaking) {
    // pre-1.0 保护：0.x.y 阶段 breaking → minor+1，不进入 1.0.0
    return major === 0 ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`
  }
  if (hasFeat) return `${major}.${minor + 1}.0`
  if (hasFix) return `${major}.${minor}.${patch + 1}`
  return currentVersion // 仅 docs/refactor/test/chore/style 等不变
}
