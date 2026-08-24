import { cases } from "./cases.js"
import { prepareBaseline } from "./adapters/baseline.js"
import { preparePlugin, type PluginMode } from "./adapters/plugin.js"
import { fixtureProvider } from "./providers/fixture.js"
import { openAICompatibleProvider } from "./providers/openai-compatible.js"
import { openCodeCLIProvider } from "./providers/opencode-cli.js"
import type { EvalCase, EvalNextAction, ProviderAdapter, ProviderTelemetry } from "./types.js"

export const CONTINUATION_CONDITIONS = ["baseline", "plugin", "markdown", "json"] as const
export type ContinuationCondition = (typeof CONTINUATION_CONDITIONS)[number]

export type ContinuationConditionMetrics = {
  condition: ContinuationCondition
  runs: number
  compaction_provider_calls: number
  continuation_provider_calls: number
  provider_errors: number
  compaction_zero_text_responses: number
  continuation_zero_text_responses: number
  next_action_recall: { recalled: number; total: number; rate: number }
  exact_next_action_recall: { recalled: number; total: number; rate: number }
  oracle_violations: number
  unsupported_material_claims: number
  compaction_telemetry: ProviderTelemetry[]
  continuation_telemetry: ProviderTelemetry[]
}

export type ContinuationEvalReport = {
  schema_version: 3
  corpus_version: number
  corpus_cases: number
  repetitions: number
  provider: string
  conditions: Record<ContinuationCondition, ContinuationConditionMetrics>
  gates: {
    zero_provider_errors: boolean
    zero_compaction_or_continuation_text: boolean
    source_grounded_next_action_at_least_95_percent: boolean
    zero_oracle_violations: boolean
    zero_unsupported_material_claims: boolean
    passed: boolean
  }
}

type Accumulator = Omit<ContinuationConditionMetrics, "condition" | "next_action_recall" | "exact_next_action_recall"> & {
  nextActionRecalled: number
  exactNextActionRecalled: number
  nextActionTotal: number
  oracleViolations: number
}

export async function runContinuationEval(input: {
  provider: ProviderAdapter
  repetitions?: number
  maxCases?: number
  conditions?: readonly ContinuationCondition[]
  concurrency?: number
  quiet?: boolean
}): Promise<ContinuationEvalReport> {
  const repetitions = input.repetitions ?? 1
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0 || repetitions > 100) {
    throw new TypeError("repetitions must be an integer between 1 and 100")
  }
  const maxCases = input.maxCases ?? cases.length
  if (!Number.isSafeInteger(maxCases) || maxCases <= 0 || maxCases > cases.length) {
    throw new TypeError(`maxCases must be an integer between 1 and ${cases.length}`)
  }
  const concurrency = input.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 16) {
    throw new TypeError("concurrency must be an integer between 1 and 16")
  }
  const conditions = uniqueConditions(input.conditions ?? CONTINUATION_CONDITIONS)
  const selectedCases = cases.slice(0, maxCases)
  const accumulators = Object.fromEntries(conditions.map((condition) => [condition, accumulator()])) as Record<ContinuationCondition, Accumulator>
  const jobs = selectedCases.flatMap((test) =>
    Array.from({ length: repetitions }, (_, repetition) =>
      conditions.map((condition) => ({ condition, repetition, test, result: accumulators[condition]! }))).flat(),
  )
  for (const batch of batches(jobs, concurrency)) {
    await Promise.all(batch.map((job) => evaluate(job.condition, job.test, job.repetition, input.provider, job.result, input.quiet)))
  }
  const metrics = Object.fromEntries(conditions.map((condition) => [condition, toMetrics(condition, accumulators[condition]!)])) as Record<ContinuationCondition, ContinuationConditionMetrics>
  const values = Object.values(metrics)
  const qualityValues = values.filter((value) => value.condition !== "baseline")
  const actionValues = qualityValues.length ? qualityValues : values
  const gates = {
    zero_provider_errors: values.every((value) => value.provider_errors === 0),
    zero_compaction_or_continuation_text: values.every((value) => value.compaction_zero_text_responses === 0 && value.continuation_zero_text_responses === 0),
    source_grounded_next_action_at_least_95_percent: actionValues.every((value) => value.next_action_recall.rate >= 0.95),
    zero_oracle_violations: actionValues.every((value) => value.oracle_violations === 0),
    zero_unsupported_material_claims: values.every((value) => value.unsupported_material_claims === 0),
    passed: false,
  }
  gates.passed = Object.entries(gates).filter(([key]) => key !== "passed").every(([, value]) => value)
  return {
    schema_version: 3,
    corpus_version: 1,
    corpus_cases: selectedCases.length,
    repetitions,
    provider: input.provider.name,
    conditions: metrics,
    gates,
  }
}

function evaluate(condition: ContinuationCondition, test: EvalCase, repetition: number, provider: ProviderAdapter, result: Accumulator, quiet = false) {
  return completeCompaction(condition, test, repetition, provider, result, quiet)
}

async function completeCompaction(condition: ContinuationCondition, test: EvalCase, repetition: number, provider: ProviderAdapter, result: Accumulator, quiet: boolean) {
  result.runs++
  const prepared = condition === "baseline" ? prepareBaseline(test) : preparePlugin(test, conditionToPluginMode(condition))
  result.compaction_provider_calls++
  const compacted = await provider.complete({ condition, caseID: test.id, repetition, messages: prepared.messages }).catch((error: unknown) => {
    result.provider_errors++
    if (!quiet) console.error(`[continuation-eval] compaction provider error condition=${condition} case=${test.id}: ${errorText(error)}`)
    return { text: "" }
  })
  if (compacted.telemetry) result.compaction_telemetry.push(compacted.telemetry)
  const finished = prepared.finish(compacted.text)
  if (finished.zeroText) result.compaction_zero_text_responses++
  result.nextActionTotal++
  if (!finished.acceptedText.trim()) return
  result.continuation_provider_calls++
  const continued = await provider.complete({
    condition,
    caseID: `${test.id}:continuation`,
    repetition,
    messages: [
      { role: "assistant", content: finished.acceptedText },
      { role: "user", content: continuationPrompt(test) },
    ],
  }).catch((error: unknown) => {
    result.provider_errors++
    if (!quiet) console.error(`[continuation-eval] continuation provider error condition=${condition} case=${test.id}: ${errorText(error)}`)
    return { text: "" }
  })
  if (continued.telemetry) result.continuation_telemetry.push(continued.telemetry)
  if (!continued.text.trim()) {
    result.continuation_zero_text_responses++
    return
  }
  const nextAction = test.next_action
  const todo = test.todos.find((item) => item.id === nextAction.todo_id)
  if (todo?.status === "pending" || todo?.status === "in_progress") {
    const assessment = assessNextAction(nextAction, continued.text)
    if (assessment.correct) result.nextActionRecalled++
    if (assessment.highRiskViolation) result.oracleViolations++
    if (normalize(continued.text).includes(normalize(todo.content))) result.exactNextActionRecalled++
    result.unsupported_material_claims += nextAction.forbidden_claims.filter((claim) => normalize(continued.text).includes(normalize(claim))).length
    return
  }
  result.oracleViolations++
}

function continuationPrompt(test: EvalCase) {
  const request = test.messages.at(-1)?.text ?? "Continue the task from the accepted summary."
  return `Continue the task from the accepted summary. State only the immediate next verified action, preserve exact constraints and evidence, and do not claim completion without a new verification.\n\n${request}`
}

function accumulator(): Accumulator {
  return {
    runs: 0,
    compaction_provider_calls: 0,
    continuation_provider_calls: 0,
    provider_errors: 0,
    compaction_zero_text_responses: 0,
    continuation_zero_text_responses: 0,
    nextActionRecalled: 0,
    exactNextActionRecalled: 0,
    nextActionTotal: 0,
    oracleViolations: 0,
    unsupported_material_claims: 0,
    compaction_telemetry: [],
    continuation_telemetry: [],
  }
}

function toMetrics(condition: ContinuationCondition, result: Accumulator): ContinuationConditionMetrics {
  return {
    condition,
    runs: result.runs,
    compaction_provider_calls: result.compaction_provider_calls,
    continuation_provider_calls: result.continuation_provider_calls,
    provider_errors: result.provider_errors,
    compaction_zero_text_responses: result.compaction_zero_text_responses,
    continuation_zero_text_responses: result.continuation_zero_text_responses,
    next_action_recall: {
      recalled: result.nextActionRecalled,
      total: result.nextActionTotal,
      rate: result.nextActionTotal ? Number((result.nextActionRecalled / result.nextActionTotal).toFixed(6)) : 0,
    },
    exact_next_action_recall: {
      recalled: result.exactNextActionRecalled,
      total: result.nextActionTotal,
      rate: result.nextActionTotal ? Number((result.exactNextActionRecalled / result.nextActionTotal).toFixed(6)) : 0,
    },
    oracle_violations: result.oracleViolations,
    unsupported_material_claims: result.unsupported_material_claims,
    compaction_telemetry: result.compaction_telemetry,
    continuation_telemetry: result.continuation_telemetry,
  }
}

function conditionToPluginMode(condition: Exclude<ContinuationCondition, "baseline">): PluginMode {
  return condition === "plugin" ? "fallback" : condition
}

function uniqueConditions(conditions: readonly ContinuationCondition[]) {
  const values = [...new Set(conditions)]
  if (!values.length || values.some((condition) => !CONTINUATION_CONDITIONS.includes(condition))) throw new TypeError("conditions must contain at least one supported continuation condition")
  return values
}

function batches<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size))
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
}

function assessNextAction(expected: EvalNextAction, actual: string) {
  const normalizedActual = normalize(actual)
  const targetMissing = !normalizedActual.includes(normalize(expected.target))
  const requiredAtomMissing = expected.required_atoms.some((atom) => !actual.includes(atom))
  const actionMarkerMissing = !expected.action_markers.some((marker) => normalizedActual.includes(normalize(marker)))
  const forbiddenClaimPresent = expected.forbidden_claims.some((claim) => normalizedActual.includes(normalize(claim)))
  return {
    correct: !targetMissing && !requiredAtomMissing && !actionMarkerMissing && !forbiddenClaimPresent,
    highRiskViolation: targetMissing || requiredAtomMissing || forbiddenClaimPresent,
  }
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

if (import.meta.main) {
  const providerName = process.argv.includes("--provider") ? process.argv[process.argv.indexOf("--provider") + 1] : "fixture"
  const provider = providerName === "fixture"
    ? fixtureProvider
    : providerName === "openai-compatible"
      ? openAICompatibleProvider()
      : providerName === "opencode-cli"
        ? openCodeCLIProvider()
        : undefined
  if (!provider) throw new TypeError(`Unknown provider adapter: ${providerName}`)
  const report = await runContinuationEval({ provider, repetitions: 1, maxCases: 1 })
  console.log(JSON.stringify(report, null, 2))
  if (!report.gates.passed) process.exitCode = 1
}
