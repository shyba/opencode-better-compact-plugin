import { mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"

export type NormalizedRecord = {
  sourceID: string
  recordKind: string
  naturalKey: string
  sourceVersion?: string
  routingJSON?: string
  payloadJSON?: string
  payloadSHA256: string
  deletedAt?: number
  observedAt: number
}

export type OutboxRow = NormalizedRecord & {
  id: number
  destinationID: string
  recordRevision: number
  operation: "upsert" | "delete"
  attempts: number
}

export class SyncState {
  readonly db: Database

  constructor(readonly filename: string) {
    this.db = new Database(filename)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;")
    this.db.exec(`
      create table if not exists schema_migration (version integer primary key, applied_at integer not null);
      create table if not exists installation (id text primary key, incarnation text not null, created_at integer not null, adopted_at integer);
      create table if not exists source (id text primary key, installation_id text not null references installation(id) on delete cascade, kind text not null, schema_version integer not null, canonical_locator text not null, fingerprint text, incarnation text not null, remote_revision_high_water integer, created_at integer not null, last_seen_at integer not null);
      create table if not exists source_cursor (source_id text not null references source(id) on delete cascade, stream text not null, checkpoint_json text not null, reconcile_before integer, updated_at integer not null, primary key (source_id, stream));
      create table if not exists normalized_record (source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, source_version text, routing_json text, payload_json text, payload_sha256 text not null, record_revision integer not null, deleted_at integer, observed_at integer not null, primary key (source_id, record_kind, natural_key));
      create table if not exists destination (id text primary key, kind text not null, config_ref text not null, created_at integer not null);
      create table if not exists outbox (id integer primary key, destination_id text not null references destination(id) on delete cascade, source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, routing_json text, payload_json text, payload_sha256 text not null, record_revision integer not null, operation text not null check(operation in ('upsert', 'delete')), state text not null check(state in ('pending', 'leased', 'failed')), attempts integer not null default 0, next_attempt_at integer not null, lease_until integer, last_error text, created_at integer not null, unique(destination_id, source_id, record_kind, natural_key, record_revision));
      create index if not exists outbox_ready_idx on outbox(destination_id, state, next_attempt_at, record_revision);
    `)
    this.db.query("insert or ignore into schema_migration(version, applied_at) values (1, ?)").run(Date.now())
    this.applyLocalMigrations()
  }

  private applyLocalMigrations() {
    const migrations = [
      [2, "normalized_record", "routing_json"],
      [3, "outbox", "routing_json"],
    ] as const
    for (const [version, table, column] of migrations) {
      const exists = (this.db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column)
      if (!exists) this.db.exec(`alter table ${table} add column ${column} text`)
      this.db.query("insert or ignore into schema_migration(version, applied_at) values (?, ?)").run(version, Date.now())
    }
  }

  close() { this.db.close() }

  ensureInstallation(id: string, incarnation: string, name = "default") {
    const now = Date.now()
    this.db.query("insert into installation(id, incarnation, created_at) values (?, ?, ?) on conflict(id) do nothing").run(id, incarnation, now)
    this.db.query("insert into destination(id, kind, config_ref, created_at) values (?, 'postgres', ?, ?) on conflict(id) do nothing").run("postgres", name, now)
  }

  ensureDefaultInstallation() {
    const existing = this.db.query("select id, incarnation from installation order by created_at limit 1").get() as { id: string; incarnation: string } | null
    if (existing) return existing
    const value = { id: randomUUID(), incarnation: randomUUID() }
    this.ensureInstallation(value.id, value.incarnation)
    return value
  }

  upsertSource(source: { id: string; installationID: string; kind: string; schemaVersion: number; locator: string; fingerprint?: string; incarnation: string }) {
    const existing = this.db.query("select fingerprint, installation_id from source where id=?").get(source.id) as { fingerprint?: string; installation_id: string } | null
    if (existing?.fingerprint && source.fingerprint && existing.fingerprint !== source.fingerprint) throw new Error(`source layout fingerprint changed for ${source.id}; inspect the migration before syncing`)
    if (existing?.installation_id && existing.installation_id !== source.installationID) throw new Error(`source ${source.id} belongs to a different installation`)
    this.db.query(`insert into source(id, installation_id, kind, schema_version, canonical_locator, fingerprint, incarnation, created_at, last_seen_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set last_seen_at=excluded.last_seen_at, fingerprint=excluded.fingerprint`).run(source.id, source.installationID, source.kind, source.schemaVersion, source.locator, source.fingerprint ?? null, source.incarnation, Date.now(), Date.now())
  }

  sourceIncarnation(sourceID: string, fallback = randomUUID()) {
    const row = this.db.query("select incarnation from source where id=?").get(sourceID) as { incarnation: string } | null
    return row?.incarnation ?? fallback
  }

  adoptSourceIncarnation(sourceID: string, incarnation: string) {
    this.db.query("update source set incarnation=? where id=?").run(incarnation, sourceID)
  }

  nextRevision(sourceID: string) {
    const row = this.db.query("select coalesce(max(record_revision), 0) as value from normalized_record where source_id=?").get(sourceID) as { value: number }
    return Number(row.value)
  }

  remoteRevision(sourceID: string) {
    const row = this.db.query("select coalesce(remote_revision_high_water, 0) as value from source where id=?").get(sourceID) as { value: number } | null
    return Number(row?.value ?? 0)
  }

  setRemoteRevision(sourceID: string, revision: number) {
    this.db.query("update source set remote_revision_high_water=? where id=?").run(revision, sourceID)
  }

  checkpoint(sourceID: string, stream = "messages") {
    const row = this.db.query("select checkpoint_json from source_cursor where source_id=? and stream=?").get(sourceID, stream) as { checkpoint_json: string } | null
    if (!row) return undefined
    try { return JSON.parse(row.checkpoint_json) as Record<string, unknown> } catch { return undefined }
  }

  enqueue(records: NormalizedRecord[], sourceID: string, stream: string, checkpoint: unknown, destinationID = "postgres", snapshot?: { complete: boolean; recordKinds: string[] }, maxOutboxBytes = Number.POSITIVE_INFINITY) {
    const transaction = this.db.transaction(() => {
      let nextRevision = this.nextRevision(sourceID)
      for (const record of records) {
        const previous = this.db.query("select payload_sha256, source_version, deleted_at from normalized_record where source_id=? and record_kind=? and natural_key=?").get(record.sourceID, record.recordKind, record.naturalKey) as { payload_sha256: string; source_version?: string; deleted_at?: number } | null
        if (previous && previous.payload_sha256 === record.payloadSHA256 && previous.source_version === (record.sourceVersion ?? null) && Boolean(previous.deleted_at) === (record.deletedAt !== undefined)) continue
        nextRevision++
        this.db.query(`insert into normalized_record(source_id, record_kind, natural_key, source_version, routing_json, payload_json, payload_sha256, record_revision, deleted_at, observed_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_id, record_kind, natural_key) do update set source_version=excluded.source_version, routing_json=excluded.routing_json, payload_json=excluded.payload_json, payload_sha256=excluded.payload_sha256, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, observed_at=excluded.observed_at`).run(record.sourceID, record.recordKind, record.naturalKey, record.sourceVersion ?? null, record.routingJSON ?? null, record.payloadJSON ?? null, record.payloadSHA256, nextRevision, record.deletedAt ?? null, record.observedAt)
        this.db.query(`insert into outbox(destination_id, source_id, record_kind, natural_key, routing_json, payload_json, payload_sha256, record_revision, operation, state, next_attempt_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          on conflict(destination_id, source_id, record_kind, natural_key, record_revision) do nothing`).run(destinationID, record.sourceID, record.recordKind, record.naturalKey, record.routingJSON ?? null, record.payloadJSON ?? null, record.payloadSHA256, nextRevision, record.deletedAt === undefined ? "upsert" : "delete", Date.now(), Date.now())
      }
      if (snapshot?.complete) {
        const seen = new Set(records.filter((record) => snapshot.recordKinds.includes(record.recordKind)).map((record) => `${record.recordKind}\u0000${record.naturalKey}`))
        const placeholders = snapshot.recordKinds.map(() => "?").join(",")
        const existing = this.db.query(`select record_kind, natural_key, routing_json from normalized_record where source_id=? and record_kind in (${placeholders}) and deleted_at is null`).all(sourceID, ...snapshot.recordKinds) as Array<{ record_kind: string; natural_key: string; routing_json?: string }>
        for (const row of existing) {
          if (seen.has(`${row.record_kind}\u0000${row.natural_key}`)) continue
          nextRevision++
          const deletedAt = Date.now()
          this.db.query(`update normalized_record set payload_json=null, payload_sha256='', record_revision=?, deleted_at=?, observed_at=? where source_id=? and record_kind=? and natural_key=?`).run(nextRevision, deletedAt, deletedAt, sourceID, row.record_kind, row.natural_key)
          this.db.query(`insert into outbox(destination_id, source_id, record_kind, natural_key, routing_json, payload_json, payload_sha256, record_revision, operation, state, next_attempt_at, created_at)
            values (?, ?, ?, ?, ?, null, '', ?, 'delete', 'pending', ?, ?)
            on conflict(destination_id, source_id, record_kind, natural_key, record_revision) do nothing`).run(destinationID, sourceID, row.record_kind, row.natural_key, row.routing_json ?? null, nextRevision, Date.now(), Date.now())
        }
      }
      if (this.outboxBytes(destinationID) > maxOutboxBytes) throw new Error(`better-compact outbox exceeds configured limit of ${maxOutboxBytes} bytes`)
      this.db.query("insert into source_cursor(source_id, stream, checkpoint_json, updated_at) values (?, ?, ?, ?) on conflict(source_id, stream) do update set checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at").run(sourceID, stream, JSON.stringify(checkpoint), Date.now())
    })
    transaction()
  }

  claim(destinationID: string, limit: number, now = Date.now(), leaseMs = 60_000, sourceID?: string, afterRevision = 0): OutboxRow[] {
    const filter = sourceID ? " and source_id=?" : ""
    const args = sourceID ? [destinationID, now, now, sourceID, afterRevision, limit] : [destinationID, now, now, afterRevision, limit]
    const nextArgs = sourceID ? [destinationID, now, now, sourceID, afterRevision] : [destinationID, now, now, afterRevision]
    const next = this.db.query(`select min(record_revision) as value from outbox where destination_id=? and (state='pending' or (state='leased' and lease_until<?) or (state='failed' and next_attempt_at<=?))${filter} and record_revision>?`).get(...nextArgs) as { value: number | null }
    if (next.value === null || Number(next.value) !== afterRevision + 1) return []
    const rows = this.db.query(`select * from outbox where destination_id=? and (state='pending' or (state='leased' and lease_until<?) or (state='failed' and next_attempt_at<=?))${filter} and record_revision>? order by record_revision limit ?`).all(...args) as Array<Record<string, unknown>>
    const contiguous = rows.filter((row, index) => Number(row.record_revision) === afterRevision + index + 1)
    if (!contiguous.length) return []
    const leaseUntil = now + leaseMs
    const claimed: Array<Record<string, unknown>> = []
    const transaction = this.db.transaction(() => contiguous.forEach((row) => {
      const result = this.db.query("update outbox set state='leased', lease_until=?, attempts=attempts+1 where id=? and (state='pending' or state='failed' or lease_until<?)").run(leaseUntil, Number(row.id), now) as { changes?: number }
      if (result.changes !== 0) claimed.push(row)
    }))
    transaction()
    return claimed.map((row) => ({ ...row, id: Number(row.id), sourceID: String(row.source_id), recordKind: String(row.record_kind), naturalKey: String(row.natural_key), routingJSON: typeof row.routing_json === "string" ? row.routing_json : undefined, payloadJSON: typeof row.payload_json === "string" ? row.payload_json : undefined, payloadSHA256: String(row.payload_sha256), recordRevision: Number(row.record_revision), attempts: Number(row.attempts) + 1, destinationID: String(row.destination_id), operation: row.operation as "upsert" | "delete" })) as OutboxRow[]
  }

  acknowledge(ids: number[]) { if (ids.length) this.db.query(`delete from outbox where id in (${ids.map(() => "?").join(",")})`).run(...ids) }
  adoptThrough(sourceID: string, revision: number, destinationID = "postgres") { this.db.query("delete from outbox where source_id=? and destination_id=? and record_revision<=? and state!='leased'").run(sourceID, destinationID, revision) }
  fail(ids: number[], error: string, nextAttemptAt = Date.now() + 30_000) { if (ids.length) this.db.query(`update outbox set state='failed', lease_until=null, last_error=?, next_attempt_at=? where id in (${ids.map(() => "?").join(",")})`).run(error.slice(0, 1000), nextAttemptAt, ...ids) }
  pendingCount(destinationID = "postgres") { const row = this.db.query("select count(*) as value from outbox where destination_id=?").get(destinationID) as { value: number }; return Number(row.value) }
  purgePayloads(retentionMs: number) { this.db.query("update normalized_record set payload_json=null where observed_at<? and not exists (select 1 from outbox where outbox.source_id=normalized_record.source_id and outbox.record_kind=normalized_record.record_kind and outbox.natural_key=normalized_record.natural_key)").run(Date.now() - retentionMs) }
  outboxBytes(destinationID = "postgres") { const rows = this.db.query("select payload_json, routing_json from outbox where destination_id=?").all(destinationID) as Array<{ payload_json?: string; routing_json?: string }>; return rows.reduce((total, row) => total + new TextEncoder().encode(`${row.payload_json ?? ""}${row.routing_json ?? ""}`).byteLength, 0) }
}

export async function openSyncState(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const state = new SyncState(filename)
  await chmod(filename, 0o600)
  await chmod(`${filename}-wal`, 0o600).catch(() => {})
  await chmod(`${filename}-shm`, 0o600).catch(() => {})
  return state
}
