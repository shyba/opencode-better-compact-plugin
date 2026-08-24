import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import { resolveOptions, parseOptions } from "../src/options.js"
import {
  isCatAttachment,
  catFilesFromMessages,
  loadPiOptions,
  priorPluginSummary,
  savePiOptions,
  toMessageRecords,
  todosFromBranch,
} from "../src/pi-adapter.js"
import { buildAuthoritativeSummary } from "../src/validation.js"
import { PINNED_START, saveFixedPin, formatInjection } from "../src/cat-core.js"
import { SEMANTIC_START, SemanticStore, repositoryIdentity } from "../src/semantic.js"
import { ledgerReferenceID } from "../src/projection.js"
import { parsePluginLedger } from "../src/validation.js"
import packageJSON from "../package.json"
import piExtension from "../src/pi.js"
import catExtension from "../src/cat.js"

const EMPTY_DATA: RecoveryLedgerData = {
  recent_requests: [],
  constraints: [],
  todos: [],
  touched_paths: [],
  tool_statuses: [],
  errors: [],
  evidence: [],
  next_actions: [],
  legacy_context: [],
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 }
}

function assistantMessage(content: unknown[]): AgentMessage {
  return {
    role: "assistant",
    content: content as AgentMessage & { content: unknown },
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  } as unknown as AgentMessage
}

function toolResultMessage(toolCallId: string, toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details: {},
    isError,
    timestamp: 1,
  } as unknown as AgentMessage
}

function branchMessage(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message } as SessionEntry
}

describe("isCatAttachment", () => {
  test("detects the injection marker in user messages", () => {
    expect(isCatAttachment(userMessage("<!-- cat-files v1 -->\n<file:a.rs>\nx\n</file>"))).toBe(true)
    expect(isCatAttachment(userMessage("plain question"))).toBe(false)
  })

  test("detects the marker in content-array user messages", () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "<!-- cat-files v1 -->\n<file:a.rs>\nx\n</file>" }],
      timestamp: 1,
    }
    expect(isCatAttachment(message)).toBe(true)
  })

  test("ignores non-attachment roles", () => {
    expect(isCatAttachment({ role: "assistant", content: [], timestamp: 1 })).toBe(false)
    expect(isCatAttachment({ role: "bashExecution", command: "cat a.rs", output: "", timestamp: 1 })).toBe(false)
    expect(isCatAttachment({ role: "toolResult", toolCallId: "t1", toolName: "read", content: [], timestamp: 1 })).toBe(false)
  })

  test("detects the marker in summary messages", () => {
    expect(isCatAttachment({ role: "compactionSummary", summary: "<!-- cat-files v1 -->", tokensBefore: 10, timestamp: 1 })).toBe(true)
    expect(isCatAttachment({ role: "branchSummary", summary: "no marker", tokensBefore: 10, timestamp: 1 })).toBe(false)
  })
})

describe("catFilesFromMessages", () => {
  test("recovers the newest exact /cat payload for each path", () => {
    const first = formatInjection([{ path: "src/a.rs", bytes: 3, tokens: 1, text: "old" }])
    const second = formatInjection([
      { path: "src/a.rs", bytes: 3, tokens: 1, text: "new" },
      { path: "src/b.rs", bytes: 4, tokens: 1, text: "more" },
    ])
    expect(catFilesFromMessages([userMessage(first), userMessage(second)])).toEqual([
      { path: "src/a.rs", bytes: 3, tokens: 1, text: "new" },
      { path: "src/b.rs", bytes: 4, tokens: 1, text: "more" },
    ])
  })
})

describe("toMessageRecords", () => {
  test("maps plain user and assistant text", () => {
    const records = toMessageRecords([userMessage("hello"), assistantMessage([{ type: "text", text: "hi back" }])], "s1")
    expect(records).toHaveLength(2)
    expect(records[0]!.info).toEqual({ id: "s1-pi-1", sessionID: "s1", role: "user" })
    expect(records[0]!.parts).toEqual([{ id: "s1-pi-1-p0", sessionID: "s1", messageID: "s1-pi-1", type: "text", text: "hello" }])
    expect(records[1]!.info.role).toBe("assistant")
    expect(records[1]!.parts).toEqual([{ id: "s1-pi-2-p0", sessionID: "s1", messageID: "s1-pi-2", type: "text", text: "hi back" }])
  })

  test("converts thinking blocks to reasoning parts", () => {
    const records = toMessageRecords(
      [assistantMessage([{ type: "thinking", thinking: "deep thoughts" }])],
      "s1",
    )
    expect(records[0]!.parts).toEqual([
      { id: "s1-pi-1-p0", sessionID: "s1", messageID: "s1-pi-1", type: "reasoning", text: "deep thoughts" },
    ])
  })

  test("folds a tool call and its result into the assistant message", () => {
    const messages = [
      userMessage("write a file"),
      assistantMessage([
        { type: "text", text: "sure" },
        { type: "toolCall", id: "call-1", name: "write", arguments: { path: "src/a.ts", content: "x" } },
      ]),
      toolResultMessage("call-1", "write", "wrote src/a.ts"),
      assistantMessage([{ type: "text", text: "done" }]),
    ]
    const records = toMessageRecords(messages, "s1")
    expect(records).toHaveLength(3)
    const assistant = records[1]!
    expect(assistant.info.role).toBe("assistant")
    expect(assistant.parts).toHaveLength(2)
    const tool = assistant.parts[1] as Record<string, unknown>
    expect(tool.type).toBe("tool")
    expect(tool.tool).toBe("write")
    const state = tool.state as Record<string, unknown>
    expect(state.status).toBe("completed")
    expect(state.input).toEqual({ path: "src/a.ts", content: "x" })
    expect(state.output).toBe("wrote src/a.ts")
    // The toolResult must not be emitted as a standalone record.
    expect(records[2]!.parts).toHaveLength(1)
  })

  test("marks error tool results as error with error text", () => {
    const messages = [
      assistantMessage([{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "false" } }]),
      toolResultMessage("call-2", "bash", "command failed: exit code 1", true),
    ]
    const records = toMessageRecords(messages, "s1")
    const tool = records[0]!.parts[0] as Record<string, unknown>
    const state = tool.state as Record<string, unknown>
    expect(state.status).toBe("error")
    expect(state.error).toBe("command failed: exit code 1")
  })

  test("emits a standalone record for an unmatched tool result", () => {
    const records = toMessageRecords([toolResultMessage("call-3", "read", "file content")], "s1")
    expect(records).toHaveLength(1)
    const tool = records[0]!.parts[0] as Record<string, unknown>
    expect(tool.type).toBe("tool")
    expect((tool.state as Record<string, unknown>).status).toBe("completed")
    expect((tool.state as Record<string, unknown>).output).toBe("file content")
  })

  test("maps compaction and branch summaries to summary assistant messages", () => {
    const records = toMessageRecords(
      [
        { role: "compactionSummary", summary: "old summary", tokensBefore: 100, timestamp: 1 },
        { role: "branchSummary", summary: "branch summary", fromId: "x", timestamp: 1 },
      ] as unknown as AgentMessage[],
      "s1",
    )
    expect(records[0]!.info.summary).toBe(true)
    expect((records[0]!.parts[0] as Record<string, unknown>).text).toBe("old summary")
    expect(records[1]!.info.summary).toBe(true)
  })

  test("drops bash executions excluded from context and keeps included ones", () => {
    const excluded = { role: "bashExecution", command: "ls", output: "x", exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 1 }
    const included = { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 }
    const records = toMessageRecords([excluded, included] as unknown as AgentMessage[], "s1")
    expect(records).toHaveLength(1)
    expect(records[0]!.info.role).toBe("user")
    expect((records[0]!.parts[0] as Record<string, unknown>).text).toContain("Ran `echo hi`")
  })

  test("drops hidden custom messages and keeps visible ones", () => {
    const hidden = { role: "custom", customType: "x", content: "hidden", display: false, timestamp: 1 }
    const visible = { role: "custom", customType: "x", content: "visible", display: true, timestamp: 1 }
    const records = toMessageRecords([hidden, visible] as unknown as AgentMessage[], "s1")
    expect(records).toHaveLength(1)
    expect((records[0]!.parts[0] as Record<string, unknown>).text).toBe("visible")
  })

  test("omits image data with a marker instead of leaking base64", () => {
    const records = toMessageRecords(
      [userMessage([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] as unknown as string)],
      "s1",
    )
    expect((records[0]!.parts[0] as Record<string, unknown>).text).toBe("[image attachment omitted from recovery ledger]")
  })
})

describe("todosFromBranch", () => {
  function branchWithTodo(details: unknown): SessionEntry[] {
    return [{
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "1",
      message: { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [], details, isError: false, timestamp: 1 },
    }] as unknown as SessionEntry[]
  }

  test("reads todos from the most recent todo tool result", () => {
    const todos = todosFromBranch(branchWithTodo({
      action: "list",
      todos: [
        { id: 1, text: "first", done: false },
        { id: 2, text: "second", done: true },
      ],
      nextId: 3,
    }))
    expect(todos).toEqual([
      { id: "1", content: "first", status: "pending", priority: "unknown" },
      { id: "2", content: "second", status: "completed", priority: "unknown" },
    ])
  })

  test("returns empty when no todo tool result exists", () => {
    expect(todosFromBranch([{ type: "message", id: "e1", parentId: null, timestamp: "1", message: userMessage("hi") }] as unknown as SessionEntry[])).toEqual([])
  })

  test("returns empty when the result has no todos array", () => {
    expect(todosFromBranch(branchWithTodo({ action: "list" }))).toEqual([])
  })
})

describe("priorPluginSummary", () => {
  function compactionEntry(summary: string): SessionEntry {
    return { type: "compaction", id: "c1", parentId: null, timestamp: "1", summary, firstKeptEntryId: "k1", tokensBefore: 10 } as unknown as SessionEntry
  }

  test("finds a plugin-valid ledger in the newest compaction entry", () => {
    const ledger = canonicalLedger(EMPTY_DATA)
    const summary = buildAuthoritativeSummary({ ledger, maxBytes: 100_000 })
    const found = priorPluginSummary([compactionEntry("## Goal\n- old\n\n" + ledger.block), compactionEntry(summary)])
    expect(found).toBeDefined()
    expect(found!.id).toBe("c1")
    expect(found!.ledger.digest).toBe(ledger.digest)
  })

  test("returns undefined when no compaction entry carries a valid ledger", () => {
    expect(priorPluginSummary([compactionEntry("some plain summary")])).toBeUndefined()
  })
})

describe("pi option persistence", () => {
  test("round-trips persisted options through save and load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      const resolved = resolveOptions(parseOptions({ model: "test/compactor", tail_turns: 6, vcc_mode: "off" }))
      await savePiOptions(dir, resolved)
      const loaded = resolveOptions(parseOptions(loadPiOptions(dir)))
      expect(loaded.model).toBe("test/compactor")
      expect(loaded.vcc_mode).toBe("off")
      expect(loaded.tail_turns).toBe(6)
      expect(loaded.max_ledger_bytes).toBe(resolved.max_ledger_bytes)
      const raw = await readFile(path.join(dir, ".pi", "safe-compaction.json"), "utf8")
      expect(raw).not.toContain("preserve_recent_tokens")
      expect(raw).not.toContain("reserved_tokens")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.each(["off", "hybrid", "offline"] as const)("atomically round-trips vcc_mode=%s with unrelated settings and mode 0600", async (vcc_mode) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-mode-roundtrip-"))
    try {
      const options = resolveOptions(parseOptions({
        model: "test/compactor",
        vcc_mode,
        response_mode: "json",
        max_output_tokens: 321,
        max_user_text_bytes: 12_345,
      }))
      await savePiOptions(dir, options)
      const loaded = resolveOptions(parseOptions(loadPiOptions(dir)))
      expect(loaded).toMatchObject({
        model: "test/compactor",
        vcc_mode,
        response_mode: "json",
        max_output_tokens: 321,
        max_user_text_bytes: 12_345,
      })
      expect((await stat(path.join(dir, ".pi", "safe-compaction.json"))).mode & 0o777).toBe(0o600)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("removes the temporary config when atomic rename fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-rename-failure-"))
    try {
      const configDir = path.join(dir, ".pi")
      await mkdir(path.join(configDir, "safe-compaction.json"), { recursive: true })
      const options = resolveOptions(parseOptions({ model: "test/compactor", vcc_mode: "off" }))
      await expect(savePiOptions(dir, options)).rejects.toThrow()
      expect(await stat(path.join(configDir, "safe-compaction.json"))).toBeDefined()
      await expect(stat(path.join(configDir, `safe-compaction.json.tmp-${process.pid}`))).rejects.toThrow()
      await expect(stat(path.join(configDir, "safe-compaction.json.lock"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("leaves an unknown mode untouched for an older-plugin downgrade instead of silently rewriting it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-downgrade-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      const raw = `${JSON.stringify({ vcc_mode: "future-mode", model: "test/compactor" })}\n`
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), raw, { mode: 0o600 })
      expect(loadPiOptions(dir)).toEqual({})
      expect(await readFile(path.join(dir, ".pi", "safe-compaction.json"), "utf8")).toBe(raw)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("falls back to defaults when the file is corrupt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), "not json")
      expect(loadPiOptions(dir)).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("Pi package integration", () => {
  test("declares both source-first extension entry points", () => {
    const manifest = packageJSON as {
      pi?: { extensions?: unknown }
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    expect(manifest.pi?.extensions).toEqual(["./src/pi.ts", "./src/cat.ts"])
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-agent-core"]?.optional).toBe(true)
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional).toBe(true)
    expect(manifest.peerDependenciesMeta?.["@earendil-works/pi-ai"]?.optional).toBe(true)
  })

  test("registers both real extension entry points without host startup state", () => {
    const events = new Map<string, unknown[]>()
    const commands = new Map<string, unknown>()
    const tools = new Map<string, unknown>()
    const api = {
      on(event: string, handler: unknown) {
        events.set(event, [...(events.get(event) ?? []), handler])
      },
      registerCommand(name: string, options: unknown) {
        commands.set(name, options)
      },
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool)
      },
    } as unknown as ExtensionAPI

    piExtension(api)
    catExtension(api)

    expect(events.get("session_before_compact")).toHaveLength(1)
    expect(events.get("session_before_tree")).toHaveLength(1)
    expect(commands.has("compaction-model")).toBe(true)
    expect(commands.has("cat")).toBe(true)
    expect(tools.has("vcc_recall")).toBe(true)
  })

  test.each(["offline", "hybrid"])("accepts Pi vcc_mode=%s at session start", async (vcc_mode) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-mode-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), `${JSON.stringify({ vcc_mode })}\n`)
      const events = new Map<string, unknown[]>()
      const api = {
        on(event: string, handler: unknown) {
          events.set(event, [...(events.get(event) ?? []), handler])
        },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI
      piExtension(api)
      const start = events.get("session_start")?.[0] as ((event: unknown, context: { cwd: string }) => unknown) | undefined
      expect(start).toBeDefined()
      expect(() => start?.({}, { cwd: dir })).not.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("offline Pi VCC compacts its own branch cut without a provider call", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-offline-"))
    try {
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), JSON.stringify({ vcc_mode: "offline", tail_turns: 1 }))
      const events = new Map<string, unknown[]>()
      const api = {
        on(event: string, handler: unknown) { events.set(event, [...(events.get(event) ?? []), handler]) },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI
      piExtension(api)
      const branch = [
        branchMessage("u-old", null, userMessage("old request")),
        branchMessage("a-old", "u-old", assistantMessage([{ type: "text", text: "old result" }])),
        branchMessage("u-current", "a-old", userMessage("current request")),
        branchMessage("a-current", "u-current", assistantMessage([{ type: "text", text: "current result" }])),
      ]
      let providerCalls = 0
      const ctx = {
        cwd: dir,
        model: undefined,
        sessionManager: { getSessionId: () => "offline-session", getBranch: () => branch },
        modelRegistry: { hasConfiguredAuth: () => { providerCalls++; return true }, complete: async () => { providerCalls++; throw new Error("offline must not call a provider") } },
        getContextUsage: () => ({ tokens: 0, contextWindow: 20_000 }),
      }
      await (events.get("session_start")![0] as (event: unknown, context: unknown) => unknown)({}, ctx)
      const handler = events.get("session_before_compact")![0] as (event: unknown, context: unknown) => Promise<unknown>
      const result = await handler({ preparation: { messagesToSummarize: [], turnPrefixMessages: [], firstKeptEntryId: "host-cut", tokensBefore: 100 }, branchEntries: branch, signal: new AbortController().signal }, ctx)
      expect(providerCalls).toBe(0)
      expect((result as { compaction: { firstKeptEntryId: string } }).compaction.firstKeptEntryId).toBe("u-current")
      expect((result as { compaction: { summary: string } }).compaction.summary).toContain("old request")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("pins fresh files in the real compaction hook without dropping ordinary attachments", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-hook-"))
    try {
      await mkdir(path.join(dir, "src"), { recursive: true })
      await writeFile(path.join(dir, "src", "pinned.rs"), "fn main() {}\n")
      await saveFixedPin(dir, { sessionId: "session-1", patterns: ["src/pinned.rs"], pinnedAt: 1 })

      const events = new Map<string, unknown[]>()
      let prompt = ""
      const api = {
        on(event: string, handler: unknown) {
          events.set(event, [...(events.get(event) ?? []), handler])
        },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI
      piExtension(api)

      const model = {
        provider: "test",
        id: "model",
        api: "openai-completions",
        name: "test",
        baseUrl: "http://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10_000,
        maxTokens: 2_000,
      }
      const ctx = {
        cwd: dir,
        model,
        sessionManager: { getSessionId: () => "session-1", getBranch: () => [] },
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
            prompt = context.messages[0]!.content[0]!.text
            return {
              role: "assistant",
              content: [],
              api: "openai-completions",
              provider: "test",
              model: "model",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: 1,
            }
          },
        },
        getContextUsage: () => ({ tokens: null, contextWindow: 10_000 }),
      }
      const start = events.get("session_start")![0] as (event: unknown, context: unknown) => unknown
      await start({}, ctx)
      const handler = events.get("session_before_compact")![0] as (event: unknown, context: unknown) => Promise<unknown>
      const result = await handler({
        preparation: {
          messagesToSummarize: [userMessage("Inspect the pinned source")],
          turnPrefixMessages: [],
          firstKeptEntryId: "keep",
          tokensBefore: 10,
        },
        signal: new AbortController().signal,
      }, ctx)
      const summary = (result as { compaction: { summary: string } }).compaction.summary
      expect(summary.startsWith(`${PINNED_START}\n`)).toBe(true)
      expect(summary).toContain("fn main() {}")
      expect(prompt).not.toContain("cat-files v1")
      expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(8_000)

      const ordinary = formatInjection([{ path: "src/ordinary.rs", bytes: 1, tokens: 1, text: "fn ordinary() {}" }])
      const ordinaryResult = await handler({
        preparation: {
          messagesToSummarize: [userMessage(ordinary)],
          turnPrefixMessages: [],
          firstKeptEntryId: "keep-2",
          tokensBefore: 10,
        },
        signal: new AbortController().signal,
      }, { ...ctx, sessionManager: { getSessionId: () => "session-without-pin", getBranch: () => [] } })
      expect((ordinaryResult as { compaction: { summary: string } }).compaction.summary).toContain("ordinary.rs")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("persists a semantic /cat checkpoint while keeping only its compact reference inline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-semantic-"))
    const priorState = process.env.BETTER_COMPACT_STATE
    try {
      const stateFile = path.join(dir, "state.sqlite")
      process.env.BETTER_COMPACT_STATE = stateFile
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), JSON.stringify({ semantic_checkpoints: true, max_semantic_source_bytes: 32_768 }))
      const events = new Map<string, unknown[]>()
      const api = {
        on(event: string, handler: unknown) { events.set(event, [...(events.get(event) ?? []), handler]) },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI
      piExtension(api)
      const model = {
        provider: "test", id: "model", api: "openai-completions", name: "test", baseUrl: "http://example.test",
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 4_000,
      }
      const ctx = {
        cwd: dir,
        model,
        sessionManager: { getSessionId: () => "semantic-session", getBranch: () => [] },
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
            const prompt = context.messages[0]!.content[0]!.text
            const ledger = parsePluginLedger(prompt)!
            const request = ledger.data.recent_requests[0]!
            const ref = ledgerReferenceID("recent_requests", request)
            const artifact = prompt.match(/"ref":"(cat:[a-f0-9]+)"/)?.[1]
            expect(artifact).toBeDefined()
            const output = {
              version: 1,
              goal: { text: "Understand the mapper", ledger_refs: [ref] },
              constraints: [], decisions: [], current_state: [], files: [], evidence: [], blockers: [], next_actions: [],
              ledger_sha256: ledger.digest,
              semantic_delta: {
                upserts: [{ id: "sem:mapper-role", kind: "responsibility", title: "Mapper role", summary: "Maps persisted records into API responses.", status: "current", confidence: "high", evidence_refs: [artifact], related_ids: [] }],
                supersede_ids: [], active_ids: ["sem:mapper-role"], nucleus: ["The mapper owns persistence-to-API conversion."],
              },
            }
            return {
              role: "assistant", content: [{ type: "text", text: JSON.stringify(output) }], api: "openai-completions", provider: "test", model: "model",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop", timestamp: 1,
            }
          },
        },
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 20_000 }),
      }
      await (events.get("session_start")![0] as (event: unknown, context: unknown) => unknown)({}, ctx)
      const handler = events.get("session_before_compact")![0] as (event: unknown, context: unknown) => Promise<unknown>
      const source = formatInjection([{ path: "src/Mapper.java", bytes: 36, tokens: 9, text: "class Mapper { Api map(Row row) {} }" }])
      const result = await handler({ preparation: { messagesToSummarize: [userMessage("Understand the mapper"), userMessage(source)], turnPrefixMessages: [], firstKeptEntryId: "keep", tokensBefore: 1_000 }, signal: new AbortController().signal }, ctx)
      const summary = (result as { compaction: { summary: string } }).compaction.summary
      expect(summary).toContain(SEMANTIC_START)
      expect(summary).toContain("The mapper owns persistence-to-API conversion.")
      expect(summary).not.toContain("class Mapper")
      const store = new SemanticStore(stateFile)
      const repository = repositoryIdentity(dir)
      expect(store.context(repository.id)).toContain("sem:mapper-role")
      expect(store.context(repository.id)).toContain("Maps persisted records into API responses.")
      store.close()
    } finally {
      if (priorState === undefined) delete process.env.BETTER_COMPACT_STATE
      else process.env.BETTER_COMPACT_STATE = priorState
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps ordinary compaction valid when the semantic delta is malformed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sc-pi-semantic-invalid-"))
    const priorState = process.env.BETTER_COMPACT_STATE
    try {
      const stateFile = path.join(dir, "state.sqlite")
      process.env.BETTER_COMPACT_STATE = stateFile
      await mkdir(path.join(dir, ".pi"), { recursive: true })
      await writeFile(path.join(dir, ".pi", "safe-compaction.json"), JSON.stringify({ semantic_checkpoints: true }))
      const events = new Map<string, unknown[]>()
      const api = {
        on(event: string, handler: unknown) { events.set(event, [...(events.get(event) ?? []), handler]) },
        registerCommand() {},
        registerTool() {},
      } as unknown as ExtensionAPI
      piExtension(api)
      const model = {
        provider: "test", id: "model", api: "openai-completions", name: "test", baseUrl: "http://example.test",
        reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 4_000,
      }
      const ctx = {
        cwd: dir,
        model,
        sessionManager: { getSessionId: () => "semantic-invalid", getBranch: () => [] },
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
            const ledger = parsePluginLedger(context.messages[0]!.content[0]!.text)!
            const ref = ledgerReferenceID("recent_requests", ledger.data.recent_requests[0]!)
            return {
              role: "assistant", content: [{ type: "text", text: JSON.stringify({
                version: 1,
                goal: { text: "Understand the mapper", ledger_refs: [ref] },
                constraints: [], decisions: [], current_state: [], files: [], evidence: [], blockers: [], next_actions: [],
                ledger_sha256: ledger.digest,
                semantic_delta: { upserts: "not-an-array", supersede_ids: [], active_ids: [], nucleus: [] },
              }) }], api: "openai-completions", provider: "test", model: "model",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop", timestamp: 1,
            }
          },
        },
        getContextUsage: () => ({ tokens: 1_000, contextWindow: 20_000 }),
      }
      await (events.get("session_start")![0] as (event: unknown, context: unknown) => unknown)({}, ctx)
      const handler = events.get("session_before_compact")![0] as (event: unknown, context: unknown) => Promise<unknown>
      const source = formatInjection([{ path: "src/Mapper.java", bytes: 15, tokens: 4, text: "class Mapper {}" }])
      const result = await handler({ preparation: { messagesToSummarize: [userMessage("Understand the mapper"), userMessage(source)], turnPrefixMessages: [], firstKeptEntryId: "keep", tokensBefore: 1_000 }, signal: new AbortController().signal }, ctx)
      const summary = (result as { compaction: { summary: string } }).compaction.summary
      expect(summary).toContain("## Goal\n- Understand the mapper")
      expect(summary).not.toContain(SEMANTIC_START)
      const store = new SemanticStore(stateFile)
      expect(store.latest(repositoryIdentity(dir).id)).toBeUndefined()
      store.close()
    } finally {
      if (priorState === undefined) delete process.env.BETTER_COMPACT_STATE
      else process.env.BETTER_COMPACT_STATE = priorState
      await rm(dir, { recursive: true, force: true })
    }
  })
})
