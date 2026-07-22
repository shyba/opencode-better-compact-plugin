import { describe, expect, spyOn, test } from "bun:test"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  buildRecoveryLedger,
  canonicalLedger,
  type MessageRecord,
  type RecoveryLedger,
  type TodoRecord,
  utf8Bytes,
} from "../src/ledger.js"
import { parseOptions, resolveOptions } from "../src/options.js"
import { decodedDataUrlBytes, sanitizeHistory, server } from "../src/server.js"
import { REQUIRED_SECTIONS, isPluginValidSummary, parsePluginLedger } from "../src/validation.js"

type StoredMessage = MessageRecord & {
  info: MessageRecord["info"] & {
    mode?: string
    agent?: string
  }
}

type SessionFixture = {
  messages: StoredMessage[]
  todos: TodoRecord[]
}

type MockState = {
  sessions: Map<string, SessionFixture>
  metadataRequests: string[]
  targetRequests: string[]
}

const TEST_OPTIONS = {
  model: "test/compactor",
  tail_turns: 4,
  preserve_recent_tokens: 100,
  reserved_tokens: 100,
  max_output_tokens: 64,
  max_user_text_bytes: 5,
  max_inline_data_bytes: 3,
  max_historical_part_bytes: 128,
  max_ledger_bytes: 4_096,
  max_summary_bytes: 8_192,
} satisfies Record<string, unknown>

function state(...fixtures: Array<[string, SessionFixture]>): MockState {
  return { sessions: new Map(fixtures), metadataRequests: [], targetRequests: [] }
}

function pluginInput(mock: MockState) {
  const client = {
    session: {
      messages: async (input: { path: { id: string }; throwOnError: boolean }) => {
        mock.metadataRequests.push(`messages:${input.path.id}`)
        return { data: mock.sessions.get(input.path.id)?.messages }
      },
      todo: async (input: { path: { id: string }; throwOnError: boolean }) => {
        mock.metadataRequests.push(`todos:${input.path.id}`)
        return { data: mock.sessions.get(input.path.id)?.todos }
      },
      message: async (input: { path: { id: string; messageID: string }; throwOnError: boolean }) => {
        mock.targetRequests.push(`${input.path.id}:${input.path.messageID}`)
        return {
          data: mock.sessions.get(input.path.id)?.messages.find((message) => message.info.id === input.path.messageID),
        }
      },
    },
  }
  return { client } as unknown as PluginInput
}

function storedMessage(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  parts: unknown[],
  extra: Partial<StoredMessage["info"]> = {},
): StoredMessage {
  return { info: { id, sessionID, role, ...extra }, parts }
}

function textPart(messageID: string, sessionID: string, text: string, synthetic = false) {
  return {
    id: `${messageID}-text`,
    sessionID,
    messageID,
    type: "text" as const,
    text,
    synthetic,
  }
}

function user(messageID: string, sessionID: string, text: string) {
  return storedMessage(messageID, sessionID, "user", [textPart(messageID, sessionID, text)])
}

function compactionExchange(
  sessionID: string,
  text: string,
  options: { error?: unknown; partIDs?: string[]; suffix?: string; overflow?: boolean } = {},
) {
  const userID = `${sessionID}${options.suffix ?? ""}-compaction-user`
  const summaryID = `${sessionID}${options.suffix ?? ""}-compaction-summary`
  const partIDs = options.partIDs ?? [`${summaryID}-text`]
  return {
    request: storedMessage(userID, sessionID, "user", [
      {
        id: `${userID}-part`,
        sessionID,
        messageID: userID,
        type: "compaction",
        ...(options.overflow ? { auto: true, overflow: true } : {}),
      },
    ]),
    summary: storedMessage(
      summaryID,
      sessionID,
      "assistant",
      partIDs.map((id, index) => ({ id, sessionID, messageID: summaryID, type: "text", text: index === 0 ? text : "" })),
      {
        summary: true,
        parentID: userID,
        mode: "compaction",
        ...(options.error ? { error: options.error } : {}),
      },
    ),
    partIDs,
  }
}

function summaryFor(ledger: RecoveryLedger, label = "fact") {
  return REQUIRED_SECTIONS.map((section) => `## ${section}\n- ${label}: ${section}`).join("\n\n") + `\n\n${ledger.block}`
}

function transformOutput(messages: StoredMessage[]) {
  return { messages } as unknown as Parameters<NonNullable<Hooks["experimental.chat.messages.transform"]>>[1]
}

async function compact(hooks: Hooks, sessionID: string) {
  const output: { context: string[]; prompt?: string } = { context: [] }
  await hooks["experimental.session.compacting"]?.({ sessionID }, output)
  return output
}

async function complete(
  hooks: Hooks,
  sessionID: string,
  messageID: string,
  partID: string,
  text: string,
  target?: StoredMessage,
) {
  const output = { text }
  await hooks["experimental.text.complete"]?.({ sessionID, messageID, partID }, output)
  const part = target?.parts.find((item) => {
    const value = item as { id?: string; type?: string }
    return value.id === partID && value.type === "text"
  }) as { text?: string } | undefined
  if (part) part.text = output.text
  return output.text
}

async function autocontinue(hooks: Hooks, sessionID: string, enabled = true) {
  const output = { enabled }
  const input = { sessionID } as unknown as Parameters<NonNullable<Hooks["experimental.compaction.autocontinue"]>>[0]
  await hooks["experimental.compaction.autocontinue"]?.(input, output)
  return output.enabled
}

function expectedLedger(fixture: SessionFixture, excludeSummaryID?: string) {
  return buildRecoveryLedger({
    messages: fixture.messages,
    todos: fixture.todos,
    tailTurns: Number(TEST_OPTIONS.tail_turns),
    maxBytes: Number(TEST_OPTIONS.max_ledger_bytes),
    ...(excludeSummaryID ? { excludeSummaryID } : {}),
  })
}

describe("admission limits", () => {
  test("measures UTF-8 text, sums parts, and ignores synthetic recovery text", async () => {
    const hooks = await server(pluginInput(state()), TEST_OPTIONS)
    const hook = hooks["chat.message"]
    expect(hook).toBeDefined()

    await expect(
      hook?.(
        { sessionID: "admission" },
        {
          message: {} as Parameters<NonNullable<Hooks["chat.message"]>>[1]["message"],
          parts: [textPart("user", "admission", "éé")],
        } as unknown as Parameters<NonNullable<Hooks["chat.message"]>>[1],
      ),
    ).resolves.toBeUndefined()

    await expect(
      hook?.(
        { sessionID: "admission" },
        {
          message: {} as Parameters<NonNullable<Hooks["chat.message"]>>[1]["message"],
          parts: [textPart("user-a", "admission", "é"), textPart("user-b", "admission", "éé")],
        } as unknown as Parameters<NonNullable<Hooks["chat.message"]>>[1],
      ),
    ).rejects.toThrow("rejected a 6-byte user message (limit 5)")

    await expect(
      hook?.(
        { sessionID: "admission" },
        {
          message: {} as Parameters<NonNullable<Hooks["chat.message"]>>[1]["message"],
          parts: [textPart("synthetic", "admission", "secret conversation text".repeat(100), true)],
        } as unknown as Parameters<NonNullable<Hooks["chat.message"]>>[1],
      ),
    ).resolves.toBeUndefined()
  })

  test("measures decoded base64 and percent-encoded inline data", async () => {
    expect(decodedDataUrlBytes("data:text/plain;base64,YWJj")).toBe(3)
    expect(decodedDataUrlBytes("DATA:text/plain;base64,YWJj")).toBe(3)
    expect(decodedDataUrlBytes("data:text/plain,hello%20world")).toBe(11)
    expect(() => decodedDataUrlBytes("data:text/plain,%zz")).toThrow("Invalid percent-encoding")
    expect(() => decodedDataUrlBytes("data:text/plain;base64,%%%%")).toThrow("Invalid base64")

    const hooks = await server(pluginInput(state()), TEST_OPTIONS)
    const output = (url: string) =>
      ({
        message: {},
        parts: [
          {
            id: "file",
            sessionID: "admission",
            messageID: "user",
            type: "file",
            mime: "text/plain",
            url,
          },
        ],
      }) as unknown as Parameters<NonNullable<Hooks["chat.message"]>>[1]

    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, output("data:text/plain;base64,YWJj"))).resolves.toBeUndefined()
    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, output("data:text/plain;base64,YWJjZA=="))).rejects.toThrow(
      "rejected 4 decoded inline-data bytes (limit 3)",
    )
    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, output("DATA:text/plain;base64,YWJjZA=="))).rejects.toThrow(
      "rejected 4 decoded inline-data bytes (limit 3)",
    )
    const splitInline = output("data:text/plain;base64,YWI=")
    splitInline.parts.push(...output("data:text/plain;base64,Y2Q=").parts)
    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, splitInline)).rejects.toThrow(
      "rejected 4 decoded inline-data bytes (limit 3)",
    )
  })
})

describe("configuration and model request parameters", () => {
  test("applies explicit-over-existing precedence without rewriting providers", async () => {
    const hooks = await server(pluginInput(state()), {
      ...TEST_OPTIONS,
      model: "explicit/model",
      tail_turns: 9,
      preserve_recent_tokens: 200,
      reserved_tokens: 300,
    })
    const providers = { local: { models: { stable: { name: "Stable" } } } }
    const config = {
      provider: structuredClone(providers),
      agent: { compaction: { model: "existing/model", temperature: 0.7, keep: "value" } },
      compaction: {
        auto: false,
        prune: true,
        tail_turns: 2,
        preserve_recent_tokens: 20,
        reserved: 30,
      },
    } as unknown as Config

    await hooks.config?.(config)
    expect(config).toMatchObject({
      provider: providers,
      agent: { compaction: { model: "explicit/model", temperature: 0, keep: "value" } },
      compaction: {
        auto: false,
        prune: true,
        tail_turns: 9,
        preserve_recent_tokens: 200,
        reserved: 300,
      },
    })
  })

  test("uses existing compaction values when tuple options omit them and defaults auto/prune", async () => {
    const hooks = await server(pluginInput(state()), {})
    const config = {
      agent: { compaction: { model: "existing/model" } },
      compaction: { tail_turns: 7, preserve_recent_tokens: 700, reserved: 900 },
    } as unknown as Config
    await hooks.config?.(config)

    expect(config).toMatchObject({
      agent: { compaction: { model: "existing/model", temperature: 0 } },
      compaction: {
        auto: true,
        prune: false,
        tail_turns: 7,
        preserve_recent_tokens: 700,
        reserved: 900,
      },
    })
  })

  test("scopes model checks and output caps to the compaction agent", async () => {
    const hooks = await server(pluginInput(state()), TEST_OPTIONS)
    const output = { temperature: 0.9, topP: 1, topK: 0, maxOutputTokens: 500, options: {} }
    const base = {
      sessionID: "params",
      agent: "compaction",
      model: { providerID: "test", id: "compactor", limit: { context: 1_000, output: 80 } },
    } as unknown as Parameters<NonNullable<Hooks["chat.params"]>>[0]

    await hooks["chat.params"]?.(base, output)
    expect(output.temperature).toBe(0)
    expect(output.maxOutputTokens).toBe(64)

    const ordinary = { ...output, temperature: 0.8, maxOutputTokens: 500 }
    await hooks["chat.params"]?.({ ...base, agent: "build" }, ordinary)
    expect(ordinary).toMatchObject({ temperature: 0.8, maxOutputTokens: 500 })

    await expect(
      hooks["chat.params"]?.(
        { ...base, model: { ...base.model, id: "wrong" } },
        { ...output },
      ),
    ).rejects.toThrow("expected compaction model test/compactor, received test/wrong")
    await expect(
      hooks["chat.params"]?.(
        { ...base, model: { ...base.model, limit: { context: 100, output: 80 } } },
        { ...output },
      ),
    ).rejects.toThrow("leaves no usable input")
    await expect(
      hooks["chat.params"]?.(
        { ...base, model: { ...base.model, limit: { context: 1_000, output: 0 } } },
        { ...output },
      ),
    ).rejects.toThrow("zero output limit")
    await expect(hooks["chat.params"]?.(base, { ...output, maxOutputTokens: 0 })).rejects.toThrow(
      "maxOutputTokens=0",
    )
  })
})

describe("model-visible history sanitization", () => {
  test("bounds text and tool output with head/tail markers and replaces oversized inline data", () => {
    const options = resolveOptions(parseOptions(TEST_OPTIONS))
    const sessionID = "sanitize"
    const originalText = `HEAD-${"🙂".repeat(80)}-TAIL`
    const originalTool = `TOOL-HEAD-${"x".repeat(2_000)}-TOOL-TAIL`
    const messages = [
      storedMessage("history", sessionID, "assistant", [
        textPart("history", sessionID, originalText),
        {
          id: "tool",
          sessionID,
          messageID: "history",
          type: "tool",
          callID: "call",
          tool: "read",
          state: { status: "completed", input: {}, output: originalTool, title: "read", metadata: {}, time: {} },
        },
        {
          id: "file",
          sessionID,
          messageID: "history",
          type: "file",
          mime: "application/octet-stream",
          filename: "payload.bin",
          url: "data:application/octet-stream;base64,YWJjZA==",
        },
      ]),
    ]

    sanitizeHistory(
      messages as unknown as Parameters<typeof sanitizeHistory>[0],
      options,
    )
    const text = messages[0]?.parts[0] as { text: string }
    const tool = messages[0]?.parts[1] as { state: { output: string } }
    const file = messages[0]?.parts[2] as { type: string; synthetic: boolean; text: string }
    expect(utf8Bytes(text.text)).toBeLessThanOrEqual(options.max_historical_part_bytes)
    expect(text.text).toStartWith("HEAD-")
    expect(text.text).toEndWith("-TAIL")
    expect(text.text).toContain("historical text omitted")
    expect(tool.state.output).toStartWith("TOOL-HEAD-")
    expect(tool.state.output).toEndWith("-TOOL-TAIL")
    expect(tool.state.output).toContain("characters omitted")
    expect(Array.from(tool.state.output).length).toBeLessThan(1_900)
    expect(file).toMatchObject({ type: "text", synthetic: true })
    expect(file.text).toContain("payload.bin")
    expect(file.text).not.toContain("YWJjZA")
  })

  test("leaves all ordinary history byte-for-byte unchanged without an active or recoverable attempt", async () => {
    const sessionID = "ordinary"
    const fixture = { messages: [user("u", sessionID, "normal request")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    const providerHistory = structuredClone(fixture.messages)
    const before = structuredClone(providerHistory)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect(providerHistory).toEqual(before)
    expect(mock.metadataRequests).toEqual([])
  })

  test("sanitizes overflow replay only in the cloned provider history during an active attempt", async () => {
    const sessionID = "overflow"
    const fixture = { messages: [user("u", sessionID, "preserve durable input")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const providerHistory = structuredClone(fixture.messages)
    ;(providerHistory[0]?.parts[0] as { text: string }).text = "H" + "x".repeat(1_000) + "T"

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory[0]?.parts[0] as { text: string }).text).toContain("historical text omitted")
    expect((fixture.messages[0]?.parts[0] as { text: string }).text).toBe("preserve durable input")
  })

  test("reconstructs overflow replay sanitization after session.compacted cleans active state", async () => {
    const sessionID = "overflow-after-cleanup"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const fixture = {
      messages: [user("000-context", sessionID, "earlier context"), user("original", sessionID, overflowText)],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, summaryFor(expectedLedger(fixture)), { overflow: true })
    const replay = user(`${sessionID}-replay`, sessionID, overflowText)
    fixture.messages.push(exchange.request, exchange.summary, replay)
    await hooks.event?.({
      event: { type: "session.compacted", properties: { sessionID } } as unknown as Parameters<
        NonNullable<Hooks["event"]>
      >[0]["event"],
    })
    const providerHistory = structuredClone(fixture.messages.slice(2))

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toContain("historical text omitted")
    expect((fixture.messages.at(-1)?.parts[0] as { text: string }).text).toBe(overflowText)
  })

  test("targets the durable overflow replay without truncating a later admitted user request", async () => {
    const sessionID = "overflow-target"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const fixture = {
      messages: [user("000", sessionID, "earlier context"), user("001", sessionID, overflowText)],
      todos: [],
    }
    const request = storedMessage("002", sessionID, "user", [
      { id: "002-part", sessionID, messageID: "002", type: "compaction", auto: true, overflow: true },
    ])
    const summary = storedMessage(
      "003",
      sessionID,
      "assistant",
      [textPart("003", sessionID, summaryFor(expectedLedger(fixture)))],
      { summary: true, parentID: "002", mode: "compaction" },
    )
    const replay = user("004", sessionID, overflowText)
    const response = storedMessage("005", sessionID, "assistant", [textPart("005", sessionID, "processed replay")])
    const newest = user("006", sessionID, "N" + "y".repeat(200) + "W")
    fixture.messages.push(request, summary, replay, response, newest)
    const hooks = await server(pluginInput(state([sessionID, fixture])), {
      ...TEST_OPTIONS,
      max_user_text_bytes: 512,
    })
    const providerHistory = structuredClone(fixture.messages.slice(2))

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.find((message) => message.info.id === "004")?.parts[0] as { text: string }).text).toContain(
      "historical text omitted",
    )
    expect((providerHistory.find((message) => message.info.id === "006")?.parts[0] as { text: string }).text).toBe(
      "N" + "y".repeat(200) + "W",
    )
  })

  test("does not infer replay from an unmatched first user after an overflow compaction", async () => {
    const sessionID = "overflow-no-replay"
    const manualText = "M" + "z".repeat(200) + "W"
    const fixture = { messages: [user("001", sessionID, manualText)], todos: [] }
    const request = storedMessage("002", sessionID, "user", [
      { id: "002-part", sessionID, messageID: "002", type: "compaction", auto: true, overflow: true },
    ])
    const summary = storedMessage(
      "003",
      sessionID,
      "assistant",
      [textPart("003", sessionID, summaryFor(expectedLedger(fixture)))],
      { summary: true, parentID: "002", mode: "compaction" },
    )
    const manual = user("004", sessionID, manualText)
    fixture.messages.push(request, summary, manual)
    const hooks = await server(pluginInput(state([sessionID, fixture])), {
      ...TEST_OPTIONS,
      max_user_text_bytes: 512,
    })
    const providerHistory = structuredClone(fixture.messages.slice(1))

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toBe(manualText)
  })

  test.each([
    ["image/png", "picture.png"],
    ["application/pdf", "document.pdf"],
  ])("matches normalized %s replay while preserving copied synthetic parts", async (mime, filename) => {
    const sessionID = `overflow-media-${mime === "image/png" ? "image" : "pdf"}`
    const overflowText = "S" + "x".repeat(1_000) + "T"
    const original = storedMessage("002", sessionID, "user", [
      {
        id: "002-file",
        sessionID,
        messageID: "002",
        type: "file",
        mime,
        filename,
        url: "data:application/octet-stream;base64,YWJj",
      },
      textPart("002-synthetic", sessionID, overflowText, true),
    ])
    const fixture = { messages: [user("001", sessionID, "earlier context"), original], todos: [] }
    const request = storedMessage("003", sessionID, "user", [
      { id: "003-part", sessionID, messageID: "003", type: "compaction", auto: true, overflow: true },
    ])
    const summary = storedMessage(
      "004",
      sessionID,
      "assistant",
      [textPart("004", sessionID, summaryFor(expectedLedger(fixture)))],
      { summary: true, parentID: "003", mode: "compaction" },
    )
    const replay = storedMessage("005", sessionID, "user", [
      {
        id: "005-media-text",
        sessionID,
        messageID: "005",
        type: "text",
        text: `[Attached ${mime}: ${filename}]`,
      },
      textPart("005-synthetic", sessionID, overflowText, true),
    ])
    fixture.messages.push(request, summary, replay)
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone([request, summary, replay])

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toBe(`[Attached ${mime}: ${filename}]`)
    expect((providerHistory.at(-1)?.parts[1] as { text: string }).text).toContain("historical text omitted")
    expect((fixture.messages.at(-1)?.parts[1] as { text: string }).text).toBe(overflowText)
  })

  test("does not guess a Session when provider history contains multiple Session IDs", async () => {
    const firstID = "mixed-first"
    const secondID = "mixed-second"
    const firstFixture = { messages: [user("first", firstID, "first")], todos: [] }
    const secondFixture = { messages: [user("second", secondID, "second")], todos: [] }
    const hooks = await server(pluginInput(state([firstID, firstFixture], [secondID, secondFixture])), TEST_OPTIONS)
    await compact(hooks, firstID)
    const providerHistory = [
      user("first-provider", firstID, "x".repeat(1_000)),
      user("second-provider", secondID, "y".repeat(1_000)),
    ]
    const before = structuredClone(providerHistory)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect(providerHistory).toEqual(before)
  })
})

describe("real hook compaction flows", () => {
  test("manual compaction installs the deterministic single-response prompt", async () => {
    const sessionID = "manual"
    const fixture = { messages: [user("manual-user", sessionID, "Must finish the manual request")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const output = await compact(hooks, sessionID)
    const ledger = expectedLedger(fixture)

    expect(output.prompt).toStartWith("Create one recovery summary")
    expect(output.prompt).toContain("Return one Markdown response and no commentary outside it")
    for (const section of REQUIRED_SECTIONS) expect(output.prompt).toContain(`## ${section}`)
    expect(output.prompt).toEndWith(ledger.block)
  })

  test("accepts a valid original summary and permits auto-continuation", async () => {
    const sessionID = "valid"
    const fixture = { messages: [user("valid-user", sessionID, "Must retain this request")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const original = summaryFor(expectedLedger(fixture, exchange.summary.info.id), "original")

    expect(await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, original, exchange.summary)).toBe(original)
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("revalidates durable summary text before auto-continuation", async () => {
    const sessionID = "durable-revalidation"
    const fixture = { messages: [user("request", sessionID, "Retain the durable fact")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const original = summaryFor(expectedLedger(fixture, exchange.summary.info.id), "original")
    await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, original, exchange.summary)
    ;(exchange.summary.parts[0] as { text: string }).text += "\nunsupported later mutation"

    expect(await autocontinue(hooks, sessionID)).toBe(false)
  })

  test.each(["malformed response", "I cannot comply with this request."])(
    "replaces %p with a deterministic valid fallback",
    async (providerText) => {
      const sessionID = `fallback-${providerText.startsWith("I") ? "refusal" : "malformed"}`
      const fixture = { messages: [user("request", sessionID, "Do not lose this fact")], todos: [] }
      const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
      await compact(hooks, sessionID)
      const exchange = compactionExchange(sessionID, "")
      fixture.messages.push(exchange.request, exchange.summary)
      const fallback = await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, providerText, exchange.summary)

      expect(fallback).not.toContain(providerText)
      expect(isPluginValidSummary(fallback, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
      expect(parsePluginLedger(fallback)?.data.recent_requests).toEqual(["Do not lose this fact"])
      expect(await autocontinue(hooks, sessionID)).toBe(true)
    },
  )

  test("replaces an oversized provider response with a bounded fallback", async () => {
    const sessionID = "oversized-summary"
    const fixture = { messages: [user("request", sessionID, "Retain the bounded fallback fact")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const fallback = await complete(
      hooks,
      sessionID,
      exchange.summary.info.id,
      exchange.partIDs[0]!,
      "provider-output".repeat(1_000),
      exchange.summary,
    )

    expect(utf8Bytes(fallback)).toBeLessThanOrEqual(Number(TEST_OPTIONS.max_summary_bytes))
    expect(isPluginValidSummary(fallback, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("collapses a split response to one fallback and blanks later text parts", async () => {
    const sessionID = "multipart"
    const fixture = { messages: [user("request", sessionID, "Keep multipart recovery")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "", { partIDs: ["part-one", "part-two"] })
    fixture.messages.push(exchange.request, exchange.summary)
    const providerFirstPart = summaryFor(expectedLedger(fixture, exchange.summary.info.id), "split")
    const first = await complete(hooks, sessionID, exchange.summary.info.id, "part-one", providerFirstPart, exchange.summary)
    const second = await complete(hooks, sessionID, exchange.summary.info.id, "part-two", "extra response text", exchange.summary)

    expect(first).not.toBe(providerFirstPart)
    expect(isPluginValidSummary(first, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
    expect(second).toBe("")
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("suppresses auto-continuation when a zero-text response fires no completion hook", async () => {
    const sessionID = "zero"
    const fixture = { messages: [user("request", sessionID, "Keep zero response context")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)

    expect(await autocontinue(hooks, sessionID)).toBe(false)
  })

  test("preserves a previous plugin's disabled auto-continuation decision", async () => {
    const sessionID = "disabled"
    const fixture = { messages: [user("request", sessionID, "Keep disabled setting")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const fallback = await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, "bad", exchange.summary)
    expect(isPluginValidSummary(fallback, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)

    expect(await autocontinue(hooks, sessionID, false)).toBe(false)
  })

  test("treats provider error events as cleanup signals and never enables an invalid summary", async () => {
    const sessionID = "provider-error"
    const fixture = { messages: [user("request", sessionID, "Recover after provider error")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "", { error: { name: "ProviderError", message: "upstream failed" } })
    fixture.messages.push(exchange.request, exchange.summary)
    await hooks.event?.({
      event: { type: "session.error", properties: { sessionID, error: "conversation text must not be logged" } } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
    })

    expect(await autocontinue(hooks, sessionID)).toBe(false)
  })

  test("injects bounded recovery after an invalid compaction without changing durable history", async () => {
    const sessionID = "recovery"
    const legacy = storedMessage("legacy", sessionID, "assistant", [textPart("legacy", sessionID, "Legacy summary claim")], {
      summary: true,
    })
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const fixture = {
      messages: [user("old", sessionID, "Must preserve old request"), legacy, exchange.request, exchange.summary, user("zzz-new", sessionID, "Continue now")],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    const providerUser = providerHistory.find((message) => message.info.id === "zzz-new")
    const injected = providerUser?.parts.at(-1) as { synthetic: boolean; text: string }
    expect(injected.synthetic).toBe(true)
    expect(injected.text).toContain("No prior plugin-valid summary is available")
    expect(injected.text).toContain("Legacy summary claim")
    expect(injected.text).not.toContain("EmptySummary")
    expect(fixture.messages.find((message) => message.info.id === "zzz-new")?.parts).toHaveLength(1)
  })

  test("preserves a newly admitted recovery request above the historical-part limit", async () => {
    const sessionID = "recovery-new-user"
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const newestText = "N" + "x".repeat(200) + "W"
    const newest = user("zzz-new", sessionID, newestText)
    const fixture = {
      messages: [user("001-old", sessionID, "old request"), exchange.request, exchange.summary, newest],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), {
      ...TEST_OPTIONS,
      max_user_text_bytes: 512,
    })
    const providerHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    const providerUser = providerHistory.find((message) => message.info.id === newest.info.id)
    expect((providerUser?.parts[0] as { text: string }).text).toBe(newestText)
    expect(providerUser?.parts).toHaveLength(2)
    expect((providerUser?.parts[1] as { synthetic: boolean }).synthetic).toBe(true)
    expect((fixture.messages.at(-1)?.parts[0] as { text: string }).text).toBe(newestText)
  })

  test("bounds a proven overflow replay before injecting empty-summary recovery context", async () => {
    const sessionID = "recovery-overflow-replay"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const request = storedMessage("003", sessionID, "user", [
      { id: "003-part", sessionID, messageID: "003", type: "compaction", auto: true, overflow: true },
    ])
    const summary = storedMessage(
      "004",
      sessionID,
      "assistant",
      [textPart("004", sessionID, "")],
      { summary: true, parentID: "003", mode: "compaction", error: { name: "EmptySummary" } },
    )
    const replay = user("005", sessionID, overflowText)
    const fixture = {
      messages: [user("001", sessionID, "earlier context"), user("002", sessionID, overflowText), request, summary, replay],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone([request, summary, replay])

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toContain("historical text omitted")
    expect((providerHistory.at(-1)?.parts[1] as { synthetic: boolean }).synthetic).toBe(true)
    expect((fixture.messages.at(-1)?.parts[0] as { text: string }).text).toBe(overflowText)
  })

  test("selects the max-ID invalid compaction from reordered retained-tail history", async () => {
    const sessionID = "recovery-reordered-tail"
    const olderRequest = storedMessage("020", sessionID, "user", [
      { id: "020-part", sessionID, messageID: "020", type: "compaction" },
    ])
    const olderSummary = storedMessage(
      "021",
      sessionID,
      "assistant",
      [textPart("021", sessionID, "Older retained legacy summary")],
      { summary: true, parentID: "020", mode: "compaction" },
    )
    const currentRequest = storedMessage("100", sessionID, "user", [
      { id: "100-part", sessionID, messageID: "100", type: "compaction" },
    ])
    const currentSummary = storedMessage(
      "101",
      sessionID,
      "assistant",
      [textPart("101", sessionID, "")],
      { summary: true, parentID: "100", mode: "compaction", error: { name: "EmptySummary" } },
    )
    const newest = user("102", sessionID, "Resume from the current failure")
    const fixture = {
      messages: [user("010", sessionID, "retained old request"), olderRequest, olderSummary, currentRequest, currentSummary, newest],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone([
      currentRequest,
      currentSummary,
      fixture.messages[0]!,
      olderRequest,
      olderSummary,
      newest,
    ])

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    const providerUser = providerHistory.find((message) => message.info.id === newest.info.id)
    expect((providerUser?.parts.at(-1) as { synthetic: boolean }).synthetic).toBe(true)
    expect((providerUser?.parts.at(-1) as { text: string }).text).toContain("Safe-compaction recovery context")
  })

  test("injects the newest plugin-valid prior state but never trusts a newer legacy summary as the anchor", async () => {
    const sessionID = "prior-valid"
    const priorLedger = canonicalLedger({
      recent_requests: [],
      constraints: [],
      todos: [],
      touched_paths: [],
      tool_statuses: [],
      errors: [],
      evidence: [],
      next_actions: [],
      legacy_context: [],
    })
    const trusted = summaryFor(priorLedger, "TRUSTED-PRIOR-STATE")
    const prior = storedMessage("prior", sessionID, "assistant", [textPart("prior", sessionID, trusted)], { summary: true })
    const legacy = storedMessage("newer-legacy", sessionID, "assistant", [textPart("newer-legacy", sessionID, "UNTRUSTED-LEGACY-ANCHOR")], {
      summary: true,
    })
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const fixture = {
      messages: [user("old", sessionID, "Original request"), prior, legacy, exchange.request, exchange.summary, user("zzz-new", sessionID, "Resume")],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    const injected = providerHistory.find((message) => message.info.id === "zzz-new")?.parts.at(-1) as { text: string }
    expect(injected.text).toContain("Prior validated state: - TRUSTED-PRIOR-STATE: Current state")
    expect(injected.text.slice(0, injected.text.indexOf("<!-- opencode-safe-compaction"))).not.toContain("UNTRUSTED-LEGACY-ANCHOR")
  })

  test("ignores text completion for an ordinary assistant message", async () => {
    const sessionID = "ordinary-target"
    const ordinary = storedMessage("assistant", sessionID, "assistant", [textPart("assistant", sessionID, "ordinary")], {
      mode: "build",
    })
    const fixture = { messages: [user("request", sessionID, "Request"), ordinary], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await complete(hooks, sessionID, ordinary.info.id, "assistant-text", "ordinary assistant output")).toBe(
      "ordinary assistant output",
    )
  })

  test("recovers a validated compaction from durable history after plugin restart", async () => {
    const sessionID = "restart"
    const fixture = { messages: [user("request", sessionID, "Restart-safe fact")], todos: [] }
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    ;(exchange.summary.parts[0] as { text: string }).text = summaryFor(expectedLedger(fixture, exchange.summary.info.id), "durable")
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("keeps a second real compaction valid when its ledger carries the prior plugin summary", async () => {
    const sessionID = "sequential"
    const fixture = { messages: [user("001", sessionID, "First durable request")], todos: [] }
    const options = { ...TEST_OPTIONS, max_ledger_bytes: 8_192, max_summary_bytes: 16_384 }
    const hooks = await server(pluginInput(state([sessionID, fixture])), options)
    await compact(hooks, sessionID)
    const first = compactionExchange(sessionID, "", { suffix: "-first" })
    fixture.messages.push(first.request, first.summary)
    const firstFallback = await complete(
      hooks,
      sessionID,
      first.summary.info.id,
      first.partIDs[0]!,
      "malformed",
      first.summary,
    )
    expect(isPluginValidSummary(firstFallback, Number(options.max_summary_bytes))).toBe(true)
    expect(await autocontinue(hooks, sessionID)).toBe(true)

    fixture.messages.push(user("900", sessionID, "Second durable request"))
    await compact(hooks, sessionID)
    const second = compactionExchange(sessionID, "", { suffix: "-second" })
    fixture.messages.push(second.request, second.summary)
    const restarted = await server(pluginInput(state([sessionID, fixture])), options)
    const secondFallback = await complete(
      restarted,
      sessionID,
      second.summary.info.id,
      second.partIDs[0]!,
      "malformed again",
      second.summary,
    )

    expect(isPluginValidSummary(secondFallback, Number(options.max_summary_bytes))).toBe(true)
    expect(parsePluginLedger(secondFallback)?.data.legacy_context[0]).toContain("## Goal")
    expect(await autocontinue(restarted, sessionID)).toBe(true)
  })

  test("isolates two concurrent session attempts by Session ID", async () => {
    const firstID = "concurrent-a"
    const secondID = "concurrent-b"
    const firstFixture = { messages: [user("a-user", firstID, "First session fact")], todos: [] }
    const secondFixture = { messages: [user("b-user", secondID, "Second session fact")], todos: [] }
    const hooks = await server(pluginInput(state([firstID, firstFixture], [secondID, secondFixture])), TEST_OPTIONS)
    await Promise.all([compact(hooks, firstID), compact(hooks, secondID)])
    const firstExchange = compactionExchange(firstID, "")
    const secondExchange = compactionExchange(secondID, "")
    firstFixture.messages.push(firstExchange.request, firstExchange.summary)
    secondFixture.messages.push(secondExchange.request, secondExchange.summary)
    const [first, second] = await Promise.all([
      complete(hooks, firstID, firstExchange.summary.info.id, firstExchange.partIDs[0]!, "bad", firstExchange.summary),
      complete(hooks, secondID, secondExchange.summary.info.id, secondExchange.partIDs[0]!, "bad", secondExchange.summary),
    ])

    expect(parsePluginLedger(first)?.data.recent_requests).toEqual(["First session fact"])
    expect(parsePluginLedger(second)?.data.recent_requests).toEqual(["Second session fact"])
    expect(first).not.toContain("Second session fact")
    expect(second).not.toContain("First session fact")
    expect(await Promise.all([autocontinue(hooks, firstID), autocontinue(hooks, secondID)])).toEqual([true, true])
  })

  test("emits no conversation content through console logging", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "info"), spyOn(console, "warn"), spyOn(console, "error")]
    const sessionID = "privacy"
    const secretText = "PRIVATE-CONVERSATION-SENTINEL"
    const fixture = { messages: [user("private", sessionID, secretText)], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)

    for (const log of logs) {
      expect(log).not.toHaveBeenCalled()
      expect(JSON.stringify(log.mock.calls)).not.toContain(secretText)
      log.mockRestore()
    }
  })

  test.each([
    ["session.compacted", { sessionID: "cleanup" }],
    ["session.idle", { sessionID: "cleanup" }],
    ["session.status", { sessionID: "cleanup", status: { type: "idle" } }],
    ["session.deleted", { info: { id: "cleanup" } }],
    ["session.error", { sessionID: "cleanup" }],
  ])("uses %s only to clean active attempt metadata", async (type, properties) => {
    const sessionID = "cleanup"
    const fixture = { messages: [user("cleanup-user", sessionID, "Durable cleanup context")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    await hooks.event?.({ event: { type, properties } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]["event"] })
    const providerHistory = structuredClone(fixture.messages)
    ;(providerHistory[0]?.parts[0] as { text: string }).text = "x".repeat(1_000)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory[0]?.parts[0] as { text: string }).text).toBe("x".repeat(1_000))
  })
})
