import { buildFallback, parsePluginLedger } from "../../src/validation.js"
import type { ProviderAdapter } from "../types.js"

export const fixtureProvider: ProviderAdapter = {
  name: "fixture",
  async complete(request) {
    const prompt = request.messages.at(-1)?.content ?? ""
    const transcript = request.messages.slice(0, -1).map((message) => message.content).join("\n")
    if (request.condition === "plugin") {
      const ledger = parsePluginLedger(prompt)
      if (!ledger) throw new Error(`fixture could not parse ledger for ${request.caseID}`)
      if (request.repetition === 1) return { text: "## Goal\n- malformed fixture response" }
      if (request.repetition === 2) return { text: "I cannot produce the requested structure." }
      return { text: buildFallback({ ledger, maxBytes: 49_152 }) }
    }
    if (request.repetition === 2) return { text: "I cannot produce the requested structure." }
    return {
      text: `## Objective
- Preserve the transcript facts.

## Important Details
- ${singleLine(transcript)}

## Work State
### Completed
- Bounded fixture response generated.

### Active
- Continue the newest request.

### Blocked
- Use the recorded error.

## Next Move
1. Follow the recorded next action.
2. Verify before claiming completion.

## Relevant Files
- See the exact path in Important Details.`,
    }
  },
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim()
}
