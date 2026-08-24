import { record, utf8Bytes, type MessageRecord } from "./ledger.js"
import { toVccOpenCodeEvents } from "./vcc-opencode-message.js"
import {
  buildSourceCompleteness,
  buildVccPatchSourceIndex,
  canonicalSerialize,
  compileVccCandidate,
  formCausalEpisodes,
  normalizeCanonicalEvent,
  sourceCompletenessDigest,
  type CanonicalEvent,
  type CausalEpisode,
  type SourceCompleteness,
  type VccCandidate,
  type VccPatchContext,
  type VccSourceIncompleteReason,
} from "./vcc.js"

export const VCC_OPENCODE_DEFAULT_MAX_PAGES = 256
export const VCC_OPENCODE_DEFAULT_MAX_BYTES = 4 * 1_024 * 1_024
export const VCC_OPENCODE_DEFAULT_MAX_DOCKET_BYTES = 16_384

export type VccOpenCodeSessionPage = {
  records: readonly MessageRecord[]
  next_cursor: string | null
}

export type VccOpenCodeSessionInput = {
  session_id: string
  lineage_id: string
  max_pages: number
  max_bytes: number
  max_candidate_bytes: number
  max_docket_bytes?: number
  compile_candidate?: boolean
  fetch_page: (cursor: string | null) => Promise<VccOpenCodeSessionPage>
}

export type VccOpenCodeSessionFailure =
  | "no_canonical_events"
  | "candidate_failed"
  | "docket_oversized"
  | VccSourceIncompleteReason

export type VccOpenCodeSessionResult = {
  source: SourceCompleteness
  events: CanonicalEvent[]
  episodes: CausalEpisode[]
  candidate?: VccCandidate
  context?: VccPatchContext
  docket_bytes?: string
  raw_source_bytes: string
  source_records: MessageRecord[]
  excluded_generated_message_ids: string[]
  failure?: VccOpenCodeSessionFailure
}

/**
 * Collect one injected OpenCode V1 session snapshot and compile only
 * source-backed canonical events. This returns raw records for the ephemeral
 * caller that requested the collection; it performs no persistence or model
 * work. Generated summaries remain observed in `source_records` but are never
 * candidate input.
 */
export async function collectVccOpenCodeSession(input: VccOpenCodeSessionInput): Promise<VccOpenCodeSessionResult> {
  requirePositiveLimit(input.max_pages, "max_pages")
  requirePositiveLimit(input.max_bytes, "max_bytes")
  requirePositiveLimit(input.max_candidate_bytes, "max_candidate_bytes")
  const max_docket_bytes = input.max_docket_bytes ?? VCC_OPENCODE_DEFAULT_MAX_DOCKET_BYTES
  requirePositiveLimit(max_docket_bytes, "max_docket_bytes")

  const source_records: MessageRecord[] = []
  const events: CanonicalEvent[] = []
  const message_ids = new Set<string>()
  const cursors = new Set<string>()
  const excluded_generated_message_ids: string[] = []
  let cursor: string | null = null
  let page_count = 0
  let byte_count = 0
  let authoritative_page_count = 0
  let authoritative_byte_count = 0
  let next_sequence = 0

  while (true) {
    if (page_count >= input.max_pages) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "page_limit")
    let page: unknown
    try {
      page = await input.fetch_page(cursor)
    } catch {
      return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "fetch_error")
    }
    page_count++
    if (!isPage(page)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
    let page_bytes: number
    try {
      page_bytes = utf8Bytes(canonicalSerialize(page.records))
    } catch {
      return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
    }
    if (page_bytes > input.max_bytes - byte_count) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "byte_limit")
    byte_count += page_bytes
    if (page.next_cursor !== null && !validCursor(page.next_cursor)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "invalid_cursor")
    if (page.records.length === 0 && page.next_cursor !== null) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, page.next_cursor, "empty_page_with_cursor")

    let pageHasAuthoritativeRecord = false
    for (const message of page.records) {
      const messageValue = record(message)
      const info = record(messageValue?.info)
      if (!info || typeof info.id !== "string" || !info.id) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
      if (message_ids.has(info.id)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "duplicate_message_id")
      if (info.sessionID !== input.session_id) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "cross_session_record")
      const observedLineage = info.lineage_id ?? info.lineageID
      if (observedLineage !== undefined && observedLineage !== input.lineage_id) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "lineage_ambiguous")
      message_ids.add(info.id)
      source_records.push(message)
      let mapped
      try {
        mapped = toVccOpenCodeEvents({ message, session_id: input.session_id, lineage_id: input.lineage_id, sequence: next_sequence })
      } catch {
        return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
      }
      if (!mapped || mapped.length === 0) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
      next_sequence += mapped.length
      if (mapped.every((event) => event.advisory === true)) excluded_generated_message_ids.push(info.id)
      for (const event of mapped) {
        try {
          const normalized = normalizeCanonicalEvent(event)
          if (events.some((existing) => existing.id === normalized.id)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "duplicate_message_id")
          if (normalized.authority === "advisory") continue
          pageHasAuthoritativeRecord = true
          events.push(normalized)
        } catch {
          return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
        }
      }
    }
    if (pageHasAuthoritativeRecord) {
      authoritative_page_count++
      authoritative_byte_count += utf8Bytes(canonicalSerialize(page.records.filter((message) => {
        const mapped = toVccOpenCodeEvents({ message, session_id: input.session_id, lineage_id: input.lineage_id, sequence: 0 })
        return mapped?.some((event) => event.advisory !== true)
      })))
    }

    if (page.next_cursor === null) break
    if (cursors.has(page.next_cursor)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, page.next_cursor, "cursor_repeated")
    cursors.add(page.next_cursor)
    cursor = page.next_cursor
  }

  const authoritativeRecords = source_records.filter((message) => isAuthoritativeOpenCodeRecord(message, input.session_id, input.lineage_id))
    .sort(compareOpenCodeRecords)
  const canonicalEvents: CanonicalEvent[] = []
  let canonicalSequence = 0
  for (const message of authoritativeRecords) {
    const mapped = toVccOpenCodeEvents({ message, session_id: input.session_id, lineage_id: input.lineage_id, sequence: canonicalSequence })
    if (!mapped) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
    for (const event of mapped) {
      try {
        const normalized = normalizeCanonicalEvent(event)
        if (normalized.authority === "advisory") continue
        if (canonicalEvents.some((existing) => existing.id === normalized.id)) return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "duplicate_message_id")
        canonicalEvents.push(normalized)
      } catch {
        return result(input, source_records, events, excluded_generated_message_ids, page_count, byte_count, cursor, "unsupported_record")
      }
    }
    canonicalSequence += mapped.length
  }
  const source = buildSource(input, canonicalEvents, authoritative_page_count, authoritative_byte_count, null, null)
  const raw_source_bytes = canonicalSerialize(source_records)
  if (canonicalEvents.length === 0) return { source, events: canonicalEvents, episodes: [], raw_source_bytes, source_records, excluded_generated_message_ids, failure: "no_canonical_events" }
  const episodes = formCausalEpisodes(canonicalEvents)
  let candidate: VccCandidate
  if (input.compile_candidate === false) {
    return { source, events: canonicalEvents, episodes, raw_source_bytes, source_records, excluded_generated_message_ids }
  }
  try {
    candidate = compileVccCandidate({ events: canonicalEvents, episodes, source, options: { max_bytes: input.max_candidate_bytes } })
  } catch {
    return { source, events: canonicalEvents, episodes, raw_source_bytes, source_records, excluded_generated_message_ids, failure: "candidate_failed" }
  }
  const source_index = buildVccPatchSourceIndex({
    events: canonicalEvents,
    episodes,
    goal_ids: canonicalEvents.flatMap((event) => event.goal_ids),
    artifact_ids: canonicalEvents.flatMap((event) => event.artifact_ids),
    protected_event_ids: candidate.protected_event_ids,
    protected_episode_ids: candidate.live_episode_ids,
  })
  const docket_bytes = canonicalSerialize({
    version: 1,
    kind: "vcc_opencode_docket",
    source_manifest_digest: source.digest,
    source_index_digest: candidate.source_index_digest,
    authority: "candidate and source-index references only; no workspace or archive authority",
  })
  if (utf8Bytes(docket_bytes) > max_docket_bytes) {
    return { source, events: canonicalEvents, episodes, raw_source_bytes, source_records, excluded_generated_message_ids, failure: "docket_oversized" }
  }
  return { source, events: canonicalEvents, episodes, candidate, context: { candidate, docket_bytes, source_index }, docket_bytes, raw_source_bytes, source_records, excluded_generated_message_ids }
}

function isAuthoritativeOpenCodeRecord(message: MessageRecord, sessionID: string, lineageID: string) {
  const mapped = toVccOpenCodeEvents({ message, session_id: sessionID, lineage_id: lineageID, sequence: 0 })
  return mapped?.some((event) => event.advisory !== true) === true
}

function compareOpenCodeRecords(left: MessageRecord, right: MessageRecord) {
  const leftCreated = left.info.time?.created
  const rightCreated = right.info.time?.created
  if (typeof leftCreated === "number" && typeof rightCreated === "number" && leftCreated !== rightCreated) return leftCreated - rightCreated
  return compareCodePoints(left.info.id, right.info.id)
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function result(
  input: VccOpenCodeSessionInput,
  source_records: MessageRecord[],
  events: CanonicalEvent[],
  excluded_generated_message_ids: string[],
  page_count: number,
  byte_count: number,
  terminal_cursor: string | null,
  reason: VccSourceIncompleteReason,
): VccOpenCodeSessionResult {
  return {
    source: buildSource(input, events, page_count, byte_count, terminal_cursor, reason),
    events,
    episodes: formCausalEpisodes(events),
    raw_source_bytes: canonicalSerialize(source_records),
    source_records,
    excluded_generated_message_ids,
    failure: reason,
  }
}

function buildSource(input: VccOpenCodeSessionInput, events: CanonicalEvent[], page_count: number, byte_count: number, terminal_cursor: string | null, reason: VccSourceIncompleteReason | null) {
  return buildSourceCompleteness({ host: "opencode-v1", session_id: input.session_id, lineage_id: input.lineage_id, events, page_count, byte_count, terminal_cursor, reason })
}

function sourceDigest(source: SourceCompleteness) {
  return sourceCompletenessDigest(source)
}

function isPage(value: unknown): value is VccOpenCodeSessionPage {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as Record<string, unknown>).records) && Object.prototype.hasOwnProperty.call(value, "next_cursor")
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && utf8Bytes(value) <= 4_096
}

function requirePositiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
}
