import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { extractTs, type ExtractResult, type RawChunk } from './chunker-ts.js';
import { extractPython, initPython } from './chunker-python.js';
import { loadConfig, PROJECT_ROOT } from './project.js';

export { extractManifest } from './chunker-ts.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Chunk {
  filePath: string; // relative to project root
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed inclusive
  symbolName: string | null;
  language: string; // 'typescript' | 'javascript' | 'python'
  rawCode: string;
  codeHash: string; // sha256 hex of function body (not the prefixes)
  fileMtime: number; // file modification time as Unix ms
}

// ─── Language mapping ─────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, 'typescript' | 'javascript' | 'python'> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
};

// ─── Glob matching ────────────────────────────────────────────────────────────

function globToRegex(glob: string): RegExp {
  let regexStr = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*');
  if (!glob.startsWith('/')) regexStr = '(^|/)' + regexStr;
  return new RegExp(regexStr + '$');
}

export function matchesAnyExcludePattern(relPath: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(relPath));
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ─── Line offset computation ──────────────────────────────────────────────────

function buildLineOffsets(code: string): number[] {
  const offsets = [0];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function offsetToLineFn(offsets: number[]): (offset: number) => number {
  return (offset: number) => {
    let lo = 0,
      hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ─── Initialization ───────────────────────────────────────────────────────────
//
// oxc-parser is sync. tree-sitter native binding loads sync too, but we expose
// async init for forward compatibility with web-tree-sitter (WASM) if we ever
// need to swap.

export async function init(): Promise<void> {
  await initPython();
}

// ─── File chunker ─────────────────────────────────────────────────────────────

export async function chunkFile(filePath: string): Promise<Chunk[]> {
  const cfg = loadConfig();
  const minChunkLines = cfg.indexing?.minChunkLines ?? 5;
  const maxChunkLines = cfg.indexing?.maxChunkLines ?? 300;

  const ext = path.extname(filePath).toLowerCase();
  const lang = EXT_TO_LANG[ext];

  if (!lang) {
    console.warn(
      `[chunker] Skipping unsupported file type: ${path.relative(PROJECT_ROOT, filePath)}`,
    );
    return [];
  }

  const stat = await fs.promises.stat(filePath);
  const fileMtime = stat.mtimeMs;

  const code = await fs.promises.readFile(filePath, 'utf-8');
  const relPath = path.relative(PROJECT_ROOT, filePath);

  const lineOffsets = buildLineOffsets(code);
  const offsetToLine = offsetToLineFn(lineOffsets);
  const lines = code.split('\n');

  let result: ExtractResult;
  if (lang === 'python') {
    result = extractPython(code, lines, offsetToLine);
  } else {
    result = extractTs(filePath, code, lines, offsetToLine);
  }

  if (result.parseError) {
    console.warn(`[chunker] Parse error in ${relPath}: ${result.parseError}`);
    return [];
  }
  for (const w of result.parseWarnings) {
    console.warn(`[chunker] Parse warning in ${relPath}: ${w}`);
  }

  if (result.rawChunks.length === 0) return [];

  return assembleChunks(
    result.rawChunks,
    result.importPrefix,
    result.fileDocPrefix,
    lines,
    offsetToLine,
    relPath,
    lang,
    fileMtime,
    minChunkLines,
    maxChunkLines,
  );
}

function assembleChunks(
  rawChunks: RawChunk[],
  importPrefix: string,
  fileDocPrefix: string,
  lines: string[],
  offsetToLine: (offset: number) => number,
  relPath: string,
  lang: string,
  fileMtime: number,
  minChunkLines: number,
  maxChunkLines: number,
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const raw of rawChunks) {
    const startLine = offsetToLine(raw.startOffset);
    const rawEndLine = offsetToLine(Math.max(raw.startOffset, raw.endOffset - 1));
    const endLine = Math.min(rawEndLine, startLine + maxChunkLines - 1);

    const lineCount = endLine - startLine + 1;
    // Named symbols are complete semantic units — always keep.
    // minChunkLines only applies to unnamed chunks (anonymous exports).
    if (raw.symbolName === null && lineCount < minChunkLines) continue;
    if (lineCount < 2) continue; // absolute floor: skip single-line no-ops

    const functionCode = lines.slice(startLine - 1, endLine).join('\n');
    const rawCode = fileDocPrefix + importPrefix + functionCode;

    chunks.push({
      filePath: relPath,
      startLine,
      endLine,
      symbolName: raw.symbolName,
      language: lang,
      rawCode,
      codeHash: sha256(functionCode),
      fileMtime,
    });
  }

  return chunks;
}

// ─── Walker ───────────────────────────────────────────────────────────────────

export interface WalkStats {
  filesSeen: number;
  filesSkippedMtime: number;
  filesParsed: number;
}

// `knownMtimes` (filePath → stored file_mtime) gates the parser: files whose
// disk mtime is ≤ the stored mtime are skipped entirely. Pass an empty Map to
// force a full re-walk. `seenFilePaths`, if provided, is populated with every
// matched file path (parsed OR mtime-skipped) so callers can compute orphans
// correctly — skipped files still exist and must NOT be deleted from the DB.
export async function* walkAndChunk(
  projectRoot: string,
  knownMtimes: Map<string, number> = new Map(),
  stats: WalkStats = { filesSeen: 0, filesSkippedMtime: 0, filesParsed: 0 },
  seenFilePaths?: Set<string>,
): AsyncGenerator<Chunk> {
  const cfg = loadConfig();
  const sourceRoots = cfg.indexing?.sourceRoots ?? ['src'];
  const excludePatterns = cfg.indexing?.excludePatterns ?? [];

  for (const sourceRoot of sourceRoots) {
    const rootAbsPath = path.join(projectRoot, sourceRoot);

    let entries: string[];
    try {
      entries = (await fs.promises.readdir(rootAbsPath, { recursive: true })) as string[];
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absFilePath = path.join(rootAbsPath, entry);

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absFilePath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) continue;

      const ext = path.extname(absFilePath).toLowerCase();
      if (!EXT_TO_LANG[ext]) continue;

      const relPath = path.relative(projectRoot, absFilePath);
      if (matchesAnyExcludePattern(relPath, excludePatterns)) continue;

      stats.filesSeen++;
      seenFilePaths?.add(relPath);

      const known = knownMtimes.get(relPath);
      if (known !== undefined && stat.mtimeMs <= known) {
        stats.filesSkippedMtime++;
        continue;
      }

      stats.filesParsed++;
      const chunks = await chunkFile(absFilePath);
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  }
}
