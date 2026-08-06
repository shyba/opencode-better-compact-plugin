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

export type EvalCase = {
  id: string
  title: string
  messages: EvalMessage[]
  todos: EvalTodo[]
  key_facts: Array<{ id: string; value: string }>
  unsupported_claims: string[]
}

export type ProviderMessage = {
  role: "user" | "assistant"
  content: string
}

export type Condition = "baseline" | "plugin" | "markdown" | "json"

export type ProviderRequest = {
  condition: Condition
  caseID: string
  repetition: number
  messages: ProviderMessage[]
}

export type ProviderResponse = {
  text: string
}

export type ProviderAdapter = {
  name: string
  complete(request: ProviderRequest): Promise<ProviderResponse>
}

export type PreparedCondition = {
  messages: ProviderMessage[]
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
  provider_errors: number
  zero_text_responses: number
  fallbacks: number
  structural_valid: { count: number; total: number; rate: number }
  digest_valid?: { count: number; total: number; rate: number }
  invalid_or_empty_auto_continuations: number
  key_fact_recall: { recalled: number; total: number; rate: number }
  unsupported_material_claims: number
}

export type EvalReport = {
  corpus_version: number
  corpus_cases: number
  repetitions: number
  provider: string
  live_provider: boolean
  baseline: ConditionMetrics
  plugin: ConditionMetrics
  projections: {
    markdown: ConditionMetrics
    json: ConditionMetrics
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
    passed: boolean
  }
}
