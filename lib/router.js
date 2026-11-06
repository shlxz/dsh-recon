// Pure routing core. Depends only on the adapter CONTRACT shape, never on ctx,
// on a plugin name, or on any I/O. Every channel reaches the router as an object
// with { channel, probe(), act?() } (see adapters/contract.js).
//
// Order is strict and short-circuitable:
//   read_trace → query_sensor → read_multimodal → [GATE] → structured_form
//   → minimal_question → assume_and_flag
//
// B: after every evidence channel, assumptionCost is recomputed with the evidence
//    gathered so far and the gate is re-evaluated BEFORE considering an interruption.

import {
  CHANNELS,
  EVIDENCE_CHANNELS,
  INTERRUPTING_CHANNELS,
  coverageOf,
  round,
} from './adapters/contract.js'
import {
  assumptionCost,
  confidence,
  describeLedgers,
  gate,
  interruptCost,
} from './policy.js'

export const DEFAULT_ROUTER_CONFIG = {
  solveCoverage: 0.6, // verified coverage at which a channel has answered the gap
  maxEvidenceItems: 8,
  adaptiveConfidence: true,
}

// One question per gap type. A single generic "你更偏向哪种取舍" for every type
// asks the wrong thing for environment/acceptance.
const ASK_BY_GAP = {
  goal: '最终要得到什么结果？',
  constraint: '有哪条硬限制（预算/时间/权限）？',
  preference: '你更偏向哪种取舍？',
  environment: '它依赖哪个当前事实（路径/端口/服务状态）？',
  acceptance: '怎样才算做完？',
}

export function emptyStrategy() {
  return {
    strategy: 'assume_and_flag',
    source_plugin: null,
    rationale: '',
    confidence: 0,
    question_if_any: null,
    form_if_any: null,
    assumption_if_any: null,
    evidence: [],
    skipped: [],
    ledgers: null,
  }
}

function pickPlugin(evidence) {
  for (const e of evidence) if (e.plugin) return e.plugin
  return null
}

function capEvidence(list, max) {
  return list.slice(-max)
}

/**
 * Build the one-sentence "what I already know" prefix a minimal question must carry.
 */
export function knownContextLine(evidence) {
  if (!evidence?.length) return '我目前没有任何已证实的线索。'
  const items = evidence
    .slice(-4)
    .map((e) => e.text.replace(/\s+/g, ' ').replace(/[。．.]$/, '').slice(0, 80))
  return `我已知：${items.join('；')}。`
}

/**
 * Build the assumption a flagged decision will be executed under.
 *
 * The card is read by a human, so there are two very different outcomes and it
 * must not blur them:
 *
 *   assumed_value given  -> "按此执行：<the concrete default>"
 *   assumed_value absent -> "尚未给出默认值" and the model is told to supply one
 *
 * The old card always printed "proceed on the most reversible option" without
 * naming one, so the only faithful thing the model could do was repeat the
 * question back — a question wearing a decision's clothes. Naming nothing is
 * worse than admitting nothing is named.
 *
 * `cfg.assumptionDefaults[gap_type]` (a user override) still wins over both, so
 * an operator can pin the wording for a class of decisions.
 */
export function assumptionText(input, cfg = {}) {
  const userDefault = cfg.assumptionDefaults?.[input.gap_type]
  const given = typeof input.assumed_value === 'string' ? input.assumed_value.trim() : ''

  const text = given || userDefault || null
  if (text) {
    return {
      text,
      label: `⚠ 待确认（${input.gap_type}）：${input.decision_at_stake}`,
      decision_at_stake: input.decision_at_stake,
      // Tells the renderer whether to warn that no default was supplied.
      source: given ? 'model' : 'config',
    }
  }
  return {
    text: null,
    label: `⚠ 待确认（${input.gap_type}）：${input.decision_at_stake}`,
    decision_at_stake: input.decision_at_stake,
    source: 'missing',
    guidance:
      '未给出默认值。assume_and_flag 意味着「不再问、直接做」，因此必须有一个默认选择：' +
      '重新调用并附上 assumed_value（例如 "单文件 HTML，键盘操控，无音效"）。' +
      '若确实无法给出默认值，改用 override:{strategy:"minimal_question"} 去问。',
  }
}

/**
 * Route one gap.
 * @param input    normalized input (contract.normalizeInput)
 * @param adapters array of ChannelAdapter for the six channels
 * @param ledger   { priorFailures(gapType): number, record(entry): void }
 * @param cfg      router config
 */
export async function route(input, adapters = [], ledger = null, cfg = {}) {
  const c = { ...DEFAULT_ROUTER_CONFIG, ...cfg }
  const byChannel = new Map(adapters.map((a) => [a.channel, a]))
  const evidence = [...(input.known_evidence || [])]
  const skipped = []
  const trace = [] // ordered decision log, becomes part of the rationale

  const iCost = interruptCost(input.user_state, c.policy)
  const priorFailures = ledger?.priorFailures?.(input.gap_type) ?? 0

  // ---- the obvious case: skip the reconnaissance entirely --------------------
  //
  // A cheap decision against an expensive interruption is settled arithmetic.
  // Running three probes first to "make sure" is pure ceremony: it costs three
  // I/O attempts and delays the answer, and the gate was going to say the same
  // thing afterwards. (VDiag: "which colour for this button" probed read_trace,
  // query_sensor and read_multimodal, all empty, then assumed anyway.)
  //
  // The margin is deliberately wide (default 0.5x) so this only skips when the
  // answer is already lopsided — a decision near the boundary still gets the
  // evidence channels, where evidence could actually flip the result.
  if (!input.override) {
    const cheap = assumptionCost(input, evidence, c.policy)
    const skipThreshold = Number(c.policy?.obviousAssumptionRatio ?? 0.5)
    if (iCost.value > 0 && cheap.value <= iCost.value * skipThreshold) {
      trace.push(
        `skip reconnaissance: assume ${cheap.value} <= interrupt ${iCost.value} * ${skipThreshold}`,
      )
      return finalize('assume_and_flag', {
        input, c, evidence, skipped, iCost, priorFailures, trace,
      })
    }
  }

  // ---- explicit override wins the CHANNEL, but not the evidence gathering ----
  //
  // An override says "use this channel", not "skip the work". Forcing read_trace
  // must still read the trace: returning an empty card under a forced strategy
  // looks like success while delivering nothing. (VDiag: it did exactly that —
  // confidence 0.15, no evidence, no skipped entry explaining why.)
  //
  // Only the named channel probes; channels before it in the order do NOT run,
  // which is what "force" means.
  if (input.override) {
    const strategy = input.override.strategy
    const adapter = byChannel.get(strategy)
    let probe

    if (!adapter) {
      skipped.push({ channel: strategy, reason: 'adapter not installed' })
    } else if (EVIDENCE_CHANNELS.includes(strategy)) {
      try {
        probe = await adapter.probe(input)
      } catch (error) {
        skipped.push({ channel: strategy, reason: `probe threw: ${error?.message || error}` })
      }
      if (probe) {
        if (!probe.available) {
          skipped.push({ channel: strategy, reason: probe.reason || 'channel unavailable' })
          trace.push(`${strategy}: unavailable (forced): ${probe.reason || 'no reason'}`)
        } else if (probe.evidence?.length) {
          evidence.push(...probe.evidence)
          trace.push(`${strategy}: +${probe.evidence.length} evidence (forced)`)
        } else {
          skipped.push({ channel: strategy, reason: probe.note || 'available, no matching evidence', ran: true })
          trace.push(`${strategy}: available, no new evidence (forced)`)
        }
      }
    } else if (INTERRUPTING_CHANNELS.includes(strategy)) {
      // A forced question/form still needs its fields and known context, so the
      // probe runs for those; it never actually asks here.
      try {
        probe = await adapter.probe(input)
        if (probe && !probe.available) {
          skipped.push({ channel: strategy, reason: probe.reason || 'channel unavailable' })
        }
      } catch (error) {
        skipped.push({ channel: strategy, reason: `probe threw: ${error?.message || error}` })
      }
    }

    return finalize(strategy, {
      input, c, evidence, skipped, iCost, priorFailures, trace,
      probe,
      overrideReason: input.override.reason,
    })
  }

  // ---- phase 1: evidence channels, strict order, gate re-checked after each ----
  for (const channel of EVIDENCE_CHANNELS) {
    const adapter = byChannel.get(channel)
    if (!adapter) {
      skipped.push({ channel, reason: 'adapter not installed' })
      continue
    }
    let probe
    try {
      probe = await adapter.probe(input)
    } catch (error) {
      skipped.push({ channel, reason: `probe threw: ${error?.message || error}` })
      continue
    }
    if (!probe?.available) {
      skipped.push({ channel, reason: probe?.reason || 'channel unavailable' })
      continue
    }
    if (probe.evidence?.length) {
      evidence.push(...probe.evidence)
      trace.push(`${channel}: +${probe.evidence.length} evidence (coverage ${round(coverageOf(evidence), 2)})`)
    } else {
      // A channel that ran but found nothing must still say WHY: the rationale is
      // the audit trail for the acceptance criterion.
      skipped.push({ channel, reason: probe?.note || 'available, no matching evidence', ran: true })
      trace.push(`${channel}: available, no new evidence`)
    }

    const covered = coverageOf(evidence)
    if (covered >= c.solveCoverage) {
      // The trace/sensor/multimodal channel answered the gap: stop here, do not ask.
      trace.push(`${channel}: coverage ${round(covered, 2)} >= ${c.solveCoverage}, gap resolved without interruption`)
      return finalize(channel, { input, c, evidence, skipped, iCost, priorFailures, trace })
    }

    // B: recompute the assumption ledger with what we now have, then re-check the gate.
    const aCost = assumptionCost(input, evidence, c.policy)
    const g = gate(aCost, iCost)
    if (g.prefer_assumption) {
      trace.push(`${channel}: after partial evidence, ${g.reason}`)
      return finalize('assume_and_flag', { input, c, evidence, skipped, iCost, priorFailures, trace })
    }
  }

  // ---- phase 2: the gate with everything we gathered ----
  const aCost = assumptionCost(input, evidence, c.policy)
  const g = gate(aCost, iCost)
  trace.push(`evidence exhausted: ${g.reason}`)

  if (g.prefer_assumption) {
    // The key gate: assuming is cheaper, so asking is forbidden.
    return finalize('assume_and_flag', { input, c, evidence, skipped, iCost, priorFailures, trace })
  }

  // ---- phase 3: interrupt, cheapest form first ----
  for (const channel of ['structured_form', 'minimal_question']) {
    const adapter = byChannel.get(channel)
    if (!adapter) {
      skipped.push({ channel, reason: 'adapter not installed' })
      continue
    }
    let probe
    try {
      probe = await adapter.probe(input)
    } catch (error) {
      skipped.push({ channel, reason: `probe threw: ${error?.message || error}` })
      continue
    }
    if (!probe?.available) {
      skipped.push({ channel, reason: probe?.reason || 'channel unavailable' })
      continue
    }
    trace.push(`${channel}: ${g.reason}; entering interrupt channel`)
    return finalize(channel, { input, c, evidence, skipped, iCost, priorFailures, trace, probe })
  }

  // No interrupt channel is usable (e.g. delegated caller): fall back to a flagged assumption.
  trace.push('no interrupt channel usable; falling back to flagged assumption')
  return finalize('assume_and_flag', { input, c, evidence, skipped, iCost, priorFailures, trace })
}

/**
 * Build the final result.
 *
 * `frame` carries only values the router itself computed — it is NOT a Cordis
 * context. The name is deliberate: an earlier version called it `ctx`, which
 * made a pure module look ctx-aware to anyone reading it.
 */
function finalize(strategy, frame) {
  const { input, c, evidence, skipped, iCost, priorFailures, trace, probe, overrideReason } = frame
  const capped = capEvidence(evidence, c.maxEvidenceItems)
  const aCost = assumptionCost(input, capped, c.policy)
  const g = gate(aCost, iCost)
  const conf = confidence({
    evidence: capped,
    strategy,
    priorFailures,
    gateResult: g,
    adaptive: c.adaptiveConfidence,
  })

  const out = emptyStrategy()
  out.strategy = strategy
  out.gap_type = input.gap_type
  out.decision_at_stake = input.decision_at_stake
  out.source_plugin = pickPlugin(capped)
  out.confidence = conf
  out.evidence = capped
  out.skipped = skipped
  out.ledgers = {
    assumption: aCost,
    interrupt: iCost,
    gate: g,
  }

  if (strategy === 'minimal_question' || strategy === 'structured_form') {
    out.question_if_any = {
      known_context: knownContextLine(capped),
      ask: ASK_BY_GAP[input.gap_type]
        ? `「${input.decision_at_stake}」，只需回答一个能改变做法的点： ${ASK_BY_GAP[input.gap_type]}`
        : `关于「${input.decision_at_stake}」，哪一点最影响你的判断？`,
      max_questions: strategy === 'structured_form' ? (probe?.fields?.length ?? 3) : 1,
    }
  }
  if (strategy === 'structured_form') {
    out.form_if_any = {
      fields: probe?.fields || [],
      note: probe?.note || 'one-shot, bounded question count',
    }
  }
  if (strategy === 'assume_and_flag') {
    out.assumption_if_any = assumptionText(input, c)
  }

  const lines = []
  lines.push(
    `gap=${input.gap_type}; decision="${input.decision_at_stake}"; ` +
    `risk=${input.reversibility}/${input.blast_radius} (${input.declared.reversibility && input.declared.blast_radius ? 'declared' : 'inferred'})`,
  )
  lines.push(describeLedgers(aCost, iCost, g))
  for (const t of trace) lines.push(`· ${t}`)
  if (overrideReason) lines.push(`override: ${overrideReason}`)
  if (priorFailures >= 2 && c.adaptiveConfidence) {
    lines.push(`note: this gap type was corrected ${priorFailures}x consecutively; confidence discounted (display only, gate unchanged)`)
  }
  if (skipped.length) lines.push(`skipped: ${skipped.map((s) => `${s.channel} (${s.reason})`).join('; ')}`)
  if (strategy === 'assume_and_flag') {
    lines.push('why not ask: see ledger above; the deliverable will carry the ⚠ pending-confirmation line')
  }
  out.rationale = lines.join('\n')
  return out
}

export function strategyDistribution(results) {
  const dist = {}
  for (const ch of CHANNELS) dist[ch] = 0
  for (const r of results) dist[r.strategy] = (dist[r.strategy] || 0) + 1
  return dist
}
