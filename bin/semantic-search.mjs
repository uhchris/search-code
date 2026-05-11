#!/usr/bin/env node
process.env.SEMANTIC_SEARCH_CLI = '1';
await import('../dist/index.js');
