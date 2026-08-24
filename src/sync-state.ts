import { mkdir, chmod } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Database } from "bun:sqlite"

export const CONTROL_RECORD_KINDS = {
  reconcilePrefix: "__better_compact_reconcile_prefix",
  snapshotBegin: "__better_compact_snapshot_begin",
  snapshotEnd: "__better_compact_snapshot_end",
} as const

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
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;")
    this.db.exec(`
      create table if not exists schema_migration (version integer primary key, applied_at integer not null);
      create table if not exists installation (id text primary key, incarnation text not null, created_at integer not null, adopted_at integer);
      create table if not exists source (id text primary key, installation_id text not null references installation(id) on delete cascade, kind text not null, schema_version integer not null, canonical_locator text not null, fingerprint text, incarnation text not null, remote_revision_high_water integer, local_revision integer not null default 0, records_staged integer not null default 0, records_sent integer not null default 0, bytes_sent integer not null default 0, last_staged_at integer, last_sent_at integer, last_remote_tombstone_purge_at integer, created_at integer not null, last_seen_at integer not null);
      create table if not exists source_cursor (source_id text not null references source(id) on delete cascade, stream text not null, checkpoint_json text not null, reconcile_before integer, updated_at integer not null, primary key (source_id, stream));
      create table if not exists normalized_record (source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, source_version text, routing_json text, payload_json text, payload_sha256 text not null, record_revision integer not null, deleted_at integer, observed_at integer not null, primary key (source_id, record_kind, natural_key));
      create table if not exists destination (id text primary key, kind text not null, config_ref text not null, created_at integer not null);
      create table if not exists outbox (id integer primary key, destination_id text not null references destination(id) on delete cascade, source_id text not null references source(id) on delete cascade, record_kind text not null, natural_key text not null, routing_json text, payload_json text, payload_sha256 text not null, record_revision integer not null, operation text not null check(operation in ('upsert', 'delete')), state text not null check(state in ('pending', 'leased', 'failed')), attempts integer not null default 0, next_attempt_at integer not null, lease_until integer, last_error text, created_at integer not null, unique(destination_id, source_id, record_kind, natural_key, record_revision));
      create index if not exists outbox_ready_idx on outbox(destination_id, state, next_attempt_at, record_revision);
      create index if not exists normalized_record_retention_idx on normalized_record(observed_at);
      create index if not exists outbox_record_idx on outbox(source_id, record_kind, natural_key);
      create table if not exists source_scan (source_id text primary key references source(id) on delete cascade, path_mtime_ms integer not null, path_size_or_count integer not null, child_max_mtime_ms integer not null, last_complete_scan_at integer not null);
      create table if not exists s3_file (source_id text not null references source(id) on delete cascade, path text not null, file_id text not null, size integer not null, mtime_ms real not null, sha256 text not null, updated_at integer not null, primary key (source_id, path));
    `)
    this.db.query("insert or ignore into schema_migration(version, applied_at) values (1, ?)").run(Date.now())
    this.applyLocalMigrations()
  }

  private applyLocalMigrations() {
    const migrations = [
      [2, "normalized_record", "routing_json", "text"],
      [3, "outbox", "routing_json", "text"],
      [4, "source", "local_revision", "integer not null default 0"],
      [5, "source", "records_staged", "integer not null default 0"],
      [6, "source", "records_sent", "integer not null default 0"],
      [7, "source", "bytes_sent", "integer not null default 0"],
      [8, "source", "last_staged_at", "integer"],
      [9, "source", "last_sent_at", "integer"],
      [10, "source", "last_remote_tombstone_purge_at", "integer"],
      [11, "source_scan", "source_id", "text primary key"],
    ] as const
    for (const [version, table, column, definition] of migrations) {
      if (definition.includes("primary key")) {
        const exists = (this.db.query(`select 1 from sqlite_master where type='table' and name=?`).get(table) !== null)
        if (!exists) this.db.exec(`create table if not exists ${table} (${column} references source(id) on delete cascade, path_mtime_ms integer not null, path_size_or_count integer not null, child_max_mtime_ms integer not null, last_complete_scan_at integer not null)`)
        this.db.query("insert or ignore into schema_migration(version, applied_at) values (?, ?)").run(version, Date.now())
        continue
      }
      const exists = (this.db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column)
      if (!exists) this.db.exec(`alter table ${table} add column ${column} ${definition}`)
      this.db.query("insert or ignore into schema_migration(version, applied_at) values (?, ?)").run(version, Date.now())
    }
    this.db.exec("create table if not exists hierarchy_backfill (source_id text not null references source(id) on delete cascade, path text not null, payload_sha256 text not null, hierarchy_status text not null, updated_at integer not null, primary key (source_id, path))")
    this.db.query("insert or ignore into schema_migration(version, applied_at) values (12, ?)").run(Date.now())
    this.db.exec("update source set local_revision=max(local_revision, coalesce((select max(record_revision) from normalized_record where normalized_record.source_id=source.id), 0))")
  }

  close() { this.db.close() }

  ensureInstallation(id: string, incarnation: string, name = "default", destinationID = "postgres", destinationKind = "postgres") {
    const now = Date.now()
    this.db.query("insert into installation(id, incarnation, created_at) values (?, ?, ?) on conflict(id) do nothing").run(id, incarnation, now)
    this.db.query("insert into destination(id, kind, config_ref, created_at) values (?, ?, ?, ?) on conflict(id) do nothing").run(destinationID, destinationKind, name, now)
  }

  ensureDefaultInstallation(name = "default", destinationID = "postgres", destinationKind = "postgres") {
    const existing = this.db.query("select id, incarnation from installation order by created_at limit 1").get() as { id: string; incarnation: string } | null
    if (existing) return existing
    const value = { id: randomUUID(), incarnation: randomUUID() }
    this.ensureInstallation(value.id, value.incarnation, name, destinationID, destinationKind)
    return value
  }

  adoptInstallationIncarnation(incarnation: string) {
    this.db.query("update installation set incarnation=?, adopted_at=?").run(incarnation, Date.now())
  }

  upsertSource(source: { id: string; installationID: string; kind: string; schemaVersion: number; locator: string; fingerprint?: string; incarnation: string }) {
    const existing = this.db.query("select fingerprint, schema_version, installation_id from source where id=?").get(source.id) as { fingerprint?: string; schema_version: number; installation_id: string } | null
    if (existing?.fingerprint && source.fingerprint && existing.fingerprint !== source.fingerprint && source.schemaVersion <= existing.schema_version) throw new Error(`source layout fingerprint changed without a recognized migration for ${source.id}`)
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
    const row = this.db.query("select coalesce(local_revision, 0) as value from source where id=?").get(sourceID) as { value: number } | null
    return Number(row?.value ?? 0)
  }

  remoteRevision(sourceID: string) {
    const row = this.db.query("select coalesce(remote_revision_high_water, 0) as value from source where id=?").get(sourceID) as { value: number } | null
    return Number(row?.value ?? 0)
  }

  setRemoteRevision(sourceID: string, revision: number) {
    this.db.query("update source set remote_revision_high_water=? where id=?").run(revision, sourceID)
  }

  remoteTombstonePurgeDue(sourceID: string, now = Date.now(), intervalMs = 24 * 60 * 60 * 1000) {
    const row = this.db.query("select last_remote_tombstone_purge_at from source where id=?").get(sourceID) as { last_remote_tombstone_purge_at?: number } | null
    return !row || row.last_remote_tombstone_purge_at === undefined || row.last_remote_tombstone_purge_at === null || Number(row.last_remote_tombstone_purge_at) <= now - intervalMs
  }

  markRemoteTombstonePurge(sourceID: string, at = Date.now()) {
    this.db.query("update source set last_remote_tombstone_purge_at=? where id=?").run(at, sourceID)
  }

  reconcileCommitted(sourceID: string, revision: number, destinationID = "postgres") {
    if (this.nextRevision(sourceID) < revision) return false
    this.setRemoteRevision(sourceID, revision)
    this.db.query("delete from outbox where source_id=? and destination_id=? and record_revision<=?").run(sourceID, destinationID, revision)
    this.releaseAcknowledgedRecords()
    return true
  }

  checkpoint(sourceID: string, stream = "messages") {
    const row = this.db.query("select checkpoint_json from source_cursor where source_id=? and stream=?").get(sourceID, stream) as { checkpoint_json: string } | null
    if (!row) return undefined
    try { return JSON.parse(row.checkpoint_json) as Record<string, unknown> } catch { return undefined }
  }

  forceReconcile(sourceIDs: string[], stream = "messages") {
    if (!sourceIDs.length) return 0
    const placeholders = sourceIDs.map(() => "?").join(",")
    const transaction = this.db.transaction(() => {
      const rows = this.db.query(`select source_id, checkpoint_json from source_cursor where stream=? and source_id in (${placeholders})`).all(stream, ...sourceIDs) as Array<{ source_id: string; checkpoint_json: string }>
      let changed = 0
      for (const row of rows) {
        let checkpoint: Record<string, unknown>
        try {
          const parsed = JSON.parse(row.checkpoint_json)
          checkpoint = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
        } catch {
          checkpoint = {}
        }
        checkpoint.forceReconcile = true
        checkpoint.reconcileBefore = 0
        this.db.query("update source_cursor set checkpoint_json=?, reconcile_before=0, updated_at=? where source_id=? and stream=?").run(JSON.stringify(checkpoint), Date.now(), row.source_id, stream)
        changed++
      }
      return changed
    })
    return transaction()
  }

  /** Record a successful complete scan of a source. The fingerprint lets the
   *  next syncPass detect "nothing changed" without re-running discovery. */
  recordSourceComplete(sourceID: string, pathMtimeMs: number, pathSizeOrCount: number, childMaxMtimeMs: number): void {
    this.db.query(
      "insert into source_scan(source_id, path_mtime_ms, path_size_or_count, child_max_mtime_ms, last_complete_scan_at) values(?, ?, ?, ?, ?) on conflict(source_id) do update set path_mtime_ms=excluded.path_mtime_ms, path_size_or_count=excluded.path_size_or_count, child_max_mtime_ms=excluded.child_max_mtime_ms, last_complete_scan_at=excluded.last_complete_scan_at"
    ).run(sourceID, pathMtimeMs, pathSizeOrCount, childMaxMtimeMs, Date.now())
  }

  /** Return true iff the source has been fully scanned before AND its current
   *  path fingerprint matches the one stored at the last complete scan. The
   *  caller is expected to have just computed a fresh fingerprint. */
  shouldSkipSource(sourceID: string, pathMtimeMs: number, pathSizeOrCount: number, childMaxMtimeMs: number, maxAgeMs?: number, now = Date.now()): boolean {
    const row = this.db.query("select path_mtime_ms, path_size_or_count, child_max_mtime_ms, last_complete_scan_at from source_scan where source_id=?").get(sourceID) as { path_mtime_ms: number; path_size_or_count: number; child_max_mtime_ms: number; last_complete_scan_at: number } | undefined
    if (!row) return false
    // The fingerprint only covers the path itself, so an age bound keeps a
    // stale skip from hiding appends (or a stalled drain) indefinitely.
    if (maxAgeMs !== undefined && now - Number(row.last_complete_scan_at) > maxAgeMs) return false
    return row.path_mtime_ms === pathMtimeMs && row.path_size_or_count === pathSizeOrCount && row.child_max_mtime_ms === childMaxMtimeMs
  }

  /** Persisted session inventory from the last discovery pass. The files map
   *  survives payload release, so hierarchy backfills use it as the session list. */
  sessionInventory(sourceID: string): Array<{ path: string; sessionID?: string; mtimeMs: number }> {
    const checkpoint = this.checkpoint(sourceID)
    const files = checkpoint?.files && typeof checkpoint.files === "object" && !Array.isArray(checkpoint.files) ? checkpoint.files as Record<string, { sessionID?: unknown; mtimeMs?: unknown }> : undefined
    return Object.entries(files ?? {}).map(([path, saved]) => ({ path, ...(typeof saved?.sessionID === "string" ? { sessionID: saved.sessionID } : {}), mtimeMs: Number(saved?.mtimeMs ?? 0) }))
  }

  /** Last successfully acknowledged S3 version for one source file. The S3
   *  service is idempotent by file_id, so this row is only a local hint for
   *  selecting an append suffix versus a full replacement after a crash. */
  s3File(sourceID: string, filePath: string): { fileID: string; size: number; mtimeMs: number; sha256: string } | undefined {
    const row = this.db.query("select file_id, size, mtime_ms, sha256 from s3_file where source_id=? and path=?").get(sourceID, filePath) as { file_id: string; size: number; mtime_ms: number; sha256: string } | null
    if (!row) return undefined
    return { fileID: row.file_id, size: Number(row.size), mtimeMs: Number(row.mtime_ms), sha256: row.sha256 }
  }

  recordS3File(sourceID: string, filePath: string, value: { fileID: string; size: number; mtimeMs: number; sha256: string }): void {
    this.db.query("insert into s3_file(source_id, path, file_id, size, mtime_ms, sha256, updated_at) values (?, ?, ?, ?, ?, ?, ?) on conflict(source_id, path) do update set file_id=excluded.file_id, size=excluded.size, mtime_ms=excluded.mtime_ms, sha256=excluded.sha256, updated_at=excluded.updated_at").run(sourceID, filePath, value.fileID, value.size, value.mtimeMs, value.sha256, Date.now())
  }

  hierarchyBackfillSHA(sourceID: string, path: string): string | undefined {
    const row = this.db.query("select payload_sha256 from hierarchy_backfill where source_id=? and path=?").get(sourceID, path) as { payload_sha256: string } | undefined
    return row?.payload_sha256
  }

  recordHierarchyBackfill(sourceID: string, path: string, payloadSHA256: string, hierarchyStatus: string): void {
    this.db.query("insert into hierarchy_backfill(source_id, path, payload_sha256, hierarchy_status, updated_at) values (?, ?, ?, ?, ?) on conflict(source_id, path) do update set payload_sha256=excluded.payload_sha256, hierarchy_status=excluded.hierarchy_status, updated_at=excluded.updated_at").run(sourceID, path, payloadSHA256, hierarchyStatus, Date.now())
  }

  enqueue(records: NormalizedRecord[], sourceID: string, stream: string, checkpoint: unknown, destinationID = "postgres", snapshot?: { complete?: boolean; recordKinds?: string[]; prefixes?: Array<{ prefix: string; lineCount: number; recordKinds: string[] }> }, maxOutboxBytes = Number.POSITIVE_INFINITY) {
    const transaction = this.db.transaction(() => {
      let nextRevision = this.nextRevision(sourceID)
      let stagedRecords = 0
      const snapshotToken = snapshot?.complete && snapshot.recordKinds?.length ? randomUUID() : undefined
      const snapshotRecordKinds = snapshot?.recordKinds
      const forceRecords = Boolean(snapshotToken || snapshot?.prefixes?.length)
      const enqueueRecord = (record: NormalizedRecord, normalized = true) => {
        const routingJSON = snapshotToken && snapshot?.recordKinds?.includes(record.recordKind)
          ? JSON.stringify({ ...parseObject(record.routingJSON), __better_compact_snapshot: snapshotToken })
          : record.routingJSON
        nextRevision++
        if (normalized) this.db.query(`insert into normalized_record(source_id, record_kind, natural_key, source_version, routing_json, payload_json, payload_sha256, record_revision, deleted_at, observed_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_id, record_kind, natural_key) do update set source_version=excluded.source_version, routing_json=excluded.routing_json, payload_json=excluded.payload_json, payload_sha256=excluded.payload_sha256, record_revision=excluded.record_revision, deleted_at=excluded.deleted_at, observed_at=excluded.observed_at`).run(record.sourceID, record.recordKind, record.naturalKey, record.sourceVersion ?? null, routingJSON ?? null, record.payloadJSON ?? null, record.payloadSHA256, nextRevision, record.deletedAt ?? null, record.observedAt)
        this.db.query(`insert into outbox(destination_id, source_id, record_kind, natural_key, routing_json, payload_json, payload_sha256, record_revision, operation, state, next_attempt_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          on conflict(destination_id, source_id, record_kind, natural_key, record_revision) do nothing`).run(destinationID, record.sourceID, record.recordKind, record.naturalKey, routingJSON ?? null, record.payloadJSON ?? null, record.payloadSHA256, nextRevision, record.deletedAt === undefined ? "upsert" : "delete", Date.now(), Date.now())
        stagedRecords++
      }
      for (const prefix of snapshot?.prefixes ?? []) enqueueRecord(controlRecord(sourceID, CONTROL_RECORD_KINDS.reconcilePrefix, prefix.prefix, { lineCount: prefix.lineCount, recordKinds: prefix.recordKinds }), false)
      if (snapshotToken) enqueueRecord(controlRecord(sourceID, CONTROL_RECORD_KINDS.snapshotBegin, snapshotToken, { token: snapshotToken, recordKinds: snapshotRecordKinds }), false)
      for (const record of records) {
        const previous = this.db.query("select payload_sha256, source_version, deleted_at from normalized_record where source_id=? and record_kind=? and natural_key=?").get(record.sourceID, record.recordKind, record.naturalKey) as { payload_sha256: string; source_version?: string; deleted_at?: number } | null
        if (!forceRecords && previous && previous.payload_sha256 === record.payloadSHA256 && previous.source_version === (record.sourceVersion ?? null) && Boolean(previous.deleted_at) === (record.deletedAt !== undefined)) continue
        enqueueRecord(record)
      }
      if (snapshotToken) enqueueRecord(controlRecord(sourceID, CONTROL_RECORD_KINDS.snapshotEnd, snapshotToken, { token: snapshotToken, recordKinds: snapshotRecordKinds }), false)
      if (this.outboxBytes(destinationID) > maxOutboxBytes) throw new Error(`better-compact outbox exceeds configured limit of ${maxOutboxBytes} bytes`)
      this.db.query("update source set local_revision=?, records_staged=records_staged+?, last_staged_at=? where id=?").run(nextRevision, stagedRecords, Date.now(), sourceID)
      this.db.query("insert into source_cursor(source_id, stream, checkpoint_json, updated_at) values (?, ?, ?, ?) on conflict(source_id, stream) do update set checkpoint_json=excluded.checkpoint_json, updated_at=excluded.updated_at").run(sourceID, stream, JSON.stringify(checkpoint), Date.now())
    })
    transaction()
  }

  private enqueueTombstone(nextRevision: number, destinationID: string, sourceID: string, row: { record_kind: string; natural_key: string; routing_json?: string }) {
    nextRevision++
    const deletedAt = Date.now()
    this.db.query(`update normalized_record set payload_json=null, payload_sha256='', record_revision=?, deleted_at=?, observed_at=? where source_id=? and record_kind=? and natural_key=?`).run(nextRevision, deletedAt, deletedAt, sourceID, row.record_kind, row.natural_key)
    this.db.query(`insert into outbox(destination_id, source_id, record_kind, natural_key, routing_json, payload_json, payload_sha256, record_revision, operation, state, next_attempt_at, created_at)
      values (?, ?, ?, ?, ?, null, '', ?, 'delete', 'pending', ?, ?)
      on conflict(destination_id, source_id, record_kind, natural_key, record_revision) do nothing`).run(destinationID, sourceID, row.record_kind, row.natural_key, row.routing_json ?? null, nextRevision, Date.now(), Date.now())
    return nextRevision
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

  acknowledge(ids: number[]) {
    if (!ids.length) return
    const transaction = this.db.transaction(() => {
      const placeholders = ids.map(() => "?").join(",")
      const rows = this.db.query(`select source_id, record_kind, natural_key, length(coalesce(payload_json,'') || coalesce(routing_json,'')) as bytes from outbox where id in (${placeholders})`).all(...ids) as Array<{ source_id: string; record_kind: string; natural_key: string; bytes: number }>
      this.db.query(`delete from outbox where id in (${placeholders})`).run(...ids)
      this.releaseAcknowledgedRecords()
      const sent = new Map<string, { records: number; bytes: number }>()
      for (const row of rows) {
        const current = sent.get(row.source_id) ?? { records: 0, bytes: 0 }
        current.records++
        current.bytes += Number(row.bytes ?? 0)
        sent.set(row.source_id, current)
      }
      for (const [sourceID, value] of sent) this.db.query("update source set records_sent=records_sent+?, bytes_sent=bytes_sent+?, last_sent_at=? where id=?").run(value.records, value.bytes, Date.now(), sourceID)
    })
    transaction()
  }
  adoptThrough(sourceID: string, revision: number, destinationID = "postgres") {
    this.db.query("delete from outbox where source_id=? and destination_id=? and record_revision<=?").run(sourceID, destinationID, revision)
    this.releaseAcknowledgedRecords()
  }
  fail(ids: number[], error: string, nextAttemptAt = Date.now() + 30_000) { if (ids.length) this.db.query(`update outbox set state='failed', lease_until=null, last_error=?, next_attempt_at=? where id in (${ids.map(() => "?").join(",")})`).run(error.slice(0, 1000), nextAttemptAt, ...ids) }
  pendingCount(destinationID = "postgres") { const row = this.db.query("select count(*) as value from outbox where destination_id=?").get(destinationID) as { value: number }; return Number(row.value) }
  /** Outbox rows still owed for one source: pending, expiring lease, or failed rows due for retry. */
  sourcePendingCount(sourceID: string, now = Date.now()) {
    const row = this.db.query("select count(*) as value from outbox where destination_id='postgres' and source_id=? and (state='pending' or (state='leased' and lease_until<?) or (state='failed' and next_attempt_at<=?))").get(sourceID, now, now) as { value: number }
    return Number(row.value)
  }
  releaseAcknowledgedRecords(limit = 50_000) {
    const result = this.db.query(`delete from normalized_record where rowid in (
      select normalized_record.rowid from normalized_record
      where not exists (select 1 from outbox where outbox.source_id=normalized_record.source_id and outbox.record_kind=normalized_record.record_kind and outbox.natural_key=normalized_record.natural_key)
      limit ?
    )`).run(limit) as { changes?: number }
    return Number(result.changes ?? 0)
  }
  purgePayloads(retentionMs: number, limit = 500) {
    this.db.query(`update normalized_record set payload_json=null where rowid in (
      select normalized_record.rowid from normalized_record
      where observed_at<? and payload_json is not null
        and not exists (select 1 from outbox where outbox.source_id=normalized_record.source_id and outbox.record_kind=normalized_record.record_kind and outbox.natural_key=normalized_record.natural_key)
      limit ?
    )`).run(Date.now() - retentionMs, limit)
  }
  outboxBytes(destinationID = "postgres") {
    const row = this.db.query("select coalesce(sum(length(coalesce(payload_json,'') || coalesce(routing_json,''))), 0) as value from outbox where destination_id=?").get(destinationID) as { value: number }
    return Number(row.value)
  }
}

function controlRecord(sourceID: string, recordKind: string, naturalKey: string, value: Record<string, unknown>): NormalizedRecord {
  const payloadJSON = JSON.stringify(value)
  return { sourceID, recordKind, naturalKey, payloadJSON, payloadSHA256: createHash("sha256").update(payloadJSON).digest("hex"), observedAt: Date.now() }
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

export async function openSyncState(filename: string) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const state = new SyncState(filename)
  await chmod(filename, 0o600)
  await chmod(`${filename}-wal`, 0o600).catch(() => {})
  await chmod(`${filename}-shm`, 0o600).catch(() => {})
  return state
}
