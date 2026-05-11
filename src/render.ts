// MCP-style result rendering. Extracted so the CLI `search --format mcp` and
// the MCP server share one source of truth for output shape. Versioning aligns
// with results docs:
//   v17b — per-channel-entries: each chunk emits one row per channel that
//          ranked it. desc-channel rows show description; code/bm25 rows show
//          code body. Channels compete independently. No cross-channel dedup.

import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './project.js';
import type { SearchResult } from './store.js';

const MAX_CHUNK_LINES = 80;
const SNIPPET_CONTEXT = 2;       // lines of context around each matching line
const SNIPPET_FALLBACK_LINES = 10; // signature lines when no token overlap

// Tokenize query for line-level highlighting. Lowercases, splits on
// non-alphanumeric, drops short words and FTS5 operator chars. Identifier
// splits (Lucene WDG rules) ARE NOT applied here — the goal is to find lines
// that contain literal query terms so the agent sees the matching code line,
// not synthesize new vocabulary.
function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length >= 3);
}

// Score a line by count of distinct query tokens it contains (case-insensitive
// substring match). Returns 0 if line is empty or contains nothing.
function lineScore(line: string, tokens: string[]): number {
  if (!line.trim()) return 0;
  const lower = line.toLowerCase();
  let hits = 0;
  for (const t of tokens) if (lower.includes(t)) hits++;
  return hits;
}

// Build a relevance-targeted snippet of the chunk: pick lines with the highest
// query-token overlap, expand with ±SNIPPET_CONTEXT neighbors, splice with
// `// ...` markers between gaps. If no line has any token overlap (pure
// paraphrase match via dense channel), return the first SNIPPET_FALLBACK_LINES
// lines as a signature view. Agent always gets bounded payload.
function extractSnippet(filePath: string, startLine: number, endLine: number, query: string): string | null {
  try {
    const abs = path.join(PROJECT_ROOT, filePath);
    const all = readFileSync(abs, 'utf-8').split('\n');
    const lines = all.slice(startLine - 1, endLine);
    const tokens = queryTokens(query);

    // No tokens to match (very short query) → first N lines fallback.
    if (tokens.length === 0) {
      const slice = lines.slice(0, SNIPPET_FALLBACK_LINES);
      return slice.join('\n') + (lines.length > slice.length ? `\n// ... omitted (${lines.length - slice.length} more lines)` : '');
    }

    // Score every line, pick top scorers (>0 hits) with their indices.
    const scored = lines.map((l, i) => ({ idx: i, score: lineScore(l, tokens) })).filter((s) => s.score > 0);

    if (scored.length === 0) {
      // No literal matches (paraphrase-only match). Show signature.
      const slice = lines.slice(0, SNIPPET_FALLBACK_LINES);
      return slice.join('\n') + (lines.length > slice.length ? `\n// ... omitted (${lines.length - slice.length} more lines)` : '');
    }

    // Pick top-5 hit lines (or all if fewer), expand with ±context.
    const TOP_HITS = 5;
    const topIdxs = scored.sort((a, b) => b.score - a.score).slice(0, TOP_HITS).map((s) => s.idx);

    // Build set of line indices to include (top hits + their context windows).
    const include = new Set<number>();
    for (const i of topIdxs) {
      for (let j = Math.max(0, i - SNIPPET_CONTEXT); j <= Math.min(lines.length - 1, i + SNIPPET_CONTEXT); j++) {
        include.add(j);
      }
    }

    // Walk lines in order, emit included ones; emit `// ...` marker on each gap.
    const sorted = [...include].sort((a, b) => a - b);
    const out: string[] = [];
    let prev = -1;
    for (const i of sorted) {
      if (prev !== -1 && i !== prev + 1) {
        const skipped = i - prev - 1;
        out.push(`// ... omitted (${skipped} lines)`);
      }
      out.push(lines[i]);
      prev = i;
    }
    if (prev !== -1 && prev < lines.length - 1) {
      const trailing = lines.length - 1 - prev;
      out.push(`// ... omitted (${trailing} lines)`);
    }
    return out.join('\n');
  } catch {
    return null;
  }
}

// Read full chunk (used when caller wants the whole thing — kept for renderers
// that don't want snippet extraction).
function readChunkSource(filePath: string, startLine: number, endLine: number): string | null {
  try {
    const abs = path.join(PROJECT_ROOT, filePath);
    const lines = readFileSync(abs, 'utf-8').split('\n');
    const slice = lines.slice(startLine - 1, endLine);
    if (slice.length > MAX_CHUNK_LINES) {
      return slice.slice(0, MAX_CHUNK_LINES).join('\n') + `\n// ...truncated (${slice.length - MAX_CHUNK_LINES} more lines)`;
    }
    return slice.join('\n');
  } catch {
    return null;
  }
}

type Source = 'desc' | 'code' | 'bm25';
const SOURCE_PRIORITY: Record<Source, number> = { code: 0, bm25: 1, desc: 2 };

// v17b — pre-dedup: each chunk emits one entry per channel that ranked it.
// Same chunk can appear multiple times in different positions. Used for
// debugging and bench comparisons; v17c is the production default.
export function renderMcpV17b(results: SearchResult[], query: string, limit: number): string {
  if (results.length === 0) return `No results found for: "${query}"`;
  type Entry = { source: Source; rank: number; r: SearchResult };
  const entries: Entry[] = [];
  for (const r of results) {
    if (r.descRank != null) entries.push({ source: 'desc', rank: r.descRank, r });
    if (r.codeRank != null) entries.push({ source: 'code', rank: r.codeRank, r });
    if (r.bm25Rank != null) entries.push({ source: 'bm25', rank: r.bm25Rank, r });
  }
  entries.sort((a, b) => a.rank - b.rank || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  const display = entries.slice(0, limit * 3);
  return formatEntries(display, results.length, query, true);
}

// v17c — chunk-deduped winning-channel: one entry per chunk at its best
// channel rank. If code:#1 + desc:#3 for the same chunk, only the code:#1
// row is shown. Source = whichever channel ranked the chunk lowest (best).
// Cheaper than v17b (no duplicate chunk rows) and matches user's mental model
// of "winning channel takes the spot".
export function renderMcpV17c(results: SearchResult[], query: string, limit: number): string {
  if (results.length === 0) return `No results found for: "${query}"`;
  type Entry = { source: Source; rank: number; r: SearchResult };
  const entries: Entry[] = [];
  for (const r of results) {
    let best: { source: Source; rank: number } | null = null;
    if (r.codeRank != null) best = { source: 'code', rank: r.codeRank };
    if (r.bm25Rank != null && (!best || r.bm25Rank < best.rank)) best = { source: 'bm25', rank: r.bm25Rank };
    if (r.descRank != null && (!best || r.descRank < best.rank)) best = { source: 'desc', rank: r.descRank };
    if (best) entries.push({ ...best, r });
  }
  entries.sort((a, b) => a.rank - b.rank || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  const display = entries.slice(0, limit);
  return formatEntries(display, results.length, query, false);
}

function formatEntries(
  display: Array<{ source: Source; rank: number; r: SearchResult }>,
  totalChunks: number,
  query: string,
  showAllChannels: boolean,
): string {
  const lines: string[] = [];
  if (showAllChannels) {
    lines.push(`Found ${totalChunks} chunks (${display.length} channel-entries) for: "${query}"`);
    lines.push(`Each chunk emits one entry per channel that ranked it. desc-channel rows show description; code/bm25 rows show code. Channels compete independently.`);
  } else {
    lines.push(`Found ${display.length} results for: "${query}"`);
    lines.push(`Each chunk shown at its best-ranking channel. Code body for code/bm25 winners, description for desc winners.`);
  }
  lines.push('');

  for (let i = 0; i < display.length; i++) {
    const { source, rank, r } = display[i];
    const symbolPart = r.symbolName ? `  [${r.symbolName}]` : '';
    // For chunk-deduped view, show ALL channel ranks so agent sees the full picture
    let allRanksTag = '';
    if (!showAllChannels) {
      const fmt = (v: number | null) => v == null ? '#--' : `#${v}`;
      allRanksTag = `  desc:${fmt(r.descRank)} code:${fmt(r.codeRank)} bm25:${fmt(r.bm25Rank)}`;
    }
    const tag = showAllChannels ? `${source}:#${rank}` : `won via ${source}:#${rank}${allRanksTag}`;
    lines.push(`${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}${symbolPart}  ${tag}`);
    if (source === 'desc') {
      lines.push(`   ${r.description}`);
    } else {
      // Full chunk body. Snippet extraction (extractSnippet) was tested and
      // regressed — fewer lines per result caused more search calls (8.8 → 11.2
      // turns) and HIGHER total tokens (226K → 240K). Agent retrieval rewards
      // more context per call, not less.
      const code = readChunkSource(r.filePath, r.startLine, r.endLine);
      if (code !== null) {
        lines.push('```');
        lines.push(code);
        lines.push('```');
      }
    }
    if (r.allowlisted) lines.push(`   [ALLOWLISTED: approved co-occurrence]`);
    if (i < display.length - 1) lines.push('');
  }
  return lines.join('\n');
}
