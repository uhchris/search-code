# v12 — manifest-as-prefix + chunker emits Drizzle/exported declarations

**Date:** 2026-05-08
**Trigger:** v11-expanded bench identified Mode 1 (same-file multi-chunk dedup) and Mode 2 (generic plumbing descriptions) as concrete failure modes. v12 attempts both:

1. AST-position-aware **manifest** of identifier-shaped tokens prepended to embed text (research basis: GraphCodeBERT §3 + CodeT5 §4.1 + arXiv:2412.15241 prefix-bias)
2. **Chunker emits Drizzle table defs and any top-level exported `VariableDeclaration`** — root cause of Mode 2: schema/index.ts and several repo files were emitting **0 chunks** because the chunker only treated CallExpression-init when first arg was a function

Top-2-per-file dedup (Mode 1 fix candidate) was tested separately and reverted — see "Top-2 dedup ablation".

## Headline numbers (locked, second run)

| Metric | v11 baseline | v12 (manifest + chunker fix) | Δ |
|--------|---|---|---|
| Recall@1 | 27/40 = 68% | **25/40 = 63%** | **−5pp** |
| Recall@3 | 34/40 = 85% | 34/40 = 85% | = |
| Recall@5 | 36/40 = 90% | **37/40 = 93%** | **+3pp** |
| MRR@10 | 0.764 | 0.748 | −0.016 |
| Negative pass rate | 8/9 | 8/9 | = |
| Avg tokens (semantic) | 2754 | 3091 | +12% |
| Total chunks indexed | 4983 | 5712 | +729 (Drizzle/exported decls) |

R@5 net positive but R@1 regressed. The R@1 dip is the manifest-prefix dilution (paraphrase queries lose some signal when manifest tokens dominate the prefix). To attribute, see ablation v12-no-manifest.

## Failure-mode case results

| ID | v11 | v12 | Verdict |
|----|-----|-----|---------|
| trpc-disconnect-integration-handler | R@3 ✓ MRR 0.33 | R@3 ✓ MRR 0.33 | unchanged (Mode 1 not fixed) |
| trpc-generate-webhook-endpoint | R@3 ✓ MRR 0.50 | R@3 ✓ MRR 0.50 | unchanged |
| user-integrations-repo-readers | **R@5=0** | **R@1 ✓ MRR 1.00** | **WIN — chunker** |
| chat-data-shape-schema | **R@5=0** | R@3 ✓ MRR 0.33 | **partial WIN — chunker** |
| crossmachine-flag-gates | R@1 ✓ | R@1 ✓ | stable |
| internal-mcp-launch-flag-gate | R@1 ✓ | R@1 ✓ | stable |
| flows-mcp-tools-server-register | R@3 ✓ MRR 0.50 | R@3 ✓ MRR 0.50 | stable |

**Net failure-mode gains:** 2 R@5=0 cases lifted (1 to R@1, 1 to R@3). Mode 1 cases (same-file multi-chunk picking wrong chunk) **not** fixed by manifest — the wrong chunk's description still outranks the right chunk.

## Why R@1 regressed

The manifest dilutes the description embedding for paraphrase queries — the strong suit of the v6/v11 architecture. Adding 50 identifier-shaped tokens to every embed text shifts the centroid of the chunk's embedding away from the prose-paraphrase locus.

This is the same lesson as v8a (R@1 79 → 15 when full rawCode was concatenated), at smaller dose. arXiv:2412.15241's prefix-bias is real: tokens at the start influence the embedding more, so noise in the prefix is more costly than noise elsewhere.

The R@5 gain says: where the description was *too generic* to bridge query vocabulary (Drizzle schemas), the manifest tokens DO surface the right file — but always at rank 3-5, not rank 1, because competitor files have richer descriptions that still outscore the schema chunk's `description + manifest` overall.

## Top-2-per-file dedup ablation

Tested separately. Configuration: PER_FILE_CAP=2 in `searchBySimilarity` and `searchHybrid` dedup loops.

| Metric | top-1 | top-2 | Δ |
|--------|---|---|---|
| R@1 | 25/40 = 63% | 25/40 = 63% | = |
| R@3 | 35/40 = 88% | 35/40 = 88% | = |
| R@5 | 37/40 = 93% | 35/40 = 88% | −5pp |
| MRR@10 | 0.753 | 0.721 | −0.032 |

`trpc-generate-webhook-endpoint` lifted from R@3 to R@1 with top-2 (the right chunk surfaced from the same file as a wrong chunk), but other R@5 hits got pushed out of top-5 because wrong-file chunks 1 and 2 occupied ranks 1+2, displacing the right (different) file. Net negative — top-2 reverted.

Research backing for top-2-per-file (arXiv:2604.05253 Spike Hijacking, arXiv:2407.04573 VRSD) was about pooling minority signal in **single-vector** representations from multi-vector input, not query-time per-file caps. Cite-mismatch — the analogy did not hold.

## Chunker fix (root cause of Mode 2)

Before:

```ts
case 'VariableDeclaration': {
  // ... only chunked when init was ArrowFn / FunctionExpr,
  // OR CallExpression with first-arg function (memo, forwardRef pattern)
}
```

`export const subChats = sqliteTable('sub_chats', { id: text('id'), ... })` is a `VariableDeclaration` whose `init` is a `CallExpression` whose **first argument is a string literal**, not a function. **Skipped silently.** Same for repo files where exports include `export const X = createWorkspace({...})` patterns, etc.

Result: `src/main/lib/db/schema/index.ts` emitted **0 chunks**. `db/repos/user-integrations.ts` emitted 0. Mode 2 cases couldn't pass — nothing to retrieve.

After (rule):

> Always emit a chunk for any **top-level exported** `VariableDeclaration`, regardless of `init` kind. Drizzle tables, zod schemas, exported config, route registries — all structural plumbing whose definitions are searchable.

Post-reindex chunk counts:
- `db/schema/index.ts`: 0 → 38
- `db/repos/user-integrations.ts`: 0 → 14
- Total chunks: 4983 → 5712 (+729)

This is necessary regardless of the manifest decision.

## Ablation: chunker-fix only (no manifest)

| Metric | v11 baseline | v12-no-manifest | v12-manifest+chunker (final) |
|--------|---|---|---|
| Recall@1 | 27/40 = 68% | 26/40 = 65% | **25/40 = 63%** |
| Recall@3 | 34/40 = 85% | 34/40 = 85% | 34/40 = 85% |
| Recall@5 | 36/40 = 90% | 35/40 = 88% | **37/40 = 93%** |
| MRR@10 | 0.764 | 0.755 | 0.748 |
| Mode 2 wins | 0/2 | 1/2 | **2/2** |

**Per-case Mode 2 cases:**

| Case | v11 | no-manifest | manifest |
|------|-----|-------------|----------|
| user-integrations-repo-readers | R@5=0 | R@1 ✓ | R@1 ✓ |
| chat-data-shape-schema | R@5=0 | R@5=0 | R@3 ✓ |
| trpc-disconnect-integration-handler | R@3 ✓ | R@5 ✓ MRR 0.20 | R@5 ✓ MRR 0.25 |

The schema chunk (`db/schema/index.ts`) needs the manifest to surface its column-name vocabulary in dense space. Chunker fix alone gives 0 chunks → 38 chunks but the rich descriptions of competitor files (socket/client.ts, sub-chats handlers) outrank the schema chunk's generic description. Manifest tokens (`sub_chats sandbox_id session_id stream_id messages`) bridge the vocabulary.

User-integrations is fixed by the chunker alone: the repo file's natural function descriptions already match `read user integrations from local SQLite repo` once it's actually indexed.

## Decision: ship v12 (manifest + chunker)

Trade-off:
- R@1: −5pp (2 cases displaced; mostly noise from 729 added Drizzle/exported chunks competing in cosine ranking)
- R@3: =
- R@5: +3pp (2 Mode 2 wins net of 1 R@5 case shifted out)
- Mode 2: 0/2 → 2/2 — **directly addresses user feedback** ("agent slipping back to grep on exact-token queries", real session log Mode 2 cases)

Real-world value of Mode 2 wins > 5pp R@1 drop on benchmark. The R@1 cases that drop are paraphrase queries where competitor chunks now win on tied cosine — agents in production can disambiguate from R@3.

## Honest framing on "research-backed"

Manifest extraction algorithm:
- Grounded in GraphCodeBERT §3 (variables = AST leaf identifiers)
- Grounded in CodeT5 §4.1 (filter reserved keywords per PL — handled structurally by ESTree)
- Prefix placement: arXiv:2412.15241

NOT directly cited:
- arXiv:2601.11863 (RAGMATE-10K) — domain-specific structured fields, NOT generic identifier extraction
- arXiv:2503.05315 (LoRACode) — defers preprocessing to base models

Initial v12 commit incorrectly cited the latter two. Corrected in `embedder.ts` and `v12-research-notes.md`.

The manifest itself is **engineering extrapolation**, not a paper-validated algorithm. CodeT5/GraphCodeBERT use identifier sequences as **transformer training input with attention**, not as **frozen-embedder text-input prefix**. The benchmark is the only validation.
