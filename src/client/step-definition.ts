/**
 * 本插件在 Chat 视图里自有的 Conversation Definition。
 *
 * 每个 step（一次模型调用）产出一个自己的节点，节点紧跟该 step 的
 * \`assistant/message\` 之后（anchorSeq = 消息 seq + 0.01）；**只有存在可呈现的差异时
 * 才产出节点**，因此没有差异的步什么都不显示。
 *
 * 数据直接从事件读（客户端事件窗口里是完整的 SessionEvent），不经过 host 投影。
 * 这是 DSH 公开的 Conversation Definition 注册面（ui-goal / ui-tool / ui-workflow-run
 * 用的是同一机制），不替换任何原生渲染器。
 *
 * @module dsh-upstream-model-audit/client/step-definition
 */

import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { auditOf, type UpstreamModelAudit } from '../marks.ts'

/** 本插件节点的 kind，同时用作 \`conversation.chat.node\` 的注册 key。 */
export const STEP_AUDIT_KIND = 'upstream-model-audit'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** 上游模型审计行：每个有差异的 step 一条。 */
    'upstream-model-audit': UpstreamModelAudit
  }
}

/** Definition 内部状态：位置、消息 seq，以及该步的审计事实。 */
interface StepAuditState {
  readonly turn: number
  readonly step: number
  /** 该 step 的 assistant/message 事件 seq；-1 表示尚未落定。 */
  readonly seq: number
  /** 有差异时的记录；null 表示这一步不需要显示。 */
  readonly audit: UpstreamModelAudit | null
}

/** 从事件载荷里读 turn/step，读不到就不认这个事件。 */
function positionOf(event: { data?: unknown }): { turn: number; step: number } | null {
  const data = event.data as { turn?: unknown; step?: unknown } | undefined
  if (data === undefined || data === null) return null
  return typeof data.turn === 'number' && typeof data.step === 'number'
    ? { turn: data.turn, step: data.step }
    : null
}

/** 每个有差异的 step 一条审计节点，排在它的 assistant 消息之后。 */
export const upstreamModelAuditDefinition: ConversationNodeDefinition<StepAuditState> = {
  kind: STEP_AUDIT_KIND,
  target: 'chat',
  match: (event) => {
    if (event.type === 'step/start' || event.type === 'assistant/message') {
      const position = positionOf(event)
      if (position === null) return null
      const id = position.turn + ':' + position.step
      return { id, role: event.type === 'step/start' ? 'start' : 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'step/start') {
      throw new Error('upstream-model-audit start requires step/start')
    }
    return {
      turn: match.event.data.turn,
      step: match.event.data.step,
      seq: -1,
      audit: null,
    }
  },
  update: (context, match) => {
    if (match.event.type !== 'assistant/message') return context.state
    return {
      ...context.state,
      seq: match.event.seq,
      audit: auditOf(match.event as SessionEvent),
    }
  },
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined || state.seq < 0 || state.audit === null) return null
    const tail = context.matches.at(-1)
    return {
      key: context.key,
      kind: STEP_AUDIT_KIND,
      id: context.id,
      target: 'chat',
      // 紧跟产生它的 assistant/message。
      anchorSeq: state.seq + 0.01,
      location: tail?.location ?? context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: state.audit,
    }
  },
}
