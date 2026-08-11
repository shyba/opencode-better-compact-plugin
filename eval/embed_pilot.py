#!/usr/bin/env python3
"""Create bounded embedding rows from an extracted OpenCode JSONL corpus.

The output is an intermediate JSONL file for the separately reviewed RAG
loader. It contains no database credentials and never writes PostgreSQL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from sentence_transformers import SentenceTransformer

from rag_pilot import chunk_text, load_records


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--installation-id", required=True)
    parser.add_argument("--source-id", required=True)
    parser.add_argument("--chunk-tokens", type=int, default=512)
    parser.add_argument("--overlap", type=int, default=64)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--rows-per-batch", type=int, default=2048)
    parser.add_argument("--threads", type=int, default=16)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(max(1, min(2, args.threads // 4)))
    model = SentenceTransformer(str(args.model), device="cpu")
    tokenizer = model.tokenizer
    tokenizer.model_max_length = 1_000_000
    model.max_seq_length = args.chunk_tokens
    records = load_records(args.corpus)
    candidates = [
        (record, index, text, token_count)
        for record in records
        if record.role == "assistant"
        for index, (text, token_count) in enumerate(chunk_text(record.text, tokenizer, args.chunk_tokens, args.overlap))
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output:
        for start in range(0, len(candidates), args.rows_per_batch):
            batch = candidates[start : start + args.rows_per_batch]
            embeddings = model.encode(
                [text for _record, _index, text, _token_count in batch],
                batch_size=args.batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            for (record, index, text, token_count), embedding in zip(batch, embeddings):
                source_pk = ":".join((record.installation_id or args.installation_id, record.source_id or args.source_id, record.session_id, record.message_id))
                content_hash = hashlib.sha256(record.text.encode("utf-8")).hexdigest()
                chunk_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
                output.write(
                    json.dumps(
                        {
                            "source_system": "opencode",
                            "source_table": "opencode.message",
                            "source_pk": source_pk,
                            "title": record.session_id,
                            "content_text": record.text,
                            "content_hash": content_hash,
                            "chunk_index": index,
                            "chunk_text": text,
                            "token_count": token_count,
                            "chunk_hash": chunk_hash,
                            "chunking_mode": "opencode_tokens",
                            "chunker_version": f"bge-small-en-v1.5-{args.chunk_tokens}-{args.overlap}-v1",
                            "embedding_model": "BAAI/bge-small-en-v1.5",
                            "embedding_json": embedding.tolist(),
                            "embedding_vec": "[" + ",".join(str(float(value)) for value in embedding) + "]",
                        },
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            output.flush()
            print(json.dumps({"embedded": min(start + len(batch), len(candidates)), "total": len(candidates)}), flush=True)
    args.output.chmod(0o600)
    print(json.dumps({"records": len(records), "chunks": len(candidates), "dimension": model.get_embedding_dimension(), "output": str(args.output)}))


if __name__ == "__main__":
    main()
