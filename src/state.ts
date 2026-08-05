import type { RecoveryLedger } from "./ledger.js"
import type { ProjectedSummary } from "./projection.js"

export const ATTEMPT_TTL_MS = 30 * 60 * 1_000
export const MAX_ATTEMPTS = 128

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
