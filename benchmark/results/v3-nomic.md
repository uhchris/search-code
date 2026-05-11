# Benchmark v3-nomic

**Date:** 2026-05-03
**Model:** gemma4:26b (describer), nomic-embed-text (embedder)
**Thinking:** off
**Search:** vector-only
**Change from v3-clean:** Swapped embedder from embeddinggemma to nomic-embed-text

## Summary

| Metric | Score | vs v3-clean |
|--------|-------|-------------|
| Recall@1 | 17/25 (68%) | = |
| Recall@3 | 22/25 (88%) | = |
| Recall@5 | 22/25 (88%) | = |
| MRR@10 | 0.780 | = |
| Negative pass rate | 5/5 (100%) | = |
| Avg tokens — Semantic | 2940 | ≈ |

## Key Findings

- **Zero difference from embeddinggemma across all 30 cases.** Every R@1/R@3/R@5/MRR value and similarity score is identical.
- Confirms the model is not the bottleneck. Both models embed natural-language descriptions with equivalent quality.
- Vocabulary gap failures (`concurrency-limiter`, `git-diff-splitter`, `error-state-hook`) persist — these are description-level failures, not embedding-model failures.
- nomic-embed-text kept in config (identical performance, already embedded, no re-index needed for next step).
- **Decision:** model swap is not a useful lever for this system. Next experiments should target description quality (HyPE, metadata enrichment) not embedding model selection.

## Also tested: nomic-embed-text-code (REGRESSED)

Subsequent test of `nomic-embed-text-code` (the code-specific variant) showed **scores went DOWN** vs embeddinggemma / nomic-embed-text. Counterintuitive, but consistent with: our document corpus is LLM-generated NL descriptions, not raw code. A code-specialised embedder under-performs on prose-heavy documents. embeddinggemma is already SOTA on MTEB(Code) <500M params (arXiv:2509.20354) AND handles prose — no reason to swap.

**Do not retry `nomic-embed-text-code` or other code-specialised embedders for the description channel.** Use them only if/when a separate raw-code retrieval channel is added.
