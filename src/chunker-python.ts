import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { ExtractResult, RawChunk } from './chunker-ts.js';

// tree-sitter-python's exported Language shape lags the tree-sitter Language
// type (missing `name`); the runtime value works fine. Cast at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PythonLanguage = Python as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

// ─── Parser singleton ─────────────────────────────────────────────────────────
//
// tree-sitter's Node binding is sync after construction; we keep a single
// Parser instance to avoid per-file setLanguage cost. initPython() exists
// to match the async init() contract and to make a future swap to
// web-tree-sitter (WASM, async init) a one-line change.

let parser: InstanceType<typeof Parser> | null = null;

export async function initPython(): Promise<void> {
  if (parser) return;
  parser = new Parser();
  parser.setLanguage(PythonLanguage);
}

function getParser(): InstanceType<typeof Parser> {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(PythonLanguage);
  }
  return parser;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PROPERTY_CHUNK_MIN_BYTES = 80;

function nodeName(node: TSNode): string | null {
  const id = node.childForFieldName?.('name');
  if (id && typeof id.text === 'string') return id.text;
  return null;
}

// `decorated_definition` wraps a `function_definition` or `class_definition`.
// Unwrap to the inner def for name lookup; keep the outer span so decorators
// (e.g. `@app.route("/...")`) stay attached to the chunk's source.
function innerDef(node: TSNode): TSNode {
  if (node.type !== 'decorated_definition') return node;
  for (const child of node.namedChildren) {
    if (child.type === 'function_definition' || child.type === 'class_definition') return child;
  }
  return node;
}

// ─── __all__ parsing ──────────────────────────────────────────────────────────
//
// If a module declares `__all__ = ["foo", "bar"]`, treat that as the export
// whitelist for module-level assignments. Functions and classes are always
// emitted regardless. Absent or unparseable → fall back to the leading-
// underscore convention.

function parseAllList(rootChildren: TSNode[]): Set<string> | null {
  for (const node of rootChildren) {
    if (node.type !== 'expression_statement') continue;
    const assign = node.namedChild(0);
    if (!assign || assign.type !== 'assignment') continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || !right) continue;
    if (left.type !== 'identifier' || left.text !== '__all__') continue;
    if (right.type !== 'list') continue;
    const names = new Set<string>();
    for (const item of right.namedChildren) {
      if (item.type !== 'string') continue;
      // string_content is the unquoted text
      let content = '';
      for (const part of item.namedChildren) {
        if (part.type === 'string_content') content += part.text;
      }
      if (content) names.add(content);
    }
    return names;
  }
  return null;
}

// ─── Module-level assignment heuristic ────────────────────────────────────────
//
// Python has no `export` keyword. Closest analogue to TS's "exported
// VariableDeclaration with non-function init" rule: top-level assignments
// whose RHS is a call expression (e.g. `app = FastAPI()`, `engine =
// create_engine(...)`, `Base = declarative_base()`). These are structural
// plumbing whose descriptions carry domain vocabulary worth indexing.
//
// Rules:
//   - LHS must be a single identifier
//   - LHS must not start with `_` (private convention) and must not be a dunder
//   - RHS must be a `call` (and span at least PROPERTY_CHUNK_MIN_BYTES)
//   - If __all__ is declared, LHS must be in __all__
//
// Lambda RHS is also chunked (mirrors TS's arrow-init case).

function tryExtractAssignment(
  exprStmt: TSNode,
  allowlist: Set<string> | null,
  out: RawChunk[],
): void {
  const assign = exprStmt.namedChild(0);
  if (!assign || assign.type !== 'assignment') return;

  const left = assign.childForFieldName('left');
  const right = assign.childForFieldName('right');
  if (!left || !right) return;
  if (left.type !== 'identifier') return;

  const name: string = left.text;
  if (name.startsWith('_')) return; // covers `_private` and dunders like `__all__`
  if (allowlist && !allowlist.has(name)) return;

  if (right.type === 'lambda') {
    out.push({ startOffset: exprStmt.startIndex, endOffset: exprStmt.endIndex, symbolName: name });
    return;
  }
  if (right.type !== 'call') return;
  if (right.endIndex - right.startIndex < PROPERTY_CHUNK_MIN_BYTES) return;

  out.push({ startOffset: exprStmt.startIndex, endOffset: exprStmt.endIndex, symbolName: name });
}

// ─── Class body walk ──────────────────────────────────────────────────────────

function extractMethods(classDef: TSNode, out: RawChunk[]): void {
  const body = classDef.childForFieldName('body');
  if (!body) return;
  for (const member of body.namedChildren) {
    if (member.type === 'function_definition') {
      const name = nodeName(member);
      out.push({
        startOffset: member.startIndex,
        endOffset: member.endIndex,
        symbolName: name,
      });
    } else if (member.type === 'decorated_definition') {
      const inner = innerDef(member);
      if (inner.type === 'function_definition') {
        out.push({
          startOffset: member.startIndex,
          endOffset: member.endIndex,
          symbolName: nodeName(inner),
        });
      }
    }
  }
}

// ─── Top-level walk ───────────────────────────────────────────────────────────

function collectFromModule(rootChildren: TSNode[]): RawChunk[] {
  const result: RawChunk[] = [];
  const allowlist = parseAllList(rootChildren);

  for (const node of rootChildren) {
    if (node.type === 'function_definition') {
      result.push({
        startOffset: node.startIndex,
        endOffset: node.endIndex,
        symbolName: nodeName(node),
      });
      continue;
    }

    if (node.type === 'class_definition') {
      result.push({
        startOffset: node.startIndex,
        endOffset: node.endIndex,
        symbolName: nodeName(node),
      });
      extractMethods(node, result);
      continue;
    }

    if (node.type === 'decorated_definition') {
      const inner = innerDef(node);
      // Emit one chunk for the decorated outer span; methods walked inside if it's a class.
      result.push({
        startOffset: node.startIndex,
        endOffset: node.endIndex,
        symbolName: nodeName(inner),
      });
      if (inner.type === 'class_definition') {
        extractMethods(inner, result);
      }
      continue;
    }

    if (node.type === 'expression_statement') {
      tryExtractAssignment(node, allowlist, result);
      continue;
    }
  }

  return result;
}

// ─── Import + docstring prefixes ──────────────────────────────────────────────

function buildImportPrefix(rootChildren: TSNode[]): string {
  const parts: string[] = [];
  for (const node of rootChildren) {
    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      parts.push(node.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
}

// Python module docstring: the first `expression_statement` whose only child
// is a string, occurring before any def/class/import. Mirrors TS's top-of-file
// JSDoc prefix.
function buildModuleDocstring(rootChildren: TSNode[]): string {
  for (const node of rootChildren) {
    if (node.type === 'expression_statement') {
      const inner = node.namedChild(0);
      if (inner && inner.type === 'string') {
        return node.text + '\n\n';
      }
      return ''; // first non-docstring expression statement → no module docstring
    }
    // Imports and dunder assignments may legitimately precede a module docstring
    // in some style guides; skip past them rather than aborting.
    if (
      node.type === 'import_statement' ||
      node.type === 'import_from_statement' ||
      node.type === 'comment'
    ) {
      continue;
    }
    // Any other top-level node (def, class, real assignment) → no docstring.
    return '';
  }
  return '';
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function extractPython(
  code: string,
  _lines: string[],
  _offsetToLine: (offset: number) => number,
): ExtractResult {
  const tree = getParser().parse(code);
  const root = tree.rootNode;

  // tree-sitter never throws on syntax errors; it produces an ERROR node and
  // continues. Partial chunks are usually better than no chunks, so we accept
  // hasError trees but surface a warning.
  const parseWarnings: string[] = [];
  if (root.hasError) {
    parseWarnings.push('python parse tree contains ERROR nodes; chunks may be partial');
  }

  const children = root.namedChildren;
  const rawChunks = collectFromModule(children);
  const importPrefix = buildImportPrefix(children);
  const fileDocPrefix = buildModuleDocstring(children);

  return { rawChunks, importPrefix, fileDocPrefix, parseWarnings };
}
