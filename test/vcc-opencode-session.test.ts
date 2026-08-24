import { describe, expect, test } from "bun:test"
import type { MessageRecord } from "../src/ledger.js"
import {
  collectVccOpenCodeSession,
  type VccOpenCodeSessionInput,
  type VccOpenCodeSessionPage,
} from "../src/vcc-opencode-session.js"

const session_id = "session-seam"
const lineage_id = "lineage-main"

function textMessage(id: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}): MessageRecord {
  return {
    info: { id, sessionID: session_id, role, ...extra },
    parts: [{ id: `${id}-part`, sessionID: session_id, messageID: id, type: "text", text }],
  }
}

function toolMessage(id: string, tool = "read"): MessageRecord {
  return {
    info: { id, sessionID: session_id, role: "assistant" },
    parts: [{
      id: `${id}-part`,
      sessionID: session_id,
      messageID: id,
      type: "tool",
      callID: `${id}-call`,
      tool,
      state: { status: "completed", input: { path: "src/example.ts" }, output: "export const value = 1" },
    }],
  }
}

function pageInput(pages: Record<string, VccOpenCodeSessionPage>, overrides: Partial<VccOpenCodeSessionInput> = {}): VccOpenCodeSessionInput {
  return {
    session_id,
    lineage_id,
    max_pages: 8,
    max_bytes: 100_000,
    max_candidate_bytes: 100_000,
    fetch_page: async (cursor) => pages[cursor ?? "start"]!,
    ...overrides,
  }
}

describe("pure OpenCode V1 session source to VCC candidate", () => {
  test("walks to terminal, flattens tool events, and excludes generated summary prose", async () => {
    const generated = textMessage("generated-summary", "assistant", "old generated summary", { summary: true })
    const result = await collectVccOpenCodeSession(pageInput({
      start: { records: [generated, textMessage("request", "user", "retain the deployment constraint")], next_cursor: "cursor-1" },
      "cursor-1": { records: [toolMessage("tool-work")], next_cursor: null },
    }))

    expect(result.failure).toBeUndefined()
    expect(result.source).toMatchObject({ complete: true, reason: null, page_count: 2, terminal_cursor: null, terminal_cursor_observed: true })
    expect(result.excluded_generated_message_ids).toEqual(["generated-summary"])
    expect(result.events.map((event) => event.id)).toEqual([
      "ev:opencode-v1:request",
      "ev:opencode-v1:tool-work~tool~tool-work-part~call",
      "ev:opencode-v1:tool-work~tool~tool-work-part~result",
    ])
    expect(result.events.map((event) => event.sequence)).toEqual([0, 1, 2])
    expect(new Set(result.events.map((event) => event.sequence)).size).toBe(result.events.length)
    expect(result.candidate).toBeDefined()
    expect(result.candidate!.bytes).not.toContain("old generated summary")
    expect(result.context).toBeDefined()
    expect(result.context!.source_index.event_ids).toEqual(result.events.map((event) => event.id).sort())
    expect(result.docket_bytes).toBe(result.context!.docket_bytes)
    expect(result.docket_bytes).not.toContain("old generated summary")
    expect(result.docket_bytes).toContain("no workspace or archive authority")
  })

  test("returns an explicit complete-source result when all records are generated", async () => {
    const result = await collectVccOpenCodeSession(pageInput({
      start: { records: [textMessage("summary-only", "assistant", "generated", { summary: true })], next_cursor: null },
    }))

    expect(result.failure).toBe("no_canonical_events")
    expect(result.source).toMatchObject({ complete: true, reason: null, record_count: 0 })
    expect(result.candidate).toBeUndefined()
    expect(result.context).toBeUndefined()
    expect(result.excluded_generated_message_ids).toEqual(["summary-only"])
  })

  test("fails closed for cursor, fetch, duplicate, scope, and lineage failures", async () => {
    const repeated = await collectVccOpenCodeSession(pageInput({
      start: { records: [textMessage("first", "user", "one")], next_cursor: "same" },
      same: { records: [textMessage("second", "user", "two")], next_cursor: "same" },
    }))
    const invalid = await collectVccOpenCodeSession(pageInput({
      start: { records: [textMessage("invalid", "user", "one")], next_cursor: "" },
    }))
    const nonString = await collectVccOpenCodeSession(pageInput({
      start: { records: [textMessage("non-string", "user", "one")], next_cursor: 42 as unknown as string },
    }))
    const empty = await collectVccOpenCodeSession(pageInput({
      start: { records: [], next_cursor: "cursor" },
    }))
    const fetch = await collectVccOpenCodeSession(pageInput({}, { fetch_page: async () => { throw new Error("unavailable") } }))
    const duplicate = await collectVccOpenCodeSession(pageInput({
      start: { records: [textMessage("duplicate", "user", "one")], next_cursor: "next" },
      next: { records: [textMessage("duplicate", "user", "two")], next_cursor: null },
    }))
    const crossSession = await collectVccOpenCodeSession(pageInput({
      start: { records: [{ ...textMessage("cross", "user", "one"), info: { ...textMessage("cross", "user", "one").info, sessionID: "other" } }], next_cursor: null },
    }))
    const lineage = await collectVccOpenCodeSession(pageInput({
      start: { records: [{ ...textMessage("lineage", "user", "one"), info: { ...textMessage("lineage", "user", "one").info, lineage_id: "sibling" } }], next_cursor: null },
    }))
    const mapper = await collectVccOpenCodeSession(pageInput({
      start: { records: [{ ...textMessage("unsupported", "user", "one"), parts: [{ type: "future-part" }] }], next_cursor: null },
    }))

    expect(repeated.failure).toBe("cursor_repeated")
    expect(invalid.failure).toBe("invalid_cursor")
    expect(nonString.failure).toBe("invalid_cursor")
    expect(empty.failure).toBe("empty_page_with_cursor")
    expect(fetch.failure).toBe("fetch_error")
    expect(duplicate.failure).toBe("duplicate_message_id")
    expect(crossSession.failure).toBe("cross_session_record")
    expect(lineage.failure).toBe("lineage_ambiguous")
    expect(mapper.failure).toBe("unsupported_record")
    for (const result of [repeated, invalid, nonString, empty, fetch, duplicate, crossSession, lineage, mapper]) {
      expect(result.source.complete).toBe(false)
      expect(result.candidate).toBeUndefined()
      expect(result.context).toBeUndefined()
    }
  })

  test("enforces page, byte, candidate, and docket bounds without relabeling complete source", async () => {
    const pages = {
      start: { records: [textMessage("first", "user", "one")], next_cursor: "next" },
      next: { records: [textMessage("second", "user", "two")], next_cursor: null },
    }
    const pageLimited = await collectVccOpenCodeSession(pageInput(pages, { max_pages: 1 }))
    const byteLimited = await collectVccOpenCodeSession(pageInput({ start: pages.start }, { max_bytes: 1 }))
    const candidateLimited = await collectVccOpenCodeSession(pageInput({ start: { records: [textMessage("large", "user", "one")], next_cursor: null } }, { max_candidate_bytes: 1 }))
    const docketLimited = await collectVccOpenCodeSession(pageInput({ start: { records: [textMessage("docket", "user", "one")], next_cursor: null } }, { max_docket_bytes: 1 }))

    expect(pageLimited.failure).toBe("page_limit")
    expect(byteLimited.failure).toBe("byte_limit")
    expect(candidateLimited.failure).toBe("candidate_failed")
    expect(docketLimited.failure).toBe("docket_oversized")
    expect(candidateLimited.source.complete).toBe(true)
    expect(docketLimited.source.complete).toBe(true)
    expect(candidateLimited.candidate).toBeUndefined()
    expect(docketLimited.context).toBeUndefined()
  })

  test("is deterministic and does not claim archive or recall completeness", async () => {
    const input = pageInput({ start: { records: [textMessage("stable", "user", "same")], next_cursor: null } })
    const first = await collectVccOpenCodeSession(input)
    const second = await collectVccOpenCodeSession(input)

    expect(second).toEqual(first)
    expect(first.context!.source_index).not.toHaveProperty("archive_handles")
    expect(first.docket_bytes).toContain("no workspace or archive authority")
    expect(first.raw_source_bytes).toContain("stable")
  })

  test("keeps canonical source identity stable when a compaction exchange crosses the page boundary", async () => {
    const records = Array.from({ length: 256 }, (_, index) => textMessage(`source-${String(index).padStart(3, "0")}`, "user", `source ${index}`))
    const request = {
      info: { id: "compaction-request", sessionID: session_id, role: "user" as const },
      parts: [{ id: "compaction-request-part", sessionID: session_id, messageID: "compaction-request", type: "compaction" }],
    }
    const summary = textMessage("compaction-summary", "assistant", "generated summary", { summary: true, parentID: "compaction-request" })
    const bounds = { max_bytes: 2_000_000, max_candidate_bytes: 2_000_000 }
    const first = await collectVccOpenCodeSession(pageInput({ start: { records, next_cursor: null } }, bounds))
    const second = await collectVccOpenCodeSession(pageInput({
      start: { records: [request, summary, ...records.slice(0, 254)], next_cursor: "cursor-1" },
      "cursor-1": { records: records.slice(254), next_cursor: null },
    }, bounds))

    expect(first.failure).toBeUndefined()
    expect(second.failure).toBeUndefined()
    expect(second.source.digest).toBe(first.source.digest)
    expect(second.candidate?.digest).toBe(first.candidate?.digest)
    expect(second.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id))
    expect(second.events.map((event) => event.sequence)).toEqual(first.events.map((event) => event.sequence))
  })
})
