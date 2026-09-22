/**
 * 上游模型审计的 host 半：在 DSH 的 node 进程里旁路观察上游响应，并把缺失的事实
 * 补进 durable 的 replayState。
 *
 * 为什么需要它：pi-ai 只在 chat completions 且"响应模型名与请求名不同"时才写
 * `responseModel`，responses / azure / codex 分支根本不写，Anthropic 只在换名时写；
 * 自研通道只留请求模型。于是这些通道的上游声明永远看不到（实测 11000 次 responses 调用 0 条可见）。
 *
 * 两个观察点，都不改变转发路径：
 *
 *  1. `globalThis.fetch` 旁路：只在本插件建立的调用作用域内，克隆响应体（`Response.clone()`
 *     是 tee，不动调用方那一支），读取上游声明的模型名、服务档位与响应形状；请求体可读时
 *     顺带记录实际发往上游的模型名；响应头里的上游模型名作为兜底。
 *  2. `llm/stream` 中间件（cordis waterfall）：为每次模型调用建立作用域，并在 `finish` chunk
 *     上补写缺失的 `responseModel` 与 `response.upstreamAudit`。写进去的值随后由 DSH 自己
 *     持久化进 durable 的 `assistant/message` 事件，浏览器半照常读取。
 *
 * 不变量：只在字段缺失时补写；原生值永远优先；只采纳成功响应（2xx）的声明；
 * 形状不认识的 replayState 一律不碰；解析失败、超时、任何异常都静默降级。
 *
 * @module dsh-upstream-model-audit/host
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  SseFrameParser, UpstreamObserver, emptyFacts, extractSentModel, observeJsonText, sniffTransport,
  withObservedFacts,
} from './observe.ts'
import type { UpstreamFacts } from './observe.ts'

/** 一次响应体的观察结果。 */
interface ResponseObservation {
  /** 响应状态是否成功（只采纳成功响应的声明，与 sub2api 只记成功尝试一致）。 */
  readonly ok: boolean
  /** 这次响应观察到的事实。 */
  readonly facts: UpstreamFacts
}

/** 一次模型调用期间可见的观察作用域。 */
interface CallScope {
  /** 按发生顺序记录的响应观察结果。 */
  readonly observations: ResponseObservation[]
  /** 尚未读完的响应体解析任务。 */
  readonly pending: Set<Promise<void>>
  /** 强制停止尚未结束的旁路读取（调用结束时统一清理）。 */
  readonly cancels: Set<() => void>
}

/** `llm/stream` 的入参里本插件用到的部分（避免依赖 harness 类型包的具体版本）。 */
interface StreamCallOptions {
  readonly provider?: unknown
  readonly model?: unknown
}

/** 适配器产出的原始流 chunk 里本插件关心的部分。 */
interface RawChunk {
  readonly type?: unknown
  readonly replayState?: unknown
}

/** waterfall 中间件的形状。 */
type StreamListener = (
  options: StreamCallOptions,
  next: () => AsyncIterable<RawChunk>,
) => AsyncIterable<RawChunk>

/** 已打过补丁的 fetch 上的标记，保证同进程内只包装一次。 */
const PATCH_MARK = Symbol.for('dsh-upstream-model-audit/fetch-patched')

/** 补写前等待旁路解析完成的上限（毫秒）；只在确实缺事实时才等。 */
const SETTLE_TIMEOUT_MS = 300

/** 非流式 JSON 体的读取上限，避免异常响应把内存吃光。 */
const MAX_JSON_BODY = 8 * 1024 * 1024

/** 与模型声明无关的端点：计数、目录、鉴权，跳过不观察。 */
const SKIP_ENDPOINT = /\/(?:count_tokens|models|oauth|token)(?:\/|\?|$)/

/** 响应头里可能携带上游模型名的字段（按优先级）。 */
const MODEL_HEADERS = ['x-upstream-model', 'openai-model', 'x-model', 'upstream-model']

/** 单次模型调用的观察作用域；fetch 观察点据此把响应归属到正确的调用。 */
const scope = new AsyncLocalStorage<CallScope>()

/** 该 URL 是否值得观察。 */
function shouldObserve(url: string): boolean {
  return !SKIP_ENDPOINT.test(url)
}

/** 从响应头里读上游模型名（兜底，仅当响应体没有声明时使用）。 */
function headerModel(response: Response): string {
  for (const name of MODEL_HEADERS) {
    const value = response.headers.get(name)
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 取请求体里实际发往上游的模型名。 */
function sentModelOf(init: RequestInit | undefined): string {
  const body = init?.body
  return typeof body === 'string' ? extractSentModel(body) : ''
}

/**
 * 读响应体并解析上游声明。content-type 不可信时按内容兜底判定形状。
 * @param response - 克隆出来的响应。
 * @param observer - 目标观察器。
 * @param declared - content-type 判定的形状（`sse` / `json` / 空串）。
 * @param call - 所属调用作用域（用于统一清理悬挂读取）。
 * @param signal - 调用方的中止信号。
 */
async function readInto(
  response: Response,
  observer: UpstreamObserver,
  declared: string,
  call: CallScope,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  const body = response.body
  if (body === null) return
  const reader = body.getReader()
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  const onAbort = (): void => cancel()
  call.cancels.add(cancel)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let kind = declared
    const first = await reader.read()
    if (first.done === true) {
      observer.observeTransport(kind === '' ? 'json' : kind)
      return
    }
    const decoder = new TextDecoder()
    let buffered = decoder.decode(first.value, { stream: true })
    if (kind === '') kind = sniffTransport(buffered)
    if (kind === '') {
      // 形状不认识：只记下"有响应体但无法判定"，不解析。
      observer.observeTransport('json')
      return
    }
    observer.observeTransport(kind)
    if (kind === 'sse') {
      const parser = new SseFrameParser((eventType, payload) => observer.observePayload(payload, eventType))
      parser.push(buffered)
      for (;;) {
        const step = await reader.read()
        if (step.done === true) break
        if (step.value !== undefined) parser.push(decoder.decode(step.value, { stream: true }))
      }
      parser.end()
      return
    }
    for (;;) {
      const step = await reader.read()
      if (step.done === true) break
      if (step.value === undefined) continue
      buffered += decoder.decode(step.value, { stream: true })
      if (buffered.length > MAX_JSON_BODY) break
    }
    observeJsonText(buffered, observer)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    call.cancels.delete(cancel)
    cancel()
  }
}

/**
 * 观察一次响应：读体、必要时用响应头兜底，然后记进调用作用域。
 * @param response - 克隆出来的响应。
 * @param call - 所属调用作用域。
 * @param sentModel - 请求体里实际发往上游的模型名。
 * @param signal - 调用方的中止信号。
 */
async function observeResponse(
  response: Response,
  call: CallScope,
  sentModel: string,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  const declared = contentType.includes('event-stream') ? 'sse' : contentType.includes('json') ? 'json' : ''
  const observer = new UpstreamObserver()
  await readInto(response, observer, declared, call, signal)
  if (observer.model() === '') {
    const fromHeader = headerModel(response)
    if (fromHeader !== '') observer.observe(fromHeader, true)
  }
  call.observations.push({ ok: response.ok, facts: { ...observer.snapshot(), sentModel } })
}

/**
 * 包装 `globalThis.fetch`：只在本插件的作用域内克隆并旁路解析响应体。
 * @returns 卸载函数；若本进程已装过补丁则返回空操作。
 */
export function installFetchObserver(): () => void {
  const current = globalThis.fetch as (typeof globalThis.fetch & { [PATCH_MARK]?: true }) | undefined
  if (typeof current !== 'function') return () => undefined
  if (current[PATCH_MARK] === true) return () => undefined
  const original = globalThis.fetch
  const patched = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const response = await original(input, init)
    const call = scope.getStore()
    if (call === undefined) return response
    try {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : (input as Request).url
      if (shouldObserve(url)) {
        const sentModel = sentModelOf(init)
        const signal = init?.signal ?? (input instanceof Request ? input.signal : null)
        const task = observeResponse(response.clone(), call, sentModel, signal).catch(() => undefined)
        call.pending.add(task)
        void task.finally(() => call.pending.delete(task))
      }
    } catch {
      // 观察失败绝不影响调用方。
    }
    return response
  } as typeof globalThis.fetch & { [PATCH_MARK]?: true }
  patched[PATCH_MARK] = true
  globalThis.fetch = patched
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
  }
}

/**
 * 汇总这次调用的最终事实：取最后一个成功且确有声明的响应。
 * @param call - 当前调用作用域。
 * @returns 观察到的事实；没有可用声明时为空事实。
 */
function finalFacts(call: CallScope): UpstreamFacts {
  for (let index = call.observations.length - 1; index >= 0; index -= 1) {
    const observation = call.observations[index]
    if (observation !== undefined && observation.ok && observation.facts.model !== '') return observation.facts
  }
  return emptyFacts()
}

/**
 * 等到旁路解析有结果，或超过上限。
 * 已经有可用声明时立即返回，因此正常路径不引入任何延迟。
 * @param call - 当前调用作用域。
 * @param timeoutMs - 等待上限。
 * @returns 最终事实。
 */
async function settleFacts(call: CallScope, timeoutMs: number): Promise<UpstreamFacts> {
  if (call.pending.size > 0 && finalFacts(call).model === '') {
    const settled = Promise.allSettled([...call.pending])
    await Promise.race([settled, new Promise<void>(resolve => { setTimeout(resolve, timeoutMs).unref?.() })])
  }
  return finalFacts(call)
}

/**
 * 包装一条模型调用流：建立作用域并在 finish 上补写缺失的上游事实。
 * @param next - 下游（真正的适配器流）。
 * @returns 补写后的 chunk 流。
 */
async function* auditStream(next: () => AsyncIterable<RawChunk>): AsyncIterable<RawChunk> {
  const call: CallScope = { observations: [], pending: new Set(), cancels: new Set() }
  try {
    const iterator = scope.run(call, () => next()[Symbol.asyncIterator]())
    for (;;) {
      const step = await scope.run(call, () => iterator.next())
      if (step.done === true) return
      const chunk = step.value
      if (chunk?.type === 'finish' && chunk.replayState !== undefined) {
        const facts = await settleFacts(call, SETTLE_TIMEOUT_MS)
        const replayState = withObservedFacts(chunk.replayState, facts)
        yield replayState === chunk.replayState ? chunk : { ...chunk, replayState }
        continue
      }
      yield chunk
    }
  } finally {
    for (const cancel of [...call.cancels]) cancel()
  }
}

/**
 * 建立 `llm/stream` 中间件。
 * @returns 可直接注册的监听器。
 */
export function createStreamListener(): StreamListener {
  return (_options, next) => auditStream(next)
}

/**
 * 安装 host 半的全部观察点。
 * @param ctx - cordis 上下文。
 * @returns 卸载函数。
 */
export function installUpstreamAudit(ctx: Context): () => void {
  const onAny = ctx.on as unknown as (name: string, listener: StreamListener) => () => void
  const disposeStream = onAny('llm/stream', createStreamListener())
  const disposeFetch = installFetchObserver()
  return () => {
    disposeStream()
    disposeFetch()
  }
}
