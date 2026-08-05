import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { redact, utf8Bytes } from "./ledger.js"
import type { NormalizedRecord } from "./sync-state.js"

const REQUIRED_COLUMNS = {
  session: ["id", "time_created", "time_updated", "title", "directory", "metadata"],
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
    const signatures = Object.keys(REQUIRED_COLUMNS).map((table) => {
      const columns = (db.query(`pragma table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map((row) => `${row.name}:${row.type}:${row.notnull}:${row.pk}`).join(",")
      const indexes = (db.query(`pragma index_list(${table})`).all() as Array<{ name: string; unique: number }>).map((row) => `${row.name}:${row.unique}`).sort().join(",")
      return `${table}|columns=${columns}|indexes=${indexes}`
    })
    const layoutFingerprint = createHash("sha256").update(`${migrations.join("\n")}\n${signatures.join("\n")}`).digest("hex")
    return { schemaVersion, layoutFingerprint, migrations, tables }
  } finally {
    db.close()
  }
}

export function discoverOpenCodeV1(filename: string, sourceID: string, _revisionStart = 0, includeParts = true, includeToolOutput = false): { records: NormalizedRecord[]; checkpoint: { sessionCreatedAt: number; sessionID: string } } {
  const inspection = inspectOpenCodeV1(filename)
  const db = new Database(filename, { readonly: true })
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;")
    db.exec("begin")
    const sessions = db.query("select id, time_created, time_updated, title, directory, metadata from session order by time_created, id").all() as Array<Record<string, unknown>>
    const records: NormalizedRecord[] = []
    for (const session of sessions) {
      const sessionID = String(session.id)
      const sessionPayload = allowlistedPayload({ title: session.title, directory: session.directory, metadata: parseJSON(session.metadata), source_schema_version: inspection.schemaVersion })
      records.push(record(sourceID, "session", sessionID, sessionPayload, Number(session.time_updated ?? session.time_created)))
      const messages = db.query("select id, session_id, time_created, time_updated, data from message where session_id=? order by time_created, id").all(sessionID) as Array<Record<string, unknown>>
      for (const message of messages) {
        records.push(record(sourceID, "message", String(message.id), { session_id: String(message.session_id), data: normalizeMessageData(parseJSON(message.data), includeToolOutput) }, Number(message.time_updated ?? message.time_created)))
        if (!includeParts) continue
        const parts = db.query("select id, message_id, session_id, time_created, time_updated, data from part where message_id=? order by id").all(String(message.id)) as Array<Record<string, unknown>>
        for (const part of parts) {
          records.push(record(sourceID, "part", `${part.message_id}:${part.id}`, { session_id: String(part.session_id), message_id: String(part.message_id), data: normalizePartData(parseJSON(part.data), includeToolOutput) }, Number(part.time_updated ?? part.time_created)))
        }
      }
      const todos = db.query("select session_id, position, time_created, time_updated, content, status, priority from todo where session_id=? order by position").all(sessionID) as Array<Record<string, unknown>>
      for (const todo of todos) {
        records.push(record(sourceID, "todo", `${todo.session_id}:${todo.position}`, allowlistedPayload(todo), Number(todo.time_updated ?? todo.time_created)))
      }
    }
    db.exec("commit")
    const last = sessions.at(-1)
    return { records, checkpoint: { sessionCreatedAt: Number(last?.time_created ?? 0), sessionID: String(last?.id ?? "") } }
  } catch (error) {
    try { db.exec("rollback") } catch {}
    throw error
  } finally {
    db.close()
  }
}

function record(sourceID: string, recordKind: string, naturalKey: string, payload: Record<string, unknown>, observedAt: number): NormalizedRecord {
  const rawJSON = JSON.stringify(payload)
  const payloadJSON = utf8Bytes(rawJSON) > 131_072
    ? JSON.stringify({ omitted: true, reason: "payload-bound", sha256: createHash("sha256").update(rawJSON).digest("hex"), bytes: utf8Bytes(rawJSON) })
    : rawJSON
  const routing = Object.fromEntries(Object.entries(payload).filter(([key]) => ["session_id", "message_id", "position"].includes(key)))
  return { sourceID, recordKind, naturalKey, routingJSON: JSON.stringify(routing), payloadJSON, payloadSHA256: createHash("sha256").update(payloadJSON).digest("hex"), observedAt }
}

function parseJSON(value: unknown) {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return { raw: value } }
}

function allowlistedPayload(value: Record<string, unknown>): Record<string, unknown> {
  const allowed: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (["title", "directory", "metadata", "session_id", "message_id", "position", "content", "status", "priority", "source_schema_version"].includes(key)) allowed[key] = sanitizeValue(item)
  }
  return allowed
}

function normalizeMessageData(value: unknown, includeToolOutput: boolean) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const allowed = ["id", "role", "parentID", "mode", "agent", "summary", "model", "path", "time", "tokens", "cost", "finish"]
  const toolFields = ["output", "result", "error"]
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key) || (includeToolOutput && toolFields.includes(key))).map(([key, item]) => [key, sanitizeValue(item, key)]))
}

function normalizePartData(value: unknown, includeToolOutput: boolean) {
  const data = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const allowed = ["id", "type", "text", "synthetic", "messageID", "sessionID", "time", "hash"]
  const toolFields = ["output", "result", "error"]
  return Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key) || (includeToolOutput && toolFields.includes(key))).map(([key, item]) => [key, sanitizeValue(item, key)]))
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (/(password|secret|token|api[-_]?key|authorization|cookie|credential)/i.test(key)) return "[REDACTED]"
  if (typeof value === "string") return redact(value).slice(0, 65_536)
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizeValue(item))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128).map(([childKey, item]) => [childKey, sanitizeValue(item, childKey)]))
  return value
}
