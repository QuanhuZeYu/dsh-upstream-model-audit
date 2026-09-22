import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createStreamListener, installFetchObserver } from '../lib/dev/host.js'

const frame = (event, payload) => 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n'
const responsesSse = (model, extra = {}) => [
  frame('response.created', { type: 'response.created', response: { id: 'resp_1', model } }),
  frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hi' }),
  frame('response.completed', { type: 'response.completed', response: { id: 'resp_1', model, ...extra } }),
].join('')

const piAiEnvelope = { response: { kind: 'pi-ai', version: 2, model: 'req' }, blocks: [] }

/**
 * 起假上游跑一条"适配器流"：流内部发真实 HTTP，返回全部 chunk 与收到的请求。
 * @param {{ path?: string, status?: number, contentType?: string|null, headers?: Record<string,string>, body?: string, requestModel?: string, extraRequests?: Array<{path: string, body: string, contentType: string}> }} options
 */
async function runStream(options = {}) {
  const {
    path = '/v1/responses', status = 200, contentType = 'text/event-stream',
    headers = {}, body = '', requestModel = 'deepseek-v4.1-flash', replayState = piAiEnvelope,
    omitReplayState = false, extraRequests = [],
  } = options
  const received = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      received.push({ url: req.url, body: raw })
      const extra = extraRequests.find(item => req.url.startsWith(item.path))
      const head = extra === undefined
        ? { ...(contentType === null ? {} : { 'content-type': contentType }), ...headers }
        : { 'content-type': extra.contentType }
      res.writeHead(status, head)
      res.end(extra === undefined ? body : extra.body)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const base = 'http://127.0.0.1:' + server.address().port
  const dispose = installFetchObserver()
  try {
    async function* adapter() {
      for (const extra of extraRequests) await (await fetch(base + extra.path, { method: 'POST', body: JSON.stringify({ model: 'count-model' }) })).text()
      const response = await fetch(base + path, { method: 'POST', body: JSON.stringify({ model: requestModel, messages: [] }) })
      const text = await response.text()
      yield { type: 'text-delta', index: 0, text }
      yield omitReplayState
        ? { type: 'finish', reason: { kind: 'stop' } }
        : { type: 'finish', reason: { kind: 'stop' }, replayState }
    }
    const chunks = []
    for await (const chunk of createStreamListener()({ provider: 'p', model: 'req' }, adapter)) chunks.push(chunk)
    return { chunks, received, finish: chunks.find(c => c.type === 'finish') }
  } finally {
    dispose()
    server.close()
  }
}

test('responses 通道：缺失的 responseModel 被补上，附带 upstreamAudit', async () => {
  const { chunks, finish } = await runStream({ body: responsesSse('deepseek/deepseek-v4.1-flash') })
  assert.equal(finish.replayState.response.responseModel, 'deepseek/deepseek-v4.1-flash')
  assert.equal(finish.replayState.response.upstreamAudit.sentModel, 'deepseek-v4.1-flash')
  assert.equal(finish.replayState.response.upstreamAudit.transport, 'sse')
  assert.match(chunks[0].text, /response\.completed/, '调用方那一支响应体不受影响')
})

test('服务档位随 responseModel 一起落进 audit', async () => {
  const { finish } = await runStream({ body: responsesSse('gpt-5.6-sol', { service_tier: 'fast' }) })
  assert.equal(finish.replayState.response.responseModel, 'gpt-5.6-sol')
  assert.equal(finish.replayState.response.upstreamAudit.serviceTier, 'priority')
})

test('上游自相矛盾时两个名字都留档', async () => {
  const body = frame('response.created', { type: 'response.created', response: { model: 'gpt-5.5' } }) +
    frame('response.completed', { type: 'response.completed', response: { model: 'gpt-5.4' } })
  const { finish } = await runStream({ body })
  assert.equal(finish.replayState.response.responseModel, 'gpt-5.4')
  assert.deepEqual(finish.replayState.response.upstreamAudit.variants, ['gpt-5.5', 'gpt-5.4'])
})

test('content-type 不可信时按内容嗅探', async () => {
  const { finish } = await runStream({ contentType: 'text/plain', body: responsesSse('sse/sniffed') })
  assert.equal(finish.replayState.response.responseModel, 'sse/sniffed')
})

test('响应体没有声明时用响应头兜底', async () => {
  const { finish } = await runStream({
    body: frame('response.completed', { type: 'response.completed', response: { id: 'resp_1' } }),
    headers: { 'x-upstream-model': 'header/model' },
  })
  assert.equal(finish.replayState.response.responseModel, 'header/model')
})

test('失败响应（5xx）的声明不采纳', async () => {
  const { finish } = await runStream({ status: 503, contentType: 'application/json', body: JSON.stringify({ model: 'failed/model' }) })
  assert.equal(finish.replayState.response.responseModel, undefined)
})

test('同一调用内失败尝试在前、成功尝试在后时采纳成功那次', async () => {
  const body = responsesSse('ok/model')
  const { finish } = await runStream({ body })
  assert.equal(finish.replayState.response.responseModel, 'ok/model')
})

test('计数/目录类端点不参与观察', async () => {
  const { finish } = await runStream({
    body: frame('response.completed', { type: 'response.completed', response: { id: 'resp_1' } }),
    extraRequests: [{ path: '/v1/messages/count_tokens', body: JSON.stringify({ model: 'count/model' }), contentType: 'application/json' }],
  })
  assert.equal(finish.replayState.response.responseModel, undefined)
})

test('上游没有声明模型名时不补（不猜）', async () => {
  const { finish } = await runStream({ body: 'data: {"type":"response.output_text.delta","delta":"hi"}\n\n' })
  assert.equal(finish.replayState.response.responseModel, undefined)
  assert.equal(finish.replayState, piAiEnvelope, '未补写时沿用原对象')
})

test('原生值优先：已有 responseModel 时不覆盖', async () => {
  const native = { response: { kind: 'pi-ai', version: 2, model: 'req', responseModel: 'native/model' }, blocks: [] }
  const { finish } = await runStream({ body: responsesSse('deepseek/deepseek-v4.1-flash'), replayState: native })
  assert.equal(finish.replayState.response.responseModel, 'native/model')
})

test('自研 deepseek-messages envelope 同样能补，其余字段不动', async () => {
  const deepseek = { response: { kind: 'deepseek-messages', version: 1, model: 'req' }, blocks: [{ type: 'text' }] }
  const { finish } = await runStream({ body: responsesSse('deepseek/deepseek-v4.1-flash'), replayState: deepseek })
  assert.equal(finish.replayState.response.responseModel, 'deepseek/deepseek-v4.1-flash')
  assert.equal(finish.replayState.response.kind, 'deepseek-messages')
  assert.deepEqual(finish.replayState.blocks, [{ type: 'text' }])
})

test('没有 replayState 的 finish 原样透传', async () => {
  const { finish } = await runStream({ body: responsesSse('deepseek/deepseek-v4.1-flash'), omitReplayState: true })
  assert.equal(finish.replayState, undefined)
})

test('卸载后 globalThis.fetch 还原，且流不再改写', async () => {
  const before = globalThis.fetch
  const dispose = installFetchObserver()
  assert.notEqual(globalThis.fetch, before)
  dispose()
  assert.equal(globalThis.fetch, before)
})
