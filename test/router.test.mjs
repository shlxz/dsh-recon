import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeInput, makeEvidence, coverageOf } from '../lib/adapters/contract.js'
import { assumptionCost, interruptCost, gate } from '../lib/policy.js'
import { route } from '../lib/router.js'

function baseArgs(extra = {}) {
  return {
    gap_type: 'goal',
    decision_at_stake: '把登录页改成什么风格',
    reversibility: 'high',
    blast_radius: 'local',
    user_state: { busy: false, recently_corrected: false, idle_seconds: 600 },
    ...extra,
  }
}

function adapter(channel, { available = true, evidence = [], fields } = {}) {
  return {
    channel,
    async probe() {
      return { available, evidence, interruptCost: 0, fields }
    },
  }
}

const allDisabled = [
  adapter('read_trace', { available: false }),
  adapter('query_sensor', { available: false }),
  adapter('read_multimodal', { available: false }),
  adapter('structured_form', { available: false }),
  adapter('minimal_question', { available: false }),
  adapter('assume_and_flag'),
]

test('normalizeInput rejects unknown args and bad enums', () => {
  assert.throws(() => normalizeInput({ ...baseArgs(), bogus: 1 }), /unknown argument/)
  assert.throws(() => normalizeInput(baseArgs({ gap_type: 'nope' })), /gap_type/)
  assert.throws(() => normalizeInput(baseArgs({ reversibility: 'none' })), /reversibility/)
})

test('declared enums win over lexical inference', () => {
  const input = normalizeInput(
    baseArgs({ decision_at_stake: '删除生产数据库', reversibility: 'high', blast_radius: 'local' }),
  )
  assert.equal(input.reversibility, 'high')
  assert.equal(input.blast_radius, 'local')
  assert.equal(input.declared.reversibility, true)
  // inference would have said low/system — prove the fallback is not used
  assert.equal(input.inferred.reversibility, 'low')
  assert.equal(input.inferred.blast_radius, 'system')
})

test('lexical fallback applies only when enums are omitted', () => {
  const input = normalizeInput({ gap_type: 'goal', decision_at_stake: '删除生产数据库' })
  assert.equal(input.reversibility, 'low')
  assert.equal(input.blast_radius, 'system')
  assert.equal(input.declared.reversibility, false)
})

test('A: assumption cost is driven by enum, not wording', () => {
  const cheap = normalizeInput(baseArgs())
  const costly = normalizeInput(baseArgs({ reversibility: 'low', blast_radius: 'system' }))
  const a = assumptionCost(cheap, [])
  const b = assumptionCost(costly, [])
  assert.ok(b.value > a.value, `${b.value} should exceed ${a.value}`)
  assert.equal(a.source, 'declared')
})

test('B: partial evidence discounts assumption cost and can flip the gate', () => {
  const input = normalizeInput(
    baseArgs({
      gap_type: 'preference',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
    }),
  )
  const iCost = interruptCost(input.user_state)
  const before = assumptionCost(input, [])
  assert.equal(gate(before, iCost).prefer_assumption, false)

  const ev = [
    makeEvidence({ channel: 'read_trace', text: '用户此前说过：统一用 const', weight: 0.5 }),
    makeEvidence({ channel: 'read_trace', text: '上次同类决定被确认为 local', weight: 0.3 }),
  ]
  const after = assumptionCost(input, ev)
  assert.ok(after.value < before.value, 'evidence must lower the assumption cost')
  assert.ok(coverageOf(ev) > 0)
})

test('B: partial evidence is folded into the gate before any interruption', async () => {
  // Cheap decision + real but partial evidence: coverage stays below solveCoverage,
  // yet the discounted assumption is already cheaper than interrupting.
  const input = normalizeInput(
    baseArgs({
      gap_type: 'environment',
      decision_at_stake: '这个文件放在哪个目录',
      reversibility: 'high',
      blast_radius: 'local',
      user_state: { busy: false, idle_seconds: 0 },
    }),
  )
  const ev = [makeEvidence({ channel: 'read_trace', text: '工作区内已有 src/ 约定', weight: 0.5 })]
  const adapters = [
    adapter('read_trace', { evidence: ev }),
    adapter('query_sensor', { available: false }),
    adapter('read_multimodal', { available: false }),
    adapter('structured_form'),
    adapter('minimal_question'),
    adapter('assume_and_flag'),
  ]
  // solveCoverage raised so coverage 0.5 cannot short-circuit on "solved".
  const r = await route(input, adapters, null, { solveCoverage: 0.9 })
  assert.equal(r.strategy, 'assume_and_flag', 'discounted assumption must beat the question')
  assert.ok(r.ledgers.assumption.parts.coverage >= 0.5)
  assert.ok(r.ledgers.assumption.parts.discount > 0)
  assert.match(r.rationale, /assume/)
})

test('B: without evidence the same decision would have asked', async () => {
  const input = normalizeInput(
    baseArgs({
      gap_type: 'preference',
      reversibility: 'medium',
      blast_radius: 'module',
      user_state: { busy: false, idle_seconds: 1200 },
    }),
  )
  const r = await route(
    input,
    [
      adapter('read_trace', { evidence: [] }),
      adapter('query_sensor', { available: false }),
      adapter('read_multimodal', { available: false }),
      adapter('structured_form'),
      adapter('minimal_question'),
      adapter('assume_and_flag'),
    ],
    null,
    { solveCoverage: 0.9 },
  )
  assert.ok(['structured_form', 'minimal_question'].includes(r.strategy))
})

test('C: confidence never changes the routed strategy', async () => {
  const input = normalizeInput(baseArgs({ reversibility: 'low', blast_radius: 'system' }))
  const ledger = {
    priorFailures: () => 5,
    record() {},
  }
  const adapters = [
    adapter('read_trace', { available: false }),
    adapter('query_sensor', { available: false }),
    adapter('read_multimodal', { available: false }),
    adapter('structured_form'),
    adapter('minimal_question'),
    adapter('assume_and_flag'),
  ]
  const a = await route(input, adapters, null, {})
  const b = await route(input, adapters, ledger, { adaptiveConfidence: true })
  assert.equal(a.strategy, b.strategy)
  assert.ok(b.confidence < a.confidence, 'prior failures discount display confidence only')
})

test('read_trace evidence solves the gap without interrupting', async () => {
  const input = normalizeInput(baseArgs())
  const r = await route(
    input,
    [
      adapter('read_trace', {
        evidence: [
          makeEvidence({ channel: 'read_trace', plugin: 'dsh-core', text: '用户说：只要静态站点', weight: 0.7 }),
        ],
      }),
      ...allDisabled.slice(1),
    ],
    null,
    {},
  )
  assert.equal(r.strategy, 'read_trace')
  assert.equal(r.source_plugin, 'dsh-core')
  assert.equal(r.question_if_any, null)
})

test('unavailable channels fall through to minimal_question', async () => {
  const input = normalizeInput(
    baseArgs({ gap_type: 'goal', reversibility: 'low', blast_radius: 'system', user_state: { busy: false, idle_seconds: 1200 } }),
  )
  const adapters = [
    adapter('read_trace', { available: false }),
    adapter('query_sensor', { available: false }),
    adapter('read_multimodal', { available: false }),
    adapter('structured_form', { available: false }),
    adapter('minimal_question'),
    adapter('assume_and_flag'),
  ]
  const r = await route(input, adapters, null, {})
  assert.equal(r.strategy, 'minimal_question')
  assert.ok(r.question_if_any.known_context.includes('我目前') || r.question_if_any.known_context.length > 0)
})

test('no usable interrupt channel falls back to flagged assumption', async () => {
  const input = normalizeInput(baseArgs({ reversibility: 'low', blast_radius: 'system' }))
  const r = await route(
    input,
    [
      adapter('read_trace', { available: false }),
      adapter('query_sensor', { available: false }),
      adapter('read_multimodal', { available: false }),
      adapter('structured_form', { available: false }),
      adapter('minimal_question', { available: false }),
      adapter('assume_and_flag'),
    ],
    null,
    {},
  )
  assert.equal(r.strategy, 'assume_and_flag')
  assert.ok(r.assumption_if_any.label.includes('待确认'))
})

test('structured_form preferred over free-form when affordable', async () => {
  const input = normalizeInput(
    baseArgs({ gap_type: 'goal', reversibility: 'medium', blast_radius: 'module', user_state: { busy: false, idle_seconds: 30 } }),
  )
  const r = await route(
    input,
    [
      adapter('read_trace', { available: false }),
      adapter('query_sensor', { available: false }),
      adapter('read_multimodal', { available: false }),
      adapter('structured_form', { fields: [{ id: 'a', question: 'q' }] }),
      adapter('minimal_question'),
      adapter('assume_and_flag'),
    ],
    null,
    {},
  )
  assert.ok(['structured_form', 'minimal_question'].includes(r.strategy))
})

test('override is honored and explained', async () => {
  const input = normalizeInput(baseArgs({ override: { strategy: 'minimal_question', reason: 'user asked' } }))
  const r = await route(input, allDisabled.concat([adapter('minimal_question')]), null, {})
  assert.equal(r.strategy, 'minimal_question')
  assert.match(r.rationale, /override/)
})

test('recon_strategy_stats distribution shape', () => {
  const rows = [{ strategy: 'assume_and_flag' }, { strategy: 'assume_and_flag' }, { strategy: 'read_trace' }]
  const dist = {}
  for (const r of rows) dist[r.strategy] = (dist[r.strategy] || 0) + 1
  assert.equal(dist.assume_and_flag, 2)
})
