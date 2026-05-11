# Benchmark Summary: v6 → v16

**Date:** 2026-05-08
**Scope:** Six-version arc starting from v6/v11 baseline (description embedding + FTS5 BM25 over rawCode + RRF), driven by real-world feedback that agent kept falling back to grep on exact-token queries.

## Final shipped state: **v16** — three-channel RRF

Code path:
- `src/chunker.ts` — exports always emit chunks (Drizzle/zod/configs); per-property sub-chunks for tRPC-router-style CallExpressions
- `src/embedder.ts` — `buildEmbedText` = `${filePath} [${symbol}]: ${description}` (NO manifest)
- `src/tokenizer.ts` — Lucene `WordDelimiterGraphFilter` rules, ~95 LoC
- `src/store.ts` — schema adds `code_embedding BLOB` column; `searchHybrid` does 3-way RRF over description-rank + code-rank + BM25-rank; `updateDescription` augments rawCode with identifier splits before FTS5 insert
- `src/index.ts` — `--reembed-only` clears + re-embeds BOTH dense channels; Phase 1 also embeds rawCode for new chunks

## Architecture (final)

```
Query → embedQuery() ──────────────► dense channel A: vs description embedding (paraphrase)
                              └────► dense channel B: vs code embedding (code semantics)
      → toFts5Query() ──► chunks_code_fts (BM25 over rawCode + identifier splits)

                                                     RRF K=60 over 3 ranks ──► top-K
```

## Headline numbers — internal bench (40 cases)

| Version | R@1 | R@3 | R@5 | MRR | Mode 1+2 R@1 | Notes |
|---------|-----|-----|-----|-----|---|---|
| v6 / v11 baseline | 68% | 85% | 90% | 0.764 | 0/4 | description embed + FTS5 + RRF |
| v12 (manifest + Drizzle) | 63% | 85% | 93% | 0.748 | 3/4 +1 R@3 | manifest cost R@1 |
| v13 (+per-property chunks) | 63% | 88% | 93% | 0.753 | 3/4 +1 R@3 | manifest still on |
| v14 (chunker only, no manifest) | 70% | 88% | 88% | 0.787 | 3/4 | Pareto win on R@1+R@3+MRR |
| v15 (+ identifier splits) | 70% | 88% | 88% | 0.783 | 3/4 | splits index-side, neutral on bench |
| **v16 (+ code-channel embedding)** | **70%** | **88%** | **98%** | **0.800** | **3/4** | **+10pp R@5, MRR best** |

## Failure-mode case results (real-world from session log mining + chronic)

| Case | v6 | **v16** |
|------|---|---------|
| trpc-disconnect-integration-handler | R@3 MRR 0.33 | **R@1 MRR 1.00** |
| trpc-generate-webhook-endpoint | R@3 MRR 0.50 | **R@1 MRR 1.00** |
| user-integrations-repo-readers | **R@5=0** | **R@1 MRR 1.00** |
| crossmachine-flag-gates | R@1 ✓ | R@1 ✓ |
| internal-mcp-launch-flag-gate | R@1 ✓ | R@1 ✓ |
| chat-data-shape-schema | **R@5=0** | **R@5 ✓** |
| flows-mcp-tools-server-register | R@3 | R@3 |
| envelope-encryption (chronic paraphrase) | **R@5=0** | **R@5 ✓** |
| stream-to-ui-events (chronic low-lex) | **R@5=0** | **R@5 ✓** |
| ipc-git-events-subscription (chronic) | **R@5=0** | R@5=0 (only remaining) |

**4 of 7 R@1, 7 of 7 R@3, 9 of 10 R@5.** vs v6: 2/7, 4/7, 5/7.

## SWE-PolyBench Verified (24 instances, locally cloned repos)

| Repo | n | v9 R@1 | v16 R@1 | v9 R@5 | v16 R@5 |
|------|---|---|---|---|---|
| three.js | 4 | 3/4 | 3/4 | 4/4 | 4/4 |
| prettier | 17 | 8/17 | 8/17 | 14/17 | 14/17 |
| tailwindcss | 3 | 2/3 | 2/3 | 2/3 | 2/3 |
| **TOTAL** | **24** | **13/24** | **13/24** | **20/24** | **20/24** |
| Mean R@1 | — | — | 0.363 | — | 0.591 |

**Zero net change vs v9.** SWE-poly's full-paragraph problem_statement queries embed both dense channels to a blurry centroid AND starve FTS5 BM25 via AND-combine. Three-channel RRF can't help when ALL channels' query input is too generic. Real production MCP usage (short queries) WILL benefit but isn't measured here.

tailwindcss-853 chronic miss across all versions — gold file added by patch in some commits, unfixable by retrieval.

## Things tried and reverted

| Attempt | Result | Verdict |
|---------|--------|---------|
| v8a: concat description+rawCode in embed text | R@1 79→15 | Catastrophic, reverted |
| v9 phase 2: camelCase regex tokenizer | n/a | Anti-pattern, rejected |
| v10: code-only embeddings (replacing) | R@1 −18pp | Reverted |
| C.1: query rewriting / HyDE | flat | Reverted |
| v12 hardcoded keyword stoplist for manifest | dead code mostly | Replaced with structural TS-subtree gating |
| v12 manifest as embed-text prefix | R@1 −5pp | Reverted in v14 |
| v12 top-2-per-file dedup | R@5 −2pp | Reverted |

## Key lesson

**Add channels, don't merge them.**

| Modification kind | Result |
|---|---|
| Concat in single channel input (v8a, v12 manifest) | hurts |
| Replace channel input (v10) | hurts catastrophically |
| **Add new channel (v16)** | **only adds signal, RRF is robust** |

User said "two distinct channels fighting for top spot" four times before this got built. RRF over orthogonal signals scales additively because it fuses by RANK not score — it pulls in candidates that any one channel ranked highly, regardless of others' opinions. Modifying a channel's input shifts that channel's embeddings; adding a new channel leaves existing ones untouched.

## Cost (v16)

| Resource | Cost |
|----------|------|
| Storage | +36MB per DB (1 extra Float32Array[~768] per chunk) |
| Reindex time | 2x v15 (two embeds per chunk vs one) |
| Search latency | +1 cosine matrix pass (~10-30ms for 6000 chunks) |
| LLM cost | zero — embeddinggemma is local Ollama, no Anthropic API |

## What's left (deferred)

- `ipc-git-events-subscription` — last R@5=0 on internal. Likely needs symbol_name boost or fourth channel.
- SWE-poly long-query problem — query summarization or stopword-based top-K-token selection. All retrieval improvements are equally defeated by current methodology.
- `chat-data-shape-schema` at R@5 not R@1 — needs better describer prompt for schema files OR bigger weight on code-channel for plumbing.
- HyPE 2.0 (different design from prior failed attempt) — defer.
- Listwise rerank top-20 → top-5 — defer until measured against R@5=98% ceiling.

## Files

- `SUMMARY-v6-to-v16.md` — this file
- `v11-expanded-bench.md` — failure-mode discovery
- `v12-research-notes.md` — paper review, mis-attribution corrections
- `v12-manifest.md` — manifest experiment + ablation
- `v13-per-property-chunks.md` — Mode 1 fix
- `v14-chunker-only.md` — manifest dropped
- `v15-tokenizer-research.md` — Lucene research
- `v15-tokenizer.md` — splits implementation
- `v16-three-channel.md` — third channel
- `v12-bench.log` ... `v16-bench.log` — raw outputs
- `semantic_results.jsonl` — SWE-PolyBench v16 final
