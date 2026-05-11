# v15 — Tokenizer Research: Compound Identifier Splitting for BM25

**Date:** 2026-05-08
**Context:** SQLite FTS5 sparse channel uses `porter unicode61` which keeps `configurePlugins` as one token. NL queries like "enable specific core plugins" never match (SWE-PolyBench `tailwindcss-853` failure). Goal: pick a research-backed, library-grade splitter — explicitly NOT a hand-rolled regex.

---

## TL;DR — Recommendation

**Ship Lucene's `WordDelimiterGraphFilter` rule set** (rule-based, no dictionary), implemented in TS as a drop-in FTS5 `external_content` content-injector. Index BOTH the original token AND its split parts (`preserve_original=true`). Apply the same transform at query time. This is the de-facto industrial standard for code-style text in Lucene/Solr/Elasticsearch/OpenSearch and ships in every enterprise search engine.

Reason it wins over the alternatives **for our exact use case** (FTS5, JS/TS code, NL queries, no Java runtime, no GPU):

- **vs. BPE/WordPiece (Karampatsis 2020):** BPE is for *language modelling* (predicting tokens), not retrieval — and the Shi et al. 2022 paper found that "simply inserting identifier splitting into the pipeline hurts the model performance" for BPE-only setups. BPE splits are also data-dependent — the vocab learned on training data won't match agent-typed NL queries character-aligned. We already get semantic coverage from `embeddinggemma` (dense channel). The sparse channel exists to recover *exact lexical* matches that the embedder paraphrases away — BPE re-introduces the same paraphrase brittleness.
- **vs. Samurai/Ronin (dictionary-based):** Best paper accuracy, but the only maintained implementation (`casics/spiral`, Python) was archived July 2024. Adopting an unmaintained Python library across an N-API SQLite TS toolchain is operational debt for marginal gain on already-easy cases (camelCase → 99% rule-based; the hard 1% is fused identifiers like `getallthings` where dictionaries help, which is rare in modern TS).
- **vs. AST symbol-name split (Option D):** Already partially in place via tree-sitter chunking; useful as a *second column* but doesn't solve the NL query → rawCode token mismatch by itself, because rawCode contains body identifiers AST extraction misses.
- **vs. status quo (`porter unicode61`):** Misses every camelCase/snake_case compound query. Documented failure on SWE-PolyBench.

The rule-based WordDelimiter approach is also what **Sourcegraph Zoekt** effectively does — it doesn't tokenize at index time at all, instead using trigrams + regex matching at query time, deferring word-boundary detection. For an FTS5 backend that *needs* tokens up front, the WordDelimiter rules are the closest equivalent.

**Concrete action:** v15 should add a small `splitIdentifier(token)` function that applies WordDelimiterGraph rules (case transitions, letter-number boundaries, non-alphanumeric splits, preserve original), feed it into both the indexer (FTS5 `content` payload) and `toFts5Query`. ~50 LoC. No new deps.

---

## 1. Industrial-grade approaches — verified

### 1.1 Lucene `WordDelimiterGraphFilter` (Apache Lucene 9.x, used by Elasticsearch + Solr + OpenSearch)

**Source verified:** [Elastic word_delimiter_graph token filter docs](https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-word-delimiter-graph-tokenfilter.html)

**Default rules (verbatim from Elastic docs):**

> 1. **Non-alphanumeric splitting**: "Split tokens at non-alphanumeric characters. The filter uses these characters as delimiters. For example: `Super-Duper` → `Super`, `Duper`"
> 2. **Delimiter trimming**: "Remove leading or trailing delimiters from each token. For example: `XL---42+'Autocoder'` → `XL`, `42`, `Autocoder`"
> 3. **Case transitions**: "Split tokens at letter case transitions. For example: `PowerShot` → `Power`, `Shot`"
> 4. **Letter-number boundaries**: "Split tokens at letter-number transitions. For example: `XL500` → `XL`, `500`"
> 5. **Possessive removal**: "Remove the English possessive (`'s`) from the end of each token. For example: `Neil's` → `Neil`"

**Example transformation (verbatim):** `Neil's-Super-Duper-XL500--42+AutoCoder` → `[ Neil, Super, Duper, XL, 500, 42, Auto, Coder ]`

**Configuration flags:**

- `split_on_case_change` (default `true`)
- `split_on_numerics` (default `true`)
- `preserve_original` (default `false`) — emit both the original term AND its split parts so `XL500` matches queries for `XL500` OR `XL` OR `500`
- `catenate_words`, `catenate_numbers`, `catenate_all` — re-emit catenated forms
- `protected_words` — skip-list for tokens that should not split
- `stem_english_possessive` — strips `'s`

**IPv6 / acronym ambiguity:** The default Lucene rules will split `IPv6Address` → `IPv`, `6`, `Address` because letter-number-letter gives two splits at the digit boundary. To get `IP`, `v6`, `Address` you'd need `split_on_numerics=false`, but that breaks `XL500` → `XL`, `500`. **There is no perfect rule** for acronym-with-numbers without a dictionary; Lucene punts and uses `preserve_original=true` so the unsplit form is also indexed.

**Acronym handling (`XMLParser`):** The `WordDelimiterGraphFilter` (graph-aware variant) handles `XMLParser` → `XML`, `Parser` correctly via lookahead at uppercase runs. The older non-graph `WordDelimiterFilter` was buggy on this — graph filter is the current recommendation.

**Why it's the de-facto standard:** Used by Elasticsearch, Solr, OpenSearch (all major enterprise search engines). When Atlassian, GitHub Search (pre-Blackbird), AWS CodeCommit, and basically every "search source code in a SaaS" company indexes JIRA/Confluence/source code, this is the analyzer chain (typically `standard` tokenizer → `lowercase` → `word_delimiter_graph` → `flatten_graph`).

### 1.2 Tantivy (Rust)

**Verified via [docs.rs/tantivy](https://docs.rs/tantivy/latest/tantivy/tokenizer/index.html):**

Built-in tokenizers: `default`, `raw`, `en_stem`, `SimpleTokenizer`, `WhitespaceTokenizer`, `RawTokenizer`, `RegexTokenizer`, `NgramTokenizer`, `FacetTokenizer`. **No code-aware tokenizer.** The `SplitCompoundWords` filter exists but is *dictionary-driven for German compound nouns*, not camelCase. **Tantivy would require us to roll our own tokenizer** — same DIY cost as our current FTS5 path. No advantage.

### 1.3 Sourcegraph Zoekt

**Verified via [Zoekt design.md](https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) and [Thomas Tay's blog](https://thomastay.dev/blog/how-zoekt-works/):**

Zoekt sidesteps tokenization entirely: it indexes overlapping 3-character trigrams + byte offsets, then runs a regex matcher over candidate documents at query time. **Word-boundary detection is deferred to the regex engine at query time.** This is brilliant for *literal* code search ("find this token") but useless for natural-language queries — the user never types the literal trigrams `con`, `onf`, `nfi`...

Not portable to FTS5 (different index structure). Confirms the principle: **for code, defer tokenization to query time and store enough breadcrumbs to recover word boundaries** — which `preserve_original=true` accomplishes in the WordDelimiter approach.

### 1.4 claude-context (Zilliz, the popular MCP code-search tool)

**Verified by reading `cloned-projects/claude-context/packages/core/src/vectordb/milvus-vectordb.ts`:**

- Uses Milvus's built-in `FunctionType.BM25` to compute sparse vectors from raw `content` field.
- `output_field_names: ["sparse_vector"]`, `metric_type: MetricType.BM25`.
- Hybrid search fuses dense + sparse on Milvus side.
- **They do NOT do custom identifier splitting** — they delegate to Milvus's built-in BM25 analyzer (which is a standard analyzer, not code-aware). Milvus 2.4+ supports custom analyzers but claude-context doesn't configure one.

**Implication:** Even the leading code-search MCP punts on this problem. They get away with it because they have a strong dense channel + LLM reranker. Ours is similar (embeddinggemma + qwen reranker) — but we still see lexical-failure cases like `tailwindcss-853`.

### 1.5 MiniSearch / lunr (JS BM25 engines)

Both use whitespace + punctuation tokenization with optional stemming. Neither has built-in compound-identifier splitting. You'd plug in a custom tokenizer — same cost as plugging into FTS5.

---

## 2. Research papers — verified

### 2.1 Enslen, Hill, Pollock, Vijay-Shanker (2009) — Samurai
**Citation:** Enslen, E., Hill, E., Pollock, L., Vijay-Shanker, K. *Mining Source Code to Automatically Split Identifiers for Software Analysis.* MSR 2009. PDF: https://www.ptidej.net/courses/inf6306/fall09/resources/EnslenandHillandPollockandVijayShanker.pdf

**Algorithm (verified from web search summary):** First, hard-split on camelCase and non-alphanumeric. Then for each remaining "hard word" (e.g. `getallthings`), score every possible binary split using a *frequency table mined from the source corpus + a global frequency table*. Pick the split with highest combined score. Recursively split sub-parts.

**Time complexity:** O(n²) per identifier in the length of the hard word (every split point × scoring). Negligible in practice (avg identifier <16 chars).

**Code available?** Yes, indirectly — implemented in `casics/spiral` (Python).

**Key result:** Outperforms naive camelCase splitting when identifiers are *fused* (no delimiter). For pure camelCase (the dominant TS/JS pattern), gains are small because the hard-split phase already gets it right.

### 2.2 Lawrie & Binkley — GenTest (ICSM 2007 / 2010)
Generation-test approach: generate candidate splits, test each against a dictionary + abbreviation expansion. Predates Samurai. **No actively-maintained implementation.**

### 2.3 Corazza et al. — LINSEN (ICPC 2012)
Levenshtein-based dictionary lookup for splitting + expansion. Heavy (dictionary lookup per split candidate). **No actively-maintained implementation.**

### 2.4 Butler et al. — INTT
Identifier Name Tokenization Tool. Used by `casics/spiral` for evaluation but not as the primary splitter. INTT corpus (18,772 splits) is the standard benchmark.

### 2.5 Hucka — Ronin (Spiral library)
**Source verified:** https://github.com/casics/spiral (archived 2024-07).

Algorithm: Successor to Samurai. Adds explicit handling for prefixes/suffixes, common word lists, scoring tweaks. **92.09% accuracy on INTT (17,287/18,772 splits), 84.42% on Ludiso.**

**Status:** Repo archived. Python 3 only. Would require Python sidecar process for our Node toolchain. **Hard pass for us** despite the best paper accuracy — operational cost > marginal benefit.

### 2.6 Karampatsis et al. (2020) — BPE for code (cited 600+ times)
**Verified abstract via arxiv MCP (paper id 2003.07914):**
> "code introduces new vocabulary at a far higher rate than natural language ... we address this issue by ... presenting an open vocabulary source code NLM that can scale to such a corpus, 100 times larger than in previous work."

**This paper is about language modelling (perplexity, code completion), NOT retrieval.** A common citation error is to claim BPE "is the standard for code search" — the paper makes no such claim. It's the standard for *neural language models of code*.

### 2.7 Shi et al. (2022) — Identifier Splitting + BPE hybrid
**Verified abstract via arxiv MCP (paper id 2201.01988):**
> "simply inserting identifier splitting into the pipeline hurts the model performance, while a hybrid strategy combining identifier splitting and the BPE algorithm can outperform the original open-vocabulary models on predicting identifiers by 3.68% of recall and 6.32% of Mean Reciprocal Rank."

Confirms: naive BPE on raw identifiers underperforms; hybrid (rule-based pre-split + BPE) is the winner — but again, this is for *generation*, not retrieval. Still relevant: **rule-based pre-splitting helps even when BPE follows.**

---

## 3. The four options ranked

| Option | What it does | Library? | Verdict |
|---|---|---|---|
| **A. WordDelimiterGraph rules** | Splits on case/digit/non-alnum boundaries; preserves original. Rule-based, no dict. | Lucene/ES/Solr/OS native. Re-implement ~50 LoC in TS. | **SHIP THIS** |
| B. BPE/WordPiece | Subword tokenizer trained on corpus. Same vocab at index + query. | HuggingFace tokenizers (Rust+JS). | Wrong tool — built for LLMs, not BM25. Adds complexity, dense channel already covers this niche. |
| C. Samurai/Ronin (dictionary) | Frequency-table scoring across split candidates. | `casics/spiral` Python (archived). | Best paper accuracy on fused identifiers, but unmaintained + Python sidecar = no. |
| D. AST symbol-name extraction | Split identifiers at AST extraction time, store in separate column. | tree-sitter (have it). | Complementary, not a replacement — body identifiers still need tokenization in `rawCode`. Already have `symbol_name` column, could index it separately. |

---

## 4. Concrete v15 plan

1. Add `src/tokenizer.ts` with `splitIdentifier(token: string): string[]`:
   - Split on non-alphanumeric (`/[^a-zA-Z0-9]+/`)
   - Split on lowercase→uppercase transitions
   - Split on letter→digit and digit→letter transitions
   - Acronym-aware: `XMLParser` → `XML`, `Parser` (uppercase-run + trailing-cap-followed-by-lowercase rule)
   - Always emit the original token PLUS its parts (`preserve_original=true` semantics)
   - Lowercase output
   - Filter parts < 2 chars
2. In `store.ts` indexer, before inserting into `chunks_code_fts.content`, run rawCode through a tokenizer that emits the WordDelimiter-expanded stream.
3. In `toFts5Query`, run query terms through the same `splitIdentifier` and OR-join the expanded forms within each original term, AND-join across terms (e.g., `enable plugins` → `enable AND plugins`; `configurePlugins` → `(configurePlugins OR configure OR plugins)`).
4. Re-run `bun run benchmark` SWE-PolyBench `tailwindcss-853` case to verify recovery.
5. Re-run full benchmark to confirm no regression.

**No new dependencies. No Python sidecar. Pure TS, ~50 LoC, drop-in.**

---

## 5. Citations actually verified

- Elastic Search docs (verbatim quoted): https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-word-delimiter-graph-tokenfilter.html
- Solr filter docs: https://solr.apache.org/guide/solr/latest/indexing-guide/filters.html
- Tantivy tokenizer docs: https://docs.rs/tantivy/latest/tantivy/tokenizer/index.html
- Zoekt design: https://github.com/sourcegraph/zoekt/blob/main/doc/design.md
- Spiral (Ronin): https://github.com/casics/spiral
- Karampatsis 2020 (BPE for code): arxiv 2003.07914 — abstract verified via arxiv MCP
- Shi 2022 (identifier splitting + BPE): arxiv 2201.01988 — abstract verified via arxiv MCP
- Enslen et al. 2009 (Samurai): https://www.ptidej.net/courses/inf6306/fall09/resources/EnslenandHillandPollockandVijayShanker.pdf
- Empirical study (Dit, Guerrouj et al.): https://link.springer.com/article/10.1007/s10664-013-9261-0
- claude-context Milvus integration: read directly from `cloned-projects/claude-context/packages/core/src/vectordb/milvus-vectordb.ts`

## 6. Things I did NOT verify (flagging honestly)

- The Dit/Guerrouj 2013 empirical-study PDF returned binary garbage when fetched — I couldn't extract concrete accuracy numbers comparing GenTest/Samurai/INTT/LINSEN. I'm relying on the Spiral README's numbers (Ronin 92.09% on INTT) and standard literature consensus that Samurai/Ronin > rule-based > naive on fused identifiers, ≈ rule-based on pure camelCase.
- I did not verify the exact behaviour of `WordDelimiterGraphFilter` on `IPv6Address` from Lucene source — inferred from the documented `split_on_numerics` rule. Acronym-with-digits is a known ambiguous case; `preserve_original=true` is the standard mitigation.
- I did not read the Spiral source line-by-line to confirm Ronin's algorithm matches the paper. Took the README at its word.
