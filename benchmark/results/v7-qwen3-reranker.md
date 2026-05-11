# Benchmark v7-qwen3-reranker

**Date:** 2026-05-04
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Thinking:** off
**Search:** vector + Qwen3-Reranker-8B (chat-based batched scoring)
**Changes from v6:** Reranker enabled — `dengcao/Qwen3-Reranker-8B:Q3_K_M` via Ollama `/api/chat`

## Result: FAILED — Do Not Use

**R@1 dropped from 79% → 36%. MRR dropped from 0.846 → 0.403. Reranker disabled.**

| Metric | v6-dedup | v7-qwen3 | Δ |
|--------|----------|----------|---|
| Recall@1 | 79% | **36%** | -43pp |
| Recall@3 | 91% | **42%** | -49pp |
| Recall@5 | 94% | **48%** | -46pp |
| MRR@10 | 0.846 | **0.403** | -0.443 |
| Negative pass rate | 8/9 | **6/9** | -2 |

## Root Cause

Qwen3-Reranker is a **generative reranker** that uses yes/no token logprobs internally. It is not designed to output JSON score arrays via a chat interface. When prompted via `/api/chat` with "output a JSON array of 0.0–1.0 scores":

1. **Ordinal integer output**: The model outputs `[9, 8, 7, 6, 5, 4, 3, 2, 1, 0]` instead of fractional relevance scores. The regex `/\[[\d.,\s]+\]/` matches these as valid JSON, so the fallback never triggers. All results get ordinal ranks as "relevance scores", completely destroying vector order.

2. **Hallucinated explanations**: For some queries the model outputs narrative text explaining the scoring instead of a JSON array ("the first score is the probability that..."). These trigger the fallback to vector-only, which is why a minority of cases still pass.

3. **Negative case failures**: `sim=9.00` values (ordinal rank 9) far exceed the 0.5 threshold, causing false positives on `negative-docker-config`, `negative-near-miss-docker-compose`, `negative-near-miss-websocket-multiplexing`.

## Observed Output Examples

Failure mode 1 (ordinal, looks valid):
> Model outputs `[9, 8, 7, 6, 5, 4, 3, 2, 1, 0]` — regex parses as valid, ordinal re-ranking applied.

Failure mode 2 (narrative, triggers fallback):
> "the first score is the probability that the description is for the function named in the query, and..."

## Technical Context

Qwen3-Reranker is architecturally a sequence-to-sequence model that computes P("yes") / (P("yes") + P("no")) from the final token logprobs. This mechanism is not accessible via Ollama's `/api/chat` endpoint — Ollama does not expose per-token logprob output. The model defaults to instruction-following behavior when used as a chat model, which produces inconsistent and unreliable scoring.

**Ollama `/api/rerank` does not exist** (404 on v0.22.1). This is the blocking technical constraint.

## What Would Actually Work

Cross-encoder rerankers that run as ONNX inference (no logprob dependency) — see `experiments/cross-encoder-reranker.md`:
- `jina-reranker-v3`: 63.28 CoIR NDCG@10, ~280MB ONNX, runs via `@huggingface/transformers`
- `bge-reranker-v2-m3`: 278M params, returns proper scalar scores from feed-forward head
- Both run locally as ONNX without requiring logprob API access

## Per-Case Results (selected — all cases degraded or flat vs v6)

Cases that REGRESSED from v6 due to ordinal re-ranking:
- `terminal-buffering`: 1.00 → 0.00
- `version-update-classifier`: 1.00 → 0.00
- `concurrency-limiter`: 1.00 → 0.00
- `mcp-eager-load`: 1.00 → 0.00
- `auth-state-mismatch`: 1.00 → 0.00
- `credential-blob-corrupt`: 1.00 → 0.00
- `agent-execution-timeout`: 1.00 → 0.00
- `tool-permission-denied`: 1.00 → 0.00
- `pkce-verifier-lookup`: 1.00 → 0.00
- `mcp-boot-prefetch`: 1.00 → 0.00
- `flow-step-remote-execution`: 1.00 → 0.00
- `mcp-oauth-and-tools`: 1.00 → 0.00
- `git-ipc-subscription`: 1.00 → 1.00 (one of the few that held — reranker may have fallen back)

Cases that passed (reranker fell back to vector-only):
- `pluralize-duplicate`, `relative-time-duplicate`, `chat-name-needle`: 1.00 (fallback to vector)
- `truncate-scatter`, `error-state-hook`: 1.00 (explicit "score count mismatch" fallback)
- `retry-with-jitter`: 1.00 (no score mismatch logged, vector likely matched perfectly)

## Conclusion

**The chat-based Qwen3 reranker approach is not viable.** The model cannot reliably output calibrated 0.0–1.0 probability scores via text generation. Reverting to v6 (vector-only + codeHash dedup) as baseline.

Next experiment: jina-reranker-v3 via ONNX (`@huggingface/transformers`) — see `experiments/cross-encoder-reranker.md`.
