import { describe, expect, test } from "bun:test"
import { cases } from "./cases.js"
import { fixtureProvider } from "./providers/fixture.js"
import { runContinuationEval } from "./continuation.js"
import type { ProviderAdapter } from "./types.js"

describe("post-compaction continuation evaluation", () => {
  test("runs one bounded follow-up turn and measures the expected next action", async () => {
    const provider: ProviderAdapter = {
      name: "continuation-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        const test = cases.find((value) => value.id === request.caseID.slice(0, -":continuation".length))!
        const action = test.next_action
        return { text: `Next verified action: ${test.todos.find((todo) => todo.id === action.todo_id)?.content} at ${action.target}; ${action.required_atoms.join("; ")}` }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 2, repetitions: 2, quiet: true })
    const metrics = report.conditions.plugin
    expect(report.schema_version).toBe(3)
    expect(metrics).toMatchObject({
      runs: 4,
      compaction_provider_calls: 4,
      continuation_provider_calls: 4,
      provider_errors: 0,
      compaction_zero_text_responses: 0,
      continuation_zero_text_responses: 0,
      next_action_recall: { recalled: 4, total: 4, rate: 1 },
      exact_next_action_recall: { recalled: 4, total: 4, rate: 1 },
      oracle_violations: 0,
      unsupported_material_claims: 0,
    })
    expect(report.gates.passed).toBe(true)
    expect(metrics.compaction_telemetry).toEqual([])
    expect(metrics.continuation_telemetry).toEqual([])
  })

  test("counts a source-grounded paraphrase while retaining exact recall separately", async () => {
    const provider: ProviderAdapter = {
      name: "paraphrase-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        return { text: "Run the focused test to reproduce the timeout, then verify the retry branch at src/http/checkout.ts; bun test test/checkout.test.ts" }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.plugin.next_action_recall).toEqual({ recalled: 1, total: 1, rate: 1 })
    expect(report.conditions.plugin.exact_next_action_recall).toEqual({ recalled: 0, total: 1, rate: 0 })
    expect(report.gates.passed).toBe(true)
  })

  test("does not count an unrelated continuation as next-action correctness", async () => {
    const provider: ProviderAdapter = {
      name: "unrelated-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        return { text: "The timeout investigation is complete and the change was deployed." }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.plugin.next_action_recall).toEqual({ recalled: 0, total: 1, rate: 0 })
    expect(report.conditions.plugin.exact_next_action_recall).toEqual({ recalled: 0, total: 1, rate: 0 })
    expect(report.conditions.plugin.oracle_violations).toBe(1)
    expect(report.gates.passed).toBe(false)
  })

  test("fails closed when a continuation omits an oracle-required command", async () => {
    const provider: ProviderAdapter = {
      name: "missing-atom-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        return { text: "Reproduce the timeout with the focused test at src/http/checkout.ts; bun test wrong.test.ts" }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.plugin.next_action_recall).toEqual({ recalled: 0, total: 1, rate: 0 })
    expect(report.gates.source_grounded_next_action_at_least_95_percent).toBe(false)
    expect(report.conditions.plugin.oracle_violations).toBe(1)
    expect(report.gates.zero_oracle_violations).toBe(false)
  })

  test("counts a forbidden completion claim as a high-risk oracle violation", async () => {
    const provider: ProviderAdapter = {
      name: "forbidden-claim-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        return { text: "Reproduce the timeout with the focused test at src/http/checkout.ts; bun test test/checkout.test.ts; deployed the timeout fix" }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.plugin.next_action_recall).toEqual({ recalled: 0, total: 1, rate: 0 })
    expect(report.conditions.plugin.oracle_violations).toBe(1)
    expect(report.conditions.plugin.unsupported_material_claims).toBe(1)
    expect(report.gates.zero_oracle_violations).toBe(false)
  })

  test("keeps the baseline control informational while gating plugin conditions", async () => {
    const provider: ProviderAdapter = {
      name: "baseline-control-fixture",
      async complete(request) {
        if (!request.caseID.endsWith(":continuation")) return fixtureProvider.complete(request)
        if (request.condition === "baseline") return { text: "The previous investigation is complete." }
        const test = cases.find((value) => value.id === request.caseID.slice(0, -":continuation".length))!
        const action = test.next_action
        return { text: `${test.todos.find((todo) => todo.id === action.todo_id)?.content} at ${action.target}; ${action.required_atoms.join("; ")}` }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["baseline", "plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.baseline.next_action_recall.rate).toBe(0)
    expect(report.conditions.plugin.next_action_recall.rate).toBe(1)
    expect(report.conditions.plugin.oracle_violations).toBe(0)
    expect(report.gates.source_grounded_next_action_at_least_95_percent).toBe(true)
    expect(report.gates.zero_oracle_violations).toBe(true)
  })

  test("does not hide a zero-text compaction behind continuation metrics", async () => {
    const provider: ProviderAdapter = {
      name: "zero-text-fixture",
      async complete(request) {
        if (request.caseID.endsWith(":continuation")) return { text: "unexpected continuation" }
        return { text: "" }
      },
    }
    const report = await runContinuationEval({ provider, conditions: ["plugin"], maxCases: 1, repetitions: 1, quiet: true })
    expect(report.conditions.plugin).toMatchObject({
      runs: 1,
      compaction_provider_calls: 1,
      continuation_provider_calls: 0,
      compaction_zero_text_responses: 1,
      next_action_recall: { recalled: 0, total: 1, rate: 0 },
      exact_next_action_recall: { recalled: 0, total: 1, rate: 0 },
    })
    expect(report.gates.zero_compaction_or_continuation_text).toBe(false)
    expect(report.gates.passed).toBe(false)
  })
})
