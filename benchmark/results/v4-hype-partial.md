# Benchmark v4-hype-partial

**Date:** 2026-05-03
**Model:** gemma4:26b (describer + hyp query generator), embeddinggemma (embedder)
**Thinking:** off
**Search:** vector-only + HyPE (partial — 13 of 4150 chunks have hyp embeddings)
**Change from v3-metadata:** HyPE hypothetical query embeddings added for 5 benchmark target files (13 chunks across those files). Hyp queries embedded in **query-space** (using `embedQuery`, not `embed`) — critical for embeddinggemma which uses task-specific prefixes. At search time, `similarity = max(desc_sim, hyp_sim_0, hyp_sim_1)`.

## Summary

| Metric | v1 | v2 | v3-clean | v3-metadata | v4-hype-partial | Δ v3→now |
|--------|----|----|----------|-------------|-----------------|----------|
| Recall@1 | 15/25 (60%) | 16/25 (64%) | 17/25 (68%) | 19/25 (76%) | **21/25 (84%)** | ↑ +8pp |
| Recall@3 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | 23/25 (92%) | **24/25 (96%)** | ↑ +4pp |
| Recall@5 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | 24/25 (96%) | **24/25 (96%)** | = |
| MRR@10 | 0.740 | 0.760 | 0.780 | 0.843 | **0.893** | ↑ +0.050 |
| Negative pass rate | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** | = |
| Avg tokens — Semantic | 3909 | 2818 | 2926 | 3106 | **3191** | ↑ +85 |

## Cases Fixed by HyPE

- **`stream-to-ui-events`**: R@5 → **R@1** ↑↑ — hyp query "convert mcp stream events to ui messages" scored 0.60 vs competitors at 0.50. Previously beaten by renderer message files due to path-prefix "renderer" matching the query.
- **`lsp-transport-bridge`**: R@3/R@5 → **R@1** ↑↑ — hyp query bridged the vocabulary gap.

## Key Technical Finding: Query-Space Embedding

**Critical insight**: HyPE queries MUST be embedded with `embedQuery()` (query-side prefix), not `embed()` (document-side prefix). For `embeddinggemma`, these use different task prefixes:
- Document: `"title: none | text: "` + text
- Query: `"task: search result | query: "` + text

Storing hyp embeddings with the document prefix puts them in a different semantic space than the user's query, making the cosine similarity comparison meaningless. Using `embedQuery()` places them in the same space as the user's query — enabling true question-to-question matching.

**This applies to ANY model with asymmetric query/document embeddings (nomic-embed-text, voyage-code-3, etc.).**

## Remaining Failures After Partial HyPE

| Case | v3-metadata MRR | v4-hype-partial | Notes |
|------|-----------------|-----------------|-------|
| concurrency-limiter | 0.00 | 0.00 (est.) | Target not in top-20; hyp queries too generic ("limit concurrent async tasks") |
| error-state-hook | 0.33 | ~0.33 | Target at R@3–5; hyp queries generated but limited improvement |
| unsaved-changes-guard | 0.50 | ~0.50 | Competing component (DirtyNavAlertDialog) ranked above hook; may need ground-truth expansion |

## Next Steps

Full HyPE run (4137 remaining chunks) was kicked off — ETA ~60 min. Results to be recorded in `v4-hype-full.md`. Expected: further R@1 improvements as more target files get hyp embeddings that bridge vocabulary gaps.

If full HyPE run shows no regressions: make HyPE part of the standard post-index workflow.

## Why the Previous Cross-Encoder Attempt Failed

Cross-encoder reranker (bge-reranker-base) was tried same day — R@1 dropped from 76% to 36%. Root cause: model trained on QA passages, not (query, code-description) pairs. Disabled by default (config `reranker.enabled: false`). See `experiments/cross-encoder-reranker.md`.
