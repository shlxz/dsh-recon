// Host-half snapshot tests: the panel's data source, without any UI.
//
// These pin the READ-ONLY contract: buildSnapshot() takes rows and returns a
// plain JSON-safe view — no setters, no mutation of the ledger, and every value
// survives JSON round-trip (the Host route serializes it).

import assert from 'node:assert/strict'
import test from 'node:test'

import { createLedger, buildSnapshot } from '../lib/ledger.js'
import { apply, createSnapshotRoute, SNAPSHOT_ROUTE } from '../lib/index.js'

function seedLedger() {
  const ledger = createLedger()
  ledger.record({
    gap_type: 'goal',
    strategy: 'assume_and_flag',
    decision_at_stake: '按钮颜色',
    assumption_if_any: { text: '按品牌色先做' },
    evidence: [],
    assumption_cost: 0.65,
    interrupt_cost: 0.8,
    confidence: 0.65,
  })
  const b = ledger.record({
    gap_type: 'preference',
    strategy: 'structured_form',
    decision_at_stake: '日期库选型',
    question_if_any: { ask: '用哪个日期库？', known_context: '我已知：不要用 moment' },
    evidence: [],
    // structured_form is only chosen when assuming costs MORE than interrupting.
    assumption_cost: 1.0,
    interrupt_cost: 0.05,
    confidence: 0.35,
  })
  ledger.markCorrected(b.decision_id, '用户说要用 date-fns')
  return { ledger, first: ledger.recent(2)[0], second: b }
}

test('snapshot: exposes the three blocks the panel renders', () => {
  const { ledger } = seedLedger()
  const snap = ledger.snapshot()
  assert.equal(typeof snap.total, 'number')
  assert.equal(snap.total, 2)
  assert.equal(snap.corrected, 1)
  assert.ok(Array.isArray(snap.decisions))
  assert.equal(snap.decisions.length, 2)
  assert.ok(snap.distribution.assume_and_flag >= 1)
  assert.ok(snap.distribution.structured_form >= 1)
})

test('snapshot: each decision carries gap_type, strategy, both costs, corrected', () => {
  const { ledger } = seedLedger()
  const [first, second] = ledger.snapshot().decisions
  assert.equal(first.gap_type, 'goal')
  assert.equal(first.strategy, 'assume_and_flag')
  assert.equal(first.assumption_cost, 0.65)
  assert.equal(first.interrupt_cost, 0.8)
  assert.equal(first.corrected, false)

  assert.equal(second.gap_type, 'preference')
  assert.equal(second.corrected, true)
  assert.ok(second.assumption_cost > second.interrupt_cost,
    'a form decision is only routed when interrupting is the cheaper side')
})

test('snapshot: corrected rows report the gap-type prior_failures count', () => {
  const { ledger } = seedLedger()
  const snap = ledger.snapshot()
  const corrected = snap.decisions.find((d) => d.corrected)
  assert.ok(corrected, 'a corrected row must be present')
  assert.equal(corrected.prior_failures, 1,
    'one settled correction of that gap type is the current streak')
})

test('snapshot: is JSON-safe and does not expose mutable ledger rows', () => {
  const { ledger } = seedLedger()
  const snap = ledger.snapshot()
  const round = JSON.parse(JSON.stringify(snap))
  assert.deepEqual(round, snap, 'every value must survive serialization')
  // Mutating the snapshot must not reach the ledger.
  snap.decisions[0].strategy = 'tampered'
  assert.notEqual(ledger.snapshot().decisions[0].strategy, 'tampered')
})

test('snapshot: empty ledger renders an empty but valid shape', () => {
  const snap = createLedger().snapshot()
  assert.equal(snap.total, 0)
  assert.deepEqual(snap.decisions, [])
  assert.deepEqual(snap.distribution, {})
  assert.equal(snap.corrected, 0)
})

test('buildSnapshot is pure: same rows in, same snapshot out', () => {
  const rows = [
    { decision_id: 'rc_a', at: 1, gap_type: 'goal', strategy: 'read_trace', corrected: false, settled: true },
  ]
  const a = buildSnapshot({ rows, limit: 10 })
  const b = buildSnapshot({ rows, limit: 10 })
  assert.deepEqual(a, b)
  assert.equal(a.decisions[0].prior_failures, 0)
})

// ---- the HTTP route ----

function fakeResponse() {
  const captured = { status: null, headers: null, body: null, ended: false }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers ?? null
    },
    end(body) {
      captured.body = body ?? null
      captured.ended = true
    },
  }
}

test('route: GET returns the snapshot as JSON', () => {
  const { ledger } = seedLedger()
  const route = createSnapshotRoute(ledger)
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, SNAPSHOT_ROUTE)

  const res = fakeResponse()
  route.handler({ method: 'GET' }, res)
  assert.equal(res.captured.status, 200)
  const parsed = JSON.parse(res.captured.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.snapshot.total, 2)
  assert.match(res.captured.headers['content-type'], /application\/json/)
})

test('route: non-GET is refused without touching the ledger', () => {
  const { ledger } = seedLedger()
  const route = createSnapshotRoute(ledger)
  const res = fakeResponse()
  route.handler({ method: 'POST' }, res)
  assert.equal(res.captured.status, 405)
  assert.equal(res.captured.headers.allow, 'GET, HEAD')
  assert.equal(ledger.snapshot().total, 2, 'a refused write attempt must not mutate state')
})

test('route: a throwing ledger degrades to ok:false instead of an error page', () => {
  const broken = {
    snapshot() {
      throw new Error('boom')
    },
  }
  const route = createSnapshotRoute(broken)
  const res = fakeResponse()
  route.handler({ method: 'GET' }, res)
  assert.equal(res.captured.status, 200)
  const parsed = JSON.parse(res.captured.body)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.snapshot, null)
})

test('panel route registration failure cannot break route_info_gap', () => {
  // A ctx whose webServer.register throws must still leave the tools registered.
  const registered = []
  const services = new Map()
  services.set('tools', { get: () => undefined })
  services.set('webServer', {
    register() {
      throw new Error('route collision')
    },
  })
  const ctx = {
    get: (k) => services.get(k),
    on: () => () => {},
    effect: (fn) => {
      try {
        fn()
      } catch {
        // ignore
      }
    },
    inject: (_deps, callback) => callback(ctx),
    logger: () => ({ warn: () => {} }),
    tools: { register(d) { registered.push(d); return () => {} } },
  }
  apply(ctx, {})
  assert.ok(registered.some((d) => d.name === 'route_info_gap'))
  assert.ok(registered.some((d) => d.name === 'recon_strategy_stats'))
})
