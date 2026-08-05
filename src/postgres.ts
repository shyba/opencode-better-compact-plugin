import type { OutboxRow } from "./sync-state.js"

type SQLClient = {
  unsafe<T = unknown>(query: string, values?: unknown[]): Promise<T>
  begin<T>(callback: (transaction: SQLClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export type PostgresSource = {
  installationID: string
  sourceID: string
  incarnation: string
  expectedRevision: number
}

export function openPostgres(url: string) {
  const constructor = (Bun as unknown as { SQL: new (connection: string) => SQLClient }).SQL
  return new constructor(url)
}

export async function ensureRemoteSource(client: SQLClient, source: PostgresSource, kind: string, schemaVersion: number, fingerprint: string) {
  await client.unsafe(`insert into opencode.installation(installation_id, incarnation, label)
    values ($1,$2,$3)
    on conflict (installation_id) do update set last_seen_at=now()
    where opencode.installation.incarnation=$2`, [source.installationID, source.incarnation, source.installationID])
  await client.unsafe(`insert into opencode.source(installation_id, source_id, incarnation, kind, schema_version, locator_fingerprint)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (installation_id, source_id) do update set last_seen_at=now()
    where opencode.source.incarnation=$3`, [source.installationID, source.sourceID, source.incarnation, kind, schemaVersion, fingerprint])
}

export async function readRemoteFence(client: SQLClient, source: PostgresSource) {
  const rows = await client.unsafe<Array<{ incarnation: string; remote_revision_high_water: number }>>(
    "select incarnation, remote_revision_high_water from opencode.source where installation_id=$1 and source_id=$2",
    [source.installationID, source.sourceID],
  )
  const row = rows[0]
  if (!row) return { incarnation: source.incarnation, revision: 0 }
  if (row.incarnation !== source.incarnation) throw new Error("Postgres source incarnation fence failed; run installation reset or adopt")
  return { incarnation: row.incarnation, revision: Number(row.remote_revision_high_water) }
}

export async function uploadFenced(client: SQLClient, source: PostgresSource, rows: OutboxRow[]) {
  if (!rows.length) return source.expectedRevision
  let uploadedHighWater = source.expectedRevision
  await client.begin(async (transaction) => {
    const sourceRows = await transaction.unsafe<Array<{ incarnation: string; remote_revision_high_water: number }>>(
      "select incarnation, remote_revision_high_water from opencode.source where installation_id=$1 and source_id=$2 for update",
      [source.installationID, source.sourceID],
    )
    const remote = sourceRows[0]
    if (!remote || remote.incarnation !== source.incarnation || Number(remote.remote_revision_high_water) !== source.expectedRevision) {
      throw new Error("Postgres source incarnation or revision fence failed; run installation reset or adopt")
    }
    let highWater = source.expectedRevision
    for (const row of rows) {
      if (row.recordRevision !== highWater + 1) throw new Error(`non-contiguous outbox delivery at revision ${row.recordRevision}; expected ${highWater + 1}`)
      const payload = row.payloadJSON ? JSON.parse(row.payloadJSON) as Record<string, unknown> : {}
      const routing = row.routingJSON ? JSON.parse(row.routingJSON) as Record<string, unknown> : {}
      await upsertRecord(transaction, source, row, { ...routing, ...payload })
      highWater = row.recordRevision
    }
    await transaction.unsafe(
      "update opencode.source set remote_revision_high_water=$1, last_seen_at=now() where installation_id=$2 and source_id=$3 and incarnation=$4 and remote_revision_high_water=$5",
      [highWater, source.installationID, source.sourceID, source.incarnation, source.expectedRevision],
    )
    uploadedHighWater = highWater
  })
  return uploadedHighWater
}

async function upsertRecord(client: SQLClient, source: PostgresSource, row: OutboxRow, payload: Record<string, unknown>) {
  const table = row.recordKind === "session" || row.recordKind === "message" || row.recordKind === "part" || row.recordKind === "todo" ? row.recordKind : undefined
  if (!table) throw new Error(`unsupported remote record kind: ${row.recordKind}`)
  const deleted = row.operation === "delete" ? new Date() : null
  if (table === "session") {
    await client.unsafe(`insert into opencode.session(installation_id, source_id, session_id, title, metadata, record_revision, deleted_at)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (installation_id, source_id, session_id) do update set title=excluded.title, metadata=excluded.metadata, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
      where excluded.record_revision > opencode.session.record_revision`, [source.installationID, source.sourceID, row.naturalKey, stringValue(payload.title), payload, row.recordRevision, deleted])
    return
  }
  if (table === "message") {
    const data = objectValue(payload.data)
    await client.unsafe(`insert into opencode.message(installation_id, source_id, session_id, message_id, role, summary, data, record_revision, deleted_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (installation_id, source_id, session_id, message_id) do update set role=excluded.role, summary=excluded.summary, data=excluded.data, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
      where excluded.record_revision > opencode.message.record_revision`, [source.installationID, source.sourceID, stringValue(payload.session_id), row.naturalKey, stringValue(data.role) ?? "unknown", data.summary === true, data, row.recordRevision, deleted])
    return
  }
  if (table === "part") {
    const data = objectValue(payload.data)
    await client.unsafe(`insert into opencode.part(installation_id, source_id, session_id, message_id, part_id, part_type, data, record_revision, deleted_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (installation_id, source_id, session_id, message_id, part_id) do update set part_type=excluded.part_type, data=excluded.data, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
      where excluded.record_revision > opencode.part.record_revision`, [source.installationID, source.sourceID, stringValue(payload.session_id), stringValue(payload.message_id), row.naturalKey.split(":").at(-1), stringValue(data.type) ?? "unknown", data, row.recordRevision, deleted])
    return
  }
  const data = payload
  await client.unsafe(`insert into opencode.todo(installation_id, source_id, session_id, position, data, record_revision, deleted_at)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (installation_id, source_id, session_id, position) do update set data=excluded.data, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, synced_at=now()
    where excluded.record_revision > opencode.todo.record_revision`, [source.installationID, source.sourceID, stringValue(data.session_id), Number(data.position), data, row.recordRevision, deleted])
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}
