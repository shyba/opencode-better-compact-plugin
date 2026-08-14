import { describe, expect, test } from "bun:test"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import {
  REQUIRED_SECTIONS,
  buildAuthoritativeSummary,
  buildCompactionPrompt,
  buildFallback,
  isAuthoritativeSummary,
  isPluginValidSummary,
  recoveryContext,
  renderProjectedResponse,
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

  test("uses the latest substantive request when the newest turn is only an acknowledgement", () => {
    const acked = canonicalLedger({
      ...EMPTY_DATA,
      recent_requests: ["Wire the new exporter", "check", "yes", "continue"],
    })
    const fallback = buildAuthoritativeSummary({ ledger: acked, maxBytes: 16_384 })

    expect(fallback).toContain("## Goal\n- Wire the new exporter")
    expect(fallback).not.toContain("## Goal\n- continue")
    expect(isAuthoritativeSummary(fallback, 16_384)).toBe(true)
  })

  test("treats common one-word imperatives as acknowledgements", () => {
    const ledger = canonicalLedger({
      ...EMPTY_DATA,
      recent_requests: ["Wire the new exporter", "save", "wait", "great"],
    })
    const fallback = buildAuthoritativeSummary({ ledger, maxBytes: 16_384 })

    expect(fallback).toContain("## Goal\n- Wire the new exporter")
  })

  test("uses an honest placeholder when every recovered request is terse", () => {
    const ledger = canonicalLedger({ ...EMPTY_DATA, recent_requests: ["save", "wait", "great"] })
    const fallback = buildAuthoritativeSummary({ ledger, maxBytes: 16_384 })

    expect(fallback).toContain("## Goal\n- No recoverable user request was recorded.")
  })

  test("preserves tool transitions while collapsing repeated status noise", () => {
    const statusLedger = canonicalLedger({
      ...EMPTY_DATA,
      tool_statuses: [
        { tool: "bash", status: "completed", title: "Run tests" },
        { tool: "bash", status: "completed", title: "Run tests" },
        { tool: "edit", status: "completed", title: "Update source" },
      ],
    })
    const fallback = buildAuthoritativeSummary({ ledger: statusLedger, maxBytes: 16_384 })

    expect(fallback).toContain("bash: completed — Run tests (x2)")
    expect(fallback).toContain("edit: completed — Update source")
    expect(isAuthoritativeSummary(fallback, 16_384)).toBe(true)
  })

  test("asks the recovery model to review possible zombie todos without mutating them", () => {
    const ledger = canonicalLedger({
      ...EMPTY_DATA,
      recent_requests: ["Fix the exporter"],
      todos: [{ id: "todo-old", status: "pending", priority: "low", content: "Migrate the old scraper" }],
    })
    const context = recoveryContext(ledger)

    expect(context).toContain("mention its ID")
    expect(context).toContain("possibly stale")
    expect(context).toContain("ask the user")
    expect(context).toContain('"todo-old"')
  })
})

describe("legacy markdown response mode", () => {
  const ledger = canonicalLedger({
    ...EMPTY_DATA,
    recent_requests: ["Finish the exporter"],
    constraints: ["Keep the schema"],
    next_actions: ["Run the regression"],
  })

  test("emits the legacy Markdown contract instead of the JSON shape", () => {
    const prompt = buildCompactionPrompt(ledger, 49_152, undefined, "markdown")
    expect(prompt).toContain("exact Markdown contract")
    expect(prompt).toContain("## Goal")
    expect(prompt).toContain("## Next actions")
    expect(prompt).toContain(ledger.block)
    expect(prompt).not.toContain("Required JSON shape")
    expect(prompt).not.toContain("ledger_sha256=")
  })

  test("accepts a legacy plugin-valid Markdown summary", () => {
    const summary = buildFallback({ ledger, maxBytes: 49_152 })
    const accepted = renderProjectedResponse(summary, ledger, 49_152, "markdown")
    expect(accepted).toBe(summary.trimEnd())
    expect(renderProjectedResponse(summary, ledger, 49_152, "json")).toBeUndefined()
  })

  test("rejects prose, malformed summaries, and JSON-only responses", () => {
    expect(renderProjectedResponse("some prose without a ledger", ledger, 49_152, "markdown")).toBeUndefined()
    expect(renderProjectedResponse("## Goal\n- malformed", ledger, 49_152, "markdown")).toBeUndefined()
    expect(renderProjectedResponse('{"version":1}', ledger, 49_152, "markdown")).toBeUndefined()
  })
})

describe("semantic prompt extension", () => {
  const ledger = canonicalLedger({ ...EMPTY_DATA, recent_requests: ["Understand the mapper"] })

  test("leaves the default JSON contract free of semantic instructions", () => {
    const prompt = buildCompactionPrompt(ledger, 49_152)
    expect(prompt).toContain("Keep the JSON response within")
    expect(prompt).not.toContain("semantic_delta")
    expect(prompt).not.toContain("Semantic checkpointing is enabled")
  })

  test("adds the extra JSON field only when explicitly enabled", () => {
    const prompt = buildCompactionPrompt(ledger, 49_152, undefined, "json", {
      instructions: "Semantic checkpointing is enabled.",
      jsonField: '"semantic_delta":{"upserts":[]}',
    })
    expect(prompt).toContain("Semantic checkpointing is enabled")
    expect(prompt).toContain('"semantic_delta":{"upserts":[]}')
    expect(prompt).toContain("complete JSON response within 49152 bytes")
  })
})
