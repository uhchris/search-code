import crypto from 'crypto';
import fs from 'fs';
// oxc-parser ships native arm64 binaries; no WASM, no async initialization required
import { parseSync } from 'oxc-parser';
import path from 'path';
import { loadConfig, PROJECT_ROOT } from './project.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Chunk {
  filePath: string; // relative to project root
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed inclusive
  symbolName: string | null;
  language: string; // 'typescript' | 'javascript'
  rawCode: string;
  codeHash: string; // sha256 hex of rawCode
  fileMtime: number; // file modification time as Unix ms
}

// ─── Language mapping ─────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, 'typescript' | 'javascript'> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
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

// Returns 1-indexed line number for a given character offset (binary search).
function offsetToLine(offsets: number[], offset: number): number {
  let lo = 0,
    hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ─── AST extraction ───────────────────────────────────────────────────────────

interface RawChunk {
  startOffset: number;
  endOffset: number; // exclusive (ESTree convention)
  symbolName: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASTNode = any;

function extractFromDecl(node: ASTNode, exportWrapper: ASTNode | null, result: RawChunk[]): void {
  const container = exportWrapper ?? node;

  switch (node.type) {
    case 'FunctionDeclaration': {
      result.push({
        startOffset: container.start,
        endOffset: container.end,
        symbolName: node.id?.name ?? null,
      });
      break;
    }

    case 'ClassDeclaration': {
      result.push({
        startOffset: container.start,
        endOffset: container.end,
        symbolName: node.id?.name ?? null,
      });
      // Extract each method as its own chunk
      for (const member of node.body?.body ?? []) {
        if (member.type === 'MethodDefinition' && member.key?.type === 'Identifier') {
          result.push({
            startOffset: member.start,
            endOffset: member.end,
            symbolName: member.key.name,
          });
        }
      }
      break;
    }

    case 'VariableDeclaration': {
      for (const decl of node.declarations ?? []) {
        const init = decl.init;
        if (!init) continue;
        const name = decl.id?.type === 'Identifier' ? decl.id.name : null;

        // Function-shaped initializers — always chunk (named function exports, hooks)
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          result.push({ startOffset: container.start, endOffset: container.end, symbolName: name });
          continue;
        }

        // Top-level EXPORTED declarations: always chunk regardless of init kind.
        // Captures Drizzle table defs (`sqliteTable(...)`), zod schemas (`z.object(...)`),
        // exported config objects, route registries — all structural plumbing whose
        // descriptions and embed manifests carry domain vocabulary worth indexing.
        if (exportWrapper) {
          result.push({ startOffset: container.start, endOffset: container.end, symbolName: name });

          // tRPC-router pattern: `export const fooRouter = router({ procA: ..., procB: ... })`.
          // Without per-procedure chunks, only the first ~maxChunkLines lines of the router
          // get chunked (Mode 1 failure). Walk into CallExpression arguments and emit a
          // sub-chunk for any Property whose value spans more than a few lines —
          // captures procedure handlers buried inside the router object literal.
          extractObjectPropertyChunks(init, result);
          continue;
        }

        // Non-exported CallExpression with a function first-arg — HOC pattern at
        // module scope (e.g. `const X = memo(() => {})` without re-export).
        if (init.type === 'CallExpression') {
          const firstArg = init.arguments?.[0];
          if (
            firstArg &&
            (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression')
          ) {
            result.push({
              startOffset: container.start,
              endOffset: container.end,
              symbolName: name,
            });
          }
        }
      }
      break;
    }
  }
}

// Mode 1 fix: tRPC routers, command palettes, route registries, and similar
// dispatch-tables are CallExpression arguments shaped like `{ procA, procB, … }`
// where each property's value is a long expression chain. The outer
// VariableDeclaration emits one chunk capped at maxChunkLines, so handlers
// past the cap are never indexed. Walk into CallExpression args' ObjectExpression
// properties and emit a sub-chunk per non-trivial Property.
const PROPERTY_CHUNK_MIN_BYTES = 80; // ≈3 lines of code; skip 1-line Drizzle column defs

function extractObjectPropertyChunks(initNode: ASTNode, out: RawChunk[]): void {
  if (!initNode || typeof initNode !== 'object') return;
  if (initNode.type !== 'CallExpression') return;
  for (const arg of initNode.arguments ?? []) {
    if (!arg || arg.type !== 'ObjectExpression') continue;
    for (const prop of arg.properties ?? []) {
      if (!prop || prop.type !== 'Property') continue;
      if (prop.computed) continue;
      const keyName =
        prop.key?.type === 'Identifier'
          ? prop.key.name
          : prop.key?.type === 'Literal' && typeof prop.key.value === 'string'
            ? prop.key.value
            : null;
      if (!keyName) continue;
      const value = prop.value;
      if (!value || value.end - value.start < PROPERTY_CHUNK_MIN_BYTES) continue;
      out.push({ startOffset: prop.start, endOffset: prop.end, symbolName: keyName });
    }
  }
}

function collectFromBody(body: ASTNode[]): RawChunk[] {
  const result: RawChunk[] = [];

  for (const node of body) {
    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') &&
      node.declaration
    ) {
      extractFromDecl(node.declaration, node, result);
    } else {
      extractFromDecl(node, null, result);
    }
  }

  return result;
}

// ─── Manifest extraction ──────────────────────────────────────────────────────
//
// Collects identifier-shaped tokens from the chunk AST. Prepended to the embed
// text so plumbing files (Drizzle schemas, repo readers) surface their domain
// vocabulary in dense space — column names like `sandbox_id` and call-site
// identifiers like `userIntegrations` that don't appear in the LLM-generated
// description.
//
// Walks ESTree `Identifier` and identifier-shaped string `Literal` nodes,
// skipping subtrees under any TS*-prefixed node so type-position primitives
// (`string`, `number`, `Promise`, `Array`) don't leak into the manifest.
// No hand-coded keyword list — ESTree never emits language keywords as
// Identifier nodes.

const MANIFEST_TOKEN_LIMIT = 50;
const IDENT_LITERAL_RE = /^[a-zA-Z_][a-zA-Z0-9_]{1,49}$/;

export function extractManifest(rawCode: string): string {
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync('manifest.ts', rawCode);
  } catch {
    return '';
  }

  const tokens = new Set<string>();

  function visit(node: ASTNode, inTypePosition: boolean): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inTypePosition);
      return;
    }

    const type = node.type;
    // Any TypeScript type-AST subtree (TSTypeAnnotation, TSTypeReference,
    // TSStringKeyword, TSTypeParameterInstantiation, …) — recurse without
    // collecting so type primitives never enter the manifest.
    const entersTypePosition = typeof type === 'string' && type.startsWith('TS');
    const childrenInType = inTypePosition || entersTypePosition;

    if (!childrenInType && !entersTypePosition) {
      if (type === 'Identifier' && typeof node.name === 'string') {
        tokens.add(node.name);
      } else if (
        type === 'Literal' &&
        typeof node.value === 'string' &&
        IDENT_LITERAL_RE.test(node.value)
      ) {
        tokens.add(node.value);
      }
    }

    for (const key in node) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range')
        continue;
      const child = node[key];
      if (child && typeof child === 'object') visit(child, childrenInType);
    }
  }

  visit(parsed.program as ASTNode, false);

  const filtered: string[] = [];
  for (const t of tokens) {
    if (t.length < 2) continue;
    filtered.push(t);
    if (filtered.length >= MANIFEST_TOKEN_LIMIT) break;
  }

  return filtered.join(' ');
}

// ─── Initialization (no-op — oxc-parser requires no async setup) ──────────────

export async function init(): Promise<void> {}

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

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filePath, code);
  } catch (err) {
    console.warn(`[chunker] Parse error in ${relPath}: ${(err as Error).message}`);
    return [];
  }

  if (parsed.errors?.length > 0) {
    for (const e of parsed.errors) {
      console.warn(`[chunker] Parse warning in ${relPath}: ${e.message}`);
    }
  }

  const rawChunks = collectFromBody(parsed.program.body);
  if (rawChunks.length === 0) return [];

  const lineOffsets = buildLineOffsets(code);
  const lines = code.split('\n');

  // Collect top-level import statements to prepend as context for the describer.
  // This lets the LLM see `import { useState } from 'react'` etc. when describing
  // a hook, dramatically improving descriptions for cross-cutting concerns.
  const importLines: string[] = [];
  for (const node of parsed.program.body) {
    if (node.type === 'ImportDeclaration') {
      const startL = offsetToLine(lineOffsets, node.start);
      const endL = offsetToLine(lineOffsets, Math.max(node.start, node.end - 1));
      importLines.push(...lines.slice(startL - 1, endL));
    }
  }
  const importPrefix = importLines.length > 0 ? importLines.join('\n') + '\n\n' : '';

  // Collect top-of-file JSDoc blocks that appear before the first non-import declaration.
  // These carry module-level domain context (e.g. "Why: agent executions allocate large
  // per-stream heap") that the describer needs but individual function bodies omit.
  const fileJsDocLines: string[] = [];
  {
    let idx = 0;
    while (idx < lines.length) {
      const trimmed = lines[idx].trim();
      if (trimmed === '') {
        idx++;
        continue;
      }
      if (trimmed.startsWith('//')) {
        idx++;
        continue;
      }
      if (trimmed.startsWith('import ')) {
        // skip multi-line import statements
        while (idx < lines.length && !lines[idx].includes(';')) idx++;
        idx++;
        continue;
      }
      if (trimmed.startsWith('/**') || trimmed === '*') {
        const blockStart = idx;
        while (idx < lines.length && !lines[idx].includes('*/')) idx++;
        idx++; // include the closing `*/` line
        fileJsDocLines.push(...lines.slice(blockStart, idx));
        continue;
      }
      break; // first non-import, non-comment declaration — stop
    }
  }
  const fileJsDocPrefix = fileJsDocLines.length > 0 ? fileJsDocLines.join('\n') + '\n\n' : '';

  const chunks: Chunk[] = [];

  for (const raw of rawChunks) {
    const startLine = offsetToLine(lineOffsets, raw.startOffset);
    // endOffset is exclusive; last character is at endOffset - 1
    const rawEndLine = offsetToLine(lineOffsets, Math.max(raw.startOffset, raw.endOffset - 1));
    const endLine = Math.min(rawEndLine, startLine + maxChunkLines - 1);

    const lineCount = endLine - startLine + 1;
    // Named functions are complete semantic units — always include them.
    // Only apply minChunkLines to unnamed chunks (anonymous exports) to avoid noise.
    if (raw.symbolName === null && lineCount < minChunkLines) continue;
    if (lineCount < 2) continue; // absolute floor: skip single-line no-ops

    const functionCode = lines.slice(startLine - 1, endLine).join('\n');
    // codeHash is based on the function body only — stable across prefix changes
    const rawCode = fileJsDocPrefix + importPrefix + functionCode;

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
// force a full re-walk (initial index, or after schema/chunker rule change).
// `seenFilePaths`, if provided, is populated with every matched file path
// (parsed OR mtime-skipped) so callers can compute orphans correctly — files
// the walker skipped on disk still exist and must NOT be deleted from the DB.
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
      if (!EXT_TO_LANG[ext]) continue; // skip non-TS/JS silently

      const relPath = path.relative(projectRoot, absFilePath);
      if (matchesAnyExcludePattern(relPath, excludePatterns)) continue;

      stats.filesSeen++;
      seenFilePaths?.add(relPath);

      // mtime gate: skip parse + chunk if disk mtime hasn't advanced beyond
      // the stored mtime for this path. Saves the heavy oxc-parser pass on
      // unchanged files. New/changed files (and files absent from knownMtimes)
      // still get parsed. seenFilePaths is populated above so orphan cleanup
      // does NOT delete the existing chunks of an unchanged file.
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
