import { describe, expect, test } from "bun:test"
import {
  MAX_VCC_ATTEMPTS,
  VCC_ATTEMPT_TTL_MS,
  VccAttemptStore,
  validateVccAttempt,
  type VccAttempt,
} from "../src/state.js"
import { sha256 } from "../src/ledger.js"

const digest = (value: string) => sha256(value)

function completeAttempt(index = 0): VccAttempt {
  return {
    attemptID: `attempt-${index}`,
    sessionID: `session-${index}`,
    lineageID: `lineage-${index}`,
    compactionTargetID: `target-${index}`,
    summaryMessageID: null,
    textPartID: null,
    mode: "hybrid",
    createdAt: index,
    sourceComplete: true,
    sourceReason: null,
    manifestDigest: digest("manifest"),
    sourceIndexDigest: digest("index"),
    docketDigest: digest("docket"),
    candidateDigest: digest("candidate"),
    patchDigest: null,
    outcome: "candidate_ready",
    validation: "pending",
  }
}

describe("bounded OpenCode VCC attempt metadata", () => {
  test("validates complete and incomplete metadata without transcript fields", () => {
    const complete = completeAttempt()
    expect(validateVccAttempt(complete)).toEqual(complete)
    expect(validateVccAttempt({
      ...complete,
      sourceComplete: false,
      sourceReason: "fetch_error",
      sourceIndexDigest: null,
      docketDigest: null,
      candidateDigest: null,
      outcome: "source_incomplete",
    })).toMatchObject({ sourceComplete: false, sourceReason: "fetch_error" })
    expect(validateVccAttempt({ ...complete, text: "secret transcript" })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, manifestDigest: "A".repeat(64) })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, sourceComplete: false, sourceReason: null })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, outcome: "vcc_success", sourceComplete: false, sourceReason: "byte_limit" })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, candidateDigest: null, patchDigest: digest("patch") })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, sourceComplete: false, sourceReason: "fetch_error", sourceIndexDigest: null, docketDigest: null, candidateDigest: digest("candidate"), outcome: "source_incomplete" })).toBeUndefined()
    expect(validateVccAttempt({ ...complete, sessionID: "token=sk-12345678901234567890" })).toBeUndefined()
  })

  test("matches every binding dimension and replaces stale same-session attempts", () => {
    const store = new VccAttemptStore()
    const first = completeAttempt()
    store.set(first)
    expect(store.get(first.attemptID, { sessionID: first.sessionID, lineageID: first.lineageID, compactionTargetID: first.compactionTargetID }, 10)).toEqual(first)
    expect(store.get(first.attemptID, { sessionID: "other", lineageID: first.lineageID, compactionTargetID: first.compactionTargetID }, 10)).toBeUndefined()
    expect(store.get(first.attemptID, { sessionID: first.sessionID, lineageID: "other", compactionTargetID: first.compactionTargetID }, 10)).toBeUndefined()
    expect(store.get(first.attemptID, { sessionID: first.sessionID, lineageID: first.lineageID, compactionTargetID: "other" }, 10)).toBeUndefined()

    const newer = { ...first, attemptID: "attempt-new", compactionTargetID: "target-new", createdAt: 10 }
    store.set(newer)
    expect(store.get(first.attemptID, undefined, 10)).toBeUndefined()
    expect(store.get(newer.attemptID, undefined, 10)?.compactionTargetID).toBe("target-new")
    expect(store.size).toBe(1)
  })

  test("bounds retention and expires metadata at the thirty-day boundary", () => {
    const store = new VccAttemptStore()
    for (const index of Array.from({ length: MAX_VCC_ATTEMPTS + 1 }, (_, value) => value)) store.set(completeAttempt(index))
    expect(store.size).toBe(MAX_VCC_ATTEMPTS)
    expect(store.get("attempt-0", undefined, MAX_VCC_ATTEMPTS)).toBeUndefined()
    expect(store.get(`attempt-${MAX_VCC_ATTEMPTS}`, undefined, MAX_VCC_ATTEMPTS)?.attemptID).toBe(`attempt-${MAX_VCC_ATTEMPTS}`)

    const expiring = completeAttempt(10_000)
    store.set(expiring)
    expect(store.get(expiring.attemptID, undefined, expiring.createdAt + VCC_ATTEMPT_TTL_MS - 1)).toBeDefined()
    expect(store.get(expiring.attemptID, undefined, expiring.createdAt + VCC_ATTEMPT_TTL_MS)).toBeUndefined()
  })
})
