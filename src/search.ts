import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb, searchBySimilarity, searchHybrid, type SearchResult } from './store.js';
import { initEmbedder, embedQuery } from './embedder.js';
import { describe } from './describer.js';
import { rerank } from './reranker.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  limit?: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SearchConfig {
  reranker?: { enabled?: boolean };
  hybrid?: { enabled?: boolean };
}

function loadSearchConfig(): SearchConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8')) as SearchConfig;
  } catch {
    return {};
  }
}

function isRerankerEnabled(): boolean {
  return loadSearchConfig().reranker?.enabled === true;
}

function isHybridEnabled(): boolean {
  return loadSearchConfig().hybrid?.enabled === true;
}

// ─── Code detection ───────────────────────────────────────────────────────────

const CODE_TOKENS = ['{', '}', '=>', 'function', 'const', 'class', 'def ', 'fn ', 'func '];

function detectCode(query: string): boolean {
  if (query.length <= 80) return false;
  const matches = CODE_TOKENS.filter((token) => query.includes(token));
  return matches.length >= 2;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const limit = options.limit ?? 5;
  openDb();
  initEmbedder();

  const isCode = detectCode(query);
  if (isCode) {
    const { initDescriber } = await import('./describer.js');
    initDescriber();
  }
  const textToEmbed = isCode ? await describe(query) : query;
  const embedding = await embedQuery(textToEmbed);

  const fetchLimit = isRerankerEnabled() ? limit * 2 : limit;
  // Hybrid path uses store.ts default Bm25Source (FTS5 over chunks_code_fts).
  // No camelCase splitting (porter unicode61 keeps identifiers intact).
  const candidates = isHybridEnabled()
    ? searchHybrid(embedding, query, fetchLimit)
    : searchBySimilarity(embedding, fetchLimit);

  if (!isRerankerEnabled() || candidates.length <= limit) return candidates.slice(0, limit);
  const reranked = await rerank(textToEmbed, candidates);
  return reranked.slice(0, limit);
}
