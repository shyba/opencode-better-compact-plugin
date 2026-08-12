-- Tombstone retention is scoped by installation/source and cutoff time.
-- Keep this partial index separate from the live-row reconciliation index:
-- the purge predicate is deleted_at IS NOT NULL, not IS NULL.
create index concurrently if not exists message_deleted_at_purge_idx
  on opencode.message (installation_id, source_id, deleted_at)
  where deleted_at is not null;

create index concurrently if not exists part_deleted_at_purge_idx
  on opencode.part (installation_id, source_id, deleted_at)
  where deleted_at is not null;

create index concurrently if not exists session_deleted_at_purge_idx
  on opencode.session (installation_id, source_id, deleted_at)
  where deleted_at is not null;

create index concurrently if not exists todo_deleted_at_purge_idx
  on opencode.todo (installation_id, source_id, deleted_at)
  where deleted_at is not null;
