import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  closeDb,
  getDb,
  toFts5Query,
  upsertFileChunks,
  getChunk,
  updateDescription,
  updateEmbedding,
  deleteChunk,
  deleteOrphans,
  clearDescriptionsForFilePaths,
  searchHybrid,
  type StoredChunk,
} from '../store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeChunk(overrides: Partial<StoredChunk> & { filePath: string; startLine: number; codeHash: string }): StoredChunk {
  return {
    filePath: overrides.filePath,
    startLine: overrides.startLine,
    endLine: overrides.endLine ?? overrides.startLine + 10,
    symbolName: overrides.symbolName ?? 'testFn',
    language: overrides.language ?? 'typescript',
    rawCode: overrides.rawCode ?? 'function testFn() {}',
    codeHash: overrides.codeHash,
    description: overrides.description ?? null,
    embedding: overrides.embedding ?? null,
    fileMtime: overrides.fileMtime ?? 1000,
    allowlisted: overrides.allowlisted ?? false,
  };
}

function codeFtsRowids(query: string): number[] {
  const rows = getDb()
    .prepare("SELECT rowid FROM chunks_code_fts WHERE content MATCH ?")
    .all(query) as unknown as Array<{ rowid: number }>;
  return rows.map((r) => r.rowid);
}

function makeEmbedding(components: number[]): Float32Array {
  return new Float32Array(components);
}

// ─── toFts5Query ──────────────────────────────────────────────────────────────

describe('toFts5Query', () => {
  it('returns empty string for empty input', () => {
    assert.equal(toFts5Query(''), '');
  });

  it('returns empty string when all words are shorter than 3 chars', () => {
    assert.equal(toFts5Query('a is ok it'), '');
    assert.equal(toFts5Query('ab cd'), '');
  });

  it('filters words shorter than 3 chars and joins remaining with AND (space)', () => {
    assert.equal(toFts5Query('hello world'), 'hello world');
    assert.equal(toFts5Query('retry the connection now'), 'retry the connection now');
  });

  it('strips FTS5 operator characters before splitting', () => {
    assert.equal(toFts5Query('"quoted" term'), 'quoted term');
    assert.equal(toFts5Query('(paren) match'), 'paren match');
    assert.equal(toFts5Query('star* boost'), 'star boost');
    assert.equal(toFts5Query('^caret word'), 'caret word');
  });

  it('handles mixed operators and short words', () => {
    assert.equal(toFts5Query('retry* a "connection"'), 'retry connection');
  });
});

// ─── code-FTS sync correctness ────────────────────────────────────────────────

describe('code-FTS sync — updateDescription', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  it('indexes rawCode in chunks_code_fts after updateDescription', () => {
    const chunk = makeChunk({
      filePath: 'src/a.ts',
      startLine: 1,
      codeHash: 'hash1',
      rawCode: 'function uniqueRawCodeToken() { return 1; }',
    });
    upsertFileChunks('src/a.ts', [chunk]);
    const stored = getChunk('src/a.ts', 1)!;

    updateDescription(stored.id!, 'any description here');

    const hits = codeFtsRowids('uniqueRawCodeToken');
    assert.equal(hits.length, 1);
    assert.equal(hits[0], stored.id!);
  });
});

describe('code-FTS sync — deleteChunk', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  it('removes code-FTS entry when chunk is deleted', () => {
    const chunk = makeChunk({
      filePath: 'src/a.ts',
      startLine: 1,
      codeHash: 'hash1',
      rawCode: 'function deletableFunctionToken() {}',
    });
    upsertFileChunks('src/a.ts', [chunk]);
    const id = getChunk('src/a.ts', 1)!.id!;
    updateDescription(id, 'description');

    deleteChunk(id);

    assert.equal(codeFtsRowids('deletableFunctionToken').length, 0);
  });
});

describe('code-FTS sync — deleteOrphans', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  it('removes code-FTS entries for orphaned files', () => {
    upsertFileChunks('src/a.ts', [
      makeChunk({ filePath: 'src/a.ts', startLine: 1, codeHash: 'hasha', rawCode: 'function fileAUniqueToken() {}' }),
    ]);
    upsertFileChunks('src/b.ts', [
      makeChunk({ filePath: 'src/b.ts', startLine: 1, codeHash: 'hashb', rawCode: 'function fileBUniqueToken() {}' }),
    ]);

    const idA = getChunk('src/a.ts', 1)!.id!;
    const idB = getChunk('src/b.ts', 1)!.id!;
    updateDescription(idA, 'description a');
    updateDescription(idB, 'description b');

    // Keep only a.ts — b.ts becomes an orphan
    deleteOrphans(new Set(['src/a.ts']));

    assert.equal(codeFtsRowids('fileBUniqueToken').length, 0, 'orphaned file code-FTS entry must be removed');
    assert.equal(codeFtsRowids('fileAUniqueToken').length, 1, 'surviving file code-FTS entry must remain');
  });
});

describe('code-FTS sync — upsertFileChunks stale row deletion', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  it('removes code-FTS entry for a chunk that disappears from the file', () => {
    const chunkA = makeChunk({
      filePath: 'src/x.ts',
      startLine: 1,
      codeHash: 'hashA',
      rawCode: 'function chunkAToken() {}',
    });
    const chunkB = makeChunk({
      filePath: 'src/x.ts',
      startLine: 20,
      codeHash: 'hashB',
      rawCode: 'function staleChunkBToken() {}',
    });
    upsertFileChunks('src/x.ts', [chunkA, chunkB]);

    const idB = getChunk('src/x.ts', 20)!.id!;
    updateDescription(idB, 'desc b');

    // Re-index with only chunkA — chunkB is now stale
    upsertFileChunks('src/x.ts', [chunkA]);

    assert.equal(codeFtsRowids('staleChunkBToken').length, 0, 'stale chunk code-FTS entry must be removed');
  });

  it('removes code-FTS entry when chunk content changes at same position', () => {
    const original = makeChunk({
      filePath: 'src/x.ts',
      startLine: 1,
      codeHash: 'hashV1',
      rawCode: 'function oldVersionToken() {}',
    });
    upsertFileChunks('src/x.ts', [original]);

    const id = getChunk('src/x.ts', 1)!.id!;
    updateDescription(id, 'desc v1');

    // Same startLine, different hash = content changed
    const modified = makeChunk({
      filePath: 'src/x.ts',
      startLine: 1,
      codeHash: 'hashV2',
      rawCode: 'function newVersionToken() { return 1; }',
    });
    upsertFileChunks('src/x.ts', [modified]);

    assert.equal(codeFtsRowids('oldVersionToken').length, 0, 'stale code-FTS entry must be removed after content change');
  });
});

describe('code-FTS sync — clearDescriptionsForFilePaths', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  it('removes code-FTS entries for all cleared chunks', () => {
    upsertFileChunks('src/a.ts', [
      makeChunk({ filePath: 'src/a.ts', startLine: 1, codeHash: 'h1', rawCode: 'function alphaToken() {}' }),
      makeChunk({ filePath: 'src/a.ts', startLine: 20, codeHash: 'h2', rawCode: 'function betaToken() {}' }),
    ]);
    const id1 = getChunk('src/a.ts', 1)!.id!;
    const id2 = getChunk('src/a.ts', 20)!.id!;
    updateDescription(id1, 'desc 1');
    updateDescription(id2, 'desc 2');

    clearDescriptionsForFilePaths(['src/a.ts']);

    assert.equal(codeFtsRowids('alphaToken').length, 0);
    assert.equal(codeFtsRowids('betaToken').length, 0);
  });

  it('does not touch code-FTS entries for files not in the list', () => {
    upsertFileChunks('src/a.ts', [
      makeChunk({ filePath: 'src/a.ts', startLine: 1, codeHash: 'h1', rawCode: 'function clearMeToken() {}' }),
    ]);
    upsertFileChunks('src/b.ts', [
      makeChunk({ filePath: 'src/b.ts', startLine: 1, codeHash: 'h2', rawCode: 'function keepMeToken() {}' }),
    ]);
    const idA = getChunk('src/a.ts', 1)!.id!;
    const idB = getChunk('src/b.ts', 1)!.id!;
    updateDescription(idA, 'desc a');
    updateDescription(idB, 'desc b');

    clearDescriptionsForFilePaths(['src/a.ts']);

    assert.equal(codeFtsRowids('keepMeToken').length, 1, 'uncleared file code-FTS entry must remain');
  });
});

// ─── searchHybrid ─────────────────────────────────────────────────────────────

describe('searchHybrid', () => {
  beforeEach(() => openDb(':memory:'));
  afterEach(() => closeDb());

  function insertChunkWithEmbedding(
    filePath: string,
    startLine: number,
    codeHash: string,
    description: string,
    embedding: Float32Array,
    rawCode = 'function testFn() {}',
  ): number {
    upsertFileChunks(filePath, [makeChunk({ filePath, startLine, codeHash, rawCode })]);
    const id = getChunk(filePath, startLine)!.id!;
    updateDescription(id, description);
    updateEmbedding(id, embedding);
    return id;
  }

  it('returns cosine similarity in result — not RRF score', () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    insertChunkWithEmbedding('src/a.ts', 1, 'h1', 'test chunk description', emb);

    const results = searchHybrid(makeEmbedding([1, 0, 0, 0]), 'test chunk', 5);
    assert.equal(results.length, 1);
    assert.ok(Math.abs(results[0].similarity - 1.0) < 1e-5, `expected similarity ~1.0, got ${results[0].similarity}`);
  });

  it('deduplicates chunks from the same file — returns one result per file', () => {
    const emb = makeEmbedding([1, 0]);
    insertChunkWithEmbedding('src/a.ts', 1, 'h1', 'first chunk file a', emb);
    insertChunkWithEmbedding('src/a.ts', 50, 'h2', 'second chunk file a', emb);

    const results = searchHybrid(makeEmbedding([1, 0]), 'chunk', 10);
    const paths = results.map((r) => r.filePath);
    assert.equal(paths.filter((p) => p === 'src/a.ts').length, 1, 'should only return one result for src/a.ts');
  });

  it('still returns results when query words are all too short for BM25 (vector-only fallback)', () => {
    // "a b" → toFts5Query returns "" → BM25 returns [] → should still rank by vector
    const emb = makeEmbedding([1, 0]);
    insertChunkWithEmbedding('src/a.ts', 1, 'h1', 'some description text', emb);

    const results = searchHybrid(makeEmbedding([1, 0]), 'a b', 5);
    assert.equal(results.length, 1, 'should return vector results even with empty BM25');
  });

  it('BM25-matching chunk ranks above pure-vector winner when vector scores are close', () => {
    // Chunk A: high cosine (0.9), no rawCode token match
    // Chunk B: lower cosine (0.7), rawCode contains the BM25 query terms
    // Expected: B ranks first due to RRF BM25 boost
    const embA = makeEmbedding([0.9, 0.4359]); // cosine with [1,0] ≈ 0.9
    const embB = makeEmbedding([0.7, 0.7141]); // cosine with [1,0] ≈ 0.7
    const query = makeEmbedding([1, 0]);

    insertChunkWithEmbedding('src/a.ts', 1, 'hA', 'desc a', embA, 'function unrelatedFn() { return 0; }');
    insertChunkWithEmbedding(
      'src/b.ts',
      1,
      'hB',
      'desc b',
      embB,
      'function bm25matchword specific() { return 1; }',
    );

    const results = searchHybrid(query, 'bm25matchword specific', 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].filePath, 'src/b.ts', 'BM25-matching chunk should rank first after RRF fusion');
  });
});
