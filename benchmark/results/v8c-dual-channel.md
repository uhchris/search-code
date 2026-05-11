# Benchmark v8c: Dual-Channel Embeddings + RRF Fusion

**Date:** 2026-05-05
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Search:** dual-channel (description embedding + code embedding) fused via RRF (K=60). HyPE disabled. Reranker disabled.
**Change from v6 / current baseline:** Each chunk now has TWO independent embeddings — one from `${filePath} [${symbol}]: ${description}` (existing) and one from `${filePath} [${symbol}]\n${rawCode}` (new). At search time, both rankings are computed against the same query embedding and fused via RRF.

## Summary

| Metric | v6 (with HyPE, doc claim) | Description-only baseline (no HyPE) | **v8c dual-channel** | Δ vs no-HyPE baseline |
|--------|---|---|---|---|
| Recall@1 | 79% | 76% (25/33) | **64%** (21/33) | **-12pp** |
| Recall@3 | 91% | 88% (29/33) | **94%** (31/33) | **+6pp** |
| Recall@5 | 94% | 94% (31/33) | 94% (31/33) | = |
| MRR@10 | 0.846 | 0.825 | **0.778** | -0.047 |
| Negative pass rate | 8/9 | 8/9 | 8/9 | = |
| Avg tokens — Semantic | 2888 | 2598 | 2565 | -1% |

**Tradeoff: -12pp R@1, +6pp R@3, identical R@5.**

## What Improved

- **Identifier smoke test now perfect:** `useRollback hook` query returns `useRollback.ts` at #1 (sim=0.69). Description channel alone could not match identifier-style queries verbatim.
- **R@3 jumps 6pp:** code channel surfaces correct files that description alone missed in top-1. Cases that previously failed entirely (`stream-to-ui-events`, `ipc-git-events-subscription` are persistent vocabulary-gap failures) — but most "almost-found" cases now appear in top-3.
- **Paraphrase preserved on smoke test:** `prevent JS heap exhaustion from concurrent agents` still ranks `bounded-execute-handler.ts` and `runtime-gate.ts` as top results.
- **Negative pass rate unchanged:** 8/9 — code channel doesn't introduce new false positives on adversarial queries.

## What Regressed

- **R@1 drop on cases description channel previously dominated.** RRF weights both channels equally; when description channel had a clean #1 win and code channel ranked the target #5, RRF fusion demotes the target to #2 or #3. Specific cases:

| Case | v6/baseline R@1 | v8c | Note |
|---|---|---|---|
| `loading-state-components` | ✓ | ✗ R@3 (0.50) | code channel finds many similar UI files |
| `error-state-hook` | ✓ | ✗ R@3 (0.50) | many React hooks have similar code shape |
| `version-update-classifier` | ✓ | ✗ R@3 (0.50) | similar token distribution across update logic |
| `editor-dirty-guard-navigation` | ✓ | ✗ R@3 (0.50) | navigation/guard pattern shared across files |
| `git-change-notification-pipeline` | ✓ | ✗ R@3 (0.50) | git-related code is concentrated, low IDF |
| `auth-state-mismatch` | ✓ | ✗ R@3 (0.50) | auth files have similar code shape |
| `tool-permission-denied` | ✓ | ✗ R@5 (0.33) | error-handling code is repetitive |
| `unsaved-changes-guard` | partial | ✗ R@3 (0.50) | hook + UI guard split |
| `envelope-encryption` | partial | ✗ R@3 (0.33) | crypto utilities have similar code |

Pattern: code channel boosts files that share **structural code patterns** (React hooks, error handlers, crypto wrappers) even when domain differs. RRF gives this signal equal weight to description.

## Persistent Failures (vocabulary gap, not solved by either channel)

- `stream-to-ui-events`: MRR 0.00 (target file not in top-5 in any version)
- `ipc-git-events-subscription`: MRR 0.00 (renderer hooks consistently outrank IPC bridge)

Neither channel resolves these — query vocabulary is far from both description and code in the target file.

## Side Experiment: Reranker (jina-reranker-v1-turbo-en)

Tried enabling existing reranker on top of v8c results to see if it could restore R@1.

| Metric | v8c (no reranker) | v8c + reranker |
|---|---|---|
| Recall@1 | 64% | **45%** |
| Recall@3 | 94% | 82% |
| MRR@10 | 0.778 | 0.638 |

Reranker actively hurt — same root cause as v7-qwen3 / cross-encoder-base: the model was trained on QA passage pairs, not (NL query, code-description) pairs. **Disabled. Do not retry without code-trained reranker (jina-reranker-v3 or similar).**

## SWE-PolyBench (n=7: three.js + tailwindcss)

| Retriever | Prior baseline (desc-only) R@1 | **v8c R@1** | R@5 (prior → v8c) | Avg tokens |
|---|---|---|---|---|
| Semantic (direct) | 47.6% | **48.5%** (+0.9pp) | 61.9% → 61.2% | n/a |
| Semantic-agent | 48.5% | 44.9% (-3.6pp) | 61.9% → 57.7% | 6,901 → **6,153** (-11%) |
| Grep-agent | 55.6% | 55.6% (=) | 55.6% → 57.7% | 102,862 |

Token savings vs grep: **94%** (was 92%).

**`tailwindcss-853` (the original `configurePlugins.js` motivating case): STILL FAILS.** Pure semantic R@1=0.00, R@5=0.00. Code channel did not bridge the gap — issue text describes the FEATURE ("enable specific core plugins") not the IDENTIFIER (`configurePlugins`). embeddinggemma's code training helps semantics but cannot infer that a file named `configurePlugins.js` is the right match for a feature description that doesn't share any code-level vocabulary.

This confirms the vocabulary gap is not solved by adding a code-embedding channel. It needs either HyDE-style query rewriting (NL → hypothetical code stub), proper BM25 tokenization (identifier-aware FTS5), or path-based hints (filename tokens weighted higher in retrieval).

## Verdict

**Mixed result.** Not catastrophic like v8a (R@1=15%), but R@1 regressed -12pp on internal bench and -3.6pp on SWE-poly agent. Two views:

1. **For agents that retrieve top-3-5 results and reason over them**, R@3=94% (vs 88%) is a meaningful improvement — the original goal (reduce grep fallback) is served by getting the right file in the candidate set, not strictly at #1.
2. **For users / tooling that take only #1**, this is a regression.

The R@1 regression is structural to RRF: equal-weight rank fusion when one channel has higher precision per query is inherently lossy. Bruch & Gai (arXiv:2210.11934) demonstrated that **tuned convex combination outperforms RRF** in both in-domain and out-of-domain settings — RRF discards score magnitude.

## Next Direction Options

**v8c2 — weighted convex blend** (cheap, no re-embed):
```typescript
const score = α * normalizedCosine(query, descEmb) + (1-α) * normalizedCosine(query, codeEmb);
```
Tune α against bench. Likely α ≈ 0.7 (description-weighted) recovers R@1 close to 76% while keeping R@3 improvements. Implementation cost ~10 lines in `searchDualChannel`.

**v8d — HyDE for vocabulary gap** (addresses configurePlugins-class failure directly):
LLM rewrites NL query → hypothetical code stub → embed stub. Stub will likely contain identifier names like `configurePlugins`, which then matches the code embedding channel verbatim. Adds 1 LLM call per query (~1-3s latency) — gate behind config flag. Research backing: Gao et al. arXiv:2212.10692 (HyDE).

**v8e — Path-aware retrieval boost**:
Tokenize file paths (`configurePlugins.js` → `configure plugins`) and add path-token cosine score as a third channel. No LLM, no re-embed. Specifically targets cases where the file name itself describes the feature.

**Rollback**:
Revert to description-only via `git checkout c0ee81d8e -- .claude/tools/search-code/src/`. Lose identifier-query capability but restore 76% R@1 / 88% R@3 internal baseline.

## Implementation Status

- New schema column `code_embedding BLOB` (idempotent migration in `openDb`)
- `buildCodeEmbedText` helper, `searchDualChannel` RRF function, `--reembed-code-only` CLI flag
- Watcher updates both channels on file changes
- `config.json`: `hybrid.dualEmbed: true`, `hype.enabled: false`
- 4898 chunks backfilled (~35min embedder time, no LLM calls)
- HyPE infrastructure intact in DB (9796 hyp embeddings) but gated off by config
