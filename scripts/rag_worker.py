#!/usr/bin/env python3
"""Restart-safe BGE-small OpenCode RAG worker.

The worker reads only the synchronized OpenCode-V1 projection, keeps no
transcript cache on disk, and writes append-only rows to the existing RAG
tables. It is intentionally separate from compaction and session sync: a
database or model failure can pause retrieval without affecting OpenCode.
"""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
import hashlib
import json
import os
import signal
import sys
import time
import traceback
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
import torch
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from sentence_transformers import SentenceTransformer


MODEL_NAME = "BAAI/bge-small-en-v1.5"
SOURCE_TABLE = "opencode.message"
SOURCE_SYSTEM = "opencode"
CHUNK_MODE = "opencode_tokens"
CHUNKER_VERSION_PREFIX = "bge-small-en-v1.5"
DEFAULT_ONNX_FILE = "onnx/model_qint8_avx512_vnni.onnx"
DEFAULT_BACKEND = "auto"
DEFAULT_COMPUTE_DTYPE = "bfloat16"
DEFAULT_POLL_SECONDS = 30
DEFAULT_LOOKBACK_SECONDS = 900
DEFAULT_FULL_SWEEP_INTERVAL = 900
DEFAULT_MESSAGE_BATCH = 2048
DEFAULT_EMBED_BATCH = 16
STAGING_BATCH_ROWS = 2048
DEFAULT_THREADS = 16
STATE_VERSION = 1


MESSAGE_QUERY = """
with records as (
  select
    m.installation_id::text as installation_id,
    m.source_id,
    m.session_id,
    m.message_id,
    greatest(
      coalesce(m.source_updated_at, m.source_created_at, 'epoch'::timestamptz),
      coalesce(max(p.source_updated_at), 'epoch'::timestamptz)
    ) as updated_at,
    string_agg(
      p.data->>'text', E'\\n\\n'
      order by p.source_created_at nulls first, p.source_updated_at nulls first, p.part_id
    ) as content_text
  from opencode.message m
  join opencode.source s using (installation_id, source_id)
  join opencode.part p using (installation_id, source_id, session_id, message_id)
  where s.kind = 'opencode-v1-sqlite'
    and m.role = 'assistant'
    and m.deleted_at is null
    and p.deleted_at is null
    and p.part_type in ('text', 'reasoning')
    and coalesce(nullif(regexp_replace(p.data->>'text', '[[:space:]]', '', 'g'), ''), '') <> ''
  group by m.installation_id, m.source_id, m.session_id, m.message_id,
    m.source_updated_at, m.source_created_at
)
select
  records.*,
  encode(digest(records.content_text, 'sha256'), 'hex') as content_hash
from records
where records.content_text is not null
  and regexp_replace(records.content_text, '[[:space:]]', '', 'g') <> ''
  and (
    %s = false
    or %s = true
    or records.updated_at >= %s::timestamptz
  )
  and (
    %s = false
    or (records.updated_at, records.installation_id, records.source_id, records.session_id, records.message_id)
      > (%s::timestamptz, %s, %s, %s, %s)
  )
  and not exists (
    select 1
    from rag.document_source d
    where d.source_system = 'opencode'
      and d.source_table = 'opencode.message'
      and d.source_pk = records.installation_id || ':' || records.source_id || ':' || records.session_id || ':' || records.message_id
      and d.content_hash = encode(digest(records.content_text, 'sha256'), 'hex')
      and exists (
        select 1
        from rag.chunk c
        where c.doc_id = d.doc_id
          and c.chunking_mode = %s
          and c.chunker_version = %s
      )
      and not exists (
        select 1
        from rag.chunk c
        where c.doc_id = d.doc_id
          and c.chunking_mode = %s
          and c.chunker_version = %s
          and not exists (
            select 1
            from rag.embedding_current_384 e
            where e.chunk_id = c.chunk_id
              and e.embedding_model = %s
          )
      )
  )
order by records.updated_at, records.installation_id, records.source_id, records.session_id, records.message_id
limit %s
"""


# The server-side backfill cursor executes the expensive aggregation once and
# streams its ordered result in message-sized pages. Re-running MESSAGE_QUERY
# for every page would rescan the synchronized part projection each time.
MESSAGE_STREAM_QUERY = MESSAGE_QUERY.rsplit("limit %s", 1)[0]


# Live polling uses the part timestamp index before it aggregates a message's
# complete history. A recent part marks a message as a candidate; the second
# phase then reads all eligible parts for that message so the stored document
# remains complete and deterministic.
LIVE_MESSAGE_QUERY = """
with candidate_keys as (
  select distinct
    p.installation_id,
    p.source_id,
    p.session_id,
    p.message_id
  from opencode.part p
  join opencode.source s using (installation_id, source_id)
  join opencode.message m using (installation_id, source_id, session_id, message_id)
  where s.kind = 'opencode-v1-sqlite'
    and m.role = 'assistant'
    and m.deleted_at is null
    and p.deleted_at is null
    and p.part_type in ('text', 'reasoning')
    and coalesce(nullif(regexp_replace(p.data->>'text', '[[:space:]]', '', 'g'), ''), '') <> ''
    and greatest(
      coalesce(p.source_updated_at, 'epoch'::timestamptz),
      coalesce(p.source_created_at, 'epoch'::timestamptz)
    ) >= %s::timestamptz
), records as (
  select
    m.installation_id::text as installation_id,
    m.source_id,
    m.session_id,
    m.message_id,
    greatest(
      coalesce(m.source_updated_at, m.source_created_at, 'epoch'::timestamptz),
      coalesce(max(greatest(
        coalesce(p.source_updated_at, 'epoch'::timestamptz),
        coalesce(p.source_created_at, 'epoch'::timestamptz)
      )), 'epoch'::timestamptz)
    ) as updated_at,
    string_agg(
      p.data->>'text', E'\\n\\n'
      order by p.source_created_at nulls first, p.source_updated_at nulls first, p.part_id
    ) as content_text
  from candidate_keys k
  join opencode.message m using (installation_id, source_id, session_id, message_id)
  join opencode.part p using (installation_id, source_id, session_id, message_id)
  where p.deleted_at is null
    and p.part_type in ('text', 'reasoning')
    and coalesce(nullif(regexp_replace(p.data->>'text', '[[:space:]]', '', 'g'), ''), '') <> ''
  group by m.installation_id, m.source_id, m.session_id, m.message_id,
    m.source_updated_at, m.source_created_at
), documents as (
  select records.*, encode(digest(records.content_text, 'sha256'), 'hex') as content_hash
  from records
)
select
  documents.*
from documents
where documents.content_text is not null
  and regexp_replace(documents.content_text, '[[:space:]]', '', 'g') <> ''
  and not exists (
    select 1
    from rag.document_source d
    where d.source_system = 'opencode'
      and d.source_table = 'opencode.message'
      and d.source_pk = documents.installation_id || ':' || documents.source_id || ':' || documents.session_id || ':' || documents.message_id
      and d.content_hash = documents.content_hash
      and exists (
        select 1
        from rag.chunk c
        where c.doc_id = d.doc_id
          and c.chunking_mode = %s
          and c.chunker_version = %s
      )
      and not exists (
        select 1
        from rag.chunk c
        where c.doc_id = d.doc_id
          and c.chunking_mode = %s
          and c.chunker_version = %s
          and not exists (
            select 1
            from rag.embedding_current_384 e
            where e.chunk_id = c.chunk_id
              and e.embedding_model = %s
          )
      )
  )
order by documents.updated_at, documents.installation_id, documents.source_id, documents.session_id, documents.message_id
limit %s
"""


STATUS_QUERY = """
with records as (
  select
    m.installation_id::text as installation_id,
    m.source_id,
    m.session_id,
    m.message_id,
    string_agg(p.data->>'text', E'\\n\\n' order by p.source_created_at nulls first, p.source_updated_at nulls first, p.part_id) as content_text
  from opencode.message m
  join opencode.source s using (installation_id, source_id)
  join opencode.part p using (installation_id, source_id, session_id, message_id)
  where s.kind = 'opencode-v1-sqlite'
    and m.role = 'assistant'
    and m.deleted_at is null
    and p.deleted_at is null
    and p.part_type in ('text', 'reasoning')
    and coalesce(nullif(regexp_replace(p.data->>'text', '[[:space:]]', '', 'g'), ''), '') <> ''
  group by m.installation_id, m.source_id, m.session_id, m.message_id
), documents as (
  select records.*,
    encode(digest(records.content_text, 'sha256'), 'hex') as content_hash
  from records
)
select
  count(*)::bigint as total_messages,
  count(*) filter (where exists (
    select 1 from rag.document_source d
    where d.source_system='opencode' and d.source_table='opencode.message'
      and d.source_pk=documents.installation_id || ':' || documents.source_id || ':' || documents.session_id || ':' || documents.message_id
      and d.content_hash=documents.content_hash
      and exists (select 1 from rag.chunk c where c.doc_id=d.doc_id and c.chunking_mode=%s and c.chunker_version=%s)
      and not exists (
        select 1 from rag.chunk c
        where c.doc_id=d.doc_id and c.chunking_mode=%s and c.chunker_version=%s
          and not exists (select 1 from rag.embedding_current_384 e where e.chunk_id=c.chunk_id and e.embedding_model=%s)
      )
  ))::bigint as embedded_messages
from documents
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="keep OpenCode RAG embeddings caught up")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--once", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    rag = config["rag"]
    if not rag.get("enabled", False):
        print("rag disabled; set rag.enabled=true in the better-compact config", flush=True)
        return 0
    database_url = os.environ.get(str(rag.get("database_url_env", "OPENCODE_SYNC_DATABASE_URL")))
    if not database_url:
        sync = config.get("sync", {})
        database_url = os.environ.get(str(sync.get("database_url_env", "OPENCODE_SYNC_DATABASE_URL")))
    if not database_url:
        print("rag worker: database URL is not configured", file=sys.stderr, flush=True)
        return 2
    model_name = str(rag.get("model", MODEL_NAME))
    model_path = expand_path(str(rag.get("model_path", "")))
    onnx_file = str(rag.get("onnx_file", DEFAULT_ONNX_FILE))
    configured_backend = str(rag.get("backend", DEFAULT_BACKEND))
    if configured_backend not in {"auto", "onnx", "torch"}:
        print("rag worker: backend must be auto, onnx, or torch", file=sys.stderr, flush=True)
        return 2
    compute_dtype = str(rag.get("compute_dtype", DEFAULT_COMPUTE_DTYPE))
    if compute_dtype not in {"float32", "bfloat16"}:
        print("rag worker: compute_dtype must be float32 or bfloat16", file=sys.stderr, flush=True)
        return 2
    backend = resolve_backend(configured_backend, model_path)
    if backend == "onnx" and not model_path:
        print("rag worker: backend=onnx requires rag.model_path", file=sys.stderr, flush=True)
        return 2
    if backend == "onnx" and compute_dtype != "float32":
        if configured_backend != "auto":
            print("rag worker: bfloat16 autocast requires backend=torch", file=sys.stderr, flush=True)
            return 2
        print("warning: ONNX model bundle cannot use bfloat16; falling back to float32", file=sys.stderr, flush=True)
        compute_dtype = "float32"
    if backend == "torch" and compute_dtype == "bfloat16" and not supports_bfloat16():
        if configured_backend != "auto":
            print("rag worker: this Torch runtime does not expose CPU bfloat16 support", file=sys.stderr, flush=True)
            return 2
        print("warning: CPU bfloat16 is unavailable; falling back to Torch float32", file=sys.stderr, flush=True)
        compute_dtype = "float32"
    length_bucketing = rag.get("length_bucketing", True)
    if not isinstance(length_bucketing, bool):
        print("rag worker: length_bucketing must be boolean", file=sys.stderr, flush=True)
        return 2
    chunk_tokens = positive_int(rag, "chunk_tokens", 512)
    overlap = positive_int(rag, "overlap", 64)
    if overlap >= chunk_tokens:
        print("rag worker: overlap must be smaller than chunk_tokens", file=sys.stderr, flush=True)
        return 2
    embed_batch_size = positive_int(rag, "batch_size", DEFAULT_EMBED_BATCH)
    message_batch = positive_int(rag, "message_batch_size", DEFAULT_MESSAGE_BATCH)
    poll_seconds = positive_int(rag, "poll_interval_ms", DEFAULT_POLL_SECONDS * 1000) / 1000
    lookback_seconds = positive_int(rag, "lookback_seconds", DEFAULT_LOOKBACK_SECONDS)
    full_sweep_interval = positive_int(rag, "full_sweep_interval_seconds", DEFAULT_FULL_SWEEP_INTERVAL)
    threads = positive_int(rag, "threads", DEFAULT_THREADS)
    state = load_state(args.state)
    stop = False

    def request_stop(_signum: int, _frame: Any) -> None:
        nonlocal stop
        stop = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(max(1, min(2, threads // 4)))
    print(f"rag worker: loading {model_name} (backend={backend} dtype={compute_dtype} length_bucketing={str(length_bucketing).lower()})", flush=True)
    model = load_model(model_name, model_path, onnx_file, backend)
    tokenizer = model.tokenizer
    tokenizer.model_max_length = 1_000_000
    model.max_seq_length = chunk_tokens
    chunker_version = f"{CHUNKER_VERSION_PREFIX}-{chunk_tokens}-{overlap}-v1"
    run_id = uuid.uuid4()
    connection = None
    candidate_stream = None
    batch_stager = None
    stream_rows = None
    stream_stage_pending = False
    stream_end_pending = False
    vector_writer = None
    try:
        connection = psycopg.connect(database_url, row_factory=dict_row)
        vector_writer = VectorBatchWriter(database_url)
        connection.execute(
            "insert into audit.pipeline_run(run_id,pipeline_name,code_version,params_json,status,triggered_by) values(%s,%s,%s,%s,%s,%s)",
            (run_id, "opencode_rag_embedding_service", chunker_version, Jsonb({"model": model_name, "backend": backend, "compute_dtype": compute_dtype, "length_bucketing": length_bucketing, "chunk_tokens": chunk_tokens, "overlap": overlap, "message_batch_size": message_batch, "embed_batch_size": embed_batch_size, "full_sweep_interval_seconds": full_sweep_interval, "embedding_dimension": int(model.get_embedding_dimension())}), "running", "better-compact"),
        )
        connection.commit()
        print(f"rag worker: started run {run_id}", flush=True)
        while not stop:
            try:
                page_started = time.perf_counter()
                cursor_rows: list[dict[str, Any]] = []
                rows: list[dict[str, Any]] = []
                staged_candidates = None
                if candidate_stream is None:
                    if state.get("caught_up"):
                        rows = fetch_candidates(connection, state, message_batch, chunker_version, model_name, lookback_seconds)
                        connection.commit()
                        if not rows and full_sweep_due(state, full_sweep_interval):
                            candidate_stream = CandidateStream(database_url, state, message_batch, chunker_version, model_name, True)
                    else:
                        candidate_stream = CandidateStream(database_url, state, message_batch, chunker_version, model_name, False)
                if candidate_stream is not None:
                    if batch_stager is None:
                        batch_stager = BatchStager(database_url, tokenizer, chunk_tokens, overlap, chunker_version, model_name)
                    if stream_rows is None:
                        stream_rows = candidate_stream.next()
                    if not stream_rows:
                        completed_full_sweep = candidate_stream.full_sweep
                        candidate_stream.close()
                        candidate_stream = None
                        stream_rows = None
                        stream_stage_pending = False
                        state["caught_up"] = True
                        if completed_full_sweep:
                            state["last_full_sweep_at"] = utc_now()
                        save_state(args.state, state)
                        print("rag worker: catch-up complete", flush=True)
                        if args.once:
                            break
                        continue
                    rows = stream_rows
                    stream_rows = None
                    cursor_rows = rows
                    if stream_stage_pending:
                        staged_candidates = batch_stager.collect()
                        stream_stage_pending = False
                    else:
                        batch_stager.submit(rows)
                        staged_candidates = batch_stager.collect()
                    lookahead_rows = candidate_stream.next()
                    if lookahead_rows:
                        stream_rows = lookahead_rows
                        batch_stager.submit(lookahead_rows)
                        stream_stage_pending = True
                    else:
                        stream_end_pending = True
                connection.commit()
                if not rows:
                    if args.once:
                        break
                    time.sleep(poll_seconds)
                    continue
                if staged_candidates is None:
                    processed, embedded = embed_batch(connection, rows, model, tokenizer, chunk_tokens, overlap, chunker_version, model_name, embed_batch_size, run_id, backend, compute_dtype, length_bucketing, vector_writer)
                else:
                    processed, embedded = embed_candidates(staged_candidates, model, embed_batch_size, run_id, model_name, backend, compute_dtype, length_bucketing, vector_writer, len(rows))
                if processed:
                    if cursor_rows and processed == len(rows):
                        state["cursor"] = cursor_from_row(cursor_rows[-1])
                        state["caught_up"] = False
                    state["last_progress_at"] = utc_now()
                    save_state(args.state, state)
                    elapsed = max(0.001, time.perf_counter() - page_started)
                    rate = embedded / elapsed
                    print(f"rag worker: processed_messages={processed} embedded_chunks={embedded} page_seconds={elapsed:.3f} embedded_chunks_per_second={rate:.2f}", flush=True)
                if stream_end_pending:
                    completed_full_sweep = candidate_stream.full_sweep if candidate_stream is not None else False
                    if candidate_stream is not None:
                        candidate_stream.close()
                    candidate_stream = None
                    stream_end_pending = False
                    state["caught_up"] = True
                    if completed_full_sweep:
                        state["last_full_sweep_at"] = utc_now()
                    save_state(args.state, state)
                    print("rag worker: catch-up complete", flush=True)
                if processed < len(rows):
                    time.sleep(1)
            except Exception as error:
                connection.rollback()
                if candidate_stream is not None:
                    candidate_stream.close()
                    candidate_stream = None
                stream_rows = None
                stream_stage_pending = False
                stream_end_pending = False
                if batch_stager is not None:
                    try:
                        batch_stager.close()
                    except Exception as close_error:
                        print(f"warning: RAG staging cleanup failed: {type(close_error).__name__}: {close_error}", file=sys.stderr, flush=True)
                    batch_stager = None
                state["last_error_at"] = utc_now()
                save_state(args.state, state)
                print(f"warning: rag worker pass failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                traceback.print_exc(file=sys.stderr)
                if args.once:
                    return finish_run(connection, run_id, "failed")
                time.sleep(min(300, max(5, poll_seconds)))
        return finish_run(connection, run_id, "success")
    except Exception as error:
        if connection is not None:
            connection.rollback()
            try:
                finish_run(connection, run_id, "failed")
            except Exception:
                pass
        print(f"rag worker failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        if candidate_stream is not None:
            candidate_stream.close()
        if batch_stager is not None:
            batch_stager.close()
        if vector_writer is not None:
            vector_writer.close()
        if connection is not None:
            connection.close()


def load_config(filename: Path) -> dict[str, Any]:
    value = json.loads(filename.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("better-compact config must be an object")
    rag = value.get("rag")
    if not isinstance(rag, dict):
        value["rag"] = {"enabled": False}
    return value


def resolve_backend(configured_backend: str, model_path: str) -> str:
    if configured_backend != "auto":
        return configured_backend
    if not model_path:
        return "torch"
    model_directory = Path(model_path)
    if any(model_directory.glob("model*.safetensors")) or any(model_directory.glob("pytorch_model*.bin")):
        return "torch"
    return "onnx"


def supports_bfloat16() -> bool:
    checker = getattr(torch.cpu, "_is_avx512_bf16_supported", None)
    if not torch.backends.mkldnn.enabled or checker is None:
        return False
    try:
        return bool(checker())
    except Exception:
        return False


def load_model(model_name: str, model_path: str, onnx_file: str, backend: str) -> SentenceTransformer:
    if backend == "onnx":
        if not Path(model_path).is_dir():
            raise FileNotFoundError(f"configured RAG model path does not exist: {model_path}")
        return SentenceTransformer(model_path, backend="onnx", model_kwargs={"file_name": onnx_file}, device="cpu")
    if model_path:
        if not Path(model_path).is_dir():
            raise FileNotFoundError(f"configured RAG model path does not exist: {model_path}")
        return SentenceTransformer(model_path, backend="torch", device="cpu")
    return SentenceTransformer(model_name, backend="torch", device="cpu")


def fetch_candidates(connection: psycopg.Connection, state: dict[str, Any], limit: int, chunker_version: str, model_name: str, lookback_seconds: int, full_sweep: bool = False) -> list[dict[str, Any]]:
    cursor = state.get("cursor") if not state.get("caught_up") else None
    live = cursor is None and state.get("caught_up") is True
    if live:
        since = datetime.now(timezone.utc).timestamp() - lookback_seconds
        cursor = {"updated_at": datetime.fromtimestamp(since, timezone.utc).isoformat(), "installation_id": "", "source_id": "", "session_id": "", "message_id": ""}
    cursor = cursor or {"updated_at": "1970-01-01T00:00:00+00:00", "installation_id": "", "source_id": "", "session_id": "", "message_id": ""}
    with connection.cursor() as cursor_handle:
        if live and not full_sweep:
            cursor_handle.execute(
                LIVE_MESSAGE_QUERY,
                (
                    cursor["updated_at"],
                    CHUNK_MODE,
                    chunker_version,
                    CHUNK_MODE,
                    chunker_version,
                    model_name,
                    limit,
                ),
            )
        else:
            cursor_handle.execute(
                MESSAGE_QUERY,
                (
                    live,
                    full_sweep,
                    cursor["updated_at"],
                    not bool(state.get("caught_up")) and not full_sweep,
                    cursor["updated_at"],
                    cursor["installation_id"],
                    cursor["source_id"],
                    cursor["session_id"],
                    cursor["message_id"],
                    CHUNK_MODE,
                    chunker_version,
                    CHUNK_MODE,
                    chunker_version,
                    model_name,
                    limit,
                ),
            )
        return list(cursor_handle.fetchall())


def stream_parameters(state: dict[str, Any], chunker_version: str, model_name: str, full_sweep: bool) -> tuple[Any, ...]:
    cursor = state.get("cursor") or {"updated_at": "1970-01-01T00:00:00+00:00", "installation_id": "", "source_id": "", "session_id": "", "message_id": ""}
    return (
        False,
        full_sweep,
        cursor["updated_at"],
        not bool(state.get("caught_up")) and not full_sweep,
        cursor["updated_at"],
        cursor["installation_id"],
        cursor["source_id"],
        cursor["session_id"],
        cursor["message_id"],
        CHUNK_MODE,
        chunker_version,
        CHUNK_MODE,
        chunker_version,
        model_name,
    )


def merge_candidates(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for group in groups:
        for row in group:
            key = (str(row["installation_id"]), str(row["source_id"]), str(row["session_id"]), str(row["message_id"]), str(row["content_hash"]))
            if key in seen:
                continue
            seen.add(key)
            result.append(row)
    return result


class CandidateStream:
    """Run one backfill query and prefetch its next page while encoding."""

    def __init__(self, database_url: str, state: dict[str, Any], limit: int, chunker_version: str, model_name: str, full_sweep: bool):
        self.database_url = database_url
        self.state = state
        self.limit = limit
        self.chunker_version = chunker_version
        self.model_name = model_name
        self.full_sweep = full_sweep
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rag-candidate-reader")
        self.connection: psycopg.Connection | None = None
        self.cursor: psycopg.ServerCursor | None = None
        self.pending: Future[list[dict[str, Any]]] | None = self.executor.submit(self._open_and_fetch)

    def next(self) -> list[dict[str, Any]]:
        if self.pending is None:
            return []
        future = self.pending
        self.pending = None
        rows = future.result()
        if rows:
            self.pending = self.executor.submit(self._fetch)
        return rows

    def close(self) -> None:
        pending = self.pending
        self.pending = None
        if pending is not None:
            try:
                pending.result()
            except Exception:
                pass
        try:
            self.executor.submit(self._close_reader).result()
        finally:
            self.executor.shutdown(wait=True)

    def _open_and_fetch(self) -> list[dict[str, Any]]:
        self.connection = psycopg.connect(self.database_url, row_factory=dict_row)
        self.connection.execute("set transaction read only")
        self.cursor = self.connection.cursor(name=f"rag-candidates-{uuid.uuid4().hex}")
        self.cursor.execute(MESSAGE_STREAM_QUERY, stream_parameters(self.state, self.chunker_version, self.model_name, self.full_sweep))
        return [dict(row) for row in self.cursor.fetchmany(self.limit)]

    def _fetch(self) -> list[dict[str, Any]]:
        if self.cursor is None:
            return []
        return [dict(row) for row in self.cursor.fetchmany(self.limit)]

    def _close_reader(self) -> None:
        if self.cursor is not None:
            try:
                self.cursor.close()
            finally:
                self.cursor = None
        if self.connection is not None:
            self.connection.rollback()
            self.connection.close()
            self.connection = None


class BatchStager:
    """Insert/select the next message page while the current page is encoded."""

    def __init__(self, database_url: str, tokenizer: Any, chunk_tokens: int, overlap: int, chunker_version: str, model_name: str):
        self.database_url = database_url
        self.tokenizer = tokenizer
        self.chunk_tokens = chunk_tokens
        self.overlap = overlap
        self.chunker_version = chunker_version
        self.model_name = model_name
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rag-batch-stager")
        self.pending: Future[list[dict[str, Any]]] | None = None
        self.connection: psycopg.Connection | None = None

    def submit(self, rows: list[dict[str, Any]]) -> None:
        if self.pending is not None:
            raise RuntimeError("RAG batch stager already has a pending page")
        self.pending = self.executor.submit(self._stage, rows)

    def collect(self) -> list[dict[str, Any]]:
        if self.pending is None:
            raise RuntimeError("RAG batch stager has no pending page")
        future = self.pending
        self.pending = None
        return future.result()

    def close(self) -> None:
        error: BaseException | None = None
        try:
            if self.pending is not None:
                self.collect()
        except BaseException as caught:
            error = caught
        try:
            self.executor.submit(self._close_connection).result()
        finally:
            self.executor.shutdown(wait=True)
        if error is not None:
            raise error

    def _stage(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.connection is None:
            self.connection = psycopg.connect(self.database_url, row_factory=dict_row)
        try:
            return stage_batch(self.connection, rows, self.tokenizer, self.chunk_tokens, self.overlap, self.chunker_version, self.model_name)
        except BaseException:
            self.connection.rollback()
            raise

    def _close_connection(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None


class VectorBatchWriter:
    """Keep one database connection in a writer thread while CPU work continues."""

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="rag-vector-writer")
        self.pending: Future[int] | None = None
        self.connection: psycopg.Connection | None = None
        self.completed = 0

    def submit(self, batch: list[dict[str, Any]], vectors: Any, model_name: str, run_id: uuid.UUID) -> None:
        self._collect_pending()
        self.pending = self.executor.submit(self._write, batch, vectors, model_name, run_id)

    def finish(self) -> int:
        self._collect_pending()
        completed = self.completed
        self.completed = 0
        return completed

    def close(self) -> None:
        error: BaseException | None = None
        try:
            self._collect_pending()
        except BaseException as caught:
            error = caught
        try:
            self.executor.submit(self._close_connection).result()
        finally:
            self.executor.shutdown(wait=True)
        if error is not None:
            raise error

    def _collect_pending(self) -> None:
        if self.pending is None:
            return
        future = self.pending
        self.pending = None
        self.completed += future.result()

    def _write(self, batch: list[dict[str, Any]], vectors: Any, model_name: str, run_id: uuid.UUID) -> int:
        if self.connection is None:
            self.connection = psycopg.connect(self.database_url, row_factory=dict_row)
        prepared = [
            (int(item["chunk_id"]), [float(value) for value in vector])
            for item, vector in zip(batch, vectors)
        ]
        input_rows = [
            (chunk_id, Jsonb(values), model_name, run_id, "[" + ",".join(str(number) for number in values) + "]")
            for chunk_id, values in prepared
        ]
        try:
            with self.connection.cursor() as cursor:
                input_placeholders = ",".join(["(%s,%s,%s,%s,%s)"] * len(input_rows))
                input_values = tuple(value for row in input_rows for value in row)
                cursor.execute(
                    "with input(chunk_id,embedding_json,embedding_model,run_id,embedding_vec) as (values "
                    + input_placeholders
                    + "), inserted_events as ("
                    "insert into rag.embedding_event(chunk_id,embedding_json,embedding_model,run_id) "
                    "select i.chunk_id,i.embedding_json,i.embedding_model,i.run_id from input i "
                    "where not exists (select 1 from rag.embedding_current_384 c "
                    "where c.chunk_id=i.chunk_id and c.embedding_model=i.embedding_model) "
                    "returning embedding_event_id,chunk_id) "
                    "insert into rag.embedding_current_384(chunk_id,embedding_event_id,embedding_model,embedding_vec) "
                    "select e.chunk_id,e.embedding_event_id,i.embedding_model,i.embedding_vec::vector "
                    "from inserted_events e "
                    "join input i on i.chunk_id=e.chunk_id "
                    "on conflict do nothing",
                    input_values,
                )
                embedded = cursor.rowcount
            self.connection.commit()
            return embedded
        except BaseException:
            self.connection.rollback()
            raise

    def _close_connection(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None


def embed_batch(connection: psycopg.Connection, rows: list[dict[str, Any]], model: SentenceTransformer, tokenizer: Any, chunk_tokens: int, overlap: int, chunker_version: str, model_name: str, batch_size: int, run_id: uuid.UUID, backend: str, compute_dtype: str, length_bucketing: bool, vector_writer: VectorBatchWriter) -> tuple[int, int]:
    candidates = stage_batch(connection, rows, tokenizer, chunk_tokens, overlap, chunker_version, model_name)
    return embed_candidates(candidates, model, batch_size, run_id, model_name, backend, compute_dtype, length_bucketing, vector_writer, len(rows))


def stage_batch(connection: psycopg.Connection, rows: list[dict[str, Any]], tokenizer: Any, chunk_tokens: int, overlap: int, chunker_version: str, model_name: str) -> list[dict[str, Any]]:
    document_rows: list[tuple[str, str, str, str, str, str]] = []
    chunk_inputs: list[tuple[str, str, int, str, int, str]] = []
    for row in rows:
        source_pk = f"{row['installation_id']}:{row['source_id']}:{row['session_id']}:{row['message_id']}"
        content_hash = str(row["content_hash"])
        text = str(row["content_text"])
        document_rows.append((SOURCE_SYSTEM, SOURCE_TABLE, source_pk, str(row["session_id"]), text, content_hash))
        for index, (chunk, token_count) in enumerate(chunk_text(text, tokenizer, chunk_tokens, overlap)):
            chunk_inputs.append((source_pk, content_hash, index, chunk, token_count, hashlib.sha256(chunk.encode("utf-8")).hexdigest()))

    if not document_rows:
        connection.commit()
        return []
    with connection.cursor() as cursor:
        cursor.executemany(
            "insert into rag.document_source(source_system,source_table,source_pk,title,content_text,content_hash) values(%s,%s,%s,%s,%s,%s) on conflict do nothing",
            document_rows,
        )
        source_pks = list(dict.fromkeys(row[2] for row in document_rows))
        cursor.execute(
            "select source_pk,content_hash,doc_id from rag.document_source where source_system=%s and source_table=%s and source_pk = any(%s)",
            (SOURCE_SYSTEM, SOURCE_TABLE, source_pks),
        )
        requested_documents = {(row[2], row[5]) for row in document_rows}
        document_ids = {
            (str(row["source_pk"]), str(row["content_hash"])): int(row["doc_id"])
            for row in cursor.fetchall()
            if (str(row["source_pk"]), str(row["content_hash"])) in requested_documents
        }
        chunk_rows = [
            (document_ids[(source_pk, content_hash)], index, chunk, token_count, chunk_hash, CHUNK_MODE, chunker_version)
            for source_pk, content_hash, index, chunk, token_count, chunk_hash in chunk_inputs
        ]
        for start in range(0, len(chunk_rows), STAGING_BATCH_ROWS):
            cursor.executemany(
                "insert into rag.chunk(doc_id,chunk_index,chunk_text,token_count,chunk_hash,chunking_mode,chunker_version) values(%s,%s,%s,%s,%s,%s,%s) on conflict (doc_id,chunk_index,chunk_hash,chunking_mode,chunker_version) do nothing",
                chunk_rows[start : start + STAGING_BATCH_ROWS],
            )
        document_id_values = list(document_ids.values())
        if not document_id_values:
            connection.commit()
            return []
        cursor.execute(
            """select c.chunk_id,c.chunk_index,c.chunk_text,c.token_count
               from rag.chunk c
               where c.doc_id = any(%s) and c.chunking_mode=%s and c.chunker_version=%s
                 and not exists (select 1 from rag.embedding_current_384 e where e.chunk_id=c.chunk_id and e.embedding_model=%s)
               order by c.doc_id,c.chunk_index""",
            (document_id_values, CHUNK_MODE, chunker_version, model_name),
        )
        candidates = [dict(chunk) for chunk in cursor.fetchall()]
    # Release the staging transaction before CPU inference. Vector writes use a
    # separate connection, so their commits can overlap the next encode call.
    connection.commit()
    return candidates


def embed_candidates(candidates: list[dict[str, Any]], model: SentenceTransformer, batch_size: int, run_id: uuid.UUID, model_name: str, backend: str, compute_dtype: str, length_bucketing: bool, vector_writer: VectorBatchWriter, processed_messages: int) -> tuple[int, int]:
    if length_bucketing:
        candidates.sort(key=lambda item: (int(item["token_count"]), int(item["chunk_id"])))
    for start in range(0, len(candidates), batch_size):
        batch = candidates[start : start + batch_size]
        vectors = encode_embeddings(model, [str(item["chunk_text"]) for item in batch], batch_size, backend, compute_dtype)
        vector_writer.submit(batch, vectors, model_name, run_id)
    return processed_messages, vector_writer.finish()


def encode_embeddings(model: SentenceTransformer, texts: list[str], batch_size: int, backend: str, compute_dtype: str) -> Any:
    if backend == "torch" and callable(getattr(model, "preprocess", None)) and callable(getattr(model, "forward", None)):
        return encode_torch_forward(model, texts, batch_size, compute_dtype)
    context = nullcontext() if compute_dtype == "float32" else torch.autocast(device_type="cpu", dtype=torch.bfloat16)
    with context:
        return model.encode(texts, batch_size=batch_size, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)


def encode_torch_forward(model: SentenceTransformer, texts: list[str], batch_size: int, compute_dtype: str) -> Any:
    vectors = []
    with torch.inference_mode():
        for start in range(0, len(texts), batch_size):
            features = model.preprocess(texts[start : start + batch_size])
            context = nullcontext() if compute_dtype == "float32" else torch.autocast(device_type="cpu", dtype=torch.bfloat16)
            with context:
                output = model.forward(features)["sentence_embedding"]
            vectors.append(torch.nn.functional.normalize(output.float(), p=2, dim=1).cpu().numpy())
    return torch.cat([torch.from_numpy(vector) for vector in vectors]).numpy() if vectors else []


def chunk_text(text: str, tokenizer: Any, size: int, overlap: int) -> list[tuple[str, int]]:
    tokens = tokenizer.encode(text, add_special_tokens=False)
    if not tokens:
        return []
    step = max(1, size - overlap)
    result: list[tuple[str, int]] = []
    for start in range(0, len(tokens), step):
        window = tokens[start : start + size]
        if not window:
            break
        value = tokenizer.decode(window, skip_special_tokens=True).strip()
        if value:
            result.append((value, len(window)))
        if start + size >= len(tokens):
            break
    return result


def cursor_from_row(row: dict[str, Any]) -> dict[str, str]:
    updated_at = row["updated_at"]
    if isinstance(updated_at, datetime):
        value = updated_at.astimezone(timezone.utc).isoformat()
    else:
        value = str(updated_at)
    return {"updated_at": value, "installation_id": str(row["installation_id"]), "source_id": str(row["source_id"]), "session_id": str(row["session_id"]), "message_id": str(row["message_id"])}


def load_state(filename: Path) -> dict[str, Any]:
    try:
        value = json.loads(filename.read_text(encoding="utf-8"))
        if isinstance(value, dict) and value.get("version") == STATE_VERSION:
            return value
    except (OSError, ValueError):
        pass
    return {"version": STATE_VERSION, "caught_up": False}


def full_sweep_due(state: dict[str, Any], interval_seconds: int) -> bool:
    value = state.get("last_full_sweep_at")
    if not isinstance(value, str):
        return True
    try:
        timestamp = datetime.fromisoformat(value)
    except ValueError:
        return True
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - timestamp).total_seconds() >= interval_seconds


def save_state(filename: Path, value: dict[str, Any]) -> None:
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = filename.with_name(f"{filename.name}.tmp-{os.getpid()}")
    temporary.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(filename)
    filename.chmod(0o600)


def finish_run(connection: psycopg.Connection, run_id: uuid.UUID, status: str) -> int:
    connection.execute("update audit.pipeline_run set finished_at=now(), status=%s where run_id=%s", (status, run_id))
    connection.commit()
    return 0 if status == "success" else 1


def positive_int(value: dict[str, Any], key: str, default: int) -> int:
    candidate = value.get(key, default)
    if not isinstance(candidate, int) or isinstance(candidate, bool) or candidate <= 0:
        return default
    return candidate


def expand_path(value: str) -> str:
    return os.path.abspath(os.path.expanduser(value)) if value else ""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


if __name__ == "__main__":
    raise SystemExit(main())
