-- Additive model-specific projection for the first OpenCode RAG pilot.
-- rag.embedding_current is a 4096-dimensional Qwen projection and cannot
-- safely accept a smaller vector. Keep this table separate so either model
-- can be queried without rewriting or invalidating the existing index.
create table if not exists rag.embedding_current_384 (
  chunk_id bigint not null references rag.chunk(chunk_id),
  embedding_event_id bigint not null references rag.embedding_event(embedding_event_id),
  embedding_model text not null,
  embedding_vec vector(384) not null,
  updated_at timestamptz not null default now(),
  primary key (chunk_id, embedding_model),
  unique (embedding_event_id)
);

create index if not exists rag_embedding_current_384_model_idx
  on rag.embedding_current_384 (embedding_model);

-- The long-running worker only needs DML; table creation remains an admin
-- migration. An ANN index is intentionally deferred until corpus scale is
-- known, because the first pilot is small enough for an exact scan.
grant select, insert on rag.embedding_current_384 to dbwriter;
