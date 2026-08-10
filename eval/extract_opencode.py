#!/usr/bin/env python3
"""Extract a bounded, read-only OpenCode V1 transcript corpus for evaluation.

This intentionally writes only the selected, capped records to the caller's
output path. It never modifies the OpenCode database and omits tool output by
default because raw tool payloads are both noisy and privacy-sensitive.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def bounded_text(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def parse_json(value: str) -> dict[str, object]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def part_text(data: dict[str, object], include_tool_output: bool, max_bytes: int) -> tuple[str, bool]:
    part_type = data.get("type")
    synthetic = data.get("synthetic") is True
    if part_type in {"text", "reasoning"} and isinstance(data.get("text"), str):
        return bounded_text(str(data["text"]), max_bytes), synthetic
    if part_type != "tool":
        return "", synthetic
    if not include_tool_output:
        return "", synthetic
    tool = data.get("tool") if isinstance(data.get("tool"), str) else "tool"
    state = data.get("state") if isinstance(data.get("state"), dict) else {}
    status = state.get("status") if isinstance(state.get("status"), str) else "unknown"
    title = state.get("title") if isinstance(state.get("title"), str) else ""
    pieces = [f"[tool {tool} status={status}]", title]
    metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
    output = metadata.get("output") if isinstance(metadata.get("output"), str) else ""
    error = state.get("error") if isinstance(state.get("error"), str) else ""
    pieces.extend([output, error])
    return bounded_text("\n".join(piece for piece in pieces if piece), max_bytes), synthetic


def extract_session(connection: sqlite3.Connection, session_id: str, max_text_bytes: int, include_tool_output: bool) -> list[dict[str, object]]:
    messages = connection.execute(
        "select id, time_created, data from message where session_id=? order by time_created, id",
        (session_id,),
    ).fetchall()
    parts = connection.execute(
        "select message_id, time_created, id, data from part where session_id=? order by time_created, id",
        (session_id,),
    ).fetchall()
    by_message: dict[str, list[tuple[str, str, str]]] = {}
    for message_id, _time_created, part_id, data in parts:
        by_message.setdefault(str(message_id), []).append((str(part_id), str(_time_created), str(data)))
    records: list[dict[str, object]] = []
    for ordinal, (message_id, _time_created, raw_data) in enumerate(messages):
        message = parse_json(str(raw_data))
        role = message.get("role")
        if not isinstance(role, str):
            continue
        texts: list[str] = []
        synthetic = False
        for _part_id, _part_time, raw_part in by_message.get(str(message_id), []):
            text, is_synthetic = part_text(parse_json(raw_part), include_tool_output, max_text_bytes)
            if text:
                texts.append(text)
            synthetic = synthetic or is_synthetic
        text = bounded_text("\n\n".join(texts), max_text_bytes)
        if not text.strip():
            continue
        records.append({"session_id": session_id, "ordinal": ordinal, "message_id": str(message_id), "role": role, "synthetic": synthetic, "text": text})
    return records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--session", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-text-bytes", type=int, default=200_000)
    parser.add_argument("--include-tool-output", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    connection = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    connection.execute("pragma query_only=on")
    connection.execute("pragma busy_timeout=5000")
    records = [
        record
        for session_id in args.session
        for record in extract_session(connection, session_id, args.max_text_bytes, args.include_tool_output)
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records), encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"sessions": args.session, "records": len(records), "output": str(args.output)}))


if __name__ == "__main__":
    main()
