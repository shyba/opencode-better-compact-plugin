import { utf8Bytes } from "./ledger.js"
import {
  buildSourceCompleteness,
  canonicalSerialize,
  normalizeCanonicalEvent,
  type CanonicalEvent,
  type CanonicalEventInput,
  type SourceCompleteness,
} from "./vcc.js"

export type VccPage<TRecord> = {
  records: readonly TRecord[]
  next_cursor: string | null
}

export type VccPageCollectorInput<TRecord> = {
  session_id: string
  lineage_id: string
  max_pages: number
  max_bytes: number
  fetch_page: (cursor: string | null) => Promise<VccPage<TRecord>>
  identify: (record: TRecord) => { id: string; session_id: string; lineage_id: string }
  to_event: (record: TRecord, sequence: number) => CanonicalEventInput
}

export type VccPageCollectorResult = {
  events: CanonicalEvent[]
  source: SourceCompleteness
}

export async function collectVccPages<TRecord>(input: VccPageCollectorInput<TRecord>): Promise<VccPageCollectorResult> {
  requirePositiveLimit(input.max_pages, "max_pages")
  requirePositiveLimit(input.max_bytes, "max_bytes")
  const events: CanonicalEvent[] = []
  const identities = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let page_count = 0
  let byte_count = 0

  while (true) {
    if (page_count >= input.max_pages) return collectorResult(input, events, page_count, byte_count, "page_limit", cursor)
    let page: unknown
    try {
      page = await input.fetch_page(cursor)
    } catch {
      return collectorResult(input, events, page_count, byte_count, "fetch_error", cursor)
    }
    page_count++
    if (!isRecord(page) || !Array.isArray(page.records) || !Object.prototype.hasOwnProperty.call(page, "next_cursor")) return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
    let page_bytes: number
    try {
      page_bytes = utf8Bytes(canonicalSerialize(page.records))
    } catch {
      return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
    }
    if (page_bytes > input.max_bytes - byte_count) return collectorResult(input, events, page_count, byte_count, "byte_limit", cursor)
    byte_count += page_bytes
    if (page.next_cursor !== null && !validCursor(page.next_cursor)) return collectorResult(input, events, page_count, byte_count, "invalid_cursor", cursor)
    if (page.records.length === 0 && page.next_cursor !== null) return collectorResult(input, events, page_count, byte_count, "empty_page_with_cursor", page.next_cursor)

    for (const record of page.records) {
      const identity = identifyRecord(input, record)
      if (!identity) return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
      if (identity.session_id !== input.session_id) return collectorResult(input, events, page_count, byte_count, "cross_session_record", cursor)
      if (identity.lineage_id !== input.lineage_id) return collectorResult(input, events, page_count, byte_count, "lineage_ambiguous", cursor)
      if (identities.has(identity.id)) return collectorResult(input, events, page_count, byte_count, "duplicate_message_id", cursor)
      let eventInput: CanonicalEventInput
      try {
        eventInput = input.to_event(record, events.length)
      } catch {
        return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
      }
      if (!isRecord(eventInput) || eventInput.stable_source_id !== identity.id) return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
      try {
        const event = normalizeCanonicalEvent({ ...eventInput, sequence: events.length })
        identities.add(identity.id)
        events.push(event)
      } catch {
        return collectorResult(input, events, page_count, byte_count, "unsupported_record", cursor)
      }
    }

    if (page.next_cursor === null) return collectorResult(input, events, page_count, byte_count, null, null)
    if (cursors.has(page.next_cursor)) return collectorResult(input, events, page_count, byte_count, "cursor_repeated", page.next_cursor)
    cursors.add(page.next_cursor)
    cursor = page.next_cursor
  }
}

function identifyRecord<TRecord>(input: VccPageCollectorInput<TRecord>, record: TRecord) {
  try {
    const identity = input.identify(record)
    if (!isRecord(identity) || typeof identity.id !== "string" || !identity.id || typeof identity.session_id !== "string" || typeof identity.lineage_id !== "string") return
    return identity
  } catch {
    return
  }
}

function collectorResult<TRecord>(input: VccPageCollectorInput<TRecord>, events: CanonicalEvent[], page_count: number, byte_count: number, reason: "cursor_repeated" | "empty_page_with_cursor" | "page_limit" | "byte_limit" | "fetch_error" | "invalid_cursor" | "unsupported_record" | "duplicate_message_id" | "cross_session_record" | "lineage_ambiguous" | null, terminal_cursor: string | null): VccPageCollectorResult {
  return {
    events,
    source: buildSourceCompleteness({
      host: "opencode-v1",
      session_id: input.session_id,
      lineage_id: input.lineage_id,
      events,
      page_count,
      byte_count,
      terminal_cursor,
      reason,
    }),
  }
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && utf8Bytes(value) <= 4_096
}

function requirePositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
