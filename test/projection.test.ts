import { describe, expect, test } from "bun:test"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import {
  ledgerReferenceID,
  parseProjectionBlock,
  parseProjectionJSON,
  projectionBudget,
  remapProjection,
  renderProjection,
  type ProjectedSummary,
} from "../src/projection.js"

function ledger(data: Partial<RecoveryLedgerData> = {}) {
  return canonicalLedger({
    recent_requests: ["review the project"],
    constraints: ["preserve the CSV schema"],
    todos: [],
    touched_paths: ["aidocs/reviews/027.md"],
    tool_statuses: [{ tool: "write", status: "completed", title: "aidocs/reviews/027.md" }],
    errors: [],
    evidence: ["329 rows verified"],
    next_actions: [],
    legacy_context: [],
    ...data,
  })
}

function projection(current = ledger()): ProjectedSummary {
  const ref = (section: string, value: unknown) => [ledgerReferenceID(section, value)]
  return {
    version: 1,
    goal: { text: "Review the project", ledger_refs: ref("recent_requests", "review the project") },
    constraints: [{ text: "Preserve the CSV schema", ledger_refs: ref("constraints", "preserve the CSV schema") }],
    decisions: [],
    current_state: [{ text: "The review is complete", ledger_refs: ref("evidence", "329 rows verified") }],
    files: [{ path: "aidocs/reviews/027.md", status: "changed", summary: "Review written", evidence_refs: ref("evidence", "329 rows verified") }],
    evidence: [{ text: "329 rows verified", ledger_refs: ref("evidence", "329 rows verified") }],
    blockers: [],
    next_actions: [],
    ledger_sha256: current.digest,
  }
}

describe("validated model projection", () => {
  test("accepts a referenced JSON projection and renders a durable block", () => {
    const current = ledger()
    const value = projection(current)
    const parsed = parseProjectionJSON(JSON.stringify(value), current, projectionBudget(49_152, 12_288))
    expect(parsed).toEqual(value)
    const rendered = renderProjection(value, current, 49_152)
    expect(rendered).toBeDefined()
    expect(parseProjectionBlock(rendered!)).toEqual(value)
  })

  test("rejects duplicate keys and missing provenance", () => {
    const current = ledger()
    expect(parseProjectionJSON('{"version":1,"version":1}', current, 16_384)).toBeUndefined()
    const invalid = projection(current)
    invalid.goal.ledger_refs = []
    expect(parseProjectionJSON(JSON.stringify(invalid), current, 16_384)).toBeUndefined()
  })

  test("remaps stable references onto a newer ledger and drops stale claims", () => {
    const oldLedger = ledger()
    const old = projection(oldLedger)
    const newer = ledger({ evidence: ["329 rows verified", "new evidence"] })
    const remapped = remapProjection(old, newer)
    expect(remapped?.ledger_sha256).toBe(newer.digest)
    expect(remapped?.goal.text).toBe(old.goal.text)

    const changed = ledger({ evidence: ["different evidence"] })
    const changedProjection = remapProjection(old, changed)
    expect(changedProjection?.goal.text).toBe(old.goal.text)
    expect(changedProjection?.evidence).toEqual([])
  })

  test("reserves space for the ledger and rendering overhead", () => {
    expect(projectionBudget(49_152, 12_288)).toBe(16_384)
    expect(projectionBudget(10_000, 8_000)).toBeLessThan(2_048)
  })
})
