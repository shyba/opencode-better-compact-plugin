import { CONTROL_RECORD_KINDS, type OutboxRow } from "./sync-state.js"

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
  let records: OutboxRow[] = []
  for (const row of rows) {
    if (isControl(row)) {
      if (records.length) {
        await upsertDataRecords(client, source, records)
        records = []
      }
      await applyControl(client, source, row)
      continue
    }
    records.push(row)
  }
  if (records.length) await upsertDataRecords(client, source, records)
}

async function upsertDataRecords(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
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
    await markSnapshotSeen(client, source, group)
  }
}

async function applyControl(client: SQLClient, source: PostgresSource, row: OutboxRow) {
  const value = parseObject(row.payloadJSON)
  if (row.recordKind === CONTROL_RECORD_KINDS.reconcilePrefix) return reconcilePrefix(client, source, row, value)
  if (row.recordKind === CONTROL_RECORD_KINDS.snapshotBegin) {
    await client.unsafe("delete from opencode.sync_snapshot_seen where installation_id=$1 and source_id=$2", [source.installationID, source.sourceID])
    return
  }
  if (row.recordKind === CONTROL_RECORD_KINDS.snapshotEnd) return reconcileSnapshot(client, source, row, value)
  throw new Error(`unsupported control record kind: ${row.recordKind}`)
}

async function reconcilePrefix(client: SQLClient, source: PostgresSource, row: OutboxRow, value: Record<string, unknown>) {
  const prefix = row.naturalKey
  const recordKinds = Array.isArray(value.recordKinds) ? value.recordKinds.filter((kind): kind is string => typeof kind === "string") : []
  if (recordKinds.includes("session")) await tombstonePrefix(client, "session", "session_id", source, prefix, row.recordRevision)
  if (recordKinds.includes("message")) await tombstonePrefix(client, "message", "message_id", source, prefix, row.recordRevision)
}

async function tombstonePrefix(client: SQLClient, table: string, keyColumn: string, source: PostgresSource, prefix: string, revision: number) {
  await client.unsafe(`update opencode.${table} set deleted_at=now(), record_revision=$1, synced_at=now()
    where installation_id=$2 and source_id=$3 and deleted_at is null and ${keyColumn} like $4 || '%' escape E'\\\\'`, [revision, source.installationID, source.sourceID, escapeLikePrefix(prefix)])
}

function escapeLikePrefix(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
}

async function markSnapshotSeen(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  const seen = rows.flatMap((row) => {
    const token = snapshotToken(row)
    return token ? [{ token, recordKind: row.recordKind, naturalKey: snapshotSeenKey(row) }] : []
  })
  if (!seen.length) return
  const args: unknown[] = []
  const values = seen.map((row) => {
    const start = args.length + 1
    args.push(source.installationID, source.sourceID, row.token, row.recordKind, row.naturalKey)
    return `($${start},$${start + 1},$${start + 2},$${start + 3},$${start + 4}::jsonb)`
  })
  await client.unsafe(`insert into opencode.sync_snapshot_seen(installation_id, source_id, snapshot_token, record_kind, natural_key)
    values ${values.join(",")} on conflict do nothing`, args)
}

async function reconcileSnapshot(client: SQLClient, source: PostgresSource, row: OutboxRow, value: Record<string, unknown>) {
  const token = typeof value.token === "string" ? value.token : row.naturalKey
  const recordKinds = Array.isArray(value.recordKinds) ? value.recordKinds.filter((kind): kind is string => typeof kind === "string") : []
  const tables = [
    ["session", "json_build_array(session_id)::jsonb"],
    ["message", "json_build_array(session_id, message_id)::jsonb"],
    ["part", "json_build_array(session_id, message_id, part_id)::jsonb"],
    ["todo", "json_build_array(session_id, position)::jsonb"],
  ] as const
  for (const [kind, keyExpression] of tables) {
    if (!recordKinds.includes(kind)) continue
    await client.unsafe(`update opencode.${kind} as target set deleted_at=now(), record_revision=$1, synced_at=now()
      where target.installation_id=$2 and target.source_id=$3 and target.deleted_at is null
        and not exists (select 1 from opencode.sync_snapshot_seen seen where seen.installation_id=$2 and seen.source_id=$3 and seen.snapshot_token=$4 and seen.record_kind=$5 and seen.natural_key=${keyExpression})`, [row.recordRevision, source.installationID, source.sourceID, token, kind])
  }
  await client.unsafe("delete from opencode.sync_snapshot_seen where installation_id=$1 and source_id=$2 and snapshot_token=$3", [source.installationID, source.sourceID, token])
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
  const payload = parseObject(row.payloadJSON)
  const routing = parseObject(row.routingJSON)
  delete routing.__better_compact_snapshot
  return sanitizeJSONValue({ ...routing, ...payload }) as Record<string, unknown>
}

function snapshotToken(row: OutboxRow) {
  const routing = parseObject(row.routingJSON)
  return typeof routing.__better_compact_snapshot === "string" ? routing.__better_compact_snapshot : undefined
}

function snapshotSeenKey(row: OutboxRow) {
  const payload = mergePayload(row)
  if (row.recordKind === "session") return [row.naturalKey]
  if (row.recordKind === "message") return [stringValue(payload.session_id) ?? "", row.naturalKey]
  if (row.recordKind === "part") return [stringValue(payload.session_id) ?? "", stringValue(payload.message_id) ?? "", row.naturalKey.split(":").at(-1) ?? ""]
  if (row.recordKind === "todo") return [stringValue(payload.session_id) ?? "", Number(payload.position ?? 0)]
  return [row.naturalKey]
}

function isControl(row: OutboxRow) {
  return Object.values(CONTROL_RECORD_KINDS).includes(row.recordKind as typeof CONTROL_RECORD_KINDS[keyof typeof CONTROL_RECORD_KINDS])
}

function parseObject(value?: string) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
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
