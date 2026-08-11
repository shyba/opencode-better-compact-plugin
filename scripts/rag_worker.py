#!/usr/bin/env python3
"""Restart-safe BGE-small OpenCode RAG worker.

The worker reads only the synchronized OpenCode-V1 projection, keeps no
transcript cache on disk, and writes append-only rows to the existing RAG
tables. It is intentionally separate from compaction and session sync: a
database or model failure can pause retrieval without affecting OpenCode.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import sys
import time
import traceback
import uuid
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
DEFAULT_POLL_SECONDS = 30
DEFAULT_LOOKBACK_SECONDS = 900
DEFAULT_MESSAGE_BATCH = 32
DEFAULT_EMBED_BATCH = 64
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
    and coalesce(nullif(trim(p.data->>'text'), ''), '') <> ''
  group by m.installation_id, m.source_id, m.session_id, m.message_id,
    m.source_updated_at, m.source_created_at
)
select
  records.*,
  encode(digest(records.content_text, 'sha256'), 'hex') as content_hash
from records
where records.content_text is not null
  and btrim(records.content_text) <> ''
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
    and coalesce(nullif(trim(p.data->>'text'), ''), '') <> ''
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
    chunk_tokens = positive_int(rag, "chunk_tokens", 512)
    overlap = positive_int(rag, "overlap", 64)
    if overlap >= chunk_tokens:
        print("rag worker: overlap must be smaller than chunk_tokens", file=sys.stderr, flush=True)
        return 2
    embed_batch_size = positive_int(rag, "batch_size", DEFAULT_EMBED_BATCH)
    message_batch = positive_int(rag, "message_batch_size", DEFAULT_MESSAGE_BATCH)
    poll_seconds = positive_int(rag, "poll_interval_ms", DEFAULT_POLL_SECONDS * 1000) / 1000
    lookback_seconds = positive_int(rag, "lookback_seconds", DEFAULT_LOOKBACK_SECONDS)
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
    print(f"rag worker: loading {model_name} ({'onnx' if model_path else 'torch'})", flush=True)
    model = load_model(model_name, model_path, onnx_file)
    tokenizer = model.tokenizer
    tokenizer.model_max_length = 1_000_000
    model.max_seq_length = chunk_tokens
    chunker_version = f"{CHUNKER_VERSION_PREFIX}-{chunk_tokens}-{overlap}-v1"
    run_id = uuid.uuid4()
    connection = None
    try:
        connection = psycopg.connect(database_url, row_factory=dict_row)
        connection.execute(
            "insert into audit.pipeline_run(run_id,pipeline_name,code_version,params_json,status,triggered_by) values(%s,%s,%s,%s,%s,%s)",
            (run_id, "opencode_rag_embedding_service", chunker_version, Jsonb({"model": model_name, "chunk_tokens": chunk_tokens, "overlap": overlap, "embedding_dimension": int(model.get_embedding_dimension())}), "running", "better-compact"),
        )
        connection.commit()
        print(f"rag worker: started run {run_id}", flush=True)
        while not stop:
            try:
                cursor_rows: list[dict[str, Any]] = []
                if state.get("caught_up"):
                    rows = fetch_candidates(connection, state, message_batch, chunker_version, model_name, lookback_seconds)
                    if not rows:
                        rows = fetch_candidates(connection, state, message_batch, chunker_version, model_name, lookback_seconds, full_sweep=True)
                        cursor_rows = rows
                else:
                    live_limit = max(1, message_batch // 4)
                    backlog_limit = max(1, message_batch - live_limit)
                    live_rows = fetch_candidates(connection, {"caught_up": True}, live_limit, chunker_version, model_name, lookback_seconds)
                    backlog_rows = fetch_candidates(connection, state, backlog_limit, chunker_version, model_name, lookback_seconds)
                    rows = merge_candidates(live_rows, backlog_rows)
                    cursor_rows = backlog_rows
                if not rows:
                    if not state.get("caught_up"):
                        state["caught_up"] = True
                        save_state(args.state, state)
                        print("rag worker: catch-up complete", flush=True)
                    if args.once:
                        break
                    time.sleep(poll_seconds)
                    continue
                processed, embedded = embed_batch(connection, rows, model, tokenizer, chunk_tokens, overlap, chunker_version, model_name, embed_batch_size, run_id)
                if processed:
                    if cursor_rows and processed == len(rows):
                        state["cursor"] = cursor_from_row(cursor_rows[-1])
                        state["caught_up"] = False
                    state["last_progress_at"] = utc_now()
                    save_state(args.state, state)
                    print(f"rag worker: processed_messages={processed} embedded_chunks={embedded}", flush=True)
                if processed < len(rows):
                    time.sleep(1)
            except Exception as error:
                connection.rollback()
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


def load_model(model_name: str, model_path: str, onnx_file: str) -> SentenceTransformer:
    if model_path:
        if not Path(model_path).is_dir():
            raise FileNotFoundError(f"configured RAG model path does not exist: {model_path}")
        return SentenceTransformer(model_path, backend="onnx", model_kwargs={"file_name": onnx_file}, device="cpu")
    return SentenceTransformer(model_name, device="cpu")


def fetch_candidates(connection: psycopg.Connection, state: dict[str, Any], limit: int, chunker_version: str, model_name: str, lookback_seconds: int, full_sweep: bool = False) -> list[dict[str, Any]]:
    cursor = state.get("cursor") if not state.get("caught_up") else None
    live = cursor is None and state.get("caught_up") is True
    if live:
        since = datetime.now(timezone.utc).timestamp() - lookback_seconds
        cursor = {"updated_at": datetime.fromtimestamp(since, timezone.utc).isoformat(), "installation_id": "", "source_id": "", "session_id": "", "message_id": ""}
    cursor = cursor or {"updated_at": "1970-01-01T00:00:00+00:00", "installation_id": "", "source_id": "", "session_id": "", "message_id": ""}
    parameters = (
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
    )
    with connection.cursor() as cursor_handle:
        cursor_handle.execute(MESSAGE_QUERY, parameters)
        return list(cursor_handle.fetchall())


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


def embed_batch(connection: psycopg.Connection, rows: list[dict[str, Any]], model: SentenceTransformer, tokenizer: Any, chunk_tokens: int, overlap: int, chunker_version: str, model_name: str, batch_size: int, run_id: uuid.UUID) -> tuple[int, int]:
    candidates: list[dict[str, Any]] = []
    with connection.cursor() as cursor:
        for row in rows:
            text = str(row["content_text"])
            document_id = ensure_document(cursor, row, text)
            chunks = chunk_text(text, tokenizer, chunk_tokens, overlap)
            for index, (chunk, token_count) in enumerate(chunks):
                chunk_hash = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
                cursor.execute(
                    "insert into rag.chunk(doc_id,chunk_index,chunk_text,token_count,chunk_hash,chunking_mode,chunker_version) values(%s,%s,%s,%s,%s,%s,%s) on conflict (doc_id,chunk_index,chunk_hash) do nothing",
                    (document_id, index, chunk, token_count, chunk_hash, CHUNK_MODE, chunker_version),
                )
            cursor.execute(
                """select c.chunk_id,c.chunk_index,c.chunk_text,c.token_count
                   from rag.chunk c
                   where c.doc_id=%s and c.chunking_mode=%s and c.chunker_version=%s
                     and not exists (select 1 from rag.embedding_current_384 e where e.chunk_id=c.chunk_id and e.embedding_model=%s)
                   order by c.chunk_index""",
                (document_id, CHUNK_MODE, chunker_version, model_name),
            )
            for chunk in cursor.fetchall():
                candidates.append(dict(chunk))
        if not candidates:
            connection.commit()
            return len(rows), 0
    embedded = 0
    for start in range(0, len(candidates), batch_size):
        batch = candidates[start : start + batch_size]
        vectors = model.encode([str(item["chunk_text"]) for item in batch], batch_size=batch_size, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        event_rows = []
        for item, vector in zip(batch, vectors):
            values = [float(value) for value in vector]
            event_rows.append((int(item["chunk_id"]), Jsonb(values), model_name, run_id))
        with connection.cursor() as cursor:
            event_placeholders = ",".join(["(%s,%s,%s,%s)"] * len(event_rows))
            event_values = tuple(value for row in event_rows for value in row)
            cursor.execute(
                "insert into rag.embedding_event(chunk_id,embedding_json,embedding_model,run_id) values "
                + event_placeholders
                + " returning embedding_event_id,chunk_id",
                event_values,
            )
            event_ids = {int(row["chunk_id"]): int(row["embedding_event_id"]) for row in cursor.fetchall()}
            current_rows = []
            for item, vector in zip(batch, vectors):
                values = [float(value) for value in vector]
                current_rows.append(
                    (
                        int(item["chunk_id"]),
                        event_ids[int(item["chunk_id"])],
                        model_name,
                        "[" + ",".join(str(value) for value in values) + "]",
                    )
                )
            current_placeholders = ",".join(["(%s,%s,%s,%s)"] * len(current_rows))
            current_values = tuple(value for row in current_rows for value in row)
            cursor.execute(
                "insert into rag.embedding_current_384(chunk_id,embedding_event_id,embedding_model,embedding_vec) values "
                + current_placeholders
                + " on conflict do nothing",
                current_values,
            )
            embedded += cursor.rowcount
        connection.commit()
    return len(rows), embedded


def ensure_document(cursor: psycopg.Cursor, row: dict[str, Any], text: str) -> int:
    source_pk = f"{row['installation_id']}:{row['source_id']}:{row['session_id']}:{row['message_id']}"
    cursor.execute(
        """insert into rag.document_source(source_system,source_table,source_pk,title,content_text,content_hash)
           values(%s,%s,%s,%s,%s,%s) on conflict do nothing returning doc_id""",
        (SOURCE_SYSTEM, SOURCE_TABLE, source_pk, str(row["session_id"]), text, str(row["content_hash"])),
    )
    document = cursor.fetchone()
    if document:
        return int(document["doc_id"])
    cursor.execute(
        "select doc_id from rag.document_source where source_system=%s and source_table=%s and source_pk=%s and content_hash=%s",
        (SOURCE_SYSTEM, SOURCE_TABLE, source_pk, str(row["content_hash"])),
    )
    document = cursor.fetchone()
    if not document:
        raise RuntimeError("RAG document insert was not visible after conflict")
    return int(document["doc_id"])


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
