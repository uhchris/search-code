import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { getDb, setAllowlisted } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CoOccurrencePair {
  symbolA: string;
  fileA: string;
  symbolB: string;
  fileB: string;
  similarity: number;
  description: string;
  date: string;      // ISO 8601 YYYY-MM-DD
  decayDays: number; // defaults to 7
}

export interface CoOccurrenceAllowlist {
  pairs: CoOccurrencePair[];
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function allowlistPath(projectRoot?: string): string {
  const root = projectRoot ?? path.join(__dirname, '..', '..', '..', '..', '..');
  return path.join(root, '.co-occurrence-allowlist.json');
}

// ─── Load / Save ──────────────────────────────────────────────────────────────

export function loadCoOccurrenceAllowlist(projectRoot?: string): CoOccurrenceAllowlist {
  try {
    const raw = fs.readFileSync(allowlistPath(projectRoot), 'utf-8');
    return JSON.parse(raw) as CoOccurrenceAllowlist;
  } catch {
    return { pairs: [] };
  }
}

export function saveCoOccurrenceAllowlist(allowlist: CoOccurrenceAllowlist, projectRoot?: string): void {
  fs.writeFileSync(allowlistPath(projectRoot), JSON.stringify(allowlist, null, 2) + '\n', 'utf-8');
}

// ─── Prune ────────────────────────────────────────────────────────────────────

export function pruneExpiredPairs(projectRoot?: string): number {
  const allowlist = loadCoOccurrenceAllowlist(projectRoot);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const before = allowlist.pairs.length;
  allowlist.pairs = allowlist.pairs.filter((pair) => {
    const decay = pair.decayDays ?? 7;
    const approvedDate = new Date(pair.date);
    approvedDate.setHours(0, 0, 0, 0);
    const expiresMs = approvedDate.getTime() + decay * 86_400_000;
    return expiresMs > today.getTime();
  });

  const pruned = before - allowlist.pairs.length;
  if (pruned > 0) {
    saveCoOccurrenceAllowlist(allowlist, projectRoot);
  }
  return pruned;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export function isPairAllowlisted(
  pairs: CoOccurrencePair[],
  symbolA: string,
  fileA: string,
  symbolB: string,
  fileB: string,
): boolean {
  return pairs.some(
    (p) =>
      (p.symbolA === symbolA && p.fileA === fileA && p.symbolB === symbolB && p.fileB === fileB) ||
      (p.symbolA === symbolB && p.fileA === fileB && p.symbolB === symbolA && p.fileB === fileA),
  );
}

// ─── Apply to DB ──────────────────────────────────────────────────────────────

export function applyAllowlist(projectRoot: string): void {
  const { pairs } = loadCoOccurrenceAllowlist(projectRoot);

  const allowlistedSymbols = new Set<string>();
  for (const pair of pairs) {
    allowlistedSymbols.add(pair.symbolA);
    allowlistedSymbols.add(pair.symbolB);
  }

  const db = getDb();
  const rows = db
    .prepare('SELECT DISTINCT symbol_name FROM chunks WHERE symbol_name IS NOT NULL')
    .all() as unknown as Array<{ symbol_name: string }>;

  for (const row of rows) {
    setAllowlisted(row.symbol_name, allowlistedSymbols.has(row.symbol_name));
  }
}
