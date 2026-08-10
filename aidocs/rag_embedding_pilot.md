# RAG embedding pilot (2026-08-10)

## Decision

The first OpenCode RAG projection uses `BAAI/bge-small-en-v1.5`, 384
dimensions, 128-token chunks, and 32-token overlap. Retrieval should combine
the vector score with the existing `rag.chunk` simple-FTS score (initial pilot
weight: 0.8 vector / 0.2 lexical). The 768-dimensional Jina code model was
measured but was not selected for this first delivery.

This is a model/data-plane decision, not a change to compaction correctness.
The compaction plugin remains independent of Postgres availability.

## Evidence

The evaluation corpus was five real, local OpenCode sessions. It contained 404
text-bearing records, 54 non-synthetic user queries, and 306 assistant
records. Tool output was excluded; text and reasoning parts were bounded and
kept only in `/tmp` during evaluation.

On the five-session holdout, 128-token BGE chunks scored:

| retriever | hit@1 | hit@3 | hit@5 | MRR |
| --- | ---: | ---: | ---: | ---: |
| lexical TF-IDF baseline | 0.2593 | 0.4444 | 0.5741 | 0.4014 |
| BGE vector | 0.3519 | 0.5741 | 0.6481 | 0.4960 |
| 0.8 BGE + 0.2 lexical | 0.4074 | 0.6667 | 0.7778 | 0.5618 |

The Jina code candidate (`jinaai/jina-embeddings-v2-base-code`, 768
dimensions) scored 0.1481 / 0.3889 / 0.4074 / 0.2808 on the same five-session
128-token test (0.2407 / 0.4630 / 0.6111 / 0.3944 with the same 0.8/0.2
hybrid). A four-query single-session result had looked better, which is why
the larger cross-session check was required before selecting a model.

The hybrid weight was checked with leave-one-session-out tuning. The selected
range was 0.8–0.9 vector weight; the reported 0.8 value is a conservative
fixed setting rather than a per-query optimization.

## Live PostgreSQL pilot

The existing `rag.embedding_current.embedding_vec` is a fixed `vector(4096)`
column for the Qwen model. A 384-dimensional vector cannot be inserted there,
so the pilot uses the additive admin migration
`db/migrations/002_rag_embedding_384.sql`, which creates
`rag.embedding_current_384` and preserves the existing Qwen projection.

The migration was applied with the admin role, while rows were written with
the existing writer role. It grants only `SELECT` and `INSERT` on the new
table; the long-running sync worker remains DDL-free.

Two successful, transactional runs are present:

- `opencode_rag_embedding_pilot`: one session, 484 rows.
- `opencode_rag_embedding_expansion`: five sessions, 3,104 rows total.

The live table reports exactly 384 dimensions for every row. The five-session
expansion is about 5.2 MiB in `rag.embedding_current_384`; rerunning the load
is idempotent for `(chunk_id, embedding_model)` and does not touch existing
Qwen rows.

## Storage gate

The complete synced OpenCode source was measured read-only at 33,840,269 BGE
tokens and 349,442 128-token chunks. Using the observed 384-vector and JSON
event sizes projects approximately 0.54 GiB of vector payload and 2.66 GiB of
embedding-event JSON before ordinary chunk/index overhead. This is safely
below the 100 GiB first-delivery budget.

The Codex source is a different scale: its known text fields total roughly
12.2 billion UTF-8 characters. Embedding that entire source at 128-token
chunks would exceed the first-delivery budget once JSON event history and
vectors are included. Codex therefore remains a later, separately budgeted
expansion (larger chunks, a narrower source scope, or a compact event format).

## Reproducibility and next gates

Development tooling is in `eval/`:

- `extract_opencode.py` and `extract_pg_opencode.py` create bounded corpora;
- `rag_pilot.py` compares chunk sizes, vector, lexical, and hybrid retrieval;
- `embed_pilot.py` writes checkpointed JSONL batches without database access;
- `jsonl_to_rag_copy.py` prepares a quoted PostgreSQL `COPY` input.

Before loading the full OpenCode source, run a sampled exact-retrieval check
against the live table, then have the DBA create an ANN index sized for the
measured row count. Do not add a 384 vector to the existing 4096 table, and do
not begin full Codex ingestion until its source-level storage projection is
under the same budget gate.
