import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UpstreamObserver, SseFrameParser, observeSseText, observeJsonText, observeBody,
  extractModel, extractOpenAIServiceTier, extractAnthropicSpeed, extractSentModel,
  isGeminiShape, sniffTransport, withObservedFacts, emptyFacts, MAX_MODEL_LENGTH, MAX_VARIANTS,
} from '../lib/dev/observe.js'

const sse = (...frames) => frames.map(([event, payload]) =>
  (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(payload) + '\n\n').join('')

const factsOf = (observer, sentModel = '') => ({ ...observer.snapshot(), sentModel })

test('OpenAI Responses：terminal 帧覆盖早先声明，两个声明都留档', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['response.created', { type: 'response.created', response: { model: 'gpt-5.5' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'hi' }],
    ['response.completed', { type: 'response.completed', response: { model: 'gpt-5.4' } }],
  ), o)
  assert.equal(o.model(), 'gpt-5.4')
  assert.equal(o.conflict(), true)
  assert.deepEqual(o.snapshot().variants, ['gpt-5.5', 'gpt-5.4'])
})

test('chat completions：无 event: 名的分片按首个声明保留', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['', { object: 'chat.completion.chunk', model: 'deepseek/deepseek-v4.1-flash', choices: [] }],
    ['', { object: 'chat.completion.chunk', model: 'deepseek/deepseek-v4.1-flash', choices: [] }],
  ), o)
  assert.equal(o.model(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(o.conflict(), false)
  assert.deepEqual(o.snapshot().variants, [])
})

test('Anthropic：message_start 的 message.model 与 usage.speed', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-4-20250514', usage: { speed: 'fast' } } }],
  ), o)
  assert.equal(o.model(), 'claude-sonnet-4-20250514')
  assert.equal(o.serviceTier(), 'fast')
})

test('Gemini：每个 modelVersion 都是终态，保留最新', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['', { response: { modelVersion: 'gemini-2.5-pro' } }],
    ['', { modelVersion: 'gemini-2.5-pro-latest' }],
  ), o)
  assert.equal(o.model(), 'gemini-2.5-pro-latest')
  assert.equal(o.conflict(), true)
  assert.equal(isGeminiShape({ response: { response: { modelVersion: 'x' } } }), true)
})

test('服务档位：terminal 优先，非终结帧回显被忽略，互相矛盾则丢弃', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['response.created', { type: 'response.created', response: { model: 'gpt-5.6-sol', service_tier: 'priority' } }],
  ), o)
  assert.equal(o.serviceTier(), '', 'created 回显的是请求档位，不作数')
  observeSseText(sse(
    ['response.completed', { type: 'response.completed', response: { model: 'gpt-5.6-sol', service_tier: 'default' } }],
  ), o)
  assert.equal(o.serviceTier(), 'default')

  const chunks = new UpstreamObserver()
  observeSseText('data: {"model":"gpt-5.4","service_tier":"priority"}\n\ndata: {"model":"gpt-5.4","service_tier":"default"}\n\n', chunks)
  assert.equal(chunks.serviceTier(), '')

  const fast = new UpstreamObserver()
  observeJsonText(JSON.stringify({ model: 'gpt-5.6-sol', service_tier: 'fast' }), fast)
  assert.equal(fast.serviceTier(), 'priority', 'fast 归一到 priority')
  const auto = new UpstreamObserver()
  observeJsonText(JSON.stringify({ model: 'gpt-5.6-sol', service_tier: 'auto' }), auto)
  assert.equal(auto.serviceTier(), '')
})

test('服务档位归一函数', () => {
  assert.equal(extractOpenAIServiceTier({ response: { service_tier: 'FAST' } }), 'priority')
  assert.equal(extractOpenAIServiceTier({ service_tier: 'flex' }), 'flex')
  assert.equal(extractOpenAIServiceTier({ service_tier: 'scale' }), 'scale')
  assert.equal(extractOpenAIServiceTier({ service_tier: 'auto' }), '')
  assert.equal(extractOpenAIServiceTier({ service_tier: 'nonsense' }), '')
  assert.equal(extractAnthropicSpeed({ message: { usage: { speed: 'Standard' } } }), 'standard')
  assert.equal(extractAnthropicSpeed({ usage: { speed: 'turbo' } }), '')
})

test('大小写差异视为同一模型，不产生 variants', () => {
  const o = new UpstreamObserver()
  o.observe('GPT-5.5', false)
  o.observe('gpt-5.5', true)
  assert.equal(o.model(), 'gpt-5.5')
  assert.equal(o.conflict(), false)
})

test('没有声明时返回空事实，畸形帧被忽略', () => {
  const o = new UpstreamObserver()
  observeSseText('data: not-json\n\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'data: {"type":"response.completed","response":{"model":"gpt-5.4"}}\n\n', o)
  assert.equal(o.model(), 'gpt-5.4')
  assert.equal(o.conflict(), false)
  const empty = new UpstreamObserver()
  observeSseText('data: {"choices":[]}\n\ndata: [DONE]\n\n: comment\n\nid: 7\n\n', empty)
  assert.deepEqual({ ...empty.snapshot() }, { model: '', serviceTier: '', variants: [], transport: '', sentModel: '' })
})

test('超长模型名截断到上限，variants 数量有上限', () => {
  const o = new UpstreamObserver()
  o.observe('  ' + '模'.repeat(MAX_MODEL_LENGTH + 1) + '  ', false)
  assert.equal([...o.model()].length, MAX_MODEL_LENGTH)
  const many = new UpstreamObserver()
  for (let i = 0; i < MAX_VARIANTS + 3; i += 1) many.observe('m-' + i, true)
  assert.equal(many.snapshot().variants.length, MAX_VARIANTS)
})

test('非流式 JSON 响应体与 HTML 响应', () => {
  const o = new UpstreamObserver()
  observeJsonText(JSON.stringify({ id: 'resp_1', object: 'response', model: 'gpt-6-astra' }), o)
  assert.equal(o.model(), 'gpt-6-astra')
  const html = new UpstreamObserver()
  observeJsonText('<html>502 Bad Gateway</html>', html)
  assert.equal(html.model(), '')
})

test('SSE 帧跨 chunk 边界拼接', () => {
  const o = new UpstreamObserver()
  const parser = new SseFrameParser((eventType, payload) => o.observePayload(payload, eventType))
  const full = sse(['response.completed', { type: 'response.completed', response: { model: 'gpt-5.4' } }])
  parser.push(full.slice(0, 12))
  parser.push(full.slice(12, 30))
  parser.push(full.slice(30))
  parser.end()
  assert.equal(o.model(), 'gpt-5.4')
})

test('形状嗅探与 observeBody 分派', () => {
  assert.equal(sniffTransport('data: {"a":1}'), 'sse')
  assert.equal(sniffTransport('  event: x'), 'sse')
  assert.equal(sniffTransport('{"model":"c/d"}'), 'json')
  assert.equal(sniffTransport('<html>'), '')
  const stream = new UpstreamObserver()
  observeBody('sse', 'data: {"model":"a/b"}\n\n', stream)
  assert.equal(stream.model(), 'a/b')
  assert.equal(stream.observedTransport(), 'sse')
  const json = new UpstreamObserver()
  observeBody('json', '{"model":"c/d"}', json)
  assert.equal(json.model(), 'c/d')
  const none = new UpstreamObserver()
  observeBody('', '{"model":"e/f"}', none)
  assert.equal(none.model(), '')
})

test('extractModel 取值顺序对齐 sub2api', () => {
  assert.equal(extractModel({ response: { model: 'r' }, model: 'top' }), 'r')
  assert.equal(extractModel({ model: 'top', message: { model: 'msg' } }), 'top')
  assert.equal(extractModel({ message: { model: 'msg' } }), 'msg')
  assert.equal(extractModel({ modelVersion: 'v1' }), 'v1')
  assert.equal(extractModel({ response: { modelVersion: 'v2' } }), 'v2')
  assert.equal(extractModel({ response: { response: { modelVersion: 'v3' } } }), 'v3')
  assert.equal(extractModel({ model: '   ' }), '')
  assert.equal(extractModel(null), '')
})

test('extractSentModel 只认 JSON 请求体里的 model', () => {
  assert.equal(extractSentModel('{"model":"sent/x","messages":[]}'), 'sent/x')
  assert.equal(extractSentModel('not json'), '')
  assert.equal(extractSentModel('[1,2]'), '')
  assert.equal(extractSentModel('{"model":123}'), '')
})

test('withObservedFacts：补 responseModel 与 upstreamAudit，原生值优先', () => {
  const piAi = { response: { kind: 'pi-ai', version: 2, model: 'req' }, blocks: [] }
  const patched = withObservedFacts(piAi, { ...emptyFacts(), model: 'upstream/model', serviceTier: 'priority', transport: 'sse', sentModel: 'sent/model' })
  assert.equal(patched.response.responseModel, 'upstream/model')
  assert.deepEqual(patched.response.upstreamAudit, { sentModel: 'sent/model', serviceTier: 'priority', transport: 'sse' })
  assert.equal(piAi.response.responseModel, undefined, '原对象不被修改')

  const native = { response: { kind: 'pi-ai', version: 2, responseModel: 'native' } }
  assert.equal(withObservedFacts(native, { ...emptyFacts(), model: 'upstream/model' }), native, '原生值优先')

  const variants = withObservedFacts({ response: { kind: 'deepseek-messages', version: 1, model: 'req' } },
    { ...emptyFacts(), model: 'b', variants: ['a', 'b'] })
  assert.equal(variants.response.responseModel, 'b')
  assert.deepEqual(variants.response.upstreamAudit, { variants: ['a', 'b'] })

  const already = { response: { kind: 'pi-ai', version: 2, model: 'req', upstreamAudit: { transport: 'json' } } }
  const withModel = withObservedFacts(already, { ...emptyFacts(), model: 'm', serviceTier: 'default' })
  assert.equal(withModel.response.responseModel, 'm')
  assert.deepEqual(withModel.response.upstreamAudit, { transport: 'json' }, '已有的 audit 不被覆盖')

  const noFacts = { response: { kind: 'pi-ai', version: 2, model: 'req' } }
  assert.equal(withObservedFacts(noFacts, emptyFacts()), noFacts, '没有事实不改')
  const shapeless = { blocks: [] }
  assert.equal(withObservedFacts(shapeless, { ...emptyFacts(), model: 'x' }), shapeless, '没有 response 对象不改')
  assert.equal(withObservedFacts({ response: { model: 'req' } }, { ...emptyFacts(), model: 'x' }).response.responseModel, undefined, '缺少 kind 不改')
});
