import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discoverJsonl, inspectJsonl } from "../src/jsonl.js"

const temporary: string[] = []

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("streaming JSONL adapters", () => {
  test("discovers bounded Pi-style records and resumes by file/line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    await mkdir(path.join(root, "nested"))
    const filename = path.join(root, "nested", "session.jsonl")
    await writeFile(filename, [
      JSON.stringify({ type: "session", id: "pi-session", cwd: "/work", timestamp: "2026-08-07T12:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "keep this" }, timestamp: "2026-08-07T12:00:01.000Z" }),
      JSON.stringify({ type: "message", id: "m2", message: { role: "toolResult", content: "secret output", token: "sk-12345678901234567890" }, timestamp: "2026-08-07T12:00:02.000Z" }),
    ].join("\n") + "\n")

    const inspection = await inspectJsonl(root)
    expect(inspection.fileCount).toBe(1)
    expect(inspection.totalBytes).toBeGreaterThan(0)

    const first = await discoverJsonl(root, "codex-source", "pi-jsonl", 0, false, 1)
    expect(first.hasMore).toBe(true)
    expect(first.records.filter((record) => record.recordKind === "message")).toHaveLength(1)
    expect(first.records.some((record) => record.naturalKey.endsWith("|session"))).toBe(true)
    expect(first.records.some((record) => record.payloadJSON?.includes("sk-12345678901234567890"))).toBe(false)

    const second = await discoverJsonl(root, "codex-source", "pi-jsonl", first.checkpoint, false, 10)
    expect(second.hasMore).toBe(false)
    expect(second.records.filter((record) => record.recordKind === "message")).toHaveLength(2)
    expect(second.reconcilePrefixes).toEqual([{ prefix: "nested/session.jsonl|", lineCount: 3, recordKinds: ["session", "message"] }])
    expect(second.records.some((record) => record.payloadJSON?.includes("[REDACTED]"))).toBe(true)
  })

  test("resumes an append-only JSONL file from its saved offset instead of re-staging from line 0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    const filename = path.join(root, "session.jsonl")
    const line = (index: number) => JSON.stringify({ type: "message", id: `m${index}`, message: { role: "user", content: `line ${index}` }, timestamp: `2026-08-07T12:00:${String(index % 60).padStart(2, "0")}.000Z` })
    await writeFile(filename, Array.from({ length: 300 }, (_, index) => line(index)).join("\n") + "\n")

    const first = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 100)
    expect(first.checkpoint.current?.line).toBe(100)

    // The file grows (live session appends) and bumps its mtime. Discovery must
    // resume from the saved line/byte offset, not re-stage lines 0..99 again.
    await writeFile(filename, Array.from({ length: 600 }, (_, index) => line(index)).join("\n") + "\n")
    const second = await discoverJsonl(root, "source", "codex-jsonl", first.checkpoint, false, 100)
    expect(second.checkpoint.current?.line).toBe(200)
    const secondMessages = second.records.filter((record) => record.recordKind === "message")
    const keys = secondMessages.map((record) => record.naturalKey)
    expect(keys[0]).toBe("session.jsonl|line:100")
    expect(keys.some((key) => key.endsWith("|line:0"))).toBe(false)

    // A shrunken/rewritten file still restarts from the top.
    await writeFile(filename, Array.from({ length: 50 }, (_, index) => line(1000 + index)).join("\n") + "\n")
    const third = await discoverJsonl(root, "source", "codex-jsonl", second.checkpoint, false, 100)
    const thirdMessages = third.records.filter((record) => record.recordKind === "message")
    expect(thirdMessages[0]?.naturalKey).toBe("session.jsonl|line:0")
  })

  test("emits a bounded invalid-line record and a tombstone prefix for deleted files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    const filename = path.join(root, "session.jsonl")
    await writeFile(filename, "not-json\n")
    const first = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 10)
    expect(first.records.some((record) => record.payloadJSON?.includes("invalid_json"))).toBe(true)
    await rm(filename)
    const deleted = await discoverJsonl(root, "source", "codex-jsonl", first.checkpoint, false, 10, undefined, false, true)
    expect(deleted.records).toHaveLength(0)
    expect(deleted.reconcilePrefixes).toEqual([{ prefix: "session.jsonl|", lineCount: 0, recordKinds: ["session", "message"] }])
  })

  test("blocks an empty JSONL inventory without inferring remote deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    const filename = path.join(root, "session.jsonl")
    await writeFile(filename, `${JSON.stringify({ type: "session", id: "retained" })}\n`)
    const first = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 10)
    await rm(filename)
    const blocked = await discoverJsonl(root, "source", "codex-jsonl", first.checkpoint, false, 10)
    expect(blocked.records).toHaveLength(0)
    expect(blocked.reconcilePrefixes).toHaveLength(0)
    expect(blocked.complete).toBe(false)
    expect(typeof blocked.reconcileBlocked).toBe("string")
    expect(blocked.reconcileBlocked ?? "").toContain("JSONL source shrank")
  })

  test("can retain remote rows when a local file is intentionally pruned", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    const filename = path.join(root, "session.jsonl")
    await writeFile(filename, `${JSON.stringify({ type: "session", id: "retained" })}\n`)
    const first = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 10)
    await rm(filename)
    const retained = await discoverJsonl(root, "source", "codex-jsonl", first.checkpoint, false, 10, undefined, true)
    expect(retained.records).toHaveLength(0)
    expect(retained.reconcilePrefixes).toHaveLength(0)
    expect(retained.complete).toBe(true)
    expect(retained.hasMore).toBe(false)
  })

  test("stops a discovery pass at a cooperative cancellation boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    await writeFile(path.join(root, "session.jsonl"), `${JSON.stringify({ type: "session", id: "cancelled" })}\n`)
    const controller = new AbortController()
    controller.abort()
    const result = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 10, controller.signal)
    expect(result.records).toHaveLength(0)
    expect(result.complete).toBe(false)
    expect(result.hasMore).toBe(true)
  })

  test("extracts codex thread hierarchy into session records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    await mkdir(path.join(root, "2026/08/14"), { recursive: true })
    const meta = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: "2026-08-14T10:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-08-14T10:00:00.000Z", cwd: "/repo", originator: "codex_cli_rs", cli_version: "0.105.0", ...extra } })
    const message = (text: string) => JSON.stringify({ timestamp: "2026-08-14T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: text } })
    const parent = "00000000-0000-7000-8000-000000000000"
    await writeFile(path.join(root, "2026/08/14/rollout-sub.jsonl"), [meta("11111111-1111-7111-8111-111111111111", { source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: "Alder", agent_role: "awaiter" } } }, agent_nickname: "Alder", agent_role: "awaiter" }), message("sub")].join("\n") + "\n")
    await writeFile(path.join(root, "2026/08/14/rollout-fork.jsonl"), [meta("22222222-2222-7222-8222-222222222222", { forked_from_id: parent }), message("fork")].join("\n") + "\n")
    await writeFile(path.join(root, "2026/08/14/rollout-guardian.jsonl"), [meta("33333333-3333-7333-8333-333333333333", { source: { subagent: { other: "guardian" } }, thread_source: "subagent" }), message("judge")].join("\n") + "\n")
    await writeFile(path.join(root, "2026/08/14/rollout-root.jsonl"), [meta("44444444-4444-7444-8444-444444444444"), message("root")].join("\n") + "\n")

    const result = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 100)
    const sessions = new Map(result.records.filter((record) => record.recordKind === "session").map((record) => [record.naturalKey, JSON.parse(record.payloadJSON ?? "{}") as Record<string, any>]))

    const sub = sessions.get("2026/08/14/rollout-sub.jsonl|session")
    expect(sub.parent_session_id).toBe(parent)
    expect(sub.metadata.hierarchy).toEqual({ hierarchy_status: "subagent", parent_session_id: parent, depth: 1, nickname: "Alder", role: "awaiter" })

    const fork = sessions.get("2026/08/14/rollout-fork.jsonl|session")
    expect(fork.parent_session_id).toBe(parent)
    expect(fork.metadata.hierarchy).toEqual({ hierarchy_status: "subagent", parent_session_id: parent })

    const guardian = sessions.get("2026/08/14/rollout-guardian.jsonl|session")
    expect("parent_session_id" in guardian).toBe(false)
    expect(guardian.metadata.hierarchy).toEqual({ hierarchy_status: "subagent", thread_source: "subagent" })

    const plain = sessions.get("2026/08/14/rollout-root.jsonl|session")
    expect("parent_session_id" in plain).toBe(false)
    expect("hierarchy" in plain.metadata).toBe(false)
  })
})
