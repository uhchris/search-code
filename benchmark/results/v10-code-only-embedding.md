# Benchmark v10: Code-Only Embedding (claude-context emulation)

**Date:** 2026-05-07
**Goal:** Test whether dropping the LLM describer phase and embedding raw code directly (matching claude-context's `chunk.content` pattern, `context.ts:935`) outperforms internal's description-based embedding for the existing benchmarks.
**Hypothesis:** raw code is the actual artifact; embedding it directly should retain code-search quality while saving 7x indexing time (no `gemma4:26b` describer call per chunk). embeddinggemma is code-aware (SOTA on MTEB(Code) <500M, arXiv:2509.20354) so should embed raw code well.
**Method:** parallel column `code_only_embedding` populated by `embed(chunk.rawCode)`; `SEMANTIC_CHANNEL=code` env var routes search through `searchByCodeOnlySimilarity`. Original `embedding` column (description-based) untouched. Reversible.

## Verdict — REVERT

Code-only embedding **loses where it matters** on every benchmark we ran. Description-based embedding (v6/v9 baseline) is the right architectural choice for internal.

## Results — full comparison

### Internal 33-case bench (internal codebase)

| Metric | v9 (description) | **v10 (code-only)** | Δ |
|--------|---|---|---|
| Recall@1 | 76% (25/33) | **58%** (19/33) | **-18pp** ❌ |
| Recall@3 | 88% (29/33) | 82% (27/33) | -6pp ❌ |
| Recall@5 | 94% (31/33) | **97%** (32/33) | +3pp ✓ |
| MRR@10 | 0.825 | 0.728 | -0.097 ❌ |
| Negative pass rate | 8/9 | **9/9** | +1 ✓ |
| Avg tokens — Semantic | 2598 | 2552 | -1.8% |

R@1 dropped 18pp. R@5 actually gained 3pp — code-only finds the right files but ranks them less precisely. Description channel helps the LLM bridge paraphrase vocabulary; raw code gets the file in the candidate set but doesn't rank it #1 as often.

### SWE-PolyBench (n=24: three.js + tailwindcss + prettier)

| Retriever | v9 (description) | **v10 (code-only)** | Δ |
|---|---|---|---|
| Semantic (direct) R@1 | 36.3% | 36.3% | = |
| Semantic (direct) R@3 | 49.2% | 49.2% | = |
| Semantic (direct) R@5 | 59.1% | 59.1% | = |
| **Semantic-agent R@1** | **49.2%** | **40.8%** | **-8.4pp** ❌ |
| Semantic-agent R@3 | 60.2% | 55.0% | -5.2pp ❌ |
| Semantic-agent R@5 | 60.2% | 55.0% | -5.2pp ❌ |
| Semantic-agent tokens | 48,107 | 41,413 | -14% (cheaper) |
| Semantic-agent turns | 8.8 | 8.5 | ~ |
| Grep-agent R@1 | 54.0% | 53.3% | ~ (control, untouched) |
| Token savings (semantic-agent vs grep) | 84% | **89%** | +5pp ✓ |

Curious result: pure-semantic R@k bucket counts are byte-identical (36.3 / 49.2 / 59.1 in both runs). Per-case rank ordering differs but bucket counts collapse to same value across 24 cases. **Agent metric is the real signal:** semantic-agent loses 8.4pp R@1, 5.2pp R@5. Code-only ranking misleads the agent into wrong picks more often than description ranking.

Token savings improved (~5pp) — code-only chunks are slightly shorter contexts. Doesn't compensate for accuracy loss.

### Duplicate detection (the original internal design goal)

| Case | v9 MRR | v10 MRR | Verdict |
|---|---|---|---|
| pluralize-duplicate | 1.00 | 1.00 | tie |
| relative-time-duplicate | 1.00 | 1.00 | tie |
| loading-state-components | 0.50 | 0.50 | tie |
| credential-encryption-duplicate | 1.00 | 1.00 | tie |

Duplicate detection works in BOTH approaches. Smoke test on the actual 3-pluralize-functions case:

```
v10 code-only:
  src/renderer/features/sidebar/utils/pluralize.ts        sim=0.649
  src/renderer/features/agents/utils/pluralize.ts         sim=0.614
  src/renderer/lib/utils/pluralize.ts                     sim=0.586
  (next non-duplicate file)                               sim=0.280   ← clean gap
```

Code-only actually has a slightly larger sim gap to non-duplicates (0.59 → 0.28 vs description's 0.55 → 0.25). For duplicate detection alone, code-only is competitive or marginally better. But that doesn't justify -8.4pp R@1 on the search-quality benchmark.

## Where code-only embedding underperforms — the why

1. **Paraphrase queries lose** — description channel encodes domain semantics in NL prose ("prevents heap exhaustion via semaphore"). Raw code has the variable names + control flow but not the *purpose*. Query "prevent JS heap exhaustion from concurrent agents" matches `bounded-execute-handler.ts` description directly; raw-code-only embedding is further away in vector space.

2. **Error symptom queries lose** — descriptions explicitly state "raises X error when Y". Raw code shows the throw site without the failure-mode context.

3. **Scattered patterns lose** — descriptions stitch together logic across multiple files into a single semantic statement. Raw code is local; can't capture cross-file intent.

4. **Indexing speedup is real** — internal reindex went from ~1hr (with describer) to ~17min (embedder-only) for 4983 chunks. That speedup is the only objective v10 win.

## Architectural conclusion

Internal and claude-context optimize for different jobs:

| Aspect | claude-context | internal |
|---|---|---|
| Primary use case | Code search (find files matching query) | Code search + semantic duplicate detection (commit-guard) |
| Embed text | `chunk.content` (raw code) | `${path} [${symbol}]: ${description}` (LLM prose) |
| Indexing cost | embedder only | embedder + describer LLM call (7x slower) |
| Bench (their reported) | F1=0.40 (SWE-bench Verified, vs grep baseline F1=0.40) | R@1=76% internal, 49.2% SWE-poly agent |
| Relative R@1 in our stack | 58% (transplanted v10) | 76% (v9) |

**Internal's LLM-description architecture is the right choice for internal's use case.** The 7x indexing cost buys 18pp R@1 on internal bench and 8.4pp R@1 on SWE-poly agent. Description embeddings cluster duplicates AND rank paraphrase/error/scattered cases better.

This does NOT prove "internal > claude-context" — we ran their *embed-text* design choice in our stack, not their full binary. They'd score differently with their default stack on a code-search-only benchmark. But within internal's stack and for internal's job, descriptions win.

## Implementation status (post-revert)

- `code_only_embedding` column populated for internal (4983 chunks) + 24 SWE-poly DBs (~13K chunks). Total embedder time spent: ~6 hours.
- v10 src changes (column, helpers, CLI flag, env hooks) being reverted.
- Column remains in schema. Future ablation experiments can use it without re-embedding.

## Lessons

- Embedding raw code (claude-context pattern) is NOT a free swap for description embedding when the latter is tuned for paraphrase / error / duplicate cases. The describer phase delivers measurable accuracy.
- Bench-driven decisions: 6 hours of indexing answered the question definitively. Cheaper than weeks of architectural debate.
- embeddinggemma handles raw code well (smoke test sims look reasonable: 0.5-0.65 for true matches, 0.28 for unrelated). The model isn't the bottleneck — the input format choice is.
- Internal bench R@1 ≠ R@5 trade tells the story: the right files are reachable from raw code (R@5 stable/up) but ranking-to-#1 needs prose descriptions.
