#!/usr/bin/env python3
"""Small, reproducible retrieval pilot for local OpenCode/Codex transcripts.

The script is development tooling only. It reads JSONL records containing
``{session_id, ordinal, role, text, synthetic}``, embeds assistant records,
and treats the next assistant response in the same session after each real
user record as a held-out relevance label.
"""

from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer


@dataclass(frozen=True)
class Record:
    installation_id: str
    source_id: str
    session_id: str
    message_id: str
    ordinal: int
    role: str
    text: str
    synthetic: bool


@dataclass(frozen=True)
class Document:
    session_id: str
    record_ordinal: int
    chunk_index: int
    text: str
    token_count: int


def load_records(filename: Path) -> list[Record]:
    records: list[Record] = []
    for line in filename.read_text(encoding="utf-8").splitlines():
        value = json.loads(line)
        text = value.get("text")
        role = value.get("role")
        if isinstance(text, str) and text.strip() and isinstance(role, str):
            records.append(
                Record(
                    str(value.get("installation_id", "")),
                    str(value.get("source_id", "")),
                    str(value.get("session_id", "default")),
                    str(value.get("message_id", f"ordinal:{len(records)}")),
                    int(value.get("ordinal", len(records))),
                    role,
                    text.strip(),
                    value.get("synthetic") is True,
                )
            )
    return records


def crop_query(text: str, tokenizer, limit: int) -> str:
    tokens = tokenizer.encode(text, add_special_tokens=False)
    if len(tokens) <= limit:
        return text
    half = max(1, limit // 2)
    return tokenizer.decode(tokens[:half] + tokens[-half:], skip_special_tokens=True)


def chunk_text(text: str, tokenizer, size: int, overlap: int) -> list[tuple[str, int]]:
    tokens = tokenizer.encode(text, add_special_tokens=False)
    if not tokens:
        return []
    step = max(1, size - overlap)
    result: list[tuple[str, int]] = []
    for start in range(0, len(tokens), step):
        window = tokens[start : start + size]
        if not window:
            break
        result.append((tokenizer.decode(window, skip_special_tokens=True).strip(), len(window)))
        if start + size >= len(tokens):
            break
    return [(text, count) for text, count in result if text]


def build_documents(records: list[Record], tokenizer, size: int, overlap: int) -> list[Document]:
    documents: list[Document] = []
    for record in records:
        if record.role != "assistant":
            continue
        for index, (text, count) in enumerate(chunk_text(record.text, tokenizer, size, overlap)):
            documents.append(Document(record.session_id, record.ordinal, index, text, count))
    return documents


def build_queries(records: list[Record], tokenizer, limit: int) -> list[tuple[str, tuple[str, int]]]:
    queries: list[tuple[str, tuple[str, int]]] = []
    for index, record in enumerate(records):
        if record.role != "user" or record.synthetic:
            continue
        next_assistant = next(
            (
                candidate
                for candidate in records[index + 1 :]
                if candidate.session_id == record.session_id and candidate.role == "assistant"
            ),
            None,
        )
        if next_assistant is not None:
            queries.append((crop_query(record.text, tokenizer, limit), (next_assistant.session_id, next_assistant.ordinal)))
    return queries


def ranking_metrics(scores: np.ndarray, queries: list[tuple[str, tuple[str, int]]], documents: list[Document]) -> dict[str, float | int]:
    if not len(queries) or not len(documents):
        return {"queries": len(queries), "documents": len(documents), "hit_at_1": 0.0, "hit_at_3": 0.0, "hit_at_5": 0.0, "mrr": 0.0}
    hits = {1: 0, 3: 0, 5: 0}
    reciprocal_ranks: list[float] = []
    for row, (_, target) in zip(scores, queries):
        order = np.argsort(-row)
        ranks = [
            position + 1
            for position, document_index in enumerate(order)
            if (documents[int(document_index)].session_id, documents[int(document_index)].record_ordinal) == target
        ]
        rank = ranks[0] if ranks else len(documents) + 1
        reciprocal_ranks.append(1.0 / rank if ranks else 0.0)
        for cutoff in hits:
            hits[cutoff] += int(rank <= cutoff)
    total = len(queries)
    return {
        "queries": total,
        "documents": len(documents),
        "hit_at_1": round(hits[1] / total, 4),
        "hit_at_3": round(hits[3] / total, 4),
        "hit_at_5": round(hits[5] / total, 4),
        "mrr": round(float(np.mean(reciprocal_ranks)), 4),
    }


def model_scores(model, documents: list[Document], queries: list[tuple[str, tuple[str, int]]], batch_size: int) -> tuple[np.ndarray, float]:
    started = time.perf_counter()
    document_embeddings = model.encode(
        [document.text for document in documents],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    query_embeddings = model.encode(
        [query for query, _ in queries],
        batch_size=batch_size,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return query_embeddings @ document_embeddings.T, round(time.perf_counter() - started, 3)


def evaluate_variant(model, documents: list[Document], queries: list[tuple[str, tuple[str, int]]], batch_size: int, size: int) -> tuple[dict[str, float | int], float, np.ndarray, list[tuple[str, tuple[str, int]]]]:
    model.max_seq_length = size
    bounded_queries = [(crop_query(query, model.tokenizer, size), target) for query, target in queries]
    scores, seconds = model_scores(model, documents, bounded_queries, batch_size)
    return ranking_metrics(scores, bounded_queries, documents), seconds, scores, bounded_queries


def minmax_rows(scores: np.ndarray) -> np.ndarray:
    low = scores.min(axis=1, keepdims=True)
    high = scores.max(axis=1, keepdims=True)
    return (scores - low) / np.maximum(high - low, 1e-9)


def evaluate_tfidf(documents: list[Document], queries: list[tuple[str, tuple[str, int]]]) -> dict[str, float | int]:
    vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1)
    document_embeddings = vectorizer.fit_transform(document.text for document in documents)
    query_embeddings = vectorizer.transform(query for query, _ in queries)
    return ranking_metrics((query_embeddings @ document_embeddings.T).toarray(), queries, documents)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--model", default="jinaai/jina-embeddings-v2-base-code")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--threads", type=int, default=16)
    parser.add_argument("--chunk-tokens", type=int, action="append")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(max(1, min(2, args.threads // 4)))
    model = SentenceTransformer(args.model, trust_remote_code=True, device="cpu")
    tokenizer = model.tokenizer
    tokenizer.model_max_length = 1_000_000
    variants = [(128, 32), (256, 48), (384, 64), (512, 64)]
    if args.chunk_tokens:
        variants = [(size, min(64, size // 4)) for size in args.chunk_tokens]
    records = load_records(args.corpus)
    queries = build_queries(records, tokenizer, 512)
    results: dict[str, object] = {
        "model": args.model,
        "embedding_dimension": model.get_embedding_dimension(),
        "records": len(records),
        "roles": {role: sum(record.role == role for record in records) for role in sorted({record.role for record in records})},
        "queries": len(queries),
        "tfidf": None,
        "variants": [],
    }
    for size, overlap in variants:
        documents = build_documents(records, tokenizer, size, overlap)
        metrics, seconds, semantic_scores, bounded_queries = evaluate_variant(model, documents, queries, args.batch_size, size)
        result = {"chunk_tokens": size, "overlap": overlap, "embedding_seconds": seconds, **metrics}
        results["variants"].append(result)
        if results["tfidf"] is None:
            lexical_vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1)
            lexical_documents = lexical_vectorizer.fit_transform(document.text for document in documents)
            lexical_queries = lexical_vectorizer.transform(query for query, _ in bounded_queries)
            lexical_scores = (lexical_queries @ lexical_documents.T).toarray()
            results["tfidf"] = {"chunk_tokens": size, "overlap": overlap, **ranking_metrics(lexical_scores, bounded_queries, documents)}
            results["hybrid"] = {
                "chunk_tokens": size,
                "overlap": overlap,
                "semantic_weight": 0.8,
                **ranking_metrics(0.8 * minmax_rows(semantic_scores) + 0.2 * minmax_rows(lexical_scores), bounded_queries, documents),
            }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
