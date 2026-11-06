// structured_form adapter — one-shot, bounded question count.
//
// Calls the PLATFORM primitive `ctx.userQuestions.ask` directly (confirmed by the
// user-questions subsystem docs). That is not "bypassing existing plugins": ask is
// the lowest-level existing capability. `config.formTool` defaults to null; when a
// user explicitly names a form plugin, we probe for it first and use it instead.
//
// TODO(adapter): `ask()` only admits the exact live RUNTIME ROOT. A delegated
// child gets `DELEGATED_CALLER`; we surface that as `available:false` so the router
// falls through to assume_and_flag instead of hanging.

import { makeEvidence } from './contract.js'

const MAX_FIELDS = 3

// A gap type has "structured fields" only when it can be decomposed into more
// than one decision-bearing question. environment/acceptance cannot: they collapse
// into one generic prompt, which is exactly what minimal_question already sends.
const STRUCTURED_GAP_TYPES = new Set(['goal', 'constraint', 'preference'])

function fieldsFor(input, limit) {
  const base = [{ id: 'decision', header: '关键取舍', question: questionFor(input) }]
  if (input.gap_type === 'goal') {
    base.push({
      id: 'outcome',
      header: '结果形态',
      question: '最终交付物是文档、代码、还是直接改到仓库里？',
    })
  }
  if (input.gap_type === 'constraint') {
    base.push({ id: 'limit', header: '硬限制', question: '有哪条不能突破的限制（时间/预算/权限）？' })
  }
  if (input.gap_type === 'preference') {
    base.push({ id: 'taste', header: '风格取舍', question: '更偏向哪种做法？' })
  }
  return base.slice(0, Math.max(1, limit))
}

/** True when this gap type has a form worth sending (more than one generic field). */
export function hasStructuredFields(input) {
  return STRUCTURED_GAP_TYPES.has(input.gap_type)
}

function questionFor(input) {
  if (input.gap_type === 'goal') return `「${input.decision_at_stake}」最终要得到什么结果？`
  if (input.gap_type === 'constraint') return `「${input.decision_at_stake}」有哪条硬限制？`
  if (input.gap_type === 'preference') return `「${input.decision_at_stake}」你更偏向哪种取舍？`
  if (input.gap_type === 'environment') return `「${input.decision_at_stake}」依赖哪个当前事实（路径/端口/服务）？`
  if (input.gap_type === 'acceptance') return `「${input.decision_at_stake}」怎样才算做完？`
  return `关于「${input.decision_at_stake}」，哪一点最影响你的判断？`
}

export function createFormAdapter({ ctx, agent, config }) {
  const limit = Math.min(Math.max(config?.maxFormQuestions ?? MAX_FIELDS, 1), MAX_FIELDS)

  function askService() {
    const uq = ctx?.get?.('userQuestions')
    if (!uq?.ask) return null
    return uq
  }

  return {
    channel: 'structured_form',

    async probe(input) {
      const uq = askService()
      if (!uq) {
        return {
          available: false,
          reason: 'ctx.userQuestions unavailable',
          evidence: [],
          interruptCost: 0.3,
        }
      }
      // An owned child has no human answerer; asking would block forever.
      const agents = ctx?.get?.('agents')
      if (agents?.isOwnedBy && agent?.id) {
        try {
          for (const root of agents.roots?.() ?? []) {
            if (agents.isOwnedBy(agent.id, root)) {
              return {
                available: false,
                reason: 'delegated caller has no human answerer (would block)',
                evidence: [],
                interruptCost: 0.3,
              }
            }
          }
        } catch {
          // ownership check is advisory; fall through and let ask() decide
        }
      }

      // Optional third-party form plugin, only when explicitly configured.
      const formTool = config?.formTool
      if (formTool) {
        const tools = ctx?.get?.('tools')
        const visible = Boolean(tools?.get?.(formTool, agent))
        if (!visible) {
          return {
            available: false,
            reason: `configured formTool "${formTool}" is not visible`,
            evidence: [],
            interruptCost: 0.3,
          }
        }
      }

      // No structured decomposition for this gap type. Returning available:false
      // is honest: the alternative is two channels emitting the SAME ask under
      // different names, which would make the router compare channel labels
      // instead of solving power. The router then falls through to
      // minimal_question, which is the only thing this form would have done.
      if (!hasStructuredFields(input)) {
        return {
          available: false,
          reason: `no structured fields configured for gap_type=${input.gap_type}`,
          evidence: [],
          interruptCost: 0.35,
        }
      }

      return {
        available: true,
        coverage: 'none',
        evidence: [],
        fields: fieldsFor(input, limit),
        note: formTool ? `routed through configured formTool ${formTool}` : 'routed through ctx.userQuestions.ask',
        // A structured form is cheaper than free-form prose for the human.
        interruptCost: 0.35,
      }
    },

    /**
     * Only reachable with mode:'act'. Bounded, one-shot, no free-form form UI.
     */
    async act(input, probe) {
      const uq = askService()
      if (!uq) throw new Error('ctx.userQuestions unavailable')
      const fields = probe?.fields?.length ? probe.fields : fieldsFor(input, limit)
      // The known-context prefix is a CONTRACT, not a nicety: a structured form that
      // silently drops what the trace already proved re-asks the human for it.
      const known = probe?.known_context || ''
      const questions = fields.map((f) => ({
        id: f.id,
        header: f.header,
        question: f.question,
        detail: [known, f.detail].filter(Boolean).join('\n') || undefined,
        options: f.options,
      }))
      const answer = await uq.ask({
        questions,
        agent,
        signal: AbortSignal.timeout(config?.askTimeoutMs ?? 90_000),
      })
      // A skipped question (empty `selected`, no `custom`) is a legitimate batch
      // member — the Host uses it to preserve a skipped item. It carries NO
      // information, so it must not become Evidence: `id=` alone would inflate
      // coverage and silently discount the assumption cost.
      const evidence = []
      for (const a of answer?.answers || []) {
        const value = a.custom || (a.selected || []).join('/')
        if (!value) continue
        evidence.push(
          makeEvidence({
            channel: 'structured_form',
            plugin: 'dsh-core',
            tool: 'userQuestions.ask',
            ref: `answer:${a.id}`,
            text: `${a.id}=${value}`,
            weight: 0.5,
          }),
        )
      }
      return { evidence }
    },
  }
}
