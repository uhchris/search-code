import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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

let ollamaHost: string | null = null;
let embedderModel: string | null = null;
let queryPrefix: string = '';
let documentPrefix: string = '';

// ─── Init ─────────────────────────────────────────────────────────────────────
// Default embedder: embeddinggemma — handles both prose and code in a single
// embedding space, so the same model can score description queries and raw-code
// queries without a separate code-specialised model.

export function initEmbedder(): void {
  if (embedderModel) return;

  const config = loadConfig();
  embedderModel = config.models.embedder;
  ollamaHost = config.ollama.host;

  // EmbeddingGemma requires task-specific prefixes for full retrieval quality.
  // Other models (mxbai-embed-large, nomic-embed-text) work without prefixes.
  const isEmbeddingGemma = embedderModel.toLowerCase().includes('embeddinggemma');
  queryPrefix =
    config.models.embedderPrompts?.query ??
    (isEmbeddingGemma ? 'task: search result | query: ' : '');
  documentPrefix =
    config.models.embedderPrompts?.document ?? (isEmbeddingGemma ? 'title: none | text: ' : '');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Calls Ollama's native embed endpoint directly. Same transport pattern as
// describer.ts — no SDK dependency, matches the rest of the repo.
async function embedRaw(text: string): Promise<Float32Array> {
  if (!embedderModel || !ollamaHost) {
    throw new Error('Embedder not initialized. Call initEmbedder() first.');
  }

  const RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${ollamaHost}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedderModel, input: text }),
      });
      if (!res.ok) throw new Error(`Ollama embed API error: ${res.status} ${res.statusText}`);

      const json = (await res.json()) as { embeddings?: number[][]; error?: string };
      if (json.error) throw new Error(json.error);
      const vec = json.embeddings?.[0];
      if (!vec || vec.length === 0) throw new Error('Ollama embed returned empty embedding');
      return new Float32Array(vec);
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
// Embed text is the LLM-generated description plus a minimal source pointer.
// Merging the full rawCode in, or prepending a structural identifier manifest,
// both regressed recall on the internal bench — kept as a deliberate negative
// result rather than reattempted.

export function buildEmbedText(chunk: {
  filePath: string;
  symbolName: string | null;
  startLine: number;
  description: string;
}): string {
  return `${chunk.filePath} [${chunk.symbolName ?? chunk.startLine}]: ${chunk.description}`;
}
