import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { redact, sha256, truncateUtf8, utf8Bytes } from "./ledger.js"
import { createVccArchiveHandle, parseVccArchiveHandle, verifyVccArchive } from "./vcc-archive.js"
import { canonicalSerialize } from "./vcc.js"

export const VCC_PI_RECALL_DEFAULT_MAX_RESULTS = 5
export const VCC_PI_RECALL_MAX_RESULTS = 16
export const VCC_PI_RECALL_DEFAULT_MAX_BYTES = 16 * 1_024
export const VCC_PI_RECALL_MAX_BYTES = 64 * 1_024
const VCC_PI_RECALL_MAX_ENTRIES = 4_096
const VCC_PI_RECALL_SOURCE_MAX_BYTES = 64 * 1_024
const VCC_PI_RECALL_PAYLOAD_MAX_BYTES = 16 * 1_024

export type VccPiRecallEntry = {
  handle: string
  entry_id: string
  parent_id: string | null
  entry_type: "message" | "custom_message"
  timestamp: string
  source_location: string
  source_bytes: string
  payload_bytes: string
  source_digest: string
  payload_digest: string
  searchable_text: string
}

export type VccPiRecallIndex = {
  session_id: string
  lineage_id: string
  complete: boolean
  reason: "page_limit" | "duplicate_message_id" | "unsupported_record" | null
  entries: VccPiRecallEntry[]
}

export type VccPiRecallFailure =
  | "malformed_handle"
  | "scope_mismatch"
  | "handle_unavailable"
  | "digest_mismatch"
  | "oversized"

export type VccPiRecallResolution =
  | { ok: true; entry: VccPiRecallEntry }
  | { ok: false; reason: VccPiRecallFailure }

export type VccPiRecallToolResult = {
  title: string
  output: string
  metadata: { status: string }
}

/** The active branch is the only durable Pi source exposed by this V1 seam.
 * The first child is a stable fork marker: appending entries preserves it,
 * while sibling branches after the same root receive different markers. */
export function vccPiLineageId(session_id: string, branch: readonly SessionEntry[]) {
  const branch_marker = branch[1]?.id ?? branch[0]?.id ?? "empty-branch"
  return `pi-v1:${sha256(canonicalSerialize({ version: 1, session_id, branch_marker }))}`
}

export function buildVccPiRecallIndex(input: { session_id: string; branch: readonly SessionEntry[] }): VccPiRecallIndex {
  const lineage_id = vccPiLineageId(input.session_id, input.branch)
  const seen = new Set<string>()
  const complete = input.branch.length <= VCC_PI_RECALL_MAX_ENTRIES
  const hasInvalidAuthoritativeEntry = input.branch.some((entry) => isRecallEntry(entry) && !validIdentity(entry.id))
  const reason = !complete ? "page_limit" : hasInvalidAuthoritativeEntry ? "unsupported_record" : null
  const entries = input.branch.slice(0, VCC_PI_RECALL_MAX_ENTRIES).flatMap((entry) => {
    if (!isRecallEntry(entry)) return []
    if (!validIdentity(entry.id)) return []
    if (seen.has(entry.id)) return []
    seen.add(entry.id)
    try {
      const projection = entryProjection(entry)
      const source_bytes = boundedRedacted(canonicalSerialize({ version: 1, kind: "pi-v1-source-entry", entry: projection }), VCC_PI_RECALL_SOURCE_MAX_BYTES)
      const source_location = `pi-v1:branch:${entry.id}`
      const payload_bytes = boundedRedacted(canonicalSerialize({
        version: 1,
        host: "pi",
        session_id: input.session_id,
        lineage_id,
        source_entry_id: entry.id,
        source_location,
        entry: projection,
      }), VCC_PI_RECALL_PAYLOAD_MAX_BYTES)
      const handle = createVccArchiveHandle({
        host: "pi",
        session_id: input.session_id,
        lineage_id,
        stable_source_id: entry.id,
        canonical_source_kind: "pi-session-entry",
        stable_source_identity: entry.id,
        source_bytes,
        payload_bytes,
      }).handle
      const verified = verifyVccArchive({
        handle,
        host: "pi",
        session_id: input.session_id,
        lineage_id,
        stable_source_id: entry.id,
        canonical_source_kind: "pi-session-entry",
        stable_source_identity: entry.id,
        source_bytes,
        payload_bytes,
      })
      if (!verified.valid) return []
      return [{
        handle,
        entry_id: entry.id,
        parent_id: entry.parentId,
        entry_type: entry.type,
        timestamp: entry.timestamp,
        source_location,
        source_bytes,
        payload_bytes,
        source_digest: verified.source_digest,
        payload_digest: verified.payload_digest,
        searchable_text: payload_bytes.toLowerCase(),
      }]
    } catch {
      return []
    }
  })
  const duplicate = input.branch.some((entry, index) => input.branch.findIndex((candidate) => candidate.id === entry.id) !== index)
  return { session_id: input.session_id, lineage_id, complete: complete && !duplicate && !hasInvalidAuthoritativeEntry, reason: duplicate ? "duplicate_message_id" : reason, entries }
}

export function resolveVccPiHandle(input: {
  handle: string
  session_id: string
  lineage_id: string
  entries: readonly VccPiRecallEntry[]
  max_bytes?: number
}): VccPiRecallResolution {
  const parts = parseVccArchiveHandle(input.handle)
  if (!parts) return { ok: false, reason: "malformed_handle" }
  if (parts.host !== "pi") return { ok: false, reason: "scope_mismatch" }
  if (parts.scope_digest !== sha256(`vcc-scope-v1\0pi\0${input.session_id}\0${input.lineage_id}`)) return { ok: false, reason: "scope_mismatch" }
  const entry = input.entries.find((candidate) => candidate.handle === input.handle)
  if (!entry) return { ok: false, reason: "handle_unavailable" }
  if (input.max_bytes !== undefined && utf8Bytes(entry.payload_bytes) > input.max_bytes) return { ok: false, reason: "oversized" }
  const verified = verifyVccArchive({
    handle: entry.handle,
    host: "pi",
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    stable_source_id: entry.entry_id,
    canonical_source_kind: "pi-session-entry",
    stable_source_identity: entry.entry_id,
    source_bytes: entry.source_bytes,
    payload_bytes: entry.payload_bytes,
  })
  return verified.valid ? { ok: true, entry } : { ok: false, reason: verified.reason === "scope_mismatch" ? "scope_mismatch" : "digest_mismatch" }
}

export function discoverVccPiHandles(input: {
  query: string
  entries: readonly VccPiRecallEntry[]
  page?: number
  max_results?: number
}) {
  const query = input.query.trim().toLowerCase()
  const tokens = query.split(/\s+/u).filter(Boolean)
  const page = Number.isSafeInteger(input.page) && input.page! > 0 ? input.page! : 1
  const max_results = boundedResults(input.max_results)
  const ranked = input.entries
    .map((entry) => ({ entry, score: tokens.reduce((total, token) => total + (entry.searchable_text.includes(token) ? 1 : 0), 0) }))
    .filter((candidate) => tokens.length > 0 && candidate.score === tokens.length)
    .sort((left, right) => right.score - left.score || compareCodePoints(left.entry.entry_id, right.entry.entry_id))
  const start = (page - 1) * max_results
  return {
    total: ranked.length,
    page,
    total_pages: Math.max(1, Math.ceil(ranked.length / max_results)),
    entries: ranked.slice(start, start + max_results).map((candidate) => candidate.entry),
  }
}

export function renderVccPiRecallEntry(entry: VccPiRecallEntry, max_bytes: number) {
  if (utf8Bytes(entry.payload_bytes) > max_bytes) return
  const output = canonicalSerialize({
    handle: entry.handle,
    entry_id: entry.entry_id,
    parent_id: entry.parent_id,
    entry_type: entry.entry_type,
    timestamp: entry.timestamp,
    source_location: entry.source_location,
    source_digest: entry.source_digest,
    payload_digest: entry.payload_digest,
    presentation: "transformed_redacted",
    payload: entry.payload_bytes,
  })
  if (utf8Bytes(output) > max_bytes) return
  return output
}

export function vccPiRecallToolResult(status: string, body: Record<string, unknown>, max_bytes: number): VccPiRecallToolResult {
  const output = canonicalSerialize({ version: 1, kind: "vcc_recall", host: "pi", status, ...body })
  if (utf8Bytes(output) <= max_bytes) return { title: `VCC Pi recall: ${status}`, output, metadata: { status } }
  const bounded = canonicalSerialize({ version: 1, kind: "vcc_recall", host: "pi", status: "oversized", requested_bytes: max_bytes })
  return { title: "VCC Pi recall: oversized", output: bounded, metadata: { status: "oversized" } }
}

function isRecallEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" | "custom_message" }> {
  return entry.type === "message" || (entry.type === "custom_message" && entry.display)
}

function entryProjection(entry: Extract<SessionEntry, { type: "message" | "custom_message" }>) {
  if (entry.type === "message") {
    return { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, type: entry.type, message: entry.message }
  }
  return { id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, type: entry.type, customType: entry.customType, content: entry.content, display: entry.display }
}

function boundedRedacted(value: string, max_bytes: number) {
  return truncateUtf8(redact(value), max_bytes)
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes(":") && !value.includes("\0") && !value.includes("\n") && !/^\d+$/u.test(value) && utf8Bytes(value) <= 512
}

function boundedResults(value: number | undefined) {
  if (!Number.isSafeInteger(value)) return VCC_PI_RECALL_DEFAULT_MAX_RESULTS
  return Math.min(VCC_PI_RECALL_MAX_RESULTS, Math.max(1, value!))
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
