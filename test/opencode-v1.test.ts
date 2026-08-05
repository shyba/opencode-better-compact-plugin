import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { discoverOpenCodeV1, inspectOpenCodeV1 } from "../src/opencode-v1.js"

test("OpenCode V1 adapter validates the migration journal and emits bounded normalized records", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-opencode-"))
  const filename = path.join(directory, "opencode.db")
  const db = new Database(filename)
  db.exec(`
    create table migration (id text primary key, time_completed integer not null);
    insert into migration values ('001', 1);
    create table session (id text primary key, time_created integer, time_updated integer, title text, directory text, metadata text);
    create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    create table todo (session_id text, position integer, time_created integer, time_updated integer, content text, status text, priority text);
    insert into session values ('ses-1', 1, 2, 'Keep', '/tmp/project', '{"secret":"password=hidden","nested":{"apiKey":"still-hidden"}}');
    insert into message values ('msg-1', 'ses-1', 3, 4, '{"role":"user","text":"hello"}');
    insert into part values ('part-1', 'msg-1', 'ses-1', 5, 6, '{"type":"text","text":"token=hidden","output":"tool secret","attachment":"data:text/plain;base64,c2VjcmV0"}');
    insert into todo values ('ses-1', 0, 7, 8, 'check', 'pending', 'high');
  `)
  db.close()
  try {
    expect(inspectOpenCodeV1(filename).schemaVersion).toBe(1)
    const result = discoverOpenCodeV1(filename, "source-1")
    expect(result.records.map((record) => record.recordKind)).toEqual(["session", "message", "part", "todo"])
    expect(result.records.every((record) => !record.payloadJSON?.includes("password=hidden"))).toBe(true)
    expect(result.records.every((record) => !record.payloadJSON?.includes("token=hidden"))).toBe(true)
    expect(result.records.every((record) => !record.payloadJSON?.includes("tool secret"))).toBe(true)
    expect(result.records.every((record) => !record.payloadJSON?.includes("still-hidden"))).toBe(true)
    expect(result.records.every((record) => !record.payloadJSON?.includes("c2VjcmV0"))).toBe(true)
    expect(result.checkpoint.sessionID).toBe("ses-1")
    const unchanged = discoverOpenCodeV1(filename, "source-1", result.checkpoint)
    expect(unchanged.records).toHaveLength(0)
    expect(unchanged.complete).toBe(false)
    const changedDB = new Database(filename)
    changedDB.query("update message set time_updated=?, data=? where id=?").run(9, JSON.stringify({ role: "assistant" }), "msg-1")
    changedDB.close()
    const changed = discoverOpenCodeV1(filename, "source-1", result.checkpoint)
    expect(changed.complete).toBe(false)
    expect(changed.records.some((record) => record.recordKind === "message" && record.payloadJSON?.includes("assistant"))).toBe(true)
    const equalTimestampDB = new Database(filename)
    equalTimestampDB.query("insert into message values (?, ?, ?, ?, ?)").run("msg-2", "ses-1", 3, 3, JSON.stringify({ role: "user" }))
    equalTimestampDB.close()
    const equalTimestamp = discoverOpenCodeV1(filename, "source-1", changed.checkpoint)
    expect(equalTimestamp.records.some((record) => record.naturalKey === "msg-2")).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("OpenCode V1 adapter safety", () => {
  test("rejects a source without the migration journal", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "better-compact-opencode-"))
    const filename = path.join(directory, "opencode.db")
    const db = new Database(filename)
    db.exec("create table session(id text, time_created integer, time_updated integer, title text, directory text, metadata text)")
    db.close()
    try {
      expect(() => inspectOpenCodeV1(filename)).toThrow("missing table message")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
