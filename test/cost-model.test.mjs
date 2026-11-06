// Cost-model configurability: the gate must be retunable through Config,
// not by editing policy.js and restarting.
//
// Why this exists: the functional audit found a plausible weight set that made
// the gate answer "interrupt" for 12 of 18 decision/state combinations. A user
// whose judgment differs has to be able to fix that without forking the source.

import assert from 'node:assert/strict'
import test from 'node:test'

import { modelFromConfig, defaults, assumptionCost, interruptCost, gate } from '../lib/policy.js'
import { Config } from '../lib/config.js'

const DECLARED = { reversibility: true, blast_radius: true }

function assumption(reversibility, blast, model) {
  return assumptionCost(
    { gap_type: 'goal', decision_at_stake: 'x', reversibility, blast_radius: blast, declared: DECLARED },
    [],
    model,
  )
}

test('the Config schema exposes a full cost model', () => {
  const d = Config({})
  assert.ok(d.costModel, 'costModel must exist')
  for (const key of ['reversibility', 'blastRadius', 'gapRisk', 'interrupt', 'maxAssumption', 'evidenceDiscount']) {
    assert.ok(key in d.costModel, `costModel.${key} must be declared`)
  }
  for (const key of ['base', 'busy', 'recentlyCorrected', 'idleDiscount', 'idleSaturationSeconds', 'scale']) {
    assert.ok(key in d.costModel.interrupt, `costModel.interrupt.${key} must be declared`)
  }
})

test('modelFromConfig with an empty config equals the built-in defaults', () => {
  // The adapter must not silently invent different weights than the source.
  const fromConfig = modelFromConfig({})
  const builtin = defaults()
  for (const key of [
    'W_BASE_INTERRUPT',
    'W_BUSY',
    'W_RECENTLY_CORRECTED',
    'W_IDLE',
    'IDLE_SATURATION_SECONDS',
    'INTERRUPT_SCALE',
    'gatelessAssumption',
    'EVIDENCE_DISCOUNT',
  ]) {
    assert.equal(fromConfig[key], builtin[key], `${key} must match the built-in default`)
  }
  assert.deepEqual(fromConfig.W_REVERSIBILITY, builtin.W_REVERSIBILITY)
  assert.deepEqual(fromConfig.W_BLAST, builtin.W_BLAST)
  assert.deepEqual(fromConfig.GAP_RISK, builtin.GAP_RISK)
})

test('a configured weight actually reaches the cost functions', () => {
  const model = modelFromConfig({ costModel: { last: undefined, interrupt: { base: 5 } } })
  assert.equal(model.W_BASE_INTERRUPT, 5, 'the override must survive')
  const idle = interruptCost({ busy: false, recently_corrected: false, idle_seconds: 3600 }, model)
  assert.ok(idle.value > interruptCost({ busy: false, idle_seconds: 3600 }, defaults()).value,
    'a dearer base must raise the idle interruption cost')
})

test('retuning the model moves the gate boundary in both directions', () => {
  const cheap = assumption('high', 'local', defaults())
  const idleState = { busy: false, recently_corrected: false, idle_seconds: 3600 }

  // Default: an idle user is not asked about a trivial decision.
  assert.equal(gate(cheap, interruptCost(idleState, defaults())).prefer_assumption, true)

  // A much lower interrupt bar: now even a trivial decision is worth a question.
  const pushy = modelFromConfig({ costModel: { interrupt: { base: 0.05, idleDiscount: 0, scale: 0.5 } } })
  assert.equal(gate(cheap, interruptCost(idleState, pushy)).prefer_assumption, false)

  // A much higher bar: the gate stops asking even for expensive decisions.
  const shy = modelFromConfig({ costModel: { interrupt: { base: 5, scale: 5 } } })
  const costly = assumption('low', 'system', shy)
  const busy = { busy: true, recently_corrected: true, idle_seconds: 0 }
  assert.equal(gate(costly, interruptCost(busy, shy)).prefer_assumption, true)
})

test('a partially specified costModel leaves the other weights alone', () => {
  const model = modelFromConfig({ costModel: { interrupt: { busy: 99 } } })
  assert.equal(model.W_BUSY, 99)
  assert.equal(model.W_BASE_INTERRUPT, defaults().W_BASE_INTERRUPT, 'untouched weights keep their defaults')
  assert.equal(model.INTERRUPT_SCALE, defaults().INTERRUPT_SCALE)
})

test('a malformed costModel value falls back instead of poisoning the math', () => {
  // Infinity/NaN would make every comparison meaningless.
  const model = modelFromConfig({ costModel: { interrupt: { base: NaN, scale: Infinity, busy: 'nope' } } })
  assert.equal(model.W_BASE_INTERRUPT, defaults().W_BASE_INTERRUPT)
  assert.equal(model.INTERRUPT_SCALE, defaults().INTERRUPT_SCALE)
  assert.equal(model.W_BUSY, defaults().W_BUSY)
  const a = assumption('high', 'local', model)
  const i = interruptCost({ busy: true, idle_seconds: 0 }, model)
  assert.ok(Number.isFinite(a.value) && Number.isFinite(i.value), 'costs must stay finite')
})

test('the default model keeps the audited distribution', () => {
  // The regression this guards is already in router.test; repeating it here on
  // the built-in model ties the DEFAULT weights to the documented behaviour.
  const model = defaults()
  let busyAssume = 0
  let idleAssume = 0
  for (const rev of ['high', 'medium', 'low']) {
    for (const blast of ['local', 'module', 'system']) {
      const a = assumption(rev, blast, model)
      if (gate(a, interruptCost({ busy: true, idle_seconds: 0 }, model)).prefer_assumption) busyAssume += 1
      if (gate(a, interruptCost({ busy: false, idle_seconds: 3600 }, model)).prefer_assumption) idleAssume += 1
    }
  }
  assert.equal(busyAssume, 8, 'busy user: 8 of 9 assumed')
  assert.equal(idleAssume, 1, 'idle user: only the trivial decision is assumed')
})
