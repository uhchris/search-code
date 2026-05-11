# Benchmark v5-contextual-retrieval

**Date:** 2026-05-04
**Model:** gemma4:26b (describer), embeddinggemma (embedder)
**Thinking:** off
**Search:** vector-only
**Changes from v3-metadata (two bundled):**
1. **JSDoc prefix** — module-level `/**...*/` blocks before the first non-import declaration are collected in the chunker and prepended to each chunk's `rawCode`. Fixes vocabulary gap where JSDoc contained exact domain terms (e.g. "agent executions allocate large per-stream heap") that were invisible to the describer.
2. **File context (Anthropic Contextual Retrieval pattern)** — the describer LLM now receives the surrounding file as `<file>` context. Files ≤300 lines: full content. Files >300 lines: skeleton of exported signatures + their preceding JSDoc. LLM is instructed to use the file context to name the domain accurately when describing each chunk.

## Summary

| Metric | v1 | v2 | v3-clean | v3-metadata | v4-hype-partial† | **v5-contextual** | Δ v3-meta→v5 |
|--------|----|----|----------|-------------|------------------|-------------------|--------------|
| Recall@1 | 15/25 (60%) | 16/25 (64%) | 17/25 (68%) | 19/25 (76%) | 21/25 (84%) | **21/25 (84%)** | = |
| Recall@3 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | 23/25 (92%) | 24/25 (96%) | **23/25 (92%)** | = |
| Recall@5 | 23/25 (92%) | 22/25 (88%) | 22/25 (88%) | 24/25 (96%) | 24/25 (96%) | **24/25 (96%)** | = |
| MRR@10 | 0.740 | 0.760 | 0.780 | 0.843 | 0.893 | **0.883** | ↑ +0.040 |
| Negative pass rate | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | **5/5** | = |
| Avg tokens — Semantic | 3909 | 2818 | 2926 | 3106 | 3191 | **2740** | ↓ -366 |
| Avg tokens — Grep | — | — | — | — | — | **4868** | — |

† v4-hype-partial was a selection-bias artifact (only 13 of 4150 chunks had hyp embeddings — the 5 benchmark target files). Full HyPE run catastrophically regressed (R@1 44%, MRR 0.553) and was reverted. See `v4-hype-full.md` + `experiments/hype.md`.

## Per-Case Results

† v4 values: only the 5 benchmark target files had HyPE embeddings. All other cases are identical to v3-metadata — those chunks had no hyp embeddings so scores were unaffected.

| ID | Type | v1 | v2 | v3-meta | v4-hype† | **v5** | Δ v3→v5 |
|----|------|----|----|---------|----------|--------|---------|
| pluralize-duplicate | duplicate_detection | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| relative-time-duplicate | duplicate_detection | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| loading-state-components | duplicate_detection | 0.50 | 0.50 | 1.00 | 1.00 | **0.50** | ↓ regression |
| chat-name-needle | needle_in_haystack | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| truncate-scatter | scattered_pattern | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| error-state-hook | scattered_pattern | 1.00 | 0.00 | 0.33 | ~0.33 | **1.00** | ↑↑ fixed |
| retry-with-jitter | paraphrase | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| terminal-buffering | paraphrase | 0.00 | 0.50 | 1.00 | 1.00 | **1.00** | = |
| envelope-encryption | paraphrase | 1.00 | 1.00 | 1.00 | 1.00 | **0.25** | ↓ regression |
| unsaved-changes-guard | paraphrase | 1.00 | 0.50 | 0.50 | ~0.50 | **0.50** | = |
| version-update-classifier | paraphrase | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| concurrency-limiter | low_lexical_overlap | 0.00 | 0.00 | 0.00 | ~0.00 | **1.00** | ↑↑ fixed (JSDoc) |
| mcp-eager-load | low_lexical_overlap | 0.33 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| git-diff-splitter | low_lexical_overlap | 0.50 | 0.00 | 1.00 | 1.00 | **1.00** | = |
| stream-to-ui-events | low_lexical_overlap | 1.00 | 1.00 | 0.25 | 1.00 | **0.00** | ↓ regression |
| auth-state-mismatch | error_symptom | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| credential-blob-corrupt | error_symptom | 0.50 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| agent-execution-timeout | error_symptom | 0.50 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| tool-permission-denied | error_symptom | 0.50 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| pkce-verifier-lookup | needle_in_haystack | 1.00 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| mcp-boot-prefetch | needle_in_haystack | 0.33 | 1.00 | 0.50 | 0.50 | **1.00** | ↑↑ fixed |
| git-ipc-subscription | needle_in_haystack | 1.00 | 0.50 | 1.00 | 1.00 | **1.00** | = |
| lsp-transport-bridge | needle_in_haystack | 1.00 | 0.50 | 0.50 | 1.00 | **1.00** | ↑↑ fixed |
| flow-step-remote-execution | needle_in_haystack | 0.33 | 1.00 | 1.00 | 1.00 | **1.00** | = |
| mcp-oauth-and-tools | needle_in_haystack | 1.00 | 0.50 | 1.00 | 1.00 | **1.00** | = |
| negative-unrelated | negative | PASS | PASS | PASS | PASS | **PASS** | = |
| negative-too-generic | negative | PASS | PASS | PASS | PASS | **PASS** | = |
| negative-docker-config | negative | PASS | PASS | PASS | PASS | **PASS** | = |
| negative-webgl-shader | negative | PASS | PASS | PASS | PASS | **PASS** | = |
| negative-sql-migration | negative | PASS | PASS | PASS | PASS | **PASS** | = |

## Key Findings

- **Net positive vs v3-metadata baseline** (+0.040 MRR, same R@1/R@3/R@5 headline but different composition).
- **`concurrency-limiter` finally fixed** (0.00 → 1.00, all previous versions): The file `bounded-execute-handler.ts` had a module-level JSDoc block containing "agent executions allocate large per-stream heap… every chat-pane that triggers an execute request runs in parallel and the JS heap is overrun." The chunker was discarding this block because `container.start` points to the `export` keyword, not the preceding comment. New line-scanning approach collects pre-declaration JSDoc blocks and prepends them — giving the describer the exact domain vocabulary that queries use.
- **`error-state-hook` fully recovered** (0.33 → 1.00): File context let the LLM situate the hook within its React component tree, producing a description that matched the error-recovery query vocabulary.
- **`lsp-transport-bridge` and `mcp-boot-prefetch` fixed** (both 0.50 → 1.00): File context resolved the disambiguation that path+symbol prefix alone couldn't.
- **`envelope-encryption` regressed** (1.00 → 0.25): Two near-duplicate files — `src/main/lib/credential-crypto.ts` and `socket-server/src/lib/credential-crypto.ts` — now get subtly different file context (main process vs socket server) and produce slightly different descriptions. The competitor ranks above the target. Root cause: contextual retrieval breaks same-logic duplicate detection when the surrounding file context differs between duplicates.
- **`loading-state-components` regressed** (1.00 → 0.50): File context changed description wording enough to shift ranking between two similar loading-state components.
- **`stream-to-ui-events` regressed further** (0.25 → 0.00): File context on renderer-side message files amplified the false-positive signal that was already causing ranking issues in v3-metadata. Target dropped out of top-10 entirely.
- **Token efficiency improved**: Semantic query avg drops 366 tokens vs v3-metadata (2740 vs 3106). Likely due to embeddinggemma being more efficient than nomic-embed-text which was used in v3.

## Remaining Hard Cases

| Case | MRR | Root cause | Next angle |
|------|-----|------------|------------|
| stream-to-ui-events | 0.00 | Renderer message files amplified by file context | GitNexus caller injection — callers are in main process, would disambiguate |
| envelope-encryption | 0.25 | Duplicate file with different surrounding context | Deduplication: when two chunks share identical `codeHash`, merge into single result |
| loading-state-components | 0.50 | Two similar loading-state implementations | Same dedup approach, or tighter file context for shared utils |
| unsaved-changes-guard | 0.50 | `DirtyNavAlertDialog` ranks above the hook | Caller context from GitNexus would distinguish guard (called everywhere) from dialog (single use) |

## Decision

v5-contextual-retrieval is adopted as the new baseline. The JSDoc fix alone is worth it (`concurrency-limiter` was 0.00 across all 4 previous versions). Contextual retrieval adds MRR gains despite the duplicate-detection regression — the net is positive.
