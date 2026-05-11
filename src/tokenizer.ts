// ─── Compound-identifier splitter (Lucene WordDelimiterGraphFilter rules) ────
//
// Splits camelCase / PascalCase / snake_case / kebab-case / mixed identifiers
// into their constituent words. Used at index time only — the FTS5 column
// stores `${rawCode}\n${splits}` so the original compound token is preserved
// (Lucene `preserve_original=true`) and split forms are also matchable.
//
// Reference: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-word-delimiter-graph-tokenfilter.html
//
// Rules applied:
//   1. Split at non-alphanumeric          Super-Duper       → Super, Duper
//   2. Split at letter↔digit transition   XL500             → XL, 500
//   3. Split lower→upper                  PowerShot         → Power, Shot
//   4. Split upper-run→lower (acronym)    XMLParser         → XML, Parser
//                                         DBAdmin           → DB, Admin
//                                         IPv6Address       → IPv, 6, Address
//
// The acronym rule (#4) only fires when the upper-run length ≥ 3 — this is
// what keeps `IPv` together (run length 2 with the trailing lowercase) while
// splitting `XMLParser` (run length 4). `IPv6Address` is genuinely ambiguous
// and `preserve_original` mitigates: the original token stays searchable.

type CharKind = 'lower' | 'upper' | 'digit' | 'other';

function charKind(c: string): CharKind {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return 'digit';
  if (code >= 65 && code <= 90) return 'upper';
  if (code >= 97 && code <= 122) return 'lower';
  return 'other';
}

function splitCaseAndDigit(s: string): string[] {
  if (s.length <= 1) return s ? [s] : [];
  const boundaries: number[] = [0];

  for (let i = 1; i < s.length; i++) {
    const prevKind = charKind(s[i - 1]);
    const currKind = charKind(s[i]);
    if (prevKind === currKind) continue;

    const prevIsLetter = prevKind === 'lower' || prevKind === 'upper';
    const currIsLetter = currKind === 'lower' || currKind === 'upper';

    // Letter ↔ digit transition
    if ((prevIsLetter && currKind === 'digit') || (prevKind === 'digit' && currIsLetter)) {
      boundaries.push(i);
      continue;
    }

    // Lower → Upper (camelCase boundary)
    if (prevKind === 'lower' && currKind === 'upper') {
      boundaries.push(i);
      continue;
    }

    // Upper-run → Lower (acronym handling): split BEFORE the last upper
    // if the upper-run has length ≥ 3, so the last upper joins the lowercase
    // run as the start of the next word (XMLParser → XML + Parser).
    if (prevKind === 'upper' && currKind === 'lower') {
      let runStart = i - 1;
      while (runStart > 0 && charKind(s[runStart - 1]) === 'upper') runStart--;
      const runLen = i - runStart;
      if (runLen >= 3) {
        boundaries.push(i - 1);
      }
    }
  }

  boundaries.push(s.length);

  const parts: string[] = [];
  let prev = boundaries[0];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] > prev) {
      parts.push(s.slice(prev, boundaries[i]));
      prev = boundaries[i];
    }
  }
  return parts;
}

// Step 1 of the rule set: split at non-alphanumeric, then apply case/digit
// rules to each segment. No length floor — single-char digit/letter splits
// (e.g. `IPv6Address` → `IPv`,`6`,`Address`) are preserved; FTS5 BM25 IDF
// naturally downweights common short tokens.
export function splitIdentifier(token: string): string[] {
  if (!token) return [];
  const segments = token.split(/[^a-zA-Z0-9]+/u).filter(Boolean);
  const out: string[] = [];
  for (const segment of segments) {
    for (const part of splitCaseAndDigit(segment)) {
      out.push(part);
    }
  }
  return out;
}

// ─── Index-side augmentation ──────────────────────────────────────────────────
// Append a deduplicated set of split sub-tokens to the original text. FTS5
// unicode61 lowercases everything at tokenization time, so casing differences
// between original and splits collapse naturally. The result preserves both
// the unsplit form (Lucene `preserve_original=true`) and every split form.

export function augmentForFts5(text: string): string {
  const matches = text.match(/[a-zA-Z][a-zA-Z0-9_]*/g) ?? [];
  const splits = new Set<string>();
  for (const m of matches) {
    const parts = splitIdentifier(m);
    if (parts.length <= 1) continue;
    for (const p of parts) splits.add(p);
  }
  if (splits.size === 0) return text;
  return `${text}\n${[...splits].join(' ')}`;
}
