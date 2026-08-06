export const OPTION_KEYS = [
  "model",
  "response_mode",
  "tail_turns",
  "preserve_recent_tokens",
  "reserved_tokens",
  "max_output_tokens",
  "max_user_text_bytes",
  "max_inline_data_bytes",
  "max_historical_part_bytes",
  "max_ledger_bytes",
  "max_summary_bytes",
] as const

export const RESPONSE_MODES = ["json", "markdown"] as const
export type ResponseMode = (typeof RESPONSE_MODES)[number]

export type PluginOptions = {
  model: string
  response_mode: ResponseMode
  tail_turns: number
  preserve_recent_tokens: number
  reserved_tokens: number
  max_output_tokens: number
  max_user_text_bytes: number
  max_inline_data_bytes: number
  max_historical_part_bytes: number
  max_ledger_bytes: number
  max_summary_bytes: number
}

export type ParsedOptions = Partial<PluginOptions>

export type ExistingOptions = {
  model?: string | undefined
  tail_turns?: number | undefined
  preserve_recent_tokens?: number | undefined
  reserved_tokens?: number | undefined
}

export const SELECTED_MODEL = "selected"

export const DEFAULT_OPTIONS = {
  response_mode: "json",
  tail_turns: 4,
  preserve_recent_tokens: 16_000,
  reserved_tokens: 32_000,
  max_output_tokens: 16_384,
  max_user_text_bytes: 524_288,
  max_inline_data_bytes: 10_485_760,
  max_historical_part_bytes: 131_072,
  max_ledger_bytes: 12_288,
  max_summary_bytes: 49_152,
} satisfies Omit<PluginOptions, "model">

// These limits bound work performed before the provider request. They are deliberately
// above the documented defaults while preventing one tuple from disabling the plugin's
// memory-safety guarantees.
export const MAX_OPTIONS = {
  tail_turns: 64,
  max_user_text_bytes: 8 * 1_024 * 1_024,
  max_inline_data_bytes: 64 * 1_024 * 1_024,
  max_historical_part_bytes: 1 * 1_024 * 1_024,
  max_ledger_bytes: 256 * 1_024,
  max_summary_bytes: 1 * 1_024 * 1_024,
} as const

export function parseOptions(input: Record<string, unknown> | undefined) {
  const value = input ?? {}
  const unknown = Object.keys(value).filter((key) => !OPTION_KEYS.includes(key as (typeof OPTION_KEYS)[number]))
  if (unknown.length) throw new TypeError(`Unknown opencode-safe-compaction option: ${unknown.sort().join(", ")}`)

  const result: ParsedOptions = {}
  if (value.model !== undefined) {
    if (
      typeof value.model !== "string" ||
      (value.model !== SELECTED_MODEL && !/^[^/\s]+\/[^\s]+$/.test(value.model))
    ) {
      throw new TypeError('Option "model" must be "selected" or use the provider/model format')
    }
    result.model = value.model
  }

  if (value.response_mode !== undefined) {
    if (typeof value.response_mode !== "string" || !(RESPONSE_MODES as readonly string[]).includes(value.response_mode)) {
      throw new TypeError(`Option "response_mode" must be one of: ${RESPONSE_MODES.join(", ")}`)
    }
    result.response_mode = value.response_mode as ResponseMode
  }

  for (const key of OPTION_KEYS.filter((item) => item !== "model" && item !== "response_mode")) {
    if (value[key] === undefined) continue
    if (!Number.isSafeInteger(value[key]) || (key === "tail_turns" ? Number(value[key]) < 0 : Number(value[key]) <= 0)) {
      throw new TypeError(`Option "${key}" must be a ${key === "tail_turns" ? "non-negative" : "positive"} integer`)
    }
    result[key] = Number(value[key])
  }
  return result
}

export function resolveOptions(options: ParsedOptions, existing: ExistingOptions = {}) {
  const result: PluginOptions = {
    model: options.model ?? existing.model ?? SELECTED_MODEL,
    response_mode: options.response_mode ?? DEFAULT_OPTIONS.response_mode,
    tail_turns: options.tail_turns ?? existing.tail_turns ?? DEFAULT_OPTIONS.tail_turns,
    preserve_recent_tokens:
      options.preserve_recent_tokens ?? existing.preserve_recent_tokens ?? DEFAULT_OPTIONS.preserve_recent_tokens,
    reserved_tokens: options.reserved_tokens ?? existing.reserved_tokens ?? DEFAULT_OPTIONS.reserved_tokens,
    max_output_tokens: options.max_output_tokens ?? DEFAULT_OPTIONS.max_output_tokens,
    max_user_text_bytes: options.max_user_text_bytes ?? DEFAULT_OPTIONS.max_user_text_bytes,
    max_inline_data_bytes: options.max_inline_data_bytes ?? DEFAULT_OPTIONS.max_inline_data_bytes,
    max_historical_part_bytes: options.max_historical_part_bytes ?? DEFAULT_OPTIONS.max_historical_part_bytes,
    max_ledger_bytes: options.max_ledger_bytes ?? DEFAULT_OPTIONS.max_ledger_bytes,
    max_summary_bytes: options.max_summary_bytes ?? DEFAULT_OPTIONS.max_summary_bytes,
  }
  for (const key of Object.keys(MAX_OPTIONS) as Array<keyof typeof MAX_OPTIONS>) {
    if (result[key] > MAX_OPTIONS[key]) {
      throw new TypeError(`Option "${key}" must not exceed ${MAX_OPTIONS[key]}`)
    }
  }
  if (result.max_historical_part_bytes < 128) {
    throw new TypeError('Option "max_historical_part_bytes" must be at least 128 bytes')
  }
  if (result.max_ledger_bytes < 1_024) {
    throw new TypeError('Option "max_ledger_bytes" must be at least 1024 bytes')
  }
  if (result.max_summary_bytes < result.max_ledger_bytes + 1_024) {
    throw new TypeError('Option "max_summary_bytes" must exceed "max_ledger_bytes" by at least 1024 bytes')
  }
  if (result.response_mode === "json" && result.max_summary_bytes < result.max_ledger_bytes + 4_096 + 2_048) {
    throw new TypeError('Option "max_summary_bytes" must leave at least 2048 bytes for the JSON projection after ledger and rendering overhead')
  }
  return result
}
