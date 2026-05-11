import path from 'path';
import fs from 'fs';

import { init, chunkFile, matchesAnyExcludePattern } from './chunker.js';
import { PROJECT_ROOT, loadConfig } from './project.js';
import {
  openDb,
  upsertFileChunks,
  getChunksForFilePaths,
  updateDescription,
  updateEmbedding,
  type StoredChunk,
} from './store.js';
import { initDescriber, describe, buildFileContext } from './describer.js';
import { initEmbedder, embed, buildEmbedText } from './embedder.js';

// ─── Supported extensions ─────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// ─── Process one changed file ─────────────────────────────────────────────────

async function processFile(absPath: string, excludePatterns: string[]): Promise<void> {
  const relPath = path.relative(PROJECT_ROOT, absPath);
  const ext = path.extname(absPath).toLowerCase();

  if (!SUPPORTED_EXTS.has(ext)) return;
  if (matchesAnyExcludePattern(relPath, excludePatterns)) return;

  // File deleted → remove its chunks
  try {
    await fs.promises.access(absPath);
  } catch {
    upsertFileChunks(relPath, []);
    console.log(`[watch] removed  ${relPath}`);
    return;
  }

  const chunks = await chunkFile(absPath);
  const stored: StoredChunk[] = chunks.map((c) => ({
    ...c,
    description: null,
    embedding: null,
    allowlisted: false,
  }));

  upsertFileChunks(relPath, stored);

  // Only chunks that changed (upsert nulled their description) need re-work
  const needsDesc = getChunksForFilePaths([relPath]).filter((c) => c.description === null);

  if (needsDesc.length === 0) {
    console.log(`[watch] unchanged ${relPath}`);
    return;
  }

  const start = Date.now();
  console.log(`[watch] changed  ${relPath} — ${needsDesc.length} chunk(s) re-describing...`);

  let watcherFileContext = '';
  try {
    const content = await fs.promises.readFile(absPath, 'utf-8');
    watcherFileContext = buildFileContext(content);
  } catch { /* leave empty */ }

  for (const chunk of needsDesc) {
    const desc = await describe(chunk.rawCode, watcherFileContext);
    updateDescription(chunk.id!, desc);
    const embText = buildEmbedText({ ...chunk, description: desc });
    const emb = await embed(embText);
    updateEmbedding(chunk.id!, emb);
    console.log(`  ✓ ${chunk.symbolName ?? '(unnamed)'}  (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }

  console.log(`[watch] done     ${relPath}\n`);
}

// ─── Watch ────────────────────────────────────────────────────────────────────

export async function runWatch(): Promise<void> {
  const cfg = loadConfig();
  const sourceRoots = cfg.indexing?.sourceRoots ?? ['src'];
  const excludePatterns = cfg.indexing?.excludePatterns ?? [];

  openDb();
  await init();
  initDescriber();
  initEmbedder();

  // Per-file debounce: cancel rapid successive saves before doing work
  const pending = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_MS = 500;

  function schedule(absPath: string): void {
    const existing = pending.get(absPath);
    if (existing) clearTimeout(existing);
    pending.set(
      absPath,
      setTimeout(() => {
        pending.delete(absPath);
        processFile(absPath, excludePatterns).catch((err: Error) => {
          console.error(`[watch] error processing ${absPath}:`, err.message);
        });
      }, DEBOUNCE_MS),
    );
  }

  const watchers: fs.FSWatcher[] = [];

  for (const sourceRoot of sourceRoots) {
    const rootAbsPath = path.join(PROJECT_ROOT, sourceRoot);
    try {
      const watcher = fs.watch(rootAbsPath, { recursive: true }, (_eventType, filename) => {
        if (filename) schedule(path.join(rootAbsPath, filename));
      });
      watchers.push(watcher);
      console.log(`[watch] watching ${sourceRoot}/`);
    } catch {
      console.warn(`[watch] could not watch ${sourceRoot}/ (does it exist?)`);
    }
  }

  console.log('[watch] ready — Ctrl+C to stop\n');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      for (const w of watchers) w.close();
      resolve();
    });
  });
}
