import { redact, utf8Bytes, type RecoveryLedger } from "./ledger.js"
import type { ProjectedSummary } from "./projection.js"
import { VCC_SOURCE_INCOMPLETE_REASONS, type VccSourceIncompleteReason } from "./vcc.js"

export const ATTEMPT_TTL_MS = 30 * 60 * 1_000
export const MAX_ATTEMPTS = 128
export const VCC_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const MAX_VCC_ATTEMPTS = 1_024

const VCC_ATTEMPT_KEYS = [
  "attemptID",
  "sessionID",
  "lineageID",
  "compactionTargetID",
  "summaryMessageID",
  "textPartID",
  "mode",
  "createdAt",
  "sourceComplete",
  "sourceReason",
  "manifestDigest",
  "sourceIndexDigest",
  "docketDigest",
  "candidateDigest",
  "patchDigest",
  "outcome",
  "validation",
] as const

export const VCC_ATTEMPT_OUTCOMES = [
  "pending",
  "source_incomplete",
  "candidate_ready",
  "vcc_success",
  "degraded_summary",
  "fallback",
  "no_text",
  "invalid",
] as const
export type VccAttemptOutcome = (typeof VCC_ATTEMPT_OUTCOMES)[number]

export const VCC_ATTEMPT_VALIDATIONS = ["pending", "provider", "fallback", "invalid"] as const
export type VccAttemptValidation = (typeof VCC_ATTEMPT_VALIDATIONS)[number]

export type VccAttempt = {
  attemptID: string
  sessionID: string
  lineageID: string
  compactionTargetID: string
  summaryMessageID: string | null
  textPartID: string | null
  mode: "hybrid"
  createdAt: number
  sourceComplete: boolean
  sourceReason: VccSourceIncompleteReason | null
  manifestDigest: string
  sourceIndexDigest: string | null
  docketDigest: string | null
  candidateDigest: string | null
  patchDigest: string | null
  outcome: VccAttemptOutcome
  validation: VccAttemptValidation
}

export type VccAttemptBinding = Pick<VccAttempt, "sessionID" | "lineageID" | "compactionTargetID">

export type Attempt = {
  sessionID: string
  createdAt: number
  ledger: RecoveryLedger
  projection?: ProjectedSummary
  summaryMessageID?: string
  textPartID?: string
  validation: "pending" | "provider" | "fallback" | "invalid"
  recoveryUserID?: string
  recoveryComplete?: boolean
}

export class AttemptStore {
  #attempts = new Map<string, Attempt>()

  get(sessionID: string, now = Date.now()) {
    this.cleanupExpired(now)
    return this.#attempts.get(sessionID)
  }

  set(attempt: Attempt) {
    this.cleanupExpired(attempt.createdAt)
    this.#attempts.delete(attempt.sessionID)
    this.#attempts.set(attempt.sessionID, attempt)
    while (this.#attempts.size > MAX_ATTEMPTS) {
      const oldest = this.#attempts.keys().next().value
      if (!oldest) break
      this.#attempts.delete(oldest)
    }
    return attempt
  }

  delete(sessionID: string | undefined) {
    if (sessionID) this.#attempts.delete(sessionID)
  }

  clear() {
    this.#attempts.clear()
  }

  cleanupExpired(now = Date.now()) {
    for (const [sessionID, attempt] of this.#attempts) {
      if (now - attempt.createdAt >= ATTEMPT_TTL_MS) this.#attempts.delete(sessionID)
    }
  }

  get size() {
    return this.#attempts.size
  }
}

/** Validate the transport-safe VCC attempt record. It intentionally has no
 * ledger, candidate, source text, error text, or provider response fields. */
export function validateVccAttempt(value: unknown): VccAttempt | undefined {
  if (!isRecord(value) || Object.keys(value).join("\n") !== VCC_ATTEMPT_KEYS.join("\n")) return
  const createdAt = value.createdAt
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) return
  if (
    !boundedID(value.attemptID) ||
    !boundedID(value.sessionID) ||
    !boundedID(value.lineageID) ||
    !boundedID(value.compactionTargetID) ||
    !boundedIDOrNull(value.summaryMessageID) ||
    !boundedIDOrNull(value.textPartID) ||
    value.mode !== "hybrid" ||
    typeof value.sourceComplete !== "boolean" ||
    !validReason(value.sourceReason) ||
    !isDigest(value.manifestDigest) ||
    !isDigestOrNull(value.sourceIndexDigest) ||
    !isDigestOrNull(value.docketDigest) ||
    !isDigestOrNull(value.candidateDigest) ||
    !isDigestOrNull(value.patchDigest) ||
    !VCC_ATTEMPT_OUTCOMES.includes(value.outcome as VccAttemptOutcome) ||
    !VCC_ATTEMPT_VALIDATIONS.includes(value.validation as VccAttemptValidation)
  ) return
  if (value.sourceComplete && value.sourceReason !== null) return
  if (!value.sourceComplete && value.sourceReason === null) return
  if (!value.sourceComplete && (value.sourceIndexDigest !== null || value.docketDigest !== null || value.candidateDigest !== null || value.patchDigest !== null)) return
  if (value.patchDigest !== null && value.candidateDigest === null) return
  if (["candidate_ready", "vcc_success"].includes(value.outcome as string) && value.candidateDigest === null) return
  if (value.outcome === "vcc_success" && !value.sourceComplete) return
  if (value.sourceComplete && ["source_incomplete", "degraded_summary"].includes(value.outcome as string)) return
  return { ...value } as VccAttempt
}

/** A bounded process-local store for VCC metadata. A newer attempt replaces
 * older attempts for the same session, so stale target state cannot apply. */
export class VccAttemptStore {
  #attempts = new Map<string, VccAttempt>()

  get(attemptID: string, binding?: VccAttemptBinding, now = Date.now()) {
    this.cleanupExpired(now)
    const attempt = this.#attempts.get(attemptID)
    if (!attempt || (binding && !matchesBinding(attempt, binding))) return
    return { ...attempt }
  }

  getSession(sessionID: string, now = Date.now()) {
    this.cleanupExpired(now)
    return [...this.#attempts.values()].find((attempt) => attempt.sessionID === sessionID)
  }

  set(value: VccAttempt) {
    const attempt = validateVccAttempt(value)
    if (!attempt) throw new TypeError("invalid VCC attempt metadata")
    this.cleanupExpired(attempt.createdAt)
    for (const [attemptID, existing] of this.#attempts) {
      if (existing.sessionID === attempt.sessionID && attemptID !== attempt.attemptID) this.#attempts.delete(attemptID)
    }
    this.#attempts.delete(attempt.attemptID)
    this.#attempts.set(attempt.attemptID, attempt)
    while (this.#attempts.size > MAX_VCC_ATTEMPTS) {
      const oldest = this.#attempts.keys().next().value
      if (!oldest) break
      this.#attempts.delete(oldest)
    }
    return { ...attempt }
  }

  delete(attemptID: string | undefined) {
    if (attemptID) this.#attempts.delete(attemptID)
  }

  deleteSession(sessionID: string | undefined) {
    if (!sessionID) return
    for (const [attemptID, attempt] of this.#attempts) {
      if (attempt.sessionID === sessionID) this.#attempts.delete(attemptID)
    }
  }

  clear() {
    this.#attempts.clear()
  }

  cleanupExpired(now = Date.now()) {
    for (const [attemptID, attempt] of this.#attempts) {
      if (now >= attempt.createdAt && now - attempt.createdAt >= VCC_ATTEMPT_TTL_MS) this.#attempts.delete(attemptID)
    }
  }

  get size() {
    return this.#attempts.size
  }
}

function matchesBinding(attempt: VccAttempt, binding: VccAttemptBinding) {
  return attempt.sessionID === binding.sessionID && attempt.lineageID === binding.lineageID && attempt.compactionTargetID === binding.compactionTargetID
}

function validReason(value: unknown): value is VccSourceIncompleteReason | null {
  return value === null || (typeof value === "string" && VCC_SOURCE_INCOMPLETE_REASONS.includes(value as VccSourceIncompleteReason))
}

function isDigestOrNull(value: unknown): value is string | null {
  return value === null || isDigest(value)
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
}

function boundedID(value: unknown) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && utf8Bytes(value) <= 512 && redact(value) === value
}

function boundedIDOrNull(value: unknown) {
  return value === null || boundedID(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
