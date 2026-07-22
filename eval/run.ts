import { prepareBaseline } from "./adapters/baseline.js"
import { preparePlugin } from "./adapters/plugin.js"
import { cases, CORPUS_VERSION } from "./cases.js"
import { fixtureProvider } from "./providers/fixture.js"
import { openAICompatibleProvider } from "./providers/openai-compatible.js"
import { openCodeCLIProvider } from "./providers/opencode-cli.js"
import type {
  ConditionMetrics,
  EvalCase,
  EvalReport,
  PreparedCondition,
  ProviderAdapter,
} from "./types.js"

type Accumulator = {
  runs: number
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
}

export async function runEval(input: {
  provider: ProviderAdapter
  repetitions?: number
  liveProvider?: boolean
  quiet?: boolean
}): Promise<EvalReport> {
  const repetitions = input.repetitions ?? 3
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    throw new TypeError("repetitions must be a positive integer")
  }
  const baseline = accumulator()
  const plugin = accumulator()
  for (const test of cases) {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      await evaluate("baseline", test, repetition, input.provider, prepareBaseline(test), baseline, input.quiet)
      await evaluate("plugin", test, repetition, input.provider, preparePlugin(test), plugin, input.quiet)
    }
  }
  const baselineMetrics = metrics("baseline", baseline)
  const pluginMetrics = metrics("plugin", plugin)
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
  gates.passed = Object.entries(gates)
    .filter(([key]) => key !== "passed")
    .every(([, value]) => value)
  return {
    corpus_version: CORPUS_VERSION,
    corpus_cases: cases.length,
    repetitions,
    provider: input.provider.name,
    live_provider: input.liveProvider ?? false,
    baseline: baselineMetrics,
    plugin: pluginMetrics,
    plugin_gates: gates,
  }
}

async function evaluate(
  condition: "baseline" | "plugin",
  test: EvalCase,
  repetition: number,
  provider: ProviderAdapter,
  prepared: PreparedCondition,
  result: Accumulator,
  quiet = false,
) {
  result.runs++
  const response = await provider
    .complete({ condition, caseID: test.id, repetition, messages: prepared.messages })
    .catch((error: unknown) => {
      result.providerErrors++
      if (!quiet) console.error(`[eval] provider error condition=${condition} case=${test.id} repetition=${repetition}: ${errorText(error)}`)
      return { text: "" }
    })
  const finished = prepared.finish(response.text)
  if (finished.zeroText) result.zeroText++
  if (finished.usedFallback) result.fallbacks++
  if (!finished.zeroText) {
    result.structuralTotal++
    if (finished.structuralValid) result.structuralValid++
    if (condition === "plugin") {
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
  }
}

function metrics(condition: "baseline" | "plugin", value: Accumulator): ConditionMetrics {
  return {
    condition,
    runs: value.runs,
    provider_errors: value.providerErrors,
    zero_text_responses: value.zeroText,
    fallbacks: value.fallbacks,
    structural_valid: rate(value.structuralValid, value.structuralTotal),
    ...(condition === "plugin" ? { digest_valid: rate(value.digestValid, value.digestTotal) } : {}),
    invalid_or_empty_auto_continuations: value.invalidAutoContinues,
    key_fact_recall: {
      recalled: value.factsRecalled,
      total: value.factsTotal,
      rate: ratio(value.factsRecalled, value.factsTotal),
    },
    unsupported_material_claims: value.unsupportedClaims,
  }
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
  const report = await runEval({
    provider,
    repetitions,
    liveProvider: providerName !== "fixture",
  })
  console.log(JSON.stringify(report, null, 2))
  if (!report.plugin_gates.passed) process.exitCode = 1
}
