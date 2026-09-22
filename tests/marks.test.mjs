/**
 * 纯判定逻辑的行为规格：只构造事件，不启动 harness。
 * 运行前需要先构建 lib/dev（pnpm run build）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditOf, markOf, readReportedModel } from '../lib/dev/marks.js'

const message = (turn, step, model, responseModel) => ({
  type: 'assistant/message',
  data: {
    turn,
    step,
    message: {
      id: 'm' + turn + '-' + step,
      source: {
        kind: 'model',
        provider: 'newapi',
        model,
        ...(responseModel === undefined ? {} : {
          replayState: { response: { kind: 'pi-ai', version: 2, api: 'openai-completions', model, responseModel } },
        }),
      },
    },
  },
})

test('厂商前缀形式照实记录，两个名字都原样保留', () => {
  assert.deepEqual(auditOf(message(1, 0, 'mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro')), {
    turn: 1, step: 0, requested: 'mimo-v2.6-pro', reported: 'xiaomi/mimo-v2.6-pro', mark: 'prefixed',
  })
})

test('逐字相同不产出记录（没有可呈现的差异）', () => {
  assert.equal(auditOf(message(1, 0, 'claude-opus-5', 'claude-opus-5')), null)
})

test('换模型照实记为 different（不做族匹配、不剥后缀）', () => {
  assert.equal(auditOf(message(1, 0, 'claude-fable-5', 'claude-opus-5'))?.mark, 'different')
})

test('日期快照后缀照实记为 different，不降级', () => {
  assert.equal(auditOf(message(1, 0, 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'))?.mark, 'different')
})

test('上游未声明模型名时不产出记录', () => {
  assert.equal(auditOf(message(1, 0, 'deepseek-v4.1-flash', undefined)), null)
})

test('非 assistant/message 与非 model 来源一律忽略', () => {
  assert.equal(auditOf(null), null)
  assert.equal(auditOf({ type: 'step/end', data: { turn: 1, step: 0 } }), null)
  assert.equal(auditOf({ type: 'assistant/message', data: { turn: 1, step: 0, message: { id: 'x', source: { kind: 'user' } } } }), null)
})

test('防御未知 replayState 形状', () => {
  assert.equal(readReportedModel(undefined), null)
  assert.equal(readReportedModel({}), null)
  assert.equal(readReportedModel({ response: null }), null)
  assert.equal(readReportedModel({ response: { responseModel: 42 } }), null)
  assert.equal(readReportedModel({ response: { responseModel: '' } }), null)
  assert.equal(readReportedModel({ response: { responseModel: 'xiaomi/mimo-v2.6-pro' } }), 'xiaomi/mimo-v2.6-pro')
})

test('markOf 的三态口径', () => {
  assert.equal(markOf('a', 'a'), 'identical')
  assert.equal(markOf('a', 'x/a'), 'prefixed')
  assert.equal(markOf('x/a', 'a'), 'prefixed')
  assert.equal(markOf('a', 'a/b'), 'different')
  assert.equal(markOf('mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro'), 'prefixed')
})
