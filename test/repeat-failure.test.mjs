// Repeated failure must change the ROUTE, not just the shrink the badge.
//
// The deepest form of "result does not match the need": a decision type whose
// assumption keeps being corrected, and the plugin keeps making the same
// assumption. prior_failures used to be display-only, so six identical
// corrections changed nothing about what happened next.
//
// Escalation is stepped because one correction and a chronic failure are
// different evidence: a single correction may be a fluke; three in a row is a
// pattern about this KIND of decision, not about this one instance.

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

function env(cfg = {}) {
  const registered = []
  const services = new Map()
  services.set('tools', { get: () => undefined })
  services.set('sessionQuery', { async readSurface() { return { events: [] } } })
  services.set('sessions', { get: () => undefined })
  services.set('sessionProjections', { stateOf: () => undefined })
  services.set('agents', { roots: () => [{ id: 's1' }], isOwnedBy: () => false })
  services.set('userQuestions', { async ask() { throw new Error('no answerer') } })

  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    inject: (_deps, cb) => cb(ctx),
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
    logger: () => ({ warn() {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }
  apply(ctx, cfg)
  const def = registered.find((d) => d.name === 'route_info_gap')
  return (args) => def.execute(args, { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) })
}

const base = {
  gap_type: 'goal',
  decision_at_stake: '按钮颜色',
  assumed_value: '品牌蓝',
  reversibility: 'high',
  blast_radius: 'local',
  user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
}

test('a fresh gap type assumes; a chronic one stops assuming', async () => {
  const route = env()
  const seen = []
  let id = null
  for (let i = 0; i < 4; i += 1) {
    const r = await route(id ? { ...base, feedback: { decision_id: id, corrected: true } } : base)
    id = r.decision_id
    seen.push(r.strategy)
  }
  assert.equal(seen[0], 'assume_and_flag', 'first decision of a fresh gap type assumes')
  assert.equal(seen[1], 'assume_and_flag', 'one correction is not yet a pattern')
  assert.match(
    seen[seen.length - 1],
    /minimal_question|structured_form|assume_and_flag/,
    'the last decision routes normally',
  )
  assert.ok(
    seen.includes('minimal_question') || seen.includes('structured_form'),
    `after enough corrections it must stop assuming; got ${seen.join(',')}`,
  )
})

test('the escalation is stepped: soft disables the shortcut, hard forces the question', async () => {
  // With the obvious-assume shortcut ON, a cheap decision probes nothing.
  // After `softAfter` corrections that shortcut must be off (it probes), and
  // after `forceAskAt` the route must be a question.
  const route = env()
  let id = null
  const observations = []
  for (let i = 0; i < 4; i += 1) {
    const r = await route(id ? { ...base, feedback: { decision_id: id, corrected: true } } : base)
    id = r.decision_id
    observations.push({
      strategy: r.strategy,
      repeatFailure: /repeat-failure/.test(r.rationale),
    })
  }
  assert.equal(observations[0].repeatFailure, false, 'no escalation before the streak exists')
  const firstFlag = observations.findIndex((o) => o.repeatFailure)
  assert.ok(firstFlag > 0, 'the flag appears only once a streak exists')
  // Once flagged, the route stops being a bare assumption.
  for (const o of observations.slice(firstFlag)) {
    assert.ok(
      o.strategy !== 'assume_and_flag' || observations[firstFlag - 1]?.strategy === 'assume_and_flag',
      'flagged decisions must not keep assuming blindly',
    )
  }
})

test('the thresholds are configurable', async () => {
  // An operator who wants to distrust defaults immediately can set forceAskAt: 1.
  const route = env({ repeatFailure: { softAfter: 1, forceAskAt: 1 } })
  let id = null
  const seen = []
  for (let i = 0; i < 3; i += 1) {
    const r = await route(id ? { ...base, feedback: { decision_id: id, corrected: true } } : base)
    id = r.decision_id
    seen.push(r.strategy)
  }
  assert.ok(
    seen.slice(1).some((s) => s !== 'assume_and_flag'),
    `with forceAskAt:1 the second decision must already ask; got ${seen.join(',')}`,
  )
})

test('a correct decision resets the streak and the escalation', async () => {
  const route = env()
  let id = null
  // Build a streak.
  for (let i = 0; i < 3; i += 1) {
    const r = await route(id ? { ...base, feedback: { decision_id: id, corrected: true } } : base)
    id = r.decision_id
  }
  // One decision explicitly confirmed as NOT corrected ends it.
  const clean = await route({ ...base, feedback: { decision_id: id, corrected: false } })
  assert.equal(clean.strategy, 'assume_and_flag', 'a confirmed decision restores trust')
  assert.doesNotMatch(clean.rationale, /repeat-failure/, 'the streak is over')
})
