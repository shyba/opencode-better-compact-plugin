import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import { resolveOptions, parseOptions } from "../src/options.js"
import {
  loadPiOptions,
  priorPluginSummary,
  savePiOptions,
  toMessageRecords,
  todosFromBranch,
} from "../src/pi-adapter.js"
import { buildAuthoritativeSummary } from "../src/validation.js"

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
      const resolved = resolveOptions(parseOptions({ model: "test/compactor", tail_turns: 6 }))
      await savePiOptions(dir, resolved)
      const loaded = resolveOptions(parseOptions(loadPiOptions(dir)))
      expect(loaded.model).toBe("test/compactor")
      expect(loaded.tail_turns).toBe(6)
      expect(loaded.max_ledger_bytes).toBe(resolved.max_ledger_bytes)
      const raw = await readFile(path.join(dir, ".pi", "safe-compaction.json"), "utf8")
      expect(raw).not.toContain("preserve_recent_tokens")
      expect(raw).not.toContain("reserved_tokens")
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
