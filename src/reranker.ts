import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';
import type { SearchResult } from './store.js';

// ─── Config ───────────────────────────────────────────────────────────────────

// 37.8M params, ONNX quantized (~38 MB), 8K context window.
// Code-ranking generalises better than MS-MARCO passage models.
const MODEL_ID = 'jinaai/jina-reranker-v1-turbo-en';

// ─── Lazy model cache ────────────────────────────────────────────────────────

type HFModel = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
type HFTokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;

let cachedModel: HFModel | null = null;
let cachedTokenizer: HFTokenizer | null = null;

async function loadModel(): Promise<{ model: HFModel; tokenizer: HFTokenizer }> {
  if (!cachedModel || !cachedTokenizer) {
    console.error('[reranker] loading model (first call — downloading to HF cache if needed)...');
    [cachedModel, cachedTokenizer] = await Promise.all([
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: 'q8' }),
      AutoTokenizer.from_pretrained(MODEL_ID),
    ]);
    console.error('[reranker] model ready');
  }
  return { model: cachedModel, tokenizer: cachedTokenizer };
}

// ─── Rerank ───────────────────────────────────────────────────────────────────
//
// Tokenises all (query, description) pairs in a single batched forward pass.
// Applies sigmoid to the raw logit to get a [0, 1] relevance score.
// Falls back to original vector ranking on any error.

export async function rerank(query: string, candidates: SearchResult[]): Promise<SearchResult[]> {
  if (candidates.length <= 1) return candidates;

  try {
    const { model, tokenizer } = await loadModel();
    const docs = candidates.map((c) => c.description);

    const inputs = tokenizer(
      new Array(docs.length).fill(query) as string[],
      {
        text_pair: docs,
        padding: true,
        truncation: true,
      },
    );

    const { logits } = await model(inputs) as { logits: { sigmoid: () => { tolist: () => number[][] } } };
    const scores: number[] = logits.sigmoid().tolist().map((row: number[]) => row[0] ?? 0);

    if (scores.length !== candidates.length) {
      throw new Error(`Score count mismatch: got ${scores.length}, expected ${candidates.length}`);
    }

    return candidates
      .map((c, i) => ({ ...c, similarity: scores[i] ?? 0 }))
      .sort((a, b) => b.similarity - a.similarity);
  } catch (err) {
    console.error('[reranker] failed, using vector-only ranking:', (err as Error).message);
    return candidates;
  }
}
