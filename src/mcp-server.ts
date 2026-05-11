import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { mkdirSync, openSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDescriber } from './describer.js';
import { initEmbedder } from './embedder.js';
import { PROJECT_ROOT } from './project.js';
import { renderMcpV17b } from './render.js';
import { search } from './search.js';
import { openDb } from './store.js';

// ─── Debounced background re-index ────────────────────────────────────────────
// On each search call we trigger an incremental re-index ONLY if (a) no recent
// in-process trigger and (b) the existing log file shows the previous index
// finished. mtime-gated Phase 0 makes this cheap on no-change runs (~3s on
// 2k-file repos); LLM cost only for changed files. Output → .search-code/
// last-index.log so users can `tail -f` for progress.

const DEBOUNCE_MS = 30_000;
const LOG_RUNNING_MS = 10_000; // if log mtime updated within 10s, treat as running
let lastReindexAt = 0;

function maybeTriggerBackgroundReindex(): void {
  const now = Date.now();
  if (now - lastReindexAt < DEBOUNCE_MS) return;

  const stateDir = path.join(PROJECT_ROOT, '.search-code');
  const logPath = path.join(stateDir, 'last-index.log');

  // If log was touched very recently, another reindex is likely still writing.
  // SQLite WAL handles concurrent writes anyway, but skipping avoids wasted
  // duplicate work across multiple Claude Code sessions sharing the same DB.
  try {
    const logMtime = statSync(logPath).mtimeMs;
    if (now - logMtime < LOG_RUNNING_MS) return;
  } catch {
    // log doesn't exist yet → fine, proceed
  }

  lastReindexAt = now;
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    return;
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, 'w');
  } catch {
    return;
  }

  const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
  const child = spawn(process.execPath, [cliPath, 'index'], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  child.unref();
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server({ name: 'codebase', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'searchCode',
      description:
        'Semantic + lexical hybrid code search. Returns ranked file paths with descriptions, line numbers, and similarity scores in a single round trip. Saves ~94% tokens vs grep-based exploration on conceptual lookups.\n\n## When to use searchCode (these queries should ALWAYS go here, NOT to grep/find)\n\nGood query: "function that formats relative time"\nGood query: "where authentication tokens are validated"\nGood query: "the plugin configuration system"\nGood query: "retry logic with exponential backoff"\nGood query: "code that prevents heap exhaustion when many agents run concurrently"\nGood query: "find all places that handle WebSocket reconnection"\n\nPattern: you describe WHAT the code does, not its name. You don\'t know the exact filename or symbol. You\'d otherwise read 3+ files speculatively to find it.\n\n## When to use grep instead (DO NOT call searchCode for these)\n\nBad searchCode query: "configurePlugins" → use `grep -rn "configurePlugins"` (you know the exact identifier)\nBad searchCode query: "TypeError: cannot read property" → use grep (exact error string)\nBad searchCode query: "useRollback" → use `grep -rn "useRollback"` (exact symbol name)\nBad searchCode query: "package.json" → use find/glob (exact filename)\n\nPattern: you already know the verbatim token. Grep is faster and exact for these.\n\n## Decision rule\n\nIf you are about to write `grep -r "foo"` because you already know the literal token `foo`, just grep. Use searchCode when you would otherwise read multiple files speculatively to figure out where something lives.\n\n## Result format\n\nEach result includes: file path, line range, symbol name, a description of what the code does, AND the actual chunk source (first 80 lines, truncated if longer). Results are ordered by hybrid rank — three independent retrievers (description embedding, code embedding, BM25 over rawCode + identifier splits) fused via Reciprocal Rank Fusion. Rank 1 is the best match; reason over the top 3-5 to pick. Allowlisted results are intentional duplicates — safe to ignore.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language description or code snippet to search for',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 5)',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'searchCode') {
    const query = (args as Record<string, unknown>)['query'] as string;
    const limit = (args as Record<string, unknown>)['limit'] as number | undefined;

    const results = await search(query, { limit });
    const text = renderMcpV17b(results, query, limit ?? 5);
    // Fire-and-forget incremental reindex so the next search reflects recent
    // edits. Debounced + lock-guarded; cheap on no-change runs via mtime gate.
    maybeTriggerBackgroundReindex();
    return { content: [{ type: 'text', text }] };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ─── Start ────────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  openDb();
  initEmbedder();
  initDescriber();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
