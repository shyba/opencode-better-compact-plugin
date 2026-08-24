import { prepareBaseline } from "./adapters/baseline.js"
import { prepareOffline, preparePlugin } from "./adapters/plugin.js"
import { cases, CORPUS_VERSION } from "./cases.js"
import { fixtureProvider } from "./providers/fixture.js"
import { openAICompatibleProvider } from "./providers/openai-compatible.js"
import { openCodeCLIProvider } from "./providers/opencode-cli.js"
import { runContinuationEval } from "./continuation.js"
import { runVccEval } from "./vcc.js"
import type {
  Condition,
  ConditionMetrics,
  EvalCase,
  EvalReport,
  PreparedCondition,
  ProviderAdapter,
  ProviderTelemetry,
  NumericTelemetry,
  TelemetryMetrics,
} from "./types.js"

export const MAX_EVAL_CONCURRENCY = 16
export const MAX_EVAL_REPETITIONS = 100

type Accumulator = {
  runs: number
  providerCalls: number
  providerErrors: number
  zeroText: number
  fallbacks: number
  structuralValid: number
  structuralTotal: number
  digestValid: number
  digestTotal: number
  invalidAutoContinues: number
  factsRecalled: number
  factsTotal: number
  unsupportedClaims: number
  telemetry: ProviderTelemetry[]
}

export async function runEval(input: {
  provider: ProviderAdapter
  repetitions?: number
  maxCases?: number
  concurrency?: number
  liveProvider?: boolean
  quiet?: boolean
}): Promise<EvalReport> {
  const repetitions = input.repetitions ?? 3
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0 || repetitions > MAX_EVAL_REPETITIONS) {
    throw new TypeError(`repetitions must be an integer between 1 and ${MAX_EVAL_REPETITIONS}`)
  }
  const maxCases = input.maxCases ?? cases.length
  if (!Number.isSafeInteger(maxCases) || maxCases <= 0 || maxCases > cases.length) {
    throw new TypeError(`maxCases must be an integer between 1 and ${cases.length}`)
  }
  const concurrency = input.concurrency ?? 1
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > MAX_EVAL_CONCURRENCY) {
    throw new TypeError(`concurrency must be an integer between 1 and ${MAX_EVAL_CONCURRENCY}`)
  }
  const selectedCases = cases.slice(0, maxCases)
  const baseline = accumulator()
  const offline = accumulator()
  const plugin = accumulator()
  const markdown = accumulator()
  const json = accumulator()
  const jobs = selectedCases.flatMap((test) =>
    Array.from({ length: repetitions }, (_, repetition) => [
      { condition: "baseline" as const, prepared: prepareBaseline(test), result: baseline },
      { condition: "offline" as const, prepared: prepareOffline(test), result: offline },
      { condition: "plugin" as const, prepared: preparePlugin(test, "fallback"), result: plugin },
      { condition: "markdown" as const, prepared: preparePlugin(test, "markdown"), result: markdown },
      { condition: "json" as const, prepared: preparePlugin(test, "json"), result: json },
    ].map((job) => ({ ...job, test, repetition }))).flat(),
  )
  for (const batch of batches(jobs, concurrency)) {
    await Promise.all(
      batch.map((job) =>
      evaluate(job.condition, job.test, job.repetition, input.provider, job.prepared, job.result, input.quiet),
      ),
    )
  }
  const baselineMetrics = metrics("baseline", baseline)
  const offlineMetrics = metrics("offline", offline)
  const pluginMetrics = metrics("plugin", plugin)
  const markdownMetrics = metrics("markdown", markdown)
  const jsonMetrics = metrics("json", json)
  const projectionMetrics = { markdown: markdownMetrics, json: jsonMetrics }
  const vcc_eval = runVccEval()
  const offlineGates = {
    zero_provider_calls: offlineMetrics.provider_calls === 0,
    structural_and_digest_valid_after_fallback:
      offlineMetrics.structural_valid.count === offlineMetrics.structural_valid.total &&
      offlineMetrics.digest_valid?.count === offlineMetrics.digest_valid?.total,
    zero_invalid_or_empty_auto_continuations: offlineMetrics.invalid_or_empty_auto_continuations === 0,
    key_fact_recall_at_least_95_percent: offlineMetrics.key_fact_recall.rate >= 0.95,
    zero_unsupported_material_claims: offlineMetrics.unsupported_material_claims === 0,
    passed: false,
  }
  offlineGates.passed = everyGate(offlineGates)
  const gates = {
    structural_and_digest_valid_after_fallback:
      pluginMetrics.structural_valid.count === pluginMetrics.structural_valid.total &&
      pluginMetrics.digest_valid?.count === pluginMetrics.digest_valid?.total,
    zero_invalid_or_empty_auto_continuations: pluginMetrics.invalid_or_empty_auto_continuations === 0,
    key_fact_recall_at_least_95_percent: pluginMetrics.key_fact_recall.rate >= 0.95,
    zero_unsupported_material_claims: pluginMetrics.unsupported_material_claims === 0,
    zero_provider_errors: pluginMetrics.provider_errors === 0,
    passed: false,
  }
  gates.passed = everyGate(gates)
  const projectionGates = {
    structural_and_digest_valid_after_fallback:
      [markdownMetrics, jsonMetrics].every((value) =>
        value.structural_valid.count === value.structural_valid.total &&
        value.digest_valid?.count === value.digest_valid?.total),
    zero_invalid_or_empty_auto_continuations:
      [markdownMetrics, jsonMetrics].every((value) => value.invalid_or_empty_auto_continuations === 0),
    key_fact_recall_at_least_95_percent:
      [markdownMetrics, jsonMetrics].every((value) => value.key_fact_recall.rate >= 0.95),
    zero_unsupported_material_claims:
      [markdownMetrics, jsonMetrics].every((value) => value.unsupported_material_claims === 0),
    zero_provider_errors: [markdownMetrics, jsonMetrics].every((value) => value.provider_errors === 0),
    passed: false,
  }
  projectionGates.passed = everyGate(projectionGates)
  return {
    corpus_version: CORPUS_VERSION,
    corpus_cases: selectedCases.length,
    repetitions,
    provider: input.provider.name,
    live_provider: input.liveProvider ?? false,
    vcc_eval,
    baseline: baselineMetrics,
    offline: offlineMetrics,
    plugin: pluginMetrics,
    projections: projectionMetrics,
    offline_gates: offlineGates,
    plugin_gates: gates,
    projection_gates: projectionGates,
  }
}

export function allEvalGatesPassed(report: EvalReport) {
  return report.vcc_eval.passed && report.offline_gates.passed && report.plugin_gates.passed && report.projection_gates.passed
}

export function hasFlag(name: string, argv = Bun.argv) {
  return argv.includes(name)
}

async function evaluate(
  condition: Condition,
  test: EvalCase,
  repetition: number,
  provider: ProviderAdapter,
  prepared: PreparedCondition,
  result: Accumulator,
  quiet = false,
) {
  result.runs++
  if (prepared.deterministicText === undefined) result.providerCalls++
  const response = prepared.deterministicText === undefined
    ? await provider
      .complete({ condition, caseID: test.id, repetition, messages: prepared.messages })
      .catch((error: unknown) => {
        result.providerErrors++
        if (!quiet) console.error(`[eval] provider error condition=${condition} case=${test.id} repetition=${repetition}: ${errorText(error)}`)
        return { text: "" }
      })
    : { text: prepared.deterministicText }
  if (response.telemetry) result.telemetry.push(response.telemetry)
  const finished = prepared.finish(response.text)
  if (finished.zeroText) result.zeroText++
  if (finished.usedFallback) result.fallbacks++
  if (!finished.zeroText) {
    result.structuralTotal++
    if (finished.structuralValid) result.structuralValid++
    if (condition !== "baseline") {
      result.digestTotal++
      if (finished.digestValid) result.digestValid++
    }
  }
  if (finished.autoContinue && (finished.zeroText || !finished.structuralValid || finished.digestValid === false)) {
    result.invalidAutoContinues++
  }
  const accepted = normalize(finished.acceptedText)
  result.factsTotal += test.key_facts.length
  result.factsRecalled += test.key_facts.filter((fact) => accepted.includes(normalize(fact.value))).length
  result.unsupportedClaims += test.unsupported_claims.filter((claim) => accepted.includes(normalize(claim))).length
}

function accumulator(): Accumulator {
  return {
    runs: 0,
    providerCalls: 0,
    providerErrors: 0,
    zeroText: 0,
    fallbacks: 0,
    structuralValid: 0,
    structuralTotal: 0,
    digestValid: 0,
    digestTotal: 0,
    invalidAutoContinues: 0,
    factsRecalled: 0,
    factsTotal: 0,
    unsupportedClaims: 0,
    telemetry: [],
  }
}

function metrics(condition: Condition, value: Accumulator): ConditionMetrics {
  return {
    condition,
    runs: value.runs,
    provider_calls: value.providerCalls,
    provider_errors: value.providerErrors,
    zero_text_responses: value.zeroText,
    fallbacks: value.fallbacks,
    structural_valid: rate(value.structuralValid, value.structuralTotal),
    ...(condition !== "baseline" ? { digest_valid: rate(value.digestValid, value.digestTotal) } : {}),
    invalid_or_empty_auto_continuations: value.invalidAutoContinues,
    key_fact_recall: {
      recalled: value.factsRecalled,
      total: value.factsTotal,
      rate: ratio(value.factsRecalled, value.factsTotal),
    },
    unsupported_material_claims: value.unsupportedClaims,
    telemetry: telemetry(value.telemetry),
  }
}

function telemetry(values: ProviderTelemetry[]): TelemetryMetrics {
  return {
    samples: values.length,
    latency_ms: numericTelemetry(values.flatMap((value) => [value.latency_ms])),
    input_tokens: numericTelemetry(values.flatMap((value) => optionalNumber(value.input_tokens))),
    output_tokens: numericTelemetry(values.flatMap((value) => optionalNumber(value.output_tokens))),
    reasoning_tokens: numericTelemetry(values.flatMap((value) => optionalNumber(value.reasoning_tokens))),
    cache_read_tokens: numericTelemetry(values.flatMap((value) => optionalNumber(value.cache_read_tokens))),
    cache_write_tokens: numericTelemetry(values.flatMap((value) => optionalNumber(value.cache_write_tokens))),
    cost: numericTelemetry(values.flatMap((value) => optionalNumber(value.cost))),
  }
}

function optionalNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? [value] : []
}

function numericTelemetry(values: number[]): NumericTelemetry {
  if (!values.length) {
    return { observed: 0, total: 0, mean: null, variance: null, min: null, max: null }
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  const mean = total / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return {
    observed: values.length,
    total: round(total),
    mean: round(mean),
    variance: round(variance),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  }
}

function round(value: number) {
  return Number(value.toFixed(6))
}

function everyGate(gates: Record<string, boolean>) {
  return Object.entries(gates)
    .filter(([key]) => key !== "passed")
    .every(([, value]) => value)
}

function rate(count: number, total: number) {
  return { count, total, rate: ratio(count, total) }
}

function ratio(count: number, total: number) {
  return total ? Number((count / total).toFixed(6)) : 0
}

function normalize(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim()
}

function errorText(value: unknown) {
  return value instanceof Error ? value.message : String(value)
}

function argument(name: string) {
  const index = Bun.argv.indexOf(name)
  return index < 0 ? undefined : Bun.argv[index + 1]
}

if (import.meta.main) {
  const providerName = argument("--provider") ?? "fixture"
  const provider = providerName === "fixture"
    ? fixtureProvider
    : providerName === "openai-compatible"
      ? openAICompatibleProvider()
      : providerName === "opencode-cli"
        ? openCodeCLIProvider()
        : undefined
  if (!provider) throw new TypeError(`Unknown provider adapter: ${providerName}`)
  const repetitions = Number(argument("--repetitions") ?? 3)
  const maxCases = Number(argument("--max-cases") ?? cases.length)
  const concurrency = Number(argument("--concurrency") ?? 1)
  if (hasFlag("--continuation")) {
    const report = await runContinuationEval({ provider, repetitions, maxCases, concurrency })
    console.log(JSON.stringify(report, null, 2))
    if (!report.gates.passed) process.exitCode = 1
  } else {
    const report = await runEval({
      provider,
      repetitions,
      maxCases,
      concurrency,
      liveProvider: providerName !== "fixture",
    })
    console.log(JSON.stringify(report, null, 2))
    if (!allEvalGatesPassed(report)) process.exitCode = 1
  }
}

function batches<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}
