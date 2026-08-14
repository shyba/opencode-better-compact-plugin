import { describe, expect, test } from "bun:test"
import {
  canonicalLedger,
  truncateUtf8,
  utf8Bytes,
  type RecoveryLedger,
  type RecoveryLedgerData,
} from "../src/ledger.js"
import {
  PROJECTION_ACTIONS_MAX,
  PROJECTION_FILES_MAX,
  PROJECTION_SECTION_LIMITS,
  ledgerReferenceID,
  ledgerReferenceIDs,
  parseProjectionEnvelope,
  parseProjectionBlock,
  parseProjectionJSON,
  projectionBudget,
  remapProjection,
  renderProjection,
  type ProjectedSummary,
} from "../src/projection.js"
import { DEFAULT_OPTIONS } from "../src/options.js"

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

  test("validates a strict projection envelope without weakening duplicate-key checks", () => {
    const current = ledger()
    const value = { ...projection(current), semantic_delta: { upserts: [] } }
    expect(parseProjectionEnvelope(JSON.stringify(value), current, 49_152, ["semantic_delta"])?.extras).toEqual({ semantic_delta: { upserts: [] } })
    expect(parseProjectionEnvelope(JSON.stringify(value).replace('"semantic_delta":', '"semantic_delta":{},"semantic_delta":'), current, 49_152, ["semantic_delta"])).toBeUndefined()
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

describe("per-section projection limits", () => {
  const current = ledger()
  const ref = (section: string, value: unknown) => [ledgerReferenceID(section, value)]
  const claims = (count: number) =>
    Array.from({ length: count }, () => ({ text: "x", ledger_refs: ref("evidence", "329 rows verified") }))
  const files = (count: number) =>
    Array.from({ length: count }, () => ({
      path: "aidocs/reviews/027.md",
      status: "changed" as const,
      summary: "Review written",
      evidence_refs: ref("evidence", "329 rows verified"),
    }))
  const actions = (count: number) =>
    Array.from({ length: count }, () => ({
      text: "Run the regression",
      status: "proposed" as const,
      ledger_refs: ref("evidence", "329 rows verified"),
    }))

  test("enforces the distinct per-section item limits", () => {
    const base = projection(current)
    const parse = (value: ProjectedSummary) =>
      parseProjectionJSON(JSON.stringify(value), current, 16_384)
    const over = (section: keyof ProjectedSummary, value: unknown) =>
      parse({ ...base, [section]: value })

    for (const [section, limit] of [
      ["constraints", PROJECTION_SECTION_LIMITS.constraints],
      ["decisions", PROJECTION_SECTION_LIMITS.decisions],
      ["current_state", PROJECTION_SECTION_LIMITS.current_state],
      ["blockers", PROJECTION_SECTION_LIMITS.blockers],
      ["evidence", PROJECTION_SECTION_LIMITS.evidence],
    ] as const) {
      expect(parse({ ...base, [section]: claims(limit) })).toBeDefined()
      expect(over(section, claims(limit + 1))).toBeUndefined()
    }
    expect(parse({ ...base, files: files(PROJECTION_FILES_MAX) })).toBeDefined()
    expect(over("files", files(PROJECTION_FILES_MAX + 1))).toBeUndefined()
    expect(parse({ ...base, next_actions: actions(PROJECTION_ACTIONS_MAX) })).toBeDefined()
    expect(over("next_actions", actions(PROJECTION_ACTIONS_MAX + 1))).toBeUndefined()
  })

  test("does not let the derived budget inflate section allowances", () => {
    const saturated = claims(PROJECTION_SECTION_LIMITS.evidence + 1)
    expect(parseProjectionJSON(JSON.stringify({ ...projection(current), evidence: saturated }), current, 16_384)).toBeUndefined()
  })
})

describe("stale projected next actions", () => {
  test("surfaces stale actions as blockers instead of silently dropping them", () => {
    const oldLedger = ledger()
    const old = projection(oldLedger)
    old.next_actions = [
      { text: "Run the regression", status: "proposed", ledger_refs: [ledgerReferenceID("evidence", "329 rows verified")] },
      { text: "Reproduce the timeout", status: "proposed", ledger_refs: [ledgerReferenceID("evidence", "329 rows verified")] },
    ]
    const changed = ledger({ evidence: ["different evidence"] })
    const remapped = remapProjection(old, changed)

    expect(remapped).toBeDefined()
    expect(remapped!.next_actions).toEqual([])
    expect(remapped!.blockers).toHaveLength(2)
    for (const blocker of remapped!.blockers) {
      expect(blocker.text).toContain("[stale projected action]")
      expect(blocker.text).toContain("verify before resuming")
      expect(blocker.ledger_refs).toEqual([ledgerReferenceID("recent_requests", "review the project")])
    }
  })

  test("keeps actions whose references still resolve", () => {
    const oldLedger = ledger()
    const old = projection(oldLedger)
    old.next_actions = [
      { text: "Review the project", status: "proposed", ledger_refs: [ledgerReferenceID("recent_requests", "review the project")] },
      { text: "Stale step", status: "proposed", ledger_refs: [ledgerReferenceID("evidence", "329 rows verified")] },
    ]
    const changed = ledger({ evidence: ["different evidence"] })
    const remapped = remapProjection(old, changed)

    expect(remapped?.next_actions.map((item) => item.text)).toEqual(["Review the project"])
    expect(remapped?.blockers[0]?.text).toContain("[stale projected action]")
  })

  test("bounds stale-action blockers to the blockers limit", () => {
    const oldLedger = ledger()
    const old = projection(oldLedger)
    old.blockers = Array.from({ length: PROJECTION_SECTION_LIMITS.blockers }, () => ({
      text: "Existing blocker",
      ledger_refs: [ledgerReferenceID("recent_requests", "review the project")],
    }))
    old.next_actions = Array.from({ length: 6 }, () => ({
      text: "Stale step",
      status: "proposed" as const,
      ledger_refs: [ledgerReferenceID("evidence", "329 rows verified")],
    }))
    const changed = ledger({ evidence: ["different evidence"] })
    const remapped = remapProjection(old, changed)

    expect(remapped?.blockers).toHaveLength(PROJECTION_SECTION_LIMITS.blockers)
    expect(remapped?.blockers.every((blocker) => blocker.text === "Existing blocker")).toBe(true)
  })
})

describe("worst-case rendered size", () => {
  const MAX_SUMMARY = DEFAULT_OPTIONS.max_summary_bytes
  const MAX_LEDGER = DEFAULT_OPTIONS.max_ledger_bytes

  test("a near-capacity ledger and near-budget projection still render within the summary bound", () => {
    const nearFull = nearFullLedger(MAX_LEDGER)
    expect(utf8Bytes(nearFull.block)).toBeLessThanOrEqual(MAX_LEDGER)
    const budget = projectionBudget(MAX_SUMMARY, MAX_LEDGER)
    const saturated = saturatedProjection(nearFull, budget)
    const json = JSON.stringify(saturated)
    expect(utf8Bytes(json)).toBeLessThanOrEqual(budget)

    const parsed = parseProjectionJSON(json, nearFull, budget)
    expect(parsed).toEqual(saturated)
    const rendered = renderProjection(parsed!, nearFull, MAX_SUMMARY)
    expect(rendered).toBeDefined()
    expect(utf8Bytes(rendered!)).toBeLessThanOrEqual(MAX_SUMMARY)
    expect(parseProjectionBlock(rendered!)).toEqual(saturated)
  })

  test("counts multibyte UTF-8 text against the byte limits", () => {
    const nearFull = nearFullLedger(MAX_LEDGER)
    const budget = projectionBudget(MAX_SUMMARY, MAX_LEDGER)
    const saturated = saturatedProjection(nearFull, budget)
    const json = JSON.stringify(saturated)
    expect(json.length).toBeLessThan(utf8Bytes(json))
    const rendered = renderProjection(saturated, nearFull, MAX_SUMMARY)
    expect(rendered).toBeDefined()
    expect(utf8Bytes(rendered!)).toBeLessThanOrEqual(MAX_SUMMARY)
  })

  test("rejects a projection whose JSON exceeds the derived budget", () => {
    const current = ledger()
    const budget = projectionBudget(MAX_SUMMARY, MAX_LEDGER)
    const overflow = saturatedProjection(current, budget)
    const extra = { ...overflow, decisions: [...overflow.decisions, {
      text: truncateUtf8("é".repeat(2_048), 1_024),
      ledger_refs: [ledgerReferenceID("evidence", "329 rows verified")],
    }] }
    expect(parseProjectionJSON(JSON.stringify(extra), current, budget)).toBeUndefined()
    expect(validateWithBudget(extra, current, budget)).toBeUndefined()
  })

  test("a ledger block at the cap leaves room for the projection markers and sections", () => {
    const nearFull = nearFullLedger(MAX_LEDGER)
    const budget = projectionBudget(MAX_SUMMARY, MAX_LEDGER)
    const saturated = saturatedProjection(nearFull, budget)
    const rendered = renderProjection(saturated, nearFull, MAX_SUMMARY)!
    const sectionOverhead = utf8Bytes(rendered) - utf8Bytes(JSON.stringify(saturated)) - utf8Bytes(nearFull.block)
    expect(sectionOverhead).toBeGreaterThan(0)
    expect(sectionOverhead).toBeLessThanOrEqual(MAX_SUMMARY - utf8Bytes(JSON.stringify(saturated)) - utf8Bytes(nearFull.block))
  })
})

function validateWithBudget(value: ProjectedSummary, ledger: RecoveryLedger, budget: number) {
  return parseProjectionJSON(JSON.stringify(value), ledger, budget)
}

function nearFullLedger(maxBytes: number): RecoveryLedger {
  let data: RecoveryLedgerData = {
    recent_requests: [],
    constraints: [],
    todos: [],
    touched_paths: [],
    tool_statuses: [],
    errors: [],
    evidence: ["seed evidence entry"],
    next_actions: [],
    legacy_context: [],
  }
  let current = canonicalLedger(data)
  let index = 0
  while (utf8Bytes(current.block) < maxBytes - 64) {
    const next: RecoveryLedgerData = index % 2 === 0
      ? { ...data, evidence: [...data.evidence, `evidence ${index}`.padEnd(220, "x")] }
      : { ...data, constraints: [...data.constraints, `constraint ${index}`.padEnd(220, "x")] }
    const candidate = canonicalLedger(next)
    if (utf8Bytes(candidate.block) > maxBytes) break
    data = next
    current = candidate
    index++
  }
  return current
}

function saturatedProjection(ledger: RecoveryLedger, budget: number): ProjectedSummary {
  const references = [...ledgerReferenceIDs(ledger)]
  const evidenceRef = ledgerReferenceID("evidence", ledger.data.evidence[0] ?? "seed evidence entry")
  const reference = references[0] ?? evidenceRef
  const claim = (text: string) => ({ text, ledger_refs: [reference] })
  const projection: ProjectedSummary = {
    version: 1,
    goal: claim(truncateUtf8("é".repeat(2_048), 2_048)),
    constraints: [],
    decisions: [],
    current_state: [],
    files: [],
    evidence: [],
    blockers: [],
    next_actions: [],
    ledger_sha256: ledger.digest,
  }
  const sections = [
    ["constraints", PROJECTION_SECTION_LIMITS.constraints, claim(truncateUtf8("é".repeat(2_048), 1_024))],
    ["decisions", PROJECTION_SECTION_LIMITS.decisions, claim(truncateUtf8("é".repeat(2_048), 1_024))],
    ["current_state", PROJECTION_SECTION_LIMITS.current_state, claim(truncateUtf8("é".repeat(2_048), 1_024))],
    ["blockers", PROJECTION_SECTION_LIMITS.blockers, claim(truncateUtf8("é".repeat(2_048), 1_024))],
    ["evidence", PROJECTION_SECTION_LIMITS.evidence, claim(truncateUtf8("é".repeat(2_048), 1_024))],
    ["files", PROJECTION_FILES_MAX, {
      path: `aidocs/${truncateUtf8("é".repeat(1_024), 500)}`,
      status: "unverified",
      summary: truncateUtf8("é".repeat(2_048), 1_024),
      evidence_refs: [evidenceRef],
    }],
    ["next_actions", PROJECTION_ACTIONS_MAX, {
      text: truncateUtf8("é".repeat(2_048), 1_024),
      status: "proposed",
      ledger_refs: [evidenceRef],
    }],
  ] as const
  for (const [section, limit, item] of sections) {
    const list = projection[section] as unknown[]
    for (let index = 0; index < limit; index++) {
      list.push(item)
      if (utf8Bytes(JSON.stringify(projection)) > budget) {
        list.pop()
        break
      }
    }
  }
  return projection
}
