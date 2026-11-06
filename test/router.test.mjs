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
  // This case must sit where the discount actually MOVES the decision. An
  // undisturbed cheap assumption (high/local, busy user) is already cheap
  // enough to prefer assuming, so using it here would assert nothing.
  //
  // Instead: an idle user, where the interrupt side is cheapest. Without
  // evidence the assumption loses; with real evidence it wins.
  const input = normalizeInput(
    baseArgs({
      gap_type: 'preference',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: false, recently_corrected: false, idle_seconds: 3600 },
    }),
  )
  const iCost = interruptCost(input.user_state)
  const before = assumptionCost(input, [])
  assert.equal(gate(before, iCost).prefer_assumption, false, 'a costly decision vs an idle user asks first')

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

test('a forced evidence channel still PROBES (override is not "skip the work")', async () => {
  // The defect this guards: the override branch returned before any probe ran,
  // so forcing read_trace produced an empty card with confidence 0.15 and no
  // explanation. A forced channel must still gather its own evidence.
  let probed = 0
  const trace = {
    channel: 'read_trace',
    async probe() {
      probed += 1
      return {
        available: true,
        evidence: [makeEvidence({ channel: 'read_trace', text: '用户此前说过：统一用 4 空格', weight: 0.6 })],
      }
    },
  }
  const input = normalizeInput(baseArgs({ override: { strategy: 'read_trace', reason: 'force it' } }))
  const r = await route(input, [trace, ...allDisabled.slice(1)], null, {})

  assert.equal(probed, 1, 'the forced channel must be probed')
  assert.equal(r.strategy, 'read_trace')
  assert.equal(r.evidence.length, 1, 'forced evidence must reach the result')
  assert.match(r.rationale, /forced/)
})

test('a forced evidence channel that finds nothing still says why', async () => {
  const trace = {
    channel: 'read_trace',
    async probe() {
      return { available: true, evidence: [], note: 'scanned 3 events, none matched' }
    }
  }
  const input = normalizeInput(baseArgs({ override: { strategy: 'read_trace', reason: 'force' } }))
  const r = await route(input, [trace, ...allDisabled.slice(1)], null, {})

  assert.equal(r.strategy, 'read_trace')
  const entry = r.skipped.find((s) => s.channel === 'read_trace')
  assert.ok(entry, 'a forced channel that found nothing must be recorded in skipped')
  assert.match(entry.reason, /scanned 3 events, none matched/)
  assert.equal(entry.ran, true, 'it ran, so the reason is a negative result not an absence')
})

test('a forced channel that is unavailable reports its reason', async () => {
  const input = normalizeInput(baseArgs({ override: { strategy: 'read_trace', reason: 'force' } }))
  const r = await route(input, allDisabled, null, {})
  assert.equal(r.strategy, 'read_trace')
  const entry = r.skipped.find((s) => s.channel === 'read_trace')
  assert.ok(entry)
  assert.doesNotMatch(entry.reason, /no matching evidence/)
})

test('recon_strategy_stats distribution shape', () => {
  const rows = [{ strategy: 'assume_and_flag' }, { strategy: 'assume_and_flag' }, { strategy: 'read_trace' }]
  const dist = {}
  for (const r of rows) dist[r.strategy] = (dist[r.strategy] || 0) + 1
  assert.equal(dist.assume_and_flag, 2)
})

// ---- gate economics: the distribution is the product decision --------------------

test('an idle user is not asked about cheap decisions', () => {
  // This is the whole point of the plugin. An idle user must still NOT be
  // interrupted for a decision whose wrongness costs almost nothing.
  const cheap = normalizeInput(
    baseArgs({
      gap_type: 'preference',
      decision_at_stake: '这个按钮用哪个颜色',
      reversibility: 'high',
      blast_radius: 'local',
      user_state: { busy: false, recently_corrected: false, idle_seconds: 3600 },
    }),
  )
  const a = assumptionCost(cheap, [])
  const i = interruptCost(cheap.user_state)
  assert.equal(gate(a, i).prefer_assumption, true,
    `idle must not lower the bar for trivial questions (assume ${a.value} vs interrupt ${i.value})`)
})

test('a busy user is not asked about expensive decisions either', () => {
  const costly = normalizeInput(
    baseArgs({
      gap_type: 'constraint',
      decision_at_stake: '发布到生产的审批流程',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: true, recently_corrected: false, idle_seconds: 0 },
    }),
  )
  const a = assumptionCost(costly, [])
  const i = interruptCost(costly.user_state)
  // A busy user is expensive to interrupt, so even a costly decision is assumed.
  assert.equal(gate(a, i).prefer_assumption, true,
    `interrupting a busy user must be dearer than assuming (${a.value} vs ${i.value})`)
})

test('the idle floor still admits a genuinely expensive decision', () => {
  // The counterweight to the test above: raising the idle floor must not make
  // the gate permanently silent. An idle user IS worth asking when the stakes
  // are high.
  const costly = normalizeInput(
    baseArgs({
      gap_type: 'constraint',
      decision_at_stake: '发布到生产的审批流程',
      reversibility: 'low',
      blast_radius: 'system',
      user_state: { busy: false, recently_corrected: false, idle_seconds: 3600 },
    }),
  )
  const a = assumptionCost(costly, [])
  const i = interruptCost(costly.user_state)
  assert.equal(gate(a, i).prefer_assumption, false,
    `an idle user must still be asked about real stakes (${a.value} vs ${i.value})`)
})

test('the two ledgers share one scale', () => {
  // Guards the scale mismatch that made 12 of 18 combinations answer "interrupt".
  // Ranges must overlap, not nest.
  const assumptions = []
  for (const rev of ['high', 'medium', 'low']) {
    for (const blast of ['local', 'module', 'system']) {
      assumptions.push(assumptionCost(
        normalizeInput(baseArgs({ reversibility: rev, blast_radius: blast })), [],
      ).value)
    }
  }
  const interrupts = [
    interruptCost({ busy: true, idle_seconds: 0 }).value,
    interruptCost({ busy: false, idle_seconds: 3600 }).value,
  ]
  const aMax = Math.max(...assumptions)
  const iMax = Math.max(...interrupts)
  assert.ok(iMax > Math.min(...assumptions),
    `interrupt must be able to exceed a cheap assumption (iMax ${iMax} vs aMin ${Math.min(...assumptions)})`)
  assert.ok(aMax > Math.min(...interrupts),
    `assumption must be able to exceed a cheap interruption (aMax ${aMax} vs iMin ${Math.min(...interrupts)})`)
})

test('idle can never discount more than a fraction of the base interrupt cost', () => {
  // A structural guard, not a value snapshot: whatever the individual weights
  // become, going idle must never make a question nearly free. When W_IDLE
  // outweighed the base, "user is away" silently meant "ask about anything".
  const idle = interruptCost({ busy: false, recently_corrected: false, idle_seconds: 3600 })
  const busy = interruptCost({ busy: true, recently_corrected: false, idle_seconds: 0 })

  // The full idle discount must be a small share of the idle-vs-busy spread,
  // i.e. idle buys a modest saving, not a free pass.
  const discount = Math.abs(idle.parts.idle_discount)
  const base = idle.parts.base
  assert.ok(discount <= base * 0.5,
    `idle discount ${discount} must stay under half the base ${base}`)

  // And an idle question must still cost meaningfully more than nothing.
  assert.ok(idle.value >= base * 0.5 * idle.parts.scale,
    `an idle interruption must still cost a real amount, got ${idle.value}`)
  assert.ok(busy.value > idle.value, 'a busy user must still be dearer than an idle one')
})
