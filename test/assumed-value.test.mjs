// `assumed_value`: the assumption must name a choice, not restate the question.
//
// Reported defect: the card said "按此假设执行 按最小可逆的方案先做" without naming
// any option, so a model asking about "HTML vs pygame" could only repeat the
// question back under a "assumed" heading. A question wearing a decision's
// clothes is worse than an honest question.

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeInput, findDeferral, MAX_ASSUMED_VALUE_LENGTH } from '../lib/adapters/contract.js'
import { assumptionText } from '../lib/router.js'

const base = { gap_type: 'goal', decision_at_stake: '贪吃蛇的实现形态' }

test('a concrete default is accepted and carried through', () => {
  const input = normalizeInput({ ...base, assumed_value: '单文件 HTML，键盘操控，无音效' })
  assert.equal(input.assumed_value, '单文件 HTML，键盘操控，无音效')
})

test('an omitted default is null, not invented', () => {
  const input = normalizeInput(base)
  assert.equal(input.assumed_value, null)
})

test('deferred values are rejected with a reason the model can act on', () => {
  const cases = ['待定', '未定', '取决于你想怎么做', '看情况', '你决定', 'TBD', 'it depends']
  for (const value of cases) {
    assert.throws(
      () => normalizeInput({ ...base, assumed_value: value }),
      /looks deferred/,
      `"${value}" must be rejected`,
    )
  }
})

test('a question is rejected even when phrased as a preference', () => {
  for (const value of ['html 还是 pygame？', '要音效吗', '单文件还是桌面版']) {
    assert.throws(() => normalizeInput({ ...base, assumed_value: value }), /looks deferred/)
  }
})

test('an empty or whitespace default is rejected', () => {
  for (const value of ['', '   ']) {
    assert.throws(() => normalizeInput({ ...base, assumed_value: value }), /must not be empty/)
  }
})

test('a default that restates the whole brief is rejected', () => {
  const long = '单文件 HTML'.padEnd(MAX_ASSUMED_VALUE_LENGTH + 10, '，还有更多细节')
  assert.throws(() => normalizeInput({ ...base, assumed_value: long }), /at most/)
})

test('findDeferral reports what it matched, not just true', () => {
  assert.equal(findDeferral('单文件 HTML'), null)
  assert.equal(findDeferral('待定'), '待定')
  // A bare question mark and an interrogative particle are different shapes.
  assert.equal(findDeferral('要音效吗？'), '问号')
  assert.equal(findDeferral('要音效吗'), '疑问语气')
  assert.equal(findDeferral('单文件还是桌面版'), '二选一未定')
})

test('assumptionText prefers the model default over the config fallback', () => {
  const input = normalizeInput({ ...base, assumed_value: '单文件 HTML' })
  const a = assumptionText(input, { assumptionDefaults: { goal: '配置里的默认' } })
  assert.equal(a.text, '单文件 HTML')
  assert.equal(a.source, 'model')
})

test('assumptionText falls back to the config default when the model gave none', () => {
  const input = normalizeInput(base)
  const a = assumptionText(input, { assumptionDefaults: { goal: '配置里的默认' } })
  assert.equal(a.text, '配置里的默认')
  assert.equal(a.source, 'config')
})

test('assumptionText admits a missing default instead of bluffing', () => {
  const a = assumptionText(normalizeInput(base), {})
  assert.equal(a.text, null)
  assert.equal(a.source, 'missing')
  assert.match(a.guidance, /assumed_value/, 'the guidance must name the fix')
  assert.doesNotMatch(a.guidance, /按最小可逆的方案先做/, 'the old template must be gone')
})

test('the label always names the decision, whatever the source', () => {
  for (const input of [
    normalizeInput({ ...base, assumed_value: '单文件 HTML' }),
    normalizeInput(base),
  ]) {
    const a = assumptionText(input, {})
    assert.match(a.label, /待确认（goal）/, 'the flag stays visible')
    assert.match(a.label, /贪吃蛇的实现形态/, 'and names what is unconfirmed')
  }
})
