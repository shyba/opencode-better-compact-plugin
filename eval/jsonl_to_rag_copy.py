#!/usr/bin/env python3
"""Convert embedding JSONL into a quoted TSV suitable for PostgreSQL COPY."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


FIELDS = (
    "source_system",
    "source_table",
    "source_pk",
    "title",
    "content_text",
    "content_hash",
    "chunk_index",
    "chunk_text",
    "token_count",
    "chunk_hash",
    "chunking_mode",
    "chunker_version",
    "embedding_model",
    "embedding_json",
    "embedding_vec",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rows = []
    with args.input.open(encoding="utf-8") as source:
        for line in source:
            value = json.loads(line)
            rows.append(
                [
                    value[field] if field not in {"embedding_json"} else json.dumps(value[field], separators=(",", ":"))
                    for field in FIELDS
                ]
            )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8", newline="") as target:
        csv.writer(target, delimiter="\t", quoting=csv.QUOTE_ALL, lineterminator="\n").writerows(rows)
    args.output.chmod(0o600)
    print(json.dumps({"rows": len(rows), "output": str(args.output)}))


if __name__ == "__main__":
    main()
