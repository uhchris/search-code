# Benchmark v4-hype-full

**Date:** 2026-05-03
**Model:** gemma4:26b (describer + hyp query generator), embeddinggemma (embedder)
**Thinking:** off
**Search:** vector-only + HyPE (full — all 4150 chunks have hyp embeddings)
**Change from v4-hype-partial:** HyPE applied to all 4150 chunks, not just the 5 benchmark target files.

## Summary

| Metric | v3-metadata | v4-hype-partial | v4-hype-full | Δ full vs v3 |
|--------|-------------|-----------------|--------------|--------------|
| Recall@1 | 19/25 (76%) | 21/25 (84%) | **11/25 (44%)** | ↓ -32pp |
| Recall@3 | 23/25 (92%) | 24/25 (96%) | **16/25 (64%)** | ↓ -28pp |
| Recall@5 | 24/25 (96%) | 24/25 (96%) | **18/25 (72%)** | ↓ -24pp |
| MRR@10 | 0.843 | 0.893 | **0.553** | ↓ -0.290 |
| Negative pass rate | 5/5 | 5/5 | **2/5** | ↓ -3 |

**Decision: reverted to v3-metadata (deleted all 8300 hyp embedding rows).**

## Root Cause: Selection Bias in Partial Benchmark

The v4-hype-partial result (+8pp R@1) was a measurement artifact, not a real improvement.

In partial mode, only the 5 benchmark **target files** had hyp embeddings — competitors did not. The `max(desc_sim, hyp0, hyp1)` operation selectively boosted correct answers while leaving incorrect ones unaffected. The benchmark looked good because the deck was stacked.

In full mode, all 4150 chunks have hyp embeddings. Every chunk's effective score is `max` of 3 comparisons. With 4150 × 3 = 12,450 similarity computations:
- **False positives proliferate**: a competitor chunk's hyp query happens to be closer to the search query than the correct chunk's description, displacing the right answer
- **Similarity floor rises globally**: negative queries ("Docker container health check") now hit hyp queries from infra-adjacent chunks at 0.52, exceeding the 0.5 threshold → 3 negative failures

## Key Learning: `max()` Aggregation Doesn't Scale

The `max()` strategy is fundamentally incompatible with universal application. It assumes hyp queries only boost the right answer — true when only targets have them, false when everyone does.

Alternative that might preserve the gains (not yet tested):
```typescript
// Additive blend: hyp contributes only when it beats desc_sim
const descSim = cosine(queryEmbedding, chunk.embedding);
const hypBoost = Math.max(0, ...chunk.hypEmbeddings.map(h => cosine(queryEmbedding, h) - descSim));
final = descSim + 0.3 * hypBoost;
```
This would cap hyp contribution and prevent it from dominating when the description already has a weak match.

## Cases That Regressed

Virtually all positives regressed. Cases previously at R@1 (MRR=1.00) dropped to R@3–R@5 or worse. The new negative test cases (docker-config, webgl-shader, sql-migration) added to the benchmark also all failed.

## Benchmark Expansion Note

v4-hype-full used an expanded benchmark (30 total cases) vs v4-hype-partial (30 total cases — but the 3 new negative cases docker-config, webgl-shader, sql-migration were added between runs). These 3 cases pass cleanly in v3-metadata (max sim 0.40, 0.47, 0.38), confirming the full HyPE inflated similarity scores globally.
