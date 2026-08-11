#!/usr/bin/env python3
"""Run a reproducible, session-held-out retrieval benchmark.

This is development tooling, not part of the compaction request path.  It
keeps relevance labels deliberately conservative: a non-synthetic user turn
is relevant to the next assistant response in the same session, while terse
acknowledgements are excluded and counted.  Hyperparameters are selected on
training sessions and scored on held-out sessions, so a convenient one-shot
score cannot silently become the default.

The benchmark compares vector, lexical, and hybrid retrieval across models and
chunk sizes.  It emits only bounded metadata and metrics; transcript text is
never written to the report or printed to the terminal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from transformers import logging as transformers_logging

from rag_pilot import Document, Record, build_documents, crop_query, load_records


ACKNOWLEDGEMENT = re.compile(
    r"^(?:ok(?:ay)?|yes|no|continue|go ahead|do it|see|hm+|hmm+|blank|nice|cool|thanks?)(?:[,.!… ]+(?:this|that) one)?[.!…]*$",
    re.IGNORECASE,
)
CACHE_VERSION = 1


@dataclass(frozen=True)
class Query:
    session_id: str
    ordinal: int
    text: str
    target: tuple[str, int]


@dataclass(frozen=True)
class Candidate:
    model: str
    dimension: int
    chunk_tokens: int
    overlap: int
    documents: list[Document]
    semantic_scores: np.ndarray
    lexical_scores: np.ndarray
    embedding_seconds: float
    cache_hit: bool
    assistant_tokens: int
    document_tokens: int


def normalize_query(text: str) -> str:
    return " ".join(text.split())


def substantive_query_reason(record: Record) -> str | None:
    text = normalize_query(record.text)
    if record.synthetic:
        return "synthetic"
    if not text:
        return "empty"
    if ACKNOWLEDGEMENT.fullmatch(text):
        return "terse_acknowledgement"
    if len(text.split()) < 3 and "?" not in text:
        return "terse"
    return None


def build_benchmark_queries(records: list[Record]) -> tuple[list[Query], dict[str, int]]:
    by_session: dict[str, list[Record]] = {}
    for record in records:
        by_session.setdefault(record.session_id, []).append(record)
    queries: list[Query] = []
    excluded: dict[str, int] = {}
    for session_records in by_session.values():
        ordered = sorted(session_records, key=lambda record: (record.ordinal, record.message_id))
        for index, record in enumerate(ordered):
            if record.role != "user":
                continue
            reason = substantive_query_reason(record)
            if reason is not None:
                excluded[reason] = excluded.get(reason, 0) + 1
                continue
            target = next(
                (
                    candidate
                    for candidate in ordered[index + 1 :]
                    if candidate.role == "assistant"
                ),
                None,
            )
            if target is None:
                excluded["no_next_assistant"] = excluded.get("no_next_assistant", 0) + 1
                continue
            queries.append(Query(record.session_id, record.ordinal, record.text, (target.session_id, target.ordinal)))
    return queries, excluded


def stable_fold(value: str, folds: int, seed: int) -> int:
    digest = hashlib.sha256(f"{seed}:{value}".encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big") % folds


def assign_folds(queries: list[Query], requested: int, mode: str, seed: int) -> tuple[str, int, list[int]]:
    sessions = sorted({query.session_id for query in queries})
    if len(queries) < 2:
        raise ValueError("the corpus needs at least two eligible queries")
    actual_mode = mode
    if mode == "session" and len(sessions) < 2:
        actual_mode = "query"
    folds = max(2, min(requested, len(sessions) if actual_mode == "session" else len(queries)))
    keys = sessions if actual_mode == "session" else [f"{query.session_id}:{query.ordinal}" for query in queries]
    ordered_keys = sorted(set(keys), key=lambda value: (stable_fold(value, 2**31 - 1, seed), value))
    key_folds = {key: index % folds for index, key in enumerate(ordered_keys)}
    assignments = [key_folds[query.session_id if actual_mode == "session" else f"{query.session_id}:{query.ordinal}"] for query in queries]
    return actual_mode, folds, assignments


def minmax_rows(scores: np.ndarray) -> np.ndarray:
    low = scores.min(axis=1, keepdims=True)
    high = scores.max(axis=1, keepdims=True)
    return (scores - low) / np.maximum(high - low, 1e-9)


def metrics_for(scores: np.ndarray, queries: list[Query], indexes: list[int], documents: list[Document]) -> dict[str, float | int]:
    """Measure the first relevant chunk without sorting every document row.

    The previous pilot used a full argsort for every query.  This equivalent
    stable-rank calculation is linear in the document count and keeps the
    benchmark usable on a larger local corpus.  Ties follow document order,
    matching the intended deterministic ranking contract.
    """
    target_documents: dict[tuple[str, int], list[int]] = {}
    for index, document in enumerate(documents):
        target_documents.setdefault((document.session_id, document.record_ordinal), []).append(index)
    hits = {1: 0, 3: 0, 5: 0}
    reciprocal_ranks: list[float] = []
    for query_index in indexes:
        target = target_documents.get(queries[query_index].target, [])
        if not target:
            reciprocal_ranks.append(0.0)
            continue
        best = float(np.max(scores[query_index, target]))
        first_target = min(index for index in target if scores[query_index, index] == best)
        rank = 1 + int(np.count_nonzero(scores[query_index] > best))
        rank += int(np.count_nonzero(scores[query_index, :first_target] == best))
        reciprocal_ranks.append(1.0 / rank)
        for cutoff in hits:
            hits[cutoff] += int(rank <= cutoff)
    total = len(indexes)
    if not total:
        return {"queries": 0, "documents": len(documents), "hit_at_1": 0.0, "hit_at_3": 0.0, "hit_at_5": 0.0, "mrr": 0.0}
    return {
        "queries": total,
        "documents": len(documents),
        "hit_at_1": round(hits[1] / total, 4),
        "hit_at_3": round(hits[3] / total, 4),
        "hit_at_5": round(hits[5] / total, 4),
        "mrr": round(float(np.mean(reciprocal_ranks)), 4),
    }


def combine_scores(candidate: Candidate, semantic_weight: float) -> np.ndarray:
    return semantic_weight * minmax_rows(candidate.semantic_scores) + (1.0 - semantic_weight) * minmax_rows(candidate.lexical_scores)


def metric_key(metrics: dict[str, float | int], candidate: Candidate, semantic_weight: float, projected_bytes: int) -> tuple[float, float, float, float, int, int, int, float]:
    return (
        float(metrics["mrr"]),
        float(metrics["hit_at_1"]),
        float(metrics["hit_at_3"]),
        float(metrics["hit_at_5"]),
        -projected_bytes,
        -candidate.dimension,
        -candidate.chunk_tokens,
        -semantic_weight,
    )


def aggregate_metrics(values: list[dict[str, float | int]]) -> dict[str, float | int]:
    total = sum(int(value["queries"]) for value in values)
    if not total:
        return {"queries": 0, "documents": 0, "hit_at_1": 0.0, "hit_at_3": 0.0, "hit_at_5": 0.0, "mrr": 0.0}
    return {
        "queries": total,
        "documents": max(int(value["documents"]) for value in values),
        **{
            key: round(sum(float(value[key]) * int(value["queries"]) for value in values) / total, 4)
            for key in ("hit_at_1", "hit_at_3", "hit_at_5", "mrr")
        },
    }


def model_instance(name: str) -> SentenceTransformer:
    return SentenceTransformer(name, trust_remote_code=True, device="cpu")


def model_label(name: str) -> str:
    if "bge-small-en-v1.5" in name:
        return "BAAI/bge-small-en-v1.5"
    if "jina-embeddings-v2-base-code" in name:
        return "jinaai/jina-embeddings-v2-base-code"
    return name


def corpus_digest(records: list[Record]) -> str:
    digest = hashlib.sha256()
    for record in records:
        digest.update(
            json.dumps(
                [record.installation_id, record.source_id, record.session_id, record.message_id, record.ordinal, record.role, record.synthetic, len(record.text)],
                separators=(",", ":"),
            ).encode("utf-8")
        )
        digest.update(hashlib.sha256(record.text.encode("utf-8")).digest())
    return digest.hexdigest()


def cache_path(cache_dir: Path | None, model_name: str, digest: str, chunk_tokens: int, overlap: int) -> Path | None:
    if cache_dir is None:
        return None
    key = hashlib.sha256(f"{CACHE_VERSION}\n{model_name}\n{digest}\n{chunk_tokens}\n{overlap}".encode("utf-8")).hexdigest()[:24]
    return cache_dir / f"vectors-{key}.npz"


def load_cached_vectors(filename: Path, documents: list[Document], queries: list[Query], dimension: int) -> tuple[np.ndarray, np.ndarray, float] | None:
    if not filename.exists():
        return None
    try:
        with np.load(filename, allow_pickle=False) as cached:
            document_embeddings = cached["document_embeddings"]
            query_embeddings = cached["query_embeddings"]
            embedding_seconds = float(cached["embedding_seconds"])
    except (OSError, ValueError, KeyError, zipfile.BadZipFile):
        return None
    if (
        document_embeddings.shape != (len(documents), dimension)
        or query_embeddings.shape != (len(queries), dimension)
        or not np.issubdtype(document_embeddings.dtype, np.number)
        or not np.issubdtype(query_embeddings.dtype, np.number)
        or not np.isfinite(document_embeddings).all()
        or not np.isfinite(query_embeddings).all()
    ):
        return None
    return document_embeddings, query_embeddings, embedding_seconds


def save_cached_vectors(filename: Path, document_embeddings: np.ndarray, query_embeddings: np.ndarray, embedding_seconds: float) -> None:
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.parent.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{filename.name}.", suffix=".tmp.npz", dir=filename.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.chmod(0o600)
    try:
        np.savez_compressed(temporary, document_embeddings=document_embeddings, query_embeddings=query_embeddings, embedding_seconds=np.array(embedding_seconds))
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)
    filename.chmod(0o600)


def encode_candidates(
    model_name: str,
    records: list[Record],
    queries: list[Query],
    variants: list[tuple[int, int]],
    batch_size: int,
    digest: str,
    cache_dir: Path | None,
) -> tuple[list[Candidate], int, int]:
    model = model_instance(model_name)
    tokenizer = model.tokenizer
    tokenizer.model_max_length = 1_000_000
    candidates: list[Candidate] = []
    for chunk_tokens, overlap in variants:
        tokenizer.model_max_length = 1_000_000
        documents = build_documents(records, tokenizer, chunk_tokens, overlap)
        if not documents or not queries:
            continue
        bounded_queries = [crop_query(query.text, tokenizer, chunk_tokens) for query in queries]
        model.max_seq_length = chunk_tokens
        filename = cache_path(cache_dir, model_name, digest, chunk_tokens, overlap)
        cached = load_cached_vectors(filename, documents, queries, int(model.get_embedding_dimension())) if filename is not None else None
        print(json.dumps({"stage": "candidate", "model": model_label(model_name), "chunk_tokens": chunk_tokens, "documents": len(documents), "cache_hit": cached is not None}), flush=True)
        if cached is not None:
            document_embeddings, query_embeddings, embedding_seconds = cached
            cache_hit = True
        else:
            started = time.perf_counter()
            document_embeddings = model.encode(
                [document.text for document in documents],
                batch_size=batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            query_embeddings = model.encode(
                bounded_queries,
                batch_size=batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            embedding_seconds = round(time.perf_counter() - started, 3)
            cache_hit = False
            if filename is not None:
                save_cached_vectors(filename, document_embeddings, query_embeddings, embedding_seconds)
        lexical_vectorizer = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1)
        lexical_documents = lexical_vectorizer.fit_transform(document.text for document in documents)
        lexical_queries = lexical_vectorizer.transform(bounded_queries)
        candidates.append(
            Candidate(
                model_name,
                int(model.get_embedding_dimension()),
                chunk_tokens,
                overlap,
                documents,
                query_embeddings @ document_embeddings.T,
                (lexical_queries @ lexical_documents.T).toarray(),
                embedding_seconds,
                cache_hit,
                sum(
                    len(tokenizer.encode(record.text, add_special_tokens=False))
                    for record in records
                    if record.role == "assistant"
                ),
                sum(document.token_count for document in documents),
            )
        )
    return candidates, int(model.get_embedding_dimension()), len(queries)


def candidate_storage(candidate: Candidate, projected_tokens: int | None, event_bytes_per_row: int) -> dict[str, int | float | bool]:
    observed_chunks = len(candidate.documents)
    projected_chunks = observed_chunks
    if projected_tokens is not None and candidate.assistant_tokens:
        projected_chunks = max(1, math.ceil(projected_tokens * observed_chunks / candidate.assistant_tokens))
    vector_bytes = projected_chunks * candidate.dimension * 4
    event_bytes = projected_chunks * event_bytes_per_row
    total_bytes = vector_bytes + event_bytes
    return {
        "projected_chunks": projected_chunks,
        "vector_bytes": vector_bytes,
        "event_bytes": event_bytes,
        "total_bytes": total_bytes,
        "total_gib": round(total_bytes / (1024**3), 4),
        "budget_passed": total_bytes <= 100 * 1024**3,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model", action="append", help="model name or local path; repeat to compare candidates")
    parser.add_argument("--chunk-tokens", type=int, action="append", help="chunk size; repeat to compare sizes")
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--threads", type=int, default=16)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--split", choices=("session", "query"), default="session")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--semantic-weight", type=float, action="append", help="hybrid weight; repeat to tune")
    parser.add_argument("--reference-weight", type=float, default=0.8, help="fixed hybrid weight reported for cross-candidate comparison")
    parser.add_argument("--reference-chunk-tokens", type=int, default=512, help="BGE-small chunk size used by the baseline reference")
    parser.add_argument("--projected-tokens", type=int, help="measured full-source assistant-token estimate")
    parser.add_argument("--event-bytes-per-row", type=int, default=8192)
    parser.add_argument("--cache-dir", type=Path, help="mode-0600 vector cache directory for resumable runs")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.threads < 1 or args.batch_size < 1:
        raise SystemExit("--threads and --batch-size must be positive")
    if args.event_bytes_per_row < 0:
        raise SystemExit("--event-bytes-per-row cannot be negative")
    if args.reference_chunk_tokens < 1:
        raise SystemExit("--reference-chunk-tokens must be positive")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(max(1, min(2, args.threads // 4)))
    records = load_records(args.corpus)
    digest = corpus_digest(records)
    queries, excluded = build_benchmark_queries(records)
    models = args.model or ["BAAI/bge-small-en-v1.5", "jinaai/jina-embeddings-v2-base-code"]
    sizes = args.chunk_tokens or [128, 256, 384, 512]
    variants = [(size, min(64, size // 4)) for size in sizes]
    weights = args.semantic_weight or [round(value / 10, 1) for value in range(0, 11)]
    if any(weight < 0 or weight > 1 for weight in weights):
        raise SystemExit("--semantic-weight values must be between 0 and 1")
    if not 0 <= args.reference_weight <= 1:
        raise SystemExit("--reference-weight must be between 0 and 1")
    transformers_logging.set_verbosity_error()
    if len(queries) < 2:
        raise SystemExit("the corpus needs at least two eligible queries")
    split_mode, fold_count, assignments = assign_folds(queries, args.folds, args.split, args.seed)
    all_candidates: list[Candidate] = []
    dimensions: dict[str, int] = {}
    query_count = len(queries)
    for model_name in models:
        candidates, dimension, _ = encode_candidates(model_name, records, queries, variants, args.batch_size, digest, args.cache_dir)
        all_candidates.extend(candidates)
        dimensions[model_name] = dimension
    if not all_candidates:
        raise SystemExit("no model/chunk candidate produced documents")
    storage = {
        f"{candidate.model}:{candidate.chunk_tokens}": candidate_storage(candidate, args.projected_tokens, args.event_bytes_per_row)
        for candidate in all_candidates
    }
    folds: list[dict[str, object]] = []
    for fold in range(fold_count):
        train_indexes = [index for index, assignment in enumerate(assignments) if assignment != fold]
        test_indexes = [index for index, assignment in enumerate(assignments) if assignment == fold]
        if not train_indexes or not test_indexes:
            continue
        eligible: list[tuple[tuple[float, float, float, float, int, int, int, float], Candidate, float, dict[str, float | int], int]] = []
        for candidate in all_candidates:
            candidate_storage_bytes = int(storage[f"{candidate.model}:{candidate.chunk_tokens}"]["total_bytes"])
            if not bool(storage[f"{candidate.model}:{candidate.chunk_tokens}"]["budget_passed"]):
                continue
            for weight in weights:
                scores = combine_scores(candidate, weight)
                train_metrics = metrics_for(scores, queries, train_indexes, candidate.documents)
                eligible.append((metric_key(train_metrics, candidate, weight, candidate_storage_bytes), candidate, weight, train_metrics, candidate_storage_bytes))
        if not eligible:
            raise SystemExit("all candidates exceed the 100 GiB storage gate")
        _key, selected, weight, train_metrics, _bytes = max(eligible, key=lambda item: item[0])
        selected_scores = combine_scores(selected, weight)
        selected_test = metrics_for(selected_scores, queries, test_indexes, selected.documents)
        holdout_sessions = sorted({queries[index].session_id for index in test_indexes})
        folds.append(
            {
                "fold": fold,
                "holdout_sessions": holdout_sessions,
                "train_queries": len(train_indexes),
                "test_queries": len(test_indexes),
                "selected": {"model": selected.model, "model_label": model_label(selected.model), "dimension": selected.dimension, "chunk_tokens": selected.chunk_tokens, "overlap": selected.overlap, "semantic_weight": weight},
                "train_metrics": train_metrics,
                "test_metrics": selected_test,
            }
        )
    selected_metrics = aggregate_metrics([fold["test_metrics"] for fold in folds])
    reference_evaluations: list[dict[str, object]] = []
    for candidate in all_candidates:
        if not bool(storage[f"{candidate.model}:{candidate.chunk_tokens}"]["budget_passed"]):
            continue
        for weight in (0.0, args.reference_weight, 1.0):
            scores = combine_scores(candidate, weight)
            values = [
                metrics_for(scores, queries, [index for index, assignment in enumerate(assignments) if assignment == fold], candidate.documents)
                for fold in range(fold_count)
                if any(assignment == fold for assignment in assignments)
            ]
            reference_evaluations.append(
                {
                    "model": candidate.model,
                    "model_label": model_label(candidate.model),
                    "dimension": candidate.dimension,
                    "chunk_tokens": candidate.chunk_tokens,
                    "overlap": candidate.overlap,
                    "semantic_weight": weight,
                    "metrics": aggregate_metrics(values),
                    "storage": storage[f"{candidate.model}:{candidate.chunk_tokens}"],
                }
            )
    baseline_key = next((candidate for candidate in all_candidates if model_label(candidate.model) == "BAAI/bge-small-en-v1.5" and candidate.chunk_tokens == args.reference_chunk_tokens), None)
    baseline_folds: list[dict[str, float | int]] = []
    if baseline_key is not None:
        baseline_scores = combine_scores(baseline_key, args.reference_weight)
        baseline_folds = [metrics_for(baseline_scores, queries, [index for index, assignment in enumerate(assignments) if assignment == fold], baseline_key.documents) for fold in range(fold_count) if any(assignment == fold for assignment in assignments)]
    candidate_metadata = [
        {
            "model": candidate.model,
            "model_label": model_label(candidate.model),
            "dimension": candidate.dimension,
            "chunk_tokens": candidate.chunk_tokens,
            "overlap": candidate.overlap,
            "documents": len(candidate.documents),
            "document_tokens_including_overlap": candidate.document_tokens,
            "embedding_seconds": candidate.embedding_seconds,
            "cache_hit": candidate.cache_hit,
            "storage": storage[f"{candidate.model}:{candidate.chunk_tokens}"],
        }
        for candidate in all_candidates
    ]
    result = {
        "benchmark_version": 2,
        "protocol": "next-assistant relevance; session-held-out tuning; vector/TF-IDF row-normalized hybrid",
        "corpus": str(args.corpus),
        "corpus_digest": digest,
        "records": len(records),
        "sessions": len({record.session_id for record in records}),
        "models": models,
        "dimensions": dimensions,
        "chunk_variants": variants,
        "semantic_weights": weights,
        "reference_weight": args.reference_weight,
        "reference_chunk_tokens": args.reference_chunk_tokens,
        "query_filter": {"eligible": query_count, "excluded": excluded},
        "split": {"requested": args.split, "used": split_mode, "folds": fold_count, "seed": args.seed},
        "candidates": candidate_metadata,
        "selected_test_metrics": selected_metrics,
        "reference_evaluations": reference_evaluations,
        "baseline_reference_metrics": aggregate_metrics(baseline_folds) if baseline_folds else None,
        "folds": folds,
        "storage_gate": {"budget_gib": 100, "event_bytes_per_row": args.event_bytes_per_row, "projected_tokens": args.projected_tokens, "all_candidates_pass": all(bool(item["storage"]["budget_passed"]) for item in candidate_metadata)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    args.output.chmod(0o600)
    print(json.dumps({"output": str(args.output), "eligible_queries": query_count, "selected_test_metrics": selected_metrics, "baseline": result["baseline_reference_metrics"]}, indent=2))


if __name__ == "__main__":
    main()
