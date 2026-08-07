import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { createInterface } from "node:readline"
import { redact, truncateUtf8, utf8Bytes } from "./ledger.js"
import type { NormalizedRecord } from "./sync-state.js"

export type JsonlFileCheckpoint = {
  size: number
  mtimeMs: number
  lineCount?: number
  sessionID?: string
}

export type JsonlCheckpoint = {
  version: 1
  inventoryComplete?: boolean
  files: Record<string, JsonlFileCheckpoint>
  current?: {
    path: string
    line: number
    byteOffset: number
    size: number
    mtimeMs: number
    sessionID: string
  }
}

export type JsonlInspection = {
  adapterEnvelopeVersion: 1
  schemaVersion: 1
  layoutFingerprint: string
  fileCount: number
  totalBytes: number
}

export type JsonlReconcilePrefix = {
  prefix: string
  lineCount: number
  recordKinds: string[]
}

export type JsonlDiscoveryResult = {
  records: NormalizedRecord[]
  sessionRecords: NormalizedRecord[]
  checkpoint: JsonlCheckpoint
  complete: boolean
  hasMore: boolean
  reconcilePrefixes: JsonlReconcilePrefix[]
  sourceUpdatedAt: number
}

export type JsonlSessionCheckpoint = {
  version: 1
  files: Record<string, { size: number; mtimeMs: number; sessionID: string }>
}

type JsonlFile = {
  relativePath: string
  filename: string
  size: number
  mtimeMs: number
}

const MESSAGE_LIMIT = 131_072
const VALUE_LIMIT = 16_384
const MAX_DEPTH = 7
const MAX_ENTRIES = 128
const OMITTED_KEYS = /^(output|stdout|stderr|result|raw|trace|transcript|content_bytes)$/i

export async function inspectJsonl(root: string): Promise<JsonlInspection> {
  const files = await listJsonlFiles(root)
  const fingerprint = createHash("sha256").update("better-compact-jsonl-v1").digest("hex")
  return {
    adapterEnvelopeVersion: 1,
    schemaVersion: 1,
    layoutFingerprint: fingerprint,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  }
}

export async function discoverJsonl(
  root: string,
  sourceID: string,
  kind: string,
  checkpointOrRevision: JsonlCheckpoint | number = 0,
  includeToolOutput = false,
  maxRecords = 500,
): Promise<JsonlDiscoveryResult> {
  const files = await listJsonlFiles(root)
  const prior = typeof checkpointOrRevision === "number" ? undefined : checkpointOrRevision
  const checkpoint: JsonlCheckpoint = {
    version: 1,
    ...(prior?.inventoryComplete ? { inventoryComplete: true } : {}),
    files: { ...(prior?.files ?? {}) },
    ...(prior?.current ? { current: prior.current } : {}),
  }
  const currentFiles = new Map(files.map((file) => [file.relativePath, file]))
  const reconcilePrefixes: JsonlReconcilePrefix[] = []
  for (const relativePath of Object.keys(checkpoint.files).sort()) {
    if (currentFiles.has(relativePath)) continue
    reconcilePrefixes.push({ prefix: naturalPrefix(relativePath), lineCount: 0, recordKinds: ["session", "message"] })
    delete checkpoint.files[relativePath]
    if (checkpoint.current?.path === relativePath) delete checkpoint.current
  }

  const inventoryRecords: NormalizedRecord[] = []
  const inventoryNeeded = !checkpoint.inventoryComplete || files.some((file) => !checkpoint.files[file.relativePath]?.sessionID)
  if (inventoryNeeded) {
    for (const file of files) {
      const saved = checkpoint.files[file.relativePath]
      if (saved?.sessionID && saved.size === file.size && saved.mtimeMs === file.mtimeMs) continue
      const header = await readSessionHeader(file.filename)
      const sessionID = header.sessionID || stableSessionID(sourceID, file.relativePath)
      checkpoint.files[file.relativePath] = { ...(saved?.lineCount === undefined ? {} : { lineCount: saved.lineCount }), size: file.size, mtimeMs: file.mtimeMs, sessionID }
      inventoryRecords.push(sessionRecord(sourceID, kind, file.relativePath, sessionID, header, header.createdAt || file.mtimeMs, file.mtimeMs))
    }
    checkpoint.inventoryComplete = true
  }

  const candidates = files.filter((file) => {
    const saved = checkpoint.files[file.relativePath]
    if (checkpoint.current?.path === file.relativePath) return true
    return !saved || saved.size !== file.size || saved.mtimeMs !== file.mtimeMs || saved.lineCount === undefined
  })
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

  const records: NormalizedRecord[] = inventoryRecords
  const sessionRecords: NormalizedRecord[] = [...inventoryRecords]
  let sourceUpdatedAt = files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0)
  let remaining = Math.max(1, Math.floor(maxRecords))
  for (const file of candidates) {
    const saved = checkpoint.current?.path === file.relativePath ? checkpoint.current : undefined
    const sameMetadata = saved && saved.size === file.size && saved.mtimeMs === file.mtimeMs
    const startLine = sameMetadata ? saved.line : 0
    const startOffset = sameMetadata ? saved.byteOffset : 0
    const sessionHeader = await readSessionHeader(file.filename)
    const sessionID = sessionHeader.sessionID || stableSessionID(sourceID, file.relativePath)
    const sessionCreatedAt = sessionHeader.createdAt || file.mtimeMs
    const session = sessionRecord(sourceID, kind, file.relativePath, sessionID, sessionHeader, sessionCreatedAt, file.mtimeMs)
    records.push(session)
    sessionRecords.push(session)

    let line = startLine
    let byteOffset = startOffset
    let finished = true
    const input = createReadStream(file.filename, { start: startOffset })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const value of lines) {
        const text = String(value)
        const parsed = parseLine(text)
        const persist = shouldPersistLine(kind, parsed.value)
        const lineNumber = line
        const lineBytes = Buffer.byteLength(text, "utf8") + 1
        if (!persist) {
          line++
          byteOffset += lineBytes
          continue
        }
        if (remaining <= 0) {
          finished = false
          break
        }
        line++
        byteOffset += lineBytes
        records.push(messageRecord(sourceID, file.relativePath, sessionID, lineNumber, text, includeToolOutput, file.mtimeMs))
        remaining--
      }
    } finally {
      lines.close()
      input.destroy()
    }

    if (!finished) {
      checkpoint.current = { path: file.relativePath, line, byteOffset, size: file.size, mtimeMs: file.mtimeMs, sessionID }
      sourceUpdatedAt = Math.max(sourceUpdatedAt, file.mtimeMs)
      break
    }

    checkpoint.files[file.relativePath] = { size: file.size, mtimeMs: file.mtimeMs, lineCount: line, sessionID }
    if (checkpoint.current?.path === file.relativePath) delete checkpoint.current
    reconcilePrefixes.push({ prefix: naturalPrefix(file.relativePath), lineCount: line, recordKinds: ["session", "message"] })
    sourceUpdatedAt = Math.max(sourceUpdatedAt, file.mtimeMs)
    if (remaining <= 0) break
  }

  const hasMore = Boolean(checkpoint.current) || files.some((file) => {
    const saved = checkpoint.files[file.relativePath]
    return !saved || saved.size !== file.size || saved.mtimeMs !== file.mtimeMs || saved.lineCount === undefined
  })
  return {
    records,
    sessionRecords,
    checkpoint,
    complete: !hasMore,
    hasMore,
    reconcilePrefixes,
    sourceUpdatedAt,
  }
}

export async function discoverJsonlSessions(root: string, sourceID: string, kind: string, checkpointOrRevision: JsonlSessionCheckpoint | number = 0) {
  const prior = typeof checkpointOrRevision === "number" ? undefined : checkpointOrRevision
  const paths = prior?.files && Object.keys(prior.files).length ? await listJsonlPaths(root) : await listJsonlFiles(root)
  const files = paths.map((file) => {
    const saved = prior?.files[file.relativePath]
    return { ...file, size: saved?.size ?? -1, mtimeMs: saved?.mtimeMs ?? -1 }
  })
  const checkpoint: JsonlSessionCheckpoint = { version: 1, files: { ...(prior?.files ?? {}) } }
  const current = new Map(files.map((file) => [file.relativePath, file]))
  const reconcilePrefixes: JsonlReconcilePrefix[] = []
  for (const relativePath of Object.keys(checkpoint.files).sort()) {
    if (current.has(relativePath)) continue
    reconcilePrefixes.push({ prefix: naturalPrefix(relativePath), lineCount: 0, recordKinds: ["session"] })
    delete checkpoint.files[relativePath]
  }
  const records: NormalizedRecord[] = []
  for (const file of files) {
    const saved = checkpoint.files[file.relativePath]
    if (saved && saved.size === file.size && saved.mtimeMs === file.mtimeMs) continue
    const header = await readSessionHeader(file.filename)
    const metadata = await stat(file.filename)
    const sessionID = header.sessionID || stableSessionID(sourceID, file.relativePath)
    records.push(sessionRecord(sourceID, kind, file.relativePath, sessionID, header, header.createdAt || metadata.mtimeMs, metadata.mtimeMs))
    checkpoint.files[file.relativePath] = { size: metadata.size, mtimeMs: metadata.mtimeMs, sessionID }
    reconcilePrefixes.push({ prefix: naturalPrefix(file.relativePath), lineCount: 1, recordKinds: ["session"] })
  }
  return { records, sessionRecords: records, checkpoint, complete: true, hasMore: false, reconcilePrefixes, sourceUpdatedAt: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0) }
}

async function listJsonlFiles(root: string): Promise<JsonlFile[]> {
  const resolved = path.resolve(root)
  const result: JsonlFile[] = []
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(directory, entry.name))))
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map(async (entry) => {
      const filename = path.join(directory, entry.name)
      const metadata = await stat(filename)
      result.push({ relativePath: path.relative(resolved, filename).split(path.sep).join("/"), filename, size: metadata.size, mtimeMs: metadata.mtimeMs })
    }))
  }
  await visit(resolved)
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function listJsonlPaths(root: string): Promise<Array<Pick<JsonlFile, "relativePath" | "filename">>> {
  const resolved = path.resolve(root)
  const result: Array<Pick<JsonlFile, "relativePath" | "filename">> = []
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => visit(path.join(directory, entry.name))))
    result.push(...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => {
      const filename = path.join(directory, entry.name)
      return { relativePath: path.relative(resolved, filename).split(path.sep).join("/"), filename }
    }))
  }
  await visit(resolved)
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

async function readSessionHeader(filename: string) {
  const input = createReadStream(filename, { start: 0, end: 16_383 })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const value of lines) {
      const parsed = parseLine(String(value))
      if (!parsed.value) continue
      const sessionID = findString(parsed.value, ["id", "session_id", "sessionId"], 2)
      const createdAt = timestampMs(parsed.value)
      const title = findString(parsed.value, ["title", "name"], 2)
      const directory = findString(parsed.value, ["directory", "cwd", "workdir"], 2)
      return { sessionID, createdAt, title, directory }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return { sessionID: undefined, createdAt: undefined, title: undefined, directory: undefined }
}

function sessionRecord(sourceID: string, kind: string, relativePath: string, sessionID: string, header: { title?: string | undefined; directory?: string | undefined }, createdAt: number, updatedAt: number): NormalizedRecord {
  const payload = {
    title: header.title,
    directory: header.directory,
    metadata: { source_kind: kind, source_path: relativePath, session_id: sessionID },
    source_created_at: createdAt,
    source_updated_at: updatedAt,
  }
  return record(sourceID, "session", `${relativePath}|session`, payload, updatedAt)
}

function messageRecord(sourceID: string, relativePath: string, sessionID: string, line: number, text: string, includeToolOutput: boolean, observedAt: number): NormalizedRecord {
  const parsed = parseLine(text)
  const source = parsed.value ? sanitizeValue(parsed.value, "", includeToolOutput) : { invalid_json: true, raw: truncateUtf8(redact(text), 4_096) }
  const eventType = parsed.value ? nestedType(parsed.value) ?? findString(parsed.value, ["type", "event_type"], 1) ?? "record" : "invalid_json"
  const role = parsed.value ? findString(parsed.value, ["role"], 4) ?? nestedRole(parsed.value) ?? eventType : "unknown"
  const timestamp = parsed.value ? timestampMs(parsed.value) ?? observedAt : observedAt
  const payload = {
    session_id: sessionID,
    data: { role, event_type: eventType, source_path: relativePath, line, data: source },
    source_created_at: timestamp,
    source_updated_at: timestamp,
  }
  return record(sourceID, "message", `${relativePath}|line:${line}`, payload, timestamp)
}

function shouldPersistLine(kind: string, value: Record<string, unknown> | undefined) {
  if (kind !== "codex-jsonl" || !value) return true
  const topLevel = typeof value.type === "string" ? value.type : ""
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload) ? value.payload as Record<string, unknown> : undefined
  const payloadType = typeof payload?.type === "string" ? payload.type : ""
  if (topLevel === "session_meta" || topLevel === "turn_context") return false
  if (topLevel === "event_msg") return payloadType === "user_message" || payloadType === "agent_message"
  if (topLevel === "response_item") return payloadType === "message" || payloadType === "function_call"
  return true
}

function record(sourceID: string, recordKind: string, naturalKey: string, payload: Record<string, unknown>, observedAt: number): NormalizedRecord {
  const rawJSON = JSON.stringify(payload)
  const payloadJSON = utf8Bytes(rawJSON) > MESSAGE_LIMIT
    ? JSON.stringify({ omitted: true, reason: "payload-bound", sha256: createHash("sha256").update(rawJSON).digest("hex"), bytes: utf8Bytes(rawJSON) })
    : rawJSON
  const routing = Object.fromEntries(Object.entries(payload).filter(([key]) => ["session_id", "message_id", "position"].includes(key)))
  return {
    sourceID,
    recordKind,
    naturalKey,
    routingJSON: JSON.stringify(routing),
    payloadJSON,
    payloadSHA256: createHash("sha256").update(payloadJSON).digest("hex"),
    observedAt,
  }
}

function parseLine(value: string): { value?: Record<string, unknown> } {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { value: parsed as Record<string, unknown> }
  } catch {}
  return {}
}

function sanitizeValue(value: unknown, key: string, includeToolOutput: boolean, depth = 0): unknown {
  if (/(password|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key)/i.test(key)) return "[REDACTED]"
  if (depth >= MAX_DEPTH) return "[TRUNCATED]"
  if (typeof value === "string") {
    if (/^data:/i.test(value)) return { omitted: true, reason: "inline-data", bytes: decodedDataBytes(value) }
    return truncateUtf8(redact(value), VALUE_LIMIT)
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => sanitizeValue(item, key, includeToolOutput, depth + 1))
  if (!value || typeof value !== "object") return undefined
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).slice(0, MAX_ENTRIES).flatMap(([childKey, childValue]) => {
    if (!includeToolOutput && OMITTED_KEYS.test(childKey)) return [[childKey, { omitted: true, reason: "tool-output" }]]
    const sanitized = sanitizeValue(childValue, childKey, includeToolOutput, depth + 1)
    return sanitized === undefined ? [] : [[childKey, sanitized]]
  }))
}

function findString(value: unknown, keys: string[], depth: number): string | undefined {
  if (!value || typeof value !== "object" || depth < 0) return undefined
  const object = value as Record<string, unknown>
  for (const key of keys) if (typeof object[key] === "string" && object[key]) return object[key]
  for (const child of Object.values(object)) {
    const result = findString(child, keys, depth - 1)
    if (result) return result
  }
  return undefined
}

function nestedRole(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const object = value as Record<string, unknown>
  const message = object.message
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const role = (message as Record<string, unknown>).role
    if (typeof role === "string") return role
  }
  return undefined
}

function nestedType(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const object = value as Record<string, unknown>
  const payload = object.payload
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const type = (payload as Record<string, unknown>).type
    if (typeof type === "string") return type
  }
  return undefined
}

function timestampMs(value: unknown): number | undefined {
  const timestamp = findValue(value, ["timestamp", "time_created", "created_at", "createdAt"], 3)
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function findValue(value: unknown, keys: string[], depth: number): unknown {
  if (!value || typeof value !== "object" || depth < 0) return undefined
  const object = value as Record<string, unknown>
  for (const key of keys) if (object[key] !== undefined) return object[key]
  for (const child of Object.values(object)) {
    const result = findValue(child, keys, depth - 1)
    if (result !== undefined) return result
  }
  return undefined
}

function stableSessionID(sourceID: string, relativePath: string) {
  return `file-${createHash("sha256").update(`${sourceID}\n${relativePath}`).digest("hex").slice(0, 24)}`
}

function naturalPrefix(relativePath: string) {
  return `${relativePath}|`
}

function decodedDataBytes(value: string) {
  const comma = value.indexOf(",")
  if (comma < 0) return 0
  const body = value.slice(comma + 1)
  if (/;base64/i.test(value.slice(0, comma))) {
    const length = body.replace(/\s/g, "").length
    return Math.max(0, Math.floor(length * 3 / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0))
  }
  try { return utf8Bytes(decodeURIComponent(body)) } catch { return utf8Bytes(body) }
}
