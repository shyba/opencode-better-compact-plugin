import { describe, expect, test } from "bun:test"
import { cases } from "./cases.js"
import { fixtureProvider } from "./providers/fixture.js"
import {
  buildOpenCodeCommand,
  parsePlainAssistantOutput,
  serializeOpenCodeInput,
} from "./providers/opencode-cli.js"
import { runEval } from "./run.js"
import { buildFallback } from "../src/validation.js"
import { canonicalLedger } from "../src/ledger.js"

describe("sanitized compaction eval", () => {
  test("contains exactly 30 unique synthetic cases", () => {
    expect(cases).toHaveLength(30)
    expect(new Set(cases.map((item) => item.id)).size).toBe(30)
    expect(cases.every((item) => item.key_facts.length === 4)).toBe(true)
    expect(JSON.stringify(cases)).not.toMatch(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/)
  })

  test("runs three repetitions and enforces the plugin gates", async () => {
    const report = await runEval({ provider: fixtureProvider, repetitions: 3, quiet: true })
    expect(report.baseline.runs).toBe(90)
    expect(report.plugin.runs).toBe(90)
    expect(report.plugin.fallbacks).toBe(60)
    expect(report.plugin.structural_valid).toEqual({ count: 90, total: 90, rate: 1 })
    expect(report.plugin.digest_valid).toEqual({ count: 90, total: 90, rate: 1 })
    expect(report.plugin.invalid_or_empty_auto_continuations).toBe(0)
    expect(report.plugin.key_fact_recall.rate).toBe(1)
    expect(report.plugin.unsupported_material_claims).toBe(0)
    expect(report.plugin_gates.passed).toBe(true)
  })

  test("builds a shell-free OpenCode CLI command", () => {
    expect(buildOpenCodeCommand("/opt/opencode/bin/opencode", "demo/model-v1")).toEqual([
      "/opt/opencode/bin/opencode",
      "run",
      "--model",
      "demo/model-v1",
      "--agent",
      "compaction",
      "--format",
      "default",
    ])
    expect(() => buildOpenCodeCommand("opencode", "missing-provider-separator")).toThrow(
      "provider/model format",
    )
  })

  test("serializes roles and the final prompt without a parent path", () => {
    const value = serializeOpenCodeInput({
      condition: "baseline",
      caseID: "case-test",
      repetition: 0,
      messages: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "bounded response" },
        { role: "user", content: "final prompt" },
      ],
    })
    expect(value).toContain('<eval-message index="1" role="user">\nfirst request')
    expect(value).toContain('<eval-message index="3" role="user">\nfinal prompt')
    expect(value).not.toContain("file://")
  })

  test("extracts plain baseline output after CLI presentation", () => {
    const value = parsePlainAssistantOutput(
      "\u001b[0m> build · demo-model\u001b[0m\r\n\r\nnoise\r\n## Objective\r\n- resume safely\r\n",
      "baseline",
    )
    expect(value).toBe("## Objective\n- resume safely")
    expect(parsePlainAssistantOutput("> build · demo-model\n\nI cannot comply.\n", "baseline")).toBe(
      "I cannot comply.",
    )
  })

  test("preserves trailing plugin output so runtime validation can reject it", () => {
    const ledger = canonicalLedger({
      recent_requests: ["resume the fixture"],
      constraints: [],
      todos: [],
      touched_paths: [],
      tool_statuses: [],
      errors: [],
      evidence: [],
      next_actions: ["verify the fixture"],
      legacy_context: [],
    })
    const summary = buildFallback({ ledger, maxBytes: 49_152 })
    const output = parsePlainAssistantOutput(
      `\u001b[2m> compaction • demo-model\u001b[0m\n\ntool presentation\n${summary}\nunsupported trailing claim\n`,
      "plugin",
    )
    expect(output).toBe(`${summary}\nunsupported trailing claim`)
  })
})
