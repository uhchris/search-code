import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { extractPython, initPython } from '../chunker-python.js';

before(async () => {
  await initPython();
});

function extract(code: string) {
  const lines = code.split('\n');
  // The offsetToLine arg isn't consumed by the python extractor — startIndex/
  // endIndex byte offsets are returned directly and the caller in chunker.ts
  // does the line mapping. Pass a stub so the signature matches.
  return extractPython(code, lines, (offset: number) => {
    let line = 1;
    for (let i = 0; i < offset && i < code.length; i++) {
      if (code[i] === '\n') line++;
    }
    return line;
  });
}

function namesOf(result: ReturnType<typeof extract>): (string | null)[] {
  return result.rawChunks.map((c) => c.symbolName);
}

describe('chunker-python', () => {
  it('chunks a decorated function with the decorator span attached', () => {
    const code = `import os

@app.route("/hello")
def greet(name):
    return f"hello {name}"
`;
    const result = extract(code);
    assert.equal(result.rawChunks.length, 1);
    const chunk = result.rawChunks[0];
    assert.equal(chunk.symbolName, 'greet');
    const span = code.slice(chunk.startOffset, chunk.endOffset);
    assert.ok(
      span.startsWith('@app.route'),
      `expected span to begin with decorator, got: ${span.slice(0, 40)}`,
    );
    assert.ok(span.includes('def greet'));
  });

  it('emits one chunk for a class plus one per method', () => {
    const code = `class AppConfig:
    """Config class."""
    def __init__(self, debug=False):
        self.debug = debug

    def reload(self):
        return True
`;
    const result = extract(code);
    const names = namesOf(result);
    assert.deepEqual(names, ['AppConfig', '__init__', 'reload']);
  });

  it('preserves decorators on methods inside a class', () => {
    const code = `class Api:
    @property
    def status(self):
        return self._status

    @staticmethod
    def helper(x):
        return x * 2
`;
    const result = extract(code);
    const status = result.rawChunks.find((c) => c.symbolName === 'status');
    const helper = result.rawChunks.find((c) => c.symbolName === 'helper');
    assert.ok(status && helper);
    assert.ok(code.slice(status.startOffset, status.endOffset).includes('@property'));
    assert.ok(code.slice(helper.startOffset, helper.endOffset).includes('@staticmethod'));
  });

  it('respects __all__ for module-level assignments', () => {
    const code = `__all__ = ["public_thing"]

public_thing = make_thing(
    name="public",
    description="exported via __all__, long enough to pass byte threshold",
    extra="padding to ensure the RHS exceeds the chunk minimum byte length",
)

private_thing = make_thing(
    name="private",
    description="not in __all__, also padded to pass the byte threshold here",
    extra="more padding to ensure the RHS exceeds the chunk minimum byte length",
)
`;
    const result = extract(code);
    const names = namesOf(result);
    assert.ok(names.includes('public_thing'));
    assert.ok(!names.includes('private_thing'));
  });

  it('falls back to leading-underscore convention when no __all__', () => {
    const code = `app = FastAPI(
    title="my long application that needs documenting here",
    version="1.0.0",
    description="A long-enough description for the chunker.",
)

_private = make_private_thing(
    arg="something",
    other="value",
)
`;
    const result = extract(code);
    const names = namesOf(result);
    assert.ok(names.includes('app'));
    assert.ok(!names.includes('_private'));
  });

  it('emits a module docstring as fileDocPrefix', () => {
    const code = `"""Module docstring.

Spans multiple lines.
"""
import os

def foo():
    return 1
`;
    const result = extract(code);
    assert.ok(result.fileDocPrefix.startsWith('"""Module docstring.'));
    assert.ok(result.fileDocPrefix.endsWith('\n\n'));
  });

  it('collects imports into importPrefix', () => {
    const code = `import os
from typing import Optional

def foo():
    return 1
`;
    const result = extract(code);
    assert.ok(result.importPrefix.includes('import os'));
    assert.ok(result.importPrefix.includes('from typing import Optional'));
    assert.ok(result.importPrefix.endsWith('\n\n'));
  });

  it('survives parse errors and emits partial chunks with a warning', () => {
    const code = `def foo():
    return 1

def broken(
    # missing closing paren — syntax error

def bar():
    return 2
`;
    const result = extract(code);
    assert.ok(result.parseWarnings.length > 0, 'expected parse warning');
    const names = namesOf(result);
    assert.ok(names.includes('foo'));
    assert.ok(names.includes('bar'));
  });

  it('does not chunk dunders even without __all__', () => {
    const code = `__version__ = "1.0"
__author__ = "someone"

real_thing = make_real_thing(
    arg="value-padded-out-to-clear-the-eighty-byte-minimum",
    other="another value also padded for the byte threshold",
)
`;
    const result = extract(code);
    const names = namesOf(result);
    assert.ok(!names.includes('__version__'));
    assert.ok(!names.includes('__author__'));
    assert.ok(names.includes('real_thing'));
  });

  it('skips short module-level call assignments', () => {
    const code = `x = make(1)
`;
    const result = extract(code);
    assert.equal(result.rawChunks.length, 0);
  });

  it('does not chunk integer/string-literal assignments (not calls)', () => {
    const code = `MAX_RETRIES = 5
DEFAULT_NAME = "alice"
`;
    const result = extract(code);
    assert.equal(result.rawChunks.length, 0);
  });

  it('chunks an async function definition', () => {
    const code = `async def fetch_data(url):
    async with httpx.AsyncClient() as client:
        return await client.get(url)
`;
    const result = extract(code);
    // tree-sitter-python represents async funcs as function_definition with an `async` modifier,
    // so this should produce one chunk named `fetch_data`.
    assert.equal(result.rawChunks.length, 1);
    assert.equal(result.rawChunks[0].symbolName, 'fetch_data');
  });
});
