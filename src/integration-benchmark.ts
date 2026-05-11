import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from './store.js';
import { initEmbedder } from './embedder.js';
import { initDescriber } from './describer.js';
import { search } from './search.js';
import type { SearchResult } from './store.js';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GROUND_TRUTH_PATH = path.join(__dirname, '..', 'benchmark', 'ground-truth.json');

// Haiku — cheapest, integration test cares about tool mechanics not answer quality
// eslint-disable-next-line @typescript-eslint/no-inferrable-types
const AGENT_MODEL: string = 'claude-haiku-4-5-20251001';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GroundTruthCase {
  id: string;
  query: string;
  type: string;
  expected: string[];
  pass_condition?: string;
}

interface RunResult {
  toolCalled: boolean;
  toolQuery: string | null;
  toolResultFiles: string[];
  recall1: boolean | null;
  recall3: boolean | null;
  inputTokens: number;
  outputTokens: number;
}

interface CaseResult {
  id: string;
  type: string;
  query: string;
  expected: string[];
  withTool: RunResult;
  noTool: RunResult;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const SEARCH_TOOL = {
  name: 'searchCode',
  description:
    'Search the codebase for existing code by semantic meaning. Use this to find implementations, components, or patterns before writing new code.',
  input_schema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language description of what you are looking for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 5)',
      },
    },
    required: ['query'],
  },
};

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeSearch(input: { query: string; limit?: number }): Promise<SearchResult[]> {
  return search(input.query, { limit: input.limit ?? 5 });
}

function formatToolResult(hits: SearchResult[]): string {
  if (hits.length === 0) return 'No results found.';
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.filePath}:${h.startLine}-${h.endLine} (similarity: ${h.similarity.toFixed(2)})\nDescription: ${h.description}`,
    )
    .join('\n\n');
}

// ─── Single agent run ─────────────────────────────────────────────────────────

async function agentRun(
  client: Anthropic,
  query: string,
  expected: string[],
  mode: 'with-tool' | 'no-tool',
  debug: boolean,
): Promise<RunResult> {
  const prompt = mode === 'with-tool'
    ? `Find: "${query}". You may only use the searchCode tool — do not answer from memory.`
    : `Find: "${query}".`;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];

  let toolCalled = false;
  let toolQuery: string | null = null;
  let toolResultFiles: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: AGENT_MODEL,
    max_tokens: 512,
    messages,
    stream: false,
    ...(mode === 'with-tool' && {
      tools: [SEARCH_TOOL],
      tool_choice: { type: 'tool', name: 'searchCode' },
    }),
  };

  for (let turn = 0; turn < 5; turn++) {
    if (debug) {
      console.log(`\n    [${mode} turn ${turn + 1}] tool_choice=${JSON.stringify(createParams.tool_choice ?? 'none')}`);
    }

    createParams.messages = messages;
    const response = await client.messages.create(createParams);

    if (debug) {
      console.log(`    stop_reason: ${response.stop_reason}  usage: ${JSON.stringify(response.usage)}`);
      console.log(`    content: ${JSON.stringify(response.content)}`);
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      // After the tool call, prevent further tool calls so token counts are comparable
      createParams.tool_choice = { type: 'auto' };
      createParams.tools = undefined;

      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        toolCalled = true;
        toolQuery = (block.input as { query: string }).query;
        const hits = await executeSearch(block.input as { query: string; limit?: number });
        toolResultFiles = hits.map((h) => h.filePath);
        if (debug) {
          console.log(`    tool result: ${hits.map(h => h.filePath).join(', ')}`);
        }
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: formatToolResult(hits) });
      }
      messages.push({ role: 'user', content: toolResultBlocks });
      continue;
    }

    break;
  }

  const recallAt = (k: number): boolean | null => {
    if (expected.length === 0) return null;
    const topK = new Set(toolResultFiles.slice(0, k));
    return expected.some((e) => topK.has(e));
  };

  return { toolCalled, toolQuery, toolResultFiles, recall1: recallAt(1), recall3: recallAt(3), inputTokens, outputTokens };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mark(v: boolean | null): string {
  if (v === null) return '—';
  return v ? '✓' : '✗';
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runIntegrationBenchmark(opts: { debug?: boolean } = {}): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is required for the integration benchmark.');
    console.error('Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const cases: GroundTruthCase[] = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf8'));

  openDb();
  initEmbedder();
  initDescriber();

  console.log('=== Integration Benchmark ===');
  console.log(`Model:  ${AGENT_MODEL}`);
  console.log(`Cases:  ${cases.length}`);
  console.log(`Runs:   2 per case (with tool forced | no tool)\n`);

  const results: CaseResult[] = [];

  for (const tc of cases) {
    const isNegative = tc.type === 'negative';
    process.stdout.write(`[${tc.id}]`);

    process.stdout.write(' with-tool...');
    const withTool = await agentRun(client, tc.query, tc.expected, 'with-tool', opts.debug ?? false);

    process.stdout.write(' no-tool...');
    const noTool = await agentRun(client, tc.query, tc.expected, 'no-tool', opts.debug ?? false);

    results.push({ id: tc.id, type: tc.type, query: tc.query, expected: tc.expected, withTool, noTool });

    if (isNegative) {
      console.log(` tool called: ${withTool.toolCalled ? 'yes' : 'no'}`);
    } else {
      console.log(
        ` with-tool R@3 ${mark(withTool.recall3)}  no-tool R@3 ${mark(noTool.recall3)}`,
      );
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  const positives = results.filter((r) => r.type !== 'negative');
  const negatives = results.filter((r) => r.type === 'negative');
  const totalPos = positives.length;

  const wR1 = positives.filter((r) => r.withTool.recall1).length;
  const wR3 = positives.filter((r) => r.withTool.recall3).length;
  const nR1 = positives.filter((r) => r.noTool.recall1).length;
  const nR3 = positives.filter((r) => r.noTool.recall3).length;

  const wIn = results.reduce((s, r) => s + r.withTool.inputTokens, 0);
  const wOut = results.reduce((s, r) => s + r.withTool.outputTokens, 0);
  const nIn = results.reduce((s, r) => s + r.noTool.inputTokens, 0);
  const nOut = results.reduce((s, r) => s + r.noTool.outputTokens, 0);

  console.log('\n=== Summary ===\n');
  console.log(`                   With tool   No tool`);
  console.log(`  Recall@1         ${String(wR1 + '/' + totalPos + ' (' + pct(wR1, totalPos) + '%)').padEnd(12)}${nR1}/${totalPos} (${pct(nR1, totalPos)}%)`);
  console.log(`  Recall@3         ${String(wR3 + '/' + totalPos + ' (' + pct(wR3, totalPos) + '%)').padEnd(12)}${nR3}/${totalPos} (${pct(nR3, totalPos)}%)`);
  console.log(`  Avg input tok    ${String(Math.round(wIn / results.length).toLocaleString()).padEnd(12)}${Math.round(nIn / results.length).toLocaleString()}`);
  console.log(`  Avg output tok   ${String(Math.round(wOut / results.length).toLocaleString()).padEnd(12)}${Math.round(nOut / results.length).toLocaleString()}`);

  if (negatives.length > 0) {
    const negCalled = negatives.filter((r) => r.withTool.toolCalled).length;
    console.log(`\n  Negative cases tool called: ${negCalled}/${negatives.length}`);
  }

  console.log('\n─── Per-case ───');
  for (const r of results) {
    const isNeg = r.type === 'negative';
    console.log(`\n[${r.id}] ${r.type}`);
    console.log(`  Query:    "${r.query}"`);
    if (!isNeg) {
      console.log(`  Expected: ${r.expected.join(', ')}`);
      console.log(`  With tool → R@1 ${mark(r.withTool.recall1)}  R@3 ${mark(r.withTool.recall3)}  got: ${r.withTool.toolResultFiles.slice(0, 3).join(', ') || '(none)'}`);
      console.log(`  No tool   → R@1 ${mark(r.noTool.recall1)}  R@3 ${mark(r.noTool.recall3)}  (agent is blind)`);
    } else {
      console.log(`  With tool → tool called: ${r.withTool.toolCalled ? 'yes' : 'no'}`);
      console.log(`  No tool   → tool called: no (not registered)`);
    }
    console.log(`  Tokens    → with: in=${r.withTool.inputTokens} out=${r.withTool.outputTokens}  no: in=${r.noTool.inputTokens} out=${r.noTool.outputTokens}`);
  }
}
