import type { OutboxRow } from "./sync-state.js"

type SQLClient = {
  unsafe<T = unknown>(query: string, values?: unknown[]): Promise<T>
  begin<T>(callback: (transaction: SQLClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export type PostgresSource = {
  installationID: string
  installationIncarnation: string
  sourceID: string
  incarnation: string
  ownerToken: string
  expectedRevision: number
}

export function openPostgres(url: string) {
  const constructor = (Bun as unknown as { SQL: new (connection: string) => SQLClient }).SQL
  return new constructor(url)
}

export async function applyRemoteMigration(client: SQLClient, sql: string) {
  await client.unsafe(sql)
}

export async function recordObservation(client: SQLClient, source: PostgresSource, staged: number, uploaded: number, lagMs: number | null) {
  await client.unsafe(`insert into opencode.sync_observation(installation_id, source_id, lag_ms, records_staged, records_uploaded)
    values ($1,$2,$3,$4,$5)
    on conflict (installation_id, source_id) do update set observed_at=now(), lag_ms=excluded.lag_ms, records_staged=opencode.sync_observation.records_staged + excluded.records_staged, records_uploaded=opencode.sync_observation.records_uploaded + excluded.records_uploaded`, [source.installationID, source.sourceID, lagMs, staged, uploaded])
}

export async function purgeRemoteTombstones(client: SQLClient, source: PostgresSource, retentionDays: number) {
  for (const table of ["session", "message", "part", "todo"]) await client.unsafe(`delete from opencode.${table} where installation_id=$2 and source_id=$3 and deleted_at is not null and deleted_at < now() - ($1 * interval '1 day')`, [retentionDays, source.installationID, source.sourceID])
}

export async function ensureRemoteSource(client: SQLClient, source: PostgresSource, kind: string, schemaVersion: number, fingerprint: string) {
  await client.unsafe(`insert into opencode.installation(installation_id, incarnation, label)
    values ($1,$2,$3)
    on conflict (installation_id) do update set last_seen_at=now()
    where opencode.installation.incarnation=$2`, [source.installationID, source.installationIncarnation, source.installationID])
  const installations = await client.unsafe<Array<{ incarnation: string }>>("select incarnation from opencode.installation where installation_id=$1", [source.installationID])
  if (installations[0]?.incarnation !== source.installationIncarnation) throw new Error("Postgres installation incarnation fence failed; run installation reset or adopt")
  await client.unsafe(`insert into opencode.source(installation_id, source_id, incarnation, kind, schema_version, locator_fingerprint)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (installation_id, source_id) do update set last_seen_at=now()
    where opencode.source.incarnation=$3`, [source.installationID, source.sourceID, source.incarnation, kind, schemaVersion, fingerprint])
  const sources = await client.unsafe<Array<{ incarnation: string }>>("select incarnation from opencode.source where installation_id=$1 and source_id=$2", [source.installationID, source.sourceID])
  if (sources[0]?.incarnation !== source.incarnation) throw new Error("Postgres source incarnation fence failed; run installation reset or adopt")
  const lease = await client.unsafe<Array<{ source_id: string }>>(`update opencode.source set lease_owner=$3, lease_until=now() + interval '30 seconds', last_seen_at=now()
    where installation_id=$1 and source_id=$2 and incarnation=$4 and (lease_owner is null or lease_until < now() or lease_owner=$3) returning source_id`, [source.installationID, source.sourceID, source.ownerToken, source.incarnation])
  if (!lease.length) throw new Error("another sync worker owns this source lease; use installation reset or adopt only after confirming it is stopped")
}

export async function readRemoteFence(client: SQLClient, source: PostgresSource, acceptDifferentIncarnation = false) {
  const rows = await client.unsafe<Array<{ incarnation: string; remote_revision_high_water: number }>>(
    "select incarnation, remote_revision_high_water from opencode.source where installation_id=$1 and source_id=$2",
    [source.installationID, source.sourceID],
  )
  const row = rows[0]
  if (!row) return { incarnation: source.incarnation, revision: 0 }
  if (row.incarnation !== source.incarnation && !acceptDifferentIncarnation) throw new Error("Postgres source incarnation fence failed; run installation reset or adopt")
  return { incarnation: row.incarnation, revision: Number(row.remote_revision_high_water) }
}

export async function uploadFenced(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  if (!rows.length) return source.expectedRevision
  let uploadedHighWater = source.expectedRevision
  await client.begin(async (transaction) => {
    const sourceRows = await transaction.unsafe<Array<{ incarnation: string; remote_revision_high_water: number; lease_owner: string }>>(
      "select incarnation, remote_revision_high_water, lease_owner from opencode.source where installation_id=$1 and source_id=$2 for update",
      [source.installationID, source.sourceID],
    )
    const remote = sourceRows[0]
    if (!remote || remote.incarnation !== source.incarnation || remote.lease_owner !== source.ownerToken || Number(remote.remote_revision_high_water) !== source.expectedRevision) {
      throw new Error("Postgres source incarnation or revision fence failed; run installation reset or adopt")
    }
    let highWater = source.expectedRevision
    for (const row of rows) {
      if (row.recordRevision !== highWater + 1) throw new Error(`non-contiguous outbox delivery at revision ${row.recordRevision}; expected ${highWater + 1}`)
      highWater = row.recordRevision
    }
    await upsertRecords(transaction, source, rows)
    await transaction.unsafe(
      "update opencode.source set remote_revision_high_water=$1, lease_until=now() + interval '30 seconds', last_seen_at=now() where installation_id=$2 and source_id=$3 and incarnation=$4 and remote_revision_high_water=$5 and lease_owner=$6",
      [highWater, source.installationID, source.sourceID, source.incarnation, source.expectedRevision, source.ownerToken],
    )
    uploadedHighWater = highWater
  })
  return uploadedHighWater
}

async function upsertRecords(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const groups = new Map<string, OutboxRow[]>()
  for (const row of deduplicateRemoteKeys(rows)) {
    if (!["session", "message", "part", "todo"].includes(row.recordKind)) throw new Error(`unsupported remote record kind: ${row.recordKind}`)
    const group = groups.get(row.recordKind)
    if (group) group.push(row)
    else groups.set(row.recordKind, [row])
  }
  for (const [table, group] of groups) {
    if (table === "session") await upsertSessions(client, source, group)
    if (table === "message") await upsertMessages(client, source, group)
    if (table === "part") await upsertParts(client, source, group)
    if (table === "todo") await upsertTodos(client, source, group)
  }
}

function deduplicateRemoteKeys(rows: OutboxRow[]) {
  const latest = new Map<string, OutboxRow>()
  for (const row of rows) {
    const key = `${row.recordKind}\u0000${remoteKey(row)}`
    const previous = latest.get(key)
    if (!previous || row.recordRevision > previous.recordRevision) latest.set(key, row)
  }
  return [...latest.values()].sort((left, right) => left.recordRevision - right.recordRevision)
}

function remoteKey(row: OutboxRow) {
  const payload = mergePayload(row)
  if (row.recordKind === "session") return row.naturalKey
  if (row.recordKind === "message") return `${stringValue(payload.session_id) ?? ""}\u0000${row.naturalKey}`
  if (row.recordKind === "part") return `${stringValue(payload.session_id) ?? ""}\u0000${stringValue(payload.message_id) ?? ""}\u0000${row.naturalKey.split(":").at(-1) ?? ""}`
  if (row.recordKind === "todo") return `${stringValue(payload.session_id) ?? ""}\u0000${String(payload.position ?? "")}`
  return row.naturalKey
}

async function upsertSessions(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const args: unknown[] = []
  const values = rows.map((row) => {
    const payload = mergePayload(row)
    return tuple(args, [source.installationID, source.sourceID, row.naturalKey, stringValue(payload.parent_session_id), stringValue(payload.directory), stringValue(payload.title), objectValue(payload.model), objectValue(payload.metadata), Number(payload.source_created_at ?? 0), Number(payload.source_updated_at ?? 0), row.recordRevision, deletedAt(row)], [8, 9])
  })
  await client.unsafe(`insert into opencode.session(installation_id, source_id, session_id, parent_session_id, directory, title, model, metadata, source_created_at, source_updated_at, record_revision, deleted_at)
    values ${values.join(",")} on conflict (installation_id, source_id, session_id) do update set parent_session_id=excluded.parent_session_id, directory=excluded.directory, title=excluded.title, model=excluded.model, metadata=excluded.metadata, source_created_at=excluded.source_created_at, source_updated_at=excluded.source_updated_at, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
    where excluded.record_revision > opencode.session.record_revision`, args)
}

async function upsertMessages(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const args: unknown[] = []
  const values = rows.map((row) => {
    const payload = mergePayload(row)
    const data = objectValue(payload.data)
    return tuple(args, [source.installationID, source.sourceID, stringValue(payload.session_id), row.naturalKey, stringValue(data.role) ?? "unknown", stringValue(data.parentID), data.summary === true, data, Number(payload.source_created_at ?? 0), Number(payload.source_updated_at ?? 0), row.recordRevision, deletedAt(row)], [8, 9])
  })
  await client.unsafe(`insert into opencode.message(installation_id, source_id, session_id, message_id, role, parent_id, summary, data, source_created_at, source_updated_at, record_revision, deleted_at)
    values ${values.join(",")} on conflict (installation_id, source_id, session_id, message_id) do update set role=excluded.role, parent_id=excluded.parent_id, summary=excluded.summary, data=excluded.data, source_created_at=excluded.source_created_at, source_updated_at=excluded.source_updated_at, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
    where excluded.record_revision > opencode.message.record_revision`, args)
}

async function upsertParts(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const args: unknown[] = []
  const values = rows.map((row) => {
    const payload = mergePayload(row)
    const data = objectValue(payload.data)
    return tuple(args, [source.installationID, source.sourceID, stringValue(payload.session_id), stringValue(payload.message_id), row.naturalKey.split(":").at(-1), stringValue(data.type) ?? "unknown", data, Number(payload.source_created_at ?? 0), Number(payload.source_updated_at ?? 0), row.recordRevision, deletedAt(row)], [7, 8])
  })
  await client.unsafe(`insert into opencode.part(installation_id, source_id, session_id, message_id, part_id, part_type, data, source_created_at, source_updated_at, record_revision, deleted_at)
    values ${values.join(",")} on conflict (installation_id, source_id, session_id, message_id, part_id) do update set part_type=excluded.part_type, data=excluded.data, source_created_at=excluded.source_created_at, source_updated_at=excluded.source_updated_at, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
    where excluded.record_revision > opencode.part.record_revision`, args)
}

async function upsertTodos(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const args: unknown[] = []
  const values = rows.map((row) => {
    const data = mergePayload(row)
    return tuple(args, [source.installationID, source.sourceID, stringValue(data.session_id), Number(data.position), data, Number(data.source_updated_at ?? 0), row.recordRevision, deletedAt(row)], [5])
  })
  await client.unsafe(`insert into opencode.todo(installation_id, source_id, session_id, position, data, source_updated_at, record_revision, deleted_at)
    values ${values.join(",")} on conflict (installation_id, source_id, session_id, position) do update set data=excluded.data, source_updated_at=excluded.source_updated_at, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
    where excluded.record_revision > opencode.todo.record_revision`, args)
}

function mergePayload(row: OutboxRow) {
  const payload = row.payloadJSON ? JSON.parse(row.payloadJSON) as Record<string, unknown> : {}
  const routing = row.routingJSON ? JSON.parse(row.routingJSON) as Record<string, unknown> : {}
  return sanitizeJSONValue({ ...routing, ...payload }) as Record<string, unknown>
}

function sanitizeJSONValue(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll("\u0000", "\\u0000")
  if (Array.isArray(value)) return value.map((item) => sanitizeJSONValue(item))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replaceAll("\u0000", "\\u0000"), sanitizeJSONValue(item)]))
  return value
}

function deletedAt(row: OutboxRow) {
  return row.operation === "delete" ? new Date() : null
}

function tuple(args: unknown[], values: unknown[], timestamps: number[] = []) {
  const start = args.length + 1
  args.push(...values)
  return `(${values.map((_, index) => timestamps.includes(index) ? `to_timestamp($${start + index} / 1000.0)` : `$${start + index}`).join(",")})`
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}
