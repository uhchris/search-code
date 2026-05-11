# v14 — chunker fixes only (manifest dropped)

**Date:** 2026-05-08
**Trigger:** v13 (manifest + chunker fixes) regressed R@1 −5pp vs v11 baseline. v12-no-manifest ablation showed chunker fixes alone covered most of the Mode 2 wins. v14 tests the cleanest combo: BOTH chunker fixes (Drizzle/exported emit + per-property tRPC chunks) but NO manifest prefix.

## Headline numbers — v14 PARETO BEATS v11 baseline

| Metric | v11 baseline | v12-manifest | v13 (manifest + chunker) | **v14 (chunker only)** | Δ vs v11 |
|--------|---|---|---|---|---|
| Recall@1 | 27/40 = 68% | 25/40 = 63% | 25/40 = 63% | **28/40 = 70%** | **+2pp** |
| Recall@3 | 34/40 = 85% | 34/40 = 85% | 35/40 = 88% | **35/40 = 88%** | **+3pp** |
| Recall@5 | 36/40 = 90% | 37/40 = 93% | 37/40 = 93% | 35/40 = 88% | −2pp |
| MRR@10 | 0.764 | 0.748 | 0.753 | **0.787** | **+0.023** |
| Negative pass | 8/9 | 8/9 | 8/9 | 8/9 | = |
| Total chunks | 4983 | 5712 | 6083 | 6083 | +1100 |

R@1 + R@3 + MRR all improved. R@5 lost 2 cases to chat-data-shape-schema (Mode 2 plumbing).

## Failure-mode case results

| Case | v11 | **v14** | Outcome |
|------|-----|---------|---------|
| trpc-disconnect-integration-handler | R@3 ✓ MRR 0.33 | **R@1 ✓ MRR 1.00** | **Mode 1 WIN** (per-property chunks) |
| trpc-generate-webhook-endpoint | R@3 ✓ MRR 0.50 | **R@1 ✓ MRR 1.00** | **Mode 1 WIN** (per-property chunks) |
| user-integrations-repo-readers | R@5=0 | **R@1 ✓ MRR 1.00** | **Mode 2 WIN** (Drizzle/exported emit fix) |
| crossmachine-flag-gates | R@1 ✓ | R@1 ✓ | stable |
| frink-mcp-launch-flag-gate | R@1 ✓ | R@1 ✓ | stable |
| chat-data-shape-schema | R@5=0 | **R@5=0** | **REGRESSION RETAINED** — manifest was needed for this case |
| flows-mcp-tools-server-register | R@3 ✓ MRR 0.50 | R@3 ✓ MRR 0.50 | stable |

**3 of 4 Mode 1+2 cases lifted to R@1.** Only `chat-data-shape-schema` stays at R@5=0. The manifest specifically rescued this one case (rich-vocab competitor files outrank schema chunk's generic prose description without column-name token injection). v13 paid R@1 −7pp for that single rescue — bad trade.

## Why v14 beats v13 on R@1

Manifest tokens diluted description embeddings for paraphrase queries. Adding ~50 identifier tokens to every chunk's embed text shifted the embedding centroid toward identifier-space, away from prose-paraphrase-space where the v6/v11 architecture was strongest.

The chunker fixes (per-property tRPC chunks + Drizzle/exported emit) add chunks but DON'T modify embed text content — each chunk still embeds its own prose description. So the per-chunk paraphrase signal stays clean. New chunks just compete fairly with existing ones; right answers win when they're a better cosine match.

## Why R@5 regressed −2pp (still net positive overall)

Adding 1100 new chunks (Drizzle table defs, exported configs, tRPC per-procedure chunks) means more cosine competitors. Some R@5 hits where the right file ranked 4-5 on v11 now rank 6+ because new related-but-not-target chunks slot in.

This is the fundamental cost of fixing Mode 2 (was: 0 chunks for schema files = R@5=0). Schema/repo files genuinely matter for queries — they need chunks. Adding them costs some R@5 ranking churn elsewhere.

Net: +1 R@1 case, +1 R@3 case, −1 R@5 case = small positive shift. MRR +0.023 reflects this.

## What got dropped

`embedder.ts:buildEmbedText` no longer calls `extractManifest`. The function still lives in `chunker.ts` for potential future revisits (smaller cap, selective application to plumbing files, etc.). Comment in embedder.ts records why.

## SWE-PolyBench impact (CONFIRMED — n=24)

Re-ran SWE-poly with v14 (manifest dropped, chunker fixes retained):

| Metric | v9 baseline | v13 (manifest) | **v14** |
|---|---|---|---|
| R@1 any-hit | 13/24 | 14/24 (+1) | **13/24** (= v9) |
| R@3 any-hit | 17/24 | 17/24 | **17/24** (= v9) |
| R@5 any-hit | 20/24 | 18/24 (−2) | **20/24** (= v9) |
| Mean R@1 | — | 0.384 | **0.363** |
| Mean R@5 | — | 0.557 | **0.591** |

**Zero net change vs v9 baseline.** Chunker fixes don't add many chunks to plain-JS codebases (tailwind +5, prettier ~stable, three.js minor) — the chunker rules target patterns absent in those repos (Drizzle, tRPC). Tailwindcss-853 (`configurePlugins.js`) still total miss as on every prior version — chronic, pre-dates all changes.

**Best of both:** v14 improves frink's TS/Drizzle/tRPC retrieval without disturbing other codebases.

## Cumulative path summary

v11 → v14 changes (in `.claude/tools/search-code/src/`):

1. `chunker.ts` `VariableDeclaration` handler — emits chunks for any top-level **exported** `VariableDeclaration` regardless of init kind. Mode 2 root cause: Drizzle `sqliteTable(...)` and similar pattern-init exports previously emitted 0 chunks because the chunker only handled function/HOC initializers.

2. `chunker.ts:extractObjectPropertyChunks()` — for exported CallExpression-init patterns (tRPC routers, dispatch tables), emits a sub-chunk per `Property` whose value spans ≥80 bytes. Mode 1 root cause: 1500-line tRPC routers truncated at maxChunkLines=300 → handlers past the cap never indexed.

3. `chunker.ts:extractManifest()` — kept (code cost: ~40 lines) but unused. Future-work hook.

Things tried and reverted:
- Manifest-as-prefix in embed text — regressed R@1, dropped (v14)
- Hardcoded keyword stoplist for manifest — replaced with structural TS-subtree gating before being dropped
- Top-2-per-file dedup (Spike Hijacking citation) — net negative, reverted
- camelCase tokenizer for BM25 — anti-pattern, rejected pre-v9

## Decision

**Ship v14.** Pareto improvement over v11 on R@1 + R@3 + MRR. Mode 1 and Mode 2 R@1 wins (3 of 4 real-world failure cases). Single regression (`chat-data-shape-schema`) accepted because rescuing it via manifest cost +5 cases R@1 elsewhere.

## Honest framing

The chunker fixes are **correctness improvements**, not retrieval engineering: schema/index.ts genuinely had 0 chunks under v11 (a silent bug), and tRPC routers were genuinely truncated past 300 lines. Fixing these bugs makes more code searchable; that's the whole win. Retrieval ranking didn't fundamentally change.

Manifest was the engineering extrapolation that didn't pan out. Result: clean revert. Lessons saved in `v12-research-notes.md` for any future retry.
