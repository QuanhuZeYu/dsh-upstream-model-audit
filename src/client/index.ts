/**
 * dsh-upstream-model-audit 的浏览器半。
 *
 * 两件事：注册一个自有的 Chat 节点 Definition（每个有差异的 step 一个节点，排在它的
 * assistant 消息之后），并给该 kind 注册渲染器。数据由 Definition 直接从客户端事件窗口
 * 里的 \`assistant/message\` 事件读取 —— 不经过 host，不新增事件类型，不写会话日志，
 * 不进入模型上下文，也不替换原生渲染器。
 *
 * @module dsh-upstream-model-audit/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { en, NS, zh, type UpstreamModelAuditKey } from './locales.ts'
import { installStyles } from './styles.ts'
import { STEP_AUDIT_KIND, upstreamModelAuditDefinition } from './step-definition.ts'
import { UpstreamModelAudit } from './UpstreamModelAudit.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 上游模型审计行的文案。 */
    'upstream-model-audit': UpstreamModelAuditKey
  }
}

/** 必需服务：slot 注册表、字典注册表，以及自有 Conversation Definition 的注册面。 */
export const inject = ['slots', 'locale', 'uiConversation']

/**
 * 客户端插件体。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'upstream-model-audit: dictionaries')
  ctx.effect(installStyles, 'upstream-model-audit: stylesheet')
  // 自有 Definition 随插件 fiber 卸载，不留残渣。
  ctx.effect(
    () => ctx.uiConversation.events.register(upstreamModelAuditDefinition),
    'upstream-model-audit: definition',
  )
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: STEP_AUDIT_KIND,
    locale: NS,
  }, UpstreamModelAudit))
}
