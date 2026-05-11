import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadCoOccurrenceAllowlist,
  saveCoOccurrenceAllowlist,
  pruneExpiredPairs,
  isPairAllowlisted,
  type CoOccurrencePair,
} from '../allowlist.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
}

function makePair(overrides: Partial<CoOccurrencePair> = {}): CoOccurrencePair {
  return {
    symbolA: 'useAuth',
    fileA: 'src/hooks/useAuth.ts',
    symbolB: 'useAuthLegacy',
    fileB: 'src/hooks/useAuthLegacy.ts',
    similarity: 0.91,
    description: 'Legacy hook',
    date: new Date().toISOString().slice(0, 10),
    decayDays: 7,
    ...overrides,
  };
}

describe('loadCoOccurrenceAllowlist', () => {
  it('returns empty pairs when file is missing', () => {
    const result = loadCoOccurrenceAllowlist('/nonexistent/path');
    assert.deepEqual(result, { pairs: [] });
  });

  it('reads pairs from file', () => {
    const dir = makeTmpDir();
    const pair = makePair();
    fs.writeFileSync(
      path.join(dir, '.co-occurrence-allowlist.json'),
      JSON.stringify({ pairs: [pair] }, null, 2),
    );
    const result = loadCoOccurrenceAllowlist(dir);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].symbolA, 'useAuth');
  });
});

describe('pruneExpiredPairs', () => {
  it('removes pairs past their decayDays', () => {
    const dir = makeTmpDir();
    const expired = makePair({ date: '2020-01-01', decayDays: 7 });
    const fresh = makePair({ symbolA: 'foo', symbolB: 'bar' });
    saveCoOccurrenceAllowlist({ pairs: [expired, fresh] }, dir);

    const pruned = pruneExpiredPairs(dir);
    assert.equal(pruned, 1);

    const result = loadCoOccurrenceAllowlist(dir);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].symbolA, 'foo');
  });

  it('keeps pairs that have not expired', () => {
    const dir = makeTmpDir();
    const fresh = makePair();
    saveCoOccurrenceAllowlist({ pairs: [fresh] }, dir);

    const pruned = pruneExpiredPairs(dir);
    assert.equal(pruned, 0);
    assert.equal(loadCoOccurrenceAllowlist(dir).pairs.length, 1);
  });

  it('returns 0 and does not write when nothing is pruned', () => {
    const dir = makeTmpDir();
    const fresh = makePair();
    saveCoOccurrenceAllowlist({ pairs: [fresh] }, dir);
    const mtimeBefore = fs.statSync(path.join(dir, '.co-occurrence-allowlist.json')).mtimeMs;

    const pruned = pruneExpiredPairs(dir);
    assert.equal(pruned, 0);
    const mtimeAfter = fs.statSync(path.join(dir, '.co-occurrence-allowlist.json')).mtimeMs;
    assert.equal(mtimeBefore, mtimeAfter);
  });
});

describe('isPairAllowlisted', () => {
  it('returns true for exact match', () => {
    const pair = makePair();
    assert.equal(
      isPairAllowlisted([pair], 'useAuth', 'src/hooks/useAuth.ts', 'useAuthLegacy', 'src/hooks/useAuthLegacy.ts'),
      true,
    );
  });

  it('returns true for reversed order (bidirectional)', () => {
    const pair = makePair();
    assert.equal(
      isPairAllowlisted([pair], 'useAuthLegacy', 'src/hooks/useAuthLegacy.ts', 'useAuth', 'src/hooks/useAuth.ts'),
      true,
    );
  });

  it('returns false when pair is not in list', () => {
    const pair = makePair();
    assert.equal(
      isPairAllowlisted([pair], 'someOther', 'src/other.ts', 'useAuth', 'src/hooks/useAuth.ts'),
      false,
    );
  });

  it('returns false for same symbol name in different file', () => {
    const pair = makePair();
    assert.equal(
      isPairAllowlisted([pair], 'useAuth', 'src/hooks/DIFFERENT.ts', 'useAuthLegacy', 'src/hooks/useAuthLegacy.ts'),
      false,
    );
  });
});
