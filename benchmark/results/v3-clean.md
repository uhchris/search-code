# Benchmark v3-clean

**Date:** 2026-05-03
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Thinking:** off
**Search:** vector-only
**Change from v2:** Re-indexed after adding `**/*.test.tsx` to excludePatterns — removed 217 chunks from 98 test files

## Summary

| Metric | Score | vs v2 |
|--------|-------|-------|
| Recall@1 | 17/25 (68%) | ↑ +4pp |
| Recall@3 | 22/25 (88%) | = |
| Recall@5 | 22/25 (88%) | = |
| MRR@10 | 0.780 | ↑ +0.020 |
| Negative pass rate | 5/5 (100%) | = |
| Avg tokens — Semantic | 2926 | ≈ |
| Avg tokens — Grep | 4876 | ↓ |

## Per-Case Results

| ID | Type | R@1 | R@3 | R@5 | MRR | Top sim | vs v2 |
|----|------|-----|-----|-----|-----|---------|-------|
| pluralize-duplicate | duplicate_detection | ✓ | ✓ | ✓ | 1.00 | 0.63 | = |
| relative-time-duplicate | duplicate_detection | ✓ | ✓ | ✓ | 1.00 | 0.59 | = |
| chat-name-needle | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.65 | = |
| truncate-scatter | scattered_pattern | ✓ | ✓ | ✓ | 1.00 | 0.65 | = |
| loading-state-components | duplicate_detection | ✗ | ✓ | ✓ | 0.50 | 0.72 | = |
| error-state-hook | scattered_pattern | ✗ | ✗ | ✗ | 0.00 | 0.52 | = |
| retry-with-jitter | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.66 | = |
| terminal-buffering | paraphrase | ✗ | ✓ | ✓ | 0.50 | 0.50 | = |
| envelope-encryption | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.54 | = |
| unsaved-changes-guard | paraphrase | ✗ | ✓ | ✓ | 0.50 | 0.61 | = |
| version-update-classifier | paraphrase | ✓ | ✓ | ✓ | 1.00 | 0.53 | = |
| concurrency-limiter | low_lexical_overlap | ✗ | ✗ | ✗ | 0.00 | 0.61 | = |
| mcp-eager-load | low_lexical_overlap | ✓ | ✓ | ✓ | 1.00 | 0.57 | = |
| git-diff-splitter | low_lexical_overlap | ✗ | ✗ | ✗ | 0.00 | 0.57 | = |
| stream-to-ui-events | low_lexical_overlap | ✓ | ✓ | ✓ | 1.00 | 0.54 | = |
| auth-state-mismatch | error_symptom | ✓ | ✓ | ✓ | 1.00 | 0.51 | = |
| credential-blob-corrupt | error_symptom | ✓ | ✓ | ✓ | 1.00 | 0.58 | = |
| agent-execution-timeout | error_symptom | ✓ | ✓ | ✓ | 1.00 | 0.53 | = |
| tool-permission-denied | error_symptom | ✓ | ✓ | ✓ | 1.00 | 0.52 | = |
| pkce-verifier-lookup | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.74 | = |
| mcp-boot-prefetch | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.56 | = |
| git-ipc-subscription | needle_in_haystack | ✗ | ✓ | ✓ | 0.50 | 0.52 | = |
| lsp-transport-bridge | needle_in_haystack | ✗ | ✓ | ✓ | 0.50 | 0.55 | = |
| flow-step-remote-execution | needle_in_haystack | ✓ | ✓ | ✓ | 1.00 | 0.56 | = |
| **mcp-oauth-and-tools** | needle_in_haystack | ✓ | ✓ | ✓ | **1.00** | 0.66 | **↑ was 0.50** |
| negative-unrelated | negative | — | — | — | — | 0.41 | PASS |
| negative-too-generic | negative | — | — | — | — | 0.33 | PASS |
| negative-docker-config | negative | — | — | — | — | 0.36 | PASS |
| negative-webgl-shader | negative | — | — | — | — | 0.48 | PASS |
| negative-sql-migration | negative | — | — | — | — | 0.41 | PASS |

## Key Findings

- Removing 217 `.test.tsx` chunks from 98 test files fixed `mcp-oauth-and-tools` (test file no longer pollutes top results).
- All other metrics unchanged from v2 — confirms this was the only effect of the contamination.
- **Persistent hard failures (3 cases):** `error-state-hook`, `concurrency-limiter`, `git-diff-splitter` — unchanged.
- **Ranking failures (5 cases at MRR=0.50):** `loading-state-components`, `terminal-buffering`, `unsaved-changes-guard`, `git-ipc-subscription`, `lsp-transport-bridge` — right file in top-5 but not top-1.
- This is the new clean baseline for model swap experiments (v3-nomic, v3-qwen3, etc.).
