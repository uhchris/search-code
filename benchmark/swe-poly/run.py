#!/usr/bin/env python3
"""
SWE-PolyBench file-localisation + token-efficiency harness.

Retrievers:
  bm25           — keyword match on file path + first line. No API. Fast baseline.
  semantic       — direct vector search. No API. Measures recall.
  semantic-agent — Claude agent with our semantic_search tool. Measures recall + tokens.
  grep-agent     — Claude agent with bash (grep/find). Measures recall + tokens.

Usage:
  python run.py --retriever bm25,semantic --repos three.js
  python run.py --retriever semantic-agent,grep-agent --repos three.js --max-instances 4
  python run.py --retriever semantic,semantic-agent --repos three.js --max-instances 4

Environment:
  ANTHROPIC_API_KEY     required for *-agent retrievers
  SEMANTIC_SEARCH_TOOL  path to node dist/index.js (default: auto-detected)
  REPOS_DIR             where cloned repos are stored (default: ./repos)
"""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# ─── Deps check ───────────────────────────────────────────────────────────────

try:
    from datasets import load_dataset
    from sklearn.metrics import f1_score, precision_score, recall_score
    import git
except ImportError:
    print("Missing deps. Run: pip install datasets scikit-learn GitPython rank_bm25")
    sys.exit(1)

try:
    from rank_bm25 import BM25Okapi
    HAS_BM25 = True
except ImportError:
    HAS_BM25 = False

# ─── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
TOOL_DIR   = SCRIPT_DIR.parent.parent   # .claude/tools/semantic-search/
NODE_TOOL  = os.environ.get("SEMANTIC_SEARCH_TOOL", str(TOOL_DIR / "dist" / "index.js"))
REPOS_DIR  = Path(os.environ.get("REPOS_DIR", SCRIPT_DIR / "repos"))
RESULTS_DIR = SCRIPT_DIR / "results"

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

REPO_URLS = {
    "mrdoob/three.js":           "https://github.com/mrdoob/three.js.git",
    "tailwindlabs/tailwindcss":  "https://github.com/tailwindlabs/tailwindcss.git",
    "coder/code-server":         "https://github.com/coder/code-server.git",
    "prettier/prettier":         "https://github.com/prettier/prettier.git",
    "serverless/serverless":     "https://github.com/serverless/serverless.git",
    "sveltejs/svelte":           "https://github.com/sveltejs/svelte.git",
    "mui/material-ui":           "https://github.com/mui/material-ui.git",
    "microsoft/vscode":          "https://github.com/microsoft/vscode.git",
    "angular/angular":           "https://github.com/angular/angular.git",
}
SHORT_NAMES = {r.split("/")[1]: r for r in REPO_URLS}

AGENT_RETRIEVERS = {"semantic-agent", "grep-agent"}
MAX_TURNS  = 50
MAX_TOKENS = 1024

# Extensions the semantic indexer covers (AST chunker is TS/JS only)
INDEXED_EXTENSIONS = {".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs"}

def gold_is_source_only(gold_files: set[str]) -> bool:
    return all(Path(f).suffix in INDEXED_EXTENSIONS for f in gold_files)

# ─── Patch parsing ────────────────────────────────────────────────────────────

def get_patch_files(patch: str) -> set[str]:
    files = set()
    for line in patch.splitlines():
        if line.startswith("--- "):
            path = line[4:]
            if path.startswith("a/"): path = path[2:]
            if path != "/dev/null": files.add(path)
        elif line.startswith("+++ "):
            path = line[4:]
            if path.startswith("b/"): path = path[2:]
            if path != "/dev/null": files.add(path)
    return files

# ─── Repo management ─────────────────────────────────────────────────────────

def ensure_repo(repo_name: str) -> Path:
    short = repo_name.split("/")[1]
    repo_path = REPOS_DIR / short
    if repo_path.exists():
        return repo_path
    url = REPO_URLS[repo_name]
    print(f"  Cloning {repo_name} (bare)...")
    REPOS_DIR.mkdir(parents=True, exist_ok=True)
    git.Repo.clone_from(url, str(repo_path), bare=True)
    return repo_path

def checkout_worktree(bare_repo_path: Path, commit: str, worktree_path: Path) -> None:
    if worktree_path.exists():
        return
    bare = git.Repo(str(bare_repo_path))
    bare.git.worktree("add", "--detach", str(worktree_path), commit)

# ─── Fast retrievers (no API) ─────────────────────────────────────────────────

def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-zA-Z0-9]+", text.lower())

def bm25_retrieve(query: str, repo_path: Path, limit: int) -> list[str]:
    if not HAS_BM25:
        raise RuntimeError("rank_bm25 not installed.")
    files, corpus = [], []
    for p in repo_path.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(repo_path))
        parts = Path(rel).parts
        if any(part.startswith(".") for part in parts):
            continue
        if any(part in ("node_modules", "dist", "build", "__pycache__") for part in parts):
            continue
        try:
            first_line = p.read_text(errors="replace").splitlines()[0][:120] if p.stat().st_size > 0 else ""
        except Exception:
            first_line = ""
        files.append(rel)
        corpus.append(tokenize(rel + " " + first_line))
    if not corpus:
        return []
    bm25 = BM25Okapi(corpus)
    scores = bm25.get_scores(tokenize(query))
    return [f for _, f in sorted(zip(scores, files), reverse=True)[:limit]]

def semantic_retrieve(query: str, db_path: Path, limit: int) -> list[str]:
    env = {**os.environ, "SEMANTIC_SEARCH_DB": str(db_path)}
    result = subprocess.run(
        [NODE_BIN, NODE_TOOL, "search", query, "--limit", str(limit), "--json"],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Search failed: {result.stderr[:200]}")
    data = json.loads(result.stdout)
    worktree_prefix = db_path.stem + "/"
    paths = []
    for r in data:
        fp = r["filePath"]
        idx = fp.find(worktree_prefix)
        paths.append(fp[idx + len(worktree_prefix):] if idx != -1 else fp)
    return paths

def build_semantic_index(repo_path: Path, db_path: Path) -> None:
    env = {**os.environ, "SEMANTIC_SEARCH_ROOT": str(repo_path), "SEMANTIC_SEARCH_DB": str(db_path)}
    print(f"  Indexing {repo_path.name} → {db_path.name} ...")
    result = subprocess.run([NODE_BIN, NODE_TOOL, "index"], capture_output=False, text=True, env=env)
    if result.returncode != 0:
        raise RuntimeError(f"Indexing failed for {repo_path}")

# ─── Agent retrievers (Claude + tools) ───────────────────────────────────────

SUBMIT_TOOL = {
    "name": "submit_answer",
    "description": "Call this when you have identified the file(s) to change. Pass relative file paths.",
    "input_schema": {
        "type": "object",
        "properties": {
            "files": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["files"],
    },
}

SEMANTIC_TOOL_DEF = {
    "name": "semantic_search",
    "description": "Search the codebase by meaning. Returns ranked file paths with descriptions. Search multiple times with different queries if needed.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {"type": "string"}
        },
        "required": ["query"],
    },
}

BASH_TOOL_DEF = {
    "name": "bash",
    "description": "Run a read-only shell command in the repo. Allowed: grep, find, ls, wc.",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string"}
        },
        "required": ["command"],
    },
}

READ_FILE_TOOL = {
    "name": "read_file",
    "description": "Read a file, optionally between specific line numbers. Use this to inspect file contents.",
    "input_schema": {
        "type": "object",
        "properties": {
            "path":       {"type": "string",  "description": "Relative path from repo root"},
            "start_line": {"type": "integer", "description": "First line to read (1-indexed, optional)"},
            "end_line":   {"type": "integer", "description": "Last line to read (optional)"},
        },
        "required": ["path"],
    },
}

ALLOWED_CMDS = re.compile(r"^\s*(grep|find|ls|wc)\b")

def run_semantic_tool(query: str, db_path: Path, wt_path: Path | None = None) -> str:
    """Run hybrid search and return formatted output for the agent.
    SEMANTIC_BENCH_FORMAT env var: 'mcp' (v17b per-channel-entries) or 'short'
    (legacy `path — description[:120]` format used by v16 bench, default)."""
    env = {**os.environ, "SEMANTIC_SEARCH_DB": str(db_path)}
    if wt_path is not None:
        env["SEMANTIC_SEARCH_ROOT"] = str(wt_path)
    fmt = os.environ.get("SEMANTIC_BENCH_FORMAT", "short")
    if fmt == "mcp":
        result = subprocess.run(
            [NODE_BIN, NODE_TOOL, "search", query, "--limit", "5", "--format", "mcp"],
            capture_output=True, text=True, env=env, timeout=60,
        )
        if result.returncode != 0:
            return f"Error: {result.stderr[:200]}"
        worktree_prefix = db_path.stem + "/"
        return result.stdout.replace(worktree_prefix, "") or "No results found."
    result = subprocess.run(
        [NODE_BIN, NODE_TOOL, "search", query, "--limit", "5", "--json"],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if result.returncode != 0:
        return f"Error: {result.stderr[:200]}"
    try:
        data = json.loads(result.stdout)
        worktree_prefix = db_path.stem + "/"
        lines = []
        for r in data:
            fp = r["filePath"]
            idx = fp.find(worktree_prefix)
            fp = fp[idx + len(worktree_prefix):] if idx != -1 else fp
            lines.append(f"{fp}  —  {r.get('description', '')[:120]}")
        return "\n".join(lines) if lines else "No results found."
    except Exception as e:
        return f"Parse error: {e}"

def run_bash_tool(command: str, cwd: Path) -> str:
    if not ALLOWED_CMDS.match(command):
        return "Blocked: only grep, find, ls, wc are allowed. Use read_file to read file contents."
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, cwd=str(cwd), timeout=15,
        )
        output = (result.stdout + result.stderr).strip()
        return output[:3000] if output else "(no output)"
    except subprocess.TimeoutExpired:
        return "Timeout."

def run_read_file_tool(path: str, start_line: int | None, end_line: int | None, cwd: Path) -> str:
    full_path = cwd / path
    try:
        lines = full_path.read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return f"File not found: {path}"
    except Exception as e:
        return f"Error reading file: {e}"

    total = len(lines)
    lo = max(0, (start_line or 1) - 1)
    hi = min(total, end_line or total)
    chunk = lines[lo:hi]

    # Cap at ~200 lines to avoid token explosion
    if len(chunk) > 200:
        chunk = chunk[:200]
        truncated = True
    else:
        truncated = False

    result = "\n".join(f"{lo + i + 1}: {l}" for i, l in enumerate(chunk))
    if truncated:
        result += f"\n... (truncated — {total} lines total, showing {lo+1}-{lo+200})"
    return result or "(empty file)"

def agent_retrieve(
    client: Any,
    model: str,
    retriever: str,
    problem_statement: str,
    db_path: Path,
    wt_path: Path,
) -> dict[str, Any]:
    """Run a Claude agent to find files. Returns predicted paths + token metrics."""
    system = (
        "You are a code navigation assistant. Given a bug report, find the source file(s) "
        "most likely to need changing. Search as many times as you need. Call submit_answer when you are confident."
    )

    if retriever == "semantic-agent":
        tools = [SEMANTIC_TOOL_DEF, SUBMIT_TOOL]
        user_msg = f"Bug report:\n\n{problem_statement[:2000]}\n\nFind the file(s) that need changing."
    else:  # grep-agent
        tools = [BASH_TOOL_DEF, READ_FILE_TOOL, SUBMIT_TOOL]
        user_msg = (
            f"Bug report:\n\n{problem_statement[:2000]}\n\n"
            f"Find the file(s) that need changing. Repo root: {wt_path}\n"
            f"Source is under src/, packages/, or similar top-level dirs."
        )

    messages: list[dict] = [{"role": "user", "content": user_msg}]
    total_input = total_output = turns = 0
    submitted = None

    while turns < MAX_TURNS and submitted is None:
        response = client.messages.create(
            model=model, max_tokens=MAX_TOKENS, system=system,
            tools=tools, messages=messages,
        )
        if not hasattr(response, "usage"):
            raise RuntimeError(f"Unexpected API response: {str(response)[:200]}")

        total_input  += response.usage.input_tokens
        total_output += response.usage.output_tokens
        turns        += 1
        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            if block.name == "submit_answer":
                submitted = block.input.get("files", [])
                break
            elif block.name == "semantic_search":
                result_text = run_semantic_tool(block.input["query"], db_path, wt_path)
            elif block.name == "bash":
                result_text = run_bash_tool(block.input["command"], wt_path)
            elif block.name == "read_file":
                result_text = run_read_file_tool(
                    block.input["path"],
                    block.input.get("start_line"),
                    block.input.get("end_line"),
                    wt_path,
                )
            else:
                result_text = "Unknown tool."
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result_text})

        if submitted is not None:
            break

        if tool_results:
            messages.append({"role": "user", "content": tool_results})
        else:
            messages.append({"role": "user", "content": "Please call submit_answer with your best answer, or search further."})

    return {
        "predicted":      submitted or [],
        "input_tokens":   total_input,
        "output_tokens":  total_output,
        "total_tokens":   total_input + total_output,
        "turns":          turns,
    }

# ─── Metrics ─────────────────────────────────────────────────────────────────

def compute_metrics(gold: set[str], predicted: list[str]) -> dict[str, float]:
    all_files = list(gold | set(predicted))
    if not all_files:
        return {"recall": 0.0, "precision": 0.0, "f1": 0.0}
    y_true = [int(f in gold) for f in all_files]
    y_pred = [int(f in predicted) for f in all_files]
    return {
        "recall":    recall_score(y_true, y_pred, zero_division=0),
        "precision": precision_score(y_true, y_pred, zero_division=0),
        "f1":        f1_score(y_true, y_pred, zero_division=0),
    }

def recall_at_k(gold: set[str], predicted: list[str], k: int) -> float:
    return len(gold & set(predicted[:k])) / len(gold) if gold else 0.0

# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--retriever", default="bm25",
                   help="bm25, semantic, semantic-agent, grep-agent (comma-separated)")
    p.add_argument("--repos",          default="three.js")
    p.add_argument("--limit",          type=int, default=5)
    p.add_argument("--max-instances",  type=int, default=None)
    p.add_argument("--model",          default="claude-haiku-4-5-20251001")
    p.add_argument("--dataset",        default="AmazonScience/SWE-PolyBench_Verified")
    return p.parse_args()

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    retrievers = [r.strip() for r in args.retriever.split(",")]
    target_repos = list(SHORT_NAMES.values()) if args.repos == "all" else \
                   [SHORT_NAMES.get(r.strip(), r.strip()) for r in args.repos.split(",")]

    # Only load anthropic if needed
    client = None
    if any(r in AGENT_RETRIEVERS for r in retrievers):
        try:
            import anthropic as _anthropic
        except ImportError:
            print("Missing dep for agent retrievers: pip install anthropic")
            sys.exit(1)
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            print("ANTHROPIC_API_KEY not set (required for semantic-agent / grep-agent).")
            sys.exit(1)
        client = _anthropic.Anthropic(api_key=api_key, base_url="https://api.anthropic.com")

    print(f"Loading dataset {args.dataset}...")
    ds = load_dataset(args.dataset, split="test")
    instances = [r for r in ds if r["language"] in ("TypeScript", "JavaScript")]
    instances = [r for r in instances if r["repo"] in target_repos]
    print(f"  {len(instances)} JS+TS instances in target repos: {', '.join(target_repos)}")
    if args.max_instances:
        instances = instances[:args.max_instances]
        print(f"  Capped at {args.max_instances}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    REPOS_DIR.mkdir(parents=True, exist_ok=True)

    all_results: dict[str, list[dict]] = {r: [] for r in retrievers}

    by_repo: dict[str, list] = {}
    for inst in instances:
        by_repo.setdefault(inst["repo"], []).append(inst)

    for repo_name, repo_instances in by_repo.items():
        short = repo_name.split("/")[1]
        print(f"\n── {repo_name} ({len(repo_instances)} instances) ──")
        bare_path = ensure_repo(repo_name)

        for retriever in retrievers:
            print(f"\n  Retriever: {retriever}")
            commit_dbs: dict[str, Path] = {}

            for inst in repo_instances:
                instance_id = inst["instance_id"]
                commit      = inst["base_commit"]
                gold_files  = get_patch_files(inst["patch"])
                wt_path     = REPOS_DIR / f"{short}_{commit[:8]}"

                if not gold_files:
                    print(f"    [{instance_id}] skip — no files in patch")
                    continue

                try:
                    checkout_worktree(bare_path, commit, wt_path)

                    if retriever == "bm25":
                        predicted = bm25_retrieve(inst["problem_statement"], wt_path, args.limit)
                        token_info: dict = {}

                    elif retriever == "semantic":
                        if commit not in commit_dbs:
                            db_path = REPOS_DIR / f"{short}_{commit[:8]}.db"
                            if not db_path.exists():
                                build_semantic_index(wt_path, db_path)
                            commit_dbs[commit] = db_path
                        predicted = semantic_retrieve(inst["problem_statement"], commit_dbs[commit], args.limit)
                        token_info = {}

                    elif retriever in AGENT_RETRIEVERS:
                        if commit not in commit_dbs:
                            db_path = REPOS_DIR / f"{short}_{commit[:8]}.db"
                            if retriever == "semantic-agent" and not db_path.exists():
                                build_semantic_index(wt_path, db_path)
                            commit_dbs[commit] = db_path
                        agent_result = agent_retrieve(
                            client, args.model, retriever,
                            inst["problem_statement"],
                            commit_dbs[commit], wt_path,
                        )
                        predicted  = agent_result["predicted"]
                        token_info = {k: agent_result[k] for k in ("input_tokens", "output_tokens", "total_tokens", "turns")}

                    else:
                        raise ValueError(f"Unknown retriever: {retriever}")

                    metrics = compute_metrics(gold_files, predicted)
                    r1 = recall_at_k(gold_files, predicted, 1)
                    r3 = recall_at_k(gold_files, predicted, 3)
                    r5 = recall_at_k(gold_files, predicted, 5)

                    hit = "✓" if r5 == 1.0 else ("~" if r5 > 0 else "✗")
                    tok_str = f"  tokens={token_info['total_tokens']:6d}  turns={token_info['turns']}" if token_info else ""
                    print(f"    [{hit}] {instance_id[:40]:40s}  R@1={r1:.2f}  R@5={r5:.2f}{tok_str}  gold={sorted(gold_files)[:2]}")

                    all_results[retriever].append({
                        "instance_id":      instance_id,
                        "repo":             repo_name,
                        "gold_files":       sorted(gold_files),
                        "source_only_gold": gold_is_source_only(gold_files),
                        "predicted":        predicted,
                        "recall_at_1":      r1,
                        "recall_at_3":      r3,
                        "recall_at_5":      r5,
                        **metrics,
                        **token_info,
                    })

                except Exception as e:
                    print(f"    [!] {instance_id}: {e}")

    # ── Summary ───────────────────────────────────────────────────────────────
    print("\n" + "═" * 65)
    print("SUMMARY")
    print("═" * 65)

    # avg_tokens keyed by retriever, split by source_only
    summaries: dict[str, dict] = {}
    for retriever, results in all_results.items():
        if not results:
            continue
        n = len(results)
        avg_r1 = sum(r["recall_at_1"] for r in results) / n
        avg_r3 = sum(r["recall_at_3"] for r in results) / n
        avg_r5 = sum(r["recall_at_5"] for r in results) / n
        print(f"\n  {retriever} (n={n})")
        print(f"    R@1={avg_r1:.3f}  R@3={avg_r3:.3f}  R@5={avg_r5:.3f}")
        if "total_tokens" in results[0]:
            avg_tok   = sum(r["total_tokens"] for r in results) / n
            avg_turns = sum(r["turns"] for r in results) / n
            print(f"    Avg tokens: {avg_tok:.0f}  Avg turns: {avg_turns:.1f}")

            src_only = [r for r in results if r.get("source_only_gold")]
            docs_inc = [r for r in results if not r.get("source_only_gold")]
            if src_only and docs_inc:
                avg_tok_src = sum(r["total_tokens"] for r in src_only) / len(src_only)
                avg_tok_doc = sum(r["total_tokens"] for r in docs_inc) / len(docs_inc)
                print(f"      source-only gold (n={len(src_only)}): {avg_tok_src:.0f} avg tokens")
                print(f"      includes-docs    (n={len(docs_inc)}): {avg_tok_doc:.0f} avg tokens")

            summaries[retriever] = {
                "all":  avg_tok,
                "src":  sum(r["total_tokens"] for r in src_only) / len(src_only) if src_only else None,
            }

        out = RESULTS_DIR / f"{retriever.replace('-','_')}_results.jsonl"
        with open(out, "w") as f:
            for r in results:
                f.write(json.dumps(r) + "\n")
        print(f"    → {out}")

    if "semantic-agent" in summaries and "grep-agent" in summaries:
        s_all = summaries["semantic-agent"]["all"]
        g_all = summaries["grep-agent"]["all"]
        savings_all = (g_all - s_all) / g_all * 100
        print(f"\n  Token savings — all cases:              {savings_all:.0f}%  ({s_all:.0f} vs {g_all:.0f} avg tokens)")

        s_src = summaries["semantic-agent"].get("src")
        g_src = summaries["grep-agent"].get("src")
        if s_src and g_src:
            savings_src = (g_src - s_src) / g_src * 100
            print(f"  Token savings — source-only gold cases: {savings_src:.0f}%  ({s_src:.0f} vs {g_src:.0f} avg tokens)")
            print(f"  (docs-included cases skew 'all' — semantic gives up early on non-indexed files)")

if __name__ == "__main__":
    main()
