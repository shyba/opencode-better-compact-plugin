import { describe, expect, test } from "bun:test"
import type { MessageRecord } from "../src/ledger.js"
import { formCausalEpisodes, normalizeCanonicalEvent } from "../src/vcc.js"
import { toVccOpenCodeEvents } from "../src/vcc-opencode-message.js"

const session_id = "msg-session"
const lineage_id = "msg-lineage"

function input(message: MessageRecord, sequence = 0) {
  return { message, session_id, lineage_id, sequence }
}

function textMessage(id: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}): MessageRecord {
  return {
    info: { id, sessionID: session_id, role, ...extra },
    parts: [{ id: `${id}-part`, sessionID: session_id, messageID: id, type: "text", text }],
  }
}

function toolMessage(id: string, tool: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}): MessageRecord {
  return {
    info: { id, sessionID: session_id, role: "assistant", ...extra },
    parts: [{ id: `${id}-part`, sessionID: session_id, messageID: id, type: "tool", callID: `${id}-call`, tool, state }],
  }
}

describe("pure OpenCode V1 message-to-event adapter", () => {
  test("maps a direct human message with stable identity, source location, and redacted canonical content", () => {
    const events = toVccOpenCodeEvents(input(textMessage("msg-direct", "user", 'retain api_key: "sk-12345678901234567890"')))
    expect(events).toHaveLength(1)
    const event = events![0]!
    expect(event.stable_source_id).toBe("msg-direct")
    expect(event.provenance).toBe("human_direct")
    expect(event.kind).toBe("message")
    expect(event.source_location).toBe("opencode-v1:message:msg-direct")
    expect(event.content).not.toContain("sk-12345678901234567890")
    expect(normalizeCanonicalEvent(event).authority).toBe("authoritative")
  })

  test("keeps assistant text as assistant provenance and preserves observable parent correlation", () => {
    const events = toVccOpenCodeEvents(input(textMessage("msg-assistant", "assistant", "I finished the check", { parentID: "msg-parent" }), 3))
    expect(events).toHaveLength(1)
    expect(events![0]).toMatchObject({
      stable_source_id: "msg-assistant",
      sequence: 3,
      provenance: "assistant",
      pair_id: "msg-parent",
    })
    expect(normalizeCanonicalEvent(events![0]!).provenance).toBe("assistant")
  })

  test("emits a whole tool call/result pair and keeps question answers human-authoritative only with metadata", () => {
    const question = toolMessage("msg-question", "question", {
      status: "completed",
      input: { questions: [{ question: "Deploy?" }] },
      output: 'User has answered your questions: "Deploy?"="yes".',
      metadata: { answers: [["yes"]] },
    })
    const events = toVccOpenCodeEvents(input(question))
    expect(events).toHaveLength(2)
    expect(events!.map((event) => event.stable_source_id)).toEqual(["msg-question~tool~msg-question-part~call", "msg-question~tool~msg-question-part~result"])
    expect(events!.map((event) => event.sequence)).toEqual([0, 1])
    expect(new Set(events!.map((event) => event.stable_source_id)).size).toBe(2)
    expect(events![0]).toMatchObject({ provenance: "tool_call", kind: "tool_call", pair_id: "msg-question-call" })
    expect(events![1]).toMatchObject({ provenance: "human_tool_answer", kind: "question_answer", pair_id: "msg-question-call" })
    expect(normalizeCanonicalEvent(events![1]!).authority).toBe("authoritative")
    const episode = formCausalEpisodes(events!.map(normalizeCanonicalEvent))[0]
    expect(episode).toMatchObject({ kind: "question_answer", status: "completed", event_ids: events!.map((event) => `ev:opencode-v1:${event.stable_source_id}`) })

    const proseOnly = toolMessage("msg-prose", "question", {
      status: "completed",
      input: { questions: [{ question: "Deploy?" }] },
      output: 'User has answered your questions: "Deploy?"="yes".',
    })
    expect(toVccOpenCodeEvents(input(proseOnly))![1]!.provenance).toBe("tool_result")
  })

  test("maps ordinary tool completion without inventing human provenance", () => {
    const events = toVccOpenCodeEvents(input(toolMessage("msg-tool", "read", {
      status: "completed",
      input: { path: "src/a.ts" },
      output: "file contents",
    })))
    expect(events).toHaveLength(2)
    expect(events!.map((event) => event.provenance)).toEqual(["tool_call", "tool_result"])
    expect(events!.every((event) => event.pair_id === "msg-tool-call")).toBe(true)
    expect(events!.every((event) => normalizeCanonicalEvent(event).session_id === session_id)).toBe(true)
  })

  test("keeps expanded tool identity stable when unrelated part positions change", () => {
    const first = toolMessage("msg-reorder", "read", { status: "completed", input: { path: "a" }, output: "a" })
    const secondTool = { id: "msg-reorder-other-part", sessionID: session_id, messageID: "msg-reorder", type: "tool", callID: "other-call", tool: "read", state: { status: "completed", input: { path: "b" }, output: "b" } }
    first.parts = [first.parts[0]!, secondTool]
    const reordered = structuredClone(first)
    reordered.parts.reverse()
    const firstEvents = toVccOpenCodeEvents(input(first))!
    const reorderedEvents = toVccOpenCodeEvents(input(reordered))!
    expect(firstEvents.map((event) => event.stable_source_id).sort()).toEqual(reorderedEvents.map((event) => event.stable_source_id).sort())
    expect(firstEvents.map((event) => event.source_location).sort()).toEqual(reorderedEvents.map((event) => event.source_location).sort())
  })

  test("marks compaction summaries advisory and never authoritative", () => {
    const message = textMessage("msg-summary", "assistant", "old generated summary", { summary: true })
    const events = toVccOpenCodeEvents(input(message))
    expect(events).toHaveLength(1)
    expect(events![0]).toMatchObject({ kind: "summary", advisory: true })
    expect(events![0]).not.toHaveProperty("authoritative")
    expect(normalizeCanonicalEvent(events![0]!).authority).toBe("advisory")

    const compaction = textMessage("msg-compaction", "assistant", "compacted", {})
    compaction.parts = [{ id: "part", sessionID: session_id, messageID: "msg-compaction", type: "compaction", auto: true }]
    expect(toVccOpenCodeEvents(input(compaction))![0]).toMatchObject({ kind: "compaction", advisory: true })
  })

  test("fails closed for malformed identity, cross-session data, unsupported parts, and invalid tool state", () => {
    expect(toVccOpenCodeEvents(input(textMessage("msg:bad", "user", "bad")))).toBeUndefined()
    expect(toVccOpenCodeEvents(input({ ...textMessage("msg-cross", "user", "bad"), info: { ...textMessage("msg-cross", "user", "bad").info, sessionID: "other" } }))).toBeUndefined()
    expect(toVccOpenCodeEvents(input({ ...textMessage("msg-part-cross", "user", "bad"), parts: [{ type: "text", text: "bad", sessionID: "other" }] }))).toBeUndefined()
    expect(toVccOpenCodeEvents(input({ ...textMessage("msg-unknown", "user", "bad"), parts: [{ type: "future-part" }] }))).toBeUndefined()
    expect(toVccOpenCodeEvents(input(toolMessage("msg-bad-tool", "read", { status: "completed", input: {} })))).toBeUndefined()
    const missingPartID = toolMessage("msg-missing-part-id", "read", { status: "completed", input: {}, output: "ok" })
    delete (missingPartID.parts[0] as Record<string, unknown>).id
    expect(toVccOpenCodeEvents(input(missingPartID))).toBeUndefined()
    const duplicatePartID = toolMessage("msg-duplicate-part-id", "read", { status: "completed", input: {}, output: "ok" })
    duplicatePartID.parts.push(structuredClone(duplicatePartID.parts[0]))
    expect(toVccOpenCodeEvents(input(duplicatePartID))).toBeUndefined()
    expect(toVccOpenCodeEvents(input(textMessage("msg-sequence", "user", "bad"), -1))).toBeUndefined()
  })

  test("is deterministic across repeated mapping", () => {
    const message = toolMessage("msg-repeat", "write", {
      status: "completed",
      input: { path: "src/a.ts", content: "x" },
      output: "wrote it",
    })
    expect(toVccOpenCodeEvents(input(message, 8))).toEqual(toVccOpenCodeEvents(input(structuredClone(message), 8)))
  })
})
