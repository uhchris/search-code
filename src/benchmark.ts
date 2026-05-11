import { execSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from './store.js';
import { initEmbedder } from './embedder.js';
import { initDescriber } from './describer.js';
import { search, type SearchOptions } from './search.js';
import type { SearchResult } from './store.js';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GROUND_TRUTH_PATH = path.join(__dirname, '..', 'benchmark', 'ground-truth.json');
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..', '..');

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
  | 'exact_symbol_with_context'    // Real-world failure: exact symbol mentioned in NL query
  | 'concept_with_constraint'      // Real-world failure: concept + flag-gate / path-constraint
  | 'concept_resolves_to_symbol'   // Real-world failure: concept that resolves to specific repo/symbol
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
  grepRecall1: boolean | null;
  grepRecall3: boolean | null;
  grepFiles: string[];
  grepTokens: number;
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
    debugLog(`\n⚠  countTokens ${label ? `(${label}) ` : ''}— no ANTHROPIC_API_KEY, using estimate`);
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
    const preview = content.length > 300 ? content.slice(0, 300) + `\n... [${content.length - 300} more chars]` : content;
    debugLog(`\n┌─ countTokens request ${label ? `(${label})` : ''}`);
    debugLog(`│  model:   ${request.model}`);
    debugLog(`│  chars:   ${content.length}`);
    debugLog(`│  messages: ${JSON.stringify(request.messages.map(m => ({ role: m.role, content_length: (m.content as string).length })))}`);
    if (debugFilePath) {
      // Full content in the file
      appendFileSync(debugFilePath, `│  content (full):\n`, 'utf8');
      for (const line of fullContent.split('\n')) appendFileSync(debugFilePath, `│    ${line}\n`, 'utf8');
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
    debugLog(`  countTokens ERROR (${label}): ${(err as Error).message} — falling back to estimate ${estimate}`);
    return estimate;
  }
}

// Format semantic results the way the MCP tool would return them to Claude
function formatSemanticContext(hits: SearchResult[], projectRoot: string): string {
  if (hits.length === 0) return '(no results)';

  return hits.map((h, i) => {
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
  }).join('\n\n');
}

// Format grep output the way an agent would receive it (rg with 3 lines context).
// Uses the single longest non-stop keyword — a competent agent picks one precise
// term rather than running three separate searches, which was inflating grep tokens.
function formatGrepContext(query: string, projectRoot: string): { files: string[]; text: string } {
  const stopWords = new Set([
    'a', 'an', 'the', 'that', 'this', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'for', 'and', 'or',
    'but', 'in', 'on', 'at', 'to', 'of', 'as', 'by', 'with', 'from', 'into',
    'like', 'such', 'based', 'can', 'will', 'would', 'could', 'should',
    'function', 'return', 'const', 'let', 'var',
  ]);

  const words = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopWords.has(w));

  if (words.length === 0) return { files: [], text: '(no grep results)' };

  // Pick the single longest keyword — longer = more discriminating, fewer false hits
  const keyword = words.slice().sort((a, b) => b.length - a.length)[0]!;

  const fileHits = new Map<string, number>();

  let output = '';
  try {
    output = execSync(
      `rg -n --context=3 --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs}' -t code -i "${keyword}" "${projectRoot}/src" "${projectRoot}/socket-server/src" 2>/dev/null | head -200 || true`,
      { encoding: 'utf8', timeout: 10_000 },
    );
  } catch { /* silently skip */ }

  if (!output.trim()) return { files: [], text: '(no grep results)' };

  const text = `# grep: "${keyword}"\n${output.trim()}`;

  for (const line of output.split('\n')) {
    const m = line.match(/^([^:]+):\d+:/);
    if (m) {
      const rel = path.relative(projectRoot, m[1]);
      fileHits.set(rel, (fileHits.get(rel) ?? 0) + 1);
    }
  }

  const files = [...fileHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);

  return { files, text };
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
      console.log(`  Grep     → R@1 ${checkmark(r.grepRecall1)}  R@3 ${checkmark(r.grepRecall3)}`);

      if (r.semanticTokens > 0 || r.grepTokens > 0) {
        const saved = r.grepTokens - r.semanticTokens;
        const note = r.grepTokens > 0
          ? `Semantic ${r.semanticTokens} tok | Grep ${r.grepTokens} tok | Saved ${Math.max(0, saved)} tok`
          : `Semantic ${r.semanticTokens} tok | Grep: not found`;
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
  const grepR1 = positives.filter((r) => r.grepRecall1).length;
  const grepR3 = positives.filter((r) => r.grepRecall3).length;
  const negPass = negatives.filter((r) => r.negativePassed).length;
  const totalPos = positives.length;
  const totalNeg = negatives.length;

  console.log(
    `Positive Recall@1: ${posR1}/${totalPos} (${pct(posR1, totalPos)}%)    Grep @1: ${grepR1}/${totalPos} (${pct(grepR1, totalPos)}%)`,
  );
  console.log(
    `Positive Recall@3: ${posR3}/${totalPos} (${pct(posR3, totalPos)}%)    Grep @3: ${grepR3}/${totalPos} (${pct(grepR3, totalPos)}%)`,
  );
  console.log(`Positive Recall@5: ${posR5}/${totalPos} (${pct(posR5, totalPos)}%)`);

  const mrrValues = positives.map((r) => r.semanticMrr ?? 0);
  const avgMrr = totalPos > 0 ? mrrValues.reduce((s, v) => s + v, 0) / totalPos : 0;
  console.log(`Avg MRR@10:        ${avgMrr.toFixed(3)}`);

  if (totalNeg > 0) {
    console.log(`Negative pass rate: ${negPass}/${totalNeg} (${pct(negPass, totalNeg)}%)`);
  }

  const semTok = positives.reduce((s, r) => s + r.semanticTokens, 0);
  const grepTok = positives.reduce((s, r) => s + r.grepTokens, 0);
  if (semTok > 0 || grepTok > 0) {
    const avgSem = totalPos > 0 ? Math.round(semTok / totalPos) : 0;
    const avgGrep = totalPos > 0 ? Math.round(grepTok / totalPos) : 0;
    console.log(
      `Avg tokens/query: Semantic ${avgSem} | Grep ${avgGrep} | Delta ${Math.max(0, avgGrep - avgSem)}`,
    );
  }
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 100);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runBenchmark(projectRoot: string, opts: { debug?: boolean; debugFile?: string } = {}): Promise<void> {
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

    // ── Grep baseline ──
    const { files: grepFiles, text: grepContext } = formatGrepContext(tc.query, projectRoot);
    const grepTokens = grepContext !== '(no grep results)'
      ? await countTokens(grepContext, `grep/${tc.id}`)
      : 0;

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
        id: tc.id, type: tc.type, query: tc.query,
        semanticRecall1: null, semanticRecall3: null, semanticRecall5: null,
        semanticMrr: null,
        semanticTopSim, semanticFiles, semanticTokens,
        grepRecall1: null, grepRecall3: null, grepFiles, grepTokens,
        negativePassed, expected: tc.expected,
      };
    } else {
      result = {
        id: tc.id, type: tc.type, query: tc.query,
        semanticRecall1: recall(semanticFiles, tc.expected, 1),
        semanticRecall3: recall(semanticFiles, tc.expected, 3),
        semanticRecall5: recall(semanticFiles, tc.expected, 5),
        semanticMrr: mrr(semanticFiles, tc.expected, 10),
        semanticTopSim, semanticFiles, semanticTokens,
        grepRecall1: recall(grepFiles, tc.expected, 1),
        grepRecall3: recall(grepFiles, tc.expected, 3),
        grepFiles, grepTokens,
        negativePassed: null, expected: tc.expected,
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
