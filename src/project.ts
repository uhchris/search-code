import path from 'path';
import fs from 'fs';

// ─── Config types ─────────────────────────────────────────────────────────────

export interface SemanticSearchConfig {
  models?: { describer?: string; embedder?: string };
  ollama?: { host?: string };
  reranker?: { enabled?: boolean; model?: string };
  indexing?: {
    sourceRoots?: string[];
    excludePatterns?: string[];
    minChunkLines?: number;
    maxChunkLines?: number;
    concurrency?: number;
  };
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SemanticSearchConfig = {
  models: { describer: 'gemma4:26b', embedder: 'embeddinggemma' },
  ollama: { host: 'http://localhost:11434' },
  reranker: { enabled: true, model: 'jinaai/jina-reranker-v1-turbo-en' },
  indexing: {
    sourceRoots: ['src'],
    excludePatterns: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.d.ts',
      '**/node_modules/**',
      '**/.semantic-search/**',
      '**/__pycache__/**',
      '**/*.pyc',
      '**/.venv/**',
      '**/venv/**',
      '**/.pytest_cache/**',
      '**/.mypy_cache/**',
      '**/dist/**',
    ],
    minChunkLines: 5,
    maxChunkLines: 300,
    concurrency: 1,
  },
};

export const CONFIG_FILE = 'search-code.config.json';

// ─── Project root discovery ───────────────────────────────────────────────────

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export const PROJECT_ROOT: string =
  process.env.SEMANTIC_SEARCH_ROOT ?? findProjectRoot(process.cwd());

// ─── Config loading ───────────────────────────────────────────────────────────

let _config: SemanticSearchConfig | null = null;

export function loadConfig(): SemanticSearchConfig {
  if (_config) return _config;
  const configPath = path.join(PROJECT_ROOT, CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    _config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as SemanticSearchConfig;
  } else {
    _config = DEFAULT_CONFIG;
  }
  return _config;
}

// ─── DB path ─────────────────────────────────────────────────────────────────

export function getDbPath(): string {
  if (process.env.SEMANTIC_SEARCH_DB) return process.env.SEMANTIC_SEARCH_DB;
  const dir = path.join(PROJECT_ROOT, '.search-code');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'index.db');
}
