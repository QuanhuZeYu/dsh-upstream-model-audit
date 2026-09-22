/**
 * 上游响应观察器：从原始响应字节里读出上游声明的事实。
 *
 * 这是 `replayState.response.responseModel` 缺失时的旁路数据源。DSH 的适配器只在部分
 * 通道写这个字段（chat completions 且名字与请求不同才写，responses / anthropic / 自研
 * 通道根本不写），导致界面看不到真相。本模块在 host 半的 fetch 观察点上按与 sub2api
 * 相同的语义解析原始帧：
 *
 *   - 模型名：terminal 帧（`response.completed` 等）优先，否则保留首个声明；
 *   - 服务档位：terminal 帧优先，非 terminal 帧只在互相一致时可信；
 *   - 一次响应内出现过多个不同声明时原样留档（`variants`），不归一化、不挑一个"正确"的；
 *   - 名字超长按 200 字符截断（上游是不可信输入）；
 *   - 读不到就是空串／空数组，绝不猜测。
 *
 * 零依赖纯逻辑，可在 node --test 里直接跑。
 *
 * @module dsh-upstream-model-audit/observe
 */

/** 一次上游响应里观察到的事实。 */
export interface UpstreamFacts {
  /** 上游声明的模型名；空串表示这次响应没有声明。 */
  readonly model: string
  /** 上游声明的服务档位（已归一到计费词汇）；空串表示没有可信声明。 */
  readonly serviceTier: string
  /** 一次响应内出现过的不同声明（去重、按出现顺序，>1 表示上游自相矛盾）。 */
  readonly variants: readonly string[]
  /** 响应体形状：`sse` / `json` / 空串（无法判定）。 */
  readonly transport: string
  /** 请求体里实际发往上游的模型名；空串表示没读到。 */
  readonly sentModel: string
}

/** 上游模型名长度上限（与 sub2api 的 `upstreamResponseModelMaxLength` 一致）。 */
export const MAX_MODEL_LENGTH = 200

/** 一次响应内最多留档几个不同声明。 */
export const MAX_VARIANTS = 4

/** 单行缓冲上限：超长行（例如超大的 tool-call 参数）不再累积，避免内存风险。 */
const MAX_LINE_LENGTH = 1024 * 1024

/** OpenAI Responses 的终结事件；只有这些帧的声明才是"上游实际服务了哪个模型"。 */
const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
  'response.canceled',
])

/** 空事实集。 */
export function emptyFacts(): UpstreamFacts {
  return { model: '', serviceTier: '', variants: [], transport: '', sentModel: '' }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function trimmedString(value: unknown): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (text === '') return ''
  const runes = [...text]
  return runes.length > MAX_MODEL_LENGTH ? runes.slice(0, MAX_MODEL_LENGTH).join('') : text
}

/**
 * 从一帧负载里取上游声明的模型名。
 * 取值顺序对齐 sub2api：`response.model` → `model` → `message.model` → `modelVersion`
 * → `response.modelVersion` → `response.response.modelVersion`。
 * @param payload - 已解析的 JSON 负载。
 * @returns 去掉首尾空白的模型名，或空串。
 */
export function extractModel(payload: unknown): string {
  const frame = asRecord(payload)
  if (frame === null) return ''
  const response = asRecord(frame['response'])
  const message = asRecord(frame['message'])
  const nested = response === null ? null : asRecord(response['response'])
  const candidates: unknown[] = [
    response?.['model'],
    frame['model'],
    message?.['model'],
    frame['modelVersion'],
    response?.['modelVersion'],
    nested?.['modelVersion'],
  ]
  for (const candidate of candidates) {
    const model = trimmedString(candidate)
    if (model !== '') return model
  }
  return ''
}

/**
 * 判断一帧是否 Gemini 形状（`modelVersion`）。
 * Gemini 流没有统一的终结事件，每个声明都当作终态，保留最新那个。
 * @param payload - 已解析的 JSON 负载。
 * @returns 是否 Gemini 形状。
 */
export function isGeminiShape(payload: unknown): boolean {
  const frame = asRecord(payload)
  if (frame === null) return false
  if (frame['modelVersion'] !== undefined) return true
  const response = asRecord(frame['response'])
  if (response === null) return false
  if (response['modelVersion'] !== undefined) return true
  const nested = asRecord(response['response'])
  return nested !== null && nested['modelVersion'] !== undefined
}

/**
 * 归一一帧里的 OpenAI 服务档位（`service_tier`）。
 * `fast` 是 `priority` 的别名；`auto` 不描述处理档位，一律忽略而不是猜。
 * @param payload - 已解析的 JSON 负载。
 * @returns 归一后的档位，或空串。
 */
export function extractOpenAIServiceTier(payload: unknown): string {
  const frame = asRecord(payload)
  if (frame === null) return ''
  const response = asRecord(frame['response'])
  const raw = response?.['service_tier'] ?? frame['service_tier']
  if (typeof raw !== 'string') return ''
  switch (raw.trim().toLowerCase()) {
    case 'priority':
    case 'fast':
      return 'priority'
    case 'default':
    case 'flex':
    case 'scale':
      return raw.trim().toLowerCase()
    default:
      return ''
  }
}

/**
 * 提取并归一 Anthropic 的 `usage.speed`（fast / standard）。
 * @param payload - 已解析的 JSON 负载。
 * @returns 归一后的档位，或空串。
 */
export function extractAnthropicSpeed(payload: unknown): string {
  const frame = asRecord(payload)
  if (frame === null) return ''
  const message = asRecord(frame['message'])
  const messageUsage = message === null ? null : asRecord(message['usage'])
  const usage = asRecord(frame['usage'])
  const raw = messageUsage?.['speed'] ?? usage?.['speed']
  if (typeof raw !== 'string') return ''
  const value = raw.trim().toLowerCase()
  return value === 'fast' || value === 'standard' ? value : ''
}

/**
 * 从请求体文本里取实际发往上游的模型名。
 * @param body - 请求体（通常是 JSON 字符串）。
 * @returns 模型名，或空串。
 */
export function extractSentModel(body: string): string {
  const text = body.trim()
  if (text === '' || text[0] !== '{') return ''
  try {
    const parsed = asRecord(JSON.parse(text))
    return parsed === null ? '' : trimmedString(parsed['model'])
  } catch {
    return ''
  }
}

/**
 * 一次上游响应的声明聚合器（模型名语义同 sub2api 的 `upstreamResponseModelObserver`）。
 */
export class UpstreamObserver {
  private first = ''
  private terminal = ''
  private readonly seen: string[] = []
  private firstTier = ''
  private terminalTier = ''
  private tierConflict = false
  private transport = ''

  /**
   * 记录一帧模型名声明。
   * @param model - 该帧声明的模型名；空串忽略。
   * @param terminal - 该帧是否为终结帧。
   */
  observe(model: string, terminal: boolean): void {
    const normalized = trimmedString(model)
    if (normalized === '') return
    this.remember(normalized)
    if (terminal) {
      this.terminal = normalized
      return
    }
    if (this.first === '') this.first = normalized
  }

  /**
   * 记录一次服务档位声明。
   * @param tier - 已归一的档位；空串忽略。
   * @param terminal - 该声明是否来自终结帧。
   */
  observeServiceTier(tier: string, terminal: boolean): void {
    if (tier === '') return
    if (terminal) {
      this.terminalTier = tier
      return
    }
    if (this.firstTier === '') {
      this.firstTier = tier
      return
    }
    if (this.firstTier !== tier) this.tierConflict = true
  }

  /**
   * 记录响应体的形状。
   * @param transport - `sse` / `json`。
   */
  observeTransport(transport: string): void {
    if (this.transport === '' && transport !== '') this.transport = transport
  }

  /**
   * 记录一帧原始负载。
   * @param payload - 已解析的 JSON 负载。
   * @param eventType - SSE 的 `event:` 名（无则空串）。
   */
  observePayload(payload: unknown, eventType: string): void {
    const model = extractModel(payload)
    if (model === '') return
    const typed = eventType.trim()
    const terminal = TERMINAL_EVENTS.has(typed) || isGeminiShape(payload)
    this.observe(model, terminal)
    // 非终结帧的 Responses 事件回显的是请求档位而非实际处理档位；
    // chat completions 分片与非流式体（无 event 名）才报告真实档位。
    const openaiTier = extractOpenAIServiceTier(payload)
    if (openaiTier !== '' && (terminal || typed === '')) this.observeServiceTier(openaiTier, terminal)
    const speed = extractAnthropicSpeed(payload)
    if (speed !== '') this.observeServiceTier(speed, false)
  }

  private remember(model: string): void {
    if (this.seen.some(existing => existing.toLowerCase() === model.toLowerCase())) return
    if (this.seen.length >= MAX_VARIANTS) return
    this.seen.push(model)
  }

  /** @returns 上游声明的模型名（terminal 优先，否则首个），空串表示没有声明。 */
  model(): string {
    return this.terminal !== '' ? this.terminal : this.first
  }

  /** @returns 上游声明的服务档位（terminal 优先，非终结声明只在一致时可信）。 */
  serviceTier(): string {
    if (this.terminalTier !== '') return this.terminalTier
    return this.tierConflict ? '' : this.firstTier
  }

  /** @returns 响应体形状。 */
  observedTransport(): string {
    return this.transport
  }

  /** @returns 同一次响应内是否出现过互相矛盾的模型声明。 */
  conflict(): boolean {
    return this.seen.length > 1
  }

  /** @returns 当前观察结果的快照。 */
  snapshot(): UpstreamFacts {
    return {
      model: this.model(),
      serviceTier: this.serviceTier(),
      variants: this.seen.length > 1 ? [...this.seen] : [],
      transport: this.transport,
      sentModel: '',
    }
  }
}

/**
 * SSE 帧解析器：把字节流切成 (event, data) 分发给观察器。
 * 只认 `event:` / `data:` 两种字段，忽略注释、id、retry 与 `[DONE]`。
 */
export class SseFrameParser {
  private buffer = ''
  private eventType = ''
  private dataLines: string[] = []

  /**
   * @param onFrame - 收到一个完整帧时回调。
   */
  constructor(private readonly onFrame: (eventType: string, payload: unknown) => void) {}

  /**
   * 喂入一段文本（可跨帧边界）。
   * @param text - 新增的响应文本。
   */
  push(text: string): void {
    this.buffer += text
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      this.line(line)
      index = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE_LENGTH) this.buffer = ''
  }

  /** 流结束时冲刷残留缓冲。 */
  end(): void {
    if (this.buffer !== '') {
      this.line(this.buffer.replace(/\r$/, ''))
      this.buffer = ''
    }
    this.dispatch()
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventType = value
    else if (field === 'data') this.dataLines.push(value)
  }

  private dispatch(): void {
    const eventType = this.eventType
    const data = this.dataLines.join('\n')
    this.eventType = ''
    this.dataLines = []
    if (data === '' || data === '[DONE]') return
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    this.onFrame(eventType, payload)
  }
}

/**
 * 解析一整段 SSE 文本。
 * @param text - SSE 文本。
 * @param observer - 目标观察器。
 */
export function observeSseText(text: string, observer: UpstreamObserver): void {
  const parser = new SseFrameParser((eventType, payload) => observer.observePayload(payload, eventType))
  parser.push(text)
  parser.end()
}

/**
 * 解析一整段 JSON 文本（非流式响应体）。
 * @param text - 响应体文本。
 * @param observer - 目标观察器。
 */
export function observeJsonText(text: string, observer: UpstreamObserver): void {
  const trimmed = text.trim()
  if (trimmed === '') return
  try {
    observer.observePayload(JSON.parse(trimmed), '')
  } catch {
    // 非 JSON 响应体（错误页、HTML）不含声明，忽略。
  }
}

/**
 * 判断一段（可能是响应体开头的）文本看起来像什么。
 * 有些中转不给正确的 content-type，这里按内容兜底判定。
 * @param text - 文本开头。
 * @returns `sse` / `json` / 空串。
 */
export function sniffTransport(text: string): string {
  const head = text.trimStart()
  if (head.startsWith('data:') || head.startsWith('event:') || head.startsWith(':')) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return ''
}

/**
 * 按形状选择解析方式后解析响应体。
 * @param transport - `sse` / `json` / 空串（不解析）。
 * @param text - 响应体文本。
 * @param observer - 目标观察器。
 */
export function observeBody(transport: string, text: string, observer: UpstreamObserver): void {
  observer.observeTransport(transport)
  if (transport === 'sse') observeSseText(text, observer)
  else if (transport === 'json') observeJsonText(text, observer)
}

/**
 * 把观察到的事实补进 finish chunk 的 replayState。
 *
 * 两条补写规则，都只在字段缺失时生效：
 *   - `response.responseModel`：上游声明的模型名（原生值永远优先）；
 *   - `response.upstreamAudit`：本插件观察到的附加上下文（实际发出的模型名、服务档位、
 *     响应体形状、上游自相矛盾的多个声明）。
 *
 * `upstreamAudit` 是 replayState 上的未知字段：pi-ai 的 `readReplayState` 只校验已知
 * 字段的类型，自研 `deepseek-messages` 的校验同样忽略未知字段，因此两种 envelope 都安全。
 * 形状不认识的 replayState 一律原样返回。
 *
 * @param replayState - finish chunk 上的 replayState（未知形状）。
 * @param facts - 观察到的事实。
 * @returns 补写后的 replayState（未补写时原样返回）。
 */
export function withObservedFacts(replayState: unknown, facts: UpstreamFacts): unknown {
  const envelope = asRecord(replayState)
  if (envelope === null) return replayState
  const response = asRecord(envelope['response'])
  if (response === null) return replayState
  if (typeof response['kind'] !== 'string' || response['kind'] === '') return replayState

  const audit: Record<string, unknown> = {}
  if (facts.sentModel !== '') audit['sentModel'] = facts.sentModel
  if (facts.serviceTier !== '') audit['serviceTier'] = facts.serviceTier
  if (facts.transport !== '') audit['transport'] = facts.transport
  if (facts.variants.length > 1) audit['variants'] = [...facts.variants]

  const hasAudit = Object.keys(audit).length > 0
  const current = response['responseModel']
  const needsModel = facts.model !== '' && !(typeof current === 'string' && current !== '')
  const needsAudit = hasAudit && asRecord(response['upstreamAudit']) === null
  if (!needsModel && !needsAudit) return replayState

  const nextResponse: Record<string, unknown> = { ...response }
  if (needsModel) nextResponse['responseModel'] = facts.model
  if (needsAudit) nextResponse['upstreamAudit'] = audit
  return { ...envelope, response: nextResponse }
}
