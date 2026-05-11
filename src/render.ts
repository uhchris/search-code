// MCP-style result rendering. Shared between the CLI `search --format mcp`
// path and the MCP server so both produce the same output shape: each chunk
// emits one row per channel that ranked it (desc shows description; code/bm25
// shows code body). Channels compete independently with no cross-channel
// dedup so the agent can see WHY each result ranked.

import { readFileSync } from 'fs';
import path from 'path';
import { PROJECT_ROOT } from './project.js';
import type { SearchResult } from './store.js';

const MAX_CHUNK_LINES = 80;

function readChunkSource(filePath: string, startLine: number, endLine: number): string | null {
  try {
    const abs = path.join(PROJECT_ROOT, filePath);
    const lines = readFileSync(abs, 'utf-8').split('\n');
    const slice = lines.slice(startLine - 1, endLine);
    if (slice.length > MAX_CHUNK_LINES) {
      return (
        slice.slice(0, MAX_CHUNK_LINES).join('\n') +
        `\n// ...truncated (${slice.length - MAX_CHUNK_LINES} more lines)`
      );
    }
    return slice.join('\n');
  } catch {
    return null;
  }
}

type Source = 'desc' | 'code' | 'bm25';
const SOURCE_PRIORITY: Record<Source, number> = { code: 0, bm25: 1, desc: 2 };

// Pre-dedup MCP renderer: each chunk emits one entry per channel that ranked
// it, so the same chunk may appear multiple times (once per winning channel).
// Lets the agent see WHY a chunk ranked — desc, code, or bm25 — instead of a
// flat sorted list. Channels compete independently.
export function renderMcp(results: SearchResult[], query: string, limit: number): string {
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

function formatEntries(
  display: Array<{ source: Source; rank: number; r: SearchResult }>,
  totalChunks: number,
  query: string,
  showAllChannels: boolean,
): string {
  const lines: string[] = [];
  if (showAllChannels) {
    lines.push(`Found ${totalChunks} chunks (${display.length} channel-entries) for: "${query}"`);
    lines.push(
      `Each chunk emits one entry per channel that ranked it. desc-channel rows show description; code/bm25 rows show code. Channels compete independently.`,
    );
  } else {
    lines.push(`Found ${display.length} results for: "${query}"`);
    lines.push(
      `Each chunk shown at its best-ranking channel. Code body for code/bm25 winners, description for desc winners.`,
    );
  }
  lines.push('');

  for (let i = 0; i < display.length; i++) {
    const { source, rank, r } = display[i];
    const symbolPart = r.symbolName ? `  [${r.symbolName}]` : '';
    // For chunk-deduped view, show ALL channel ranks so agent sees the full picture
    let allRanksTag = '';
    if (!showAllChannels) {
      const fmt = (v: number | null) => (v == null ? '#--' : `#${v}`);
      allRanksTag = `  desc:${fmt(r.descRank)} code:${fmt(r.codeRank)} bm25:${fmt(r.bm25Rank)}`;
    }
    const tag = showAllChannels ? `${source}:#${rank}` : `won via ${source}:#${rank}${allRanksTag}`;
    lines.push(`${i + 1}. ${r.filePath}:${r.startLine}-${r.endLine}${symbolPart}  ${tag}`);
    if (source === 'desc') {
      lines.push(`   ${r.description}`);
    } else {
      // Full chunk body. Snippet extraction was tested and regressed: fewer
      // lines per result caused more follow-up search calls and higher total
      // tokens. Agent retrieval rewards more context per call, not less.
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
