import { describe, expect, test } from "bun:test"
import { canonicalLedger, type RecoveryLedgerData } from "../src/ledger.js"
import { ATTEMPT_TTL_MS, AttemptStore, MAX_ATTEMPTS, type Attempt } from "../src/state.js"

const EMPTY_DATA: RecoveryLedgerData = {
  recent_requests: [],
  constraints: [],
  todos: [],
  touched_paths: [],
  tool_statuses: [],
  errors: [],
  evidence: [],
  next_actions: [],
  legacy_context: [],
}

function attempt(sessionID: string, createdAt: number): Attempt {
  return {
    sessionID,
    createdAt,
    ledger: canonicalLedger(EMPTY_DATA),
    validation: "pending",
  }
}

describe("bounded active-attempt state", () => {
  test("isolates records by Session ID and expires them at the 30-minute boundary", () => {
    const store = new AttemptStore()
    store.set(attempt("first", 1_000))
    store.set(attempt("second", 2_000))

    expect(store.get("first", 1_000 + ATTEMPT_TTL_MS - 1)?.sessionID).toBe("first")
    expect(store.get("second", 1_000 + ATTEMPT_TTL_MS - 1)?.sessionID).toBe("second")
    expect(store.get("first", 1_000 + ATTEMPT_TTL_MS)).toBeUndefined()
    expect(store.get("second", 1_000 + ATTEMPT_TTL_MS)).toBeDefined()
  })

  test("evicts the oldest insertion when the bounded store reaches capacity", () => {
    const store = new AttemptStore()
    for (const index of Array.from({ length: MAX_ATTEMPTS + 1 }, (_, index) => index)) {
      store.set(attempt(`session-${index}`, index))
    }

    expect(store.size).toBe(MAX_ATTEMPTS)
    expect(store.get("session-0", MAX_ATTEMPTS)).toBeUndefined()
    expect(store.get(`session-${MAX_ATTEMPTS}`, MAX_ATTEMPTS)?.sessionID).toBe(`session-${MAX_ATTEMPTS}`)
  })

  test("supports targeted deletion and complete disposal", () => {
    const store = new AttemptStore()
    store.set(attempt("first", 0))
    store.set(attempt("second", 0))
    store.delete("first")
    expect(store.get("first", 0)).toBeUndefined()
    expect(store.size).toBe(1)

    store.clear()
    expect(store.size).toBe(0)
  })
})
