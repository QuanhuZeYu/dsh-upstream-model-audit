/**
 * 上游模型审计的客户端判定逻辑（零依赖、可单测）。
 *
 * 事实来源是 durable 的 `assistant/message` 事件，客户端与 host 都能拿到同一份：
 *   - `message.source.model` —— 实际发往 provider 的模型名；
 *   - `message.source.replayState.response.responseModel` —— 上游响应声明的模型名；
 *   - `message.source.replayState.response.upstreamAudit` —— host 半旁路观察到的事实
 *     （实际发出的模型名、服务档位、上游自相矛盾的多个声明）。
 *
 * 本模块只做事实提取与客观分类：不归一化、不剥后缀、不判严重性，名字原样保留。
 *
 * @module dsh-upstream-model-audit/marks
 */

/** 一次调用的客观差异标记；不表示严重性。 */
export type UpstreamModelMark =
  /** 请求名与上游声明名逐字相同。 */
  | 'identical'
  /** 一方是另一方的厂商/路由前缀形式（如 mimo-v2.6-pro vs xiaomi/mimo-v2.6-pro）。 */
  | 'prefixed'
  /** 两个名字逐字不同，且不构成前缀关系。 */
  | 'different'

/** host 半旁路观察到的附加上下文（字段缺失表示没有观察到）。 */
export interface ObservedUpstreamAudit {
  /** 请求体里实际发往上游的模型名。 */
  readonly sentModel?: string
  /** 上游声明的服务档位（OpenAI service_tier 的归一值 / Anthropic usage.speed）。 */
  readonly serviceTier?: string
  /** 一次响应内出现过的不同声明（>1 表示上游自相矛盾）。 */
  readonly variants?: readonly string[]
}

/** 一条可显示的审计记录；字段全部取自会话日志，未经加工。 */
export interface UpstreamModelAudit extends ObservedUpstreamAudit {
  /** 轮次。 */
  readonly turn: number
  /** 步骤：一次模型调用。 */
  readonly step: number
  /** 实际发往 provider 的模型名。 */
  readonly requested: string
  /** 上游响应声明的模型名。 */
  readonly reported: string
  /** 客观差异标记。 */
  readonly mark: UpstreamModelMark
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * 读取 replayState 里的响应对象。
 * replayState 是适配器私有结构（会随适配器版本变化），逐层防御式读取。
 * @param replayState - 事件里的 `message.source.replayState`。
 * @returns 响应对象，或 null。
 */
function responseOf(replayState: unknown): Record<string, unknown> | null {
  const envelope = asRecord(replayState)
  return envelope === null ? null : asRecord(envelope['response'])
}

/**
 * 读取上游声明的模型名。
 * @param replayState - 事件里的 `message.source.replayState`。
 * @returns 非空字符串或 null。
 */
export function readReportedModel(replayState: unknown): string | null {
  const response = responseOf(replayState)
  const reported = response?.['responseModel']
  return typeof reported === 'string' && reported.length > 0 ? reported : null
}

/**
 * 读取 host 半旁路观察到的附加事实。
 * 字段缺失或形状不认识时一律省略，绝不猜测。
 * @param replayState - 事件里的 `message.source.replayState`。
 * @returns 附加事实（可能为空对象）。
 */
export function readObservedAudit(replayState: unknown): ObservedUpstreamAudit {
  const response = responseOf(replayState)
  const audit = response === null ? null : asRecord(response['upstreamAudit'])
  if (audit === null) return {}
  const observed: { sentModel?: string; serviceTier?: string; variants?: readonly string[] } = {}
  const sentModel = audit['sentModel']
  if (typeof sentModel === 'string' && sentModel !== '') observed.sentModel = sentModel
  const serviceTier = audit['serviceTier']
  if (typeof serviceTier === 'string' && serviceTier !== '') observed.serviceTier = serviceTier
  const variants = audit['variants']
  if (Array.isArray(variants)) {
    const list = variants.filter((item): item is string => typeof item === 'string' && item !== '')
    if (list.length > 1) observed.variants = list
  }
  return observed
}

/**
 * 对两个名字做客观分类。
 * @param requested - 请求模型名。
 * @param reported - 上游声明模型名。
 * @returns 差异标记。
 */
export function markOf(requested: string, reported: string): UpstreamModelMark {
  if (requested === reported) return 'identical'
  if (requested.endsWith('/' + reported) || reported.endsWith('/' + requested)) return 'prefixed'
  return 'different'
}

/**
 * 从一个会话事件里提取可显示的审计记录。
 * 只认 `assistant/message`；上游未声明模型名、名字逐字相同、或事件形状不认识时返回 null
 * （没有可呈现的差异事实，就不显示）。
 * @param event - 任意会话事件（结构式读取，不依赖 harness 类型）。
 * @returns 审计记录或 null。
 */
export function auditOf(event: { type?: unknown; data?: unknown } | null | undefined): UpstreamModelAudit | null {
  if (event === null || event === undefined || event.type !== 'assistant/message') return null
  const data = event.data as
    | { turn?: unknown; step?: unknown; message?: { source?: unknown } }
    | undefined
  if (data === undefined || data === null) return null
  const source = data.message?.source as
    | { kind?: unknown; model?: unknown; replayState?: unknown }
    | undefined
  if (source === undefined || source === null || source.kind !== 'model') return null
  const requested = typeof source.model === 'string' && source.model.length > 0 ? source.model : null
  const reported = readReportedModel(source.replayState)
  if (requested === null || reported === null) return null
  const mark = markOf(requested, reported)
  if (mark === 'identical') return null
  return {
    turn: typeof data.turn === 'number' ? data.turn : -1,
    step: typeof data.step === 'number' ? data.step : -1,
    requested,
    reported,
    mark,
    ...readObservedAudit(source.replayState),
  }
}
