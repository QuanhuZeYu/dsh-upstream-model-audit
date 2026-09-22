/**
 * 一条 assistant 消息下方的上游模型审计行。
 *
 * 数据来自节点载荷（Definition 已从事件里提炼好），组件本身不读任何其它状态：
 * 不写会话日志、不影响模型上下文。
 *
 * @module dsh-upstream-model-audit/client/UpstreamModelAudit
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from './step-definition.ts'
import { CLS } from './styles.ts'
import { NS } from './locales.ts'

/** 完整 props：节点载荷来自 keyed slot owner。 */
export type UpstreamModelAuditProps =
  PropsRuntime<'conversation.chat.node', 'upstream-model-audit'> & PropsLocale<typeof NS>

/**
 * 渲染本 step 的审计行。
 * @param props - slot 提供的节点与文案。
 * @returns 审计行。
 */
export function UpstreamModelAudit({ node, t }: UpstreamModelAuditProps) {
  const { turn, step, requested, reported, mark } = node.data
  return (
    <div
      className={CLS + '-row'}
      aria-label={t('row.aria', {
        turn: String(turn + 1),
        step: String(step + 1),
        requested,
        reported,
      })}
    >
      <span className={CLS + '-label'}>{t('row.label')}</span>
      <span className={CLS + '-to'}>{reported}</span>
      <span className={CLS + '-meta'}>
        {t('row.meta', {
          requested,
          mark: t(mark === 'prefixed' ? 'mark.prefixed' : 'mark.different'),
        })}
      </span>
    </div>
  )
}
