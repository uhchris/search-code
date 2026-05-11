# semantic-search

A local semantic code search tool for AI agents. Given a natural language query, it finds the most relevant files in your codebase and returns ranked file paths in ~2,000 tokens instead of the 20,000–50,000 tokens a grep-based agent typically burns.

Runs entirely on your machine via [Ollama](https://ollama.com). No cloud APIs, no data leaves your environment.

---

## Why

AI coding agents find code one of two ways: grep/find through the filesystem, or read files they already know about. Both work, but both are expensive. A grep-based agent on a medium-sized codebase routinely burns 20k–70k tokens locating the right file before it can even start the actual task.

The less obvious problem is what happens when the agent *doesn't* find the right file. It writes the code anyway, from scratch. Utility functions get reimplemented, hooks get duplicated, test helpers are written twice. Over time, agents operating without good code search produce codebases full of near-identical logic spread across files, none of which knows the others exist. This is harder to fix than the token cost.

This tool gives agents a semantic search tool call that resolves to 1–5 ranked file paths in a single round trip. In benchmarks on real GitHub bug reports (SWE-PolyBench), this reduces token consumption by **~94%** with equal or better accuracy, and gives the agent a fighting chance of finding what already exists before writing something new.

---

## How it works

**Indexing** (one-time, runs locally):

1. **Chunk** - the codebase is parsed using the TypeScript/JavaScript AST (via [oxc-parser](https://github.com/oxc-project/oxc)). Each function, class, and exported constant becomes its own chunk. Boundaries follow real code structure, not arbitrary line counts.

2. **Describe** - each chunk is passed to a local LLM (default: `gemma4:26b` via Ollama) which writes a natural language description of what the code does. This bridges the vocabulary gap between how developers describe problems and how code is written.

3. **Embed** - the description (prefixed with file path and symbol name) is embedded using a local embedding model (default: `embeddinggemma`). Embeddings are stored in a local SQLite database alongside the raw chunk and description.

**Search** (at query time):

1. The query is embedded using the same model.
2. Cosine similarity is computed against all chunk embeddings.
3. Results are deduplicated by file path and code hash, then returned as ranked file paths with descriptions.

The whole search round trip takes ~200ms once the index is built.

---

## Benchmarks

### Internal codebase (33 test cases across 6 query types)

Tested on a ~500-file TypeScript/React/Node codebase. Query types include paraphrase, low-lexical-overlap (vocabulary gap between query and code), scattered patterns, duplicate detection, needle-in-haystack, and error symptom queries.

| Version | R@1 | R@3 | R@5 | MRR@10 |
|---------|-----|-----|-----|--------|
| v1 (baseline) | 60% | 92% | 92% | 0.740 |
| v2 (hybrid BM25) | 64% | 88% | 88% | 0.760 |
| v3 (metadata prefix) | 76% | 92% | 96% | 0.843 |
| v5 (contextual retrieval) | 84% | 92% | 96% | 0.883 |
| **v6 (codeHash deduplication)** | **79%** | **91%** | **94%** | **0.846** |

> v6 is lower than v5 because the benchmark was expanded from 25 to 33 harder cases. On the original 25 cases, v6 is flat with v5 at 84% R@1.

**In plain English:** given a natural language description of what you're looking for, the correct file is the top result 79% of the time. It appears somewhere in the top 5 results 94% of the time.

---

### SWE-PolyBench (real GitHub bug reports, external repos)

Tested on [SWE-PolyBench Verified](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified), which contains real GitHub issues from open-source JS/TS repos with known correct file patches. These are queries neither we nor the tool have seen before.

#### Combined results (n=24: three.js + tailwindcss + prettier)

| Retriever | R@1 | R@3 | R@5 |
|-----------|-----|-----|-----|
| Semantic (direct, v9 hybrid) | **35.4%** | **48.3%** | **59.4%** |

Earlier n=7 (three.js + tailwindcss) numbers: R@1=47.6%, R@5=61.9%, agent token savings 92%. R@1 dropped after adding prettier because prettier issue bodies often reference doc files (changelog, README, .yml) that the AST chunker does not index — those count as misses on absolute R@k. Source-only R@k stays much higher (50%+ R@1 on the source-gold subset).

#### Per-repo breakdown

**three.js (n=4)** — agent + retrieval bench, see initial v6 results

| Retriever | R@1 | R@5 | Avg tokens |
|-----------|-----|-----|------------|
| Semantic (direct) | 53.6% | 63.4% | n/a |
| Semantic agent | 53.6% | 57.1% | 6,633 |
| Grep agent | 53.6% | 57.1% | 105,494 |

**tailwindcss (n=3)**

| Retriever | R@1 | R@5 | Avg tokens |
|-----------|-----|-----|------------|
| Semantic (direct) | 41.7% | 58.3% | n/a |
| Semantic agent | 41.7% | 66.7% | 7,259 |
| Grep agent | 58.3% | 58.3% | 50,279 |

**prettier (n=17)** — v9 retrieval only

| Retriever | R@1 | R@3 | R@5 |
|-----------|-----|-----|-----|
| Semantic (direct, dense only) | 31.3% | 46.5% | 58.3% |
| Semantic (direct, FTS5 hybrid) | 31.3% | 46.5% | 58.3% |
| Semantic (direct, MiniSearch hybrid) | 31.3% | 46.5% | 58.3% |
| Source-only subset (n=8) | **50.0%** | — | **87.5%** |

Three runs (dense, FTS5 hybrid, MiniSearch hybrid) produced byte-identical results — BM25 contributed zero on prettier because issue-body queries are too verbose for AND-combine (every term must appear in target chunk → unsatisfied for every case). Documented in `benchmark/results/v9-swe-poly-prettier.md`.

#### Known gaps

**Non-indexed file types.** The AST chunker covers `.js`, `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs` only. Two tailwind gold files are `css/preflight.css` and `yarn.lock` — neither indexed. The semantic agent exits early on these; the grep agent keeps burning tokens searching. This inflates token savings figures for cases with non-source gold files. Source-file-only token savings: **61%** on tailwindcss, **87%** on three.js.

**Identifier-style queries (largely fixed in v9).** On tailwindcss-853 (`configurePlugins.js`), the grep agent succeeded where the semantic agent failed — grep searched the literal token `configurePlugins` and found it. v9 adds a sparse BM25 channel over rawCode (FTS5 by default, MiniSearch with code-aware tokenizer optional) fused via RRF — identifier-component queries like `useRollback hook` now hit at R@1. The remaining failure mode is **long verbose issue bodies** with zero token overlap to the (short) target file: AND-combine returns `[]`, dense channel can't bridge the vocabulary gap. This is a query-side problem, not a retrieval-side one — see "When to use vs grep" below.

### When to use searchCode vs grep

| You want to find... | Use |
|---|---|
| A concept / behavior / domain ("where auth tokens are validated") | `searchCode` |
| A function whose name you already know exactly (`configurePlugins`) | `grep` (faster, exact) |
| An exact error string or log message | `grep` |
| A file by name | `find` / glob |
| Multiple related functions across a feature area | `searchCode` (single round trip) |
| Paraphrased intent ("retry with backoff") | `searchCode` |

`searchCode` saves ~94% tokens vs grep on conceptual queries where it is the right tool. For literal-string lookups it is worse than grep — agents should route by whether they already know the verbatim token.

> n=7 total. Expanding to the full 200 JS/TS instances across 9 repos (mui/material-ui, sveltejs/svelte, serverless/serverless, microsoft/vscode, prettier/prettier, and more) is on the roadmap.

---

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Ollama](https://ollama.com) running locally
- The following models pulled in Ollama:

```bash
ollama pull gemma4:26b
ollama pull embeddinggemma
```

### Install

```bash
cd .claude/tools/semantic-search
npm install
npm run build
```

### Configure

Edit `config.json` to point at your source directories:

```json
{
  "models": {
    "describer": "gemma4:26b",
    "embedder": "embeddinggemma"
  },
  "ollama": {
    "host": "http://localhost:11434"
  },
  "indexing": {
    "sourceRoots": ["src"],
    "excludePatterns": ["**/*.test.ts", "**/*.d.ts", "**/node_modules/**"]
  }
}
```

### Index your codebase

```bash
node dist/index.js index
```

This runs once. Re-run after significant code changes. Progress is saved, so interrupted indexing resumes from where it left off.

### Search

```bash
node dist/index.js search "function that retries with exponential backoff"
```

### Use with an AI agent (MCP)

The tool exposes a `searchCode` MCP tool that injects into any Anthropic API-compatible agent automatically via the included API proxy:

```bash
node .claude/tools/api-proxy/dist/proxy.js
# Point your agent at http://localhost:3031 instead of api.anthropic.com
```

The agent gains a `searchCode` tool without any code changes. Every API request gets it transparently.

---

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `models.describer` | `gemma4:26b` | Ollama model used to describe code chunks |
| `models.embedder` | `embeddinggemma` | Ollama model used to embed descriptions. SOTA on MTEB(Code) <500M params (arXiv:2509.20354) — handles both prose and code. Already-tested alternatives that did NOT improve scores: `nomic-embed-text` (identical), `nomic-embed-text-code` (regressed) |
| `ollama.host` | `http://localhost:11434` | Ollama server URL |
| `indexing.sourceRoots` | `["src"]` | Directories to index (relative to repo root) |
| `indexing.excludePatterns` | see config | Glob patterns to skip |
| `indexing.minChunkLines` | `5` | Ignore chunks smaller than this |
| `indexing.maxChunkLines` | `300` | Split chunks larger than this |
| `indexing.concurrency` | `1` | Parallel describe+embed workers |

---

## Roadmap

- **Multi-language support** - the describer and embedder are language-agnostic; only the AST chunker is TypeScript-specific. Adding Python, Go, and Rust chunkers would extend the tool to any codebase.
- **Larger benchmark** - expand SWE-PolyBench coverage beyond three.js (4 instances) to tailwindcss, code-server, and prettier across all 200 JS/TS verified instances.
- **End-to-end agent benchmark** - measure not just token consumption to find the file, but task completion rate and total tokens for a full fix cycle. This is the true signal.
- **Watch mode** - real-time incremental index updates as you code, rather than manual re-indexing.
- **Model flexibility** - document and test with smaller/faster models for teams with less GPU headroom.
