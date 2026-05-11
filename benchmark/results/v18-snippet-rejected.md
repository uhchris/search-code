# v18 — Snippet extraction (REJECTED)

**Date:** 2026-05-09
**Status:** Implemented, benched, REGRESSED. `extractSnippet` retained in `src/render.ts` for potential future use; production path stays on full-chunk `readChunkSource`.

## Hypothesis

Returning the entire chunk body (50-300 lines) per result wastes tokens. Replace with **passage highlighting** — Elasticsearch/Algolia-style snippet extraction:

1. Tokenize query → query terms
2. Score each line in chunk by query-term overlap (case-insensitive substring)
3. Pick top-5 hit lines, expand with ±2 context lines
4. Splice with `// ... omitted (N lines)` markers between gaps
5. Fallback: if no token overlap (pure paraphrase match via dense channel), show first 10 lines (signature view)

Expected: 60-80% per-chunk token reduction with same R@1.

## Implementation

`extractSnippet(filePath, startLine, endLine, query)` in `src/render.ts`:

```ts
const tokens = queryTokens(query);                    // ≥3-char alphanumeric
const scored = lines.map((l, i) => ({ idx: i, score: lineScore(l, tokens) })).filter(s => s.score > 0);
const topIdxs = scored.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.idx);
// expand ±2 lines, dedupe, sort by line number, splice with omission markers
```

Smoke test confirmed sensible output:
- 300-line `handler` chunk → ~20 lines visible (signature + retry-related lines + sourceId for retries) with `// ... omitted` between
- Small chunks (≤10 lines) → returned unchanged
- Pure paraphrase queries with no token overlap → first 10 lines fallback

## Bench results — v17b-snippet vs v17b-full-chunk (agent-mode SWE-PolyBench)

| Metric | v17b full-chunk | v17b-snippet | Δ |
|--------|---|---|---|
| R@1 any-hit | 19/24 | **18/24** | **−1** |
| R@3 any-hit | 20/24 | 19/24 | −1 |
| R@5 any-hit | 20/24 | 19/24 | −1 |
| Mean R@1 | 0.506 | 0.492 | −0.014 |
| Mean R@3 | 0.532 | 0.519 | −0.013 |
| Mean R@5 | 0.532 | 0.519 | −0.013 |
| **Avg tokens** | **226K** | **240K** | **+6%** |
| Avg turns | 8.8 | 11.2 | +27% |

**Worse on every retrieval metric AND tokens went UP, not down.**

## Why snippet regressed

Per-call payload shrunk (10-25 lines vs 50-300 lines visible). But total session cost is dominated by **turns × overhead**, not per-call content. With less context per call:

- Agent can't tell from snippet alone whether the chunk is the right answer
- Agent issues more disambiguating searches (turns 8.8 → 11.2, +27%)
- Each turn pays the system-prompt + tool-def overhead (~3K tokens fixed cost per turn)
- More turns × fixed overhead > savings from shorter per-call payloads
- Net: **+14K tokens AND −1 R@1 case**

This matches the v17c failure mode: chunk-dedup reduced rows per result, agent made more calls, costs went up.

**Recurring principle:** agent retrieval rewards more context per call, not less. The "obvious" optimization of trimming response content fails when the consumer is an iterative agent that uses each call to commit/disambiguate.

## Pattern across rejected experiments

| Attempt | What it removed | Result |
|---------|---|---|
| v8a | Description prose (concat with rawCode) | R@1 79→15 catastrophic |
| v10 | Description embedding (replaced with code) | R@1 −18pp |
| v12 manifest | Description structure (added identifier soup prefix) | R@1 −5pp |
| v17c | Multi-row evidence per chunk (chunk-dedup) | R@1 −3 cases, more tokens |
| **v18 snippet** | **Code lines (only matched lines + context)** | **R@1 −1 case, more tokens** |

Common thread: removing/condensing what the existing channels surface degrades agent's ability to act. **Adding new orthogonal channels (v16) helps. Trimming existing channels' output hurts.**

## Decision

**Reject v18 snippet. Keep `readChunkSource` full-chunk.** `extractSnippet` retained in `src/render.ts` as dead code — could be useful for human-readable web UI or for cost-constrained downstream consumers, but NOT for the LLM agent path.

## What's left

- Snippet might still help for VERY large chunks (>200 lines). Hybrid rule: full-chunk if <80 lines, snippet if larger? Untested. Probably not worth the asymmetry.
- Investigate WHY v17b's 226K-tokens/inst is "the right amount" — is there a sweet spot? Currently empirical.
- Other unexplored: chunk-level rerank with cross-encoder before fusion. Would change retrieval, not rendering.

## Files

- `src/render.ts` — `extractSnippet` (unused), `readChunkSource` (production)
- `benchmark/results/v18-snippet-rejected.md` — this file
- `benchmark/results/SUMMARY-v6-to-v16.md` should be renamed to capture v17b/v17c/v18 too
