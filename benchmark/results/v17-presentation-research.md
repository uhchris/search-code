# v17 — Hybrid Retrieval Result Presentation Research

**Question.** Three independent retrievers (description embedding, code embedding, BM25) are fused via RRF (K=60). What does retrieval research say about how the fused list should be PRESENTED to an agent that has to act on it?

Three options on the table:
- **A.** Show winning channel only (description if desc-channel won, code if code-channel won, BM25-highlighted excerpt if BM25 won).
- **B.** Show per-channel ranks + description + code (full transparency).
- **C.** Segregated lists per channel (no fusion at display time).

## TL;DR — recommendation

**Pick C-lite, fall back to B. Reject A.**

- **C-lite** = keep the RRF-merged list, but **always show the rawCode chunk** as the canonical body (one signal per row), and surface description + per-channel rank as **compact metadata on the same row**. This is what every production hybrid retrieval engine does.
- **A is wrong**: hiding the code on a description-channel win is the opposite of what every system in the literature does. The retrieved object is the code; description is metadata about why it was retrieved.
- **B (full per-channel ranks visible)** is the production-engine default (Vespa `match-features`, Weaviate `explainScore`) and is research-defensible — but the scores are noise to an agent that just wants the code.

The user's pushback is correct that description and code are orthogonal signals. The fix is **not** to alternate which one is shown — it's to recognise that the **code is the retrieved object** and the description is a retrieval-time explanation feature.

---

## What the original RRF paper actually says

Cormack, Clarke, Buettcher (SIGIR 2009), "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods" (https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf, https://dl.acm.org/doi/10.1145/1571941.1572114).

**The paper is silent on presentation.** It is a fusion-algorithm + evaluation-metric paper (TREC, LETOR 3, MAP/P@10/NDCG). The output of RRF is a single ranked list of documents, and the paper reports retrieval-effectiveness numbers on that single list. There is no discussion of:
- whether to surface per-channel ranks/scores
- whether to segregate per-channel lists at display time
- what metadata to attach to each result

So **research is silent on the specific UX question for RRF.** Anyone citing Cormack 2009 to justify a particular presentation is over-claiming.

## What production hybrid retrieval engines do

These are the canonical references for "how do you actually ship this":

**Vespa** (https://docs.vespa.ai/en/ranking/ranking-expressions-features.html, https://blog.vespa.ai/redefining-hybrid-search-possibilities-with-vespa/). Each hit carries `matchfeatures` showing individual ranking signals — `bm25(text)`, `bm25(title)`, `closeness(field,embedding)`. Per-channel scores are exposed as **debug-side metadata on the merged list**, not as separate lists. Default is "show the document; per-signal scores are available if you ask for them."

**Weaviate** (https://docs.weaviate.io/weaviate/search/hybrid, https://weaviate.io/blog/hybrid-search-fusion-algorithms). `explainScore` returns the BM25 contribution and the vector contribution per result, on the same merged hit. Same pattern: one merged ranked list, per-channel attribution available as opt-in metadata.

**Cursor** (https://cursor.com/blog/semsearch, https://cursor.com/docs/context/codebase-indexing). Cursor's hybrid (semantic + grep) retrieval returns "obfuscated file paths and line ranges of the most relevant code chunks." The **retrieved object is the code**, not the description. The agent then reads chunks locally.

**claude-context** (the leading code-search MCP, cloned at `cloned-projects/claude-context`). The actual MCP output format from `packages/mcp/src/handlers.ts:764-773`:

```
${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]
   Location: ${location}
   Rank: ${index + 1}
   Context:
   ```${language}
   ${context}
   ```
```

It returns **only the code excerpt**. No description channel. No per-channel rank. One merged list, code body, location, rank. (This isn't because they considered B/C and rejected — they don't even have a description channel.)

**Continue.dev** (https://docs.continue.dev/customize/context/codebase, https://blog.continue.dev/accuracy-limits-of-codebase-retrieval/). Two-stage: ~50 candidates from vector DB → reranker → top 10 code chunks fed to the LLM. The chunks are the body; channel attribution is internal to the pipeline.

**Pattern across all of them:** merged ranked list, code is the body, per-channel attribution is opt-in debug metadata. **Nobody does A. Nobody does pure C.**

## Lost-in-the-middle and per-result token cost

Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" (arXiv:2307.03172, https://arxiv.org/abs/2307.03172). Verbatim: *"performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts, even for explicitly long-context models."*

The paper does **not** prescribe a result format. What it does say: long contexts dilute attention. So **per-result bloat has a real cost** — every byte of "rank: desc:#3 code:#1 bm25:#--" pushes the actually-useful code further into the middle. This argues against B's full per-channel rank table being the default presentation.

## Honest verdict on each option

**A — show winning channel only.** Not supported by any production system. The retrieved object in code search is code; replacing it with a description on description-channel wins throws away the thing the agent needs. There is no research backing this.

**B — full per-channel ranks + description + code.** Defensible: Vespa and Weaviate expose this as opt-in debug. As a default it inflates every result row with metadata an agent rarely uses, costing context (Liu 2023). Use as opt-in.

**C — segregated lists per channel.** No production code-search engine does this. Cormack 2009's whole point was that **the merged list outperforms any individual ranker**; reverting to three lists discards that gain and forces the agent to re-fuse mentally.

## The actual answer: C-lite (single merged list, code-body-canonical)

```
1. src/main/auth/jwt.ts:42-78  [func validateJWT]
   why: validates JWT signature against JWKS and checks expiry  (desc:#3 code:#1 bm25:#--)
   ```ts
   <rawCode excerpt>
   ```
```

- Body = code (always). The retrieved object is what the agent acts on.
- Description = one-line "why" annotation, not a wall of text.
- Per-channel rank = compact one-line tag, useful when an agent needs to debug a miss.
- One merged RRF list, not three.

This matches: Vespa match-features, Weaviate explainScore, Cursor's "retrieve chunks then read locally", claude-context's code-only output, and Continue.dev's two-stage pipeline. It respects Liu 2023 by keeping per-result bloat low. It respects Cormack 2009 by keeping the merged list as the single ranked output.

## Sources

- Cormack, Clarke, Buettcher (SIGIR 2009), https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf, https://dl.acm.org/doi/10.1145/1571941.1572114
- Liu et al. (arXiv:2307.03172), https://arxiv.org/abs/2307.03172
- Weaviate hybrid + explainScore, https://docs.weaviate.io/weaviate/search/hybrid, https://weaviate.io/blog/hybrid-search-fusion-algorithms
- Vespa hybrid + match-features, https://docs.vespa.ai/en/ranking/ranking-expressions-features.html, https://blog.vespa.ai/redefining-hybrid-search-possibilities-with-vespa/
- Cursor semantic search, https://cursor.com/blog/semsearch, https://cursor.com/docs/context/codebase-indexing
- Continue.dev codebase retrieval, https://docs.continue.dev/customize/context/codebase, https://blog.continue.dev/accuracy-limits-of-codebase-retrieval/
- claude-context MCP format, local: `cloned-projects/claude-context/packages/mcp/src/handlers.ts:764-773`

## Citation honesty notes

- **Cormack 2009 says nothing about presentation.** Anyone (including me, in earlier sessions) citing it for "show fused only" or "show per-channel" is over-claiming. It only justifies the merge step, not the display step.
- **Lost-in-the-middle does not prescribe a result format.** It only says long contexts hurt. The link to "keep per-result bloat low" is an inference, not a quote.
- **No research paper found that directly evaluates A vs B vs C for agent-consumed code retrieval.** The verdict above leans on production-engine convergence + the negative space (nobody does A or pure C) rather than a controlled study. Be honest about that.
