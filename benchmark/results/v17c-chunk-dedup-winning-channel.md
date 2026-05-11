# v17c — Chunk-deduped winning-channel rendering (REJECTED)

**Date:** 2026-05-09
**Status:** Implemented, benched, REGRESSED vs v17b. Reverted; kept as variant in `render.ts` for future revisits.

## Hypothesis

Per user feedback after seeing v17b output — when the same chunk appears 3× (one per channel that ranked it), it feels redundant. Cleaner mental model: **one row per chunk**, source = whichever channel ranked it best. If `code:#1` and `desc:#3` for same chunk → show only `code:#1` row. Token-cheaper than v17b's 3-rows-per-chunk pattern.

## Implementation

`renderMcpV17c` in `src/render.ts`:

```ts
for (const r of results) {
  let best: { source: Source; rank: number } | null = null;
  if (r.codeRank != null) best = { source: 'code', rank: r.codeRank };
  if (r.bm25Rank != null && (!best || r.bm25Rank < best.rank)) best = { source: 'bm25', rank: r.bm25Rank };
  if (r.descRank != null && (!best || r.descRank < best.rank)) best = { source: 'desc', rank: r.descRank };
  if (best) entries.push({ ...best, r });
}
entries.sort((a, b) => a.rank - b.rank || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
```

Output shape (one row per chunk):

```
1. file.ts:1-10  [symbol]  won via code:#1  desc:#2 code:#1 bm25:#--
```ts
<code>
```

2. other.ts:5-20  [x]  won via desc:#1  desc:#1 code:#4 bm25:#--
   <description prose>
```

All channel ranks shown for transparency; source content driven by winning channel.

## Bench results — v17c agent-mode SWE-PolyBench

n=23 (one instance failed/missing — possibly timeout).

| Metric | v17c |
|--------|------|
| any-hit R@1 | 16/23 (70%) |
| any-hit R@3 | 19/23 |
| any-hit R@5 | 19/23 |
| Mean R@1 | 0.448 |
| Mean R@3 | 0.563 |
| Mean R@5 | 0.563 |
| Avg tokens | 236K |
| Avg turns | 10.6 |

## Comparison

| | v16 short | **v17b (shipped)** | v17c |
|---|---|---|---|
| n | 24 | 24 | 23 |
| R@1 any-hit | 15/24 (62%) | **19/24 (79%)** | 16/23 (70%) |
| Mean R@1 | 0.408 | **0.506** | 0.448 |
| Mean R@3 | 0.576 | 0.532 | 0.563 |
| Mean R@5 | 0.576 | 0.532 | 0.563 |
| Avg tokens | 50K | 226K | 236K |
| Avg turns | 8.9 | 8.8 | 10.6 |

**v17c is strictly worse than v17b on R@1 and tokens.** Marginally better on R@3/R@5 means.

## Why v17c regressed

The chunk-dedup collapses multi-channel evidence. v17b's redundancy is INFORMATIVE — when both `desc` and `code` channels independently rank a chunk, that's two votes saying "this is relevant", and the agent sees both rows in top-K with different content (description prose AND code body). v17c hides this signal: only the winning channel's content surfaces, and the other channel's vote becomes invisible (just a "#4" tag instead of a full row).

Practical effect on the agent:
- v17b: agent sees code body for `setStreamId` AT rank 1 (code:#1), then description for `setStreamId` AT rank 2 (desc:#1). Two reinforcing pieces of evidence near the top.
- v17c: agent sees only code body for `setStreamId` at rank 1. Description signal collapsed into a tag. Less context for reasoning.

The "redundancy" v17c was trying to remove was actually doing useful work.

## Token cost paradox

v17c uses MORE tokens (236K) than v17b (226K) despite collapsing 3 rows → 1.

Hypothesis: with fewer alternatives surfaced per call, the agent makes more search calls to disambiguate. More turns (10.6 vs 8.8) → more total tokens. The per-call payload shrinks but per-instance turns grow.

This matches a general retrieval-UX principle: **richer single calls beat sparser multiple calls** when the agent has to compose evidence.

## Decision

**v17b is the production default.** v17c retained in `render.ts` as `renderMcpV17c` for future revisits — could become useful with different downstream consumers (e.g. human-readable web UI where 3-rows-per-chunk feels noisy). For agent consumption, v17b's redundancy is the right shape.

## What this proves

1. Adding "cleaner" output (chunk dedup) does NOT help agents — they reason better with parallel evidence than with collapsed evidence.
2. Bench-driven decision-making works: hypothesis → implement → measure → revert. Shipped wrong path would have cost real R@1.
3. v17b's "same chunk, multiple rows" is research-aligned with **listwise rerank** patterns where redundant strong signals reinforce confidence.

## Files

- `src/render.ts` — both `renderMcpV17b` (shipped default) and `renderMcpV17c` (variant, unused)
- `src/mcp-server.ts` — imports `renderMcpV17b`
- `src/index.ts:runSearch` — `--format mcp` calls `renderMcpV17b`
- `benchmark/results/v17b-agent-mode-bench.md` — shipped path bench
- `benchmark/results/v17c-chunk-dedup-winning-channel.md` — this file

## Cumulative summary update

| Bench | v6 baseline | **v17b (shipped)** | v17c (rejected) |
|-------|---|---|---|
| Frink internal R@1 | 68% | **70%** | n/a (rendering only) |
| Frink internal R@5 | 90% | **98%** | n/a |
| SWE-poly agent R@1 any-hit | n/a | **19/24 (79%)** | 16/23 (70%) |
| SWE-poly agent mean R@1 | n/a | **0.506** | 0.448 |
