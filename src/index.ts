/**
 * dsh-upstream-model-audit 的 node 半。
 *
 * 浏览器半直接从 durable 的 `assistant/message` 事件里读上游声明的模型名；node 半负责
 * **把缺失的声明补上**：pi-ai 与自研适配器只在部分通道写 `replayState.response.responseModel`，
 * 这里用 fetch 旁路观察 + `llm/stream` 中间件补写，写进去的值仍由 DSH 自己持久化，
 * 浏览器半无需改动。
 *
 * 观察点完全旁路：不改请求、不改响应、只在字段缺失时补写、任何异常都静默降级。
 *
 * @module dsh-upstream-model-audit
 */

import type { Context } from '@deepseek-ai/cordis'
import { installUpstreamAudit } from './host.ts'

/**
 * 装载 host 半：注册 `llm/stream` 中间件与 fetch 旁路观察，随插件卸载一起拆除。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => installUpstreamAudit(ctx))
}
