import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { configPaths, validateConfig } from "../src/config.js"
import { openSyncState } from "../src/sync-state.js"

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
    expect(validateConfig({ version: 1, sync: {}, sources: [], installation: { name: "server" } }).installation.name).toBe("server")
    expect(() => validateConfig({ version: 1, sync: { unknown: true }, sources: [] })).toThrow("unknown key")
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
    expect(rows.some((row) => row.operation === "delete" && row.naturalKey === "m1")).toBe(true)
    state.close()
  })
})
