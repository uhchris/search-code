# v13 — per-property chunks for tRPC-router pattern (Mode 1 fix)

**Date:** 2026-05-08
**Trigger:** v12 fixed Mode 2 (Drizzle/exported declarations chunked) but Mode 1 (`trpc-disconnect`, `trpc-generate-webhook`) stayed at R@3 / R@5. Root cause traced: tRPC routers are 1500+ line `VariableDeclaration`s with `init = CallExpression(router, ObjectExpression{...})`. Chunker capped at maxChunkLines=300 → handler at line 1435 never indexed.

## Headline numbers vs v11 baseline

| Metric | v11 | v12 (manifest + Drizzle chunker) | **v13 (+ per-property chunks)** | Δ v11→v13 |
|--------|---|---|---|---|
| Recall@1 | 27/40 = 68% | 25/40 = 63% | 25/40 = 63% | −5pp |
| Recall@3 | 34/40 = 85% | 34/40 = 85% | **35/40 = 88%** | **+3pp** |
| Recall@5 | 36/40 = 90% | 37/40 = 93% | 37/40 = 93% | +3pp |
| MRR@10 | 0.764 | 0.748 | 0.753 | −0.011 |
| Negative pass | 8/9 | 8/9 | 8/9 | = |
| Total chunks | 4983 | 5712 | **6083** | +1100 |

## Failure-mode case results (v11 → v13)

| Case | v11 | v12 | v13 | Outcome |
|------|-----|-----|-----|---------|
| trpc-disconnect-integration-handler | R@3 ✓ MRR 0.33 | R@5 ✓ MRR 0.25 | **R@1 ✓ MRR 1.00** | **Mode 1 WIN** |
| trpc-generate-webhook-endpoint | R@3 ✓ MRR 0.50 | R@1 ✓ MRR 1.00 | **R@1 ✓ MRR 1.00** | stable |
| user-integrations-repo-readers | R@5=0 | R@1 ✓ MRR 1.00 | **R@1 ✓ MRR 1.00** | Mode 2 WIN (chunker fix) |
| chat-data-shape-schema | R@5=0 | R@3 ✓ MRR 0.33 | **R@3 ✓ MRR 0.33** | Mode 2 partial (R@3) |
| crossmachine-flag-gates | R@1 ✓ | R@1 ✓ | R@1 ✓ | stable |
| frink-mcp-launch-flag-gate | R@1 ✓ | R@1 ✓ | R@1 ✓ | stable |
| flows-mcp-tools-server-register | R@3 ✓ MRR 0.50 | R@3 ✓ MRR 0.50 | R@3 ✓ MRR 0.50 | stable |

**Net failure-mode coverage: 4 of 7 R@1 (was 2 of 7); all 7 R@3 (was 4 of 7).**

## Implementation

`src/chunker.ts:extractObjectPropertyChunks()` — when a top-level exported `VariableDeclaration` has `init` of type `CallExpression`, walk into the call's arguments and emit a sub-chunk for each non-computed `Property` whose value spans ≥80 bytes (≈3 lines).

```ts
function extractObjectPropertyChunks(initNode, out) {
  if (initNode?.type !== 'CallExpression') return;
  for (const arg of initNode.arguments ?? []) {
    if (arg?.type !== 'ObjectExpression') continue;
    for (const prop of arg.properties ?? []) {
      if (prop?.type !== 'Property' || prop.computed) continue;
      const keyName = prop.key?.type === 'Identifier' ? prop.key.name
        : prop.key?.type === 'Literal' && typeof prop.key.value === 'string' ? prop.key.value
        : null;
      if (!keyName) continue;
      if ((prop.value.end - prop.value.start) < PROPERTY_CHUNK_MIN_BYTES) continue;
      out.push({ startOffset: prop.start, endOffset: prop.end, symbolName: keyName });
    }
  }
}
```

The 80-byte threshold means Drizzle column defs (1-line `text('id')`) are skipped — they stay aggregated in the parent table chunk. tRPC procedures (multi-line `.input(...).mutation(...)`) are emitted individually.

`integrations.ts` chunk count: 14 → 33 (added 19 per-procedure chunks including `disconnect`, `generateWebhookEndpoint`, `connectShortcut`, `connectGmail`, `connectGithub`, `rotateWebhookSecret`, …).

## R@1 net-zero analysis

v13 R@1 unchanged at 25/40 vs v12, but the case mix changed:

| Case | v12 R@1 | v13 R@1 | |
|------|---|---|---|
| trpc-disconnect-integration-handler | ✗ | ✓ | **WIN** (Mode 1 fix) |
| chat-name-needle | ✓ | ✗ | apparent loss |

`chat-name-needle` — query "generates a name for a chat conversation using an LLM". v13 top result is `chat-name.ts:14 generateSubChatName` — a tRPC procedure that wraps `generateBestEffortChatName`. The expected files (`chat-name-generator.ts`, `name-generation.ts`, `name-generation-async.ts`) sit at ranks 2-4. Ground-truth marks rank 1 as wrong because it's the router endpoint not the implementation.

This is bench rigidity, not a real regression: the agent in production gets a useful entry point at #1 that delegates to the implementation. The bench narrowly defines correct files. Did not adjust ground-truth — flagging for future review.

## Cumulative path summary

v11 → v13 changes (all in `.claude/tools/search-code/src/`):

1. `chunker.ts:extractManifest()` — AST-position-aware identifier extraction (gates `TS*`-prefixed subtrees, no name-based stoplist). Grounded in GraphCodeBERT §3 + CodeT5 §4.1; prefix placement via arXiv:2412.15241.
2. `chunker.ts` `VariableDeclaration` handler — emits chunks for any top-level **exported** `VariableDeclaration` regardless of init kind (Mode 2 root cause: Drizzle/exported config previously emitted 0 chunks).
3. `chunker.ts:extractObjectPropertyChunks()` — for exported CallExpression patterns, emits a sub-chunk per multi-line `Property` (Mode 1 root cause: tRPC routers truncated at maxChunkLines).
4. `embedder.ts:buildEmbedText()` — prepends the AST manifest before the description so plumbing files surface domain vocabulary in dense space.

Things tried and reverted:
- Hardcoded keyword stoplist (lazy hack, replaced with structural TS-subtree gating)
- Top-2-per-file dedup (Spike Hijacking citation didn't translate; net negative)
- camelCase tokenizer for BM25 (anti-pattern, rejected pre-v9)

## Honest framing

- Manifest-as-prefix is engineering extrapolation grounded in code-retrieval research, not a directly cited algorithm.
- The R@1 −5pp vs v11 is real cost — added 1100 chunks compete in cosine ranking, occasionally displacing the right chunk for paraphrase queries that already had R@1.
- Mode 1 + Mode 2 wins (4 of 7 → R@1, 7 of 7 → R@3) directly address the user feedback that triggered v11-expansion.

## What's left (deferred)

- 3 chronic total-miss cases (`envelope-encryption`, `stream-to-ui-events`, `ipc-git-events-subscription`) — pre-date v11, persist through all variants. Need different mechanism (likely query-side rewriting or a different embedder).
- `chat-data-shape-schema` only at R@3 — the schema chunk is rank 3, competitor chunks (socket/client.ts, sub-chats handlers) win on cosine due to richer descriptions. Would require describer-side change for plumbing files.
- `chat-name-needle` ground-truth review.
