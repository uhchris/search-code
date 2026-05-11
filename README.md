# search-code

Local semantic + lexical code search for AI agents. Resolves natural-language queries to 1–5 ranked code chunks in ~200ms, all on-device via [Ollama](https://ollama.com). Production architecture is a 3-channel hybrid retriever (description embedding + code embedding + BM25 with identifier splits) fused via Reciprocal Rank Fusion.

Runs entirely on your machine. No cloud APIs, no data leaves your environment.

---

## Why

AI coding agents find code two ways: grep through the filesystem, or read files they already know about. Both are expensive. A grep-based agent on a medium-sized codebase routinely burns 20k–300k tokens locating the right file before it can do the actual task.

The less obvious cost: when the agent doesn't find the right file, it writes the code anyway, from scratch. Utility functions get reimplemented, hooks get duplicated, test helpers are written twice. Over time, agents operating without good code search produce codebases full of near-identical logic spread across files, none of which knows the others exist. Harder to fix than the token cost.

This tool gives agents a `searchCode` MCP tool that returns ranked chunks (file path + symbol + actual source code) in a single round trip.

On the SWE-PolyBench Verified agent benchmark (n=24): **R@1 19/24 (79%) at 226K avg tokens/instance vs a grep-agent at 15/18 (83%) and 308K tokens — same recall at 32% lower cost.**

---

## How it works

**Indexing** (one-time per repo, then incremental):

1. **Chunk** — parse via [oxc-parser](https://github.com/oxc-project/oxc). Each function, class, exported variable, and tRPC-router-style sub-procedure becomes its own chunk. Drizzle table definitions are chunked. Boundaries follow real code structure.
2. **Describe** — each chunk is passed to a local LLM (default: `gemma4:26b`) which writes 2–3 sentences explaining what the code does, the domain, and key constraints. Bridges the vocabulary gap between query intent and code identifiers.
3. **Embed twice**:
   - The description (prefixed with `filePath [symbol]:`) is embedded → stored as `embedding` BLOB
   - The raw code is embedded directly → stored as `code_embedding` BLOB
4. **Index for BM25** — rawCode is appended with Lucene `WordDelimiterGraphFilter`–style identifier splits (`disconnectIntegration` → `disconnectIntegration disconnect Integration`) into a SQLite FTS5 table.

All state lives in `.search-code/index.db` next to your `search-code.config.json`.

**Search** (per query):

1. Query is embedded once.
2. Three independent rankings computed in parallel:
   - **desc**: cosine vs description embedding (paraphrase strength)
   - **code**: cosine vs code embedding (code-shape semantics)
   - **bm25**: FTS5 BM25 over rawCode + identifier splits (literal lexical match)
3. Ranks fused via Reciprocal Rank Fusion (K=60). Each chunk emits one row per channel that ranked it; rows sorted by channel-internal rank.
4. Agent sees: file path + line range + symbol + per-channel rank tags (`desc:#3 code:#1 bm25:#--`) + full chunk source.

Round-trip latency on a 6,000-chunk index: ~150ms.

**Incremental re-indexing** runs automatically. Each `searchCode` MCP call triggers a debounced background re-index (30s debounce, mtime-gated Phase 0 — files whose disk mtime hasn't advanced are skipped entirely). LLM cost is paid only for chunks of files that genuinely changed. `search-code status` shows whether a background pass is currently writing.

---

## Benchmarks

### Internal benchmark (40 failure-mode cases)

40 natural-language queries with known-correct file targets. Covers same-file multi-chunk retrieval, generic plumbing descriptions, concept-with-constraint queries, and paraphrase/low-lexical-overlap inputs that are designed to break pure-lexical baselines.

Current numbers: **R@1 70%, R@3 88%, R@5 98%, MRR@10 0.800.**

**vs BM25 baseline** (SQLite FTS5 with `porter unicode61` stemming + IDF, OR-joined like Lucene/Elasticsearch defaults — the same lexical retriever used as the sparse channel inside `searchHybrid`):

| Metric | searchCode | BM25 | Δ |
|---|---|---|---|
| R@1 | 28/40 (70%) | 12/40 (30%) | **+40pp** |
| R@3 | 34/40 (85%) | 19/40 (48%) | **+37pp** |
| Avg tokens/query | 1,280 | 934 | +37% |

BM25 (porter stemmer + IDF + identifier splits via `augmentForFts5`) is a strong lexical baseline. Semantic retrieval still wins on R@1 by ~2× — driven mostly by paraphrase and low-lexical-overlap queries where vocabulary in the query does not overlap with vocabulary in the matching file. BM25 pulls ahead only when the query contains the exact identifier or near-verbatim string; the MCP tool description explicitly routes those cases to `grep`.

### SWE-PolyBench Verified (real GitHub bug reports)

Tested on [SWE-PolyBench Verified](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified) — real GitHub issues from open-source JS/TS repos with known correct file patches. Queries the tool has never seen.

**Non-agent mode** (`semantic` retriever passes full multi-paragraph problem_statement as query):

| Repo | n | R@1 | R@3 | R@5 |
|------|---|-----|-----|-----|
| three.js | 4 | 3/4 | 4/4 | 4/4 |
| prettier | 17 | 8/17 | 11/17 | 14/17 |
| tailwindcss | 3 | 2/3 | 2/3 | 2/3 |
| **TOTAL** | **24** | **13/24** | **17/24** | **20/24** |

Multi-paragraph queries starve all three channels (AND-combined FTS5 returns 0; both dense channels embed long English text to a blurry centroid). The retriever shines in agent mode where queries are short and identifier-rich.

**Agent mode** (`semantic-agent` — Claude Haiku 4.5 formulates short queries via the `searchCode` MCP tool):

| | R@1 any-hit | Mean R@1 | Avg tokens | Avg turns |
|---|---|---|---|---|
| Non-agent CLI | 13/24 | 0.363 | n/a (single call) | n/a |
| **searchCode agent** | **19/24 (79%)** | **0.506** | **226K** | **8.8** |
| Grep-agent (n=18) | 15/18 (83%) | 0.540 | 308K | 14 |

**searchCode agent matches grep-agent's R@1 hit count at 32% lower token cost.** Agents formulate short identifier-rich queries that exercise BM25 + code-channel properly; the non-agent long-paragraph mode under-measures the architecture.

### Where searchCode wins vs grep

| You want to find... | Use |
|---|---|
| A concept / behavior / domain ("where auth tokens are validated") | `searchCode` |
| A function whose verbatim name you already know | `grep` (faster, exact) |
| An exact error string or log message | `grep` |
| A file by name | `find` / glob |
| Paraphrased intent ("retry with backoff") | `searchCode` |
| Compound identifier as separated words ("configure plugins" for `configurePlugins`) | `searchCode` (BM25 splits handle this) |

The MCP tool description itself nudges this routing. Agents that know the verbatim token are told to grep.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+ (or [Bun](https://bun.sh))
- [Ollama](https://ollama.com) running locally
- Pull required models:

```bash
ollama pull gemma4:26b
ollama pull embeddinggemma
```

### Install globally

```bash
git clone <this repo> ~/search-code   # or wherever
cd ~/search-code
npm install
npm run build
npm install -g .                      # symlinks search-code into PATH
```

After this, `search-code` is available from any directory.

### Initialise a repo

```bash
cd /path/to/your/repo
search-code init        # writes search-code.config.json + creates .search-code/
```

Edit `search-code.config.json` to set source roots:

```json
{
  "models": { "describer": "gemma4:26b", "embedder": "embeddinggemma" },
  "ollama": { "host": "http://localhost:11434" },
  "hybrid": { "enabled": true },
  "indexing": {
    "sourceRoots": ["src"],
    "excludePatterns": ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"],
    "minChunkLines": 5,
    "maxChunkLines": 300
  }
}
```

### Initial index

```bash
search-code index
```

First run is slow because the LLM describes every chunk (~10–30 min on a 1,000-file repo). Subsequent runs are mtime-gated: unchanged files are skipped at the parse step (~3s Phase 0 on a 2,000-file repo with no changes). Only chunks of changed files pay the LLM cost.

### Search from CLI

```bash
search-code search "function that retries with exponential backoff"
search-code search "configurePlugins" --limit 5 --format mcp
search-code status      # shows total chunks + whether a background reindex is running
```

### Use with Claude Code (MCP)

```bash
claude mcp add codebase "search-code serve"
```

Restart Claude Code. The `searchCode` tool is now available in every project that has a `search-code.config.json`. Each MCP call also fires a debounced background reindex, so your edits get reflected in the next search without you running `index` manually.

Tail live progress when a background reindex is running:

```bash
tail -f .search-code/last-index.log
```

---

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `models.describer` | `gemma4:26b` | Ollama model used to describe chunks |
| `models.embedder` | `embeddinggemma` | Ollama embedding model. Handles prose and code in one space, so the same model serves description and code queries. |
| `ollama.host` | `http://localhost:11434` | Ollama server URL |
| `hybrid.enabled` | `true` | Enable 3-channel RRF. Disable for description-channel only |
| `indexing.sourceRoots` | `["src"]` | Directories to index (relative to repo root) |
| `indexing.excludePatterns` | see config | Glob patterns to skip |
| `indexing.minChunkLines` | `5` | Ignore unnamed chunks smaller than this |
| `indexing.maxChunkLines` | `300` | Split chunks larger than this |
| `indexing.concurrency` | `1` | Parallel describe+embed workers |

---

## Roadmap

- **Multi-language chunkers** — describer + embedder are language-agnostic. Adding Python, Go, Rust chunkers (via oxc-parser equivalents or tree-sitter) extends coverage. TS/JS only today.
- **Wider SWE-PolyBench coverage** — 24 instances across 3 repos today. Indexing more repos would tighten the variance bounds.
- **End-to-end agent benchmark** — measure not just file-finding but task completion + total tokens for full fix cycles. Closest signal to production value.
- **Smaller models** — test gemma3:1b describer + smaller embedder for teams with less GPU headroom.
- **Cross-repo group search** — federated index across multiple repos for multi-service codebases.

---

## License

PolyForm Noncommercial 1.0.0 (matching upstream conventions for code-search-as-MCP tools). Commercial use available on request.
