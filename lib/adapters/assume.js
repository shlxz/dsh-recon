// assume_and_flag adapter — always available, never interrupts.
//
// Pure: it produces no evidence (there is nothing to observe) and exists so the
// router's channel table is complete and the card can render the assumption text.

export function createAssumeAdapter({ config }) {
  return {
    channel: 'assume_and_flag',
    async probe() {
      return {
        available: true,
        coverage: 'none',
        evidence: [],
        interruptCost: 0,
        note: 'fallback: proceed on the stated default and flag it in the deliverable',
        defaults: config?.assumptionDefaults ?? {},
      }
    },
  }
}
