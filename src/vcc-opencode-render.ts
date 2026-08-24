import { parsePluginLedger, buildAuthoritativeSummary, REQUIRED_SECTIONS } from "./validation.js"
import { canonicalSerialize, type VccCandidate } from "./vcc.js"
import {
  renderVccProjection,
  renderVccSourceStatus,
  VCC_PROJECTION_END,
  VCC_PROJECTION_START,
  VCC_SOURCE_STATUS_END,
  VCC_SOURCE_STATUS_START,
  isVccSuccessfulSummary,
  type VccSourceStatus,
} from "./vcc-wire.js"
import { canonicalLedger, redact, sha256, utf8Bytes, type RecoveryLedger } from "./ledger.js"

export const VCC_CANDIDATE_START = "<!-- opencode-safe-compaction vcc-candidate v1 start -->"
export const VCC_CANDIDATE_END = "<!-- opencode-safe-compaction vcc-candidate v1 end -->"

type RenderStatusInput = Omit<VccSourceStatus, "version" | "mode" | "complete" | "outcome" | "partial_ledger">

export type VccOpenCodeProjectionRenderInput = {
  candidate: VccCandidate
  patch_digest: string | null
  archive_manifest_digest: string
  ledger: RecoveryLedger
  max_bytes: number
}

export type VccOpenCodeDegradedRenderInput = {
  ledger: RecoveryLedger
  status: RenderStatusInput
  max_bytes: number
}

/**
 * Render a complete candidate as host-compatible text. The candidate is kept
 * byte-for-byte inside a bounded transport block; only the projection marker
 * and legacy ledger are interpreted by the host validators.
 */
export function renderVccOpenCodeProjection(input: VccOpenCodeProjectionRenderInput) {
  if (!validLimit(input.max_bytes) || !validLedger(input.ledger)) return
  if (!validCandidate(input.candidate)) return
  if (!isDigest(input.archive_manifest_digest) || !isDigestOrNull(input.patch_digest)) return
  const marker = renderVccProjection({
    source_manifest_digest: input.candidate.source_manifest_digest,
    source_index_digest: input.candidate.source_index_digest,
    archive_manifest_digest: input.archive_manifest_digest,
    candidate_digest: input.candidate.digest,
    patch_digest: input.patch_digest,
  })
  if (!marker) return
  let legacy: string
  try {
    legacy = buildAuthoritativeSummary({ ledger: input.ledger, maxBytes: input.max_bytes })
  } catch {
    return
  }
  const prefix = legacy.slice(0, -input.ledger.block.length).trimEnd()
  if (!prefix || !prefix.startsWith("## Goal\n")) return
  const candidateBlock = `${VCC_CANDIDATE_START}\n${input.candidate.bytes.trimEnd()}\n${VCC_CANDIDATE_END}`
  const result = `${prefix}\n\n${candidateBlock}\n\n${marker}\n\n${input.ledger.block}`
  const expected = {
    source_manifest_digest: input.candidate.source_manifest_digest,
    source_index_digest: input.candidate.source_index_digest,
    archive_manifest_digest: input.archive_manifest_digest,
    candidate_digest: input.candidate.digest,
    patch_digest: input.patch_digest,
  }
  return utf8Bytes(result) <= input.max_bytes && isVccSuccessfulSummary(result, expected) ? result : undefined
}

/**
 * Render a source-incomplete result without allowing it to look like a
 * successful VCC projection. Every visible recovery item is explicitly
 * labelled partial, the status marker follows the final heading, and the
 * verified legacy ledger remains the final marked block.
 */
export function renderVccOpenCodeDegraded(input: VccOpenCodeDegradedRenderInput) {
  if (!validLimit(input.max_bytes) || !validLedger(input.ledger)) return
  if (!exactStatusKeys(input.status)) return
  const status = renderVccSourceStatus(input.status)
  if (!status) return
  let base: string
  try {
    base = buildAuthoritativeSummary({ ledger: input.ledger, maxBytes: input.max_bytes })
  } catch {
    base = ""
  }
  const prefix = base.slice(0, -input.ledger.block.length).trimEnd()
  const labeled = labelPartialSource(prefix)
  const result = `${labeled}\n\n- partial source: VCC source is incomplete; recover exact material before acting.\n- partial source: auto-continuation is disabled for this degraded result.\n${status}\n\n${input.ledger.block}`
  if (utf8Bytes(result) <= input.max_bytes && validEightHeadingSummary(result, input.ledger)) return result

  const minimal = REQUIRED_SECTIONS.map((heading) => `## ${heading}\n- partial source: verify the canonical source before continuing.`).join("\n\n")
  const bounded = `${minimal}\n\n${status}\n\n${input.ledger.block}`
  return utf8Bytes(bounded) <= input.max_bytes && validEightHeadingSummary(bounded, input.ledger) ? bounded : undefined
}

function validCandidate(candidate: VccCandidate) {
  try {
    if (
      candidate.version !== 1 ||
      typeof candidate.bytes !== "string" ||
      !isDigest(candidate.digest) ||
      sha256(candidate.bytes) !== candidate.digest ||
      redact(candidate.bytes) !== candidate.bytes ||
      containsReservedMarkers(candidate.bytes)
    ) return false
    const parsed = JSON.parse(candidate.bytes) as unknown
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || canonicalSerialize(parsed) !== candidate.bytes) return false
    const body = parsed as { version?: unknown; kind?: unknown; source_complete?: unknown; source_manifest_digest?: unknown; source_index_digest?: unknown }
    return body.version === 1 && body.kind === "vcc_candidate" && body.source_complete === true && body.source_manifest_digest === candidate.source_manifest_digest && body.source_index_digest === candidate.source_index_digest && isDigest(candidate.source_manifest_digest) && isDigest(candidate.source_index_digest)
  } catch {
    return false
  }
}

function validLedger(ledger: RecoveryLedger) {
  try {
    if (typeof ledger.block !== "string" || typeof ledger.body !== "string" || redact(ledger.block) !== ledger.block || containsReservedMarkers(ledger.block)) return false
    const parsed = parsePluginLedger(ledger.block)
    if (!parsed || parsed.block !== ledger.block || parsed.digest !== ledger.digest || parsed.body !== ledger.body) return false
    return canonicalLedger(ledger.data).body === parsed.body
  } catch {
    return false
  }
}

function validEightHeadingSummary(value: string, ledger: RecoveryLedger) {
  const parsed = parsePluginLedger(value)
  if (!parsed || parsed.block !== ledger.block) return false
  const headings = [...value.slice(0, -ledger.block.length).matchAll(/^## (.+)$/gm)].map((match) => match[1])
  return headings.length === REQUIRED_SECTIONS.length && headings.every((heading, index) => heading === REQUIRED_SECTIONS[index])
}

function labelPartialSource(value: string) {
  return value.split("\n").map((line) => line.startsWith("- ") ? `- partial source: ${line.slice(2)}` : line).join("\n")
}

function exactStatusKeys(value: RenderStatusInput) {
  return Object.keys(value).join("\n") === "reason\nmanifest_digest\nattempt_digest"
}

function containsReservedMarkers(value: string) {
  return [
    VCC_CANDIDATE_START,
    VCC_CANDIDATE_END,
    VCC_PROJECTION_START,
    VCC_PROJECTION_END,
    VCC_SOURCE_STATUS_START,
    VCC_SOURCE_STATUS_END,
  ].some((marker) => value.includes(marker))
}

function validLimit(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
}

function isDigestOrNull(value: unknown): value is string | null {
  return value === null || isDigest(value)
}
