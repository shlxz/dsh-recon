// read_trace adapter — evidence from what the session already recorded.
//
// Uses only documented Host services (verified via cordis_inspect_query):
//   ctx.sessionQuery.readSurface / filterEvents   (unified live-preferred query)
//   ctx.sessionProjections.stateOf                 (userQuestions projection)
//   ctx.sessions.get                               (live session lookup)
//
// TODO(adapter): `sessionProjections.stateOf` returns RAW state (confirmed by
// the heartbeat plugin's 0.6.1 regression) — we therefore treat every read as
// optional and tolerate a missing key instead of asserting its shape.
// TODO(adapter): projection key `userQuestions` is confirmed in the docs but its
// `{active, settled}` shape is re-checked here defensively on every read.

import { cueCount, hasCorrectionCue, makeEvidence } from './contract.js'

const MAX_SCANNED_MESSAGES = 40

function textOfMessageEvent(event) {
  const content = event?.data?.message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
  }
  return ''
}

export function createTraceAdapter({ ctx, agent, config, ledger }) {
  return {
    channel: 'read_trace',
    async probe(input) {
      const evidence = []
      const notes = []

      // 1) Ledger: what this gap type already produced in this process.
      //
      // Deduplicated by the fact being asserted, not by row identity. Two rows
      // that say "constraint was handled by read_trace" are ONE fact; counting
      // them twice inflated coverage and quietly raised confidence.
      const prior = ledger?.recent?.(20) ?? []
      const sameGap = prior.filter((r) => r.gap_type === input.gap_type && !r.corrected).slice(-2)
      const seen = new Set()
      for (const row of sameGap) {
        const text = `${row.gap_type} 此前已按「${row.strategy}」处理${
          row.assumption ? `，假设为：${row.assumption}` : ''
        }`.replace(/。$/, '')
        if (seen.has(text)) continue
        seen.add(text)
        evidence.push(
          makeEvidence({
            channel: 'read_trace',
            plugin: 'dsh-recon',
            tool: 'ledger',
            ref: row.decision_id,
            text,
            weight: 0.25,
          }),
        )
      }

      // 2) Live session surface: user corrections and cue-bearing messages.
      const sessionId = agent?.id
      const sessionQuery = ctx?.get?.('sessionQuery')
      if (!sessionId || !sessionQuery?.readSurface) {
        notes.push('sessionQuery.readSurface unavailable')
      } else {
        try {
          const surface = await sessionQuery.readSurface(sessionId)
          const events = (surface?.events || []).slice(-MAX_SCANNED_MESSAGES)
          // Two very different "nothing found" outcomes must not share a message:
          //   first_turn  — there was nothing to read (channel is healthy, context is new)
          //   scanned     — we read N events and none matched (a real negative result)
          // Lumping them together makes the model think the trace channel is broken.
          const scanned = events.filter((e) => e?.type === 'user/message').length
          let hits = 0
          for (const event of events) {
            if (event?.type !== 'user/message') continue
            const text = textOfMessageEvent(event)
            if (!text) continue
            const cues = cueCount(text, input.gap_type)
            const corrected = hasCorrectionCue(text)
            // A session correction ("不要用 moment" / "改成 date-fns") is the strongest
            // preference evidence we can find without asking, whatever the gap type.
            const prefCues = cueCount(text, 'preference')
            if (cues === 0 && !corrected) continue
            hits += 1
            const weight = Math.min(
              0.75,
              (corrected ? 0.45 : 0) + (cues >= 2 ? 0.2 : cues === 1 ? 0.1 : 0) +
                (prefCues >= 2 ? 0.2 : prefCues === 1 ? 0.1 : 0),
            )
            evidence.push(
              makeEvidence({
                channel: 'read_trace',
                plugin: 'dsh-core',
                tool: 'sessionQuery.readSurface',
                ref: `${sessionId}#${event.seq}`,
                text,
                weight,
              }),
            )
            if (hits >= 3) break
          }
          if (!hits) {
            if (scanned === 0) {
              notes.push('first_turn: no prior events to read')
            } else {
              notes.push(`scanned ${scanned} events, none matched`)
            }
          } else {
            notes.push(`scanned ${scanned} events, ${hits} matched`)
          }
        } catch (error) {
          notes.push(`readSurface failed: ${error?.message || error}`)
        }
      }

      // 3) Structured answers the user already gave (settled user questions).
      const projections = ctx?.get?.('sessionProjections')
      const sessions = ctx?.get?.('sessions')
      if (projections?.stateOf && sessions?.get && sessionId) {
        try {
          const session = sessions.get(sessionId)
          if (session) {
            const state = projections.stateOf(session, 'userQuestions')
            const settled = state?.settled
            if (Array.isArray(settled)) {
              const last = settled.slice(-2)
              for (const s of last) {
                const answers = s?.answers || []
                const text = answers
                  .map((a) => a.custom || (a.selected || []).join('/'))
                  .filter(Boolean)
                  .join('；')
                if (!text) continue
                evidence.push(
                  makeEvidence({
                    channel: 'read_trace',
                    plugin: 'dsh-core',
                    tool: 'sessionProjections.stateOf',
                    ref: `userQuestions:${s.callId}`,
                    text: `用户此前已作答：${text}`,
                    weight: 0.4,
                  }),
                )
              }
              if (!last.length) notes.push('no settled user question yet')
            } else {
              notes.push('userQuestions projection absent or not shaped as {settled[]}')
            }
          }
        } catch (error) {
          notes.push(`projection read failed: ${error?.message || error}`)
        }
      } else {
        notes.push('sessionProjections/sessions unavailable')
      }

      return {
        available: true,
        coverage: evidence.length ? 'partial' : 'none',
        evidence,
        interruptCost: 0, // reading a trace never interrupts the human
        note: notes.join('; ') || undefined,
      }
    },
  }
}
