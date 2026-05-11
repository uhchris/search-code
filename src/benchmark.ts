import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDescriber } from './describer.js';
import { initEmbedder } from './embedder.js';
import { search } from './search.js';
import type { SearchResult } from './store.js';
import { getDb, openDb } from './store.js';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GROUND_TRUTH_PATH = path.join(__dirname, '..', 'benchmark', 'ground-truth.json');

// Model used purely for tokenization — cheapest available, no generation
const TOKEN_COUNT_MODEL = 'claude-sonnet-4-6';

// ─── Types ────────────────────────────────────────────────────────────────────

type TestType =
  | 'duplicate_detection'
  | 'needle_in_haystack'
  | 'scattered_pattern'
  | 'paraphrase'
  | 'low_lexical_overlap'
  | 'error_symptom'
  | 'exact_symbol_with_context' // Real-world failure: exact symbol mentioned in NL query
  | 'concept_with_constraint' // Real-world failure: concept + flag-gate / path-constraint
  | 'concept_resolves_to_symbol' // Real-world failure: concept that resolves to specific repo/symbol
  | 'negative';

interface GroundTruthCase {
  id: string;
  query: string;
  type: TestType;
  expected: string[];
  note?: string;
  pass_condition?: string;
}

interface CaseResult {
  id: string;
  type: TestType;
  query: string;
  semanticRecall1: boolean | null;
  semanticRecall3: boolean | null;
  semanticRecall5: boolean | null;
  semanticMrr: number | null;
  semanticTopSim: number | null;
  semanticFiles: string[];
  semanticTokens: number;
  bm25Recall1: boolean | null;
  bm25Recall3: boolean | null;
  bm25Files: string[];
  bm25Tokens: number;
  negativePassed: boolean | null;
  expected: string[];
}

// ─── Token counting ───────────────────────────────────────────────────────────

let anthropic: Anthropic | null = null;
let debugMode = false;
let debugFilePath: string | null = null;

function debugLog(line: string): void {
  if (!debugMode) return;
  console.log(line);
  if (debugFilePath) appendFileSync(debugFilePath, line + '\n', 'utf8');
}

function getAnthropicClient(): Anthropic | null {
  if (anthropic) return anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  anthropic = new Anthropic({ apiKey: key });
  return anthropic;
}

async function countTokens(content: string, label?: string): Promise<number> {
  const client = getAnthropicClient();
  if (!client) {
    const estimate = Math.ceil(content.length / 3.5);
    debugLog(
      `\n⚠  countTokens ${label ? `(${label}) ` : ''}— no ANTHROPIC_API_KEY, using estimate`,
    );
    debugLog(`   chars: ${content.length}  →  estimated tokens: ${estimate}`);
    return estimate;
  }
  try {
    const request = {
      model: TOKEN_COUNT_MODEL,
      messages: [{ role: 'user' as const, content }],
    };

    // In file mode write the full content untruncated; console gets a 300-char preview
    const fullContent = content;
    const preview =
      content.length > 300
        ? content.slice(0, 300) + `\n... [${content.length - 300} more chars]`
        : content;
    debugLog(`\n┌─ countTokens request ${label ? `(${label})` : ''}`);
    debugLog(`│  model:   ${request.model}`);
    debugLog(`│  chars:   ${content.length}`);
    debugLog(
      `│  messages: ${JSON.stringify(request.messages.map((m) => ({ role: m.role, content_length: (m.content as string).length })))}`,
    );
    if (debugFilePath) {
      // Full content in the file
      appendFileSync(debugFilePath, `│  content (full):\n`, 'utf8');
      for (const line of fullContent.split('\n'))
        appendFileSync(debugFilePath, `│    ${line}\n`, 'utf8');
    } else {
      // Preview on console only
      console.log(`│  content preview:`);
      for (const line of preview.split('\n')) console.log(`│    ${line}`);
    }
    debugLog(`└─ calling client.messages.countTokens()...`);

    const result = await client.messages.countTokens(request);

    debugLog(`┌─ countTokens response ${label ? `(${label})` : ''}`);
    debugLog(`│  raw response: ${JSON.stringify(result)}`);
    debugLog(`└─ input_tokens: ${result.input_tokens}`);

    return result.input_tokens;
  } catch (err) {
    const estimate = Math.ceil(content.length / 3.5);
    debugLog(
      `  countTokens ERROR (${label}): ${(err as Error).message} — falling back to estimate ${estimate}`,
    );
    return estimate;
  }
}

// Format semantic results the way the MCP tool would return them to Claude
function formatSemanticContext(hits: SearchResult[], projectRoot: string): string {
  if (hits.length === 0) return '(no results)';

  return hits
    .map((h, i) => {
      // Read actual chunk lines from disk — this is exactly what the agent receives
      let chunkText = '';
      try {
        const lines = readFileSync(path.join(projectRoot, h.filePath), 'utf8').split('\n');
        chunkText = lines.slice(h.startLine - 1, h.endLine).join('\n');
      } catch {
        chunkText = h.description;
      }
      return [
        `[${i + 1}] ${h.filePath}:${h.startLine}-${h.endLine} (similarity: ${h.similarity.toFixed(2)})`,
        `Description: ${h.description}`,
        '```',
        chunkText,
        '```',
      ].join('\n');
    })
    .join('\n\n');
}

// Format BM25 baseline results in the same shape as semantic results so token
// counts are an apples-to-apples comparison. The lexical retriever is
// SQLite FTS5 with `porter unicode61` stemming + IDF over the indexed corpus —
// identical to the sparse channel used inside `searchHybrid`. No hand-rolled
// stopwords, no toy stemmer, no NL→grep guessing: the question this benchmark
// now answers is "how much does semantic add over the best lexical retriever
// the repo can build from the same index?".
interface Bm25Hit {
  filePath: string;
  startLine: number;
  endLine: number;
  description: string | null;
  rank: number;
}

// OR-joined FTS5 BM25 query. Note: this differs from `searchByCodeBm25` in
// store.ts, which AND-joins terms. AND-join is the right call for the *hybrid
// composition* (where dense channels protect recall and BM25 is asked to be
// precise) — but for a *standalone lexical baseline* it is too strict and
// returns 0 hits on most NL queries. OR-join is the default behaviour of
// Lucene/Elasticsearch and is therefore the apples-to-apples lexical
// comparator for this benchmark.
function fetchBm25Hits(query: string, limit: number): Bm25Hit[] {
  const tokens = query
    .replace(/["*()^]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.join(' OR ');

  let rows: Array<{
    rowid: number;
    file_path: string;
    start_line: number;
    end_line: number;
    description: string | null;
  }>;
  try {
    rows = getDb()
      .prepare(
        `SELECT cf.rowid AS rowid, c.file_path, c.start_line, c.end_line, c.description
         FROM chunks_code_fts cf
         JOIN chunks c ON c.id = cf.rowid
         WHERE cf.content MATCH ?
         ORDER BY -bm25(chunks_code_fts) DESC
         LIMIT ?`,
      )
      .all(ftsQuery, limit * 4) as Array<{
      rowid: number;
      file_path: string;
      start_line: number;
      end_line: number;
      description: string | null;
    }>;
  } catch {
    return [];
  }

  // Dedupe by file_path; recall in the benchmark is measured at file level.
  const hits: Bm25Hit[] = [];
  const seenPaths = new Set<string>();
  let rank = 0;
  for (const row of rows) {
    if (seenPaths.has(row.file_path)) continue;
    seenPaths.add(row.file_path);
    rank++;
    hits.push({
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      description: row.description,
      rank,
    });
    if (hits.length === limit) break;
  }
  return hits;
}

function formatBm25Context(
  hits: Bm25Hit[],
  projectRoot: string,
): { files: string[]; text: string } {
  if (hits.length === 0) return { files: [], text: '(no bm25 results)' };

  const text = hits
    .map((h, i) => {
      let chunkText = '';
      try {
        const lines = readFileSync(path.join(projectRoot, h.filePath), 'utf8').split('\n');
        chunkText = lines.slice(h.startLine - 1, h.endLine).join('\n');
      } catch {
        chunkText = h.description ?? '';
      }
      const header = `[${i + 1}] ${h.filePath}:${h.startLine}-${h.endLine} (bm25 rank: ${h.rank})`;
      return h.description
        ? [header, `Description: ${h.description}`, '```', chunkText, '```'].join('\n')
        : [header, '```', chunkText, '```'].join('\n');
    })
    .join('\n\n');

  return { files: hits.map((h) => h.filePath), text };
}

// ─── Recall helpers ───────────────────────────────────────────────────────────

function recall(found: string[], expected: string[], k: number): boolean {
  if (expected.length === 0) return false;
  const topK = new Set(found.slice(0, k));
  return expected.some((e) => topK.has(e));
}

function recallCount(found: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const topK = new Set(found.slice(0, k));
  return expected.filter((e) => topK.has(e)).length;
}

function mrr(found: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 0;
  const expectedSet = new Set(expected);
  for (let i = 0; i < Math.min(found.length, k); i++) {
    if (expectedSet.has(found[i]!)) return 1 / (i + 1);
  }
  return 0;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function checkmark(v: boolean | null): string {
  if (v === null) return ' — ';
  return v ? '✓' : '✗';
}

function renderResults(results: CaseResult[], usingRealTokenizer: boolean): void {
  const tokenizerNote = usingRealTokenizer
    ? '(tokens via claude countTokens API)'
    : '(tokens estimated ~3.5 chars/token — set ANTHROPIC_API_KEY for exact counts)';

  console.log(`\n=== Semantic Search Benchmark ===\n${tokenizerNote}\n`);

  const positives = results.filter((r) => r.type !== 'negative');
  const negatives = results.filter((r) => r.type === 'negative');

  for (const r of results) {
    console.log(`[${r.id}] ${r.type}`);
    console.log(`  Query: "${r.query}"`);

    if (r.type === 'negative') {
      const status = r.negativePassed ? 'PASS' : 'FAIL';
      console.log(`  Semantic → top sim=${r.semanticTopSim?.toFixed(2) ?? 'n/a'}  ${status}`);
    } else {
      const sim = r.semanticTopSim != null ? `sim=${r.semanticTopSim.toFixed(2)}` : 'no results';
      const mrrStr = r.semanticMrr != null ? `MRR=${r.semanticMrr.toFixed(2)}` : '';
      console.log(
        `  Semantic → R@1 ${checkmark(r.semanticRecall1)}  R@3 ${checkmark(r.semanticRecall3)}  R@5 ${checkmark(r.semanticRecall5)}  ${mrrStr}  ${sim}`,
      );
      if (r.semanticFiles.length > 0) {
        console.log(`    Files: ${r.semanticFiles.slice(0, 3).join(', ')}`);
      }
      console.log(`  BM25     → R@1 ${checkmark(r.bm25Recall1)}  R@3 ${checkmark(r.bm25Recall3)}`);

      if (r.semanticTokens > 0 || r.bm25Tokens > 0) {
        const saved = r.bm25Tokens - r.semanticTokens;
        const note =
          r.bm25Tokens > 0
            ? `Semantic ${r.semanticTokens} tok | BM25 ${r.bm25Tokens} tok | Saved ${Math.max(0, saved)} tok`
            : `Semantic ${r.semanticTokens} tok | BM25: not found`;
        console.log(`  Tokens   → ${note}`);
      }
    }
    console.log();
  }

  // ── Summary ──
  console.log('=== Summary ===');

  const posR1 = positives.filter((r) => r.semanticRecall1).length;
  const posR3 = positives.filter((r) => r.semanticRecall3).length;
  const posR5 = positives.filter((r) => r.semanticRecall5).length;
  const bm25R1 = positives.filter((r) => r.bm25Recall1).length;
  const bm25R3 = positives.filter((r) => r.bm25Recall3).length;
  const negPass = negatives.filter((r) => r.negativePassed).length;
  const totalPos = positives.length;
  const totalNeg = negatives.length;

  console.log(
    `Positive Recall@1: ${posR1}/${totalPos} (${pct(posR1, totalPos)}%)    BM25 @1: ${bm25R1}/${totalPos} (${pct(bm25R1, totalPos)}%)`,
  );
  console.log(
    `Positive Recall@3: ${posR3}/${totalPos} (${pct(posR3, totalPos)}%)    BM25 @3: ${bm25R3}/${totalPos} (${pct(bm25R3, totalPos)}%)`,
  );
  console.log(`Positive Recall@5: ${posR5}/${totalPos} (${pct(posR5, totalPos)}%)`);

  const mrrValues = positives.map((r) => r.semanticMrr ?? 0);
  const avgMrr = totalPos > 0 ? mrrValues.reduce((s, v) => s + v, 0) / totalPos : 0;
  console.log(`Avg MRR@10:        ${avgMrr.toFixed(3)}`);

  if (totalNeg > 0) {
    console.log(`Negative pass rate: ${negPass}/${totalNeg} (${pct(negPass, totalNeg)}%)`);
  }

  const semTok = positives.reduce((s, r) => s + r.semanticTokens, 0);
  const bm25Tok = positives.reduce((s, r) => s + r.bm25Tokens, 0);
  if (semTok > 0 || bm25Tok > 0) {
    const avgSem = totalPos > 0 ? Math.round(semTok / totalPos) : 0;
    const avgBm25 = totalPos > 0 ? Math.round(bm25Tok / totalPos) : 0;
    console.log(
      `Avg tokens/query: Semantic ${avgSem} | BM25 ${avgBm25} | Delta ${Math.max(0, avgBm25 - avgSem)}`,
    );
  }
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runBenchmark(
  projectRoot: string,
  opts: { debug?: boolean; debugFile?: string } = {},
): Promise<void> {
  debugMode = opts.debug ?? false;
  debugFilePath = opts.debugFile ?? null;

  if (debugFilePath) {
    // Truncate/create the file fresh each run
    writeFileSync(debugFilePath, `=== Benchmark Debug Log ===\n\n`, 'utf8');
    console.log(`Debug output → ${debugFilePath}\n`);
  }

  const cases: GroundTruthCase[] = JSON.parse(readFileSync(GROUND_TRUTH_PATH, 'utf8'));

  openDb();
  initEmbedder();
  initDescriber();

  const usingRealTokenizer = !!process.env.ANTHROPIC_API_KEY;
  if (!usingRealTokenizer) {
    const msg = 'Note: ANTHROPIC_API_KEY not set — using char/3.5 token estimate.';
    console.log(msg + '\n');
    if (debugFilePath) appendFileSync(debugFilePath, msg + '\n\n', 'utf8');
  }
  if (debugMode) {
    const msg = `Debug mode ON — logging every countTokens request + raw response.`;
    console.log(msg + '\n');
    if (debugFilePath) appendFileSync(debugFilePath, msg + '\n\n', 'utf8');
  }

  const results: CaseResult[] = [];

  for (const tc of cases) {
    process.stdout.write(`Running [${tc.id}]...`);
    const isNegative = tc.type === 'negative';

    // ── Semantic search ──
    let semanticHits: SearchResult[] = [];
    let semanticTopSim: number | null = null;
    let semanticTokens = 0;

    try {
      semanticHits = await search(tc.query, { limit: 5 });
      semanticTopSim = semanticHits[0]?.similarity ?? null;
      const semanticContext = formatSemanticContext(semanticHits, projectRoot);
      semanticTokens = await countTokens(semanticContext, `semantic/${tc.id}`);
    } catch (err) {
      console.error(`\n  Search error for [${tc.id}]:`, err);
    }

    const semanticFiles = semanticHits.map((h) => h.filePath);

    // ── BM25 baseline (FTS5 porter unicode61 over rawCode) ──
    const bm25Hits = fetchBm25Hits(tc.query, 5);
    const { files: bm25Files, text: bm25Context } = formatBm25Context(bm25Hits, projectRoot);
    const bm25Tokens =
      bm25Context !== '(no bm25 results)' ? await countTokens(bm25Context, `bm25/${tc.id}`) : 0;

    // ── Compute metrics ──
    let result: CaseResult;

    if (isNegative) {
      let negativePassed = false;
      if (tc.pass_condition?.includes('similarity < 0.5')) {
        negativePassed = semanticTopSim == null || semanticTopSim < 0.5;
      } else if (tc.pass_condition?.includes('similarity > 0.8')) {
        negativePassed = semanticTopSim == null || semanticTopSim <= 0.8;
      } else {
        negativePassed = semanticTopSim == null || semanticTopSim < 0.5;
      }

      result = {
        id: tc.id,
        type: tc.type,
        query: tc.query,
        semanticRecall1: null,
        semanticRecall3: null,
        semanticRecall5: null,
        semanticMrr: null,
        semanticTopSim,
        semanticFiles,
        semanticTokens,
        bm25Recall1: null,
        bm25Recall3: null,
        bm25Files,
        bm25Tokens,
        negativePassed,
        expected: tc.expected,
      };
    } else {
      result = {
        id: tc.id,
        type: tc.type,
        query: tc.query,
        semanticRecall1: recall(semanticFiles, tc.expected, 1),
        semanticRecall3: recall(semanticFiles, tc.expected, 3),
        semanticRecall5: recall(semanticFiles, tc.expected, 5),
        semanticMrr: mrr(semanticFiles, tc.expected, 10),
        semanticTopSim,
        semanticFiles,
        semanticTokens,
        bm25Recall1: recall(bm25Files, tc.expected, 1),
        bm25Recall3: recall(bm25Files, tc.expected, 3),
        bm25Files,
        bm25Tokens,
        negativePassed: null,
        expected: tc.expected,
      };

      const r3count = recallCount(semanticFiles, tc.expected, 3);
      console.log(` R@3 ${r3count}/${tc.expected.length} found`);
    }

    if (isNegative) console.log(` ${result.negativePassed ? 'PASS' : 'FAIL'}`);
    results.push(result);
  }

  console.log();
  renderResults(results, usingRealTokenizer);
}
