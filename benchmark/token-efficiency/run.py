#!/usr/bin/env python3
"""
Token efficiency benchmark: semantic search tool vs grep.

Runs the same queries through two agents:
  semantic  — has only our semantic_search tool + submit_answer
  grep      — has only bash (read-only) + submit_answer

Measures total API tokens consumed before each agent submits an answer,
and whether the answer was correct.

Usage:
  python run.py                          # all cases, both agents
  python run.py --agent semantic         # one agent only
  python run.py --cases 5               # first N cases
  python run.py --type low_lexical_overlap
  python run.py --model claude-haiku-4-5-20251001

Environment:
  ANTHROPIC_API_KEY   required
  SEMANTIC_SEARCH_DB  override path to index.db (default: auto-detected)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import anthropic
except ImportError:
    print("Missing dep. Run: pip install anthropic")
    sys.exit(1)

# ─── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR   = Path(__file__).parent
TOOL_DIR     = SCRIPT_DIR.parent.parent          # .claude/tools/semantic-search/
FRINK_ROOT   = TOOL_DIR.parent.parent.parent     # repo root
GROUND_TRUTH = TOOL_DIR / "benchmark" / "ground-truth.json"
RESULTS_DIR  = SCRIPT_DIR / "results"
NODE_TOOL    = os.environ.get("SEMANTIC_SEARCH_TOOL", str(TOOL_DIR / "dist" / "index.js"))
DB_PATH      = os.environ.get("SEMANTIC_SEARCH_DB",  str(TOOL_DIR / "index.db"))

import shutil as _shutil
_NVM_BIN = Path.home() / ".nvm" / "versions" / "node"
NODE_BIN: str = (
    os.environ.get("NODE_BIN")
    or _shutil.which("node")
    or next(
        (str(p / "bin" / "node") for p in sorted(_NVM_BIN.glob("v*"), reverse=True) if (p / "bin" / "node").exists()),
        "node",
    )
)

MAX_TURNS  = 12
MAX_TOKENS = 1024   # per response

# ─── Tool definitions ─────────────────────────────────────────────────────────

SUBMIT_TOOL = {
    "name": "submit_answer",
    "description": "Call this when you have identified the file(s). Pass the relative file paths.",
    "input_schema": {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Relative file paths from the repo root, e.g. ['src/lib/foo.ts']",
            }
        },
        "required": ["files"],
    },
}

SEMANTIC_TOOL = {
    "name": "semantic_search",
    "description": "Search the codebase by meaning or concept. Returns ranked file paths with descriptions. Use this once with a clear natural-language query.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What you are looking for, in plain English."}
        },
        "required": ["query"],
    },
}

BASH_TOOL = {
    "name": "bash",
    "description": (
        "Run a read-only shell command inside the frink repo. "
        "Allowed: grep, find, cat, head, ls, wc. "
        "Do NOT use git, curl, npm, node, or write commands. "
        "Working directory is the project root."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The shell command to run."}
        },
        "required": ["command"],
    },
}

# ─── Tool executors ───────────────────────────────────────────────────────────

def run_semantic_search(query: str) -> str:
    result = subprocess.run(
        [NODE_BIN, NODE_TOOL, "search", query, "--limit", "5", "--json"],
        capture_output=True, text=True,
        env={**os.environ, "SEMANTIC_SEARCH_DB": DB_PATH},
        timeout=30,
    )
    if result.returncode != 0:
        return f"Error: {result.stderr[:200]}"
    try:
        data = json.loads(result.stdout)
        lines = []
        for r in data:
            lines.append(f"{r['filePath']}  —  {r.get('description','')[:120]}")
        return "\n".join(lines) if lines else "No results found."
    except Exception as e:
        return f"Parse error: {e}"

ALLOWED_CMDS = re.compile(r"^\s*(grep|find|cat|head|ls|wc)\b")

def run_bash(command: str) -> str:
    if not ALLOWED_CMDS.match(command):
        return "Blocked: only grep, find, cat, head, ls, wc are allowed."
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True,
            cwd=str(FRINK_ROOT), timeout=15,
        )
        output = (result.stdout + result.stderr).strip()
        return output[:3000] if output else "(no output)"
    except subprocess.TimeoutExpired:
        return "Timeout."

# ─── Agent loop ───────────────────────────────────────────────────────────────

def run_agent(
    client: anthropic.Anthropic,
    model: str,
    agent_type: str,   # "semantic" | "grep"
    query: str,
) -> dict[str, Any]:
    """Run one agent on one query. Returns tokens, turns, submitted files."""

    system = (
        "You are a code navigation assistant. "
        "Your only job is to find the file(s) in this TypeScript/React codebase that best match the query. "
        "Be efficient. Once you are confident, call submit_answer immediately."
    )

    if agent_type == "semantic":
        tools = [SEMANTIC_TOOL, SUBMIT_TOOL]
        user_msg = f"Find the file(s) that implement this: {query}"
    else:
        tools = [BASH_TOOL, SUBMIT_TOOL]
        user_msg = (
            f"Find the file(s) in this codebase that implement: {query}\n\n"
            f"The repo root is: {FRINK_ROOT}\n"
            f"Source lives under src/ and socket-server/src/."
        )

    messages: list[dict] = [{"role": "user", "content": user_msg}]
    total_input  = 0
    total_output = 0
    turns        = 0
    submitted    = None

    while turns < MAX_TURNS and submitted is None:
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            tools=tools,
            messages=messages,
        )

        if not hasattr(response, "usage"):
            raise RuntimeError(f"Unexpected API response: {response!r:.200}")

        total_input  += response.usage.input_tokens
        total_output += response.usage.output_tokens
        turns        += 1

        # Append assistant turn
        messages.append({"role": "assistant", "content": response.content})

        # Process tool calls
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            if block.name == "submit_answer":
                submitted = block.input.get("files", [])
                break
            elif block.name == "semantic_search":
                result_text = run_semantic_search(block.input["query"])
            elif block.name == "bash":
                result_text = run_bash(block.input["command"])
            else:
                result_text = "Unknown tool."
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result_text,
            })

        if submitted is not None:
            break

        if not tool_results:
            # Model gave a text response without calling a tool — prompt it
            tool_results = []
            messages.append({
                "role": "user",
                "content": "Please call submit_answer with your best answer, or use a tool to search further.",
            })
        else:
            messages.append({"role": "user", "content": tool_results})

    return {
        "input_tokens":  total_input,
        "output_tokens": total_output,
        "total_tokens":  total_input + total_output,
        "turns":         turns,
        "submitted":     submitted or [],
    }

# ─── Scoring ──────────────────────────────────────────────────────────────────

def score(submitted: list[str], expected: list[str]) -> dict[str, float]:
    """Check if any submitted file matches any expected file (partial path match)."""
    hits = 0
    for sub in submitted:
        for exp in expected:
            if sub.endswith(exp) or exp.endswith(sub) or Path(sub).name == Path(exp).name:
                hits += 1
                break
    recall = hits / len(expected) if expected else 0.0
    precision = hits / len(submitted) if submitted else 0.0
    return {"recall": recall, "precision": precision, "hit": hits > 0}

# ─── Main ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--agent",  default="both", help="semantic, grep, or both")
    p.add_argument("--cases",  type=int, default=None, help="Limit number of cases")
    p.add_argument("--type",   default=None, help="Filter by case type")
    p.add_argument("--model",  default="claude-haiku-4-5-20251001")
    return p.parse_args()

def main():
    args = parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set.")
        sys.exit(1)

    # Force direct Anthropic connection — bypass any local proxy (e.g. localhost:3031)
    client = anthropic.Anthropic(api_key=api_key, base_url="https://api.anthropic.com")

    cases = json.load(open(GROUND_TRUTH))
    cases = [c for c in cases if c.get("type") != "negative"]
    if args.type:
        cases = [c for c in cases if c.get("type") == args.type]
    if args.cases:
        cases = cases[:args.cases]

    agents = ["semantic", "grep"] if args.agent == "both" else [args.agent]

    print(f"Model:  {args.model}")
    print(f"Cases:  {len(cases)}")
    print(f"Agents: {', '.join(agents)}")
    print()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    all_results: dict[str, list] = {a: [] for a in agents}

    for case in cases:
        cid      = case["id"]
        query    = case["query"]
        expected = case["expected"]
        ctype    = case["type"]

        print(f"[{cid}]  ({ctype})")
        print(f"  query: {query[:80]}")

        for agent in agents:
            result = run_agent(client, args.model, agent, query)
            s = score(result["submitted"], expected)

            hit_sym = "✓" if s["hit"] else "✗"
            print(
                f"  [{agent:8s}] {hit_sym}  "
                f"tokens={result['total_tokens']:5d}  "
                f"turns={result['turns']}  "
                f"submitted={result['submitted'][:2]}"
            )

            all_results[agent].append({
                "id":       cid,
                "type":     ctype,
                "query":    query,
                "expected": expected,
                **result,
                **s,
            })

        print()

    # ── Summary ───────────────────────────────────────────────────────────────
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)

    summaries = {}
    for agent, results in all_results.items():
        if not results:
            continue
        n          = len(results)
        avg_tokens = sum(r["total_tokens"] for r in results) / n
        avg_turns  = sum(r["turns"] for r in results) / n
        hit_rate   = sum(r["hit"] for r in results) / n
        summaries[agent] = {"avg_tokens": avg_tokens, "avg_turns": avg_turns, "hit_rate": hit_rate, "n": n}
        print(f"\n  {agent} (n={n})")
        print(f"    Hit rate:   {hit_rate:.0%}")
        print(f"    Avg tokens: {avg_tokens:.0f}")
        print(f"    Avg turns:  {avg_turns:.1f}")

    if "semantic" in summaries and "grep" in summaries:
        s = summaries["semantic"]
        g = summaries["grep"]
        savings = (g["avg_tokens"] - s["avg_tokens"]) / g["avg_tokens"] * 100
        print(f"\n  Token savings (semantic vs grep): {savings:.0f}%")
        print(f"  ({s['avg_tokens']:.0f} vs {g['avg_tokens']:.0f} avg tokens)")

    # Save results
    for agent, results in all_results.items():
        out = RESULTS_DIR / f"{agent}_results.jsonl"
        with open(out, "w") as f:
            for r in results:
                f.write(json.dumps(r) + "\n")
        print(f"\n  → {out}")

if __name__ == "__main__":
    main()
