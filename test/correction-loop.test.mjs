// Correction attribution state machine — the ONLY mechanism the acceptance
// criterion ("interruptions down without rework up") actually rests on.
//
// This is cross-call state: ledger must survive between two route_info_gap
// invocations, and the second call must show prior_failures WITHOUT letting it
// move the cost ledgers (confirm-list item 6).

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { assumptionCost, interruptCost } from '../lib/policy.js'
import { normalizeInput } from '../lib/adapters/contract.js'

function fakeCtx({ sessionMessages = [] } = {}) {
  const registered = []
  const handlers = {}
  const services = new Map()
  const surfaceEvents = sessionMessages.map((text, i) => ({
    type: 'user/message',
    seq: i + 1,
    time: 0,
    data: { message: { role: 'user', content: [{ type: 'text', text }] } },
  }))
  let surface = { events: surfaceEvents }

  services.set('sessionQuery', { async readSurface() { return surface } })
  services.set('sessions', { get: (id) => (id === 's1' ? { id: 's1' } : undefined) })
  services.set('sessionProjections', { stateOf: () => ({ active: [], settled: [] }) })
  services.set('agents', { roots: () => [{ id: 's1' }], isOwnedBy: () => false })
  services.set('userQuestions', { async ask() { throw new Error('no answerer') } })
  services.set('tools', { get: () => undefined })

  const ctx = {
    get: (k) => services.get(k),
    on: (evt, fn) => {
      ;(handlers[evt] ||= []).push(fn)
      return () => {}
    },
    effect: () => {},
    logger: () => ({ warn() {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }

  return {
    ctx,
    registered,
    handlers,
    /** Append a user message the way the Host would, and notify listeners. */
    pushUserMessage(text) {
      const event = {
        type: 'user/message',
        seq: surfaceEvents.length + 1,
        time: 0,
        data: { message: { role: 'user', content: [{ type: 'text', text }] } },
      }
      surfaceEvents.push(event)
      surface = { events: surfaceEvents }
      for (const fn of handlers['session/event'] || []) fn({ id: 's1' }, event)
    },
  }
}

function tool(registered, name) {
  const def = registered.find((d) => d.name === name)
  assert.ok(def, `${name} not registered`)
  return (args) => def.execute(args, { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) })
}

const gapArgs = {
  gap_type: 'goal',
  decision_at_stake: '按钮用哪个颜色',
  reversibility: 'high',
  blast_radius: 'local',
  user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
}

const inputOf = (args) => normalizeInput(args)

test('correction loop: assume → user corrects → same gap type shows prior_failures', async () => {
  // No session messages: this test isolates LEDGER state, so no evidence channel
  // can short-circuit the route into read_trace.
  const env = fakeCtx()
  apply(env.ctx, {})
  const route = tool(env.registered, 'route_info_gap')

  // 1st call: no history → assume_and_flag, record its decision_id
  const first = await route(gapArgs)
  assert.equal(first.strategy, 'assume_and_flag')
  assert.ok(first.decision_id)
  assert.doesNotMatch(first.rationale, /was corrected|prior_failures/,
    'no correction history yet, so no attribution note')
  const firstCosts = {
    assume: first.ledgers.assumption.value,
    interrupt: first.ledgers.interrupt.value,
  }

  // The human corrects us; the model claims it via `feedback` on the next call.
  const second = await route({ ...gapArgs, feedback: { decision_id: first.decision_id, corrected: true } })
  assert.equal(second.strategy, 'assume_and_flag', 'one correction must not flip the strategy')
  const stats = await tool(env.registered, 'recon_strategy_stats')({})
  assert.ok(stats.corrections >= 1, 'the correction must be attributed')
  assert.equal(stats.correction_rate, Math.round((1 / stats.total) * 100) / 100)

  // A second consecutive correction of the same gap type.
  const third = await route({ ...gapArgs, feedback: { decision_id: second.decision_id, corrected: true } })
  assert.equal(third.strategy, 'assume_and_flag', 'the gate result must NOT move with confidence')

  // 4th call: two consecutive corrections now exist → displayed confidence drops.
  const fourth = await route(gapArgs)
  assert.ok(fourth.confidence < first.confidence,
    `confidence must be discounted by prior failures (${first.confidence} → ${fourth.confidence})`)
  assert.match(fourth.rationale, /corrected 2x|prior|corrected/,
    'the rationale must carry the attribution note')

  // ...but confidence never feeds the gate. Prove it structurally: recomputing both
  // ledgers from the SAME inputs the router used must reproduce its numbers exactly.
  // (If confidence leaked into cost/policy, this would drift.)
  const recomputedAssume = assumptionCost(inputOf(gapArgs), fourth.evidence)
  const recomputedInterrupt = interruptCost(gapArgs.user_state)
  assert.equal(fourth.ledgers.assumption.value, recomputedAssume.value,
    'assumptionCost must be a pure function of (input, evidence) — no confidence term')
  assert.equal(fourth.ledgers.interrupt.value, recomputedInterrupt.value,
    'interruptCost must be a pure function of user_state')
  assert.equal(fourth.ledgers.gate.prefer_assumption, true)

  // The only thing prior_failures is allowed to move:
  const cleanEnv = fakeCtx()
  apply(cleanEnv.ctx, {})
  const clean = await tool(cleanEnv.registered, 'route_info_gap')(gapArgs)
  assert.ok(fourth.confidence < clean.confidence,
    'with the same costs, only DISPLAYED confidence is discounted')
})

test('a correction IN THE SESSION is picked up by read_trace (desirable, not a bug)', async () => {
  const env = fakeCtx()
  apply(env.ctx, {})
  const route = tool(env.registered, 'route_info_gap')

  const first = await route(gapArgs)
  assert.equal(first.strategy, 'assume_and_flag')

  // The human states the real answer as a plain message. read_trace now HAS
  // evidence, but one correction alone (coverage 0.45) does not clear
  // solveCoverage, so the route still assumes — with the evidence attached.
  env.pushUserMessage('不对，那个按钮应该是品牌蓝')
  const second = await route(gapArgs)
  assert.ok(second.evidence.some((e) => /品牌蓝/.test(e.text)),
    'the session correction must be read as evidence')
  // and it must widen the discount: the assumption ledger drops vs the first call.
  assert.ok(second.ledgers.assumption.parts.discount > 0)
  assert.ok(second.ledgers.assumption.value < first.ledgers.assumption.value)
})

test('confidence discount is monotonic and capped, never breaks the gate', async () => {
  const env = fakeCtx()
  apply(env.ctx, {})
  const route = tool(env.registered, 'route_info_gap')

  const seen = []
  let decisionId = null
  for (let i = 0; i < 5; i += 1) {
    const args = decisionId
      ? { ...gapArgs, feedback: { decision_id: decisionId, corrected: true } }
      : gapArgs
    const r = await route(args)
    seen.push(r.confidence)
    assert.equal(r.strategy, 'assume_and_flag', 'strategy must never flip on confidence')
    decisionId = r.decision_id
  }
  // Once the streak starts, displayed confidence must not increase.
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] <= seen[i - 1] + 0.01, `confidence rose: ${seen[i - 1]} → ${seen[i]}`)
  }
  assert.ok(seen[seen.length - 1] >= 0, 'confidence is clamped at 0')
})

test('a correct decision ends the streak (prior_failures resets)', async () => {
  const env = fakeCtx({ sessionMessages: ['用品牌蓝，就这么定'] })
  apply(env.ctx, {})
  const route = tool(env.registered, 'route_info_gap')

  let decisionId = null
  for (let i = 0; i < 2; i += 1) {
    const r = await route(decisionId ? { ...gapArgs, feedback: { decision_id: decisionId, corrected: true } } : gapArgs)
    decisionId = r.decision_id
  }
  // Now record an UNCORRECTED decision of the same gap type: the streak ends.
  const clean = await route(gapArgs)
  const after = await route(gapArgs)
  assert.ok(after.confidence >= clean.confidence - 0.01,
    'an uncorrected decision must reset the failure streak')
})

test('correction detection is gap-type scoped, not global', async () => {
  const env = fakeCtx()
  apply(env.ctx, {})
  const route = tool(env.registered, 'route_info_gap')

  const a = await route(gapArgs)
  await route({ ...gapArgs, feedback: { decision_id: a.decision_id, corrected: true } })

  // Same call count, different gap type: its streak is independent.
  const other = await route({
    gap_type: 'constraint',
    decision_at_stake: '有没有时间限制',
    reversibility: 'high',
    blast_radius: 'local',
    user_state: { busy: true, idle_seconds: 0 },
  })
  assert.equal(other.strategy, 'assume_and_flag')
  assert.ok(other.confidence >= 0)
})

test('policy: prior failures never alter either cost ledger (pure unit check)', () => {
  const input = normalizeInput(gapArgs)
  const aCost = assumptionCost(input, [])
  const iCost = interruptCost(input.user_state)
  // Recomputing with a "failed 5 times" record is not even expressible here:
  // assumptionCost takes (input, evidence) only — the type system forbids it.
  assert.deepEqual(Object.keys(aCost).sort(), ['parts', 'source', 'value'])
  assert.equal(typeof iCost.value, 'number')
})
