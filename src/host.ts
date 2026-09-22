/**
 * 上游模型审计的 host 半：在 DSH 的 node 进程里旁路观察上游响应，并把缺失的
 * `replayState.response.responseModel` 补全。
 *
 * 为什么需要它：pi-ai 只在 chat completions 且"响应模型名与请求名不同"时才写
 * `responseModel`，responses / azure / codex 分支根本不写，Anthropic 只在换名时写；
 * 于是 `openai-responses` 这类通道永远看不到上游声明的模型名（实测 11000 次调用 0 条可见）。
 *
 * 两个观察点，都不改变转发路径：
 *
 *  1. `globalThis.fetch` 旁路：只在本插件建立的调用作用域内，克隆响应体（`Response.clone()`
 *     是 tee，不动调用方那一支），按与 sub2api 相同的语义解析 SSE / JSON 帧里的模型声明。
 *     作用域外一律原样透传，零行为差异。
 *  2. `llm/stream` 中间件（cordis waterfall）：为每次模型调用建立作用域，并在 `finish` chunk
 *     上补写缺失的 `responseModel`。写进去的值随后由 DSH 自己持久化进 durable 的
 *     `assistant/message` 事件，浏览器半照常读取，无需新增事件类型或传输通道。
 *
 * 不变量：只在字段缺失时补写；原生值永远优先；形状不认识的 replayState 一律不碰；
 * 解析失败、超时、任何异常都静默降级（观察绝不影响模型调用）。
 *
 * @module dsh-upstream-model-audit/host
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import { SseFrameParser, UpstreamObserver, observeJsonText, withObservedModel } from './observe.ts'

/** 一次模型调用期间可见的观察作用域。 */
interface CallScope {
  /** 最近一次拿到声明的响应所声明的模型名。 */
  declared: string
  /** 尚未读完的响应体解析任务。 */
  readonly pending: Set<Promise<void>>
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

/** watermark 中间件的形状。 */
type StreamListener = (
  options: StreamCallOptions,
  next: () => AsyncIterable<RawChunk>,
) => AsyncIterable<RawChunk>

/** 已打过补丁的 fetch 上的标记，保证同进程内只包装一次。 */
const PATCH_MARK = Symbol.for('dsh-upstream-model-audit/fetch-patched')

/** 补写前等待旁路解析完成的上限（毫秒）；只在确实缺字段时才等。 */
const SETTLE_TIMEOUT_MS = 300

/** 单次模型调用的观察作用域；fetch 观察点据此把响应归属到正确的调用。 */
const scope = new AsyncLocalStorage<CallScope>()

/** 是否只处理 SSE / JSON 形状的响应体。 */
function isObservableContentType(contentType: string): boolean {
  return contentType.includes('event-stream') || contentType.includes('json')
}

/**
 * 读克隆出来的响应体并解析上游模型声明。
 * @param response - `Response.clone()` 的副本。
 * @param call - 该响应所属的调用作用域。
 */
async function consumeResponse(response: Response, call: CallScope): Promise<void> {
  const contentType = response.headers.get('content-type') ?? ''
  const body = response.body
  if (body === null || !isObservableContentType(contentType)) {
    // 不消费的 tee 分支会持续缓冲，必须显式取消。
    await body?.cancel().catch(() => undefined)
    return
  }
  const observer = new UpstreamObserver()
  if (contentType.includes('event-stream')) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseFrameParser((eventType, payload) => observer.observePayload(payload, eventType))
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      if (step.value !== undefined) parser.push(decoder.decode(step.value, { stream: true }))
    }
    parser.end()
  } else {
    observeJsonText(await response.text(), observer)
  }
  const declared = observer.model()
  if (declared !== '') call.declared = declared
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
      const task = consumeResponse(response.clone(), call).catch(() => undefined)
      call.pending.add(task)
      void task.finally(() => call.pending.delete(task))
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
 * 等到旁路解析有结果，或超过上限。
 * 已经有声明时立即返回，因此正常路径不引入任何延迟。
 * @param call - 当前调用作用域。
 * @param timeoutMs - 等待上限。
 * @returns 观察到（或空）的模型名。
 */
async function settleDeclared(call: CallScope, timeoutMs: number): Promise<string> {
  if (call.declared !== '' || call.pending.size === 0) return call.declared
  const settled = Promise.allSettled([...call.pending])
  await Promise.race([settled, new Promise<void>(resolve => { setTimeout(resolve, timeoutMs).unref?.() })])
  return call.declared
}

/**
 * 包装一条模型调用流：建立作用域并在 finish 上补写缺失的上游模型名。
 * @param next - 下游（真正的适配器流）。
 * @returns 补写后的 chunk 流。
 */
async function* auditStream(next: () => AsyncIterable<RawChunk>): AsyncIterable<RawChunk> {
  const call: CallScope = { declared: '', pending: new Set() }
  const iterator = scope.run(call, () => next()[Symbol.asyncIterator]())
  for (;;) {
    const step = await scope.run(call, () => iterator.next())
    if (step.done === true) return
    const chunk = step.value
    if (chunk?.type === 'finish' && chunk.replayState !== undefined) {
      const declared = await settleDeclared(call, SETTLE_TIMEOUT_MS)
      const replayState = withObservedModel(chunk.replayState, declared)
      yield replayState === chunk.replayState ? chunk : { ...chunk, replayState }
      continue
    }
    yield chunk
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
