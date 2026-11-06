// Decision ledger: the fact source for the acceptance criterion.
//
// Default is PURE IN-MEMORY (a ring buffer). Persistence is explicit opt-in
// (`ledgerPersist: false` by default) because a preview-version workspace path
// and the storage-domain API shape are both unverified — see README, TODO markers.
//
// What it records: one row per routed gap, plus whether the user later corrected
// that direction. Corrections are never guessed in advance; they are claimed by
// `feedback` on a later call, or detected from a later user message.

import { randomUUID } from 'node:crypto'

const RING_SIZE = 200

export function createLedger({ capacity = RING_SIZE } = {}) {
  const rows = []
  const byId = new Map()

  function record(entry) {
    const row = {
      decision_id: entry.decision_id || `rc_${randomUUID().slice(0, 8)}`,
      at: Date.now(),
      gap_type: entry.gap_type,
      strategy: entry.strategy,
      assumption: entry.assumption_if_any?.text ?? null,
      question: entry.question_if_any?.ask ?? null,
      evidence_refs: (entry.evidence || []).map((e) => e.ref || e.text.slice(0, 40)),
      // The two ledgers and the decision text are what the panel compares. Storing
      // them here (not recomputing later) keeps the panel showing the numbers the
      // router actually used — a policy change never rewrites history.
      decision_at_stake: entry.decision_at_stake ?? null,
      assumption_cost: entry.assumption_cost ?? null,
      interrupt_cost: entry.interrupt_cost ?? null,
      confidence: entry.confidence ?? null,
      corrected: false,
      // A fresh row has NO outcome yet. "corrected: false" alone cannot express
      // "confirmed fine" vs "nobody said anything", and that distinction is what
      // makes a failure streak mean anything.
      settled: false,
      source: entry.source || 'route',
    }
    rows.push(row)
    byId.set(row.decision_id, row)
    while (rows.length > capacity) {
      const gone = rows.shift()
      if (gone) byId.delete(gone.decision_id)
    }
    return row
  }

  function markCorrected(decisionId, note = null) {
    const row = byId.get(decisionId)
    if (!row) return false
    row.corrected = true
    row.settled = true
    if (note) row.correction_note = String(note).slice(0, 160)
    return true
  }

  /** The assumption held: an explicit "no correction" settlement. */
  function markConfirmed(decisionId) {
    const row = byId.get(decisionId)
    if (!row) return false
    row.corrected = false
    row.settled = true
    return true
  }

  /**
   * Consecutive corrections of the same gap type, most recent first.
   *
   * Only SETTLED rows count. An unsettled row means "we do not know yet" — treating
   * it as either corrected or clean would make the streak meaningless, and a
   * just-recorded row would break its own streak on the very next call.
   *
   * Used ONLY for the displayed confidence (C) — never for the gate.
   */
  function priorFailures(gapType) {
    let n = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]
      if (r.gap_type !== gapType) continue
      if (!r.settled) continue // unknown outcome: skip, do not terminate the streak
      if (r.corrected) n += 1
      else break // an explicitly confirmed decision ends the streak
    }
    return n
  }

  function recent(limit = 20) {
    return rows.slice(-limit)
  }

  function distribution() {
    const d = {}
    for (const r of rows) d[r.strategy] = (d[r.strategy] || 0) + 1
    return d
  }

  function exportRows() {
    return rows.map((r) => ({ ...r }))
  }

  function restore(list) {
    if (!Array.isArray(list)) return 0
    for (const r of list) {
      if (!r?.decision_id) continue
      rows.push({ ...r })
      byId.set(r.decision_id, rows[rows.length - 1])
    }
    while (rows.length > capacity) {
      const gone = rows.shift()
      if (gone) byId.delete(gone.decision_id)
    }
    return rows.length
  }

  return {
    record,
    markCorrected,
    markConfirmed,
    priorFailures,
    recent,
    distribution,
    exportRows,
    restore,
    snapshot: (limit = 200) => buildSnapshot({ rows, limit, priorFailures, distribution }),
  }
}

/**
 * Read-only view for the panel. Pure: it takes the rows it is given, so the Host
 * route and the tests can call it without a live ctx.
 *
 * Every corrected row carries the CURRENT prior_failures count of its gap type,
 * which is what the panel highlights.
 */
export function buildSnapshot({ rows, limit = 200, priorFailures, distribution }) {
  const visible = rows.slice(-limit)
  const counts = distribution
    ? distribution()
    : visible.reduce((acc, r) => {
        acc[r.strategy] = (acc[r.strategy] || 0) + 1
        return acc
      }, {})
  return {
    total: rows.length,
    corrected: rows.filter((r) => r.corrected).length,
    distribution: counts,
    decisions: visible.map((r) => ({
      decision_id: r.decision_id,
      at: r.at,
      gap_type: r.gap_type,
      strategy: r.strategy,
      decision_at_stake: r.decision_at_stake ?? null,
      assumption_cost: r.assumption_cost ?? null,
      interrupt_cost: r.interrupt_cost ?? null,
      confidence: r.confidence ?? null,
      corrected: Boolean(r.corrected),
      settled: Boolean(r.settled),
      prior_failures: priorFailures ? priorFailures(r.gap_type) : 0,
    })),
  }
}
