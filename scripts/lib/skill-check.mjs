/**
 * skills/ 技能结构校验（plan-repository-commit-release-skills Phase 3）
 *
 * 单点归属：doc-check 的 S 检查唯一消费本实现；SKILL.md 契约（name/description）
 * 与 docs/rules frontmatter 契约不同，各自解析，不混用。
 *
 * 检查项：
 *   S1 目录结构：skills/ 下每个子目录必须含 SKILL.md；SKILL.md 不允许直接置于 skills/ 根
 *   S2 frontmatter：YAML name / description 必须存在且非空
 *   S3 名称一致性：YAML name === 目录名 === 正文 H1 标题
 *   S4 相对引用存在性：反引号内 docs|scripts|skills|packages 前缀的相对路径须存在
 *      （含 glob 通配或 <> 占位符的运行时产物引用跳过）
 *   S5 禁用宿主专属继承措辞：不得出现 .trae/skills、沿用全局技能、
 *      肯定式「依赖名为 solution-evaluator」（commit-convention 的「不依赖名为 …」
 *      否定表述属正确示范，不命中）
 *
 * 零依赖：仅解析本契约用到的字段子集，不引入完整 YAML 解析器。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 宿主专属继承措辞（肯定式依赖，排除否定表述） */
const HOST_SPECIFIC_PATTERNS = [
  { pattern: /\.trae\/skills/, reason: '宿主专属技能目录' },
  { pattern: /沿用全局技能/, reason: '用户级技能继承' },
  { pattern: /(?<!不)依赖名为\s*`?solution-evaluator/, reason: '私有 subagent type 依赖' },
]

/**
 * 解析 SKILL.md YAML frontmatter（仅 name/description）。
 * @param {string} content SKILL.md 全文（utf-8）
 * @returns {{name:string, description:string}|null} 无 frontmatter 时返回 null
 */
export function parseSkillFrontmatter(content) {
  const text = String(content).replace(/^\uFEFF/, '').trimStart()
  if (!text.startsWith('---')) return null

  // frontmatter 闭合：首个行首 `---`（排除开头的 `---` 本身）
  const endIdx = text.indexOf('\n---', 3)
  if (endIdx === -1) return null
  const fmText = text.slice(3, endIdx)

  /** @type {Record<string, string>} */
  const fm = {}
  for (const line of fmText.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const rawVal = line.slice(colonIdx + 1).trim()
    fm[key] = rawVal.replace(/^["']|["']$/g, '').trim()
  }

  return { name: fm.name ?? '', description: fm.description ?? '' }
}

/**
 * 校验 skills/ 目录结构（纯逻辑，接受注入 root）。
 * @param {string} root 仓库根
 * @returns {{ errors: {check:string,message:string}[], warnings: {check:string,message:string}[] }}
 */
export function checkSkillStructure(root) {
  const errors = []
  const warnings = []
  const skillsDir = join(root, 'skills')
  // 无 skills/ 目录不视为违规（容忍仓库尚未启用 repo skill）
  if (!existsSync(skillsDir)) return { errors, warnings }

  const entries = readdirSync(skillsDir, { withFileTypes: true })

  // S1：SKILL.md 不允许直接置于 skills/ 根，必须位于 skills/<skill-name>/ 子目录
  for (const e of entries) {
    if (e.isFile() && e.name === 'SKILL.md') {
      errors.push({ check: 'S1', message: `skills/SKILL.md 不允许直接置于 skills/ 根，需位于 skills/<skill-name>/ 子目录` })
    }
  }

  for (const dir of entries.filter(e => e.isDirectory())) {
    const skillPath = join(skillsDir, dir.name, 'SKILL.md')
    if (!existsSync(skillPath)) {
      errors.push({ check: 'S1', message: `skills/${dir.name}/ 缺少 SKILL.md` })
      continue
    }

    const content = readFileSync(skillPath, 'utf-8')
    const fm = parseSkillFrontmatter(content)
    if (!fm) {
      errors.push({ check: 'S2', message: `skills/${dir.name}/SKILL.md 缺少 YAML frontmatter（--- 包裹的 name/description）` })
      continue
    }

    // S2：name / description 必填
    if (!fm.name || !fm.description) {
      errors.push({ check: 'S2', message: `skills/${dir.name}/SKILL.md frontmatter 缺少 name 或 description` })
    }

    // S3：名称一致性（YAML name === 目录名 === H1 标题）
    if (fm.name !== dir.name) {
      errors.push({ check: 'S3', message: `skills/${dir.name}/SKILL.md YAML name 与目录名不一致：name="${fm.name}" 目录="${dir.name}"` })
    }
    const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
    if (h1 && h1 !== dir.name) {
      errors.push({ check: 'S3', message: `skills/${dir.name}/SKILL.md H1 标题与目录名不一致：H1="${h1}" 目录="${dir.name}"` })
    }

    // S4：相对引用存在性（跳过 glob 通配与 <> 占位符等运行时产物）
    for (const m of content.matchAll(/`((?:docs|scripts|skills|packages)\/[^`\s]+)`/g)) {
      const ref = m[1]
      if (/[*?<>]/.test(ref)) continue
      if (!existsSync(resolve(root, ref))) {
        errors.push({ check: 'S4', message: `skills/${dir.name}/SKILL.md 引用了不存在的路径：${ref}` })
      }
    }

    // S5：禁用宿主专属继承措辞
    for (const { pattern, reason } of HOST_SPECIFIC_PATTERNS) {
      if (pattern.test(content)) {
        errors.push({ check: 'S5', message: `skills/${dir.name}/SKILL.md 含${reason}措辞（${pattern}）` })
      }
    }
  }

  return { errors, warnings }
}
