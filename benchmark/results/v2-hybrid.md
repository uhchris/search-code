# Benchmark v2-hybrid

**Date:** 2026-05-03
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Thinking:** off
**Describer prompt focus:** domain + problem + constraints (bad→good few-shot examples)
**Search:** hybrid BM25+vector via RRF (K=60)
**Test cases:** 30 (25 positive, 5 negative)

## Summary

| Metric | Score | vs v1 |
|--------|-------|-------|
| Recall@1 | 12/25 (48%) | ↓ -12pp |
| Recall@3 | 18/25 (72%) | ↓ -20pp |
| Recall@5 | 19/25 (76%) | ↓ -16pp |
| MRR@10 | 0.590 | ↓ -0.150 |
| Negative pass rate | 5/5 (100%) | = |
| Avg tokens — Semantic | 3004 | ↓ -905 |
| Avg tokens — Grep | 5709 | ≈ |

## Per-Case Results

| ID | Type | R@1 | R@3 | R@5 | MRR | Top sim | vs v1 |
|----|------|-----|-----|-----|-----|---------|-------|
| pluralize-duplicate | duplicate_detection | ✓ | ✓ | ✓ | 1.00 | 0.63 | = |
| relative-time-duplicate | duplicate_detection | ✓ | ✓ | ✓ | 1.00 | 0.59 | = |
| chat-name-needle | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.64 | = |
| truncate-scatter | scattered_pattern | ✓ | ✓ | ✓ | 1.00 | 0.60 | = |
| **loading-state-components** | duplicate_detection | ✗ | ✗ | ✗ | **0.00** | 0.72 | ↓ was 0.50 |
| **error-state-hook** | scattered_pattern | ✗ | ✗ | ✗ | **0.00** | 0.48 | ↓ was 1.00 |
| retry-with-jitter | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.66 | = |
| terminal-buffering | paraphrase | ✗ | ✗ | ✗ | 0.00 | 0.44 | = |
| envelope-encryption | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.54 | = |
| **unsaved-changes-guard** | paraphrase | ✗ | ✓ | ✓ | **0.33** | 0.61 | ↓ was 1.00 |
| version-update-classifier | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.52 | = |
| concurrency-limiter | low_lexical_overlap | ✗ | ✗ | ✗ | 0.00 | 0.58 | = |
| **mcp-eager-load** | low_lexical_overlap | ✗ | ✗ | ✓ | **0.25** | 0.50 | ↓ was 0.33 |
| **git-diff-splitter** | low_lexical_overlap | ✗ | ✗ | ✗ | **0.00** | 0.57 | ↓ was 0.50 |
| **stream-to-ui-events** | low_lexical_overlap | ✗ | ✓ | ✓ | **0.50** | 0.50 | ↓ was 1.00 |
| **auth-state-mismatch** | error_symptom | ✗ | ✗ | ✗ | **0.00** | 0.49 | ↓ was 1.00 |
| credential-blob-corrupt | error_symptom | ✗ | ✓ | ✓ | 0.50 | 0.56 | = |
| agent-execution-timeout | error_symptom | ✗ | ✓ | ✓ | 0.33 | 0.50 | ↓ was 0.50 |
| tool-permission-denied | error_symptom | ✓ | ✓ | ✓ | 1.00 | 0.52 | ↑ was 0.50 |
| pkce-verifier-lookup | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.74 | = |
| mcp-boot-prefetch | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.56 | ↑ was 0.33 |
| git-ipc-subscription | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.52 | = |
| **lsp-transport-bridge** | needle_in_haystack | ✗ | ✓ | ✓ | **0.33** | 0.55 | ↓ was 1.00 |
| flow-step-remote-execution | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.56 | ↑ was 0.33 |
| **mcp-oauth-and-tools** | needle_in_haystack | ✗ | ✓ | ✓ | **0.50** | 0.69 | ↓ was 1.00 (test.tsx at R@1) |
| negative-unrelated | negative | — | — | — | — | 0.39 | PASS |
| negative-too-generic | negative | — | — | — | — | 0.27 | PASS |
| negative-docker-config | negative | — | — | — | — | 0.34 | PASS |
| negative-webgl-shader | negative | — | — | — | — | 0.48 | PASS |
| negative-sql-migration | negative | — | — | — | — | 0.37 | PASS |

## Key Findings

- **Root cause of regression:** BM25 hybrid boosted domain-adjacent files sharing query vocabulary, pushing targets out of top-5.
- New purpose-driven descriptions are less keyword-dense — BM25 rewards lexical overlap with wrong files.
- `auth-state-mismatch`, `stream-to-ui-events`, `lsp-transport-bridge` all dropped from MRR=1.00 to ≤0.50 due to BM25 false-positive boosting.
- `mcp-oauth-and-tools` R@1 contaminated by `.test.tsx` file (exclude pattern gap: `*.test.ts` only, not `*.test.tsx`). Fixed in config.
- Improvements (tool-permission-denied, mcp-boot-prefetch, flow-step-remote-execution) confirm new prompt descriptions are better — just not compatible with BM25.
- **Decision:** revert to vector-only search, keep FTS5 infrastructure for potential future use with raw-code indexing.
