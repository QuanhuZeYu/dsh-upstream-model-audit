/**
 * 上游响应观察器：从原始响应字节里读出上游声明的模型名。
 *
 * 这是 `replayState.response.responseModel` 缺失时的旁路数据源。DSH 的 pi-ai 适配器
 * 只在特定条件下写这个字段（chat completions 且名字与请求不同才写，responses /
 * anthropic / 自研通道根本不写），导致界面看不到 responses 通道的真相。本模块在
 * host 半的 fetch 观察点上按与 sub2api 相同的语义解析原始帧：
 *
 *   - terminal 帧（`response.completed` 等）优先，否则保留首个声明；
 *   - 一次响应内出现互相矛盾的声明时置 `conflict`（仍返回 terminal/first）；
 *   - 名字超长按 200 字符截断（上游是不可信输入）；
 *   - 不归一化、不剥后缀、不猜：读不到就返回空串。
 *
 * 零依赖纯逻辑，可在 node --test 里直接跑。
 *
 * @module dsh-upstream-model-audit/observe
 */

/** 观察到的上游声明。 */
export interface UpstreamDeclaration {
  /** 上游声明的模型名；空串表示这次响应没有声明。 */
  readonly model: string
  /** 同一次响应内出现过互相矛盾的声明。 */
  readonly conflict: boolean
}

/** 上游模型名长度上限（与 sub2api 的 `upstreamResponseModelMaxLength` 一致）。 */
export const MAX_MODEL_LENGTH = 200

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
 * 一次上游响应的声明聚合器（语义同 sub2api 的 `upstreamResponseModelObserver`）。
 */
export class UpstreamObserver {
  private first = ''
  private terminal = ''
  private conflicted = false

  /**
   * 记录一帧声明。
   * @param model - 该帧声明的模型名；空串忽略。
   * @param terminal - 该帧是否为终结帧。
   */
  observe(model: string, terminal: boolean): void {
    const normalized = trimmedString(model)
    if (normalized === '') return
    const current = this.model()
    if (current !== '' && current.toLowerCase() !== normalized.toLowerCase()) this.conflicted = true
    if (terminal) {
      this.terminal = normalized
      return
    }
    if (this.first === '') this.first = normalized
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
  }

  /** @returns 上游声明的模型名（terminal 优先，否则首个），空串表示没有声明。 */
  model(): string {
    return this.terminal !== '' ? this.terminal : this.first
  }

  /** @returns 同一次响应内是否出现过互相矛盾的声明。 */
  conflict(): boolean {
    return this.conflicted
  }

  /** @returns 当前观察结果的快照。 */
  snapshot(): UpstreamDeclaration {
    return { model: this.model(), conflict: this.conflicted }
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
 * 判断响应体形状，选择对应的解析方式后解析。
 * @param contentType - 响应的 `content-type`。
 * @param text - 响应体文本。
 * @param observer - 目标观察器。
 */
export function observeBody(contentType: string, text: string, observer: UpstreamObserver): void {
  if (contentType.includes('event-stream')) observeSseText(text, observer)
  else if (contentType.includes('json')) observeJsonText(text, observer)
}

/**
 * 把观察到的模型名补进 finish chunk 的 replayState。
 *
 * 只在 `response.responseModel` 缺失、且确实观察到了声明时写入，原生值永远优先；
 * 形状不认识的 replayState 一律原样返回。pi-ai 的 `readReplayState` 只校验
 * `responseModel` 必须是字符串，自研 `deepseek-messages` 的校验忽略未知字段，
 * 因此这条补写对两种 envelope 都安全。
 *
 * @param replayState - finish chunk 上的 replayState（未知形状）。
 * @param observed - 观察到的上游声明；空串表示没有声明。
 * @returns 补写后的 replayState（未补写时原样返回）。
 */
export function withObservedModel(replayState: unknown, observed: string): unknown {
  if (observed === '') return replayState
  const envelope = asRecord(replayState)
  if (envelope === null) return replayState
  const response = asRecord(envelope['response'])
  if (response === null) return replayState
  if (typeof response['kind'] !== 'string' || response['kind'] === '') return replayState
  const current = response['responseModel']
  if (typeof current === 'string' && current !== '') return replayState
  return { ...envelope, response: { ...response, responseModel: observed } }
}
