import { DatabaseSync } from 'node:sqlite';
import { getDbPath } from './project.js';
import { augmentForFts5 } from './tokenizer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredChunk {
  id?: number;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  language: string;
  rawCode: string;
  codeHash: string;
  description: string | null;
  embedding: Float32Array | null;
  fileMtime: number;
  allowlisted: boolean;
}

export interface EmbeddedChunk {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  codeHash: string;
  description: string;
  embedding: Float32Array;
  allowlisted: boolean;
}

export interface SearchResult {
  id: number;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  description: string;
  similarity: number;
  allowlisted: boolean;
  // Per-channel rank metadata for hybrid retrieval transparency.
  // null = chunk not in this channel's top-K candidate set.
  // Convention: rank 1 = best in that channel.
  descRank: number | null;
  codeRank: number | null;
  bm25Rank: number | null;
}

export interface IndexStatus {
  totalChunks: number;
  chunksWithDescription: number;
  chunksWithEmbedding: number;
  languages: Record<string, number>;
  lastIndexed: number | null;
}

// ─── Module-level DB instance ─────────────────────────────────────────────────

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not initialized. Call openDb() first.');
  return db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path      TEXT NOT NULL,
  start_line     INTEGER NOT NULL,
  end_line       INTEGER NOT NULL,
  symbol_name    TEXT,
  language       TEXT NOT NULL,
  raw_code       TEXT NOT NULL,
  code_hash      TEXT NOT NULL,
  description    TEXT,
  embedding      BLOB,
  code_embedding BLOB,
  file_mtime     INTEGER NOT NULL,
  allowlisted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_symbol ON chunks(symbol_name);
CREATE INDEX IF NOT EXISTS idx_hash ON chunks(code_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_code_fts USING fts5(
  content,
  tokenize='porter unicode61'
);
`;

// ─── Open / initialize ────────────────────────────────────────────────────────

export function openDb(dbPath?: string): void {
  db = new DatabaseSync(dbPath ?? getDbPath());
  // WAL mode allows concurrent reads (benchmark, search) while the indexer writes
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(SCHEMA);
  // Idempotent migration: add code_embedding column to existing DBs.
  const cols = db.prepare('PRAGMA table_info(chunks)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'code_embedding')) {
    db.exec('ALTER TABLE chunks ADD COLUMN code_embedding BLOB');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Row ↔ StoredChunk conversion ─────────────────────────────────────────────

interface ChunkRow {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  symbol_name: string | null;
  language: string;
  raw_code: string;
  code_hash: string;
  description: string | null;
  embedding: Uint8Array | null;
  file_mtime: number;
  allowlisted: number;
}

function rowToChunk(row: ChunkRow): StoredChunk {
  return {
    id: row.id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbolName: row.symbol_name,
    language: row.language,
    rawCode: row.raw_code,
    codeHash: row.code_hash,
    description: row.description,
    embedding: row.embedding
      ? new Float32Array(
          row.embedding.buffer.slice(
            row.embedding.byteOffset,
            row.embedding.byteOffset + row.embedding.byteLength,
          ),
        )
      : null,
    fileMtime: row.file_mtime,
    allowlisted: row.allowlisted === 1,
  };
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

export function upsertFileChunks(filePath: string, newChunks: StoredChunk[]): void {
  const database = getDb();

  type ExistingRow = {
    id: number;
    start_line: number;
    end_line: number;
    code_hash: string;
    language: string;
  };

  const existingRows = database
    .prepare('SELECT id, start_line, end_line, code_hash, language FROM chunks WHERE file_path = ?')
    .all(filePath) as unknown as ExistingRow[];

  const byStartLine = new Map<number, ExistingRow>();
  const byHash = new Map<string, ExistingRow>();
  for (const row of existingRows) {
    byStartLine.set(row.start_line, row);
    // Only track the first occurrence per hash (duplicates would be stale anyway)
    if (!byHash.has(row.code_hash)) byHash.set(row.code_hash, row);
  }

  const processedIds = new Set<number>();

  for (const chunk of newChunks) {
    const atLine = byStartLine.get(chunk.startLine);

    if (atLine) {
      processedIds.add(atLine.id);
      if (atLine.code_hash === chunk.codeHash && atLine.language === chunk.language) {
        // Function body unchanged — always refresh raw_code so import context stays current.
        // Description/embedding are preserved (still valid for the same function body).
        database
          .prepare('UPDATE chunks SET raw_code = ?, file_mtime = ? WHERE id = ?')
          .run(chunk.rawCode, chunk.fileMtime, atLine.id);
        continue;
      }

      if (atLine.code_hash === chunk.codeHash) {
        // Content unchanged but metadata (language/symbol) migrated — cheap update, keep description+embedding
        database
          .prepare(
            'UPDATE chunks SET language = ?, symbol_name = ?, raw_code = ?, file_mtime = ? WHERE id = ?',
          )
          .run(chunk.language, chunk.symbolName, chunk.rawCode, chunk.fileMtime, atLine.id);
        continue;
      }

      // Same position, content changed — null out description/embedding for re-generation
      // Also remove stale code-FTS entry so old rawCode cannot surface in BM25 results
      database.prepare('DELETE FROM chunks_code_fts WHERE rowid = ?').run(atLine.id);
      database
        .prepare(`
        UPDATE chunks
        SET end_line = ?, language = ?, symbol_name = ?, raw_code = ?, code_hash = ?, file_mtime = ?,
            description = NULL, embedding = NULL
        WHERE id = ?
      `)
        .run(
          chunk.endLine,
          chunk.language,
          chunk.symbolName,
          chunk.rawCode,
          chunk.codeHash,
          chunk.fileMtime,
          atLine.id,
        );
      continue;
    }

    // Same code hash at a different line → function shifted; preserve description + embedding
    const shifted = byHash.get(chunk.codeHash);
    if (shifted && !processedIds.has(shifted.id)) {
      processedIds.add(shifted.id);
      database
        .prepare(`
        UPDATE chunks
        SET start_line = ?, end_line = ?, language = ?, symbol_name = ?, raw_code = ?, file_mtime = ?
        WHERE id = ?
      `)
        .run(
          chunk.startLine,
          chunk.endLine,
          chunk.language,
          chunk.symbolName,
          chunk.rawCode,
          chunk.fileMtime,
          shifted.id,
        );
      continue;
    }

    // Genuinely new chunk
    const embeddingBlob = chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null;
    database
      .prepare(`
      INSERT INTO chunks
        (file_path, start_line, end_line, symbol_name, language, raw_code,
         code_hash, description, embedding, file_mtime, allowlisted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        chunk.filePath,
        chunk.startLine,
        chunk.endLine,
        chunk.symbolName,
        chunk.language,
        chunk.rawCode,
        chunk.codeHash,
        chunk.description,
        embeddingBlob,
        chunk.fileMtime,
        chunk.allowlisted ? 1 : 0,
      );
  }

  // Delete stale rows: chunks that existed but are not in the new set
  for (const row of existingRows) {
    if (!processedIds.has(row.id)) {
      database.prepare('DELETE FROM chunks_code_fts WHERE rowid = ?').run(row.id);
      database.prepare('DELETE FROM chunks WHERE id = ?').run(row.id);
    }
  }
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getChunk(filePath: string, startLine: number): StoredChunk | undefined {
  const row = getDb()
    .prepare('SELECT * FROM chunks WHERE file_path = ? AND start_line = ?')
    .get(filePath, startLine) as unknown as ChunkRow | undefined;
  return row ? rowToChunk(row) : undefined;
}

export function getChunksNeedingDescription(): StoredChunk[] {
  const rows = getDb()
    .prepare('SELECT * FROM chunks WHERE description IS NULL')
    .all() as unknown as ChunkRow[];
  return rows.map(rowToChunk);
}

export function updateDescription(id: number, description: string): void {
  const database = getDb();
  database.prepare('UPDATE chunks SET description = ? WHERE id = ?').run(description, id);
  // Sync code-FTS (hybrid sparse channel). rawCode passes through
  // augmentForFts5 which appends split sub-tokens of every compound identifier
  // so a query like "configure plugins" matches indexed `configurePlugins`.
  const row = database.prepare('SELECT raw_code FROM chunks WHERE id = ?').get(id) as unknown as
    | { raw_code: string }
    | undefined;
  if (row) {
    database.prepare('DELETE FROM chunks_code_fts WHERE rowid = ?').run(id);
    database
      .prepare('INSERT INTO chunks_code_fts(rowid, content) VALUES (?, ?)')
      .run(id, augmentForFts5(row.raw_code));
  }
}

export function getChunksNeedingEmbedding(): StoredChunk[] {
  const rows = getDb()
    .prepare('SELECT * FROM chunks WHERE description IS NOT NULL AND embedding IS NULL')
    .all() as unknown as ChunkRow[];
  return rows.map(rowToChunk);
}

export function updateEmbedding(id: number, embedding: Float32Array): void {
  getDb()
    .prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
    .run(Buffer.from(embedding.buffer), id);
}

// Code-side dense embedding — embed(rawCode) gives a third retrieval channel
// orthogonal to description-embedding (paraphrase) and BM25 (lexical).
// Stored separately so RRF can fuse all three independently.
export function updateCodeEmbedding(id: number, embedding: Float32Array): void {
  getDb()
    .prepare('UPDATE chunks SET code_embedding = ? WHERE id = ?')
    .run(Buffer.from(embedding.buffer), id);
}

export function getChunksNeedingCodeEmbedding(): StoredChunk[] {
  const rows = getDb()
    .prepare('SELECT * FROM chunks WHERE description IS NOT NULL AND code_embedding IS NULL')
    .all() as unknown as ChunkRow[];
  return rows.map(rowToChunk);
}

export function clearAllCodeEmbeddings(): number {
  const result = getDb()
    .prepare('UPDATE chunks SET code_embedding = NULL WHERE description IS NOT NULL')
    .run() as unknown as { changes: number };
  return result.changes;
}

// ─── Embedded chunks (for similarity search) ──────────────────────────────────

export function getAllEmbedded(): EmbeddedChunk[] {
  const rows = getDb()
    .prepare(
      'SELECT id, file_path, start_line, end_line, symbol_name, code_hash, description, embedding, allowlisted FROM chunks WHERE embedding IS NOT NULL AND description IS NOT NULL',
    )
    .all() as unknown as Array<{
    id: number;
    file_path: string;
    start_line: number;
    end_line: number;
    symbol_name: string | null;
    code_hash: string;
    description: string;
    embedding: Uint8Array;
    allowlisted: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbolName: row.symbol_name,
    codeHash: row.code_hash,
    description: row.description,
    embedding: new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength,
      ),
    ),
    allowlisted: row.allowlisted === 1,
  }));
}

// Code-side embeddings keyed by chunk id. Loaded once per query alongside
// description embeddings so the searchHybrid path scores both channels in
// the same in-memory pass.
export function getAllCodeEmbeddings(): Map<number, Float32Array> {
  const rows = getDb()
    .prepare('SELECT id, code_embedding FROM chunks WHERE code_embedding IS NOT NULL')
    .all() as unknown as Array<{ id: number; code_embedding: Uint8Array }>;
  const out = new Map<number, Float32Array>();
  for (const row of rows) {
    out.set(
      row.id,
      new Float32Array(
        row.code_embedding.buffer.slice(
          row.code_embedding.byteOffset,
          row.code_embedding.byteOffset + row.code_embedding.byteLength,
        ),
      ),
    );
  }
  return out;
}

// ─── Orphan cleanup ───────────────────────────────────────────────────────────

export function deleteOrphans(existingFilePaths: Set<string>): number {
  const database = getDb();
  const allPaths = database
    .prepare('SELECT DISTINCT file_path FROM chunks')
    .all() as unknown as Array<{ file_path: string }>;

  const orphans = allPaths.map((r) => r.file_path).filter((p) => !existingFilePaths.has(p));

  if (orphans.length === 0) return 0;

  const placeholders = orphans.map(() => '?').join(', ');
  // Sync code-FTS before deleting rows (needs the IDs)
  database
    .prepare(
      `DELETE FROM chunks_code_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_path IN (${placeholders}))`,
    )
    .run(...orphans);
  const result = database
    .prepare(`DELETE FROM chunks WHERE file_path IN (${placeholders})`)
    .run(...orphans) as unknown as { changes: number };

  return result.changes;
}

// ─── Delete by id ─────────────────────────────────────────────────────────────

export function deleteChunk(id: number): void {
  const database = getDb();
  database.prepare('DELETE FROM chunks_code_fts WHERE rowid = ?').run(id);
  database.prepare('DELETE FROM chunks WHERE id = ?').run(id);
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function getStatus(): IndexStatus {
  const database = getDb();

  const totals = database
    .prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN description IS NOT NULL THEN 1 ELSE 0 END) as with_desc, SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as with_emb, MAX(file_mtime) as last_indexed FROM chunks',
    )
    .get() as unknown as {
    total: number;
    with_desc: number;
    with_emb: number;
    last_indexed: number | null;
  };

  const langRows = database
    .prepare('SELECT language, COUNT(*) as cnt FROM chunks GROUP BY language')
    .all() as unknown as Array<{ language: string; cnt: number }>;

  const languages: Record<string, number> = {};
  for (const row of langRows) {
    languages[row.language] = row.cnt;
  }

  return {
    totalChunks: totals.total,
    chunksWithDescription: totals.with_desc ?? 0,
    chunksWithEmbedding: totals.with_emb ?? 0,
    languages,
    lastIndexed: totals.last_indexed,
  };
}

// ─── Targeted re-describe ─────────────────────────────────────────────────────

export function clearDescriptionsForFilePaths(filePaths: string[]): number {
  if (filePaths.length === 0) return 0;
  const database = getDb();
  const placeholders = filePaths.map(() => '?').join(', ');
  // Remove code-FTS entries before clearing descriptions
  database
    .prepare(
      `DELETE FROM chunks_code_fts WHERE rowid IN (SELECT id FROM chunks WHERE description IS NOT NULL AND file_path IN (${placeholders}))`,
    )
    .run(...filePaths);
  const result = database
    .prepare(
      `UPDATE chunks SET description = NULL, embedding = NULL WHERE file_path IN (${placeholders})`,
    )
    .run(...filePaths) as unknown as { changes: number };
  return result.changes;
}

// Re-embed all chunks: nulls embedding column, preserves descriptions.
// Used by `index --reembed-only` when the embed text format changes.
export function clearAllEmbeddings(): number {
  const database = getDb();
  const result = database
    .prepare('UPDATE chunks SET embedding = NULL WHERE description IS NOT NULL')
    .run() as unknown as { changes: number };
  return result.changes;
}

export function getDescriptionForCodeHash(
  codeHash: string,
  excludeId: number,
): { description: string; embedding: Float32Array } | null {
  const row = getDb()
    .prepare(
      'SELECT description, embedding FROM chunks WHERE code_hash = ? AND id != ? AND description IS NOT NULL AND embedding IS NOT NULL LIMIT 1',
    )
    .get(codeHash, excludeId) as unknown as
    | { description: string; embedding: Uint8Array }
    | undefined;
  if (!row) return null;
  return {
    description: row.description,
    embedding: new Float32Array(
      row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength,
      ),
    ),
  };
}

export function getChunksForFilePaths(filePaths: string[]): StoredChunk[] {
  if (filePaths.length === 0) return [];
  const placeholders = filePaths.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(`SELECT * FROM chunks WHERE file_path IN (${placeholders})`)
    .all(...filePaths) as unknown as ChunkRow[];
  return rows.map(rowToChunk);
}

// mtime gate for incremental indexing — returns a map of filePath → max stored
// file_mtime across all chunks of that path. Walker uses this to skip parsing
// files whose disk mtime hasn't advanced beyond the stored one.
export function getFileMtimes(): Map<string, number> {
  const rows = getDb()
    .prepare('SELECT file_path, MAX(file_mtime) AS mtime FROM chunks GROUP BY file_path')
    .all() as unknown as Array<{ file_path: string; mtime: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.file_path, r.mtime);
  return out;
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

export function setAllowlisted(symbolName: string, allowlisted: boolean): void {
  getDb()
    .prepare('UPDATE chunks SET allowlisted = ? WHERE symbol_name = ?')
    .run(allowlisted ? 1 : 0, symbolName);
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchBySimilarity(queryEmbedding: Float32Array, limit: number): SearchResult[] {
  const embedded = getAllEmbedded();

  const scored = embedded.map((chunk) => ({
    id: chunk.id,
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName,
    codeHash: chunk.codeHash,
    description: chunk.description,
    similarity: cosine(queryEmbedding, chunk.embedding),
    allowlisted: chunk.allowlisted,
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  // Deduplicate: one result per file, and one result per unique codeHash (cross-file duplicates).
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  const deduped: SearchResult[] = [];
  let rank = 0;
  for (const result of scored) {
    if (seenPaths.has(result.filePath)) continue;
    if (seenHashes.has(result.codeHash)) continue;
    seenPaths.add(result.filePath);
    seenHashes.add(result.codeHash);
    rank++;
    deduped.push({
      id: result.id,
      filePath: result.filePath,
      startLine: result.startLine,
      endLine: result.endLine,
      symbolName: result.symbolName,
      description: result.description,
      similarity: result.similarity,
      allowlisted: result.allowlisted,
      descRank: rank,
      codeRank: null,
      bm25Rank: null,
    });
    if (deduped.length === limit) break;
  }
  return deduped;
}

// ─── BM25 helpers ─────────────────────────────────────────────────────────────

export function toFts5Query(text: string): string {
  // Strip FTS5 operator chars, split into words ≥3 chars, AND-join (space = FTS5 implicit AND).
  // OR-join was found to pollute BM25 with common code keywords (const, function, return)
  // when querying chunks_code_fts — every file matches at least one common token, IDF is too
  // diluted across a homogeneous TS corpus to recover precision. AND-join requires all query
  // terms in the matched chunk → higher precision. Recall protection: vector channel still
  // returns full corpus ranking via RRF, so even if BM25 returns [] the dense channel wins.
  const words = text
    .replace(/["*()^]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return words.join(' ');
}

interface Bm25Row {
  id: number;
  score: number;
}

// Hybrid sparse channel: BM25 over rawCode (chunks_code_fts).
// Lexical matching for identifier-style queries (e.g. `configurePlugins`) that
// the description-channel embedding misses.
function searchByCodeBm25(queryText: string, limit: number): Array<{ id: number; rank: number }> {
  const ftsQuery = toFts5Query(queryText);
  if (!ftsQuery) return [];

  try {
    const rows = getDb()
      .prepare(
        'SELECT rowid AS id, -bm25(chunks_code_fts) AS score FROM chunks_code_fts WHERE content MATCH ? ORDER BY score DESC LIMIT ?',
      )
      .all(ftsQuery, limit) as unknown as Bm25Row[];

    return rows.map((row, idx) => ({ id: row.id, rank: idx + 1 }));
  } catch {
    return [];
  }
}

// ─── Hybrid search (BM25 + vector, fused with RRF) ────────────────────────────

export type Bm25Source = (queryText: string, limit: number) => Array<{ id: number; rank: number }>;

export function searchHybrid(
  queryEmbedding: Float32Array,
  queryText: string,
  limit: number,
  bm25Source: Bm25Source = searchByCodeBm25,
): SearchResult[] {
  const K = 60; // standard RRF constant

  // Score every embedded chunk on both dense channels:
  //   description-channel (LLM prose) — paraphrase strength
  //   code-channel (rawCode embedded directly) — semantic code understanding
  // BM25 is fused additively as the third channel via RRF; replacing either
  // dense channel with code-only regresses recall, so all three are kept.
  const embedded = getAllEmbedded();
  const codeEmbeddings = getAllCodeEmbeddings();

  const descScored = embedded
    .map((chunk) => ({
      id: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbolName: chunk.symbolName,
      codeHash: chunk.codeHash,
      description: chunk.description,
      similarity: cosine(queryEmbedding, chunk.embedding),
      allowlisted: chunk.allowlisted,
    }))
    .sort((a, b) => b.similarity - a.similarity);

  // Code-channel rank map: cosine(query, embed(rawCode)) for each chunk that
  // has a code_embedding. Skipped when no code embeddings exist; searchHybrid
  // then degrades to description + BM25 only.
  const codeRankMap = new Map<number, number>();
  if (codeEmbeddings.size > 0) {
    const codeScored = embedded
      .filter((c) => codeEmbeddings.has(c.id))
      .map((c) => ({ id: c.id, sim: cosine(queryEmbedding, codeEmbeddings.get(c.id)!) }))
      .sort((a, b) => b.sim - a.sim);
    for (let i = 0; i < codeScored.length; i++) codeRankMap.set(codeScored[i].id, i + 1);
  }

  // BM25 ranks from injected source (FTS5 over rawCode + identifier splits)
  const bm25Results = bm25Source(queryText, limit * 4);
  const bm25RankMap = new Map<number, number>();
  for (const { id, rank } of bm25Results) bm25RankMap.set(id, rank);

  // RRF: combine description-rank + code-rank + BM25-rank for each chunk
  const rrfScored = descScored.map((chunk, idx) => {
    const descRank = idx + 1;
    const codeRank = codeRankMap.get(chunk.id);
    const bm25Rank = bm25RankMap.get(chunk.id);
    const rrfScore =
      1 / (K + descRank) +
      (codeRank != null ? 1 / (K + codeRank) : 0) +
      (bm25Rank != null ? 1 / (K + bm25Rank) : 0);
    return { ...chunk, rrfScore, descRank, codeRank: codeRank ?? null, bm25Rank: bm25Rank ?? null };
  });

  rrfScored.sort((a, b) => b.rrfScore - a.rrfScore);

  // Deduplicate by file and by codeHash — same logic as searchBySimilarity
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();
  const results: SearchResult[] = [];
  for (const chunk of rrfScored) {
    if (seenPaths.has(chunk.filePath)) continue;
    if (seenHashes.has(chunk.codeHash)) continue;
    seenPaths.add(chunk.filePath);
    seenHashes.add(chunk.codeHash);
    results.push({
      id: chunk.id,
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbolName: chunk.symbolName,
      description: chunk.description,
      similarity: chunk.similarity,
      allowlisted: chunk.allowlisted,
      descRank: chunk.descRank,
      codeRank: chunk.codeRank,
      bm25Rank: chunk.bm25Rank,
    });
    if (results.length >= limit) break;
  }

  return results;
}
