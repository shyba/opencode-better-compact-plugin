import { describe, expect, test } from "bun:test"
import { cases } from "./cases.js"
import { prepareOffline } from "./adapters/plugin.js"
import { fixtureProvider } from "./providers/fixture.js"
import {
  buildOpenCodeCommand,
  parseEvalTimeout,
  parseJsonAssistantOutput,
  parsePlainAssistantOutput,
  serializeOpenCodeInput,
} from "./providers/opencode-cli.js"
import { allEvalGatesPassed, hasFlag, MAX_EVAL_CONCURRENCY, MAX_EVAL_REPETITIONS, runEval } from "./run.js"
import { buildFallback } from "../src/validation.js"
import { canonicalLedger } from "../src/ledger.js"
import { runVccEval } from "./vcc.js"

describe("sanitized compaction eval", () => {
  test("contains exactly 30 unique synthetic cases", () => {
    expect(cases).toHaveLength(30)
    expect(new Set(cases.map((item) => item.id)).size).toBe(30)
    expect(cases.every((item) => item.key_facts.length === 4)).toBe(true)
    expect(JSON.stringify(cases)).not.toMatch(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/)
  })

  test("has a complete typed next-action oracle for every case", () => {
    expect(cases.every((item) => item.next_action.todo_id.endsWith("-next"))).toBe(true)
    expect(cases.every((item) => item.next_action.target.length > 0)).toBe(true)
    expect(cases.every((item) => item.next_action.required_atoms.length > 0)).toBe(true)
    expect(cases.every((item) => item.next_action.action_markers.length > 0)).toBe(true)
    expect(cases.every((item) => item.next_action.forbidden_claims.length > 0)).toBe(true)
  })

  test("runs three repetitions and enforces the plugin gates", async () => {
    const report = await runEval({ provider: fixtureProvider, repetitions: 3, quiet: true })
    expect(report.baseline.runs).toBe(90)
    expect(report.plugin.runs).toBe(90)
    expect(report.plugin.provider_calls).toBe(90)
    expect(report.offline.provider_calls).toBe(0)
    expect(report.plugin.fallbacks).toBe(60)
    expect(report.plugin.structural_valid).toEqual({ count: 90, total: 90, rate: 1 })
    expect(report.plugin.digest_valid).toEqual({ count: 90, total: 90, rate: 1 })
    expect(report.plugin.invalid_or_empty_auto_continuations).toBe(0)
    expect(report.plugin.key_fact_recall.rate).toBe(1)
    expect(report.plugin.unsupported_material_claims).toBe(0)
    expect(report.plugin_gates.passed).toBe(true)
    expect(report.vcc_eval.passed).toBe(true)
    expect(allEvalGatesPassed(report)).toBe(true)
  })

  test("runs the provider-free offline lane without invoking the provider", async () => {
    let providerCalls = 0
    const provider = {
      name: "offline-call-sentinel",
      async complete() {
        providerCalls++
        return { text: "provider must not be called" }
      },
    }
    const report = await runEval({ provider, maxCases: 2, repetitions: 2, quiet: true })
    expect(providerCalls).toBe(16)
    expect(report.offline.runs).toBe(4)
    expect(report.offline.provider_calls).toBe(0)
    expect(report.offline.provider_errors).toBe(0)
    expect(report.offline.telemetry.samples).toBe(0)
    expect(report.offline.key_fact_recall.rate).toBe(1)
    expect(report.offline_gates.passed).toBe(true)
    expect(allEvalGatesPassed(report)).toBe(true)

    const offlineFailure = structuredClone(report)
    offlineFailure.offline_gates.passed = false
    expect(allEvalGatesPassed(offlineFailure)).toBe(false)
    const vccFailure = structuredClone(report)
    vccFailure.vcc_eval.passed = false
    expect(allEvalGatesPassed(vccFailure)).toBe(false)
  })

  test("offline evaluator output is a VCC projection over a deterministic candidate", () => {
    const prepared = prepareOffline(cases[0]!)
    expect(prepared.deterministicText).toContain("vcc-candidate v1 start")
    expect(prepared.deterministicText).toContain("vcc-projection v1 start")
    expect(prepared.finish(prepared.deterministicText!).structuralValid).toBe(true)
    expect(prepared.finish(prepared.deterministicText!).digestValid).toBe(true)
  })

  test("supports a bounded case budget for live evaluation", async () => {
    const report = await runEval({ provider: fixtureProvider, repetitions: 2, maxCases: 1, quiet: true })
    expect(report.corpus_cases).toBe(1)
    expect(report.baseline.runs).toBe(2)
    expect(report.plugin.runs).toBe(2)
    expect(report.projections.markdown.runs).toBe(2)
    expect(report.projections.json.runs).toBe(2)
  })

  test("supports bounded concurrent evaluation without changing metrics", async () => {
    const serial = await runEval({ provider: fixtureProvider, repetitions: 2, maxCases: 2, quiet: true })
    const concurrent = await runEval({ provider: fixtureProvider, repetitions: 2, maxCases: 2, concurrency: 4, quiet: true })
    expect(concurrent).toEqual(serial)
    expect(() => runEval({ provider: fixtureProvider, concurrency: 0 })).toThrow("concurrency")
    expect(() => runEval({ provider: fixtureProvider, concurrency: MAX_EVAL_CONCURRENCY + 1 })).toThrow("concurrency")
    expect(() => runEval({ provider: fixtureProvider, repetitions: MAX_EVAL_REPETITIONS + 1 })).toThrow("repetitions")
  })

  test("reports observed provider telemetry without inventing missing fields", async () => {
    const provider = {
      name: "telemetry-fixture",
      async complete(request: Parameters<typeof fixtureProvider.complete>[0]) {
        const response = await fixtureProvider.complete(request)
        return {
          ...response,
          telemetry: {
            latency_ms: 10 + request.repetition,
            input_tokens: 100 + request.repetition,
            output_tokens: 20,
            cache_read_tokens: request.repetition === 0 ? 5 : undefined,
            cost: 0.25,
          },
        }
      },
    }
    const report = await runEval({ provider, maxCases: 1, repetitions: 2, quiet: true })
    expect(report.baseline.telemetry).toMatchObject({
      samples: 2,
      latency_ms: { observed: 2, total: 21, mean: 10.5, variance: 0.25, min: 10, max: 11 },
      input_tokens: { observed: 2, total: 201, mean: 100.5 },
      cache_read_tokens: { observed: 1, total: 5, mean: 5 },
    })
    expect(report.baseline.telemetry.cache_write_tokens.observed).toBe(0)
  })

  test("compares the markdown and JSON projections against the fallback gates", async () => {
    const report = await runEval({ provider: fixtureProvider, repetitions: 3, quiet: true })
    expect(report.projections.markdown.runs).toBe(90)
    expect(report.projections.json.runs).toBe(90)
    expect(report.projections.markdown.fallbacks).toBe(60)
    expect(report.projections.json.fallbacks).toBe(60)
    for (const mode of ["markdown", "json"] as const) {
      expect(report.projections[mode].structural_valid).toEqual({ count: 90, total: 90, rate: 1 })
      expect(report.projections[mode].digest_valid).toEqual({ count: 90, total: 90, rate: 1 })
      expect(report.projections[mode].invalid_or_empty_auto_continuations).toBe(0)
      expect(report.projections[mode].key_fact_recall.rate).toBeGreaterThanOrEqual(0.95)
      expect(report.projections[mode].unsupported_material_claims).toBe(0)
    }
    expect(report.projection_gates.passed).toBe(true)
  })

  test("fails projection gates when a projection provider call errors", async () => {
    const provider = {
      name: "projection-error-fixture",
      async complete(request: Parameters<typeof fixtureProvider.complete>[0]) {
        if (request.condition === "markdown" || request.condition === "json") {
          throw new Error("synthetic projection provider failure")
        }
        return fixtureProvider.complete(request)
      },
    }
    const report = await runEval({ provider, maxCases: 1, repetitions: 1, quiet: true })
    expect(report.projections.markdown.provider_errors).toBe(1)
    expect(report.projections.json.provider_errors).toBe(1)
    expect(report.projection_gates.zero_provider_errors).toBe(false)
    expect(report.projection_gates.passed).toBe(false)
    expect(allEvalGatesPassed(report)).toBe(false)
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
    expect(buildOpenCodeCommand("/opt/opencode/bin/opencode", "demo/model-v1", "json")).toEqual([
      "/opt/opencode/bin/opencode",
      "run",
      "--model",
      "demo/model-v1",
      "--agent",
      "compaction",
      "--format",
      "json",
    ])
  })

  test("bounds the live OpenCode evaluator timeout", () => {
    expect(parseEvalTimeout(undefined)).toBe(120_000)
    expect(parseEvalTimeout("5000")).toBe(5_000)
    expect(() => parseEvalTimeout("0")).toThrow("SAFE_COMPACTION_EVAL_TIMEOUT_MS")
    expect(() => parseEvalTimeout("900001")).toThrow("SAFE_COMPACTION_EVAL_TIMEOUT_MS")
  })

  test("recognizes a bare continuation flag in any argv position", () => {
    expect(hasFlag("--continuation", ["bun", "eval/run.ts", "--continuation"])).toBe(true)
    expect(hasFlag("--continuation", ["bun", "eval/run.ts", "--continuation", "--max-cases", "1"])).toBe(true)
    expect(hasFlag("--continuation", ["bun", "eval/run.ts", "--max-cases", "1"])).toBe(false)
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

  test("extracts text and usage telemetry from JSON CLI events", () => {
    const value = parseJsonAssistantOutput(
      [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({ type: "text", part: { type: "text", text: "## Goal\n- resume" } }),
        JSON.stringify({
          type: "step_finish",
          part: {
            type: "step-finish",
            cost: 0.0123,
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 10 } },
          },
        }),
      ].join("\n"),
    )
    expect(value).toEqual({
      text: "## Goal\n- resume",
      telemetry: {
        input_tokens: 100,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_read_tokens: 80,
        cache_write_tokens: 10,
        cost: 0.0123,
      },
    })
  })
})

describe("provider-free VCC evaluation", () => {
  test("runs the deterministic scenario matrix with honest capability accounting", () => {
    const report = runVccEval()
    expect(report).toMatchObject({
      schema_version: 1,
      corpus_version: 1,
      scenario_count: 31,
      passed: true,
      deterministic: true,
      stochastic_provider_evidence: "not_run",
      provider_calls: 0,
      network_calls: 0,
      rag_calls: 0,
    })
    expect(Object.values(report.categories).every((category) => category.passed === category.total)).toBe(true)
    expect(report.categories.direct_correction.total).toBe(4)
    expect(report.categories.question_answer.total).toBe(4)
    expect(report.categories.causal_pair.total).toBe(4)
    expect(report.categories.supersession.total).toBe(4)
    expect(report.categories.incomplete_source.total).toBe(4)
    expect(report.categories.repeated_cycle.total).toBe(4)
    expect(report.categories.boundary.total).toBe(7)
  })

  test("is byte-deterministic across repeated harness runs", () => {
    expect(runVccEval()).toEqual(runVccEval())
  })
})
