import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { createStreamListener, installFetchObserver } from '../lib/dev/host.js'

const frames = (model) => [
  'event: response.created\ndata: ' + JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model } }) + '\n\n',
  'event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) + '\n\n',
  'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', model } }) + '\n\n',
]

/** 起一个假上游，跑一条"适配器流"（流内部发一次真实 HTTP），返回全部 chunk。 */
async function runStream(responseFrames, replayState) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of responseFrames) res.write(frame)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/responses'
  const dispose = installFetchObserver()
  try {
    async function* adapter() {
      const response = await fetch(url, { method: 'POST', body: JSON.stringify({ model: 'req' }) })
      const text = await response.text()
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState }
    }
    const chunks = []
    for await (const chunk of createStreamListener()({ provider: 'p', model: 'req' }, adapter)) chunks.push(chunk)
    return chunks
  } finally {
    dispose()
    server.close()
  }
}

const piAiEnvelope = { response: { kind: 'pi-ai', version: 2, model: 'req' }, blocks: [] }

test('fetch 旁路观察 + finish 补写：responses 通道缺失的 responseModel 被补上', async () => {
  const chunks = await runStream(frames('deepseek/deepseek-v4.1-flash'), piAiEnvelope)
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.replayState.response.responseModel, 'deepseek/deepseek-v4.1-flash')
  assert.equal(finish.reason.kind, 'stop', '其余字段原样保留')
  assert.match(chunks[0].text, /response\.completed/, '调用方那一支响应体不受影响')
})

test('上游没有声明模型名时不补（不猜）', async () => {
  const chunks = await runStream([
    'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }) + '\n\n',
  ], piAiEnvelope)
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.replayState.response.responseModel, undefined)
  assert.equal(finish.replayState, piAiEnvelope, '未补写时沿用原对象')
})

test('原生值优先：已有 responseModel 时不覆盖', async () => {
  const native = { response: { kind: 'pi-ai', version: 2, model: 'req', responseModel: 'native/model' }, blocks: [] }
  const chunks = await runStream(frames('deepseek/deepseek-v4.1-flash'), native)
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.replayState, native)
})

test('自研 deepseek-messages envelope 同样能补，其余字段不动', async () => {
  const deepseek = { response: { kind: 'deepseek-messages', version: 1, model: 'req' }, blocks: [{ type: 'text' }] }
  const chunks = await runStream(frames('deepseek/deepseek-v4.1-flash'), deepseek)
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.replayState.response.responseModel, 'deepseek/deepseek-v4.1-flash')
  assert.deepEqual(finish.replayState.response.kind, 'deepseek-messages')
  assert.deepEqual(finish.replayState.blocks, [{ type: 'text' }])
})

test('没有 replayState 的 finish 原样透传', async () => {
  const chunks = await runStream(frames('deepseek/deepseek-v4.1-flash'), undefined)
  const finish = chunks.find((c) => c.type === 'finish')
  assert.equal(finish.replayState, undefined)
})

test('卸载后 globalThis.fetch 还原，且流不再改写', async () => {
  const before = globalThis.fetch
  const dispose = installFetchObserver()
  assert.notEqual(globalThis.fetch, before)
  dispose()
  assert.equal(globalThis.fetch, before)
})
