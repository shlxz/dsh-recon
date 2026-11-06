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
//
// These answer one question: how much is a question WORTH right now. They are
// deliberately close in magnitude to the assumption ledger's cheap end, because
// the gate compares them directly.
//
// Two corrections came out of the functional audit:
//
//  1. The idle term must stay small relative to the base. Idle means "less
//     disruptive", never "nearly free" — an idle user still pays attention.
//     (W_IDLE 0.2 against a 0.25 base once drove EVERY decision, including
//     "which colour for this button", to interrupt.)
//
//  2. An idle interruption must still cost more than a cheap assumption.
//     Otherwise a user who has been away 15 minutes gets asked about trivial
//     choices, which is exactly what this plugin exists to prevent.
//
//     With the old base of 0.25, a fully idle user priced an interruption at
//     ~0.10 (scaled), far below even the cheapest decision (0.65). Raising the
//     base and shrinking idle lifts the idle floor to ~1.0, so "ask" wins only
//     when the decision is genuinely expensive.
const W_BASE_INTERRUPT = 0.5
const W_BUSY = 0.55
const W_RECENTLY_CORRECTED = 0.35
const IDLE_SATURATION_SECONDS = 900
const W_IDLE = 0.08

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
    // The ceiling exists so an assumption is never "infinitely" expensive — but
    // it must sit ABOVE the costliest un-discounted base (rev low 0.8 + blast
    // system 0.75 + gap risk 0.6 = 2.15), otherwise every high-risk decision is
    // flattened to one number and the evidence discount stops mattering.
    //
    // VDiag: with the old 1.0 ceiling, blast local/module/system all produced
    // exactly 1.0 at reversibility:low, and discounting 2.05 by 43% still landed
    // on the ceiling — a well-evidenced decision looked as costly as a blind one.
    gatelessAssumption: 3.0,
    // Brings the interrupt ledger onto the assumption ledger's scale. See
    // interruptCost's doc block for why this is needed and what it changes.
    INTERRUPT_SCALE: 2.0,
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

/**
 * Cost of interrupting the human now.
 *
 * `INTERRUPT_SCALE` puts both ledgers on one scale.
 *
 * The two ledgers are measured by different yardsticks: an assumption ranges
 * roughly 0.65–2.15 (reversibility + blast + gap risk), while an interruption
 * could only reach 1.15 (base + busy + corrected). Left unscaled, the interrupt
 * side can never exceed a middling assumption, so the gate answered "interrupt"
 * for 12 of 18 combinations — the exact opposite of the plugin's purpose.
 *
 * The scale is applied to the FINAL total so the printed parts keep their
 * original weights and stay readable.
 */
export function interruptCost(userState = {}, opts = {}) {
  const cfg = defaults(opts)
  const busy = userState.busy ? cfg.W_BUSY : 0
  const corr = userState.recently_corrected ? cfg.W_RECENTLY_CORRECTED : 0
  const idle = Math.min(Math.max(userState.idle_seconds || 0, 0) / cfg.IDLE_SATURATION_SECONDS, 1)
  const idleBonus = idle * cfg.W_IDLE
  const raw = Math.max(cfg.W_BASE_INTERRUPT + busy + corr - idleBonus, 0.05)
  const total = raw * cfg.INTERRUPT_SCALE
  return {
    value: round(total, 3),
    parts: {
      base: cfg.W_BASE_INTERRUPT,
      busy: round(busy, 2),
      recently_corrected: round(corr, 2),
      idle_discount: round(-idleBonus, 2),
      raw: round(raw, 3),
      scale: cfg.INTERRUPT_SCALE,
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
