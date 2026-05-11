# Benchmark v9 Phase 2: MiniSearch BM25 with Code-Aware Tokenizer + RRF

**Date:** 2026-05-05
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Search:** dense (description) + sparse MiniSearch BM25 (rawCode + filePath + symbolName), fused via RRF K=60. AND-combine on query terms. Tokenizer emits original token + camelCase/snake_case/acronym-run split components. HyPE OFF. Reranker OFF.
**Change from Phase 1:** Replaced FTS5 BM25 over rawCode with MiniSearch BM25. Code-aware tokenizer splits `configurePlugins` into `configurePlugins` (original) + `configure`, `plugins` (components). FTS5's `porter unicode61` could not split camelCase.

## Summary

| Metric | v6 baseline | Phase 1 (FTS5) | **Phase 2 (MiniSearch)** | Δ vs Phase 1 |
|--------|---|---|---|---|
| Recall@1 | 76% | 76% | **76%** (25/33) | = |
| Recall@3 | 88% | 88% | **88%** | = |
| Recall@5 | 94% | 94% | **94%** | = |
| MRR@10 | 0.825 | 0.825 | **0.825** | = |
| Negative pass rate | 8/9 | 8/9 | 8/9 | = |
| Avg tokens — Semantic | 2598 | 2598 | 2598 | = |

**Internal bench: identical to Phase 1.** AND-combine + IDF protection means BM25 either returns the right hit or nothing — never pollutes. Both Phase 1 (FTS5+AND) and Phase 2 (MiniSearch+AND) converge to the same effective behavior on this benchmark.

## SWE-PolyBench (n=7)

| Retriever | Baseline | **v9 Phase 2** |
|---|---|---|
| Semantic R@1 | 47.6% | **48.5%** (+0.9pp) |
| Semantic R@5 | 61.9% | 61.2% (-0.7pp) |

Same as Phase 1. tailwindcss-853 (`configurePlugins.js`) **still fails** R@1=0.00, R@5=0.00.

### Why code-aware tokenizer didn't fix tailwindcss-853

The SWE-poly query is the GitHub issue body — long prose with dozens of tokens. AND-combine requires ALL query terms to appear in the matched chunk's rawCode. The 9-line `configurePlugins.js` body doesn't contain most issue-body tokens (build pipeline, framework, runtime, etc.). BM25 returns `[]`, falls back to pure dense which already failed.

The smoke query "ability to only enable specific core plugins" (short, identifier-component words) DOES find `configurePlugins.js` at R@2 (sim=0.45) — confirming the data is reachable when the query is precise. But the SWE-poly bench uses raw issue text.

Bridging that gap requires query rewriting (HyDE-style: NL → identifier-extraction prompt), not better tokenization. Out of scope for v9.

### Initial OR-combine attempt (REGRESSED, reverted to AND)

First Phase 2 run used MiniSearch's `combineWith: 'OR'` — same trap as v8a:

| Metric | OR-combine | AND-combine |
|---|---|---|
| R@1 | 48% (16/33) | 76% (25/33) |
| MRR | 0.529 | 0.825 |

OR-combine on a code-aware tokenizer that emits original + split tokens means EVERY query word matches dozens of chunks via component overlap. Even MiniSearch's IDF can't fully compensate when (a) common code keywords like `function`/`const` appear as both originals and split components, and (b) descriptive English words ("update", "render", "handler") appear as components of many camelCase identifiers. AND-combine fixes by requiring all query tokens present.

## Implementation

- `src/bm25.ts` — NEW MiniSearch wrapper:
  - `codeTokenizer`: splits `[^\w$]+`, emits `[original, ...split]` per term where split applies camelCase/snake_case/acronym-run regex
  - JSON persistence with versioned envelope `{ version: 1, tokenizerVersion: 'v1', index }` — stale-format detection logs warning + ignores
  - Atomic writes via `tmp + rename`
  - `replaceChunk(doc)` = `discard(id) + add(doc)` (explicit, sidesteps any v7 `replace()` API drift)
  - `loadOrCreate()` returns empty index if file missing — caller checks `documentCount === 0`
- `src/store.ts` — `searchHybrid` now accepts an injectable `Bm25Source` callback. Default = FTS5 `searchByCodeBm25`. Search.ts passes `bm25.search` when `engine: minisearch`. Added `getAllForBm25()` helper.
- `src/search.ts` — config selects engine. `engine: 'fts5'` (default) or `'minisearch'`. Empty MiniSearch index logs warning once.
- `src/index.ts` — `--rebuild-bm25` CLI flag. Builds MiniSearch index from existing chunks (~1s for 5000 chunks).
- `src/watcher.ts` — incremental: `bm25.replaceChunk` per chunk, `bm25.persist()` once per file change (not per chunk — avoids serialization thrash).
- `package.json` — added `minisearch ^7.2.0`.
- `config.json` — `"hybrid": { "enabled": true, "engine": "minisearch" }`.
- BM25 index path: `dirname(dbPath)/{dbBaseName}.bm25.json` — paired per-DB (fixes multi-DB SWE-poly collision bug discovered during backfill).

### File sizes

- frink (4898 chunks): 5.6MB JSON
- three.js largest (1861 chunks): ~2MB
- tailwindcss avg (97 chunks): ~150KB

Acceptable. JSON file lives next to the SQLite DB, gitignored alongside it.

## Verdict

**Phase 2 is functionally equivalent to Phase 1 on the current benchmarks.** Both deliver zero regression vs v6 baseline. Neither fixes tailwindcss-853 because the issue body is too verbose for AND-combine and porter-tokenized rawCode is irrelevant when query terms span prose unrelated to identifier components.

Phase 2 has architectural value for future tuning:
- MiniSearch supports fuzzy, prefix, per-field boosts, custom scoring — none used in v9 but available
- claude-context and SocratiCode both use library-grade BM25 via Milvus/Qdrant; matching that pattern keeps frink aligned with proven implementations

Phase 2 has cost:
- One new dependency (`minisearch`)
- ~5.6MB JSON per indexed project
- Watcher persistence overhead (one JSON write per file change, ~50ms for 5MB index)

## Next Steps

The bench data shows neither Phase 1 nor Phase 2 fixes the configurePlugins-class failure. The bottleneck is **query side**, not retrieval side: GitHub issue bodies are too verbose for token-based retrieval. Future directions:

1. **HyDE-style query rewrite**: LLM call (~1s) extracts identifier-like tokens or generates a hypothetical code stub from the issue body. Run BM25 on the rewritten query.
2. **Soft N-of-M matching**: switch from AND to "match at least 30% of query tokens" — recovers some recall without going full OR.
3. **Per-channel weighting**: tuned convex blend instead of equal-weight RRF (Bruch & Gai arXiv:2210.11934).

Out of scope for v9.

## Rollback

Phase 1 only (drop MiniSearch, keep FTS5):
```bash
git checkout 084516ecb -- .claude/tools/search-code/
```

Full rollback to v6:
```bash
git checkout 8bf195858 -- .claude/tools/search-code/
sqlite3 .search-code/index.db "DROP TABLE chunks_code_fts;"
rm -f .search-code/*.bm25.json
```
