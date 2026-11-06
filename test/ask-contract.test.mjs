// ask-answer contract: the OTHER half of the form channel.
//
// "structured_form runs" is only half-true if the answer never becomes Evidence.
// This test drives the real adapter against a fake `ctx.userQuestions.ask` that
// returns Host-shaped answers, and asserts the answer lands in the next round's
// known_evidence — normalized to the Evidence contract, not left as raw Host JSON.
//
// Host answer shape (verified against the user-questions subsystem docs):
//   { answers: [{ id, selected: string[], custom?: string }] }

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'
import { createFormAdapter } from '../lib/adapters/form.js'
import { createQuestionAdapter } from '../lib/adapters/question.js'
import { coverageOf, normalizeInput } from '../lib/adapters/contract.js'

function fakeCtx({ askImpl, askThrows = false } = {}) {
  const registered = []
  const services = new Map()
  const calls = []
  services.set('sessionQuery', { async readSurface() { return { events: [] } } })
  services.set('sessions', { get: () => undefined })
  services.set('sessionProjections', { stateOf: () => undefined })
  services.set('agents', { roots: () => [{ id: 's1' }], isOwnedBy: () => false })
  services.set('userQuestions', {
    async ask(request) {
      calls.push(request)
      if (askThrows) throw Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' })
      return askImpl(request)
    },
  })
  services.set('tools', { get: () => undefined })
  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: () => {},
    logger: () => ({ warn() {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }
  return { ctx, registered, calls }
}

const goalArgs = {
  gap_type: 'goal',
  decision_at_stake: '选哪个前端框架',
  reversibility: 'low',
  blast_radius: 'system',
  user_state: { busy: false, idle_seconds: 3600 },
}

/** Normalized input for direct adapter probing (adapters never take raw args). */
const goalInput = normalizeInput(goalArgs)

test('form answer → Evidence: custom text becomes a weighted evidence item', async () => {
  const seen = []
  const { ctx } = fakeCtx({
    askImpl: async (req) => {
      seen.push(req)
      return { answers: [{ id: 'decision', selected: [], custom: '用 Vue，但要能静态导出' }] }
    },
  })
  const adapter = createFormAdapter({ ctx, agent: { id: 's1' }, config: {} })
  const probe = await adapter.probe(goalInput)
  assert.equal(probe.available, true)

  const act = await adapter.act(goalInput, { ...probe, known_context: '我已知：仓库已有 CI。' })
  assert.equal(act.evidence.length, 1)
  const item = act.evidence[0]
  assert.equal(item.channel, 'structured_form')
  assert.equal(item.tool, 'userQuestions.ask')
  assert.match(item.text, /Vue/)
  assert.equal(item.weight, 0.5)
  assert.equal(item.verified, true, 'a real human answer is verified by definition')
  assert.ok(item.ref.startsWith('answer:'))

  // The question actually carried the known-context (never re-asks what we know).
  assert.match(seen[0].questions[0].detail || '', /我已知：仓库已有 CI/)
  assert.equal(seen[0].agent.id, 's1')
})

test('form answer → Evidence: selected labels are joined, empty answers yield nothing', async () => {
  const { ctx } = fakeCtx({
    askImpl: async () => ({
      answers: [
        { id: 'decision', selected: ['Typora', '静态导出'] },
        { id: 'outcome', selected: [], custom: '' },
      ],
    }),
  })
  const adapter = createFormAdapter({ ctx, agent: { id: 's1' }, config: {} })
  const probe = await adapter.probe(goalInput)
  const act = await adapter.act(goalInput, probe)
  assert.equal(act.evidence.length, 1, 'only the non-empty answer becomes evidence')
  assert.match(act.evidence[0].text, /Typora\/静态导出/)
})

test('minimal_question answer → Evidence with the same contract', async () => {
  const seen = []
  const { ctx } = fakeCtx({
    askImpl: async (req) => {
      seen.push(req)
      return { answers: [{ id: 'gap', selected: [], custom: '只要 3 个候选' }] }
    },
  })
  const adapter = createQuestionAdapter({ ctx, agent: { id: 's1' }, config: {} })
  const probe = await adapter.probe(goalInput)
  assert.equal(probe.available, true)
  const act = await adapter.act(goalInput, { ...probe, ask: '要几个候选？', known_context: '' })
  assert.equal(act.evidence.length, 1)
  assert.equal(act.evidence[0].channel, 'minimal_question')
  assert.match(act.evidence[0].text, /3 个候选/)
  assert.equal(seen[0].questions.length, 1, 'minimal_question asks exactly one question')
})

test('mode:act answer is added to known_evidence of the NEXT call', async () => {
  const answers = ['用 Vue']
  const env = fakeCtx({
    askImpl: async () => ({ answers: [{ id: 'decision', selected: [], custom: answers[0] }] }),
  })
  apply(env.ctx, {})
  const def = env.registered.find((d) => d.name === 'route_info_gap')

  // 1st call in act mode: routes to a question channel and performs the ask.
  const first = await def.execute(
    { ...goalArgs, mode: 'act' },
    { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) },
  )
  assert.ok(env.calls.length >= 1, 'ask must actually be called in act mode')
  assert.ok(first.evidence.some((e) => /Vue/.test(e.text)),
    'the answer must be folded into this call evidence')

  // 2nd call: the model passes what it learned as known_evidence. The router must
  // treat it as evidence (lower weight, unverified) and discount the assumption.
  const second = await def.execute(
    {
      ...goalArgs,
      known_evidence: [{ text: answers[0], channel: 'structured_form' }],
    },
    { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) },
  )
  assert.ok(second.evidence.some((e) => /Vue/.test(e.text)))
  assert.ok(coverageOf(second.evidence) > 0)
  assert.ok(second.ledgers.assumption.parts.discount > 0,
    'a carried-over answer must discount the assumption cost')
})

test('ask failure degrades to flagged assumption instead of hanging', async () => {
  const env = fakeCtx({ askThrows: true })
  apply(env.ctx, {})
  const def = env.registered.find((d) => d.name === 'route_info_gap')
  const result = await def.execute(
    { ...goalArgs, mode: 'act' },
    { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) },
  )
  assert.ok(['assume_and_flag', 'structured_form', 'minimal_question'].includes(result.strategy))
  if (result.strategy === 'assume_and_flag') {
    assert.ok(result.assumption_if_any.text)
  } else {
    assert.match(result.rationale, /act failed/)
  }
})

test('structured_form is explicitly unavailable for environment/acceptance', async () => {
  const { ctx } = fakeCtx({ askImpl: async () => ({ answers: [] }) })
  const adapter = createFormAdapter({ ctx, agent: { id: 's1' }, config: {} })
  for (const gap_type of ['environment', 'acceptance']) {
    const probe = await adapter.probe({ ...goalInput, gap_type })
    assert.equal(probe.available, false, `${gap_type} must not pretend to have structured fields`)
    assert.match(probe.reason, /no structured fields configured/)
  }
  // ...while the three supported types stay available.
  for (const gap_type of ['goal', 'constraint', 'preference']) {
    const probe = await adapter.probe({ ...goalInput, gap_type })
    assert.equal(probe.available, true, `${gap_type} must have structured fields`)
  }
})
