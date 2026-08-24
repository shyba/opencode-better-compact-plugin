import { ledgerReferenceID, PROJECTION_SECTION_LIMITS } from "../../src/projection.js"
import { buildFallback, parsePluginLedger } from "../../src/validation.js"
import type { ProjectedAction, ProjectedFile, ProjectionClaim, ProjectedSummary } from "../../src/projection.js"
import type { RecoveryLedger } from "../../src/ledger.js"
import type { Condition, ProviderAdapter } from "../types.js"
import { cases } from "../cases.js"

export const fixtureProvider: ProviderAdapter = {
  name: "fixture",
  async complete(request) {
    if (request.caseID.endsWith(":continuation")) {
      const test = cases.find((value) => value.id === request.caseID.slice(0, -":continuation".length))
      if (!test) return { text: "Continue from the accepted summary." }
      const action = test.next_action
      return { text: `Next verified action: ${test.todos.find((todo) => todo.id === action.todo_id)?.content ?? "Continue from the accepted summary."} at ${action.target}; ${action.required_atoms.join("; ")}` }
    }
    const prompt = request.messages.at(-1)?.content ?? ""
    const transcript = request.messages.slice(0, -1).map((message) => message.content).join("\n")
    if (request.condition === "baseline") {
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
    }
    const ledger = parsePluginLedger(prompt)
    if (!ledger) throw new Error(`fixture could not parse ledger for ${request.caseID}`)
    if (request.condition === "json") {
      if (request.repetition === 1) return { text: '{"version":1,"version":1}' }
      if (request.repetition === 2) return { text: "I cannot produce the requested structure." }
      return { text: JSON.stringify(fixtureProjection(ledger)) }
    }
    if (request.repetition === 1) return { text: "## Goal\n- malformed fixture response" }
    if (request.repetition === 2) return { text: "I cannot produce the requested structure." }
    return { text: buildFallback({ ledger, maxBytes: 49_152 }) }
  },
}

function fixtureProjection(ledger: RecoveryLedger): ProjectedSummary {
  const data = ledger.data
  const claim = (section: string, value: string): ProjectionClaim => ({
    text: value,
    ledger_refs: [ledgerReferenceID(section, value)],
  })
  const candidates: Array<{ section: string; value: string }> = [
    ...data.recent_requests.slice().reverse().map((value) => ({ section: "recent_requests" as const, value })),
    ...data.evidence.map((value) => ({ section: "evidence" as const, value })),
    ...data.constraints.map((value) => ({ section: "constraints" as const, value })),
    ...data.next_actions.map((value) => ({ section: "next_actions" as const, value })),
  ]
  const goalEntry = candidates.find((entry) => entry.value.trim().length > 2)
  const goal = goalEntry
    ? claim(goalEntry.section, goalEntry.value)
    : { text: "Resume the interrupted session from the canonical ledger.", ledger_refs: [] }
  const files: ProjectedFile[] = data.evidence[0]
    ? data.touched_paths.map((path) => ({
        path,
        status: "changed",
        summary: "Touched during the session.",
        evidence_refs: [ledgerReferenceID("evidence", data.evidence[0])],
      }))
    : []
  const nextActions: ProjectedAction[] = data.next_actions.map((value) => ({
    text: value,
    status: "proposed",
    ledger_refs: [ledgerReferenceID("next_actions", value)],
  }))
  return {
    version: 1,
    goal,
    constraints: data.constraints.map((value) => claim("constraints", value)),
    decisions: [],
    current_state: data.tool_statuses.slice(0, PROJECTION_SECTION_LIMITS.current_state).map((status) => ({
      text: `${status.tool}: ${status.status}${status.title ? ` — ${status.title}` : ""}`,
      ledger_refs: [ledgerReferenceID("tool_statuses", status)],
    })),
    files,
    evidence: data.evidence.map((value) => claim("evidence", value)),
    blockers: data.errors.map((value) => claim("errors", value)),
    next_actions: nextActions,
    ledger_sha256: ledger.digest,
  }
}

function singleLine(value: string) {
  return value.replace(/\s+/g, " ").trim()
}
