import { sha256, utf8Bytes } from "./ledger.js"
import { canonicalEventId, canonicalSerialize, type VccHost } from "./vcc.js"

export type VccArchiveBytes = string | Uint8Array

export type VccArchiveHandleMetadata = {
  version: 1
  handle: string
  host: VccHost
  session_id: string
  lineage_id: string
  stable_source_id: string
  canonical_source_kind: string
  stable_source_identity: string
  scope_digest: string
  source_digest: string
  payload_digest: string
  source_byte_count: number
  payload_byte_count: number
}

export type VccArchiveHandleParts = {
  version: 1
  host: VccHost
  scope_digest: string
  source_digest: string
  payload_digest: string
}

export type VccArchiveVerification =
  | {
      valid: true
      handle: string
      host: VccHost
      session_id: string
      lineage_id: string
      stable_source_id: string
      scope_digest: string
      source_digest: string
      payload_digest: string
      payload_bytes: VccArchiveBytes
      payload_byte_count: number
    }
  | {
      valid: false
      reason: "malformed_handle" | "invalid_identity" | "invalid_bytes" | "invalid_bound" | "oversized" | "scope_mismatch" | "source_mismatch" | "payload_mismatch"
    }

export function createVccArchiveHandle(input: {
  host: VccHost
  session_id: string
  lineage_id: string
  stable_source_id: string
  canonical_source_kind?: string
  stable_source_identity?: string
  source_bytes: VccArchiveBytes
  payload_bytes: VccArchiveBytes
}): VccArchiveHandleMetadata {
  validateIdentity(input.host, input.session_id, input.lineage_id, input.stable_source_id)
  const canonical_source_kind = input.canonical_source_kind ?? "event"
  const stable_source_identity = input.stable_source_identity ?? input.stable_source_id
  validateSourceIdentity(canonical_source_kind, stable_source_identity)
  const payload_digest = digestBytes(input.payload_bytes)
  const scope_digest = scopeDigest(input.host, input.session_id, input.lineage_id)
  const source_identity_digest = sourceDigest(canonical_source_kind, stable_source_identity)
  return {
    version: 1,
    handle: `archive:v1:${input.host}:${scope_digest}:${source_identity_digest}:${payload_digest}`,
    host: input.host,
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    stable_source_id: input.stable_source_id,
    scope_digest,
    source_digest: source_identity_digest,
    payload_digest,
    canonical_source_kind,
    stable_source_identity,
    source_byte_count: byteCount(input.source_bytes),
    payload_byte_count: byteCount(input.payload_bytes),
  }
}

export function parseVccArchiveHandle(handle: string): VccArchiveHandleParts | undefined {
  if (typeof handle !== "string") return
  const match = /^archive:v1:(pi|opencode-v1):([a-f0-9]{64}):([a-f0-9]{64}):([a-f0-9]{64})$/u.exec(handle)
  if (!match) return
  return { version: 1, host: match[1] as VccHost, scope_digest: match[2]!, source_digest: match[3]!, payload_digest: match[4]! }
}

export function verifyVccArchive(input: {
  handle: string
  host: VccHost
  session_id: string
  lineage_id: string
  stable_source_id: string
  canonical_source_kind?: string
  stable_source_identity?: string
  source_bytes: VccArchiveBytes
  payload_bytes: VccArchiveBytes
  max_bytes?: number
}): VccArchiveVerification {
  const parts = parseVccArchiveHandle(input.handle)
  if (!parts) return { valid: false, reason: "malformed_handle" }
  try {
    validateIdentity(input.host, input.session_id, input.lineage_id, input.stable_source_id)
    const canonical_source_kind = input.canonical_source_kind ?? "event"
    const stable_source_identity = input.stable_source_identity ?? input.stable_source_id
    validateSourceIdentity(canonical_source_kind, stable_source_identity)
    if (!isBytes(input.source_bytes) || !isBytes(input.payload_bytes)) return { valid: false, reason: "invalid_bytes" }
    if (input.max_bytes !== undefined && (!Number.isSafeInteger(input.max_bytes) || input.max_bytes <= 0)) return { valid: false, reason: "invalid_bound" }
  } catch {
    return { valid: false, reason: "invalid_identity" }
  }
  const source_byte_count = byteCount(input.source_bytes)
  const payload_byte_count = byteCount(input.payload_bytes)
  if (input.max_bytes !== undefined && source_byte_count + payload_byte_count > input.max_bytes) return { valid: false, reason: "oversized" }
  if (parts.host !== input.host) return { valid: false, reason: "scope_mismatch" }
  const expected_scope_digest = scopeDigest(input.host, input.session_id, input.lineage_id)
  if (parts.scope_digest !== expected_scope_digest) return { valid: false, reason: "scope_mismatch" }
  const canonical_source_kind = input.canonical_source_kind ?? "event"
  const stable_source_identity = input.stable_source_identity ?? input.stable_source_id
  const source_digest = sourceDigest(canonical_source_kind, stable_source_identity)
  if (parts.source_digest !== source_digest) return { valid: false, reason: "source_mismatch" }
  const payload_digest = digestBytes(input.payload_bytes)
  if (parts.payload_digest !== payload_digest) return { valid: false, reason: "payload_mismatch" }
  return {
    valid: true,
    handle: input.handle,
    host: input.host,
    session_id: input.session_id,
    lineage_id: input.lineage_id,
    stable_source_id: input.stable_source_id,
    scope_digest: expected_scope_digest,
    source_digest,
    payload_digest,
    payload_bytes: copyBytes(input.payload_bytes),
    payload_byte_count,
  }
}

function validateIdentity(host: VccHost, session_id: string, lineage_id: string, stable_source_id: string) {
  canonicalEventId(host, stable_source_id)
  requireBoundedText(session_id, "session_id")
  requireBoundedText(lineage_id, "lineage_id")
}

function scopeDigest(host: VccHost, session_id: string, lineage_id: string) {
  return sha256(`vcc-scope-v1\0${host}\0${session_id}\0${lineage_id}`)
}

function sourceDigest(canonical_source_kind: string, stable_source_identity: string) {
  return sha256(`vcc-source-v1\0${canonical_source_kind}\0${stable_source_identity}`)
}

function digestBytes(value: VccArchiveBytes) {
  if (typeof value === "string") return sha256(value)
  if (value instanceof Uint8Array) return new Bun.CryptoHasher("sha256").update(value).digest("hex")
  throw new TypeError("archive bytes must be a string or Uint8Array")
}

function byteCount(value: VccArchiveBytes) {
  if (typeof value === "string") return utf8Bytes(value)
  if (value instanceof Uint8Array) return value.byteLength
  throw new TypeError("archive bytes must be a string or Uint8Array")
}

function copyBytes(value: VccArchiveBytes): VccArchiveBytes {
  return typeof value === "string" ? value : new Uint8Array(value)
}

function isBytes(value: unknown): value is VccArchiveBytes {
  return typeof value === "string" || value instanceof Uint8Array
}

function requireBoundedText(value: string, name: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || utf8Bytes(value) > 4_096) throw new TypeError(`${name} must be non-empty and bounded`)
}

function validateSourceIdentity(canonical_source_kind: string, stable_source_identity: string) {
  requireBoundedText(canonical_source_kind, "canonical_source_kind")
  requireBoundedText(stable_source_identity, "stable_source_identity")
}
