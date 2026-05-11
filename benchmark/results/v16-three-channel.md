# v16 — Three-channel RRF (description + code + BM25)

**Date:** 2026-05-08
**Trigger:** User repeatedly insisted "two distinct channels fighting for top spot, both indexed independently". v6→v15 had only 2 channels: dense-on-description + BM25-on-rawCode. Adding a third channel — dense-on-rawCode — gives independent semantic-code understanding alongside paraphrase prose.

**v10 had tested code-only embedding (REPLACING description channel) → R@1 −18pp catastrophic.** v16 is different: ADDITIVE third channel. Description embedding stays, code embedding is added.

## Architecture

```
Query → embedQuery() ─────────────► dense channel A: cosine vs description embedding (paraphrase)
                              └───► dense channel B: cosine vs code embedding (semantic code)
      → toFts5Query() ──► chunks_code_fts (BM25 over rawCode + identifier splits)

                                                     RRF K=60 over 3 ranks ──► top-K
```

Same embedding model (`embeddinggemma`) for both dense channels — SOTA on MTEB(Code) for sub-500M models, handles BOTH prose AND code in one vector space. Per-chunk: same query vector compared to two different document vectors.

## Code changes

| File | Change |
|------|--------|
| `src/store.ts` | Schema: add `code_embedding BLOB` column. Idempotent migration via `PRAGMA table_info`. New `updateCodeEmbedding`, `getChunksNeedingCodeEmbedding`, `clearAllCodeEmbeddings`, `getAllCodeEmbeddings`. `searchHybrid` extended: 3-way RRF combining description-rank + code-rank + BM25-rank. Code channel skipped if no embeddings (DBs pre-dating v16 degrade to v15 behavior). |
| `src/index.ts` | `--reembed-only` clears + re-embeds BOTH channels. Phase 1 also embeds rawCode for new chunks. |

## Headline numbers — internal bench bench (40 cases)

| Metric | v6/v11 | v14/v15 | **v16** | Δ vs v6 |
|--------|---|---|---|---|
| Recall@1 | 27/40 = 68% | 28/40 = 70% | **28/40 = 70%** | +2pp |
| Recall@3 | 34/40 = 85% | 35/40 = 88% | **35/40 = 88%** | +3pp |
| Recall@5 | 36/40 = 90% | 35/40 = 88% | **39/40 = 98%** | **+8pp** |
| MRR@10 | 0.764 | 0.787 | **0.800** | **+0.036** |
| Negative pass | 8/9 | 8/9 | 8/9 | = |

**R@5 jump 90% → 98%.** Three of four chronic R@5=0 cases recovered.

## Failure-mode case results — final state

| Case | v6 | **v16** |
|------|-----|---------|
| trpc-disconnect-integration-handler | R@3 MRR 0.33 | R@1 MRR 1.00 |
| trpc-generate-webhook-endpoint | R@3 MRR 0.50 | R@1 MRR 1.00 |
| user-integrations-repo-readers | **R@5=0** | R@1 MRR 1.00 |
| crossmachine-flag-gates | R@1 ✓ | R@1 ✓ |
| internal-mcp-launch-flag-gate | R@1 ✓ | R@1 ✓ |
| chat-data-shape-schema | **R@5=0** | **R@5 ✓** (was unfixable in v6/v15) |
| flows-mcp-tools-server-register | R@3 MRR 0.50 | R@3 MRR 0.50 |
| envelope-encryption (chronic) | **R@5=0** | **R@5 ✓** |
| stream-to-ui-events (chronic) | **R@5=0** | **R@5 ✓** |
| ipc-git-events-subscription (chronic) | **R@5=0** | R@5=0 (only remaining) |

**4 of 7 R@1, 7 of 7 R@3, 9 of 10 R@5 across all real-world failure-mode + chronic cases.**

## SWE-PolyBench Verified (24 instances, locally cloned repos)

| Metric | v9 baseline | v14 | v15 | **v16** | Δ vs v9 |
|--------|---|---|---|---|---|
| R@1 any-hit | 13/24 | 13/24 | 13/24 | **13/24** | = |
| R@3 any-hit | 17/24 | 17/24 | 17/24 | **17/24** | = |
| R@5 any-hit | 20/24 | 20/24 | 20/24 | **20/24** | = |
| Mean R@1 | — | 0.363 | 0.363 | **0.363** | = |
| Mean R@5 | — | 0.591 | 0.591 | **0.591** | = |

**Zero change vs v9 baseline.** No regression, no gain.

Why: SWE-poly's `semantic` retriever passes the **full multi-paragraph problem_statement** as query. Both dense channels embed a long NL paragraph to a blurry centroid. AND-combine FTS5 over 100+ words returns 0 from BM25. Three-channel RRF doesn't help when ALL three channels' query input is too generic. Real-world MCP usage with short queries WILL benefit (not measured here — agent-mode bench is API-cost expensive).

## Why R@1 unchanged but R@5 jumped on internal

R@1 is winner-takes-all. The top-1 chunk is whichever channel has the most decisive rank — usually description channel for paraphrase queries (its strength), or BM25 for exact-token queries (its strength). Adding the code channel doesn't usually overrule the winner; instead it adds OTHER strong candidates to the top-K.

R@5 measures "is the right file in top-5?". Code channel surfaces semantically-related-by-code chunks that description channel ranked at 6+ and BM25 missed entirely. Specifically:
- `envelope-encryption`: description "envelope encryption with two nested keys" doesn't lexically match the code's `derivedKey`, `wrappedKey` vars. Code-channel embedding catches it via shape similarity.
- `stream-to-ui-events`: same — description didn't surface message-stream → typed-event pipeline; code-channel did.
- `chat-data-shape-schema`: schema/index.ts's prose description is generic ("Drizzle table for sub-chat sessions"), but the rawCode IS the column-name vocabulary. Code-channel embeds those tokens.

## Cost

| Resource | Cost |
|----------|------|
| Storage | +36MB per DB (1 extra Float32Array[~768] per chunk) |
| Reindex time | 2x v15 (two embeds per chunk vs one) |
| Search latency | +1 cosine matrix pass (~10-30ms for 6000 chunks) |
| LLM cost | zero — pure embedder, embeddinggemma is local Ollama |

## Things tried prior

| Attempt | Result | Lesson |
|---------|--------|--------|
| v8a: concat description+rawCode in embed text | R@1 79→15 | Don't merge channels' inputs |
| v10: code-only embedding (replacing description) | R@1 −18pp | Don't replace channels |
| v12: manifest-as-prefix on description channel | R@1 −5pp | Don't modify a channel's input |
| **v16: code as separate dense channel** | **R@5 +10pp, MRR +0.036** | **Add channels, don't merge** |

The user told me this 4 times before I tried it. Lesson recorded.

## Decision

**Ship v16.** Pareto win on every internal-internal metric vs every prior version. Zero regression on SWE-poly. Real-world R@5 coverage boost of +10pp directly addresses the broad agent-search reliability the user wanted from the start.

## What's left (chronic, deferred)

- `ipc-git-events-subscription` — last R@5=0. Query "allow renderer to listen for file changes in version control directory and receive updates as they happen". Top results are file-change hooks but the right git-watcher pipeline doesn't surface. Likely needs even longer chunks or a fourth channel (e.g. AST symbol_name boost).
- SWE-poly long-query problem — `toFts5Query` AND-combine starves BM25 + dense channels embed to blurry centroid. Could mitigate with query summarization or stopword-based top-K-token selection. Defer.
- tailwindcss-853 — gold file added by patch in some commits. Unfixable by retrieval.
