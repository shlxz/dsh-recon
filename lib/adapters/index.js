// Adapter factory — the ONLY place that touches `ctx` and knows plugin/service
// names. The router never imports from here; it receives only the six adapter
// objects, so the decision logic stays testable without a Harness.

import { createTraceAdapter } from './trace.js'
import { createSensorAdapter } from './sensor.js'
import { createMultimodalAdapter } from './multimodal.js'
import { createFormAdapter } from './form.js'
import { createQuestionAdapter } from './question.js'
import { createAssumeAdapter } from './assume.js'

export function buildAdapters({ ctx, agent, config, ledger }) {
  return [
    createTraceAdapter({ ctx, agent, config, ledger }),
    createSensorAdapter({ ctx, agent, config }),
    createMultimodalAdapter({ ctx, agent, config }),
    createFormAdapter({ ctx, agent, config }),
    createQuestionAdapter({ ctx, agent, config }),
    createAssumeAdapter({ ctx, agent, config }),
  ]
}
