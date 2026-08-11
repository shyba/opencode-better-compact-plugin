-- Allow the same document/chunk position to be represented by more than one
-- reviewed chunker version. The first pilot used 128-token chunks; the
-- current worker uses 512/64. Keeping both rows preserves their embeddings
-- and lets the active version be selected explicitly.
alter table rag.chunk drop constraint if exists chunk_doc_id_chunk_index_chunk_hash_key;

create unique index if not exists chunk_doc_id_chunk_index_chunk_hash_mode_version_key
  on rag.chunk (doc_id, chunk_index, chunk_hash, chunking_mode, chunker_version);

grant select, insert on rag.chunk to dbwriter;
