# RAG embedding pilot (2026-08-10)

## Decision

The first OpenCode RAG projection uses `BAAI/bge-small-en-v1.5`, 384
dimensions, 128-token chunks, and 32-token overlap. Retrieval should combine
the vector score with the existing `rag.chunk` simple-FTS score at a fixed
0.8 vector / 0.2 lexical weight. The 768-dimensional Jina code model was
measured on the same holdout and was not selected for this first delivery.

This is a deliberately conservative default. A larger chunk is cheaper and
slightly improves first-result accuracy, but loses recall at the top three and
top five results. The fixed weight is preferred over per-fold tuning because
the current corpus is small and fold-specific tuning overfits its few held-out
sessions.

This is a model/data-plane decision, not a change to compaction correctness.
The compaction plugin remains independent of Postgres availability.

## Evidence

The evaluation corpus was five real, local OpenCode sessions. It contained 404
text-bearing records and 306 assistant records. Tool output was excluded; text
and reasoning parts were bounded and kept only in `/tmp` during evaluation.
The benchmark removed 44 synthetic turns and six terse acknowledgements (`yes`,
`continue`, and similar turns), leaving 48 eligible queries. Each query is a
proxy label for the next assistant response in the same session; this is
reproducible, but is not a substitute for a future human-labelled retrieval
set.

`eval/rag_benchmark.py` assigns whole sessions to deterministic folds, chooses
chunk size/model/weight using training folds only, and reports the selected
configuration on the held-out fold. It also reports fixed reference settings
so a simpler policy can be compared with the tuned result. The single-session
pilot uses deterministic query folds because a session fold is impossible with
only one session.

The own-session pilot was intentionally first. It had only two eligible
queries, so its two-query-fold BGE result (hit@1 0.50, hit@3 0.50, hit@5 1.00,
MRR 0.60) is a smoke signal, not a selection gate. The five-session run is the
selection gate.

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
384-dimensional BGE 128-token candidate took 22.3 seconds to encode the
five-session corpus versus 84.5 seconds for Jina. These are comparative pilot
measurements, not a production throughput promise.

Chunk-size sensitivity for the BGE model at the same fixed 0.8 weight was:

| chunk / overlap | hit@1 | hit@3 | hit@5 | MRR | projected payload |
| --- | ---: | ---: | ---: | ---: | ---: |
| 128 / 32 | 0.4375 | **0.7291** | **0.8542** | 0.6066 | 3.28 GiB |
| 256 / 64 | 0.4375 | 0.7083 | 0.8334 | 0.6012 | 1.71 GiB |
| 512 / 64 | **0.5000** | 0.6667 | 0.7917 | **0.6079** | 0.87 GiB |

Per-fold train-only tuning selected 128/256/512 variants and reached
0.4375 / 0.6458 / 0.7708 / MRR 0.5732 on the aggregate test folds. That lower
aggregate is expected with only five sessions and is the reason the runtime
policy remains the fixed, high-recall 128-token configuration rather than
silently adopting a tuned setting.

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
tokens. The benchmark's conservative sample-ratio projection is approximately
362,409 128-token rows: 0.52 GiB of 384-vector payload plus about 2.76 GiB of
bounded embedding-event JSON before ordinary chunk/index overhead (3.28 GiB
total). The earlier exact source measurement produced 349,442 rows and the
same conclusion. Both are safely below the 100 GiB first-delivery budget.

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
  --output /tmp/rag-pilot/benchmark.json \
  --model /tmp/rag-hf-cache-small/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a \
  --model /tmp/rag-hf-cache/hub/models--jinaai--jina-embeddings-v2-base-code/snapshots/516f4baf13dec4ddddda8631e019b5737c8bc250 \
  --chunk-tokens 128 --folds 5 --split session --projected-tokens 33840269
```

For a new host, omit the offline variables and pass model identifiers so the
Hugging Face cache is populated intentionally. Keep the corpus and report
permissions restricted; the script writes mode `0600` output and never logs
record content.

Before loading the full OpenCode source, run a sampled exact-retrieval check
against the live table, then have the DBA create an ANN index sized for the
measured row count. Do not add a 384 vector to the existing 4096 table, and do
not begin full Codex ingestion until its source-level storage projection is
under the same budget gate.
