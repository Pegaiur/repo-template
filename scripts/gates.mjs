/**
 * 门禁命令清单配置（verify 引擎的唯一适配层）
 *
 * 设计（「单入口 + profile」模式）：
 *   - scripts/verify.mjs 是门禁执行引擎，只依赖本文件导出的清单，不含任何具体命令；
 *   - 所有调用方（AGENTS.md、skills、CI）只引用 `node scripts/verify.mjs <profile>`，
 *     不复制底层命令——换技术栈只改本文件；
 *   - 路由表或命令构成变化时，递增 lib/verify-profile.mjs 的 PROFILE_VERSION。
 *
 * ★ 适配新仓库时必改本文件：把命令换成你自己的 typecheck/test/lint/构建检查等。
 */

/** @typedef {{ id: string, label: string, command: string[] }} StepDef */
/** @typedef {{ id: string, label: string, globs: string[], steps: StepDef[] }} RouteGroup */

/**
 * merge profile 基础命令：始终执行，固定顺序，失败即停。
 * 典型组合：依赖一致性 → 类型检查 → 测试 → 文档一致性（doc-check）。
 * 包管理器不同则替换，例如：
 *   npm  : ['npm', 'run', 'typecheck']
 *   yarn : ['yarn', 'typecheck']
 *   cargo: ['cargo', 'check', '--all-targets']
 *   go   : ['go', 'build', './...']
 */
export const BASE_STEPS = [
  { id: 'deps-check', label: '依赖一致性', command: ['pnpm', 'run', 'verify:lockfile'] },
  { id: 'typecheck', label: '类型检查', command: ['pnpm', 'run', 'typecheck'] },
  { id: 'test', label: '测试', command: ['pnpm', 'run', 'test'] },
  // 文档一致性校验（plan checklist / ADR 索引 / 引用路径 / skills 结构），路径相对仓库根
  { id: 'doc-check', label: '文档一致性', command: ['node', 'scripts/doc-check.mjs'] },
]

/**
 * 路由组：变更文件命中 globs 时，merge profile 追加对应 steps（release profile 无条件全量）。
 * glob 语法：** 递归跨段 / * 单段通配 / ? 单字符，匹配仓库根相对路径。
 * 示例为前端单页应用场景，按仓库实际模块增删。
 */
export const ROUTE_GROUPS = [
  {
    id: 'frontend',
    label: '前端门禁',
    globs: [
      'apps/frontend/**',
      // 与前端行为相关的后端协议与共享类型投影（按仓库实际列出）
      'apps/backend/**',
      'packages/types/**',
      'docs/specs/frontend-contract.md',
    ],
    steps: [
      { id: 'lint', label: '前端 lint', command: ['pnpm', '--filter', '@repo/frontend', 'run', 'lint'] },
      { id: 'coverage', label: '前端覆盖率', command: ['pnpm', '--filter', '@repo/frontend', 'run', 'test:coverage'] },
      { id: 'e2e', label: '前端 E2E', command: ['pnpm', '--filter', '@repo/frontend', 'run', 'test:e2e'] },
    ],
  },
]

/**
 * 失败关闭（fail-closed）：变更落在以下前缀下但未命中任何路由组时，视为「未知跨模块路径」，
 * 追加 FAILOVER_ROUTE_IDS 的全量门禁——宁可多跑，不静默漏检。单仓无该需求时置空数组。
 */
export const FAILOVER_ROOTS = ['packages/']
export const FAILOVER_ROUTE_IDS = ['frontend']
