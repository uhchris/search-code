import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { openDb } from './store.js';
import { initEmbedder } from './embedder.js';
import { initDescriber } from './describer.js';
import { search } from './search.js';
import { renderMcpV17b } from './render.js';

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'codebase', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

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
