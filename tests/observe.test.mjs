import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  UpstreamObserver, SseFrameParser, observeSseText, observeJsonText, observeBody,
  extractModel, isGeminiShape, withObservedModel, MAX_MODEL_LENGTH,
} from '../lib/dev/observe.js'

const sse = (...frames) => frames.map(([event, payload]) =>
  (event ? 'event: ' + event + '\n' : '') + 'data: ' + JSON.stringify(payload) + '\n\n').join('')

test('OpenAI Responses：terminal 帧覆盖早先声明并标记冲突', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['response.created', { type: 'response.created', response: { model: 'gpt-5.5' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'hi' }],
    ['response.completed', { type: 'response.completed', response: { model: 'gpt-5.4' } }],
  ), o)
  assert.equal(o.model(), 'gpt-5.4')
  assert.equal(o.conflict(), true)
})

test('chat completions：无 event: 名的分片按首个声明保留', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['', { id: 'c1', object: 'chat.completion.chunk', model: 'deepseek/deepseek-v4.1-flash', choices: [] }],
    ['', { id: 'c1', object: 'chat.completion.chunk', model: 'deepseek/deepseek-v4.1-flash', choices: [] }],
  ), o)
  assert.equal(o.model(), 'deepseek/deepseek-v4.1-flash')
  assert.equal(o.conflict(), false)
})

test('Anthropic：message_start 的 message.model', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-4-20250514' } }],
  ), o)
  assert.equal(o.model(), 'claude-sonnet-4-20250514')
  assert.equal(o.conflict(), false)
})

test('Gemini：每个 modelVersion 都是终态，保留最新并标记冲突', () => {
  const o = new UpstreamObserver()
  observeSseText(sse(
    ['', { response: { modelVersion: 'gemini-2.5-pro' } }],
    ['', { modelVersion: 'gemini-2.5-pro-latest' }],
  ), o)
  assert.equal(o.model(), 'gemini-2.5-pro-latest')
  assert.equal(o.conflict(), true)
  assert.equal(isGeminiShape({ response: { response: { modelVersion: 'x' } } }), true)
})

test('大小写差异视为同一模型（对齐 sub2api 的大小写不敏感比较）', () => {
  const o = new UpstreamObserver()
  o.observe('GPT-5.5', false)
  o.observe('gpt-5.5', true)
  assert.equal(o.model(), 'gpt-5.5')
  assert.equal(o.conflict(), false)
})

test('没有声明时返回空串，畸形帧被忽略', () => {
  const o = new UpstreamObserver()
  observeSseText('data: not-json\n\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
    'data: {"type":"response.completed","response":{"model":"gpt-5.4"}}\n\n', o)
  assert.equal(o.model(), 'gpt-5.4')
  assert.equal(o.conflict(), false)
  const empty = new UpstreamObserver()
  observeSseText('data: {"choices":[]}\n\ndata: [DONE]\n\n: comment\n\nid: 7\n\n', empty)
  assert.equal(empty.model(), '')
})

test('超长模型名截断到上限', () => {
  const o = new UpstreamObserver()
  o.observe('  ' + '模'.repeat(MAX_MODEL_LENGTH + 1) + '  ', false)
  assert.equal([...o.model()].length, MAX_MODEL_LENGTH)
})

test('非流式 JSON 响应体', () => {
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

test('observeBody 按 content-type 分派', () => {
  const stream = new UpstreamObserver()
  observeBody('text/event-stream; charset=utf-8', 'data: {"model":"a/b"}\n\n', stream)
  assert.equal(stream.model(), 'a/b')
  const json = new UpstreamObserver()
  observeBody('application/json', '{"model":"c/d"}', json)
  assert.equal(json.model(), 'c/d')
  const other = new UpstreamObserver()
  observeBody('text/html', '{"model":"e/f"}', other)
  assert.equal(other.model(), '')
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

test('withObservedModel 只在缺失时补写，且形状不认识就原样返回', () => {
  const piAi = { response: { kind: 'pi-ai', version: 2, model: 'req' }, blocks: [] }
  const patched = withObservedModel(piAi, 'upstream/model')
  assert.equal(patched.response.responseModel, 'upstream/model')
  assert.equal(piAi.response.responseModel, undefined, '原对象不被修改')

  const hasValue = { response: { kind: 'pi-ai', version: 2, responseModel: 'native' } }
  assert.equal(withObservedModel(hasValue, 'upstream/model'), hasValue, '原生值优先')

  const deepseek = { response: { kind: 'deepseek-messages', version: 1, model: 'req' }, blocks: [] }
  assert.equal(withObservedModel(deepseek, 'upstream/model').response.responseModel, 'upstream/model')

  assert.equal(withObservedModel(piAi, ''), piAi, '没有观察值不改')
  const shapeless = { blocks: [] }
  assert.equal(withObservedModel(shapeless, 'x'), shapeless, '没有 response 对象不改')
  assert.equal(withObservedModel({ response: { model: 'req' } }, 'x').response.responseModel, undefined, '缺少 kind 不改')
})
