// query_sensor adapter — MVP PLACEHOLDER.
//
// The design says "ask the environment through existing plugins, never import
// them". DSH exposes third-party sensor capability only as TOOLS, so this
// adapter probes `ctx.tools.get(name, agent)` for configured names and, if one
// exists, can call it through the documented tool pipeline.
//
// MVP scope: probe + report "channel unavailable" with the exact reason and the
// candidate list it looked for. Executing an arbitrary third-party sensor tool
// needs a per-plugin argument contract we have not verified, so `act` is not
// wired. TODO(adapter): define a small sensor intent protocol (path/port/
// process/service) and map it onto the configured tools.

import { makeEvidence } from './contract.js'

export function createSensorAdapter({ ctx, agent, config }) {
  const names = config?.sensorTools ?? []
  return {
    channel: 'query_sensor',
    async probe(input) {
      const tools = ctx?.get?.('tools')
      const found = []
      const missing = []
      for (const name of names) {
        if (tools?.get && tools.get(name, agent)) found.push(name)
        else missing.push(name)
      }
      if (!found.length) {
        return {
          available: false,
          reason:
            names.length === 0
              ? 'no sensorTools configured'
              : `none of the configured sensor tools is visible (missing: ${missing.join(', ')})`,
          evidence: [],
          interruptCost: 0,
        }
      }
      // TODO(adapter): wire act() once a sensor intent protocol exists.
      return {
        available: false,
        reason: `sensor tools visible (${found.join(', ')}) but query_sensor is a placeholder in this MVP`,
        evidence: [],
        interruptCost: 0,
        note: 'TODO: map gap_type/decision_at_stake onto the sensor argument contract',
      }
    },
  }
}

export { makeEvidence }
