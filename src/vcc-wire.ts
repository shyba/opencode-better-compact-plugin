import { sha256, utf8Bytes } from "./ledger.js"
import { parsePluginLedger } from "./validation.js"
import { VCC_SOURCE_INCOMPLETE_REASONS, type VccSourceIncompleteReason } from "./vcc.js"

export const VCC_SOURCE_STATUS_START = "<!-- opencode-safe-compaction vcc-source-status v1 start -->"
export const VCC_SOURCE_STATUS_END = "<!-- opencode-safe-compaction vcc-source-status v1 end -->"
export const VCC_PROJECTION_START = "<!-- opencode-safe-compaction vcc-projection v1 start -->"
export const VCC_PROJECTION_END = "<!-- opencode-safe-compaction vcc-projection v1 end -->"
export const VCC_SOURCE_STATUS_MAX_BYTES = 2_048
export const VCC_PROJECTION_MAX_BYTES = 8_192

export type VccSourceStatus = {
  version: 1
  mode: "hybrid"
  complete: false
  reason: VccSourceIncompleteReason
  manifest_digest: string
  attempt_digest: string
  outcome: "degraded_summary"
  partial_ledger: true
}

export type VccProjectionMarker = {
  version: 1
  mode: "hybrid"
  source_complete: true
  source_manifest_digest: string
  source_index_digest: string
  archive_manifest_digest: string
  candidate_digest: string
  patch_digest: string | null
}

export type VccSuccessfulSummaryExpected = {
  source_manifest_digest: string
  source_index_digest: string
  archive_manifest_digest: string
  candidate_digest: string
  patch_digest: string | null
}

export function vccAttemptDigest(session_id: string, compaction_target_id: string, manifest_digest: string) {
  requireBoundedID(session_id, "session_id")
  requireBoundedID(compaction_target_id, "compaction_target_id")
  requireDigest(manifest_digest, "manifest_digest")
  return sha256(`vcc-attempt-v1\0${session_id}\0${compaction_target_id}\0${manifest_digest}`)
}

export function renderVccSourceStatus(input: Omit<VccSourceStatus, "version" | "mode" | "complete" | "outcome" | "partial_ledger">) {
  if (!VCC_SOURCE_INCOMPLETE_REASONS.includes(input.reason) || !isDigest(input.manifest_digest) || !isDigest(input.attempt_digest)) return
  const line = `{"version":1,"mode":"hybrid","complete":false,"reason":${JSON.stringify(input.reason)},"manifest_digest":${JSON.stringify(input.manifest_digest)},"attempt_digest":${JSON.stringify(input.attempt_digest)},"outcome":"degraded_summary","partial_ledger":true}`
  const block = `${VCC_SOURCE_STATUS_START}\n${line}\n${VCC_SOURCE_STATUS_END}`
  return utf8Bytes(block) <= VCC_SOURCE_STATUS_MAX_BYTES ? block : undefined
}

export function parseVccSourceStatus(text: string): VccSourceStatus | undefined {
  if (typeof text !== "string" || utf8Bytes(text) > VCC_SOURCE_STATUS_MAX_BYTES) return
  const reasonPattern = VCC_SOURCE_INCOMPLETE_REASONS.join("|")
  const pattern = new RegExp(`^${escapeRegex(VCC_SOURCE_STATUS_START)}\\n\\x7b\\"version\\":1,\\"mode\\":\\"hybrid\\",\\"complete\\":false,\\"reason\\":\\"(${reasonPattern})\\",\\"manifest_digest\\":\\"([a-f0-9]{64})\\",\\"attempt_digest\\":\\"([a-f0-9]{64})\\",\\"outcome\\":\\"degraded_summary\\",\\"partial_ledger\\":true\\x7d\\n${escapeRegex(VCC_SOURCE_STATUS_END)}$`)
  const match = pattern.exec(text)
  if (!match) return
  return { version: 1, mode: "hybrid", complete: false, reason: match[1] as VccSourceIncompleteReason, manifest_digest: match[2]!, attempt_digest: match[3]!, outcome: "degraded_summary", partial_ledger: true }
}

export function renderVccProjection(input: Omit<VccProjectionMarker, "version" | "mode" | "source_complete">) {
  if (!isDigest(input.source_manifest_digest) || !isDigest(input.source_index_digest) || !isDigest(input.archive_manifest_digest) || !isDigest(input.candidate_digest) || (input.patch_digest !== null && !isDigest(input.patch_digest))) return
  const line = `{"version":1,"mode":"hybrid","source_complete":true,"source_manifest_digest":${JSON.stringify(input.source_manifest_digest)},"source_index_digest":${JSON.stringify(input.source_index_digest)},"archive_manifest_digest":${JSON.stringify(input.archive_manifest_digest)},"candidate_digest":${JSON.stringify(input.candidate_digest)},"patch_digest":${input.patch_digest === null ? "null" : JSON.stringify(input.patch_digest)}}`
  const block = `${VCC_PROJECTION_START}\n${line}\n${VCC_PROJECTION_END}`
  return utf8Bytes(block) <= VCC_PROJECTION_MAX_BYTES ? block : undefined
}

export function parseVccProjection(text: string): VccProjectionMarker | undefined {
  if (typeof text !== "string" || utf8Bytes(text) > VCC_PROJECTION_MAX_BYTES) return
  const pattern = new RegExp(`^${escapeRegex(VCC_PROJECTION_START)}\\n\\x7b\\"version\\":1,\\"mode\\":\\"hybrid\\",\\"source_complete\\":true,\\"source_manifest_digest\\":\\"([a-f0-9]{64})\\",\\"source_index_digest\\":\\"([a-f0-9]{64})\\",\\"archive_manifest_digest\\":\\"([a-f0-9]{64})\\",\\"candidate_digest\\":\\"([a-f0-9]{64})\\",\\"patch_digest\\":(null|\\"([a-f0-9]{64})\\")\\x7d\\n${escapeRegex(VCC_PROJECTION_END)}$`)
  const match = pattern.exec(text)
  if (!match) return
  return { version: 1, mode: "hybrid", source_complete: true, source_manifest_digest: match[1]!, source_index_digest: match[2]!, archive_manifest_digest: match[3]!, candidate_digest: match[4]!, patch_digest: match[6] ?? null }
}

export function isVccSuccessfulSummary(summary: string, expected: VccSuccessfulSummaryExpected) {
  if (typeof summary !== "string" || summary.includes(VCC_SOURCE_STATUS_START) || summary.includes(VCC_SOURCE_STATUS_END)) return false
  const value = summary.trimEnd()
  const projectionBlock = extractUniqueBlock(value, VCC_PROJECTION_START, VCC_PROJECTION_END)
  if (!projectionBlock) return false
  const projection = parseVccProjection(projectionBlock.block)
  if (!projection || !matchesExpected(projection, expected)) return false
  const ledger = parsePluginLedger(value)
  if (!ledger || !value.endsWith(ledger.block)) return false
  const ledgerIndex = value.lastIndexOf(ledger.block)
  return ledgerIndex > projectionBlock.end
}

function matchesExpected(projection: VccProjectionMarker, expected: VccSuccessfulSummaryExpected) {
  return isDigest(expected.source_manifest_digest) && isDigest(expected.source_index_digest) && isDigest(expected.archive_manifest_digest) && isDigest(expected.candidate_digest) && (expected.patch_digest === null || isDigest(expected.patch_digest)) && projection.source_manifest_digest === expected.source_manifest_digest && projection.source_index_digest === expected.source_index_digest && projection.archive_manifest_digest === expected.archive_manifest_digest && projection.candidate_digest === expected.candidate_digest && projection.patch_digest === expected.patch_digest
}

function extractUniqueBlock(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start)
  const endIndex = text.indexOf(end)
  if (startIndex < 0 || endIndex <= startIndex || text.indexOf(start, startIndex + start.length) >= 0 || text.indexOf(end, endIndex + end.length) >= 0) return
  return { block: text.slice(startIndex, endIndex + end.length), start: startIndex, end: endIndex + end.length }
}

function requireBoundedID(value: string, name: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || utf8Bytes(value) > 4_096) throw new TypeError(`${name} must be non-empty and bounded`)
}

function requireDigest(value: string, name: string) {
  if (!isDigest(value)) throw new TypeError(`${name} must be lowercase sha256`)
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}
