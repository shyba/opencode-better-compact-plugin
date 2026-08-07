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

  test("emits a bounded invalid-line record and a tombstone prefix for deleted files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "better-compact-jsonl-"))
    temporary.push(root)
    const filename = path.join(root, "session.jsonl")
    await writeFile(filename, "not-json\n")
    const first = await discoverJsonl(root, "source", "codex-jsonl", 0, false, 10)
    expect(first.records.some((record) => record.payloadJSON?.includes("invalid_json"))).toBe(true)
    await rm(filename)
    const deleted = await discoverJsonl(root, "source", "codex-jsonl", first.checkpoint, false, 10)
    expect(deleted.records).toHaveLength(0)
    expect(deleted.reconcilePrefixes).toEqual([{ prefix: "session.jsonl|", lineCount: 0, recordKinds: ["session", "message"] }])
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
})
