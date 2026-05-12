import { parseSync } from 'oxc-parser';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawChunk {
  startOffset: number;
  endOffset: number; // exclusive (ESTree convention)
  symbolName: string | null;
}

export interface ExtractResult {
  rawChunks: RawChunk[];
  importPrefix: string;
  fileDocPrefix: string;
  parseError?: string;
  parseWarnings: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ASTNode = any;

// ─── AST extraction ───────────────────────────────────────────────────────────

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

        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          result.push({ startOffset: container.start, endOffset: container.end, symbolName: name });
          continue;
        }

        // Top-level EXPORTED declarations: always chunk regardless of init kind.
        // Captures Drizzle table defs, zod schemas, exported config objects,
        // route registries — plumbing whose descriptions carry domain vocabulary.
        if (exportWrapper) {
          result.push({ startOffset: container.start, endOffset: container.end, symbolName: name });

          // tRPC-router pattern: per-procedure sub-chunks for properties whose
          // value spans more than ~3 lines. Without these, handlers past the
          // maxChunkLines cap are never indexed.
          extractObjectPropertyChunks(init, result);
          continue;
        }

        // Non-exported CallExpression with a function first-arg — module-scope HOC.
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

const PROPERTY_CHUNK_MIN_BYTES = 80; // ≈3 lines; skip 1-line Drizzle column defs

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

// ─── Prefix extraction ────────────────────────────────────────────────────────

function buildImportPrefix(body: ASTNode[], lines: string[], offsetToLine: (n: number) => number): string {
  const importLines: string[] = [];
  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      const startL = offsetToLine(node.start);
      const endL = offsetToLine(Math.max(node.start, node.end - 1));
      importLines.push(...lines.slice(startL - 1, endL));
    }
  }
  return importLines.length > 0 ? importLines.join('\n') + '\n\n' : '';
}

// Top-of-file JSDoc blocks before the first non-import declaration. These
// carry module-level domain context that individual function bodies omit.
function buildFileDocPrefix(lines: string[]): string {
  const fileJsDocLines: string[] = [];
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
      while (idx < lines.length && !lines[idx].includes(';')) idx++;
      idx++;
      continue;
    }
    if (trimmed.startsWith('/**') || trimmed === '*') {
      const blockStart = idx;
      while (idx < lines.length && !lines[idx].includes('*/')) idx++;
      idx++; // include closing `*/`
      fileJsDocLines.push(...lines.slice(blockStart, idx));
      continue;
    }
    break;
  }
  return fileJsDocLines.length > 0 ? fileJsDocLines.join('\n') + '\n\n' : '';
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function extractTs(
  filePath: string,
  code: string,
  lines: string[],
  offsetToLine: (n: number) => number,
): ExtractResult {
  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(filePath, code);
  } catch (err) {
    return {
      rawChunks: [],
      importPrefix: '',
      fileDocPrefix: '',
      parseError: (err as Error).message,
      parseWarnings: [],
    };
  }

  const parseWarnings = (parsed.errors ?? []).map((e) => e.message);
  const rawChunks = collectFromBody(parsed.program.body);
  const importPrefix = buildImportPrefix(parsed.program.body, lines, offsetToLine);
  const fileDocPrefix = buildFileDocPrefix(lines);

  return { rawChunks, importPrefix, fileDocPrefix, parseWarnings };
}

// ─── Manifest extraction ──────────────────────────────────────────────────────
//
// Collects identifier-shaped tokens from a chunk. Walks ESTree Identifier
// and identifier-shaped string Literal nodes, skipping any TS*-prefixed
// node so type-position primitives (`string`, `Promise`) don't leak in.

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
