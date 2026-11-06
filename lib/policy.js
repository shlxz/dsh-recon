// Pure cost model + gate. No ctx, no plugin names, no I/O.
//
// Two ledgers, both in "cu" (cost units), printed in the rationale:
//   assumptionCost — the price of proceeding on a default assumption
//   interruptCost  — the price of interrupting the human now
//
// A: both are derived from the DECLARED enums (reversibility / blast_radius),
//     not from lexical guesswork. `declared.*` records which ones the model gave.
// B: assumptionCost is recomputed from evidence coverage and the gate is re-evaluated
//     every time partial evidence lands — coverage discounts the cost it covers.
// C: confidence never feeds the gate. Prior corrections only discount the DISPLAYED
//     confidence (and only after two consecutive corrections of the same gap type).

import { clamp01, coverageOf, round } from './adapters/contract.js'

// Weights for the assumption ledger.
const W_REVERSIBILITY = { high: 0.0, medium: 0.35, low: 0.8 } // low = irreversible
const W_BLAST = { local: 0.05, module: 0.3, system: 0.75 }
// Prior probability the default assumption is wrong, per gap type (module-scoped).
const GAP_RISK = {
  goal: 0.6,
  constraint: 0.5,
  preference: 0.55,
  environment: 0.25,
  acceptance: 0.45,
}
// How strongly verified evidence discounts the cost of the dimension it covers.
const EVIDENCE_DISCOUNT = 0.85

// Weights for the interrupt ledger.
const W_BASE_INTERRUPT = 0.25
const W_BUSY = 0.55
const W_RECENTLY_CORRECTED = 0.35
const IDLE_SATURATION_SECONDS = 900
const W_IDLE = 0.2

export function defaults(overrides = {}) {
  return {
    W_REVERSIBILITY,
    W_BLAST,
    GAP_RISK,
    EVIDENCE_DISCOUNT,
    W_BASE_INTERRUPT,
    W_BUSY,
    W_RECENTLY_CORRECTED,
    IDLE_SATURATION_SECONDS,
    W_IDLE,
    gatelessAssumption: 1.0, // never let a bare assumption exceed 1 cu
    ...overrides,
  }
}

/**
 * Cost of proceeding on a default assumption.
 * `evidence` discounts only the share of the decision the evidence actually covers.
 */
export function assumptionCost(input, evidence, opts = {}) {
  const cfg = defaults(opts)
  const rev = cfg.W_REVERSIBILITY[input.reversibility] ?? cfg.W_REVERSIBILITY.medium
  const blast = cfg.W_BLAST[input.blast_radius] ?? cfg.W_BLAST.module
  const risk = cfg.GAP_RISK[input.gap_type] ?? 0.5

  const base = rev + blast + risk
  const coverage = coverageOf(evidence)
  // Capped so a well-evidenced decision still costs something: an assumption is never free.
  const discount = Math.min(coverage * cfg.EVIDENCE_DISCOUNT, 0.85)
  const total = base * (1 - discount)

  return {
    value: round(Math.min(total, cfg.gatelessAssumption), 3),
    parts: {
      reversibility: round(rev, 2),
      blast_radius: round(blast, 2),
      gap_risk: round(risk, 2),
      base: round(base, 2),
      coverage: round(coverage, 2),
      discount: round(discount, 2),
    },
    source: input.declared.reversibility && input.declared.blast_radius ? 'declared' : 'inferred',
  }
}

/** Cost of interrupting the human now. */
export function interruptCost(userState = {}, opts = {}) {
  const cfg = defaults(opts)
  const busy = userState.busy ? cfg.W_BUSY : 0
  const corr = userState.recently_corrected ? cfg.W_RECENTLY_CORRECTED : 0
  const idle = Math.min(Math.max(userState.idle_seconds || 0, 0) / cfg.IDLE_SATURATION_SECONDS, 1)
  const idleBonus = idle * cfg.W_IDLE
  const total = Math.max(cfg.W_BASE_INTERRUPT + busy + corr - idleBonus, 0.05)
  return {
    value: round(total, 3),
    parts: {
      base: cfg.W_BASE_INTERRUPT,
      busy: round(busy, 2),
      recently_corrected: round(corr, 2),
      idle_discount: round(-idleBonus, 2),
    },
  }
}

/** The gate. true = assumption is cheaper, so interrupting is forbidden. */
export function gate(aCost, iCost) {
  return {
    prefer_assumption: aCost.value <= iCost.value,
    margin: round(Math.abs(aCost.value - iCost.value), 3),
    reason:
      aCost.value <= iCost.value
        ? `assume (${aCost.value}) <= interrupt (${iCost.value}); asking would cost more than assuming`
        : `interrupt (${iCost.value}) < assume (${aCost.value}); asking is the cheaper channel`,
  }
}

/**
 * Confidence for DISPLAY ONLY. Never an input to the gate (C).
 * A prior failure streak discounts it, but only after two consecutive corrections.
 */
export function confidence({ evidence, strategy, priorFailures = 0, gateResult, adaptive = true }) {
  const coverage = coverageOf(evidence)
  let c = 0.15 + coverage * 0.7

  if (strategy === 'assume_and_flag') {
    c = gateResult?.margin != null ? 0.5 + Math.min(gateResult.margin, 0.5) : 0.5
  } else if (strategy === 'minimal_question' || strategy === 'structured_form') {
    // We only ask when we are unsure; a confident router would have assumed.
    //
    // BOTH question channels share this formula ON PURPOSE. Confidence measures how
    // much of the GAP we have solved, not which channel name we picked. Giving
    // structured_form a higher prior would make the router prefer a channel by its
    // label instead of its solving power — the exact bias the gate exists to avoid.
    // The channel choice is already settled by cost ordering, not by confidence.
    c = 0.35 + coverage * 0.3
  } else if (coverage >= 0.6) {
    // A trace/sensor channel actually resolved the gap.
    c = 0.6 + coverage * 0.35
  }

  if (adaptive && priorFailures >= 2) {
    // Two consecutive corrections of this exact gap type: stop advertising confidence.
    c -= Math.min(0.15 * (priorFailures - 1), 0.4)
  }
  return round(clamp01(c), 2)
}

export function describeLedgers(aCost, iCost, gateResult) {
  return (
    `assume=${aCost.value} (rev ${aCost.parts.reversibility} + blast ${aCost.parts.blast_radius}` +
    ` + gap-risk ${aCost.parts.gap_risk} = ${aCost.parts.base}; evidence discount ${aCost.parts.discount})` +
    ` vs interrupt=${iCost.value} (busy ${iCost.parts.busy}, corrected ${iCost.parts.recently_corrected}` +
    `, idle ${iCost.parts.idle_discount}); ${gateResult.reason}`
  )
}
