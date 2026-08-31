/**
 * 脚本引用路径检查（doc-check D4 核心逻辑，纯函数无顶层副作用）
 *
 * 只检查"当前可执行引用"：
 *   - package scripts（根 package.json 中的 node 命令）
 *   - 源码静态 import（scripts/** 下 .mjs 的相对 import）
 *   - 明确 spawn 字符串（rules/templates 与 package scripts 中的 node 命令、反引号路径）
 *   - 当前 rules/templates（docs/rules、docs/templates 中的脚本引用）
 *
 * 解析规则：
 *   - 相对路径按引用文件所在目录解析；
 *   - glob 引用（如 scripts/__tests__/*.test.mjs）需至少一个条目匹配（支持 *、?、[abc]）；
 *   - 豁免：dev-temp/**、scripts/scratch/**、node_modules；
 *   - 排除源：docs/adr/**（ADR 叙述）、docs/ 其余文档（非当前可执行引用）；
 *   - tasks 由 tooling 目录发现自检，D4 只轻校验引用中 domain/name 路径可规范化。
 *
 * 扩展点：monorepo 需要校验子包 package.json scripts 时，在 collectSources 中按
 * 子包清单文件（package.json / Cargo.toml / pyproject.toml）扩展 pushPackageScripts。
 *
 * 已知局限（词法分析边界）：
 *   - 字符串字面量内的 `from '...'` 会被提取（不感知字符串上下文）；
 *   - JS 正则字面量中的 `/*` 序列可能被误判为块注释起始并截断该行（`\/` 转义形态安全）；
 *   - 不识别模板字符串插值拼接的运行时路径（非字面量，本就不在静态引用面）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { normalizeTaskRef } from './task-ref.mjs'
import { isPathInside, tasksRoot } from './repo-context.mjs'

/** node 命令引用：node [flags] [引号]<path>.mjs[引号]（支持 --flag、--flag=value、引号包裹路径与 glob） */
const NODE_CMD_RE = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*["']?([^\s;&|"'`]+\.mjs)["']?\b/g
/** markdown 反引号内路径引用：`scripts/xxx.mjs` */
const BACKTICK_RE = /`([\w./\\-]+\.mjs)`/g
/** 静态 import：from './x.mjs' */
const IMPORT_FROM_RE = /\bfrom\s*['"]([^'"]+\.mjs)['"]/g
/** side-effect import：import './x.mjs' */
const IMPORT_SIDE_RE = /\bimport\s*['"]([^'"]+\.mjs)['"]/g

/**
 * 行注释与块注释剥离（状态机，跨行块注释由调用方复用同一实例）。
 * 保护引号内内容（字符串/模板中的路径不被误删）。
 * 块注释闭合后继续扫描剩余段，因此「块注释后同行仍含行注释」时行注释仍被剥离。
 * @returns {(line:string)=>string} 剥离注释后的行
 */
export function createCommentStripper() {
  let inBlock = false
  return (line) => {
    let out = ''
    let rest = line
    if (inBlock) {
      const end = rest.indexOf('*/')
      if (end < 0) return ''
      inBlock = false
      rest = rest.slice(end + 2)
    }
    let inStr = null
    let i = 0
    while (i < rest.length - 1) {
      const c = rest[i]
      if (inStr) {
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === inStr) inStr = null
        i++
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        inStr = c
        i++
        continue
      }
      if (c === '/' && rest[i + 1] === '*') {
        const end = rest.indexOf('*/', i + 2)
        if (end < 0) {
          inBlock = true
          return out + rest.slice(0, i)
        }
        // 块注释闭合后从 end+2 继续扫描剩余段（可能还有行注释/另一块注释）
        out += rest.slice(0, i) + ' '
        rest = rest.slice(end + 2)
        i = 0
        continue
      }
      if (c === '/' && rest[i + 1] === '/') return out + rest.slice(0, i)
      i++
    }
    return out + rest
  }
}

/**
 * 从单行文本提取脚本路径引用（去重保留首个）。
 * @param {string} line 已剥离注释的行
 * @param {'package-json'|'mjs'|'md'} sourceType 来源类型
 * @returns {string[]} 提取到的 .mjs 相对路径引用
 */
export function extractRefsFromLine(line, sourceType) {
  const refs = []
  const push = (m) => {
    const ref = m[1].trim()
    if (ref && !refs.includes(ref)) refs.push(ref)
  }

  if (sourceType === 'mjs') {
    for (const m of line.matchAll(IMPORT_FROM_RE)) push(m)
    for (const m of line.matchAll(IMPORT_SIDE_RE)) push(m)
    return refs
  }

  // package-json / md：node 命令 + 反引号路径
  NODE_CMD_RE.lastIndex = 0
  for (const m of line.matchAll(NODE_CMD_RE)) push(m)
  if (sourceType !== 'package-json') {
    BACKTICK_RE.lastIndex = 0
    for (const m of line.matchAll(BACKTICK_RE)) push(m)
  }
  return refs
}

/**
 * glob 字符检测（* ? [）：含通配符的引用需实际匹配至少一个条目，而非仅前缀目录存在。
 * @param {string} ref 提取到的引用
 * @returns {boolean}
 */
function hasGlob(ref) {
  return /[*?[]/.test(ref)
}

/**
 * 将 glob 段（不含路径分隔符）编译为正则。
 * 支持：* 任意非分隔符序列；? 单个非分隔符字符；[abc] / [!abc] 字符类。
 * @param {string} segment glob 段，如 "*.test.mjs" 或 "b?.mjs"
 * @returns {RegExp} 全匹配锚定（^...$）
 */
function globSegmentToRegExp(segment) {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === '*') {
      out += '[^/\\\\]*'
    } else if (c === '?') {
      out += '[^/\\\\]'
    } else if (c === '[') {
      const end = segment.indexOf(']', i + 1)
      if (end < 0) {
        out += '\\['
        continue
      }
      let cls = segment.slice(i + 1, end)
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      out += '[' + cls.replace(/([\\\]])/g, '\\$1') + ']'
      i = end
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * 递归 glob 段匹配：dir 下是否存在命中 segments 序列的条目。
 * 与 lib/glob-match.mjs 的 globToRegex 语义不同：本函数按段匹配（*、?、[abc] 均不跨段），
 * 供 D4 引用存在性检查使用；glob-match 是全路径 glob（支持 **）。
 * @param {string} dir 当前搜索目录（绝对路径）
 * @param {string[]} segments 自第一个含通配符段起的剩余段
 * @returns {boolean}
 */
function globSegmentsMatch(dir, segments) {
  if (!existsSync(dir)) return false
  if (segments.length === 0) return true
  const [seg, ...rest] = segments
  const re = globSegmentToRegExp(seg)
  if (rest.length === 0) {
    return readdirSync(dir, { withFileTypes: true }).some(e => re.test(e.name))
  }
  return readdirSync(dir, { withFileTypes: true }).some(
    e => e.isDirectory() && re.test(e.name) && globSegmentsMatch(resolve(dir, e.name), rest),
  )
}

/**
 * glob 引用匹配：定位第一个含通配符的段，其前静态段构成搜索根，逐段匹配至文件/目录。
 * 至少一个条目命中才返回 true（零匹配视为无效引用）。
 * @param {string} ref glob 引用（如 scripts/__tests__/*.test.mjs）
 * @param {string} baseDir 引用文件所在目录
 * @returns {boolean}
 */
function globMatchesFromRef(ref, baseDir) {
  const norm = ref.replace(/\\/g, '/')
  const parts = norm.split('/')
  const idx = parts.findIndex(p => /[*?[]/.test(p))
  if (idx < 0) return false
  const base = parts.slice(0, idx).join('/')
  return globSegmentsMatch(base ? resolve(baseDir, base) : baseDir, parts.slice(idx))
}

/**
 * 解析引用为绝对路径。
 * @param {string} ref 相对路径引用（含 ./ ../ 或 scripts/ 前缀或裸文件名）
 * @param {string} baseDir 引用文件所在目录
 * @param {string} root 仓库根（裸文件名优先从 scripts/ 解析）
 * @returns {string|null} 绝对路径；含 node_modules / 疑似 URL 时返回 null（不检查）
 */
export function resolveRef(ref, baseDir, root) {
  const norm = ref.replace(/\\/g, '/')
  if (norm.includes('node_modules')) return null
  if (/^[a-z]+:\/\//i.test(norm)) return null
  // 裸文件名（无路径分隔符）优先从仓库 scripts/ 解析（仓库脚本惯例，如 `diag-db.mjs`）。
  // 注意：若引用方本意是引用同目录裸文件而 root/scripts/ 恰好存在同名文件，会命中仓库脚本——
  // 这是"裸名 = 仓库 scripts 惯例"的既定取舍，局部裸名引用应写相对路径（./x.mjs）明确归属。
  if (!norm.includes('/')) {
    const fromScripts = resolve(root, 'scripts', norm)
    if (existsSync(fromScripts)) return fromScripts
    return resolve(baseDir, norm)
  }
  return resolve(baseDir, norm)
}

/**
 * 豁免判定：dev-temp/**、scripts/scratch/** 内引用不检查（可清理/本地临时产物）。
 * 路径前缀大小写不敏感（Windows 文件系统语义）。
 * @param {string} resolved 绝对路径
 * @param {string} root 仓库根
 * @returns {boolean}
 */
export function isExempt(resolved, root) {
  const rel = relative(root, resolved).replace(/\\/g, '/').toLowerCase()
  return rel.startsWith('dev-temp/') || rel.startsWith('scripts/scratch/') || rel.includes('node_modules')
}

/** @typedef {{file:string,rel:string,baseDir:string,sourceType:'package-json'|'mjs'|'md',content?:string}} RefSource */

/** 收集扫描源：根 package.json scripts、scripts/**\/*.mjs、docs/rules、docs/templates */
export function collectSources(root) {
  /** @type {RefSource[]} */
  const sources = []

  const pushPackageScripts = (pkgDir) => {
    const pkgFile = join(pkgDir, 'package.json')
    if (!existsSync(pkgFile)) return
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
    } catch {
      return
    }
    const scripts = pkg.scripts
    if (!scripts || typeof scripts !== 'object') return
    // 每个 script 值独立为源并携带 key：报错时以 `scripts.<key>` 定位，而非合成文本行号
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value !== 'string') continue
      sources.push({
        file: pkgFile,
        rel: relative(root, pkgFile).replace(/\\/g, '/'),
        baseDir: pkgDir,
        sourceType: 'package-json',
        label: `scripts.${key}`,
        content: value,
      })
    }
  }

  pushPackageScripts(root)
  // monorepo 扩展点：在此按子包清单文件递归 pushPackageScripts（参考 packages/<scope>/<dir> 结构）

  const walkMjs = (dir) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      // scratch 豁免（本地临时）；__tests__ 排除（夹具引用由测试运行时兜底，非可执行引用面）
      if (e.name === 'scratch' || e.name === '__tests__') continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        walkMjs(full)
      } else if (e.isFile() && e.name.endsWith('.mjs')) {
        sources.push({
          file: full,
          rel: relative(root, full).replace(/\\/g, '/'),
          baseDir: dir,
          sourceType: 'mjs',
        })
      }
    }
  }
  walkMjs(join(root, 'scripts'))

  for (const sub of ['docs/rules', 'docs/templates']) {
    const dir = join(root, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      sources.push({ file: join(dir, f), rel: `${sub}/${f}`, baseDir: root, sourceType: 'md' })
    }
  }

  return sources
}

/**
 * 主检查：收集全部 D4 问题。
 * @param {string} root 仓库根
 * @returns {{severity:'error',file:string,line:number,message:string}[]}
 */
export function collectRefIssues(root) {
  const issues = []

  for (const src of collectSources(root)) {
    const content = src.content ?? readFileSync(src.file, 'utf-8')
    const stripper = createCommentStripper()
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = src.sourceType === 'mjs' ? stripper(lines[i]) : lines[i]
      for (const ref of extractRefsFromLine(line, src.sourceType)) {
        const resolved = resolveRef(ref, src.baseDir, root)
        if (!resolved) continue
        if (isExempt(resolved, root)) continue

        // tasks 轻校验：scripts/tasks/<domain>/<name> 引用必须可规范化（tasks 根经 repo-context 单点持有）
        const relPath = relative(root, resolved).replace(/\\/g, '/')
        if (isPathInside(tasksRoot(root), resolved) && relPath.endsWith('.mjs')) {
          const taskRef = relative(tasksRoot(root), resolved).replace(/\\/g, '/').replace(/\.mjs$/, '')
          if (!normalizeTaskRef(taskRef)) {
            const loc = src.label ? `${src.rel} ${src.label}` : `${src.rel}:${i + 1}`
            issues.push({
              severity: 'error',
              file: loc,
              line: i + 1,
              message: `task 路径不可规范化: ${relPath}`,
            })
            continue
          }
        }

        // glob 引用：至少一个条目匹配才视为有效（如 scripts/__tests__/*.test.mjs 需存在匹配文件）
        if (hasGlob(ref) && globMatchesFromRef(ref, src.baseDir)) continue

        if (!existsSync(resolved)) {
          // package-json 源以脚本 key 定位（合成文本行号无意义）；其余源以文件:行定位
          const loc = src.label ? `${src.rel} ${src.label}` : `${src.rel}:${i + 1}`
          issues.push({
            severity: 'error',
            file: loc,
            line: i + 1,
            message: `引用不存在的脚本: ${ref} → ${relative(root, resolved).replace(/\\/g, '/')}`,
          })
        }
      }
    }
  }

  return issues
}
