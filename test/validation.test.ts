import { describe, expect, test } from "bun:test"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import {
  REQUIRED_SECTIONS,
  buildAuthoritativeSummary,
  isAuthoritativeSummary,
  isPluginValidSummary,
} from "../src/validation.js"

const EMPTY_DATA: RecoveryLedgerData = {
  recent_requests: [],
  constraints: [],
  todos: [],
  touched_paths: [],
  tool_statuses: [],
  errors: [],
  evidence: [],
  next_actions: [],
  legacy_context: [],
}

describe("authoritative summary", () => {
  test("is a deterministic projection of the canonical ledger", () => {
    const ledger = canonicalLedger({
      ...EMPTY_DATA,
      recent_requests: ["Finish the parser"],
      constraints: ["Do not edit generated files"],
      next_actions: ["Run typecheck"],
    })
    const first = buildAuthoritativeSummary({ ledger, maxBytes: 16_384 })
    const second = buildAuthoritativeSummary({ ledger, maxBytes: 16_384 })

    expect(first).toBe(second)
    expect(isAuthoritativeSummary(first, 16_384)).toBe(true)
  })

  test("does not trust arbitrary prose with a valid ledger digest", () => {
    const ledger = canonicalLedger({ ...EMPTY_DATA, recent_requests: ["Keep the real request"] })
    const provider = REQUIRED_SECTIONS.map((section) =>
      `## ${section}\n- password=provider-secret; unsupported deployment completed`
    ).join("\n\n") + `\n\n${ledger.block}`

    expect(isPluginValidSummary(provider, 16_384)).toBe(true)
    expect(isAuthoritativeSummary(provider, 16_384)).toBe(false)
    expect(buildAuthoritativeSummary({ ledger, maxBytes: 16_384 })).not.toContain("provider-secret")
  })
})
