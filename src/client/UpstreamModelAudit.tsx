/**
 * 一条 assistant 消息下方的上游模型审计行。
 *
 * 数据来自节点载荷（Definition 已从事件里提炼好），组件本身不读任何其它状态：
 * 不写会话日志、不影响模型上下文。主行是"上游返回什么 / 请求了什么 / 差异形态"，
 * 附加行只在 host 半旁路观察到额外事实时出现（实际发出的模型名、服务档位、
 * 上游自相矛盾的多个声明）——照实列出，不判严重性。
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
  const { turn, step, requested, reported, mark, sentModel, serviceTier, variants } = node.data
  const details: string[] = []
  if (sentModel !== undefined && sentModel !== requested) details.push(t('audit.sent', { model: sentModel }))
  if (serviceTier !== undefined) details.push(t('audit.tier', { tier: serviceTier }))
  if (variants !== undefined && variants.length > 1) details.push(t('audit.variants', { list: variants.join('、') }))
  const meta = t('row.meta', {
    requested,
    mark: t(mark === 'prefixed' ? 'mark.prefixed' : 'mark.different'),
  })
  const aria = t('row.aria', {
    turn: String(turn + 1),
    step: String(step + 1),
    requested,
    reported,
  }) + (details.length > 0 ? '；' + details.join('；') : '')
  return (
    <div className={CLS + '-row'} aria-label={aria}>
      <span className={CLS + '-label'}>{t('row.label')}</span>
      <span className={CLS + '-to'}>{reported}</span>
      <span className={CLS + '-meta'}>{meta}</span>
      {details.length > 0 ? <span className={CLS + '-audit'}>{details.join(' · ')}</span> : null}
    </div>
  )
}
