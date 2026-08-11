import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { redact, truncateUtf8, utf8Bytes } from "./ledger.js"
import type { NormalizedRecord } from "./sync-state.js"

const REQUIRED_COLUMNS = {
  session: ["id", "time_created", "time_updated", "title", "directory", "metadata"],
  message: ["id", "session_id", "time_created", "time_updated", "data"],
  part: ["id", "message_id", "session_id", "time_created", "time_updated", "data"],
  todo: ["session_id", "position", "time_created", "time_updated", "content", "status", "priority"],
} as const

export type OpenCodeV1Inspection = {
  adapterEnvelopeVersion: 1
  schemaVersion: number
  layoutFingerprint: string
  migrations: string[]
  tables: string[]
}

export type OpenCodeV1Checkpoint = {
  sourceUpdatedAt: number
  sessionCreatedAt: number
  sessionID: string
  reconcileBefore: number
  sourceFingerprint?: string
  sessionWatermarks?: Record<string, number>
  messageCursors?: Record<string, { timeCreated: number; id: string }>
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
    if (schemaVersion > 64) throw new Error(`OpenCode V1 schema migration count ${schemaVersion} is outside the supported range 1..64`)
    const signatures = Object.keys(REQUIRED_COLUMNS).map((table) => {
      const columns = (db.query(`pragma table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>).map((row) => `${row.name}:${row.type}:${row.notnull}:${row.pk}`).join(",")
      const indexes = (db.query(`pragma index_list(${table})`).all() as Array<{ name: string; unique: number }>).map((row) => `${row.name}:${row.unique}`).sort().join(",")
      return `${table}|columns=${columns}|indexes=${indexes}`
    })
    const layoutFingerprint = createHash("sha256").update(`${migrations.join("\n")}\n${signatures.join("\n")}`).digest("hex")
    return { adapterEnvelopeVersion: 1, schemaVersion, layoutFingerprint, migrations, tables }
  } finally {
    db.close()
  }
}

export function discoverOpenCodeV1(filename: string, sourceID: string, checkpointOrRevision: OpenCodeV1Checkpoint | number = 0, includeParts = true, includeToolOutput = false): { records: NormalizedRecord[]; checkpoint: OpenCodeV1Checkpoint; complete: boolean } {
  const inspection = inspectOpenCodeV1(filename)
  const db = new Database(filename, { readonly: true })
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;")
    db.exec("begin")
    const prior = typeof checkpointOrRevision === "number" ? undefined : checkpointOrRevision
    const sourceUpdatedAt = Number((db.query("select max(value) as value from (select coalesce(max(time_updated),0) value from session union all select coalesce(max(time_updated),0) from message union all select coalesce(max(time_updated),0) from part union all select coalesce(max(time_updated),0) from todo)").get() as { value: number | null }).value ?? 0)
    const sourceCounts = db.query("select (select count(*) from session) as sessions, (select count(*) from message) as messages, (select count(*) from part) as parts, (select count(*) from todo) as todos").get() as { sessions: number; messages: number; parts: number; todos: number }
    const sourceFingerprint = `${sourceUpdatedAt}:${sourceCounts.sessions}:${sourceCounts.messages}:${sourceCounts.parts}:${sourceCounts.todos}`
    const now = Date.now()
    const fullReconcile = !prior || now >= prior.reconcileBefore
    if (prior && fullReconcile && prior.sourceFingerprint === sourceFingerprint) {
      db.exec("commit")
      return { records: [], checkpoint: { ...prior, sourceUpdatedAt, sourceFingerprint, reconcileBefore: now + 15 * 60_000 }, complete: false }
    }
    const priorWatermarks = prior?.sessionWatermarks ?? {}
    const priorMessageCursors = prior?.messageCursors ?? {}
    const messageMarkers = db.query("select session_id, id, time_created, time_updated from message order by session_id, time_created, id").all() as Array<{ session_id: string; id: string; time_created: number; time_updated: number }>
    const changedByMessages = messageMarkers.filter((row) => {
      const cursor = priorMessageCursors[String(row.session_id)]
      const watermark = Number(priorWatermarks[String(row.session_id)] ?? -1)
      return !cursor || Number(row.time_created) > cursor.timeCreated || (Number(row.time_created) === cursor.timeCreated && String(row.id) > cursor.id) || Number(row.time_updated ?? row.time_created) > watermark
    }).map((row) => String(row.session_id))
    const changedSessionIDs = fullReconcile ? undefined : new Set([
      ...(db.query("select id, max(time_updated, time_created) as observed_at from session order by id").all() as Array<{ id: string; observed_at: number }>).filter((row) => Number(row.observed_at) > Number(priorWatermarks[row.id] ?? -1)).map((row) => String(row.id)),
      ...changedByMessages,
      ...(db.query("select session_id as id, max(max(time_updated, time_created)) as observed_at from part group by session_id order by session_id").all() as Array<{ id: string; observed_at: number }>).filter((row) => Number(row.observed_at) > Number(priorWatermarks[row.id] ?? -1)).map((row) => String(row.id)),
      ...(db.query("select session_id as id, max(max(time_updated, time_created)) as observed_at from todo group by session_id order by session_id").all() as Array<{ id: string; observed_at: number }>).filter((row) => Number(row.observed_at) > Number(priorWatermarks[row.id] ?? -1)).map((row) => String(row.id)),
    ])
    if (prior && !fullReconcile && !changedSessionIDs?.size) {
      db.exec("commit")
      return { records: [], checkpoint: { ...prior, sourceUpdatedAt, sourceFingerprint }, complete: false }
    }
    const ids = changedSessionIDs ? [...changedSessionIDs] : []
    const placeholders = ids.map(() => "?").join(",")
    const sessions = fullReconcile
      ? db.query("select id, time_created, time_updated, title, directory, metadata from session order by time_created, id").all()
      : db.query(`select id, time_created, time_updated, title, directory, metadata from session where id in (${placeholders}) order by time_created, id`).all(...ids)
    const messages = fullReconcile
      ? db.query("select id, session_id, time_created, time_updated, data from message order by session_id, time_created, id").all()
      : db.query(`select id, session_id, time_created, time_updated, data from message where session_id in (${placeholders}) order by session_id, time_created, id`).all(...ids)
    const parts = includeParts
      ? (fullReconcile ? db.query("select id, message_id, session_id, time_created, time_updated, data from part order by message_id, id").all() : db.query(`select id, message_id, session_id, time_created, time_updated, data from part where session_id in (${placeholders}) order by message_id, id`).all(...ids))
      : []
    const todos = fullReconcile
      ? db.query("select session_id, position, time_created, time_updated, content, status, priority from todo order by session_id, position").all()
      : db.query(`select session_id, position, time_created, time_updated, content, status, priority from todo where session_id in (${placeholders}) order by session_id, position`).all(...ids)
    const sessionRows = sessions as Array<Record<string, unknown>>
    const messagesBySession = groupBy(messages as Array<Record<string, unknown>>, (value) => String(value.session_id))
    const partsByMessage = groupBy(parts as Array<Record<string, unknown>>, (value) => String(value.message_id))
    const todosBySession = groupBy(todos as Array<Record<string, unknown>>, (value) => String(value.session_id))
    const records: NormalizedRecord[] = []
    for (const session of sessionRows) {
      const sessionID = String(session.id)
      const sourceCreatedAt = Number(session.time_created ?? 0)
      const sourceUpdatedAt = Number(session.time_updated ?? sourceCreatedAt)
      const sessionPayload = allowlistedPayload({ title: session.title, directory: session.directory, metadata: parseJSON(session.metadata), source_schema_version: inspection.schemaVersion, source_created_at: sourceCreatedAt, source_updated_at: sourceUpdatedAt })
      records.push(record(sourceID, "session", sessionID, sessionPayload, sourceUpdatedAt))
      for (const message of messagesBySession.get(sessionID) ?? []) {
        const messageCreatedAt = Number(message.time_created ?? 0)
        const messageUpdatedAt = Number(message.time_updated ?? messageCreatedAt)
        records.push(record(sourceID, "message", String(message.id), { session_id: String(message.session_id), data: normalizeMessageData(parseJSON(message.data), includeToolOutput), source_created_at: messageCreatedAt, source_updated_at: messageUpdatedAt }, messageUpdatedAt))
        if (!includeParts) continue
        for (const part of partsByMessage.get(String(message.id)) ?? []) {
          const partCreatedAt = Number(part.time_created ?? 0)
          const partUpdatedAt = Number(part.time_updated ?? partCreatedAt)
          records.push(record(sourceID, "part", `${part.message_id}:${part.id}`, { session_id: String(part.session_id), message_id: String(part.message_id), data: normalizePartData(parseJSON(part.data), includeToolOutput), source_created_at: partCreatedAt, source_updated_at: partUpdatedAt }, partUpdatedAt))
        }
      }
      for (const todo of todosBySession.get(sessionID) ?? []) {
        records.push(record(sourceID, "todo", `${todo.session_id}:${todo.position}`, allowlistedPayload({ ...todo, source_updated_at: Number(todo.time_updated ?? todo.time_created) }), Number(todo.time_updated ?? todo.time_created)))
      }
    }
    db.exec("commit")
    const nextWatermarks = fullReconcile ? {} : { ...priorWatermarks }
    const nextMessageCursors = fullReconcile ? {} : { ...priorMessageCursors }
    for (const row of messageMarkers) {
      const key = String(row.session_id)
      const priorCursor = nextMessageCursors[key]
      if (!priorCursor || Number(row.time_created) > priorCursor.timeCreated || (Number(row.time_created) === priorCursor.timeCreated && String(row.id) > priorCursor.id)) nextMessageCursors[key] = { timeCreated: Number(row.time_created), id: String(row.id) }
    }
    for (const session of sessionRows) {
      const sessionID = String(session.id)
      const values = [Number(session.time_updated ?? session.time_created ?? 0)]
      for (const message of messagesBySession.get(sessionID) ?? []) values.push(Number(message.time_updated ?? message.time_created ?? 0))
      for (const todo of todosBySession.get(sessionID) ?? []) values.push(Number(todo.time_updated ?? todo.time_created ?? 0))
      for (const message of messagesBySession.get(sessionID) ?? []) for (const part of partsByMessage.get(String(message.id)) ?? []) values.push(Number(part.time_updated ?? part.time_created ?? 0))
      nextWatermarks[sessionID] = Math.max(...values)
    }
    const last = sessionRows.at(-1)
    return { records, checkpoint: { sourceUpdatedAt, sourceFingerprint, sessionCreatedAt: Number(last?.time_created ?? 0), sessionID: String(last?.id ?? ""), reconcileBefore: now + 15 * 60_000, sessionWatermarks: nextWatermarks, messageCursors: nextMessageCursors }, complete: fullReconcile }
  } catch (error) {
    try { db.exec("rollback") } catch {}
    throw error
  } finally {
    db.close()
  }
}

export function discoverOpenCodeV1Sessions(filename: string, sourceID: string, prior?: OpenCodeV1Checkpoint): { records: NormalizedRecord[]; checkpoint: OpenCodeV1Checkpoint; complete: true; hasMore: false; reconcilePrefixes: never[]; sourceUpdatedAt: number } {
  const inspection = inspectOpenCodeV1(filename)
  const db = new Database(filename, { readonly: true })
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;")
    const sessions = db.query("select id, time_created, time_updated, title, directory, metadata from session order by time_created, id").all() as Array<Record<string, unknown>>
    const records = sessions.map((session) => {
      const createdAt = Number(session.time_created ?? 0)
      const updatedAt = Number(session.time_updated ?? createdAt)
      return record(sourceID, "session", String(session.id), allowlistedPayload({ title: session.title, directory: session.directory, metadata: parseJSON(session.metadata), source_schema_version: inspection.schemaVersion, source_created_at: createdAt, source_updated_at: updatedAt }), updatedAt)
    })
    const last = sessions.at(-1)
    const sourceUpdatedAt = sessions.reduce((latest, session) => Math.max(latest, Number(session.time_updated ?? session.time_created ?? 0)), 0)
    const now = Date.now()
    if (prior && now < prior.reconcileBefore && sourceUpdatedAt <= prior.sourceUpdatedAt) return { records: [], checkpoint: { ...prior, sourceUpdatedAt }, complete: true, hasMore: false, reconcilePrefixes: [], sourceUpdatedAt }
    return { records, checkpoint: { sourceUpdatedAt, sessionCreatedAt: Number(last?.time_created ?? 0), sessionID: String(last?.id ?? ""), reconcileBefore: now + 15 * 60_000 }, complete: true, hasMore: false, reconcilePrefixes: [], sourceUpdatedAt }
  } finally {
    db.close()
  }
}

function groupBy(values: Array<Record<string, unknown>>, key: (value: Record<string, unknown>) => string) {
  const groups = new Map<string, Array<Record<string, unknown>>>()
  for (const value of values) {
    const group = groups.get(key(value))
    if (group) group.push(value)
    else groups.set(key(value), [value])
  }
  return groups
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
    if (["title", "directory", "metadata", "session_id", "message_id", "position", "content", "status", "priority", "source_schema_version", "source_created_at", "source_updated_at"].includes(key)) allowed[key] = sanitizeValue(item, key)
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
  if (typeof value === "string") {
    if (/^data:/i.test(value)) return { omitted: true, reason: "inline-data", bytes: decodedDataBytes(value) }
    return truncateUtf8(redact(value), 65_536)
  }
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => sanitizeValue(item))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128).map(([childKey, item]) => [childKey, sanitizeValue(item, childKey)]))
  return value
}

function decodedDataBytes(value: string) {
  const comma = value.indexOf(",")
  if (comma < 0) return 0
  const body = value.slice(comma + 1)
  if (/;base64/i.test(value.slice(0, comma))) return Math.floor(body.replace(/\s/g, "").length * 3 / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0)
  try { return utf8Bytes(decodeURIComponent(body)) } catch { return utf8Bytes(body) }
}
