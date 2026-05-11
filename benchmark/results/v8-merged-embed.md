# Benchmark v8: Merged Description + RawCode Embedding — FAILED

**Date:** 2026-05-05
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Search:** vector-only, HyPE enabled (473 chunks)
**Change from v6:** embed text changed from `${filePath} [${symbol}]: ${description}` to `${filePath} [${symbol}]: ${description}\n${rawCode}` (rawCode capped at 6000 chars)
**Verdict:** Catastrophic regression. Reverted.

## Summary

| Metric | v6 baseline | **v8 merged** | Δ |
|--------|------------|---------------|---|
| Recall@1 | 79% | **15%** (5/33) | **-64pp** |
| Recall@3 | 91% | **21%** (7/33) | -70pp |
| Recall@5 | 94% | **21%** (7/33) | -73pp |
| MRR@10 | 0.846 | **0.182** | -0.664 |
| Negative pass rate | 8/9 | 8/9 | = |
| Avg tokens — Semantic | 2888 | 4441 | +54% (longer descriptions don't help) |

## Why It Failed

Adding raw code to the embed text dilutes the description signal across the board. The vector space shifts toward code-syntax similarity (function names, types, keywords, brackets) and away from problem-domain semantics. Symptoms:

- **Even cases v6 nailed at 1.00 dropped to 0.00:** `concurrency-limiter`, `terminal-buffering`, `editor-dirty-guard-navigation`, `error-state-hook`, `truncate-scatter`, `pluralize-duplicate`, `pkce-verifier-lookup`, `auth-state-mismatch`
- **High top-1 similarity but wrong file:** `pkce-verifier-lookup` showed sim=0.91 on top result (very high) but target wasn't in top-5 — code-token similarity ranks generic crypto/auth code above the actual PKCE verifier
- **Paraphrase queries hit hardest:** queries are NL prose, but documents are now ~80% code tokens — semantic match collapses
- **Negative pass rate held:** 8/9 unchanged, suggesting the hit was on positive cases, not generic noise

## Per-Case Comparison (selected)

| Case | v6 MRR | v8 MRR | Δ |
|---|---|---|---|
| concurrency-limiter | 1.00 | 0.00 | ↓↓ |
| terminal-buffering | 1.00 | 0.00 | ↓↓ |
| pluralize-duplicate | 1.00 | 0.00 | ↓↓ |
| chat-name-needle | 1.00 | 1.00 | = |
| retry-with-jitter | 1.00 | 1.00 | = |
| credential-blob-corrupt | 1.00 | 1.00 | = |
| pkce-verifier-lookup | 1.00 | 0.00 | ↓↓ |
| editor-dirty-guard-navigation | 1.00 | 0.00 | ↓↓ |
| envelope-encryption | 0.25 | 0.00 | ↓ |
| stream-to-ui-events | 0.00 | 0.00 | = |

The 4 cases that survived (`chat-name-needle`, `retry-with-jitter`, `credential-blob-corrupt`, `flow-step-remote-execution`, `credential-encryption-duplicate`) all have query vocabulary that overlaps directly with both the description AND code-level identifiers — the merged signal didn't shift them out of top-1.

## Root Cause

embeddingGemma is a sentence-level embedder trained on prose. When ~80% of the input is code, the resulting embedding is dominated by the lexical structure of TypeScript syntax. Two unrelated functions both containing `import`, `const`, `=>`, `interface` produce embeddings that are closer to each other than to a prose query about the *purpose* of either function.

Validated approaches (claude-context, SocratiCode) embed raw code without descriptions — they rely on the embedder's code-trained variant or include filepath as a coarse domain hint. Frink's stack uses a prose-trained embedder, so prose descriptions are the only effective signal.

## Implementation Status

- `buildEmbedText` reverted to description-only. Code retained as helper for single source of truth across 4 callsites.
- `clearAllEmbeddings()` and `--reembed-only` CLI flag retained — useful infrastructure regardless.
- Re-embedded 4898 chunks against description-only baseline.

## Post-Revert Verification

After reverting `buildEmbedText` to description-only and re-embedding all 4898 chunks:

| Metric | v6 doc (with HyPE) | Post-revert no-HyPE | **Post-revert with HyPE** |
|---|---|---|---|
| Recall@1 | 79% | **76%** (25/33) | **27%** (9/33) |
| Recall@3 | 91% | 88% (29/33) | 70% (23/33) |
| Recall@5 | 94% | 94% (31/33) | 76% (25/33) |
| MRR@10 | 0.846 | 0.825 | 0.475 |
| Negative pass rate | 8/9 | 8/9 | **4/9** |
| Avg tokens — Semantic | 2888 | 2598 | 2544 |

**Two findings:**

1. **v8a regression fully reversed.** Description-only baseline (no HyPE) restores R@1 to 76% (within 3pp of v6 doc's 79% claim). The catastrophic v8a R@1=15% is gone.

2. **HyPE in current state actively hurts** (76% → 27% R@1). This is a NEW regression vs v6 documentation. Possible causes:
   - gemma4:26b model version drift (`describer.ts` prompts unchanged but model behavior may differ)
   - HyPE search-path: `searchBySimilarity` takes `max(cosine(query, chunk_emb), max(cosine(query, hyp_emb)))` — generic hyp queries ("how does this work?") boost wrong files via false high scores
   - Negative pass rate dropping from 8/9 → 4/9 confirms hyp embeddings boosting unrelated files

   HyPE infrastructure intact in DB (4898 chunks × 2 queries = 9796 hyp embeddings). Disable via search-path config flag if needed, or design v8c to fix HyPE quality / weighting.

## Current Active Baseline

**Description-only embedding, HyPE present in DB but degrading results.**

For real-world use: temporarily set `chunk_hyp_embeddings` to be ignored at search time (config flag — not yet implemented), OR clear hyp_embeddings and accept R@1=76% as the active baseline, OR investigate HyPE regression as next direction.

## Implications for Future v8 Direction

- **DO NOT** add raw code to a single-vector embedding with a prose embedder. Confirmed catastrophic.
- **Possible next direction**: dual embeddings per chunk (`description_embedding` + `code_embedding`) + max-similarity at search time — preserves the prose signal, adds code as a secondary channel.
- **Or**: switch to a code-trained embedder (jina-code-v2, voyage-code-3) that handles both natively. Major dependency change.
- **Or**: improve description quality (better prompts, longer outputs) to handle the v6 hard cases (`stream-to-ui-events`, `envelope-encryption`, `ipc-git-events-subscription`) without changing retrieval architecture.
