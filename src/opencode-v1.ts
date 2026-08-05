import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { redact, utf8Bytes } from "./ledger.js"
import type { NormalizedRecord } from "./sync-state.js"

const REQUIRED_COLUMNS = {
  session: ["id", "time_created", "time_updated", "data"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  todo: ["session_id", "position", "time_created", "time_updated", "content", "status", "priority"],
} as const

export type OpenCodeV1Inspection = {
  schemaVersion: number
  layoutFingerprint: string
  migrations: string[]
  tables: string[]
}

export function inspectOpenCodeV1(filename: string): OpenCodeV1Inspection {
  const db = new Database(filename, { readonly: true })
  try {
    const tables = (db.query("select name from sqlite_master where type='table' order by name").all() as Array<{ name: string }>).map((row) => row.name)
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      if (!tables.includes(table)) throw new Error(`OpenCode V1 source is missing table ${table}`)
      const actual = new Set((db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
      for (const column of columns) if (!actual.has(column)) throw new Error(`OpenCode V1 source is missing ${table}.${column}`)
    }
    const migrations = tables.includes("migration")
      ? (db.query("select id || ':' || time_completed as value from migration order by id").all() as Array<{ value: string }>).map((row) => row.value)
      : tables.includes("__drizzle_migrations")
        ? (db.query("select hash as value from __drizzle_migrations order by created_at").all() as Array<{ value: string }>).map((row) => row.value)
        : []
    if (!migrations.length) throw new Error("OpenCode V1 source has no recognized migration journal")
    const schemaVersion = migrations.length
    const layoutFingerprint = createHash("sha256").update(`${schemaVersion}\n${tables.join("\n")}\n${Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => `${table}:${columns.join(",")}`).join("\n")}`).digest("hex")
    return { schemaVersion, layoutFingerprint, migrations, tables }
  } finally {
    db.close()
  }
}

export function discoverOpenCodeV1(filename: string, sourceID: string, revisionStart = 0, includeParts = true): { records: NormalizedRecord[]; checkpoint: { sessionCreatedAt: number; sessionID: string; revision: number } } {
  const inspection = inspectOpenCodeV1(filename)
  const db = new Database(filename, { readonly: true })
  try {
    db.exec("begin")
    const sessions = db.query("select id, time_created, time_updated, data from session order by time_created, id").all() as Array<Record<string, unknown>>
    const records: NormalizedRecord[] = []
    let revision = revisionStart
    for (const session of sessions) {
      const sessionID = String(session.id)
      const sessionPayload = allowlistedPayload({ session: parseJSON(session.data), source_schema_version: inspection.schemaVersion })
      revision++
      records.push(record(sourceID, "session", sessionID, sessionPayload, revision, Number(session.time_updated ?? session.time_created)))
      const messages = db.query("select id, session_id, time_created, time_updated, data from message where session_id=? order by time_created, id").all(sessionID) as Array<Record<string, unknown>>
      for (const message of messages) {
        revision++
        records.push(record(sourceID, "message", String(message.id), allowlistedPayload({ session_id: message.session_id, data: parseJSON(message.data) }), revision, Number(message.time_updated ?? message.time_created)))
        if (!includeParts) continue
        const parts = db.query("select id, message_id, session_id, time_created, time_updated, data from part where message_id=? order by id").all(String(message.id)) as Array<Record<string, unknown>>
        for (const part of parts) {
          revision++
          records.push(record(sourceID, "part", `${part.message_id}:${part.id}`, allowlistedPayload({ session_id: part.session_id, message_id: part.message_id, data: parseJSON(part.data) }), revision, Number(part.time_updated ?? part.time_created)))
        }
      }
      const todos = db.query("select session_id, position, time_created, time_updated, content, status, priority from todo where session_id=? order by position").all(sessionID) as Array<Record<string, unknown>>
      for (const todo of todos) {
        revision++
        records.push(record(sourceID, "todo", `${todo.session_id}:${todo.position}`, allowlistedPayload(todo), revision, Number(todo.time_updated ?? todo.time_created)))
      }
    }
    db.exec("commit")
    const last = sessions.at(-1)
    return { records, checkpoint: { sessionCreatedAt: Number(last?.time_created ?? 0), sessionID: String(last?.id ?? ""), revision } }
  } catch (error) {
    try { db.exec("rollback") } catch {}
    throw error
  } finally {
    db.close()
  }
}

function record(sourceID: string, recordKind: string, naturalKey: string, payload: Record<string, unknown>, recordRevision: number, observedAt: number): NormalizedRecord {
  const payloadJSON = JSON.stringify(payload)
  if (utf8Bytes(payloadJSON) > 131_072) throw new Error(`OpenCode ${recordKind} payload exceeds the sync bound`)
  return { sourceID, recordKind, naturalKey, payloadJSON, payloadSHA256: createHash("sha256").update(payloadJSON).digest("hex"), recordRevision, observedAt }
}

function parseJSON(value: unknown) {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function allowlistedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (["session", "session_id", "message_id", "data", "source_schema_version", "position", "content", "status", "priority"].includes(key)) allowed[key] = sanitizeValue(item)
  }
  return allowed
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value).slice(0, 65_536)
  if (Array.isArray(value)) return value.slice(0, 128).map(sanitizeValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, item]) => [key, sanitizeValue(item)]))
  return value
}
