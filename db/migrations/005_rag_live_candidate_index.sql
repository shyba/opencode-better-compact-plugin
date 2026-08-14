-- Let the live RAG poll find recently changed text parts before aggregating
-- their complete assistant messages. The full-sweep query remains available
-- for reconciliation, but idle polling must not rescan the whole projection.
create index concurrently if not exists part_rag_recent_idx
  on opencode.part (
    (greatest(
      coalesce(source_updated_at, 'epoch'::timestamptz),
      coalesce(source_created_at, 'epoch'::timestamptz)
    )),
    installation_id, source_id, session_id, message_id
  )
  where deleted_at is null and part_type in ('text', 'reasoning');
