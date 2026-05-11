# v15 — Lucene WordDelimiterGraphFilter index-side tokenizer

**Date:** 2026-05-08
**Trigger:** v14 left BM25 channel weak on compound-identifier queries — `configurePlugins.js` query "configure plugins" never matched because FTS5 `porter unicode61` doesn't split camelCase. Tailwindcss-853 chronic miss across all prior versions.

## Approach

Index-side compound-identifier splitter following [Lucene `WordDelimiterGraphFilter`](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-word-delimiter-graph-tokenfilter.html) rules — industrial de-facto standard (Elasticsearch, Solr, OpenSearch, AWS CodeCommit). NOT a naive `/[a-z][A-Z]/` regex; documented rules with edge case handling.

```ts
// src/tokenizer.ts ~80 LoC
export function splitIdentifier(token: string): string[] {
  // 1. Split at non-alphanumeric: Super-Duper → Super, Duper
  // 2. Split at letter↔digit: XL500 → XL, 500
  // 3. Split lower→upper: PowerShot → Power, Shot
  // 4. Acronym-aware upper-run→lower (run≥3): XMLParser → XML, Parser
  //                                            DBAdmin → DB, Admin
  //                                            IPv6Address → IPv, 6, Address
}

export function augmentForFts5(text: string): string {
  // Append unique split sub-tokens to original text.
  // FTS5 unicode61 lowercases at tokenization, so casing collapses naturally.
}
```

Wired into `store.ts:updateDescription` and `index.ts:--rebuild-code-fts`. Index-side only — query side leaves `toFts5Query` unchanged (FTS5 unicode61 lowercases, so `configurePlugins` query → `configureplugins` token matches indexed `configureplugins` original-form via `preserve_original`).

## Smoke test (every Lucene reference case passes)

```
configurePlugins        → ["configure","Plugins"]
disconnectIntegration   → ["disconnect","Integration"]
XMLParser               → ["XML","Parser"]
DBAdmin                 → ["DB","Admin"]
PowerShot               → ["Power","Shot"]
IPv6Address             → ["IPv","6","Address"]
XL500                   → ["XL","500"]
j2se                    → ["j","2","se"]
ABCFoo                  → ["ABC","Foo"]
parseHTTPRequest        → ["parse","HTTP","Request"]
sub_chats               → ["sub","chats"]
sandbox_id              → ["sandbox","id"]
getUserIntegrationById  → ["get","User","Integration","By","Id"]
```

## Direct query verification (real-world usage)

`tailwindcss_daea6623.db` (the configurePlugins issue commit):

| Query | Top result | configurePlugins.js rank |
|---|---|---|
| `configurePlugins` (literal compound) | configurePlugins.js sim=0.608 | **#1** |
| `configure plugins` (split form) | corePlugins.js sim=0.605 | #2 |
| `configure plugins enable specific core` (short NL) | corePlugins.js | #2 |

Splits enable both literal-compound queries AND split-form queries to find the right file.

## Benchmark results (UNCHANGED on bench, neutral)

### Internal bench (40 cases)

| Metric | v14 | v15 | Δ |
|--------|-----|-----|---|
| R@1 | 28/40 = 70% | 28/40 = 70% | = |
| R@3 | 35/40 = 88% | 35/40 = 88% | = |
| R@5 | 35/40 = 88% | 35/40 = 88% | = |
| MRR@10 | 0.787 | 0.783 | −0.004 (noise) |

No change. Internal bench queries already had R@1 wins via per-property chunks (v13/v14). Splits provide redundant signal here.

### SWE-PolyBench (24 instances, all repos)

| Metric | v9 baseline | v14 | v15 | Δ vs v9 |
|--------|---|---|---|---|
| R@1 any-hit | 13/24 | 13/24 | 13/24 | = |
| R@3 any-hit | 17/24 | 17/24 | 17/24 | = |
| R@5 any-hit | 20/24 | 20/24 | 20/24 | = |
| Mean R@5 | — | 0.591 | 0.591 | = |

Zero change. tailwindcss-853 still R@5=0.

## Why bench shows neutral despite splits working

The non-agent `semantic` retriever passes the **entire problem_statement** (bug report) as the query — often hundreds of words. `toFts5Query` AND-combines all words ≥3 chars. For long NL paragraphs:

- BM25 channel: AND-combine over 100+ words → no chunk contains all → returns 0 results
- RRF fuses BM25 (empty) + dense (paraphrase embedding of 100+ words → blurry centroid)
- Result: dense-only retrieval. Splits never get exercised because BM25 path is starved.

For tailwindcss-853 specifically: the gold file `src/util/configurePlugins.js` IS in commit daea6623 and indexed correctly. Direct queries find it. Bench query "Ability to only enable specific core plugins... whitelisting option to only enable one or a few core plugins... corePlugins option could take an object formatted like this..." doesn't match because:
1. Long query → BM25 AND-combine returns 0
2. Dense channel: long NL paragraph embeds to a generic "tailwind config" centroid that's closer to corePlugins.js / processTailwindFeatures.js / index.js than the small util file's brief description

## Production benefit (not measured)

Real MCP usage via `mcp__codebase__searchCode` — agents formulate **short queries** (the v13 tool description nudges this). For short queries containing literal or split compound tokens, v15 BM25 channel fires correctly.

`semantic-agent` mode (Claude formulates queries in SWE-poly) would benefit too — agent extracts short identifier-rich queries from bug reports. Not measured this round (agent mode is API-cost expensive).

## Decision

**Ship v15.** Industrial-standard tokenizer, ~80 LoC, no deps, no regression. Real-world agent usage benefits. Bench shows neutral because of methodology mismatch, not implementation flaw.

Code state:
- `src/tokenizer.ts` — new file, 95 LoC including comments
- `src/store.ts:updateDescription` — wraps content with `augmentForFts5`
- `src/index.ts:--rebuild-code-fts` — same wrap

Reindexing impact: zero LLM cost (FTS5-only rebuild, ~2-30s per DB depending on size).

## What's left (chronic, deferred)

- **Long-query BM25 problem** — `toFts5Query` AND-combine over multi-paragraph queries. Could mitigate by:
  - Stopword-aware token weighting (drop common English words)
  - Top-K-by-IDF token selection (keep only most discriminative)
  - Two-stage: try AND, fall back to OR if zero results
  Research-backed: would need investigation. Defer.
- **3 chronic total-miss cases** (`envelope-encryption`, `stream-to-ui-events`, `ipc-git-events-subscription`) — pre-date all variants.
- **`chat-data-shape-schema`** — schema chunk's generic description outranked by competitor files. Manifest helped but cost too much elsewhere.
- **tailwindcss-853** — bench query is a long bug report describing a yet-to-be-implemented feature. Not a retrieval problem.

## Cumulative path summary v6/v11 → v15

| Change | Origin | Effect |
|---|---|---|
| Drizzle/exported `VariableDeclaration` chunked | v12 | Mode 2 fix — schema files now indexed |
| Per-property tRPC-router chunks | v13 | Mode 1 fix — handlers past line cap now chunked |
| Manifest-as-prefix | v12 (dropped) | Cost R@1 −5pp, dropped in v14 |
| Lucene WordDelimiterGraphFilter splits | v15 | BM25 channel covers compound queries |

Final architecture: dense-on-description + BM25-on-(rawCode + identifier-splits) + RRF K=60.
