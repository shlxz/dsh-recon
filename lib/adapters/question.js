// minimal_question adapter — ONE free-form question, always carrying what we know.
//
// Same platform primitive as form.js, deliberately limited to a single question
// with a `detail` prefixed by the known-evidence line, so the human is never asked
// to re-state what the trace already answered.

import { makeEvidence } from './contract.js'

export function createQuestionAdapter({ ctx, agent, config }) {
  function askService() {
    const uq = ctx?.get?.('userQuestions')
    return uq?.ask ? uq : null
  }

  function blocked(input) {
    const uq = askService()
    if (!uq) return 'ctx.userQuestions unavailable'
    const agents = ctx?.get?.('agents')
    if (agents?.isOwnedBy && agent?.id) {
      try {
        for (const root of agents.roots?.() ?? []) {
          if (agents.isOwnedBy(agent.id, root)) return 'delegated caller has no human answerer (would block)'
        }
      } catch {
        // advisory only
      }
    }
    return null
  }

  return {
    channel: 'minimal_question',

    async probe(input) {
      const why = blocked(input)
      if (why) return { available: false, reason: why, evidence: [], interruptCost: 0.25 }
      return {
        available: true,
        coverage: 'none',
        evidence: [],
        interruptCost: 0.25, // one free-form question = cheapest possible interruption
        note: 'a single question with the known-context prefix',
      }
    },

    async act(input, probe) {
      const uq = askService()
      if (!uq) throw new Error('ctx.userQuestions unavailable')
      const detail =
        `${probe?.known_context || ''}\n只问这一句，回答后直接开工。`.trim()
      const answer = await uq.ask({
        questions: [
          {
            id: 'gap',
            header: '只差一点',
            question: probe?.ask || `关于「${input.decision_at_stake}」，哪一点最关键？`,
            detail,
          },
        ],
        agent,
        signal: AbortSignal.timeout(config?.askTimeoutMs ?? 60_000),
      })
      const first = answer?.answers?.[0]
      const text = first?.custom || (first?.selected || []).join('/') || ''
      return {
        evidence: text
          ? [
              makeEvidence({
                channel: 'minimal_question',
                plugin: 'dsh-core',
                tool: 'userQuestions.ask',
                ref: 'answer:gap',
                text,
                weight: 0.5,
                verified: true,
              }),
            ]
          : [],
      }
    },
  }
}
