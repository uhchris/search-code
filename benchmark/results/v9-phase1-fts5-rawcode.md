# Benchmark v9 Phase 1: FTS5 BM25 over rawCode (AND-join) + RRF

**Date:** 2026-05-05
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Search:** dense (description) + sparse FTS5 BM25 (rawCode), fused via RRF K=60. AND-join on FTS5 query. HyPE OFF. Reranker OFF.
**Change from v6 baseline:** Wired the pre-existing dead `searchHybrid` (store.ts:578-641) to the search path. Added a parallel FTS5 table `chunks_code_fts` over rawCode (existing `chunks_fts` over description retained for ablation but unused in hybrid path). Switched `toFts5Query` from OR-join to AND-join (the v8a OR-join lesson confirmed: rawCode-FTS with OR pollutes via common code keywords).

## Summary

| Metric | v6 baseline (desc-only) | **v9 Phase 1** | Δ |
|--------|---|---|---|
| Recall@1 | 76% (25/33) | **76% (25/33)** | = |
| Recall@3 | 88% (29/33) | **88% (29/33)** | = |
| Recall@5 | 94% (31/33) | **94% (31/33)** | = |
| MRR@10 | 0.825 | **0.825** | = |
| Negative pass rate | 8/9 | 8/9 | = |
| Avg tokens — Semantic | 2598 | 2598 | = |

**Internal bench: zero regression, zero gain.** The AND-join in `toFts5Query` keeps BM25 from polluting the description-channel ranking. Most NL paraphrase queries get `[]` from BM25 (terms don't all appear in the same chunk's rawCode) and fall through to pure dense. RRF effectively reduces to dense-only when BM25 returns nothing.

## SWE-PolyBench (n=7: three.js + tailwindcss)

| Retriever | Baseline R@1 | **v9 R@1** | Baseline R@5 | **v9 R@5** |
|---|---|---|---|---|
| Semantic (direct) | 47.6% | **48.5%** (+0.9pp) | 61.9% | 61.2% (-0.7pp) |

Roughly flat — within noise. tailwindcss-853 (`configurePlugins.js`) **still fails R@1=0.00, R@5=0.00**.

### Why tailwindcss-853 didn't improve

SWE-poly query is the GitHub issue body (long prose). Smoke test query "ability to only enable specific core plugins" finds `configurePlugins.js` at R@2 (sim=0.45) — proving the data is reachable. But the actual issue text is longer / different, and AND-join requires ALL query terms ≥3 chars to appear in the same chunk's rawCode. The full issue body has many tokens that don't appear in `configurePlugins.js`'s 9-line body, so BM25 returns `[]` and we fall back to pure dense (which already failed).

## Why Phase 1 Was Expected to Hit a Ceiling

`porter unicode61` tokenizer does NOT split camelCase. It treats `configurePlugins` as a single token. NL queries describe the FEATURE, not the camelCase identifier — so BM25 has nothing to match. Phase 1's value: confirms zero-regression of the hybrid wiring + RRF fusion at v6 quality.

## Implementation

- `src/store.ts` — added `chunks_code_fts` table to SCHEMA + maintenance in upsert/delete paths + `searchByCodeBm25` + rewrote `searchHybrid` to call `searchByCodeBm25` (ditched description-FTS BM25). Switched `toFts5Query` from OR-join to AND-join. Kept legacy `searchByBm25` (description-FTS) exported for ablation.
- `src/search.ts` — added `isHybridEnabled()` reading `config.hybrid.enabled`, routes through `searchHybrid` when enabled.
- `src/index.ts` — added `--rebuild-code-fts` CLI flag for one-time backfill (~1s for 5000 chunks).
- `config.json` — `"hybrid": { "enabled": true }`.
- DB migration: idempotent — `chunks_code_fts` virtual table created on `openDb` via `CREATE TABLE IF NOT EXISTS`. Backfill via `--rebuild-code-fts`.

## Decision

Per plan trigger ("Phase 2 only if Phase 1 internal R@1 < 76% OR tailwindcss-853 still 0.00"): **proceed to Phase 2** (MiniSearch with code-aware tokenizer that splits camelCase/snake_case). Phase 1 is committed as a safe checkpoint — zero regression — so Phase 2 has a clean rollback target.

## Rollback

```bash
git checkout 8bf195858 -- .claude/tools/search-code/src/ .claude/tools/search-code/config.json
sqlite3 .search-code/index.db "DROP TABLE chunks_code_fts;"
```
