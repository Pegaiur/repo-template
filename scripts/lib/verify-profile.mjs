/**
 * verify 门禁 profile 版本事实源（单入口 + profile 模式）
 *
 * 路由表（gates.mjs）或命令构成变化时递增（verify.mjs 注释约定）；被 verify（门禁执行、
 * 结构化结果携带）与部署等下游复用方（比对 profileVersion）消费。
 * 独立成模块，避免「门禁入口 verify.mjs 被部署脚本 import」的角色混淆。
 */
export const PROFILE_VERSION = '1.0.0'
