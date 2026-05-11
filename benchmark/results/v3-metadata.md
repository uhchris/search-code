# Benchmark v3-metadata

**Date:** 2026-05-03
**Model:** gemma4:26b (describer), nomic-embed-text (embedder)
**Thinking:** off
**Search:** vector-only
**Change from v3-clean:** Prepend `{filePath} [{symbolName|startLine}]: ` to embedded text at index time

## Summary

| Metric | v1 | v2 | v3-clean | v3-metadata | Δ v1→now |
|--------|----|----|----------|-------------|----------|
| Recall@1 | 15/25 (60%) | 16/25 (64%) | 17/25 (68%) | **19/25 (76%)** | ↑ +16pp |
| Recall@3 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | **23/25 (92%)** | = |
| Recall@5 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | **24/25 (96%)** | ↑ +4pp |
| MRR@10 | 0.740 | 0.760 | 0.780 | **0.843** | ↑ +0.103 |
| Negative pass rate | 5/5 | 5/5 | 5/5 | **5/5** | = |
| Avg tokens — Semantic | 3909 | 2818 | 2926 | **3106** | ↓ -803 |

## Per-Case Results

| ID | Type | v1 MRR | v2 MRR | v3-clean | v3-metadata | Trend |
|----|------|--------|--------|----------|-------------|-------|
| pluralize-duplicate | duplicate_detection | 1.00 | 1.00 | 1.00 | **1.00** | = |
| relative-time-duplicate | duplicate_detection | 1.00 | 1.00 | 1.00 | **1.00** | = |
| chat-name-needle | needle_in_haystack | 1.00 | 1.00 | 1.00 | **1.00** | = |
| truncate-scatter | scattered_pattern | 1.00 | 1.00 | 1.00 | **1.00** | = |
| loading-state-components | duplicate_detection | 0.50 | 0.50 | 0.50 | **1.00** | ↑ |
| error-state-hook | scattered_pattern | 1.00 | 0.00 | 0.00 | **0.33** | ↑ partial |
| retry-with-jitter | paraphrase | 1.00 | 1.00 | 1.00 | **1.00** | = |
| terminal-buffering | paraphrase | 0.00 | 0.50 | 0.50 | **1.00** | ↑↑ |
| envelope-encryption | paraphrase | 1.00 | 1.00 | 1.00 | **1.00** | = |
| unsaved-changes-guard | paraphrase | 1.00 | 0.50 | 0.50 | **0.50** | ↓ from v1 |
| version-update-classifier | paraphrase | 1.00 | 1.00 | 1.00 | **1.00** | = |
| concurrency-limiter | low_lexical_overlap | 0.00 | 0.00 | 0.00 | **0.00** | stuck |
| mcp-eager-load | low_lexical_overlap | 0.33 | 1.00 | 1.00 | **1.00** | ↑ |
| git-diff-splitter | low_lexical_overlap | 0.50 | 0.00 | 0.00 | **1.00** | ↑↑ recovered |
| stream-to-ui-events | low_lexical_overlap | 1.00 | 1.00 | 1.00 | **0.25** | ↓ regression |
| auth-state-mismatch | error_symptom | 1.00 | 1.00 | 1.00 | **1.00** | = |
| credential-blob-corrupt | error_symptom | 0.50 | 1.00 | 1.00 | **1.00** | ↑ |
| agent-execution-timeout | error_symptom | 0.50 | 1.00 | 1.00 | **1.00** | ↑ |
| tool-permission-denied | error_symptom | 0.50 | 1.00 | 1.00 | **1.00** | ↑ |
| pkce-verifier-lookup | needle_in_haystack | 1.00 | 1.00 | 1.00 | **1.00** | = |
| mcp-boot-prefetch | needle_in_haystack | 0.33 | 1.00 | 1.00 | **0.50** | ↓ regression |
| git-ipc-subscription | needle_in_haystack | 1.00 | 0.50 | 0.50 | **1.00** | ↑ recovered |
| lsp-transport-bridge | needle_in_haystack | 1.00 | 0.50 | 0.50 | **0.50** | ↓ from v1 |
| flow-step-remote-execution | needle_in_haystack | 0.33 | 1.00 | 1.00 | **1.00** | ↑ |
| mcp-oauth-and-tools | needle_in_haystack | 1.00 | 0.50 | 1.00 | **1.00** | ↑ (v2 was test contamination) |
| negative-unrelated | negative | PASS | PASS | PASS | **PASS** | = |
| negative-too-generic | negative | PASS | PASS | PASS | **PASS** | = |
| negative-docker-config | negative | PASS | PASS | PASS | **PASS** | = |
| negative-webgl-shader | negative | PASS | PASS | PASS | **PASS** | = |
| negative-sql-migration | negative | PASS | PASS | PASS | **PASS** | = |

## Key Findings

- **Metadata prefix is the biggest single improvement.** MRR 0.780 → 0.843 (+0.063 vs v3-clean, +0.103 vs v1).
- **`git-diff-splitter` fixed** (0.50 → 0.00 → 1.00): v2 prompt change broke it; path prefix `src/main/lib/git/diff-parser.ts` restored signal to distinguish parser from UI diff components.
- **Ranking failures resolved:** `loading-state-components`, `terminal-buffering`, `git-ipc-subscription` promoted from R@3 to R@1 — path+symbol prefix broke ties between semantically similar files.
- **`error-state-hook` partially recovered** (1.00 → 0.00 → 0.33): target `useRollback.ts` now appears at R@3. Regressed in v2 (prompt change hurt it), still not back to v1 level.
- **Two regressions vs v3-clean:**
  - `stream-to-ui-events` (1.00 → 0.25): target `src/main/lib/claude/transform.ts` dropped to R@5. Renderer-side message files over-weighted by path prefix. Cross-encoder re-ranker is likely fix.
  - `mcp-boot-prefetch` (1.00 → 0.50): `src/main/lib/mcp/proxy.ts` ranks above `use-mcp-background-prefetch.ts`. Both MCP-prefetch-related; path prefix pushed proxy above the hook.
- **Persistent stuck case:** `concurrency-limiter` (0.00 across all versions) — description vocabulary gap, path prefix doesn't help. Requires HyPE (see experiments/).
- **Still below v1 on:** `unsaved-changes-guard` (1.00→0.50, v2 prompt regression not recovered), `lsp-transport-bridge` (1.00→0.50, same).
- **Token efficiency improved vs v1:** 3909 → 3106 avg semantic tokens (-20%).
