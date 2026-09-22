/**
 * dsh-upstream-model-audit 的 node 半。
 *
 * 本插件不需要任何 host 行为：浏览器半直接从 durable 的 \`assistant/message\`
 * 事件（客户端拿到的是完整 SessionEvent，含 \`message.source.replayState\`）里读上游
 * 声明的模型名，因此没有投影、没有额外传输、没有会话日志写入。
 *
 * 这个空 apply 只是 Loader 需要的一行 fiber，让本包的组合层 patch 生效。
 *
 * @module dsh-upstream-model-audit
 */

/** node 半插件体：无 host 行为。 */
export function apply(): void {}
