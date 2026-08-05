import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"

export type NormalizedRecord = {
  sourceID: string
  recordKind: string
  naturalKey: string
  sourceVersion?: string
  payloadJSON?: string
  payloadSHA256: string
  recordRevision: number
  deletedAt?: number
  observedAt: number
}

export type OutboxRow = NormalizedRecord & {
  id: number
  destinationID: string
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
      create table if not exists normalized_record (source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, source_version text, payload_json text, payload_sha256 text not null, record_revision integer not null, deleted_at integer, observed_at integer not null, primary key (source_id, record_kind, natural_key));
      create table if not exists destination (id text primary key, kind text not null, config_ref text not null, created_at integer not null);
      create table if not exists outbox (id integer primary key, destination_id text not null references destination(id) on delete cascade, source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, payload_json text, payload_sha256 text not null, record_revision integer not null, operation text not null check(operation in ('upsert', 'delete')), state text not null check(state in ('pending', 'leased', 'failed')), attempts integer not null default 0, next_attempt_at integer not null, lease_until integer, last_error text, created_at integer not null, unique(destination_id, source_id, record_kind, natural_key, record_revision));
      create index if not exists outbox_ready_idx on outbox(destination_id, state, next_attempt_at);
    `)
  }

  close() {
    this.db.close()
  }

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
    this.db.query(`insert into source(id, installation_id, kind, schema_version, canonical_locator, fingerprint, incarnation, created_at, last_seen_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set last_seen_at=excluded.last_seen_at, fingerprint=excluded.fingerprint`).run(source.id, source.installationID, source.kind, source.schemaVersion, source.locator, source.fingerprint ?? null, source.incarnation, Date.now(), Date.now())
  }

  nextRevision(sourceID: string) {
    const row = this.db.query("select coalesce(max(record_revision), 0) as value from normalized_record where source_id=?").get(sourceID) as { value: number }
    return Number(row.value)
  }

  enqueue(records: NormalizedRecord[], sourceID: string, stream: string, checkpoint: unknown, destinationID = "postgres") {
    const transaction = this.db.transaction(() => {
      for (const record of records) {
        this.db.query(`insert into normalized_record(source_id, record_kind, natural_key, source_version, payload_json, payload_sha256, record_revision, deleted_at, observed_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_id, record_kind, natural_key) do update set source_version=excluded.source_version, payload_json=excluded.payload_json, payload_sha256=excluded.payload_sha256, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, observed_at=excluded.observed_at
          where excluded.record_revision > normalized_record.record_revision`).run(record.sourceID, record.recordKind, record.naturalKey, record.sourceVersion ?? null, record.payloadJSON ?? null, record.payloadSHA256, record.recordRevision, record.deletedAt ?? null, record.observedAt)
        this.db.query(`insert into outbox(destination_id, source_id, record_kind, natural_key, payload_json, payload_sha256, record_revision, operation, state, next_attempt_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          on conflict(destination_id, source_id, record_kind, natural_key, record_revision) do nothing`).run(destinationID, record.sourceID, record.recordKind, record.naturalKey, record.payloadJSON ?? null, record.payloadSHA256, record.recordRevision, record.deletedAt === undefined ? "upsert" : "delete", Date.now(), Date.now())
      }
      this.db.query("insert into source_cursor(source_id, stream, checkpoint_json, updated_at) values (?, ?, ?, ?) on conflict(source_id, stream) do update set checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at").run(sourceID, stream, JSON.stringify(checkpoint), Date.now())
    })
    transaction()
  }

  claim(destinationID: string, limit: number, now = Date.now(), leaseMs = 60_000): OutboxRow[] {
    const rows = this.db.query(`select * from outbox where destination_id=? and (state='pending' or (state='leased' and lease_until<?) or (state='failed' and next_attempt_at<=?)) order by id limit ?`).all(destinationID, now, now, limit) as Array<Record<string, unknown>>
    const leaseUntil = now + leaseMs
    for (const row of rows) this.db.query("update outbox set state='leased', lease_until=?, attempts=attempts+1 where id=?").run(leaseUntil, Number(row.id))
    return rows.map((row) => ({ ...row, id: Number(row.id), sourceID: String(row.source_id), recordKind: String(row.record_kind), naturalKey: String(row.natural_key), payloadSHA256: String(row.payload_sha256), recordRevision: Number(row.record_revision), attempts: Number(row.attempts) + 1, destinationID: String(row.destination_id), operation: row.operation as "upsert" | "delete" })) as OutboxRow[]
  }

  acknowledge(ids: number[]) {
    if (!ids.length) return
    this.db.query(`delete from outbox where id in (${ids.map(() => "?").join(",")})`).run(...ids)
  }
}

export async function openSyncState(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  return new SyncState(filename)
}
