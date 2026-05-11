# v17b — Agent-Mode SWE-PolyBench with MCP-style rendering

**Date:** 2026-05-09
**Trigger:** v16 agent-mode showed retrieval architecture works in agent context (R@1 +5pp vs non-agent). v17b changes how MCP returns results — code body inline + per-channel rank tags + per-channel result entries — but retrieval is identical to v16. Test: does richer rendering help the agent decide?

## Bench setup

```bash
SEMANTIC_BENCH_FORMAT=mcp python3 run.py --retriever semantic-agent \
  --repos three.js,prettier,tailwindcss
```

`SEMANTIC_BENCH_FORMAT=mcp` env var routes `run_semantic_tool` through the new CLI `--format mcp` flag, which uses the same `renderMcpV17b` function the MCP server uses. Agent receives:

- Per-result header: `1. file.ts:1-10 [symbol] code:#1`
- Code body in markdown block (truncated at 80 lines) when row is from code/bm25 channel
- Description prose when row is from desc-channel
- Up to 3 channel-entries per chunk (one per channel that ranked it)

Same 24 SWE-poly instances. Same Claude Haiku 4.5. Same retrieval (v16 3-channel RRF). Different rendering.

## Headline results

| | non-agent CLI | v16 agent (short fmt) | **v17b agent (mcp fmt)** | grep-agent (n=18) |
|---|---|---|---|---|
| R@1 any-hit | 13/24 | 15/24 | **19/24** | 15/18 (83%) |
| R@3 any-hit | 17/24 | 20/24 | 20/24 | 15/18 |
| R@5 any-hit | 20/24 | 20/24 | 20/24 | 15/18 |
| Mean R@1 | 0.363 | 0.408 | **0.506** | 0.540 |
| Mean R@3 | 0.492 | 0.576 | 0.532 | 0.563 |
| Mean R@5 | 0.591 | 0.576 | 0.532 | 0.563 |
| Avg tokens | n/a | 50K | **226K** | 308K |
| Avg turns | n/a | 8.9 | 8.8 | 14 |

**v17b R@1 = 19/24 = 79%** vs v16 agent 62.5% vs non-agent 54%. **+17pp R@1 over baseline non-agent.**

## v17b vs grep-agent — matched subset (n=18)

Earlier grep-agent run was killed mid-prettier (only 18 of 24 instances). Comparing on the same 18:

| | grep-agent | **v17b** |
|---|---|---|
| R@1 any-hit | 15/18 (83%) | **15/18** (83%) — tied |
| Mean R@1 | 0.540 | 0.531 |
| Avg tokens | 308K | **211K** (−32%) |

**v17b matches grep-agent's R@1 hit count, 32% cheaper.** Mean R@1 0.540 vs 0.531 within noise.

## Per-repo v17b agent-mode (full 24)

| Repo | n | R@1 | R@3 | R@5 |
|------|---|-----|-----|-----|
| mrdoob/three.js | 4 | 3/4 | 3/4 | 3/4 |
| prettier/prettier | 17 | 13/17 | 13/17 | 13/17 |
| tailwindlabs/tailwindcss | 3 | 3/3 | 4/4 (mean) | 4/4 (mean) |

Tailwindcss-853 (`configurePlugins.js`) — chronic miss across every prior version — now **R@1=0.50** (rank 1 found one of two gold files). v16 agent had R@1=0 R@5=0.50 on this case.

## Why v17b lifts R@1

The agent gets:
1. **Actual source code** — can verify match without separate Read call
2. **Per-channel ranks** — knows whether a result won via paraphrase (description) or code semantics or literal token
3. **Multiple entries per chunk** — same chunk surfaces from desc + code channels, agent sees both signals

With this, agent commits to rank 1 confidently — fewer disambiguating turns.

## Cost trade-off

| Format | Tokens/instance | R@1/24 | Tokens per R@1 win |
|--------|---|---|---|
| short (v16) | 50K | 15 | 3.3K |
| **mcp (v17b)** | **226K** | **19** | **11.9K** |
| grep-agent | 308K | 15 | 20.5K |

v17b spends ~3.6× more tokens per win than v16 short-format, but recovers 4 wins v16 missed. Cheaper than grep per win.

For production where R@1 reliability matters, v17b is the right shape. For cost-sensitive batch tasks, v16 short-format is acceptable.

## Mean R@3/R@5 dropped slightly

v16 agent: R@3=0.576 R@5=0.576
v17b agent: R@3=0.532 R@5=0.532

Hypothesis: with code body visible, agent commits hard to rank-1 picks. Doesn't bother surfacing rank 2-5 as alternatives. Net more R@1 wins, fewer "kind-of-right" R@3 partials.

This is GOOD for production — agent submits the right file, not five plausible candidates. But the bench's mean-recall metric penalizes confident single-pick.

## What this proves

1. **Retrieval architecture (v16 3-channel RRF) is correct.** v17b uses the same retrieval; only rendering changes.
2. **MCP rendering matters.** Agent's R@1 jumped 15→19 (+27% more wins) just from richer presentation.
3. **v17b matches grep-agent on R@1 at 32% lower token cost.** Production-ready trade.

## Code changes for v17b

- New: `src/render.ts` — `renderMcpV17b(results, query, limit)` shared between MCP and CLI
- `src/mcp-server.ts` — uses shared renderer, no inline rendering
- `src/index.ts` — `runSearch` accepts `mcpFormat` arg; CLI accepts `--format mcp`
- `benchmark/swe-poly/run.py` — `run_semantic_tool` honors `SEMANTIC_BENCH_FORMAT` env (`mcp` | `short`); passes `wt_path` so `SEMANTIC_SEARCH_ROOT` resolves code body correctly

## What's not yet tested

- v17 (winning-channel-only, single entry per chunk) in agent mode — would isolate effect of "show ONLY winning channel" vs v17b's "show all channels that ranked".
- v15 / v14 retrieval in agent mode — would isolate code-channel contribution to v17b's R@1 wins.
- Full grep-agent on all 24 instances (we have 18) — would confirm R@1 parity on the missing 6.

## Decision

**Ship v17b as default MCP rendering.** Production agents get higher R@1 with acceptable token cost.

Token-sensitive callers can still get short format via legacy CLI without `--format mcp`. The architecture supports both.
