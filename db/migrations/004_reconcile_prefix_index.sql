-- Prefix tombstones are emitted when a JSONL file disappears. Keep this
-- update from scanning the entire message projection for every deleted file.
create index concurrently if not exists message_prefix_reconcile_idx
  on opencode.message (installation_id, source_id, message_id text_pattern_ops)
  where deleted_at is null;
