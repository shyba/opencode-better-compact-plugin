import { record, redact, sha256, truncateUtf8, utf8Bytes, type MessageRecord } from "./ledger.js"
import { createVccArchiveHandle, parseVccArchiveHandle, verifyVccArchive } from "./vcc-archive.js"
import { vccOpenCodePayloadBytes, vccOpenCodeSourceBytes } from "./vcc-opencode-message.js"
import { canonicalSerialize, type CanonicalEvent, type VccCandidate } from "./vcc.js"
import type { VccOpenCodeSessionResult } from "./vcc-opencode-session.js"

export const VCC_RECALL_DEFAULT_MAX_RESULTS = 5
export const VCC_RECALL_MAX_RESULTS = 16
export const VCC_RECALL_DEFAULT_MAX_BYTES = 16 * 1_024
export const VCC_RECALL_MAX_BYTES = 64 * 1_024
export const VCC_RECALL_MAX_EXPANSIONS = 8

export function vccOpenCodeArchiveManifestDigest(candidate: VccCandidate, session_id: string, lineage_id: string) {
  try {
    const body = JSON.parse(candidate.bytes) as { kind?: unknown; source_manifest_digest?: unknown; archive_manifest?: unknown; recall_handles?: unknown }
    if (body.kind !== "vcc_candidate" || body.source_manifest_digest !== candidate.source_manifest_digest || !Array.isArray(body.archive_manifest) || !Array.isArray(body.recall_handles)) return
    return sha256(canonicalSerialize({
      version: 1,
      kind: "vcc_opencode_archive_manifest",
      host: "opencode-v1",
      session_id,
      lineage_id,
      source_manifest_digest: candidate.source_manifest_digest,
      archive_manifest: body.archive_manifest,
      recall_handles: body.recall_handles,
    }))
  } catch {
    return
  }
}

export type VccOpenCodeRecallEntry = {
  handle: string
  event: CanonicalEvent
  source_bytes: string
  payload_bytes: string
  source_digest: string
  payload_digest: string
}

export type VccOpenCodeRecallFailure =
  | "malformed_handle"
  | "scope_mismatch"
  | "handle_unavailable"
  | "digest_mismatch"
  | "oversized"

export type VccOpenCodeRecallResolution =
  | { ok: true; entry: VccOpenCodeRecallEntry }
  | { ok: false; reason: VccOpenCodeRecallFailure }

export function buildVccOpenCodeRecallIndex(input: {
  session_id: string
  lineage_id: string
  result: VccOpenCodeSessionResult
}): VccOpenCodeRecallEntry[] {
  const messages = new Map(input.result.source_records.flatMap((message) => {
    const info = record(message.info)
    return typeof info?.id === "string" ? [[info.id, message] as const] : []
  }))
  return input.result.events
    .filter((event) => event.authority === "authoritative")
    .flatMap((event) => {
      const stable_source_id = event.id.slice("ev:opencode-v1:".length)
      const message_id = stable_source_id.split("~tool~", 1)[0]!
      const message = messages.get(message_id)
      if (!message || event.host !== "opencode-v1" || event.session_id !== input.session_id || event.lineage_id !== input.lineage_id) return []
      const source_bytes = vccOpenCodeSourceBytes(message)
      const payload_bytes = vccOpenCodePayloadBytes(event)
      const handle = event.archive_handles[0] ?? createVccArchiveHandle({
        host: "opencode-v1",
        session_id: input.session_id,
        lineage_id: input.lineage_id,
        stable_source_id,
        source_bytes,
        payload_bytes,
      }).handle
      const verified = verifyVccArchive({
        handle,
        host: "opencode-v1",
        session_id: input.session_id,
        lineage_id: input.lineage_id,
        stable_source_id,
        source_bytes,
        payload_bytes,
      })
      if (!verified.valid) return []
      return [{ handle, event, source_bytes, payload_bytes, source_digest: verified.source_digest, payload_digest: verified.payload_digest }]
    })
}

export function resolveVccOpenCodeHandle(input: {
  handle: string
  session_id: string
  lineage_id: string
  entries: VccOpenCodeRecallEntry[]
  max_bytes?: number
}): VccOpenCodeRecallResolution {
  const parts = parseVccArchiveHandle(input.handle)
  if (!parts) return { ok: false, reason: "malformed_handle" }
  if (parts.host !== "opencode-v1") return { ok: false, reason: "scope_mismatch" }
  const entry = input.entries.find((candidate) => candidate.handle === input.handle)
  if (!entry) {
    const scoped = input.entries.some((candidate) => candidate.event.session_id === input.session_id && candidate.event.lineage_id === input.lineage_id)
    return { ok: false, reason: scoped ? "handle_unavailable" : "scope_mismatch" }
  }
  if (entry.event.session_id !== input.session_id || entry.event.lineage_id !== input.lineage_id) return { ok: false, reason: "scope_mismatch" }
  if (input.max_bytes !== undefined && utf8Bytes(entry.payload_bytes) > input.max_bytes) return { ok: false, reason: "oversized" }
  const stable_source_id = entry.event.id.slice("ev:opencode-v1:".length)
  const verified = verifyVccArchive({
    handle: entry.handle,
    host: "opencode-v1",
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    stable_source_id,
    source_bytes: entry.source_bytes,
    payload_bytes: entry.payload_bytes,
    ...(input.max_bytes === undefined ? {} : { max_bytes: input.max_bytes + utf8Bytes(entry.source_bytes) }),
  })
  return verified.valid ? { ok: true, entry } : { ok: false, reason: "digest_mismatch" }
}

export function discoverVccOpenCodeHandles(input: {
  query: string
  entries: VccOpenCodeRecallEntry[]
  page?: number
  max_results?: number
}) {
  const query = input.query.trim().toLowerCase()
  const tokens = query.split(/\s+/u).filter(Boolean)
  const page = Number.isSafeInteger(input.page) && input.page! > 0 ? input.page! : 1
  const max_results = boundedResults(input.max_results)
  const ranked = input.entries
    .map((entry) => {
      const haystack = `${entry.event.content} ${entry.event.kind} ${entry.event.provenance} ${entry.event.source_location}`.toLowerCase()
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0)
      return { entry, score }
    })
    .filter((candidate) => candidate.score === tokens.length && tokens.length > 0)
    .sort((left, right) => right.score - left.score || left.entry.event.sequence - right.entry.event.sequence || compareCodePoints(left.entry.event.id, right.entry.event.id))
  const start = (page - 1) * max_results
  return {
    total: ranked.length,
    page,
    total_pages: Math.max(1, Math.ceil(ranked.length / max_results)),
    entries: ranked.slice(start, start + max_results).map((candidate) => candidate.entry),
  }
}

export function renderVccOpenCodeRecallEntry(entry: VccOpenCodeRecallEntry, max_bytes: number) {
  const exact = utf8Bytes(entry.payload_bytes) <= max_bytes
  const payload = exact ? entry.payload_bytes : truncateUtf8(redact(entry.payload_bytes), max_bytes)
  const output = canonicalSerialize({
    handle: entry.handle,
    event_id: entry.event.id,
    source_location: entry.event.source_location,
    source_digest: entry.source_digest,
    payload_digest: entry.payload_digest,
    presentation: exact ? "exact_canonical_payload" : "transformed_bounded_payload",
    payload,
  })
  if (utf8Bytes(output) > max_bytes) return
  return output
}

function boundedResults(value: number | undefined) {
  if (!Number.isSafeInteger(value)) return VCC_RECALL_DEFAULT_MAX_RESULTS
  return Math.min(VCC_RECALL_MAX_RESULTS, Math.max(1, value!))
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
