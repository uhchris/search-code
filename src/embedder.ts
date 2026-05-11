import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config {
  models: {
    embedder: string;
    embedderPrompts?: {
      query?: string;
      document?: string;
    };
  };
  ollama: {
    host: string;
  };
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  cachedConfig = JSON.parse(raw) as Config;
  return cachedConfig;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let client: OpenAI | null = null;
let embedderModel: string | null = null;
let queryPrefix: string = '';
let documentPrefix: string = '';

// ─── Init ─────────────────────────────────────────────────────────────────────
// Default embedder: embeddinggemma. SOTA on MTEB(Code) for sub-500M models per
// arXiv:2509.20354 — handles BOTH prose and code in a single embedding space, so
// there's no reason to swap to a code-specialised model. Already-evaluated alternatives:
//   - nomic-embed-text: identical scores to embeddinggemma (see v3-nomic.md)
//   - nomic-embed-text-code: scores went DOWN — code-specialised model underperforms
//     on our LLM-generated NL descriptions. Do not retry for description channel.

export function initEmbedder(): void {
  if (client) return;

  const config = loadConfig();
  embedderModel = config.models.embedder;

  // EmbeddingGemma requires task-specific prefixes for full retrieval quality.
  // Other models (mxbai-embed-large, nomic-embed-text) work without prefixes.
  const isEmbeddingGemma = embedderModel.toLowerCase().includes('embeddinggemma');
  queryPrefix = config.models.embedderPrompts?.query ?? (isEmbeddingGemma ? 'task: search result | query: ' : '');
  documentPrefix = config.models.embedderPrompts?.document ?? (isEmbeddingGemma ? 'title: none | text: ' : '');

  client = new OpenAI({
    baseURL: `${config.ollama.host}/v1`,
    apiKey: 'ollama',
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedRaw(text: string): Promise<Float32Array> {
  if (!client || !embedderModel) {
    throw new Error('Embedder not initialized. Call initEmbedder() first.');
  }

  const RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: embedderModel,
        input: text,
      });
      return new Float32Array(response.data[0].embedding);
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await sleep(1000);
    }
  }

  throw lastError;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a search query. Applies query-side prompt prefix when required by the model.
 */
export async function embedQuery(text: string): Promise<Float32Array> {
  return embedRaw(queryPrefix + text);
}

/**
 * Embed a document (code description at index time). Applies document-side prefix when required.
 */
export async function embed(text: string): Promise<Float32Array> {
  return embedRaw(documentPrefix + text);
}

/**
 * Embed a batch of documents. Returns Float32Array[] in the same order.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

// ─── Embed text builder (single source of truth) ──────────────────────────────
// v8a (merged full rawCode + description) regressed R@1 79% → 15%. v12 tried a
// structural identifier MANIFEST as prefix (GraphCodeBERT-style leaf identifiers
// + CodeT5-style filtering, prefix placement per arXiv:2412.15241): on the 40-case
// frink bench it cost R@1 −7pp + MRR −0.039 to lift one Mode 2 case (chat schema)
// from R@5=0 to R@3. Reverted. Manifest path lives in chunker.extractManifest in
// case future work wants to revisit a smaller-cap or selective-application variant.

export function buildEmbedText(chunk: {
  filePath: string;
  symbolName: string | null;
  startLine: number;
  description: string;
}): string {
  return `${chunk.filePath} [${chunk.symbolName ?? chunk.startLine}]: ${chunk.description}`;
}
