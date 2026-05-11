import path from 'path';
import fs from 'fs';

import { PROJECT_ROOT, loadConfig, CONFIG_FILE, DEFAULT_CONFIG } from './project.js';
import { init, walkAndChunk } from './chunker.js';
import {
  openDb,
  getDb,
  upsertFileChunks,
  type StoredChunk,
  getChunksNeedingDescription,
  updateDescription,
  getChunksNeedingEmbedding,
  updateEmbedding,
  updateCodeEmbedding,
  clearAllCodeEmbeddings,
  getStatus,
  searchBySimilarity,
  clearDescriptionsForFilePaths,
  getChunksForFilePaths,
  getDescriptionForCodeHash,
  clearAllEmbeddings,
} from './store.js';
import { applyAllowlist } from './allowlist.js';
import { initDescriber, describe, buildFileContext } from './describer.js';
import { initEmbedder, embed, embedQuery, buildEmbedText } from './embedder.js';
import { augmentForFts5 } from './tokenizer.js';
import { startMcpServer } from './mcp-server.js';
import { runWatch } from './watcher.js';
import { runBenchmark } from './benchmark.js';
import { runIntegrationBenchmark } from './integration-benchmark.js';

// ─── Timing helpers ───────────────────────────────────────────────────────────

function elapsed(startMs: number): string {
  const ms = Date.now() - startMs;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function formatEta(remainingMs: number): string {
  if (remainingMs < 60_000) return `${Math.ceil(remainingMs / 1000)}s`;
  const m = Math.floor(remainingMs / 60_000);
  const s = Math.floor((remainingMs % 60_000) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function printProgress(processed: number, total: number, phaseStart: number, label: string): void {
  const pct = ((processed / total) * 100).toFixed(1);
  const elapsedMs = Date.now() - phaseStart;
  const msPerChunk = elapsedMs / processed;
  const remaining = (total - processed) * msPerChunk;
  const rate = processed / (elapsedMs / 1000);
  const eta = processed < total ? `  ETA: ~${formatEta(remaining)}` : '  done';
  const line = `  [${processed}/${total}] ${pct}%  ${rate.toFixed(1)}/s  elapsed: ${elapsed(phaseStart)}${eta}  ${label}`;
  process.stdout.write(`\r${line.slice(0, process.stdout.columns ?? 120).padEnd(process.stdout.columns ?? 120)}`);
}

// ─── Index command ────────────────────────────────────────────────────────────

export async function runIndex(
  forceReindex: boolean,
  phase0Only = false,
  seedFiles: string[] = [],
  reembedOnly = false,
  rebuildCodeFts = false,
): Promise<void> {
  const totalStart = Date.now();

  // ── Rebuild code-FTS: bulk-populate chunks_code_fts from existing rawCode ───
  if (rebuildCodeFts) {
    console.log('--rebuild-code-fts: rebuilding chunks_code_fts from existing rawCode...');
    openDb();
    const db = getDb();
    db.exec('DELETE FROM chunks_code_fts');
    const rows = db.prepare('SELECT id, raw_code FROM chunks WHERE description IS NOT NULL').all() as unknown as Array<{ id: number; raw_code: string }>;
    const insert = db.prepare('INSERT INTO chunks_code_fts(rowid, content) VALUES (?, ?)');
    for (const row of rows) insert.run(row.id, augmentForFts5(row.raw_code));
    console.log(`Indexed ${rows.length} chunks into chunks_code_fts. Total time: ${elapsed(totalStart)}`);
    return;
  }

  // ── Re-embed only: nulls embeddings (preserves descriptions), skip Phase 0 walk ──
  if (reembedOnly) {
    console.log('--reembed-only: clearing all embeddings (descriptions preserved)...');
    openDb();
    const cleared = clearAllEmbeddings();
    const codeCleared = clearAllCodeEmbeddings();
    console.log(`Cleared ${cleared} description-embeddings + ${codeCleared} code-embeddings. Re-embedding now.\n`);
    initEmbedder();
    const phase1Start = Date.now();
    const chunks = getChunksNeedingEmbedding();
    console.log(`Phase 1: Re-embedding ${chunks.length} chunk(s) on both channels...`);
    let done = 0;
    for (const chunk of chunks) {
      const embText = buildEmbedText({ ...chunk, description: chunk.description! });
      const emb = await embed(embText);
      updateEmbedding(chunk.id!, emb);
      // v16: code-channel — embed the raw chunk text directly so dense retrieval
      // has both a paraphrase channel (description) and a semantic-code channel.
      const codeEmb = await embed(chunk.rawCode);
      updateCodeEmbedding(chunk.id!, codeEmb);
      done++;
      printProgress(done, chunks.length, phase1Start, chunk.filePath);
    }
    process.stdout.write('\n');
    console.log(`Re-embed complete. ${done} chunk(s) updated. Total time: ${elapsed(totalStart)}`);
    return;
  }

  // ── Force-reindex: clear all descriptions + embeddings ──────────────────────
  if (forceReindex) {
    console.log('--force-reindex: clearing all descriptions and embeddings...');
    openDb();
    getDb().exec('DELETE FROM chunks_code_fts');
    getDb().exec('UPDATE chunks SET description = NULL, embedding = NULL');
    console.log('Cleared. Starting fresh indexing pipeline.\n');
  }

  // ── Phase 0: Walk files, upsert chunks, delete orphans ──────────────────────
  const phase0Start = Date.now();
  console.log('Phase 0: Scanning files...');

  openDb();
  await init();

  const seenFilePaths = new Set<string>();
  let chunkCount = 0;
  const chunksByFile = new Map<string, StoredChunk[]>();

  for await (const chunk of walkAndChunk(PROJECT_ROOT)) {
    seenFilePaths.add(chunk.filePath);
    const stored: StoredChunk = { ...chunk, description: null, embedding: null, allowlisted: false };
    const existing = chunksByFile.get(chunk.filePath);
    if (existing) existing.push(stored);
    else chunksByFile.set(chunk.filePath, [stored]);
  }

  for (const [filePath, fileChunks] of chunksByFile) {
    upsertFileChunks(filePath, fileChunks);
    chunkCount += fileChunks.length;
  }

  const { deleteOrphans } = await import('./store.js');
  const orphansDeleted = deleteOrphans(seenFilePaths);

  console.log(
    `Phase 0 done: ${chunkCount} chunks upserted, ${orphansDeleted} orphaned chunks removed. (${elapsed(phase0Start)})\n`,
  );

  if (phase0Only) {
    console.log('--phase0-only: stopping after chunk scan. Run without flag to describe + embed.');
    console.log(`Total time: ${elapsed(totalStart)}`);
    return;
  }

  // ── Phase 1: Describe + embed (single pass, immediately searchable) ──────────
  const phase1Start = Date.now();
  console.log('Phase 1: Describing + embedding chunks...');

  initDescriber();
  initEmbedder();

  // Chunks needing description also need embedding (describe → embed together).
  // Chunks that already have a description but no embedding (e.g. from a previous
  // interrupted run) skip straight to embedding.
  let needingDescription = getChunksNeedingDescription();
  const needingEmbeddingOnly = getChunksNeedingEmbedding();

  // Move seed files to the front of the describe queue so they validate quickly
  if (seedFiles.length > 0) {
    const isSeed = (fp: string) => seedFiles.some((s) => fp === s || fp.endsWith(`/${s}`) || fp.includes(s));
    const seeds = needingDescription.filter((c) => isSeed(c.filePath));
    const rest = needingDescription.filter((c) => !isSeed(c.filePath));
    needingDescription = [...seeds, ...rest];
    if (seeds.length > 0) {
      console.log(`  Seeding ${seeds.length} priority chunks first (${[...new Set(seeds.map((c) => c.filePath))].join(', ')})`);
    }
  }

  const workTotal = needingDescription.length + needingEmbeddingOnly.length;

  console.log(
    `  ${needingDescription.length} need describe+embed, ${needingEmbeddingOnly.length} need embed only.`,
  );

  let workDone = 0;

  // Embed-only first (fast, unblocks search for already-described chunks)
  for (const chunk of needingEmbeddingOnly) {
    const embText = buildEmbedText({ ...chunk, description: chunk.description! });
    const emb = await embed(embText);
    updateEmbedding(chunk.id!, emb);
    const codeEmb = await embed(chunk.rawCode);
    updateCodeEmbedding(chunk.id!, codeEmb);
    workDone++;
    printProgress(workDone, workTotal, phase1Start, chunk.filePath);
  }

  // Describe + embed
  // If another chunk with the same codeHash already has a description, reuse it — same code should
  // produce the same embedding regardless of which file it lives in (cross-process duplicates).
  const fileContextCache = new Map<string, string>();
  for (const chunk of needingDescription) {
    const existing = getDescriptionForCodeHash(chunk.codeHash, chunk.id!);
    if (existing) {
      updateDescription(chunk.id!, existing.description);
      updateEmbedding(chunk.id!, existing.embedding);
      // v16: code embedding is per-chunk-content (codeHash) — same hash means
      // identical rawCode, so reuse the description but recompute code embedding
      // from rawCode (cheap, no LLM). Skipped here; the embed-only loop above
      // catches it if needed. Just embed it now.
      const codeEmb = await embed(chunk.rawCode);
      updateCodeEmbedding(chunk.id!, codeEmb);
      workDone++;
      printProgress(workDone, workTotal, phase1Start, chunk.filePath);
      continue;
    }

    if (!fileContextCache.has(chunk.filePath)) {
      try {
        const content = await fs.promises.readFile(path.join(PROJECT_ROOT, chunk.filePath), 'utf-8');
        fileContextCache.set(chunk.filePath, buildFileContext(content));
      } catch { fileContextCache.set(chunk.filePath, ''); }
    }
    const desc = await describe(chunk.rawCode, fileContextCache.get(chunk.filePath));
    updateDescription(chunk.id!, desc);
    const embText = buildEmbedText({ ...chunk, description: desc });
    const emb = await embed(embText);
    updateEmbedding(chunk.id!, emb);
    const codeEmb = await embed(chunk.rawCode);
    updateCodeEmbedding(chunk.id!, codeEmb);
    workDone++;
    printProgress(workDone, workTotal, phase1Start, chunk.filePath);
  }

  process.stdout.write('\n');
  console.log(`Phase 1 done: ${workTotal} chunks indexed. (${elapsed(phase1Start)})\n`);

  // ── Phase 3: Apply allowlist ─────────────────────────────────────────────────
  const phase3Start = Date.now();
  console.log('Phase 3: Applying allowlist...');
  applyAllowlist(PROJECT_ROOT);
  console.log(`Phase 3 done. (${elapsed(phase3Start)})\n`);

  console.log(`Indexing complete. Total time: ${elapsed(totalStart)}`);
}

// ─── Redescribe command ───────────────────────────────────────────────────────
// Targeted re-index for specific files: runs Phase 0 (updates rawCode with import context),
// clears descriptions/embeddings for the named files, then re-generates just those.

export async function runRedescribe(filePatterns: string[]): Promise<void> {
  const totalStart = Date.now();

  // Phase 0: update rawCode in DB (now with import prefix)
  console.log('Phase 0: Scanning files to refresh rawCode...');
  openDb();
  await init();

  const seenFilePaths = new Set<string>();
  const chunksByFile = new Map<string, StoredChunk[]>();

  for await (const chunk of walkAndChunk(PROJECT_ROOT)) {
    seenFilePaths.add(chunk.filePath);
    const stored: StoredChunk = { ...chunk, description: null, embedding: null, allowlisted: false };
    const existing = chunksByFile.get(chunk.filePath);
    if (existing) existing.push(stored);
    else chunksByFile.set(chunk.filePath, [stored]);
  }

  for (const [filePath, fileChunks] of chunksByFile) {
    upsertFileChunks(filePath, fileChunks);
  }

  console.log(`Phase 0 done. (${elapsed(totalStart)})\n`);

  // Resolve file patterns → relative paths present in the DB
  const isSeed = (fp: string) => filePatterns.some((s) => fp === s || fp.endsWith(`/${s}`) || fp.includes(s));
  const targetPaths = [...seenFilePaths].filter(isSeed);

  if (targetPaths.length === 0) {
    console.error('No matching files found for patterns:', filePatterns);
    process.exit(1);
  }

  console.log(`Clearing descriptions for ${targetPaths.length} file(s):`);
  for (const p of targetPaths) console.log(`  ${p}`);

  const cleared = clearDescriptionsForFilePaths(targetPaths);
  console.log(`Cleared ${cleared} chunk(s).\n`);

  // Phase 1: describe + embed only the cleared chunks
  initDescriber();
  initEmbedder();

  const chunks = getChunksForFilePaths(targetPaths).filter((c) => c.description === null);
  console.log(`Phase 1: Describing + embedding ${chunks.length} chunk(s)...`);

  const phase1Start = Date.now();
  let done = 0;
  const rdFileContextCache = new Map<string, string>();
  for (const chunk of chunks) {
    if (!rdFileContextCache.has(chunk.filePath)) {
      try {
        const content = await fs.promises.readFile(path.join(PROJECT_ROOT, chunk.filePath), 'utf-8');
        rdFileContextCache.set(chunk.filePath, buildFileContext(content));
      } catch { rdFileContextCache.set(chunk.filePath, ''); }
    }
    const desc = await describe(chunk.rawCode, rdFileContextCache.get(chunk.filePath));
    updateDescription(chunk.id!, desc);
    const embText = buildEmbedText({ ...chunk, description: desc });
    const emb = await embed(embText);
    updateEmbedding(chunk.id!, emb);
    done++;
    printProgress(done, chunks.length, phase1Start, chunk.filePath);
  }

  process.stdout.write('\n');
  console.log(`\nRedescribe complete. ${chunks.length} chunks updated. Total time: ${elapsed(totalStart)}`);
}

// ─── Search command ───────────────────────────────────────────────────────────

export async function runSearch(query: string, limit = 5, jsonOutput = false, mcpFormat = false): Promise<void> {
  // Route through `search()` so the CLI `search` command uses the same hybrid
  // retrieval (3-channel RRF: description + code + BM25-with-identifier-splits)
  // that the MCP server and internal benchmark use.
  const { search } = await import('./search.js');
  const results = await search(query, { limit });

  if (mcpFormat) {
    const { renderMcpV17b } = await import('./render.js');
    process.stdout.write(renderMcpV17b(results, query, limit) + '\n');
    return;
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(results) + '\n');
    return;
  }

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
    const symbol = r.symbolName ?? '(unnamed)';
    const sim = r.similarity.toFixed(2);
    console.log(`[${i + 1}] ${location} (similarity: ${sim}) ${symbol}`);
    console.log(`  ${r.description}`);
  }
}

// ─── Status command ───────────────────────────────────────────────────────────

export async function runStatus(): Promise<void> {
  openDb();
  const status = getStatus();

  console.log('── Semantic Search Index Status ──────────────────────────────');
  console.log(`  Total chunks:        ${status.totalChunks}`);
  console.log(`  With description:    ${status.chunksWithDescription}`);
  console.log(`  With embedding:      ${status.chunksWithEmbedding}`);

  if (status.lastIndexed !== null) {
    const lastIndexedDate = new Date(status.lastIndexed).toISOString();
    console.log(`  Last indexed (mtime): ${lastIndexedDate}`);
  } else {
    console.log(`  Last indexed (mtime): (none)`);
  }

  console.log('  Languages:');
  for (const [lang, count] of Object.entries(status.languages)) {
    console.log(`    ${lang.padEnd(14)} ${count}`);
  }
  console.log('──────────────────────────────────────────────────────────────');
}

// ─── Init command ────────────────────────────────────────────────────────────

export async function runInit(): Promise<void> {
  const configPath = path.join(process.cwd(), CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    console.log(`Already initialised — ${configPath} exists.`);
    console.log('Edit it to customise source roots, models, and exclude patterns.');
    return;
  }
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf-8');
  fs.mkdirSync(path.join(process.cwd(), '.semantic-search'), { recursive: true });
  console.log(`Created ${CONFIG_FILE}`);
  console.log('Created .semantic-search/ (index DB will live here)');
  console.log('\nNext steps:');
  console.log('  1. Edit semantic-search.config.json — set indexing.sourceRoots for your project');
  console.log('  2. Run: semantic-search index');
  console.log('  3. Register MCP in Claude Code: semantic-search serve');
}

// ─── CLI dispatch ─────────────────────────────────────────────────────────────

const isMain = process.env.SEMANTIC_SEARCH_CLI === '1' || process.argv[1]?.endsWith('dist/index.js');

if (isMain) {
  const [, , cmd, ...args] = process.argv;

  (async () => {
    try {
      switch (cmd) {
        case 'index': {
          const forceReindex = args.includes('--force-reindex');
          const phase0Only = args.includes('--phase0-only');
          const reembedOnly = args.includes('--reembed-only');
          const rebuildCodeFts = args.includes('--rebuild-code-fts');
          const seedIdx = args.indexOf('--seed-files');
          const seedFiles = seedIdx !== -1 ? (args[seedIdx + 1] ?? '').split(',').filter(Boolean) : [];
          await runIndex(forceReindex, phase0Only, seedFiles, reembedOnly, rebuildCodeFts);
          break;
        }

        case 'search': {
          const query = args[0];
          if (!query) {
            console.error('Usage: node dist/index.js search "<query>" [--limit N] [--json|--format mcp]');
            process.exit(1);
          }
          const limitIdx = args.indexOf('--limit');
          const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : (args[1] && !args[1].startsWith('--') ? parseInt(args[1], 10) : undefined);
          const jsonOutput = args.includes('--json');
          const formatIdx = args.indexOf('--format');
          const mcpFormat = formatIdx !== -1 && args[formatIdx + 1] === 'mcp';
          await runSearch(query, limit, jsonOutput, mcpFormat);
          break;
        }

        case 'watch': {
          await runWatch();
          break;
        }

        case 'serve': {
          await startMcpServer();
          break;
        }

        case 'benchmark': {
          const debug = args.includes('--debug');
          const debugFileIdx = args.indexOf('--debug-file');
          const debugFile = debugFileIdx !== -1 ? args[debugFileIdx + 1] : (debug ? path.join(PROJECT_ROOT, 'benchmark-debug.log') : undefined);
          await runBenchmark(PROJECT_ROOT, { debug, debugFile });
          break;
        }

        case 'integration': {
          const debug = args.includes('--debug');
          await runIntegrationBenchmark({ debug });
          break;
        }

        case 'status': {
          await runStatus();
          break;
        }

        case 'redescribe': {
          const files = args[0];
          if (!files) {
            console.error('Usage: node dist/index.js redescribe "file1,file2"');
            process.exit(1);
          }
          await runRedescribe(files.split(',').filter(Boolean));
          break;
        }

        case 'init': {
          await runInit();
          break;
        }

        default: {
          console.log(`
search-code — semantic code search

SETUP
  init                          Create semantic-search.config.json in current dir

INDEXING
  index                         Index codebase (resume-safe)
    --force-reindex             Clear all descriptions + embeddings, start fresh
    --phase0-only               Scan + chunk only, skip describe/embed
    --reembed-only              Re-embed all chunks (preserves descriptions)
    --rebuild-code-fts          Rebuild chunks_code_fts (FTS5 BM25 channel) from rawCode
    --seed-files "f1,f2"        Prioritise these files at front of queue
  watch                         Incrementally re-index on file changes
  redescribe "f1,f2"           Re-generate descriptions for specific files

SEARCH
  search "<query>"              Semantic search
    --limit N                   Max results (default 5)
    --json                      Output as JSON

MCP
  serve                         Start MCP server (used by Claude Code)

DIAGNOSTICS
  status                        Show index stats
  benchmark [--debug]           Run internal benchmark suite
  integration [--debug]         Run SWE-PolyBench integration benchmark
`);
          process.exit(0);
        }
      }
    } catch (err) {
      console.error('Error:', (err as Error).message ?? err);
      process.exit(1);
    }
  })();
}
