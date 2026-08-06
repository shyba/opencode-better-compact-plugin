import { describe, expect, spyOn, test } from "bun:test"
import type { Config, Hooks, PluginInput } from "@opencode-ai/plugin"
import {
  buildRecoveryLedger,
  canonicalLedger,
  type RecoveryLedgerData,
  sha256,
  type MessageRecord,
  type RecoveryLedger,
  type TodoRecord,
  utf8Bytes,
} from "../src/ledger.js"
import { ledgerReferenceID } from "../src/projection.js"
import { parseOptions, resolveOptions } from "../src/options.js"
import { decodedDataUrlBytes, sanitizeHistory, server } from "../src/server.js"
import {
  REQUIRED_SECTIONS,
  buildAuthoritativeSummary,
  buildFallback,
  isAuthoritativeSummary,
  isPluginValidSummary,
  parsePluginLedger,
  parseProjectedSummary,
} from "../src/validation.js"

type StoredMessage = MessageRecord & {
  info: MessageRecord["info"] & {
    mode?: string
    agent?: string
  }
}

type SessionFixture = {
  messages: StoredMessage[]
  todos: TodoRecord[]
  pages?: Array<{ messages: StoredMessage[]; nextCursor?: string }>
  pageByCursor?: Record<string, number>
}

type MockState = {
  sessions: Map<string, SessionFixture>
  metadataRequests: string[]
  messageLimits: Array<number | undefined>
  messageCursors: Array<string | undefined>
  targetRequests: string[]
  targetStatuses: Map<string, number>
  messagesError?: Error
  todoError?: Error
  targetError?: Error
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
  max_summary_bytes: 12_288,
} satisfies Record<string, unknown>

function state(...fixtures: Array<[string, SessionFixture]>): MockState {
  return {
    sessions: new Map(fixtures),
    metadataRequests: [],
    messageLimits: [],
    messageCursors: [],
    targetRequests: [],
    targetStatuses: new Map(),
  }
}

function pluginInput(mock: MockState) {
  const client = {
    session: {
      messages: async (input: {
        path: { id: string }
        query?: { limit?: number; before?: string }
        throwOnError: boolean
      }) => {
        mock.metadataRequests.push(`messages:${input.path.id}`)
        mock.messageLimits.push(input.query?.limit)
        mock.messageCursors.push(input.query?.before)
        if (mock.messagesError) throw mock.messagesError
        const fixture = mock.sessions.get(input.path.id)
        if (!fixture?.pages) return { data: fixture?.messages }
        const pageIndex = input.query?.before
          ? fixture.pageByCursor?.[input.query.before] ?? Number(input.query.before.replace("cursor-", ""))
          : 0
        const page = fixture.pages[pageIndex]
        const headers = new Headers()
        if (page?.nextCursor) headers.set("X-Next-Cursor", page.nextCursor)
        return { data: page?.messages, response: new Response(null, { headers }) }
      },
      todo: async (input: { path: { id: string }; throwOnError: boolean }) => {
        mock.metadataRequests.push(`todos:${input.path.id}`)
        if (mock.todoError) throw mock.todoError
        return { data: mock.sessions.get(input.path.id)?.todos }
      },
      message: async (input: { path: { id: string; messageID: string }; throwOnError: boolean }) => {
        const key = `${input.path.id}:${input.path.messageID}`
        mock.targetRequests.push(key)
        if (mock.targetError) throw mock.targetError
        const fixture = mock.sessions.get(input.path.id)
        const message = [...(fixture?.messages ?? []), ...(fixture?.pages ?? []).flatMap((page) => page.messages)].find(
          (item) => item.info.id === input.path.messageID,
        )
        const status = mock.targetStatuses.get(key) ?? (message ? 200 : 404)
        return {
          data: status === 200 ? message : undefined,
          ...(status === 200 ? {} : { error: { status } }),
          response: new Response(null, { status }),
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
        agent: "compaction",
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
  const output = await completeOutput(hooks, sessionID, messageID, partID, text, target)
  return output.text
}

async function completeOutput(
  hooks: Hooks,
  sessionID: string,
  messageID: string,
  partID: string,
  text: string,
  target?: StoredMessage,
) {
  const output: { text: string; retry?: boolean } = { text }
  await hooks["experimental.text.complete"]?.({ sessionID, messageID, partID }, output)
  const part = target?.parts.find((item) => {
    const value = item as { id?: string; type?: string }
    return value.id === partID && value.type === "text"
  }) as { text?: string } | undefined
  if (part) part.text = output.text
  return output
}

async function autocontinue(
  hooks: Hooks,
  sessionID: string,
  enabled = true,
  messageID = `${sessionID}-compaction-user`,
) {
  const output = { enabled }
  const input = {
    sessionID,
    message: { id: messageID, sessionID, role: "user" },
  } as unknown as Parameters<NonNullable<Hooks["experimental.compaction.autocontinue"]>>[0]
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
  test("measures UTF-8 text, sums parts, and does not trust client-controlled synthetic flags", async () => {
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
    ).rejects.toThrow("user message")
  })

  test("measures decoded base64 and percent-encoded inline data", async () => {
    expect(decodedDataUrlBytes("data:text/plain;base64,YWJj")).toBe(3)
    expect(decodedDataUrlBytes("DATA:text/plain;base64,YWJj")).toBe(3)
    expect(decodedDataUrlBytes("data:text/plain,hello%20world")).toBe(11)
    expect(decodedDataUrlBytes("data:text/plain,%F0%9F%99%82")).toBe(4)
    expect(() => decodedDataUrlBytes("data:text/plain,%zz")).toThrow("Invalid percent-encoding")
    expect(decodedDataUrlBytes("data:text/plain,%FF")).toBe(1)
    expect(decodedDataUrlBytes("data:text/plain,%E2%82")).toBe(2)
    expect(() => decodedDataUrlBytes("data:text/plain;base64,%%%%")).toThrow("Invalid base64")
    expect(() => decodedDataUrlBytes(`data:${"x".repeat(16_385)},a`)).toThrow("metadata exceeds 16384 bytes")

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
      "rejected 4 decoded inline-data bytes or more (limit 3)",
    )
    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, output("DATA:text/plain;base64,YWJjZA=="))).rejects.toThrow(
      "rejected 4 decoded inline-data bytes or more (limit 3)",
    )
    const splitInline = output("data:text/plain;base64,YWI=")
    splitInline.parts.push(...output("data:text/plain;base64,Y2Q=").parts)
    await expect(hooks["chat.message"]?.({ sessionID: "admission" }, splitInline)).rejects.toThrow(
      "rejected 4 decoded inline-data bytes or more (limit 3)",
    )
    await expect(
      hooks["chat.message"]?.(
        { sessionID: "admission" },
        output(`data:text/plain;base64,${" ".repeat(17_000)}YWJj`),
      ),
    ).rejects.toThrow("encoded inline-data bytes")
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

  test("removes a dedicated compaction model in selected mode and accepts each request model", async () => {
    const hooks = await server(pluginInput(state()), { ...TEST_OPTIONS, model: "selected" })
    const config = {
      agent: { compaction: { model: "old/dedicated", keep: "value" } },
    } as unknown as Config
    await hooks.config?.(config)

    expect(config).toMatchObject({
      agent: { compaction: { temperature: 0, keep: "value" } },
    })
    expect((config as unknown as { agent: { compaction: Record<string, unknown> } }).agent.compaction).not.toHaveProperty(
      "model",
    )

    const output = { temperature: 0.9, topP: 1, topK: 0, maxOutputTokens: 500, options: {} }
    const input = {
      sessionID: "selected-model",
      agent: "compaction",
      model: { providerID: "another", id: "current", limit: { context: 1_000, output: 80 } },
    } as unknown as Parameters<NonNullable<Hooks["chat.params"]>>[0]
    await expect(hooks["chat.params"]?.(input, output)).resolves.toBeUndefined()
    expect(output).toMatchObject({ temperature: 0, maxOutputTokens: 64 })
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

    const cleared = { ...output, temperature: 0.9, maxOutputTokens: undefined }
    await hooks["chat.params"]?.(
      { ...base, model: { ...base.model, limit: { context: 40, output: 80 } } },
      cleared,
    )
    expect(cleared.temperature).toBe(0)
    expect(cleared.maxOutputTokens).toBeUndefined()

    const unsupported = { ...output, temperature: undefined, maxOutputTokens: undefined }
    await hooks["chat.params"]?.(base, unsupported)
    expect(unsupported.temperature).toBeUndefined()
    expect(unsupported.maxOutputTokens).toBeUndefined()

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
        { ...output, maxOutputTokens: 80 },
      ),
    ).resolves.toBeUndefined()
    await expect(
      hooks["chat.params"]?.(
        { ...base, model: { ...base.model, limit: { context: 1_000, input: 100, output: 80 } } },
        { ...output, maxOutputTokens: 80 },
      ),
    ).rejects.toThrow("has no usable input")
    await expect(
      hooks["chat.params"]?.(
        { ...base, model: { ...base.model, limit: { context: 1_000, output: 2_000 } } },
        { ...output, maxOutputTokens: 2_000 },
      ),
    ).rejects.toThrow("has no usable input")
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
    expect(tool.state.output).toContain("middle omitted")
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

  test("preserves selected-model history during the initial compaction for prompt-cache reuse", async () => {
    const sessionID = "cache-preserving"
    const fixture = {
      messages: [storedMessage("history", sessionID, "assistant", [
        textPart("history", sessionID, "H" + "x".repeat(1_000) + "T"),
      ])],
      todos: [],
    }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), { ...TEST_OPTIONS, model: "selected" })
    await compact(hooks, sessionID)
    const providerHistory = structuredClone(fixture.messages)
    const before = structuredClone(providerHistory)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    expect(providerHistory).toEqual(before)
  })

  test("reconstructs overflow replay sanitization after session.compacted cleans active state", async () => {
    const sessionID = "overflow-after-cleanup"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const fixture = {
      messages: [user("000-context", sessionID, "earlier context"), user("original", sessionID, overflowText)],
      todos: [],
    }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
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
    expect(mock.messageLimits).toEqual([10_000, 256])
  })

  test("paginates only until two durable pre-compaction requests prove an overflow replay", async () => {
    const sessionID = "paged-overflow"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const fixture: SessionFixture = {
      messages: [user("000-context", sessionID, "earlier context"), user("original", sessionID, overflowText)],
      todos: [],
    }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, summaryFor(expectedLedger(fixture)), { overflow: true })
    const replay = user(`${sessionID}-replay`, sessionID, overflowText)
    fixture.messages.push(exchange.request, exchange.summary, replay)
    fixture.pages = [
      { messages: [exchange.request, exchange.summary, replay], nextCursor: "cursor-1" },
      { messages: fixture.messages.slice(0, 2) },
    ]
    const providerHistory = structuredClone([exchange.request, exchange.summary, replay])

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toContain("historical text omitted")
    expect((fixture.messages.at(-1)?.parts[0] as { text: string }).text).toBe(overflowText)
    expect(mock.messageLimits).toEqual([10_000])
    expect(mock.messageCursors).toEqual([undefined])
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
      { summary: true, parentID: "002", mode: "compaction", agent: "compaction" },
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
      { summary: true, parentID: "002", mode: "compaction", agent: "compaction" },
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
      textPart("002", sessionID, overflowText, true),
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
      { summary: true, parentID: "003", mode: "compaction", agent: "compaction" },
    )
    const replay = storedMessage("005", sessionID, "user", [
      {
        id: "005-media-text",
        sessionID,
        messageID: "005",
        type: "text",
        text: `[Attached ${mime}: ${filename}]`,
      },
      textPart("005", sessionID, overflowText, true),
    ])
    fixture.messages.push(request, summary, replay)
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone([request, summary, replay])

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toBe(`[Attached ${mime}: ${filename}]`)
    expect((providerHistory.at(-1)?.parts[1] as { text: string }).text).toContain("historical text omitted")
    expect((fixture.messages.at(-1)?.parts[1] as { text: string }).text).toBe(overflowText)
  })

  test("uses durable page order instead of caller-controlled Message ID order for overflow proof", async () => {
    const sessionID = "overflow-nonmonotonic-ids"
    const overflowText = "H" + "x".repeat(1_000) + "T"
    const older = user("msg_e_older", sessionID, "older context")
    const original = user("msg_a_newest", sessionID, overflowText)
    const request = storedMessage("msg_c_parent", sessionID, "user", [
      { id: "parent-part", sessionID, messageID: "msg_c_parent", type: "compaction", auto: true, overflow: true },
    ])
    const fixture = { messages: [older, original], todos: [] }
    const summary = storedMessage(
      "msg_b_summary",
      sessionID,
      "assistant",
      [textPart("msg_b_summary", sessionID, summaryFor(expectedLedger(fixture)))],
      { summary: true, parentID: request.info.id, mode: "compaction", agent: "compaction" },
    )
    const replay = user("msg_z_replay", sessionID, overflowText)
    fixture.messages.push(request, summary, replay)
    const providerHistory = structuredClone([request, summary, replay])
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    expect((providerHistory.at(-1)?.parts[0] as { text: string }).text).toContain("historical text omitted")
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

  test("does not infer a Session when any provider-history identity is empty", async () => {
    const sessionID = "mixed-empty"
    const fixture = { messages: [user("first", sessionID, "first")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const providerHistory = [user("valid", sessionID, "x".repeat(1_000)), user("invalid", "", "y".repeat(1_000))]
    const before = structuredClone(providerHistory)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))
    expect(providerHistory).toEqual(before)
  })

  test("warns and leaves history unchanged for duplicate model-visible Message identities", async () => {
    const sessionID = "duplicate-provider"
    const hooks = await server(pluginInput(state()), TEST_OPTIONS)
    const providerHistory = [user("same", sessionID, "first"), user("same", sessionID, "second")]
    const before = structuredClone(providerHistory)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    expect(providerHistory).toEqual(before)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.chat.messages.transform",
      sessionID,
      error: "Error",
    })
    warn.mockRestore()
  })
})

describe("real hook compaction flows", () => {
  test("manual compaction installs the model-led single-response prompt", async () => {
    const sessionID = "manual"
    const fixture = { messages: [user("manual-user", sessionID, "Must finish the manual request")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    const output = await compact(hooks, sessionID)
    const ledger = expectedLedger(fixture)

    expect(output.prompt).toStartWith("Compact the bounded recovery ledger below")
    expect(output.prompt).toContain("Choose Goal from the substantive recent_requests")
    for (const section of REQUIRED_SECTIONS) expect(output.prompt).toContain(`## ${section}`)
    expect(output.prompt).toEndWith(ledger.block)
    expect(mock.messageLimits).toEqual([10_000])
  })

  test("compacts with the no-ID todo shape returned by the V1 session API", async () => {
    const sessionID = "v1-todo-without-id"
    const fixture: SessionFixture = {
      messages: [user("request", sessionID, "Continue from the runtime todo list")],
      todos: [{ content: "Preserve this pending action", status: "pending", priority: "high" }],
    }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    const output = await compact(hooks, sessionID)
    const ledger = expectedLedger(fixture)

    expect(output.prompt).toEndWith(ledger.block)
    expect(ledger.data.todos).toEqual([
      {
        id: `todo-${sha256("Preserve this pending action").slice(0, 16)}`,
        content: "Preserve this pending action",
        status: "pending",
        priority: "high",
      },
    ])
    expect(mock.metadataRequests).toEqual([`messages:${sessionID}`, `todos:${sessionID}`])
  })

  test("chains the newest plugin-valid ledger beyond the bounded recent-history page", async () => {
    const sessionID = "paged-prior"
    const priorLedger = buildRecoveryLedger({
      messages: [user("001", sessionID, "Preserve the old durable requirement")],
      todos: [],
      tailTurns: Number(TEST_OPTIONS.tail_turns),
      maxBytes: Number(TEST_OPTIONS.max_ledger_bytes),
    })
    const prior = compactionExchange(sessionID, summaryFor(priorLedger), { suffix: "-old" })
    const recent = user("zzz", sessionID, "Continue the newest request")
    const fixture: SessionFixture = {
      messages: [recent],
      todos: [],
      pages: [
        { messages: [recent], nextCursor: "cursor-1" },
        { messages: [prior.request, prior.summary] },
      ],
    }
    const mock = state([sessionID, fixture])
    const output = await compact(await server(pluginInput(mock), TEST_OPTIONS), sessionID)
    const ledger = parsePluginLedger(output.prompt ?? "")

    expect(ledger?.data.recent_requests).toEqual([
      "Preserve the old durable requirement",
      "Continue the newest request",
    ])
    expect(ledger?.data.legacy_context[0]).toContain("Trusted plugin summary")
    expect(mock.messageLimits).toEqual([10_000, 256])
    expect(mock.messageCursors).toEqual([undefined, "cursor-1"])
    expect(mock.targetRequests).not.toContain(`${sessionID}:${prior.request.info.id}`)
  })

  test("chains a valid summary split from its parent at the first page boundary", async () => {
    const sessionID = "split-prior"
    const priorLedger = buildRecoveryLedger({
      messages: [user("001", sessionID, "OLD FACT")],
      todos: [],
      tailTurns: Number(TEST_OPTIONS.tail_turns),
      maxBytes: Number(TEST_OPTIONS.max_ledger_bytes),
    })
    const prior = compactionExchange(sessionID, summaryFor(priorLedger), { suffix: "-old" })
    const recent = user("zzz", sessionID, "NEW FACT")
    const fixture: SessionFixture = {
      messages: [prior.summary, recent],
      todos: [],
      pages: [
        { messages: [prior.summary, recent], nextCursor: "cursor-1" },
        { messages: [prior.request] },
      ],
    }
    const mock = state([sessionID, fixture])
    const output = await compact(await server(pluginInput(mock), TEST_OPTIONS), sessionID)

    expect(parsePluginLedger(output.prompt ?? "")?.data.recent_requests).toEqual(["OLD FACT", "NEW FACT"])
    expect(mock.messageLimits).toEqual([10_000])
    expect(mock.targetRequests).toContain(`${sessionID}:${prior.request.info.id}`)
  })

  test("skips missing prior parents and degrades to native compaction on parent lookup failures", async () => {
    const sessionID = "parent-status"
    const priorLedger = buildRecoveryLedger({
      messages: [user("001", sessionID, "unreachable old fact")],
      todos: [],
      tailTurns: Number(TEST_OPTIONS.tail_turns),
      maxBytes: Number(TEST_OPTIONS.max_ledger_bytes),
    })
    const prior = compactionExchange(sessionID, summaryFor(priorLedger), { suffix: "-missing" })
    const recent = user("zzz", sessionID, "Current fact")
    const fixture = { messages: [prior.summary, recent], todos: [] }
    const missing = state([sessionID, fixture])
    const missingOutput = await compact(await server(pluginInput(missing), TEST_OPTIONS), sessionID)
    expect(parsePluginLedger(missingOutput.prompt ?? "")?.data.recent_requests).toEqual(["Current fact"])

    const failed = state([sessionID, fixture])
    failed.targetStatuses.set(`${sessionID}:${prior.request.info.id}`, 500)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const failedOutput = await compact(await server(pluginInput(failed), TEST_OPTIONS), sessionID)
    expect(failedOutput.prompt).toBeUndefined()
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.session.compacting",
      sessionID,
      error: "Error",
    })
    warn.mockRestore()
  })

  test("degrades to native compaction for a repeated older-ledger cursor", async () => {
    const sessionID = "repeated-cursor"
    const recent = user("zzz", sessionID, "Current request")
    const fixture: SessionFixture = {
      messages: [recent],
      todos: [],
      pages: [
        { messages: [recent], nextCursor: "repeat" },
        { messages: [user("older", sessionID, "Older request")], nextCursor: "repeat" },
      ],
      pageByCursor: { repeat: 1 },
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    expect((await compact(hooks, sessionID)).prompt).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  test("degrades to native compaction for overlapping or duplicate message pages", async () => {
    const sessionID = "overlapping-pages"
    const recent = user("msg-recent", sessionID, "Current request")
    const fixture: SessionFixture = {
      messages: [recent],
      todos: [],
      pages: [
        { messages: [recent], nextCursor: "cursor-1" },
        { messages: [recent] },
      ],
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    expect((await compact(await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS), sessionID)).prompt)
      .toBeUndefined()

    const duplicate: SessionFixture = {
      messages: [recent],
      todos: [],
      pages: [{ messages: [recent, recent] }],
    }
    expect((await compact(await server(pluginInput(state([sessionID, duplicate])), TEST_OPTIONS), sessionID)).prompt)
      .toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  test("bounds older-ledger discovery across fresh cursors and identities", async () => {
    const sessionID = "bounded-pages"
    const pages = Array.from({ length: 256 }, (_, index) => ({
      messages: [user(`msg-page-${index}`, sessionID, `request ${index}`)],
      nextCursor: `cursor-${index + 1}`,
    }))
    const fixture: SessionFixture = { messages: pages[0]!.messages, todos: [], pages }
    const mock = state([sessionID, fixture])

    expect((await compact(await server(pluginInput(mock), TEST_OPTIONS), sessionID)).prompt).toContain("## Goal")
    expect(mock.messageLimits).toHaveLength(256)
    expect(mock.messageCursors.at(-1)).toBe("cursor-255")
  })

  test("accepts a structurally valid model-authored summary with the current ledger", async () => {
    const sessionID = "valid"
    const fixture = { messages: [user("valid-user", sessionID, "Must retain this request")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const ledger = expectedLedger(fixture, exchange.summary.info.id)
    const original = summaryFor(ledger, "The active request remains in progress")

    expect(await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, original, exchange.summary)).toBe(original)
    expect(isPluginValidSummary(original, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("accepts model JSON and renders a durable validated projection", async () => {
    const sessionID = "valid-json"
    const requestText = "Must retain this JSON projection request"
    const fixture = { messages: [user("valid-json-user", sessionID, requestText)], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const ledger = expectedLedger(fixture, exchange.summary.info.id)
    const ref = (section: keyof RecoveryLedgerData, value: unknown) => [ledgerReferenceID(section, value)]
    const candidate = {
      version: 1,
      goal: { text: requestText, ledger_refs: ref("recent_requests", requestText) },
      constraints: [],
      decisions: [],
      current_state: [],
      files: [],
      evidence: [],
      blockers: [],
      next_actions: [],
      ledger_sha256: ledger.digest,
    }
    const output = await completeOutput(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, JSON.stringify(candidate), exchange.summary)
    expect(output.retry).toBeUndefined()
    expect(parseProjectedSummary(output.text, ledger)?.goal.text).toBe(requestText)
    expect(output.text).toContain("opencode-safe-compaction projection v1 start")
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("keeps the legacy Markdown contract under response_mode=markdown", async () => {
    const sessionID = "markdown-mode"
    const requestText = "Retain this legacy markdown request"
    const fixture = { messages: [user("markdown-user", sessionID, requestText)], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), { ...TEST_OPTIONS, response_mode: "markdown" })
    const prompt = await compact(hooks, sessionID)

    expect(prompt.prompt).toContain("exact Markdown contract")
    expect(prompt.prompt).not.toContain("Required JSON shape")

    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const ledger = expectedLedger(fixture, exchange.summary.info.id)
    const legacy = buildFallback({ ledger, maxBytes: Number(TEST_OPTIONS.max_summary_bytes) })
    const accepted = await completeOutput(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, legacy, exchange.summary)
    expect(accepted.retry).toBeUndefined()
    expect(accepted.text).toBe(legacy.trimEnd())
    expect(await autocontinue(hooks, sessionID)).toBe(true)
  })

  test("rejects JSON candidates under response_mode=markdown and falls back deterministically", async () => {
    const sessionID = "markdown-mode-json-reject"
    const requestText = "A JSON candidate must not win in markdown mode"
    const fixture = { messages: [user("markdown-json-user", sessionID, requestText)], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), { ...TEST_OPTIONS, response_mode: "markdown" })
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const ledger = expectedLedger(fixture, exchange.summary.info.id)
    const ref = (section: keyof RecoveryLedgerData, value: unknown) => [ledgerReferenceID(section, value)]
    const candidate = JSON.stringify({
      version: 1,
      goal: { text: requestText, ledger_refs: ref("recent_requests", requestText) },
      constraints: [],
      decisions: [],
      current_state: [],
      files: [],
      evidence: [],
      blockers: [],
      next_actions: [],
      ledger_sha256: ledger.digest,
    })
    const output = await completeOutput(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, candidate, exchange.summary)
    expect(output.retry).toBe(true)
    expect(isAuthoritativeSummary(output.text, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
    expect(parseProjectedSummary(output.text, ledger)).toBeUndefined()
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
      const fallbackOutput = await completeOutput(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, providerText, exchange.summary)
      const fallback = fallbackOutput.text

      expect(fallback).not.toContain(providerText)
      expect(isPluginValidSummary(fallback, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
      expect(isAuthoritativeSummary(fallback, Number(TEST_OPTIONS.max_summary_bytes))).toBe(true)
      expect(fallbackOutput.retry).toBe(true)
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

    expect(first).toBe(providerFirstPart)
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
    expect(injected.text).toContain("untrusted provider prose is omitted")
    expect(injected.text).not.toContain("Legacy summary claim")
    expect(injected.text).toContain("Untrusted legacy summary legacy omitted")
    expect(injected.text).not.toContain("EmptySummary")
    expect(fixture.messages.find((message) => message.info.id === "zzz-new")?.parts).toHaveLength(1)
  })

  test("reinjects recovery into each fresh provider clone across a tool loop", async () => {
    const sessionID = "recovery-tool-loop"
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const recoveryUser = user("z-recovery-user", sessionID, "Continue the interrupted work")
    const fixture = {
      messages: [user("001-old", sessionID, "Preserve the original request"), exchange.request, exchange.summary, recoveryUser],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const firstProviderHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(firstProviderHistory))
    expect(firstProviderHistory.find((message) => message.info.id === recoveryUser.info.id)?.parts).toHaveLength(2)

    fixture.messages.push(
      storedMessage(
        "zz-tool-assistant",
        sessionID,
        "assistant",
        [{ id: "tool", sessionID, messageID: "zz-tool-assistant", type: "tool", tool: "read", state: { status: "completed", output: "ok" } }],
        { parentID: recoveryUser.info.id, finish: "tool-calls" },
      ),
    )
    const secondProviderHistory = structuredClone(fixture.messages)
    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(secondProviderHistory))

    const reinjected = secondProviderHistory.find((message) => message.info.id === recoveryUser.info.id)?.parts.at(-1) as { text: string }
    expect(reinjected.text).toContain("Safe-compaction recovery context")
    expect(fixture.messages.find((message) => message.info.id === recoveryUser.info.id)?.parts).toHaveLength(1)
  })

  test("does not repeat consumed recovery on a later user turn", async () => {
    const sessionID = "recovery-consumed"
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const recoveryUser = user("z-recovery-user", sessionID, "Recover once")
    const completed = storedMessage(
      "zz-completed",
      sessionID,
      "assistant",
      [textPart("zz-completed", sessionID, "Recovery completed")],
      { parentID: recoveryUser.info.id, finish: "stop" },
    )
    const laterText = `L${"x".repeat(200)}R`
    const laterUser = user("zzz-later-user", sessionID, laterText)
    const fixture = {
      messages: [user("001-old", sessionID, "Original context"), exchange.request, exchange.summary, recoveryUser],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(structuredClone(fixture.messages)))
    await hooks.event?.({
      event: { type: "session.idle", properties: { sessionID } } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
    })
    fixture.messages.push(completed, laterUser)
    const laterProviderHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(laterProviderHistory))

    const providerUser = laterProviderHistory.find((message) => message.info.id === laterUser.info.id)
    expect(providerUser?.parts).toHaveLength(1)
    expect((providerUser?.parts[0] as { text: string }).text).toBe(laterText)
  })

  test("conservatively reinjects recovery after restart without durable provenance", async () => {
    const sessionID = "recovery-consumed-restart"
    const exchange = compactionExchange(sessionID, "", { error: { name: "EmptySummary" } })
    const recoveryUser = user("z-recovery-user", sessionID, "Recover once")
    const completed = storedMessage(
      "zz-completed",
      sessionID,
      "assistant",
      [textPart("zz-completed", sessionID, "Recovery completed")],
      { parentID: recoveryUser.info.id, finish: "stop" },
    )
    const laterUser = user("zzz-later-user", sessionID, "Continue with unrelated work")
    const fixture = {
      messages: [user("001-old", sessionID, "Original context"), exchange.request, exchange.summary, recoveryUser, completed, laterUser],
      todos: [],
    }
    const restarted = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone(fixture.messages)

    await restarted["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    const recovered = providerHistory.find((message) => message.info.id === laterUser.info.id)?.parts
    expect(recovered).toHaveLength(2)
    expect((recovered?.at(-1) as { text: string }).text).toContain("recovery-ledger")
  })

  test("recovers a nonempty unterminated compaction after plugin restart", async () => {
    const sessionID = "partial-restart"
    const exchange = compactionExchange(sessionID, "## Goal\n- partial provider text")
    exchange.summary.info.finish = "stop"
    const newest = user("zzz-new", sessionID, "Resume after restart")
    const fixture = {
      messages: [user("001-old", sessionID, "Must survive the partial summary"), exchange.request, exchange.summary, newest],
      todos: [],
    }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    const providerHistory = structuredClone(fixture.messages)

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    const injected = providerHistory.find((message) => message.info.id === newest.info.id)?.parts.at(-1) as { text: string }
    expect(injected.text).toContain("Must survive the partial summary")
    expect(injected.text).toContain("No provider-authored compaction prose is trusted")
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
      { summary: true, parentID: "003", mode: "compaction", agent: "compaction", error: { name: "EmptySummary" } },
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

  test("uses durable creation time for reordered retained-tail history", async () => {
    const sessionID = "recovery-reordered-tail"
    const olderRequest = storedMessage("020", sessionID, "user", [
      { id: "020-part", sessionID, messageID: "020", type: "compaction" },
    ])
    const olderSummary = storedMessage(
      "021",
      sessionID,
      "assistant",
      [textPart("021", sessionID, "Older retained legacy summary")],
      { summary: true, parentID: "020", mode: "compaction", agent: "compaction" },
    )
    const currentRequest = storedMessage("100", sessionID, "user", [
      { id: "100-part", sessionID, messageID: "100", type: "compaction" },
    ])
    const currentSummary = storedMessage(
      "101",
      sessionID,
      "assistant",
      [textPart("101", sessionID, "")],
      { summary: true, parentID: "100", mode: "compaction", agent: "compaction", error: { name: "EmptySummary" } },
    )
    const newest = user("102", sessionID, "Resume from the current failure")
    const fixture = {
      messages: [user("010", sessionID, "retained old request"), olderRequest, olderSummary, currentRequest, currentSummary, newest],
      todos: [],
    }
    fixture.messages.forEach((message, index) => {
      message.info.time = { created: index }
    })
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

  test("never promotes prior provider prose into the recovery instruction", async () => {
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
    const instruction = injected.text.slice(0, injected.text.indexOf("<!-- opencode-safe-compaction"))
    expect(instruction).toContain("No provider-authored compaction prose is trusted")
    expect(instruction).not.toContain("TRUSTED-PRIOR-STATE")
    expect(instruction).not.toContain("UNTRUSTED-LEGACY-ANCHOR")
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

  test.each([
    ["wrong agent", { agent: "build" }],
    ["wrong mode", { mode: "build" }],
  ])("ignores a summary target with %s identity", async (_, identity) => {
    const sessionID = `forged-${identity.agent ?? identity.mode}`
    const fixture = { messages: [user("request", sessionID, "Request")], todos: [] }
    const exchange = compactionExchange(sessionID, "")
    Object.assign(exchange.summary.info, identity)
    fixture.messages.push(exchange.request, exchange.summary)
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, "provider text")).toBe("provider text")
  })

  test("ignores a compaction summary whose parent has no matching compaction part", async () => {
    const sessionID = "forged-parent"
    const exchange = compactionExchange(sessionID, "")
    exchange.request.parts = [textPart(exchange.request.info.id, sessionID, "ordinary parent")]
    const fixture = { messages: [exchange.request, exchange.summary], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await complete(hooks, sessionID, exchange.summary.info.id, exchange.partIDs[0]!, "provider text")).toBe("provider text")
  })

  test("binds auto-continuation to the compaction parent supplied by core", async () => {
    const sessionID = "autocontinue-parent"
    const first = compactionExchange(sessionID, "malformed", { suffix: "-first" })
    const second = compactionExchange(sessionID, "", { suffix: "-second" })
    const fixture = {
      messages: [user("001", sessionID, "Original request"), first.request, first.summary, second.request, second.summary],
      todos: [],
    }
    ;(second.summary.parts[0] as { text: string }).text = buildAuthoritativeSummary({
      ledger: expectedLedger(fixture, second.summary.info.id),
      maxBytes: Number(TEST_OPTIONS.max_summary_bytes),
    })
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await autocontinue(hooks, sessionID, true, first.request.info.id)).toBe(false)
    expect(await autocontinue(hooks, sessionID, true, second.request.info.id)).toBe(true)
  })

  test("recovers a validated compaction from durable history after plugin restart", async () => {
    const sessionID = "restart"
    const fixture = { messages: [user("request", sessionID, "Restart-safe fact")], todos: [] }
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    ;(exchange.summary.parts[0] as { text: string }).text = buildAuthoritativeSummary({
      ledger: expectedLedger(fixture, exchange.summary.info.id),
      maxBytes: Number(TEST_OPTIONS.max_summary_bytes),
    })
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)

    expect(await autocontinue(hooks, sessionID, true, exchange.request.info.id)).toBe(true)
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
    expect(await autocontinue(hooks, sessionID, true, first.request.info.id)).toBe(true)

    fixture.messages.shift()
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
    const chained = parsePluginLedger(secondFallback)?.data
    expect(chained?.legacy_context[0]).toContain("Trusted plugin summary")
    expect(chained?.recent_requests).toContain("First durable request")
    expect(chained?.recent_requests).toContain("Second durable request")
    expect(await autocontinue(restarted, sessionID, true, second.request.info.id)).toBe(true)
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

  test("does not clear other Session attempts for an unscoped error event", async () => {
    const firstID = "unscoped-a"
    const secondID = "unscoped-b"
    const firstFixture = { messages: [user("a-user", firstID, "First session fact")], todos: [] }
    const secondFixture = { messages: [user("b-user", secondID, "Second session fact")], todos: [] }
    const hooks = await server(pluginInput(state([firstID, firstFixture], [secondID, secondFixture])), TEST_OPTIONS)
    await Promise.all([compact(hooks, firstID), compact(hooks, secondID)])
    await hooks.event?.({
      event: { type: "session.error", properties: { error: "unscoped" } } as unknown as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
    })
    const firstProviderHistory = [user("a-provider", firstID, "a".repeat(1_000))]
    const secondProviderHistory = [user("b-provider", secondID, "b".repeat(1_000))]

    await Promise.all([
      hooks["experimental.chat.messages.transform"]?.({}, transformOutput(firstProviderHistory)),
      hooks["experimental.chat.messages.transform"]?.({}, transformOutput(secondProviderHistory)),
    ])

    expect((firstProviderHistory[0]?.parts[0] as { text: string }).text).toContain("historical text omitted")
    expect((secondProviderHistory[0]?.parts[0] as { text: string }).text).toContain("historical text omitted")
  })

  test("falls back to native compaction and logs metadata only when ledger input fails", async () => {
    const sessionID = "todo-api-failure"
    const secret = "PRIVATE-TODO-ERROR-SENTINEL"
    const secretName = "PRIVATE-TODO-ERROR-NAME"
    const fixture = { messages: [user("request", sessionID, "Do not log this request")], todos: [] }
    const mock = state([sessionID, fixture])
    mock.todoError = new Error(secret)
    mock.todoError.name = secretName
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const output = await compact(await server(pluginInput(mock), TEST_OPTIONS), sessionID)

    expect(output.prompt).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.session.compacting",
      sessionID,
      error: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secretName)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Do not log this request")
    warn.mockRestore()
  })

  test("leaves provider history unchanged when sanitization fails internally", async () => {
    const sessionID = "sanitize-failure"
    const fixture = { messages: [user("request", sessionID, "Retain the durable request")], todos: [] }
    const hooks = await server(pluginInput(state([sessionID, fixture])), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const providerHistory = [storedMessage("malformed", sessionID, "assistant", [
      textPart("malformed", sessionID, "x".repeat(1_000)),
      {
        id: "bad-tool",
        sessionID,
        messageID: "malformed",
        type: "tool",
        callID: "bad-call",
        tool: "shell",
        state: { status: "error", input: {}, error: undefined, time: { start: 1, end: 2 } },
      },
    ])]
    const before = structuredClone(providerHistory)
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    await hooks["experimental.chat.messages.transform"]?.({}, transformOutput(providerHistory))

    expect(providerHistory).toEqual(before)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.chat.messages.transform",
      sessionID,
      error: "TypeError",
    })
    warn.mockRestore()
  })

  test("preserves provider text but suppresses continuation when completion handling fails", async () => {
    const sessionID = "completion-failure"
    const secret = "PRIVATE-COMPLETION-ERROR-SENTINEL"
    const fixture = { messages: [user("request", sessionID, "Retain completion state")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    const exchange = compactionExchange(sessionID, "")
    fixture.messages.push(exchange.request, exchange.summary)
    const providerText = buildAuthoritativeSummary({
      ledger: expectedLedger(fixture, exchange.summary.info.id),
      maxBytes: Number(TEST_OPTIONS.max_summary_bytes),
    })
    ;(exchange.summary.parts[0] as { text: string }).text = providerText
    mock.targetError = new Error(secret)
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const output = { text: providerText }

    await hooks["experimental.text.complete"]?.({
      sessionID,
      messageID: exchange.summary.info.id,
      partID: exchange.partIDs[0]!,
    }, output)
    mock.targetError = undefined

    expect(output.text).toBe(providerText)
    expect(await autocontinue(hooks, sessionID)).toBe(false)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.text.complete",
      sessionID,
      error: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
    warn.mockRestore()
  })

  test("fails auto-continuation closed when durable revalidation fails internally", async () => {
    const sessionID = "autocontinue-failure"
    const fixture = { messages: [user("request", sessionID, "Retain fail-closed state")], todos: [] }
    const mock = state([sessionID, fixture])
    const hooks = await server(pluginInput(mock), TEST_OPTIONS)
    await compact(hooks, sessionID)
    mock.messagesError = new Error("PRIVATE-AUTOCONTINUE-ERROR-SENTINEL")
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    expect(await autocontinue(hooks, sessionID)).toBe(false)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      hook: "experimental.compaction.autocontinue",
      sessionID,
      error: "Error",
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE-AUTOCONTINUE-ERROR-SENTINEL")
    warn.mockRestore()
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
