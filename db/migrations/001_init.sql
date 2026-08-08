-- better-compact remote schema v1
create schema if not exists opencode;

create table if not exists opencode.schema_migration (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists opencode.installation (
  installation_id uuid primary key,
  incarnation text not null,
  label text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists opencode.source (
  installation_id uuid not null references opencode.installation(installation_id) on delete cascade,
  source_id text not null,
  incarnation text not null,
  kind text not null,
  schema_version integer not null,
  locator_fingerprint text not null,
  remote_revision_high_water bigint not null default 0,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (installation_id, source_id)
);

create table if not exists opencode.session (
  installation_id uuid not null,
  source_id text not null,
  session_id text not null,
  parent_session_id text,
  directory text,
  title text,
  model jsonb,
  metadata jsonb,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  record_revision bigint not null,
  deleted_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (installation_id, source_id, session_id),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

create table if not exists opencode.message (
  installation_id uuid not null,
  source_id text not null,
  session_id text not null,
  message_id text not null,
  role text not null,
  parent_id text,
  summary boolean,
  data jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  record_revision bigint not null,
  deleted_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (installation_id, source_id, session_id, message_id),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

create table if not exists opencode.part (
  installation_id uuid not null,
  source_id text not null,
  session_id text not null,
  message_id text not null,
  part_id text not null,
  part_type text not null,
  data jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  record_revision bigint not null,
  deleted_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (installation_id, source_id, session_id, message_id, part_id),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

create table if not exists opencode.todo (
  installation_id uuid not null,
  source_id text not null,
  session_id text not null,
  position integer not null,
  data jsonb not null,
  source_updated_at timestamptz,
  record_revision bigint not null,
  deleted_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (installation_id, source_id, session_id, position),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

create table if not exists opencode.sync_observation (
  installation_id uuid not null,
  source_id text not null,
  observed_at timestamptz not null default now(),
  lag_ms bigint,
  records_staged bigint not null default 0,
  records_uploaded bigint not null default 0,
  primary key (installation_id, source_id),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

-- Snapshot keys are transient reconciliation state. They keep the local
-- SQLite state small while allowing a complete source scan to tombstone
-- remote rows that disappeared from the source.
create table if not exists opencode.sync_snapshot_seen (
  installation_id uuid not null,
  source_id text not null,
  snapshot_token text not null,
  record_kind text not null,
  natural_key text not null,
  seen_at timestamptz not null default now(),
  primary key (installation_id, source_id, snapshot_token, record_kind, natural_key),
  foreign key (installation_id, source_id) references opencode.source(installation_id, source_id) on delete cascade
);

create index if not exists message_chronology_idx on opencode.message(installation_id, source_id, session_id, source_created_at, message_id);
create index if not exists part_message_idx on opencode.part(installation_id, source_id, session_id, message_id);
create index if not exists sync_observation_lag_idx on opencode.sync_observation(observed_at, lag_ms);
create index if not exists sync_snapshot_seen_source_idx on opencode.sync_snapshot_seen(installation_id, source_id, snapshot_token, record_kind);

alter table opencode.source add column if not exists lease_owner text;
alter table opencode.source add column if not exists lease_until timestamptz;
insert into opencode.schema_migration(version) values (1) on conflict (version) do nothing;
insert into opencode.schema_migration(version) values (2) on conflict (version) do nothing;
