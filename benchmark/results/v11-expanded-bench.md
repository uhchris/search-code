# Benchmark v11: Expanded with Real-World Failure Modes (33 → 40 cases)

**Date:** 2026-05-07
**Trigger:** User real-world feedback ("hit rate ~50%, keeps slipping back to grep on exact-token queries"). Investigation found the prior 33-case bench did not include the failure modes the user actually hit in production. Mined 136 session JSONL files for `searchCode` queries, extracted patterns, identified 3 query types with zero coverage in the existing bench.
**Method:** Added 7 new positive cases drawn from session history, with ground truth verified via grep. Three new query types introduced.

## Headline numbers

| Metric | v9 (33-case original) | **v11 (40-case expanded)** | Δ |
|--------|---|---|---|
| Recall@1 | 76% (25/33) | **68%** (27/40) | -8pp |
| Recall@3 | 88% (29/33) | 85% (34/40) | -3pp |
| Recall@5 | 94% (31/33) | 90% (36/40) | -4pp |
| MRR@10 | 0.825 | **0.764** | -0.061 |
| Negative pass rate | 8/9 | 8/9 | = |
| Avg tokens — Semantic | 2598 | 2754 | +6% |

The drop is **not a regression** — the implementation is unchanged (commit `ba55b8d05`). The 8pp R@1 drop reflects that the bench was previously overstating accuracy by excluding the failure modes the user actually encounters. Real R@1 is 68%.

## New query types and rationale

| Type | Description | Real-world example |
|------|------------|--------------------|
| `exact_symbol_with_context` | Agent knows the exact identifier and wraps it in disambiguating prose to specify which one they mean. Tool's description channel doesn't index symbol names verbatim; FTS5 AND-combine kills BM25 path due to verbose wrapping. | "disconnectIntegration trpc proc handler local repo path" — same symbol exists in 2 files (cloud client + tRPC router); agent wants the router |
| `concept_with_constraint` | Concept query plus a narrowing clause (flag-gate, path constraint, "after migration X"). Tests whether the constraint shifts ranking. | "internal flows MCP server registration for Claude agent gated by launch flag" — concept + flag-gate constraint |
| `concept_resolves_to_symbol` / `concept_resolves_to_schema` | Concept that ultimately maps to a specific repo file, schema definition, or other plumbing-style file. The plumbing files have generic descriptions; the concept doesn't surface them. | "read user integrations from local SQLite repo besides router list" — wants `db/repos/user-integrations.ts` |

## Per-case results — 7 new cases

| ID | Type | R@1 | R@3 | R@5 | MRR | Verdict |
|----|------|-----|-----|-----|-----|---------|
| trpc-disconnect-integration-handler | exact_symbol_with_context | ✗ | ✓ | ✓ | 0.33 | Right file top-3, wrong chunk |
| trpc-generate-webhook-endpoint | exact_symbol_with_context | ✗ | ✓ | ✓ | 0.50 | Right file top-3, wrong chunk |
| user-integrations-repo-readers | concept_resolves_to_symbol | ✗ | ✗ | ✗ | 0.00 | **Total miss** |
| crossmachine-flag-gates | concept_with_constraint | ✓ | ✓ | ✓ | 1.00 | WIN |
| internal-mcp-launch-flag-gate | concept_with_constraint | ✓ | ✓ | ✓ | 1.00 | WIN |
| chat-data-shape-schema | concept_resolves_to_schema | ✗ | ✗ | ✗ | 0.00 | **Total miss** |
| flows-mcp-tools-server-register | concept_with_constraint | ✗ | ✓ | ✓ | 0.50 | Right file top-3 |

**R@1 on new cases: 2/7 = 29%.** R@5: 5/7 = 71%.

## Three measurable failure modes

### Failure mode 1 — same-file, multi-chunk: dedup-by-file picks wrong chunk

Cases: `trpc-disconnect-integration-handler`, `trpc-generate-webhook-endpoint` (and likely many more in production).

The target file `src/main/lib/trpc/routers/integrations.ts` is 1500+ lines, chunked into ~20 procedure-sized chunks. Each chunk has its own description. When the agent queries "disconnectIntegration trpc proc handler local repo path":
- Some chunks of integrations.ts score moderately (0.40-0.48)
- The dedup-by-file logic in `searchBySimilarity` keeps only the HIGHEST-scoring chunk per file
- That highest-scoring chunk is often `encryptToken` (a generic helper at line 98) not the actual `disconnectIntegration` handler at line 1435
- The wrong chunk's description surfaces as the file's representative

The right file IS in top-3, but the chunk-level signal is lost.

**Fix candidates:** (a) keep the symbol_name + line range that actually scored, surface in result, so agent can navigate within file; (b) re-rank multi-chunk same-file by symbol_name match against query tokens (no regex needed — just exact substring of query against `chunks.symbol_name`); (c) switch dedup to top-K-per-file instead of top-1.

### Failure mode 2 — generic descriptions on plumbing code

Cases: `user-integrations-repo-readers`, `chat-data-shape-schema` (R@5=0 — total misses).

Repo files (`db/repos/*.ts`) have descriptions like "Returns a user integration by ID. Looks up by primary key." Schema files (`db/schema/index.ts`) have descriptions like "Drizzle table definition for sub-chat sessions". These descriptions are syntactically correct but **don't surface the domain semantics** the agent queries for ("read user integrations from local SQLite repo", "chat data shape with sandbox_id session_id stream_id messages").

The query mentions: `user integrations`, `local SQLite repo`, `sandbox_id`, `session_id`, `stream_id`, `messages`. The descriptions mention: `Returns a user integration by ID`, `Drizzle table definition for sub-chat sessions`. The vocabulary doesn't bridge.

**Fix candidates:** (a) describer prompt change — for repo/schema files, surface column names and table relationships explicitly; (b) embed text format change — include the rawCode signature alongside description for plumbing files; (c) AST chunker enhancement — emit per-table-definition chunks for schema files.

### Failure mode 3 — concept-dominance rescues (control)

Cases: `crossmachine-flag-gates`, `internal-mcp-launch-flag-gate` — both PASSED.

When the query has a strong concept signal (MCP server registration, socket connection / remote dispatch), the current arch works. The `gated by launch flag` clause adds a constraint but doesn't drown the concept signal. These pass at R@1.

This validates that the existing architecture is fine **for concept-heavy queries**. The other two failure modes are where the gap is.

## Implications for future experiments

Previous experiments were measured against the 33-case bench, which had built-in selection bias toward concept queries the tool wins on. Real R@1 is 68%, not 76%. The 8pp gap is exactly the kind of cases that drove the user back to grep in production.

Future bench targets:
- Beat **68% R@1** on the 40-case bench (not 76% on 33)
- Specifically lift the 5 failures: 2 same-file-chunk-dedup losses + 2 generic-description total misses + 1 concept+constraint near-miss

Failure-mode-targeted experiments (any one could land):

1. **Same-file dedup change** — return top-2-per-file instead of top-1; agent reasons over both. ~10 lines in `searchBySimilarity`. Measurable target: lift the 2 R@3 cases to R@1.

2. **symbol_name boost** — when query's literal substring matches a chunk's `symbol_name` (AST-extracted, no regex), boost that chunk's score. The two same-file misses both have the symbol literal in the query (`disconnectIntegration`, `generateWebhookEndpoint`). ~15 lines in `searchByCodeBm25` or new path. Measurable target: same as #1.

3. **Schema-aware describer** — different prompt for files matching `db/schema/*` and `db/repos/*` patterns. Describer surfaces table names + column names + caller summary. Reindex required. Measurable target: `chat-data-shape-schema` and `user-integrations-repo-readers` lift from 0.

4. **Embed text format for plumbing** — for repo/schema files, append `${filePath}\n${signature line}` (signature line = first export/declaration). Cheap, no LLM. Measurable target: same as #3.

## Out of scope (deferred)

- HyDE / query rewriting: tested in C.1, flat result.
- Code-only embedding: tested in v10, regressed.
- BM25 over rawCode: tested in v9, inert on verbose queries.
- jina-reranker-v3: still untested; would target the 2 R@3 same-file cases.

## Decision

Bench expansion shipped. Future retrieval experiments measured against R@1=68% baseline on 40-case bench. Don't compare to the prior 76% — that number was overstated.

Next experiment recommendation: try failure-mode-targeted fix #1 (top-2-per-file dedup) — minimal code change, directly targets 2 of the 7 new cases. ~15 min work + bench. If it works, 2 cases move from R@3 to R@1, headline goes from 68% to 73%.
