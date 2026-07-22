import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, MAX_OPTIONS, OPTION_KEYS, parseOptions, resolveOptions } from "../src/options.js"

describe("plugin option validation", () => {
  test("accepts every documented snake-case option", () => {
    const input = {
      model: "opencode-go/glm-5.2",
      tail_turns: 0,
      preserve_recent_tokens: 16_001,
      reserved_tokens: 32_001,
      max_output_tokens: 16_385,
      max_user_text_bytes: 524_289,
      max_inline_data_bytes: 10_485_761,
      max_historical_part_bytes: 131_073,
      max_ledger_bytes: 12_289,
      max_summary_bytes: 49_153,
    }

    expect(parseOptions(input)).toEqual(input)
    expect(Object.keys(input)).toEqual([...OPTION_KEYS])
  })

  test("rejects unknown keys deterministically", () => {
    expect(() => parseOptions({ zebra: true, camelCase: true })).toThrow(
      "Unknown opencode-safe-compaction option: camelCase, zebra",
    )
  })

  test.each(["model", "provider/", "/model", "provider model/name", 42])(
    "rejects invalid model value %p",
    (model) => {
      expect(() => parseOptions({ model })).toThrow('Option "model" must use the provider/model format')
    },
  )

  test("accepts OpenCode model IDs containing nested slash segments", () => {
    expect(parseOptions({ model: "openrouter/anthropic/claude-v1" })).toEqual({
      model: "openrouter/anthropic/claude-v1",
    })
  })

  test.each([
    ["tail_turns", -1],
    ["tail_turns", 1.5],
    ["reserved_tokens", 0],
    ["max_ledger_bytes", -1],
    ["max_summary_bytes", Number.MAX_SAFE_INTEGER + 1],
    ["max_output_tokens", "100"],
  ])("rejects invalid integer option %s=%p", (key, value) => {
    expect(() => parseOptions({ [key]: value })).toThrow(`Option "${key}" must be a`)
  })
})

describe("plugin option precedence", () => {
  test("uses explicit option, then existing OpenCode value, then plugin default", () => {
    const explicit = resolveOptions(
      parseOptions({
        model: "explicit/model",
        tail_turns: 8,
        preserve_recent_tokens: 20_000,
        reserved_tokens: 40_000,
      }),
      {
        model: "existing/model",
        tail_turns: 6,
        preserve_recent_tokens: 18_000,
        reserved_tokens: 36_000,
      },
    )
    expect(explicit).toMatchObject({
      model: "explicit/model",
      tail_turns: 8,
      preserve_recent_tokens: 20_000,
      reserved_tokens: 40_000,
    })

    const existing = resolveOptions({}, {
      model: "existing/model",
      tail_turns: 6,
      preserve_recent_tokens: 18_000,
      reserved_tokens: 36_000,
    })
    expect(existing).toMatchObject({
      model: "existing/model",
      tail_turns: 6,
      preserve_recent_tokens: 18_000,
      reserved_tokens: 36_000,
      max_output_tokens: DEFAULT_OPTIONS.max_output_tokens,
    })

    expect(resolveOptions({}, { model: "existing/model" })).toMatchObject({
      model: "existing/model",
      tail_turns: DEFAULT_OPTIONS.tail_turns,
      preserve_recent_tokens: DEFAULT_OPTIONS.preserve_recent_tokens,
      reserved_tokens: DEFAULT_OPTIONS.reserved_tokens,
    })
  })

  test("requires a model after applying precedence", () => {
    expect(() => resolveOptions({})).toThrow('Option "model" is required')
  })

  test("requires enough room for the ledger in a fallback summary", () => {
    expect(() =>
      resolveOptions(
        parseOptions({ model: "test/model", max_ledger_bytes: 4_096, max_summary_bytes: 5_119 }),
      ),
    ).toThrow('Option "max_summary_bytes" must exceed "max_ledger_bytes" by at least 1024 bytes')
  })

  test("rejects limits too small for deterministic history markers and the canonical ledger", () => {
    expect(() =>
      resolveOptions(parseOptions({ model: "test/model", max_historical_part_bytes: 127 })),
    ).toThrow('Option "max_historical_part_bytes" must be at least 128 bytes')
    expect(() =>
      resolveOptions(parseOptions({ model: "test/model", max_ledger_bytes: 1_023 })),
    ).toThrow('Option "max_ledger_bytes" must be at least 1024 bytes')
  })

  test("rejects resource limits that would disable the plugin's safety bounds", () => {
    for (const [key, maximum] of Object.entries(MAX_OPTIONS)) {
      expect(() => resolveOptions(parseOptions({ model: "test/model", [key]: maximum + 1 }))).toThrow(
        `Option "${key}" must not exceed ${maximum}`,
      )
    }
  })
})
