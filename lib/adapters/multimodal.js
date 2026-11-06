// read_multimodal adapter — MVP PLACEHOLDER.
//
// The only documented multimodal seam is `ctx.speechToText.listProviders()` for
// voice; vision/screen tools exist in the ecosystem but are third-party tools.
// We probe those and report unavailable. TODO(adapter): wire the vision/screen
// tools once their argument contracts are verified.

export function createMultimodalAdapter({ ctx, agent, config }) {
  const names = config?.multimodalTools ?? []
  return {
    channel: 'read_multimodal',
    async probe() {
      const tools = ctx?.get?.('tools')
      const speech = ctx?.get?.('speechToText')
      const voiceProviders = []
      if (speech?.listProviders) {
        try {
          for (const p of speech.listProviders()) voiceProviders.push(p?.id ?? String(p))
        } catch {
          // optional service; a throwing lister means "no providers today"
        }
      }
      const found = names.filter((n) => tools?.get && tools.get(n, agent))
      if (!found.length && !voiceProviders.length) {
        return {
          available: false,
          reason: 'no multimodal trace tool or speech provider visible',
          evidence: [],
          interruptCost: 0,
        }
      }
      return {
        available: false,
        reason:
          `multimodal capability visible (tools: ${found.join(', ') || '—'}; speech: ${voiceProviders.join(', ') || '—'}) ` +
          'but read_multimodal is a placeholder in this MVP',
        evidence: [],
        interruptCost: 0,
        note: 'TODO: wire vision/screen/voice evidence extraction',
      }
    },
  }
}
