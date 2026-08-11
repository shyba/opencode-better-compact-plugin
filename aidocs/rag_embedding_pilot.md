# RAG embedding pilot (2026-08-10)

## Decision

The first OpenCode RAG projection uses `BAAI/bge-small-en-v1.5`, 384
dimensions, 512-token chunks, and 64-token overlap. Retrieval should combine
the vector score with the existing `rag.chunk` simple-FTS score at a fixed
0.8 vector / 0.2 lexical weight (the benchmark uses row-normalized TF-IDF as
the bounded lexical proxy). The 768-dimensional Jina code model and a
768-dimensional BGE screen were measured but did not justify the extra
dimension or CPU cost for this delivery.

This is a measured compromise, not a claim that 512 tokens is universally
optimal. On the larger holdout it improved every reported retrieval metric
while reducing the projected payload. The fixed weight is preferred over
per-fold tuning because the runtime policy must be stable and fold-specific
tuning remains noisy even with the larger corpus.

This is a model/data-plane decision, not a change to compaction correctness.
The compaction plugin remains independent of Postgres availability.

## Evidence

The first smoke corpus was five real, local OpenCode sessions. It contained 404
text-bearing records and 306 assistant records. Tool output was excluded; text
and reasoning parts were bounded and kept only in the operator's temporary
benchmark area. The benchmark removed 44 synthetic turns and six terse
acknowledgements (`yes`, `continue`, and similar turns), leaving 48 eligible
queries. Each query is a proxy label for the next assistant response in the
same session; this is reproducible, but is not a substitute for a future
human-labelled retrieval set.

`eval/rag_benchmark.py` assigns whole sessions to deterministic folds, chooses
chunk size/model/weight using training folds only, and reports the selected
configuration on the held-out fold. It also reports fixed reference settings
so a simpler policy can be compared with the tuned result. The single-session
pilot uses deterministic query folds because a session fold is impossible with
only one session.

The own-session pilot was intentionally first. It had only two eligible
queries, so its two-query-fold BGE result is a smoke signal, not a selection
gate. The five-session run was used for the initial model screen; the
20-session run below is the selection gate.

On the five-session session-held-out corpus, fixed 128-token chunks scored:

| retriever | hit@1 | hit@3 | hit@5 | MRR |
| --- | ---: | ---: | ---: | ---: |
| lexical TF-IDF baseline | 0.2708 | 0.4791 | 0.6250 | 0.4279 |
| BGE vector | 0.3958 | 0.6458 | 0.7292 | 0.5498 |
| 0.8 BGE + 0.2 lexical | **0.4375** | **0.7291** | **0.8542** | **0.6066** |

The larger Jina code candidate (`jinaai/jina-embeddings-v2-base-code`, 768
dimensions; [model card](https://huggingface.co/jinaai/jina-embeddings-v2-base-code))
scored 0.1667 / 0.4375 / 0.4583 / MRR 0.3137 as a vector-only retriever and
0.2709 / 0.5209 / 0.6667 / MRR 0.4366 with the same 0.8/0.2 hybrid. It uses
more storage and was worse on every reported hybrid metric, so increasing the
dimension is not justified by this evidence. On the same CPU run, the
384-dimensional BGE 128-token candidate took 22.3 seconds for embedding and
local scoring of the five-session corpus versus 84.5 seconds for Jina. These
are comparative pilot measurements, not a production throughput promise.

Chunk-size sensitivity for the BGE model at the same fixed 0.8 weight was:

| chunk / overlap | hit@1 | hit@3 | hit@5 | MRR | projected payload |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128 / 32 | 0.4375 | **0.7291** | **0.8542** | 0.6066 | 3.28 GiB |
| 256 / 64 | 0.4375 | 0.7083 | 0.8334 | 0.6012 | 1.71 GiB |
| 512 / 64 | **0.5000** | 0.6667 | 0.7917 | **0.6079** | 0.87 GiB |

Per-fold train-only tuning selected 128/256/512 variants and reached
0.4375 / 0.6458 / 0.7708 / MRR 0.5732 on the aggregate test folds. That lower
aggregate is expected with only five sessions and is why it was not used as the
sole production-selection gate.

The expanded corpus contained 15,276 text-bearing records from 20 substantial
sessions. It yielded 1,465 eligible queries after excluding 168 synthetic turns,
126 terse acknowledgements, and 98 other terse turns. With the same fixed 0.8
hybrid policy, the session-held-out results were:

| chunk / overlap | documents | hit@1 | hit@3 | hit@5 | MRR | projected payload |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 / 32 | 64,444 | 0.0942 | 0.2028 | 0.2867 | 0.1946 | 3.40 GiB |
| 256 / 64 | 35,825 | 0.1031 | 0.2123 | 0.3037 | 0.2024 | 1.89 GiB |
| 512 / 64 | 21,308 | **0.1113** | **0.2184** | **0.3160** | **0.2115** | **1.12 GiB** |

The 512-token candidate therefore wins all four measured metrics in the
larger sample and uses roughly one third of the 128-token projected payload.
The labels still describe “next assistant response” rather than user-judged
relevance, so this is a default for the first delivery with a clear follow-up
gate, not a claim of perfect semantic retrieval.

For dimensionality, BGE-base (768 dimensions) was screened at 512 tokens on the
five-session corpus: 0.4167 / 0.6667 / 0.8125 / MRR 0.5748 for the fixed hybrid,
versus BGE-small's 0.5000 / 0.6667 / 0.7917 / MRR 0.6079. The small model was
faster in the earlier 128-token comparison (22.3 seconds versus 84.5 seconds
for Jina on the same CPU). Neither larger screen was a consistent improvement,
so the 384-dimensional model is the better first-delivery trade-off.

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

The complete synced OpenCode source was measured read-only at an estimated
33,840,269 assistant-model tokens. The benchmark's conservative sample-ratio
projection for the selected 512/64 configuration is approximately 124,015
rows: 0.18 GiB of 384-vector payload plus about 0.95 GiB of bounded
embedding-event JSON before ordinary chunk/index overhead (1.12 GiB total).
The 128-token projection is 3.40 GiB under the same event-row assumption.
Both are safely below the 100 GiB first-delivery budget, with substantial room
for index overhead and reruns.

The Codex source is a different scale: its known text fields total roughly
12.2 billion UTF-8 characters. Embedding that entire source at 128-token
chunks would exceed the first-delivery budget once JSON event history and
vectors are included. Codex therefore remains a later, separately budgeted
expansion (larger chunks, a narrower source scope, or a compact event format).

## Reproducibility and next gates

Development tooling is in `eval/`:

- `extract_opencode.py` and `extract_pg_opencode.py` create bounded corpora;
- `rag_pilot.py` compares chunk sizes, vector, lexical, and hybrid retrieval;
- `rag_benchmark.py` performs session-held-out tuning and fixed-candidate
  comparisons without writing transcript text to its report;
- `embed_pilot.py` writes checkpointed JSONL batches without database access;
- `jsonl_to_rag_copy.py` prepares a quoted PostgreSQL `COPY` input.

The benchmark can be reproduced from a temporary virtual environment. For the
current local artifacts, use the BGE and Jina model snapshots already cached on
the host:

```sh
python3 -m venv /tmp/.venv
/tmp/.venv/bin/python3 -m pip install numpy==2.2.4 scikit-learn==1.6.1 \
  sentence-transformers==5.7.0 transformers==4.57.1 tokenizers==0.22.2
HF_HOME=/tmp/rag-hf-cache HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  /tmp/.venv/bin/python3 eval/rag_benchmark.py /tmp/rag-pilot/opencode-5-sessions-text.jsonl \
  --output ~/mnt/rag-benchmark/benchmark.json \
  --model BAAI/bge-small-en-v1.5 \
  --model jinaai/jina-embeddings-v2-base-code \
  --chunk-tokens 128 --chunk-tokens 256 --chunk-tokens 512 \
  --reference-chunk-tokens 512 --reference-weight 0.8 \
  --folds 5 --split session --projected-tokens 33840269 \
  --cache-dir ~/mnt/rag-benchmark/cache
```

For a new host, omit the offline variables and pass model identifiers so the
Hugging Face cache is populated intentionally. Keep the corpus and report
permissions restricted; the script writes mode `0600` output and never logs
record content. The optional cache stores only model/query vectors and timing,
uses a corpus digest plus model/chunk key, and writes mode `0600` files in a
mode `0700` directory. Re-running the same candidate after interruption
therefore skips embedding without retaining transcript text.

Before loading the full OpenCode source, run a sampled exact-retrieval check
against the live table, then have the DBA create an ANN index sized for the
measured row count. Do not add a 384 vector to the existing 4096 table, and do
not begin full Codex ingestion until its source-level storage projection is
under the same budget gate.
