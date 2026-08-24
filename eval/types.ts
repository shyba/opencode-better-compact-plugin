export type EvalMessage = {
  role: "user" | "assistant"
  text: string
  tool?: {
    name: string
    status: "completed" | "error"
    title: string
    input: Record<string, unknown>
    output?: string
    error?: string
  }
}

export type EvalTodo = {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: "low" | "medium" | "high"
}

export type EvalNextActionKind =
  | "add"
  | "assert"
  | "capture"
  | "change"
  | "choose"
  | "compare"
  | "decode"
  | "derive"
  | "invalidate"
  | "mark"
  | "record"
  | "reorder"
  | "replace"
  | "retain"
  | "run_test"
  | "set"
  | "test"
  | "use"
  | "verify"

export type EvalNextAction = {
  todo_id: string
  kind: EvalNextActionKind
  target: string
  required_atoms: string[]
  action_markers: string[]
  forbidden_claims: string[]
}

export type EvalCase = {
  id: string
  title: string
  messages: EvalMessage[]
  todos: EvalTodo[]
  next_action: EvalNextAction
  key_facts: Array<{ id: string; value: string }>
  unsupported_claims: string[]
}

export type ProviderMessage = {
  role: "user" | "assistant"
  content: string
}

export type Condition = "baseline" | "offline" | "plugin" | "markdown" | "json"

export type ProviderRequest = {
  condition: Condition
  caseID: string
  repetition: number
  messages: ProviderMessage[]
}

export type ProviderResponse = {
  text: string
  telemetry?: ProviderTelemetry
}

export type ProviderTelemetry = {
  latency_ms: number
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  cost?: number
}

export type ProviderAdapter = {
  name: string
  complete(request: ProviderRequest): Promise<ProviderResponse>
}

export type PreparedCondition = {
  messages: ProviderMessage[]
  deterministicText?: string
  finish(text: string): {
    acceptedText: string
    structuralValid: boolean
    digestValid: boolean | undefined
    autoContinue: boolean
    usedFallback: boolean
    zeroText: boolean
  }
}

export type ConditionMetrics = {
  condition: Condition
  runs: number
  provider_calls: number
  provider_errors: number
  zero_text_responses: number
  fallbacks: number
  structural_valid: { count: number; total: number; rate: number }
  digest_valid?: { count: number; total: number; rate: number }
  invalid_or_empty_auto_continuations: number
  key_fact_recall: { recalled: number; total: number; rate: number }
  unsupported_material_claims: number
  telemetry: TelemetryMetrics
}

export type NumericTelemetry = {
  observed: number
  total: number
  mean: number | null
  variance: number | null
  min: number | null
  max: number | null
}

export type TelemetryMetrics = {
  samples: number
  latency_ms: NumericTelemetry
  input_tokens: NumericTelemetry
  output_tokens: NumericTelemetry
  reasoning_tokens: NumericTelemetry
  cache_read_tokens: NumericTelemetry
  cache_write_tokens: NumericTelemetry
  cost: NumericTelemetry
}

export type EvalReport = {
  corpus_version: number
  corpus_cases: number
  repetitions: number
  provider: string
  live_provider: boolean
  vcc_eval: VccEvalReport
  baseline: ConditionMetrics
  offline: ConditionMetrics
  plugin: ConditionMetrics
  projections: {
    markdown: ConditionMetrics
    json: ConditionMetrics
  }
  offline_gates: {
    zero_provider_calls: boolean
    structural_and_digest_valid_after_fallback: boolean
    zero_invalid_or_empty_auto_continuations: boolean
    key_fact_recall_at_least_95_percent: boolean
    zero_unsupported_material_claims: boolean
    passed: boolean
  }
  plugin_gates: {
    structural_and_digest_valid_after_fallback: boolean
    zero_invalid_or_empty_auto_continuations: boolean
    key_fact_recall_at_least_95_percent: boolean
    zero_unsupported_material_claims: boolean
    zero_provider_errors: boolean
    passed: boolean
  }
  projection_gates: {
    structural_and_digest_valid_after_fallback: boolean
    zero_invalid_or_empty_auto_continuations: boolean
    key_fact_recall_at_least_95_percent: boolean
    zero_unsupported_material_claims: boolean
    zero_provider_errors: boolean
    passed: boolean
  }
}
import type { VccEvalReport } from "./vcc.js"
