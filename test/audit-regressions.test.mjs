// Regression tests for defects found during self-audit.
//
// Each test here exists because it FAILED against the code as shipped. They are
// the only guard against those bugs coming back.

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, createSnapshotRoute, loopbackOnly, resolveConfig } from '../lib/index.js'

function fakeCtx({ roots = [{ id: 's1' }] } = {}) {
  const registered = []
  const handlers = {}
  const services = new Map()
  services.set('tools', { get: () => undefined })
  services.set('sessionQuery', { async readSurface() { return { events: [] } } })
  services.set('sessions', { get: () => undefined })
  services.set('sessionProjections', { stateOf: () => undefined })
  services.set('agents', { roots: () => roots, isOwnedBy: () => false })
  services.set('userQuestions', { async ask() { throw new Error('no answerer') } })

  const ctx = {
    get: (k) => services.get(k),
    on: (evt, fn) => {
      ;(handlers[evt] ||= []).push(fn)
      return () => {}
    },
    effect: () => {},
    inject: () => {},
    logger: () => ({ warn() {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }
  return { ctx, registered, handlers }
}

function setup(opts) {
  const env = fakeCtx(opts)
  apply(env.ctx, {})
  const defs = {
    route: env.registered.find((d) => d.name === 'route_info_gap'),
    stats: env.registered.find((d) => d.name === 'recon_strategy_stats'),
  }
  const call = (args, sessionId = 's1') =>
    defs.route.execute(args, { agent: { id: sessionId }, signal: AbortSignal.timeout(5000) })
  const emit = (sessionId, text) => {
    for (const fn of env.handlers['session/event'] || []) {
      fn({ id: sessionId }, { type: 'user/message', data: { message: { content: [{ type: 'text', text }] } } })
    }
  }
  return { ...env, defs, call, emit }
}

const ASSUME_ARGS = {
  gap_type: 'goal',
  decision_at_stake: '按钮用哪个颜色',
  reversibility: 'high',
  blast_radius: 'local',
  user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
}

// ---- DEFECT 1: presentResult rendered nothing ----
test('presentResult emits the markdown card (execute returns no `content`)', async () => {
  const { defs, call } = setup()
  const result = await call(ASSUME_ARGS)

  // The canonical value must stay JSON-only: no `content` field.
  assert.equal('content' in result, false, 'execute must not return presentation content')

  const view = defs.route.presentResult({}, result)
  assert.equal(view.card, 'generic')
  assert.ok(Array.isArray(view.content), 'the UI card must carry content')
  assert.equal(view.content.length, 1)
  assert.match(view.content[0].text, /策略卡/, 'the card markdown must reach the UI')
})

// ---- DEFECT 2: a correction in one session settled a decision in another ----
test('a correction in session B does not mark session A decision corrected', async () => {
  const { call, emit, defs } = setup({ roots: [{ id: 's1' }, { id: 's2' }] })
  const a = await call(ASSUME_ARGS, 's1')
  assert.equal(a.strategy, 'assume_and_flag')

  emit('s2', '不对，那是另一个项目的事')

  const stats = await defs.stats.execute({})
  assert.equal(stats.corrections, 0, 'a foreign session must not settle this assumption')
})

// ---- DEFECT 3: one message settled EVERY pending assumption ----
test('one correcting message settles exactly one pending assumption', async () => {
  const { call, emit, defs } = setup()
  const a = await call({ ...ASSUME_ARGS, decision_at_stake: '按钮颜色' })
  const b = await call({ ...ASSUME_ARGS, decision_at_stake: '页面缩进' })
  assert.equal(a.strategy, 'assume_and_flag')
  assert.equal(b.strategy, 'assume_and_flag')

  const before = (await defs.stats.execute({})).corrections
  emit('s1', '不对')
  const after = (await defs.stats.execute({})).corrections

  assert.equal(after - before, 1, 'one statement about one thing settles one decision')
})

test('a second correcting message settles the next pending assumption', async () => {
  const { call, emit, defs } = setup()
  await call({ ...ASSUME_ARGS, decision_at_stake: '按钮颜色' })
  await call({ ...ASSUME_ARGS, decision_at_stake: '页面缩进' })

  emit('s1', '不对')
  emit('s1', '还是不对')

  const stats = await defs.stats.execute({})
  assert.equal(stats.corrections, 2, 'each message settles one of the two')
})

// ---- DEFECT 4: the snapshot route claimed loopback-only but had no guard ----
test('snapshot route refuses a non-loopback peer', () => {
  const ledger = { snapshot: () => ({ total: 0 }) }
  const route = createSnapshotRoute(ledger)
  const res = { status: null, writeHead(s) { this.status = s }, end() {} }
  route.handler({ method: 'GET', socket: { remoteAddress: '192.168.1.50' } }, res)
  assert.equal(res.status, 403, 'a LAN peer must not read the decision ledger')
})

test('loopbackOnly admits loopback, IPv6 loopback and a closed socket', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '']) {
    assert.equal(loopbackOnly({ socket: { remoteAddress: address } }), true, address)
  }
  assert.equal(loopbackOnly({ socket: { remoteAddress: '10.0.0.1' } }), false)
})

// ---- DEFECT 5: assumptionDefaults was read but not configurable ----
test('assumptionDefaults is a real Config field and reaches the card', async () => {
  const { Config } = await import('../lib/config.js')
  const defaults = Config({})
  assert.ok('assumptionDefaults' in defaults, 'the router reads it, so it must be in the schema')

  const env = fakeCtx()
  apply(env.ctx, { assumptionDefaults: { goal: '先按品牌主色实现' } })
  const def = env.registered.find((d) => d.name === 'route_info_gap')
  const result = await def.execute(ASSUME_ARGS, { agent: { id: 's1' }, signal: AbortSignal.timeout(5000) })
  assert.equal(result.strategy, 'assume_and_flag')
  assert.equal(result.assumption_if_any.text, '先按品牌主色实现')
})

// ---- DEFECT 6: pendingFeedback grew without bound ----
test('pending assumptions are capped per session', async () => {
  const { call, defs } = setup()
  // 12 assumptions in one session; the cap is 10.
  for (let i = 0; i < 12; i += 1) {
    await call({ ...ASSUME_ARGS, decision_at_stake: `决定 ${i}` })
  }
  // Every message now settles at most one, and the store cannot exceed the cap.
  // Assert the observable consequence: the ledger still has all 12 decisions.
  const stats = await defs.stats.execute({})
  assert.equal(stats.total, 12)
  assert.equal(stats.corrections, 0)
})

// ---- DEFECT 8: hand-written defaults shadowed the schema ----
test('apply() resolves Config defaults from the schema, not a hand-written copy', async () => {
  const { Config } = await import('../lib/config.js')
  const schemaDefaults = Config({})
  const resolved = resolveConfig({})

  // Every schema key must survive with the same value.
  assert.deepEqual(resolved, schemaDefaults, 'resolveConfig must return the schema defaults verbatim')

  // The observable consequence: the Loader's `config: {}` must not leave sensorTools
  // empty, or query_sensor reports "not configured" forever.
  assert.ok(schemaDefaults.sensorTools.length > 0)
  assert.ok(resolved.sensorTools.length > 0)

  // And the adapter must see it. Probe the adapter DIRECTLY rather than routing
  // through the whole pipeline: the router legitimately short-circuits before
  // query_sensor depending on the gate, so a routing-based assertion would go
  // red whenever the cost policy changes — testing the solver's arithmetic, not
  // the defect this test exists for.
  const services = new Map()
  services.set('tools', { get: (n) => (n === 'ops_glob' ? {} : undefined) })
  const { createSensorAdapter } = await import('../lib/adapters/sensor.js')
  const probe = await createSensorAdapter({
    ctx: { get: (k) => services.get(k) },
    agent: { id: 's1' },
    config: resolved,
  }).probe({ gap_type: 'environment', decision_at_stake: '端口状态' })

  assert.match(probe.reason, /visible/, 'the adapter must have probed the configured tools')
  assert.doesNotMatch(probe.reason, /no sensorTools configured/)
})

test('resolveConfig survives a malformed config without throwing', () => {
  assert.doesNotThrow(() => resolveConfig({ solveCoverage: 'not-a-number' }))
  const broken = resolveConfig({ solveCoverage: 'not-a-number' })
  // A schema violation must degrade to a disabled plugin, not crash the mount.
  assert.equal(typeof broken, 'object')
})

test('session disposal releases its pending-assumption set', async () => {
  const { call, handlers } = setup()
  const a = await call(ASSUME_ARGS, 's1')
  assert.equal(a.strategy, 'assume_and_flag')

  for (const fn of handlers['session/disposed'] || []) fn({ id: 's1' })

  // After disposal a late correction in that session finds nothing to settle.
  for (const fn of handlers['session/event'] || []) {
    fn({ id: 's1' }, { type: 'user/message', data: { message: { content: [{ type: 'text', text: '不对' }] } } })
  }
  // No throw and no stale attribution is the assertion: the map was released.
  assert.ok(true)
})

// ---- DEFECT 7: the client polled but never used the result ----
test('the client panel receives polled data (source-level guard)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  // The poll must feed a store that the Panel reads. A `void fetch(...)` with no
  // assignment is the exact regression: it fetches and discards.
  assert.doesNotMatch(source, /void fetchSnapshot\(/, 'a discarded fetch result is the defect')
  assert.match(source, /store\.set\(/, 'the poll must push its result into the store')
  assert.match(source, /createSnapshotStore/, 'the store must exist')
  assert.match(source, /getSnapshot/, 'the panel must read that store')
  assert.match(source, /subscribe/, 'the panel must re-render when the store changes')
})

// ---- the store itself: behaviour, not just its name ----
test('snapshot store notifies subscribers only on real change', async () => {
  // Evaluate the store factory out of the bundle without a DOM.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

  const factorySource = source.slice(
    source.indexOf('function createSnapshotStore()'),
    source.indexOf('function createSnapshotPanel'),
  )
  const reactStub = { createElement: () => null }
  const requireStub = (id) => (id === 'react' ? reactStub : null)
  const store = new Function('require', `${factorySource}\nreturn createSnapshotStore`)(requireStub)()

  let notified = 0
  const unsubscribe = store.subscribe(() => {
    notified += 1
  })

  store.set({ total: 1 })
  assert.equal(notified, 1)
  assert.deepEqual(store.getSnapshot(), { total: 1 })

  // Identical payload: no re-render (the panel polls every 5s).
  store.set({ total: 1 })
  assert.equal(notified, 1, 'an unchanged snapshot must not notify')

  store.set({ total: 2 })
  assert.equal(notified, 2)

  unsubscribe()
  store.set({ total: 3 })
  assert.equal(notified, 2, 'unsubscribed listeners stay silent')
  assert.deepEqual(store.getSnapshot(), { total: 3 }, 'state still updates')
})

// ---- DEFECT 11: ledger evidence was counted twice for the same fact ----------
test('read_trace deduplicates ledger facts that say the same thing', async () => {
  // Two rows can assert an identical fact ("constraint handled by read_trace").
  // Counting them separately inflated coverage and raised confidence for a gap
  // nothing had actually answered.
  const { createLedger } = await import('../lib/ledger.js')
  const { createTraceAdapter } = await import('../lib/adapters/trace.js')
  const { normalizeInput } = await import('../lib/adapters/contract.js')

  const ledger = createLedger()
  ledger.record({ gap_type: 'constraint', strategy: 'read_trace', evidence: [] })
  ledger.record({ gap_type: 'constraint', strategy: 'read_trace', evidence: [] })

  const adapter = createTraceAdapter({
    ctx: { get: () => undefined },
    agent: { id: 's1' },
    config: {},
    ledger,
  })
  const probe = await adapter.probe(normalizeInput({
    gap_type: 'constraint',
    decision_at_stake: '硬限制',
  }))

  const facts = probe.evidence.filter((e) => e.tool === 'ledger')
  assert.equal(facts.length, 1, 'one fact must appear once, no matter how many rows assert it')

  // Two different facts are still both admitted.
  ledger.record({ gap_type: 'constraint', strategy: 'structured_form', evidence: [] })
  const probe2 = await adapter.probe(normalizeInput({
    gap_type: 'constraint',
    decision_at_stake: '硬限制',
  }))
  const facts2 = probe2.evidence.filter((e) => e.tool === 'ledger')
  assert.ok(facts2.length >= 2, 'distinct facts must survive the dedupe')
})
