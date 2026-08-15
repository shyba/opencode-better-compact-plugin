import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { configPaths, validateConfig } from "../src/config.js"
import { CONTROL_RECORD_KINDS, openSyncState } from "../src/sync-state.js"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("portable better-compact state", () => {
  test("resolves stable XDG paths without package-relative state", () => {
    const paths = configPaths({ HOME: "/home/test", XDG_CONFIG_HOME: "/config", XDG_STATE_HOME: "/state" })
    expect(paths.config).toBe("/config/better-compact/config.json")
    expect(paths.state).toBe("/state/better-compact/state.sqlite")
    expect(paths.logs).toBe("/state/better-compact/logs")
  })

  test("validates the versioned config and rejects unknown keys", () => {
  expect(validateConfig({ version: 1, sync: {}, sources: [], installation: { name: "server" } })).toMatchObject({ installation: { name: "server" }, sync: { keep_remote_on_missing: false, allow_source_shrink: false }, rag: { model: "BAAI/bge-small-en-v1.5", backend: "auto", compute_dtype: "bfloat16", length_bucketing: true, chunk_tokens: 512, overlap: 64, batch_size: 16, message_batch_size: 2048, full_sweep_interval_seconds: 900, enabled: false } })
  expect(() => validateConfig({ version: 1, sync: { unknown: true }, sources: [] })).toThrow("unknown key")
  expect(() => validateConfig({ version: 1, sync: {}, rag: { overlap: 512 }, sources: [] })).toThrow("rag.overlap")
  expect(() => validateConfig({ version: 1, sync: {}, rag: { backend: "cuda" }, sources: [] })).toThrow("rag.backend")
  expect(() => validateConfig({ version: 1, sync: {}, rag: { compute_dtype: "float16" }, sources: [] })).toThrow("rag.compute_dtype")
  expect(() => validateConfig({ version: 1, sync: {}, rag: { backend: "onnx", compute_dtype: "bfloat16" }, sources: [] })).toThrow("requires rag.backend")
  expect(validateConfig({ version: 1, sync: {}, rag: { model_path: "/models/bge", compute_dtype: "bfloat16" }, sources: [] })).toMatchObject({ rag: { backend: "auto", compute_dtype: "bfloat16", model_path: "/models/bge" } })
  expect(() => validateConfig({ version: 1, sync: {}, rag: { length_bucketing: "yes" }, sources: [] })).toThrow("rag.length_bucketing")
  expect(validateConfig({ version: 1, sync: {}, rag: { backend: "torch", compute_dtype: "bfloat16", length_bucketing: false }, sources: [] })).toMatchObject({ rag: { backend: "torch", compute_dtype: "bfloat16", length_bucketing: false } })
  expect(() => validateConfig({ version: 1, sync: {}, sources: [{ kind: "fixture", database: "db", extra: true }] })).toThrow("source contains an unknown key")
  })

  test("enqueues, leases, and acknowledges records transactionally", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1", "test")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    state.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: '{"text":"safe"}', payloadSHA256: "hash-1", recordRevision: 1, observedAt: 1 }], "source-1", "messages", { cursor: "m1" })
    const rows = state.claim("postgres", 10, 2)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operation).toBe("upsert")
    expect(rows[0]?.recordRevision).toBe(1)
    state.acknowledge(rows.map((row) => row.id))
    expect(state.claim("postgres", 10, 3)).toHaveLength(0)
    state.close()
  })

  test("does not replace a newer normalized record with an older revision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    state.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "new", payloadSHA256: "new", recordRevision: 2, observedAt: 2 }], "source-1", "messages", { cursor: "2" })
    state.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "old", payloadSHA256: "old", recordRevision: 1, observedAt: 1 }], "source-1", "messages", { cursor: "1" })
    const rows = state.claim("postgres", 10, 3)
    expect(rows.map((row) => row.recordRevision).sort()).toEqual([1, 2])
    state.close()
  })

  test("does not restage an unchanged observation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    const record = { sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "same", payloadSHA256: "same", observedAt: 1 }
    state.enqueue([record], "source-1", "messages", { cursor: "1" })
    state.enqueue([record], "source-1", "messages", { cursor: "2" })
    expect(state.pendingCount()).toBe(1)
    expect(state.nextRevision("source-1")).toBe(1)
    state.close()
  })

  test("creates tombstones only for a completed snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    const record = { sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "present", payloadSHA256: "present", recordRevision: 1, observedAt: 1 }
    state.enqueue([record], "source-1", "messages", { cursor: "1" })
    state.enqueue([], "source-1", "messages", { cursor: "2" }, "postgres", { complete: true, recordKinds: ["message"] })
    const rows = state.claim("postgres", 10, 3)
    expect(rows.some((row) => row.recordKind === CONTROL_RECORD_KINDS.snapshotBegin)).toBe(true)
    expect(rows.some((row) => row.recordKind === CONTROL_RECORD_KINDS.snapshotEnd)).toBe(true)
    state.close()
  })

  test("reconciles only the completed JSONL file prefix", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "codex-jsonl", schemaVersion: 1, locator: "fixture://jsonl", incarnation: "source-inc-1" })
    const records = [0, 1, 2].map((line) => ({ sourceID: "source-1", recordKind: "message", naturalKey: `session.jsonl|line:${line}`, payloadJSON: JSON.stringify({ line }), payloadSHA256: `hash-${line}`, observedAt: line + 1 }))
    state.enqueue(records, "source-1", "messages", { cursor: 3 })
    state.enqueue([], "source-1", "messages", { cursor: 2 }, "postgres", { prefixes: [{ prefix: "session.jsonl|", lineCount: 2, recordKinds: ["session", "message"] }] })
    const rows = state.claim("postgres", 10, 3)
    expect(rows.some((row) => row.recordKind === CONTROL_RECORD_KINDS.reconcilePrefix && row.naturalKey === "session.jsonl|")).toBe(true)
    state.close()
  })

  test("keeps failed rows retryable and refuses revision gaps", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    state.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "one", payloadSHA256: "one", observedAt: 1 }], "source-1", "messages", {})
    const rows = state.claim("postgres", 10, 2, 60_000, "source-1", 0)
    state.fail(rows.map((row) => row.id), "temporary", 3)
    expect(state.claim("postgres", 10, 2, 60_000, "source-1", 0)).toHaveLength(0)
    expect(state.claim("postgres", 10, 3, 60_000, "source-1", 0)).toHaveLength(1)
    state.close()
  })

  test("reconciles a committed remote prefix after a local acknowledgement crash", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    state.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "one", payloadSHA256: "one", observedAt: 1 }], "source-1", "messages", {})
    expect(state.reconcileCommitted("source-1", 1)).toBe(true)
    expect(state.remoteRevision("source-1")).toBe(1)
    expect(state.pendingCount()).toBe(0)
    state.close()
  })

  test("throttles remote tombstone maintenance across restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const filename = path.join(directory, "state.sqlite")
    const state = await openSyncState(filename)
    state.ensureInstallation("install-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    expect(state.remoteTombstonePurgeDue("source-1", 10_000, 1_000)).toBe(true)
    state.markRemoteTombstonePurge("source-1", 10_000)
    expect(state.remoteTombstonePurgeDue("source-1", 10_999, 1_000)).toBe(false)
    state.close()
    const reopened = await openSyncState(filename)
    expect(reopened.remoteTombstonePurgeDue("source-1", 11_000, 1_000)).toBe(true)
    reopened.close()
  })

  test("replays an expired lease after reopening the state database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const filename = path.join(directory, "state.sqlite")
    const first = await openSyncState(filename)
    first.ensureInstallation("install-1", "incarnation-1")
    first.upsertSource({ id: "source-1", installationID: "install-1", kind: "fixture", schemaVersion: 1, locator: "fixture://one", incarnation: "source-inc-1" })
    first.enqueue([{ sourceID: "source-1", recordKind: "message", naturalKey: "m1", payloadJSON: "one", payloadSHA256: "one", observedAt: 1 }], "source-1", "messages", {})
    first.claim("postgres", 1, 2, 10, "source-1", 0)
    first.close()
    const reopened = await openSyncState(filename)
    expect(reopened.claim("postgres", 1, 20, 10, "source-1", 0)).toHaveLength(1)
    reopened.close()
  })

  test("adopts the remote installation incarnation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    const installation = state.ensureDefaultInstallation()
    state.adoptInstallationIncarnation("remote-incarnation")
    expect(state.ensureDefaultInstallation()).toEqual({ id: installation.id, incarnation: "remote-incarnation" })
    state.close()
  })

  test("forces OpenCode checkpoints to rebuild without dropping the saved source counts", async () => {
    const filename = path.join(await mkdtemp(path.join(os.tmpdir(), "better-compact-state-")), "state.sqlite")
    const state = await openSyncState(filename)
    state.ensureInstallation("installation-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "installation-1", kind: "opencode-v1-sqlite", schemaVersion: 1, locator: "/tmp/opencode.db", incarnation: "source-incarnation-1" })
    state.enqueue([], "source-1", "messages", { sourceFingerprint: "10:2:3:4:5", sourceCounts: { sessions: 2, messages: 3, parts: 4, todos: 5 }, reconcileBefore: 123 }, "postgres")
    expect(state.forceReconcile(["source-1"])).toBe(1)
    expect(state.checkpoint("source-1")).toMatchObject({ sourceFingerprint: "10:2:3:4:5", sourceCounts: { sessions: 2, messages: 3, parts: 4, todos: 5 }, reconcileBefore: 0, forceReconcile: true })
    state.close()
    await rm(path.dirname(filename), { recursive: true, force: true })
  })

  test("records and skips a complete source scan by path fingerprint", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-state-"))
    temporary.push(directory)
    const state = await openSyncState(path.join(directory, "state.sqlite"))
    state.ensureInstallation("installation-1", "incarnation-1")
    state.upsertSource({ id: "source-1", installationID: "installation-1", kind: "opencode-v1-sqlite", schemaVersion: 1, locator: "/tmp/opencode.db", incarnation: "source-incarnation-1" })

    expect(state.shouldSkipSource("source-1", 1234, 567, 0)).toBe(false)
    state.recordSourceComplete("source-1", 1234, 567, 0)
    expect(state.shouldSkipSource("source-1", 1234, 567, 0)).toBe(true)
    expect(state.shouldSkipSource("source-1", 1235, 567, 0)).toBe(false)
    expect(state.shouldSkipSource("source-1", 1234, 568, 0)).toBe(false)
    expect(state.shouldSkipSource("source-2", 1234, 567, 0)).toBe(false)

    state.recordSourceComplete("source-1", 9999, 100, 200)
    expect(state.shouldSkipSource("source-1", 9999, 100, 200)).toBe(true)

    // The skip ages out so a shallow fingerprint cannot hide appends to deep
    // session files (or stall a drain) indefinitely.
    expect(state.shouldSkipSource("source-1", 9999, 100, 200, 3_600_000, Date.now())).toBe(true)
    expect(state.shouldSkipSource("source-1", 9999, 100, 200, 3_600_000, Date.now() + 3_600_000 - 5_000)).toBe(true)
    expect(state.shouldSkipSource("source-1", 9999, 100, 200, 3_600_000, Date.now() + 3_600_000 + 5_000)).toBe(false)
    // Without an age bound the old fingerprint-only behavior is preserved.
    expect(state.shouldSkipSource("source-1", 9999, 100, 200, undefined, Date.now() + 10 * 3_600_000)).toBe(true)
    state.close()
  })
})
