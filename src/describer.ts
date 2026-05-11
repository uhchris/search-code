import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config {
  models: { describer: string };
  ollama: { host: string };
}

let cachedConfig: Config | null = null;

function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;
  cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Config;
  return cachedConfig;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let ollamaHost: string | null = null;
let describerModel: string | null = null;

export function initDescriber(): void {
  if (describerModel) return;
  const config = loadConfig();
  describerModel = config.models.describer;
  ollamaHost = config.ollama.host;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── File context builder ─────────────────────────────────────────────────────

const FILE_CONTEXT_LINE_THRESHOLD = 300;

// Returns the full file content for small files, or a skeleton of exported
// symbol signatures for large files. Passed to describe() so the LLM can
// situate each chunk within its file (Anthropic Contextual Retrieval pattern).
export function buildFileContext(fileContent: string): string {
  const lines = fileContent.split('\n');
  if (lines.length <= FILE_CONTEXT_LINE_THRESHOLD) return fileContent;

  // Skeleton: collect each export line plus its immediately preceding JSDoc (≤8 lines)
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('export ') || trimmed.startsWith('export {')) continue;

    // Look back for a JSDoc block
    let scan = i - 1;
    while (scan >= 0 && lines[scan].trim() === '') scan--;
    if (scan >= 0 && lines[scan].includes('*/')) {
      const jsDocEnd = scan;
      while (scan >= 0 && !lines[scan].includes('/**')) scan--;
      if (scan >= 0 && jsDocEnd - scan <= 8) {
        out.push(...lines.slice(scan, jsDocEnd + 1));
      }
    }
    out.push(lines[i]); // signature only — body lines are skipped
  }
  return out.join('\n');
}

// ─── Describe ─────────────────────────────────────────────────────────────────

export async function describe(rawCode: string, fileContext?: string): Promise<string> {
  if (!describerModel || !ollamaHost) {
    throw new Error('Describer not initialized. Call initDescriber() first.');
  }

  const RETRIES = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${ollamaHost}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: describerModel,
          stream: false,
          think: false, // disable thinking chain for throughput — no effect on non-thinking models
          options: { temperature: 0.1, num_predict: 150 },
          messages: [
            {
              role: 'system',
              content: `You are a code search indexing assistant. Your descriptions are used as semantic search targets — a developer will type a natural-language query and your description must match their intent, not just the implementation details.

A good description answers: what problem does this solve, in what scenario is it used, and what are its key behaviors or limits?
A bad description only lists: what the code mechanically does (inputs, outputs, data structures).

EXAMPLES OF BAD vs GOOD descriptions:

BAD: "This class aggregates incoming string or buffer data into a single buffer, triggering a callback when a predefined size limit is reached or a time interval elapses."
GOOD: "Reduces IPC overhead when streaming terminal output from a pty process to the renderer by batching incoming text and flushing it at most every 16ms or when the buffer exceeds 200KB. Handles UTF-8 multi-byte sequences split across chunks and flushes all remaining data on disposal."

BAD: "This function returns an asynchronous handler that executes a provided callback with controlled concurrency and a specified timeout."
GOOD: "Prevents JS heap exhaustion from concurrent agent executions by wrapping a handler in a semaphore that limits how many chat sessions can run simultaneously. Automatically releases the slot after a configurable timeout so a hung agent never permanently blocks the queue."

BAD: "This function validates a state parameter and retrieves a code verifier from a consumer object."
GOOD: "Validates the OAuth state parameter returned in a login callback to prevent CSRF attacks, then retrieves the PKCE code verifier needed for token exchange. Returns an error if the state is missing, expired, or was never issued by this application."

Notice: good descriptions name the domain (terminal output, agent execution, OAuth login), the problem being solved (IPC overhead, heap exhaustion, CSRF), and key behavioral limits (16ms/200KB, semaphore cap, timeout).`,
            },
            {
              role: 'user',
              content: fileContext
                ? `Here is the full source file for context:\n<file>\n${fileContext}\n</file>\n\nNow describe the following specific function in 2-3 sentences following the GOOD pattern from the examples. Use the file context to name the domain and purpose accurately. Cover: (1) the problem it solves or the scenario it is used in — name the domain explicitly; (2) what it computes, transforms, or returns; (3) key constraints, limits, or failure conditions. Do not mention the programming language or file name.\n\n<code>\n${rawCode}\n</code>`
                : `Describe what this code does in 2-3 sentences following the GOOD pattern from the examples. Cover: (1) the problem it solves or the scenario it is used in — name the domain explicitly; (2) what it computes, transforms, or returns; (3) key constraints, limits, or failure conditions. Do not mention the programming language or file name.\n\n<code>\n${rawCode}\n</code>`,
            },
          ],
        }),
      });

      if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);

      const json = await res.json() as {
        message?: { content?: string; thinking?: string };
        error?: string;
      };

      if (json.error) throw new Error(json.error);

      const text = json.message?.content ?? '';
      return text.trim();
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await sleep(1000);
    }
  }

  throw lastError;
}

