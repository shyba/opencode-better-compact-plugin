#!/usr/bin/env python3
"""Aggregate a bounded PostgreSQL COPY export into embedding input JSONL."""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    grouped: dict[tuple[str, str, str, str], dict[str, object]] = {}
    with args.input.open(encoding="utf-8", newline="") as source:
        for installation_id, source_id, session_id, message_id, role, part_id, part_type, synthetic, text in csv.reader(source, delimiter="\t", quotechar='"'):
            if not text.strip():
                continue
            key = (installation_id, source_id, session_id, message_id)
            record = grouped.setdefault(key, {"installation_id": installation_id, "source_id": source_id, "session_id": session_id, "message_id": message_id, "role": role, "parts": []})
            record["parts"].append((part_id, part_type, synthetic == "t", text))
    lines = []
    for record in grouped.values():
        parts = sorted(record["parts"], key=lambda value: value[0])
        text = "\n\n".join(value[3] for value in parts)
        if not text.strip():
            continue
        lines.append(
            json.dumps(
                {
                    "session_id": record["session_id"],
                    "message_id": record["message_id"],
                    "role": record["role"],
                    "synthetic": any(value[2] for value in parts),
                    "text": text,
                    "installation_id": record["installation_id"],
                    "source_id": record["source_id"],
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(lines), encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"records": len(lines), "output": str(args.output)}))


if __name__ == "__main__":
    main()
