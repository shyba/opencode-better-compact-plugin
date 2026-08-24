import { describe, expect, test } from "bun:test"
import { assertCompleteSource, type CanonicalEventInput } from "../src/vcc.js"
import { collectVccPages, type VccPage, type VccPageCollectorInput } from "../src/vcc-opencode.js"

const scope = { session_id: "session-pages", lineage_id: "lineage-main" }

type RecordFixture = {
  id: string
  session_id?: string
  lineage_id?: string
  content?: string
}

function collector(pages: Record<string, VccPage<RecordFixture>>, overrides: Partial<VccPageCollectorInput<RecordFixture>> = {}): VccPageCollectorInput<RecordFixture> {
  return {
    ...scope,
    max_pages: 8,
    max_bytes: 100_000,
    fetch_page: async (cursor) => pages[cursor ?? "start"]!,
    identify: (record) => ({ id: record.id, session_id: record.session_id ?? scope.session_id, lineage_id: record.lineage_id ?? scope.lineage_id }),
    to_event: (record, sequence): CanonicalEventInput => ({ host: "opencode-v1", ...scope, stable_source_id: record.id, sequence, provenance: "assistant", kind: "message", content: record.content ?? record.id, source_location: `fixture:${record.id}` }),
    ...overrides,
  }
}

describe("pure OpenCode V1 VCC page traversal", () => {
  test("walks two pages to terminal cursor and preserves page order", async () => {
    const result = await collectVccPages(collector({
      start: { records: [{ id: "first" }], next_cursor: "cursor-1" },
      "cursor-1": { records: [{ id: "second" }], next_cursor: null },
    }))
    expect(result.events.map((event) => event.id)).toEqual(["ev:opencode-v1:first", "ev:opencode-v1:second"])
    expect(result.source).toMatchObject({ complete: true, reason: null, page_count: 2, record_count: 2, terminal_cursor: null, terminal_cursor_observed: true })
    expect(() => assertCompleteSource(result.source)).not.toThrow()
  })

  test("returns a deterministic complete result on repeated traversal", async () => {
    const pages = { start: { records: [{ id: "first", content: "same" }], next_cursor: "cursor-1" }, "cursor-1": { records: [{ id: "second", content: "same" }], next_cursor: null } }
    const first = await collectVccPages(collector(pages))
    const second = await collectVccPages(collector(pages))
    expect(second.events).toEqual(first.events)
    expect(second.source).toEqual(first.source)
    expect(second.source.digest).toBe(first.source.digest)
  })

  test("marks repeated cursors incomplete", async () => {
    const result = await collectVccPages(collector({ start: { records: [{ id: "first" }], next_cursor: "cursor-1" }, "cursor-1": { records: [{ id: "second" }], next_cursor: "cursor-1" } }))
    expect(result.source.reason).toBe("cursor_repeated")
    expect(result.source.complete).toBe(false)
    expect(() => assertCompleteSource(result.source)).toThrow()
  })

  test("marks empty continuation pages incomplete", async () => {
    const result = await collectVccPages(collector({ start: { records: [], next_cursor: "cursor-1" } }))
    expect(result.source.reason).toBe("empty_page_with_cursor")
    expect(result.events).toEqual([])
    expect(() => assertCompleteSource(result.source)).toThrow()
  })

  test("rejects empty and non-string cursors as invalid", async () => {
    const empty = await collectVccPages(collector({ start: { records: [{ id: "first" }], next_cursor: "" } as VccPage<RecordFixture> }))
    const nonString = await collectVccPages(collector({ start: { records: [{ id: "first" }], next_cursor: 42 } as unknown as VccPage<RecordFixture> }))
    const emptyMalformed = await collectVccPages(collector({ start: { records: [], next_cursor: 42 } as unknown as VccPage<RecordFixture> }))
    expect(empty.source.reason).toBe("invalid_cursor")
    expect(nonString.source.reason).toBe("invalid_cursor")
    expect(emptyMalformed.source.reason).toBe("invalid_cursor")
  })

  test("enforces page and byte caps", async () => {
    const pageLimited = await collectVccPages(collector({ start: { records: [{ id: "first" }], next_cursor: "cursor-1" }, "cursor-1": { records: [{ id: "second" }], next_cursor: null } }, { max_pages: 1 }))
    const byteLimited = await collectVccPages(collector({ start: { records: [{ id: "first", content: "large enough" }], next_cursor: null } }, { max_bytes: 1 }))
    expect(pageLimited.source.reason).toBe("page_limit")
    expect(byteLimited.source.reason).toBe("byte_limit")
  })

  test("turns fetch failures into incomplete source status", async () => {
    const result = await collectVccPages(collector({}, { fetch_page: async () => { throw new Error("unavailable") } }))
    expect(result.source.reason).toBe("fetch_error")
    expect(result.source.complete).toBe(false)
  })

  test("never reports complete when record mapping fails", async () => {
    const result = await collectVccPages(collector({ start: { records: [{ id: "bad" }], next_cursor: null } }, { to_event: () => { throw new Error("malformed") } }))
    expect(result.source.reason).toBe("unsupported_record")
    expect(result.source.complete).toBe(false)
    expect(() => assertCompleteSource(result.source)).toThrow()
  })

  test("rejects duplicate stable identity, cross-session, and lineage mismatch", async () => {
    const duplicate = await collectVccPages(collector({ start: { records: [{ id: "same" }], next_cursor: "cursor-1" }, "cursor-1": { records: [{ id: "same" }], next_cursor: null } }))
    const crossSession = await collectVccPages(collector({ start: { records: [{ id: "other", session_id: "different" }], next_cursor: null } }))
    const lineage = await collectVccPages(collector({ start: { records: [{ id: "branch", lineage_id: "sibling" }], next_cursor: null } }))
    expect(duplicate.source.reason).toBe("duplicate_message_id")
    expect(crossSession.source.reason).toBe("cross_session_record")
    expect(lineage.source.reason).toBe("lineage_ambiguous")
  })
})
