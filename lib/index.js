// dsh-recon host entry.
//
// This file is the only ctx-aware layer besides adapters/. It wires:
//   contract (validation) → ledger → adapters → router → card → tool result.
// It registers ONE tool, `route_info_gap`, in `plan` mode by default.

import { Config } from './config.js'
import { buildAdapters } from './adapters/index.js'
import {
  CHANNELS,
  GAP_TYPES,
  ReconError,
  normalizeInput,
} from './adapters/contract.js'
import { renderCard } from './card.js'
import { createLedger } from './ledger.js'
import { route, strategyDistribution } from './router.js'
import { modelFromConfig, assumptionCost, interruptCost, gate } from './policy.js'

export const name = 'dsh-recon'
export { Config }

// The tools registry is the one hard dependency: without it there is nothing to
// register. Every other service is read through `ctx.get(...)` and degrades.
export const inject = ['tools']

const TOOL_NAME = 'route_info_gap'

/** Cap on assumptions one session may have awaiting a correction. */
const MAX_PENDING_PER_SESSION = 10

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gap_type: {
      type: 'string',
      enum: GAP_TYPES,
      description: 'Missing-information class. MVP fully supports goal/constraint/preference.',
    },
    decision_at_stake: {
      type: 'string',
      description: 'The concrete decision this gap blocks. Be specific: what cannot be decided without it.',
    },
    reversibility: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'How reversible the decision is if we assume wrong. Prefer declaring it; the router otherwise infers from wording (less reliable, esp. in Chinese).',
    },
    blast_radius: {
      type: 'string',
      enum: ['local', 'module', 'system'],
      description: 'How far a wrong assumption spreads. Declare it when known.',
    },
    user_state: {
      type: 'object',
      additionalProperties: true,
      properties: {
        busy: { type: 'boolean', description: 'Is the human currently busy?' },
        recently_corrected: { type: 'boolean', description: 'Has the human corrected us recently?' },
        idle_seconds: { type: 'number', description: 'Seconds since their last message.' },
      },
      description: 'Signals used to price the interruption.',
    },
    known_evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string' },
          channel: { type: 'string' },
        },
        required: ['text'],
      },
      description: 'Evidence already gathered elsewhere (model summary; admitted at lower weight).',
    },
    mode: {
      type: 'string',
      enum: ['plan', 'act'],
      description: 'plan (default) only returns a strategy; act actually increments through the chosen channel.',
    },
    override: {
      type: 'object',
      additionalProperties: false,
      properties: {
        strategy: { type: 'string', enum: CHANNELS },
        reason: { type: 'string' },
      },
      required: ['strategy'],
      description: 'Force a channel instead of the routed one.',
    },
    feedback: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision_id: { type: 'string' },
        corrected: { type: 'boolean' },
      },
      required: ['decision_id'],
      description: 'Claim the outcome of a prior decision so the ledger can attribute corrections.',
    },
  },
  required: ['gap_type', 'decision_at_stake'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    strategy: { type: 'string', enum: CHANNELS },
    gap_type: { type: 'string' },
    // Host JSON schema rejects `type` ARRAYS (verified on 0.2.1-rc.5), so
    // "nullable" is expressed by omission: these keys are simply absent when null.
    source_plugin: { type: 'string' },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
    question_if_any: {
      type: 'object',
      properties: {
        ask: { type: 'string' },
        known_context: { type: 'string' },
        max_questions: { type: 'number' },
      },
    },
    form_if_any: { type: 'object', additionalProperties: true },
    assumption_if_any: { type: 'object', additionalProperties: true },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: true } },
    skipped: { type: 'array', items: { type: 'object', additionalProperties: true } },
    ledgers: { type: 'object', additionalProperties: true },
    decision_id: { type: 'string' },
  },
  required: ['strategy', 'rationale', 'confidence', 'decision_id'],
}

// The Host validates the canonical value against OUTPUT_SCHEMA, which rejects
// `type` arrays, so a null field must be OMITTED rather than returned as null.
function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue
      out[k] = dropNulls(v)
    }
    return out
  }
  return value
}

// The Host panel route. Read-only, loopback-only, no query parameters: it exposes
// exactly what lib/ledger.js already holds. A failed registration is logged and
// ignored — the panel must never be able to break `route_info_gap`.
export const SNAPSHOT_ROUTE = '/api/dsh-recon/snapshot'

/**
 * Materialize the full config from the schema's own defaults.
 *
 * Falls back to passing the raw value through when schemastery is unavailable or
 * the value is malformed — a bad config must degrade the plugin, never crash the
 * Host at mount.
 */
export function resolveConfig(raw) {
  try {
    return Config(raw)
  } catch (error) {
    // Last resort: keep the plugin loadable with the minimal safe surface.
    return { enabled: false, __configError: String(error?.message || error) }
  }
}

/**
 * Loopback guard, matching what other DSH plugins do (pet-live2d).
 * The ledger holds decision text, so it must not be readable from another host
 * on a LAN-exposed Web GUI. An empty remoteAddress (socket already gone) admits.
 */
export function loopbackOnly(request) {
  const address = request?.socket?.remoteAddress ?? ''
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function createSnapshotRoute(ledger) {
  return {
    kind: 'exact',
    path: SNAPSHOT_ROUTE,
    handler: (request, response) => {
      if (!loopbackOnly(request)) {
        response.writeHead(403)
        response.end()
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' })
        response.end()
        return
      }
      try {
        const body = JSON.stringify({ ok: true, snapshot: ledger.snapshot() })
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(body)
      } catch (error) {
        // Degrade to an empty snapshot rather than an error page.
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, snapshot: null, error: String(error?.message || error) }))
      }
    },
  }
}

export function apply(ctx, config) {
  // Resolve defaults through the SCHEMA, not a second hand-written copy.
  //
  // The Loader passes the row's `config` (here `{}`) — it does not materialize
  // schema defaults for us. A hand-written default block therefore silently
  // shadows the schema: `sensorTools` stayed `[]` instead of the schema's four
  // probes, so query_sensor always reported "not configured". Verified defect.
  const resolved = resolveConfig(config ?? {})
  const cfg = resolved
  if (!cfg.enabled) return

  const ledger = createLedger()
  // sessionId -> Map<decision_id, assumed text>: a decision awaiting a correction.
  // Scoped by session on purpose — the ledger is process-wide, but attribution is not.
  const pendingFeedback = new Map()
  let persistHandle = null

  // ---- optional persistence: explicit opt-in, never on by default ----
  const fs = ctx.get?.('fs')
  const workdir = ctx.get?.('workingDirectory')
  const persistence = {
    async save() {
      if (!cfg.ledgerPersist || !fs?.writeText || !workdir) return
      try {
        const dir = workdir.defaultDirectory || '.'
        const target = await fs.resolve(`${dir}/${cfg.ledgerFile}`)
        const body = JSON.stringify({ version: 1, rows: ledger.exportRows() }, null, 2)
        await fs.writeText(target, body)
      } catch (error) {
        ctx.logger?.('dsh-recon')?.warn?.('ledger persist failed: %s', error?.message || error)
      }
    },
    async load() {
      if (!cfg.ledgerPersist || !fs?.readText || !workdir) return
      try {
        const dir = workdir.defaultDirectory || '.'
        const target = await fs.resolve(`${dir}/${cfg.ledgerFile}`)
        const info = await fs.stat(target)
        if (!info) return
        const parsed = JSON.parse(await fs.readText(target))
        if (Array.isArray(parsed?.rows)) ledger.restore(parsed.rows)
      } catch {
        // absent or malformed ledger is not an error
      }
    },
  }
  persistHandle = persistence.load()

  // ---- correction attribution from later user messages ----
  //
  // Two independent guards, both load-bearing:
  //   1. SESSION scope: pendingFeedback is keyed by session, so a "不对" in one
  //      conversation can never mark a decision made in another. (Verified defect:
  //      it did.)
  //   2. GAP-TYPE scope: a message that corrects a `goal` assumption must not also
  //      settle a `preference` assumption that happened to be pending. Only the
  //      FIRST open decision is settled per message — one correction is one
  //      statement about one thing.
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    const sessionId = session?.id
    if (!sessionId) return
    const pending = pendingFeedback.get(sessionId)
    if (!pending || !pending.size) return

    const content = event.data?.message?.content
    const text = Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
      : String(content ?? '')
    if (!text) return

    const corrected =
      text.includes('不对') || text.includes('不是') || text.includes('错了') ||
      text.includes('其实') || text.includes('改成') ||
      /\bwrong\b|\bactually\b|\binstead\b/i.test(text)
    if (!corrected) return

    // Settle the most recent single open decision, not every open one.
    const entries = [...pending.entries()]
    const last = entries[entries.length - 1]
    if (!last) return
    const [decisionId] = last
    ledger.markCorrected(decisionId, text.slice(0, 120))
    pending.delete(decisionId)
    void persistHandle
  })

  ctx.effect?.(() => () => {
    pendingFeedback.clear()
  })

  // A session leaving the registry releases its pending-assumption set: without
  // this, a long-running process accumulates one stale map per closed conversation.
  ctx.on?.('session/disposed', (session) => {
    const sessionId = session?.id
    if (sessionId) pendingFeedback.delete(sessionId)
  })

  // ---- the single meta tool ----
  const dispose = ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Route one information gap to the cheapest existing channel (read_trace → query_sensor → ' +
      'read_multimodal → structured_form → minimal_question → assume_and_flag). Returns a strategy ' +
      'with an explicit cost comparison. Prefer this BEFORE asking the human: if assuming is cheaper ' +
      'than interrupting, it returns assume_and_flag and forbids the question.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.card || '' }],
    },
    async execute(args, exec) {
      const input = normalizeInput(args)
      const agent = exec?.agent

      if (input.feedback) {
        if (input.feedback.corrected) {
          ledger.markCorrected(input.feedback.decision_id, 'model-claimed feedback')
        } else {
          // An explicit "corrected: false" is a CONFIRMATION, and it ends the streak.
          ledger.markConfirmed(input.feedback.decision_id)
        }
        for (const perSession of pendingFeedback.values()) {
          perSession.delete(input.feedback.decision_id)
        }
        await persistence.save()
      }

      const adapters = buildAdapters({ ctx, agent, config: cfg, ledger })

      // act mode is v2 territory: the router itself never interrupts.
      const mode = input.mode
      const result = await route(input, adapters, ledger, {
        solveCoverage: cfg.solveCoverage,
        maxEvidenceItems: cfg.maxEvidenceItems,
        adaptiveConfidence: cfg.adaptiveConfidence,
        assumptionDefaults: cfg.assumptionDefaults,
        // The user's cost model, not the built-in one: retuning the gate must
        // not require editing source and restarting.
        policy: modelFromConfig(cfg),
      })

      if (mode === 'act' && ['structured_form', 'minimal_question'].includes(result.strategy)) {
        const adapter = adapters.find((a) => a.channel === result.strategy)
        const probe = await adapter?.probe?.(input)
        if (adapter?.act && probe?.available) {
          try {
            const act = await adapter.act(input, { ...probe, ...result.question_if_any, known_context: result.question_if_any?.known_context })
            if (act?.evidence?.length) result.evidence.push(...act.evidence)
          } catch (error) {
            result.skipped.push({ channel: result.strategy, reason: `act failed: ${error?.message || error}` })
            result.rationale += `\nact failed, falling back to flagged assumption: ${error?.message || error}`
          }
        }
      }

      const row = ledger.record({
        gap_type: result.gap_type,
        strategy: result.strategy,
        assumption_if_any: result.assumption_if_any,
        question_if_any: result.question_if_any,
        evidence: result.evidence,
        decision_at_stake: result.decision_at_stake,
        assumption_cost: result.ledgers?.assumption?.value ?? null,
        interrupt_cost: result.ledgers?.interrupt?.value ?? null,
        confidence: result.confidence ?? null,
        corrected: false,
        source: 'route',
      })
      result.decision_id = row.decision_id
      if (result.strategy === 'assume_and_flag' && agent?.id) {
        // Only an assumption can be "corrected later": a question already got
        // its answer, and a trace hit needed no judgement. Keyed by session.
        let perSession = pendingFeedback.get(agent.id)
        if (!perSession) {
          perSession = new Map()
          pendingFeedback.set(agent.id, perSession)
        }
        perSession.set(row.decision_id, result.assumption_if_any?.text || '')
        // Bounded: only the most recent few assumptions of a session can be
        // awaiting correction, so the map cannot grow for a long session.
        while (perSession.size > MAX_PENDING_PER_SESSION) {
          const oldest = perSession.keys().next().value
          perSession.delete(oldest)
        }
      }
      await persistence.save()

      result.card = renderCard(result)
      return dropNulls(result)
    },
    /**
     * The UI card. `execute` returns the canonical JSON value, which deliberately
     * has NO `content` field — JSON-safe output only. The rendered markdown lives
     * in `result.card`, so it must be lifted out here. (Verified defect: this
     * used to read `result.content`, which is always undefined, leaving every
     * tool card empty in the Web UI.)
     */
    presentResult: (args, result) => ({
      card: 'generic',
      title: `dsh-recon · ${result?.strategy || 'route'}`,
      content: result?.card ? [{ type: 'text', text: result.card }] : undefined,
    }),
  })

  // ---- diagnostics tool (read-only, no side effects) ----
  const disposeStats = ctx.tools.register({
    name: 'recon_strategy_stats',
    description:
      'Report the dsh-recon strategy distribution, correction rate, and gate calibration ' +
      'under the CURRENT cost model. Use it to verify the acceptance criterion ' +
      '(interruptions down without rework up) and to see whether retuning costModel ' +
      'actually moved the decision boundaries.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          distribution: { type: 'object' },
          corrections: { type: 'number' },
          correction_rate: { type: 'number' },
          recent: { type: 'array' },
          calibration: {
            type: 'object',
            additionalProperties: false,
            properties: {
              busy_assume: { type: 'number' },
              busy_total: { type: 'number' },
              idle_assume: { type: 'number' },
              idle_total: { type: 'number' },
              grid: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            required: ['busy_assume', 'busy_total', 'idle_assume', 'idle_total'],
          },
        },
        required: ['total', 'distribution'],
      },
      render: (_a, v) => {
        const lines = [
          `total=${v.total} corrections=${v.corrections} rate=${v.correction_rate}`,
          ...Object.entries(v.distribution).map(([k, n]) => `  ${k}: ${n}`),
        ]
        if (v.calibration) {
          const c = v.calibration
          lines.push(
            '',
            '闸门校准（当前 costModel）',
            `  忙碌时选择假设: ${c.busy_assume}/${c.busy_total}`,
            `  空闲时选择假设: ${c.idle_assume}/${c.idle_total}`,
          )
          for (const row of c.grid || []) {
            lines.push(
              `  ${String(row.risk).padEnd(16)} ${String(row.state).padEnd(4)}` +
                ` assume=${String(row.assume).padEnd(6)} interrupt=${String(row.interrupt).padEnd(6)} -> ${row.decision}`,
            )
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const rows = ledger.recent(200)
      const total = rows.length
      const corrections = rows.filter((r) => r.corrected).length

      // Replay the gate over every declared risk x user state under the LIVE
      // cost model. This makes retuning observable instead of guesswork.
      const model = modelFromConfig(cfg)
      const grid = []
      for (const reversibility of ['high', 'medium', 'low']) {
        for (const blast_radius of ['local', 'module', 'system']) {
          const input = {
            gap_type: 'goal',
            decision_at_stake: 'calibration',
            reversibility,
            blast_radius,
            declared: { reversibility: true, blast_radius: true },
          }
          for (const [state, userState] of [
            ['忙碌', { busy: true, recently_corrected: false, idle_seconds: 0 }],
            ['空闲', { busy: false, recently_corrected: false, idle_seconds: 3600 }],
          ]) {
            const a = assumptionCost(input, [], model)
            const i = interruptCost(userState, model)
            const g = gate(a, i)
            grid.push({
              risk: reversibility + '/' + blast_radius,
              state,
              assume: a.value,
              interrupt: i.value,
              decision: g.prefer_assumption ? '假设' : '打断',
            })
          }
        }
      }
      const busy = grid.filter((r) => r.state === '忙碌')
      const idle = grid.filter((r) => r.state === '空闲')
      const calibration = {
        busy_assume: busy.filter((r) => r.decision === '假设').length,
        busy_total: busy.length,
        idle_assume: idle.filter((r) => r.decision === '假设').length,
        idle_total: idle.length,
        grid,
      }

      return {
        total,
        distribution: strategyDistribution(rows.map((r) => ({ strategy: r.strategy }))),
        corrections,
        correction_rate: total ? Math.round((corrections / total) * 100) / 100 : 0,
        recent: rows.slice(-5).map((r) => ({
          decision_id: r.decision_id,
          gap_type: r.gap_type,
          strategy: r.strategy,
          corrected: r.corrected,
        })),
        calibration,
      }
    },
  })

  // ---- read-only panel route: isolate every failure from the router ----
  ctx.inject?.(['webServer'], (host) => {
    try {
      host.effect?.(() => host.webServer.register(createSnapshotRoute(ledger)))
    } catch (error) {
      ctx.logger?.('dsh-recon')?.warn?.('snapshot route registration failed: %s', error?.message || error)
    }
  })

  ctx.effect?.(() => () => {
    dispose?.()
    disposeStats?.()
  })
}

