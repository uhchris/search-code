# v12 — Research notes on AST identifier extraction for embedding manifests

**Question being answered:** When prepending a structural manifest of identifiers to an LLM-generated description before embedding, which AST nodes do we collect — and is there research backing for that exact extraction algorithm?

**Short answer:** No paper directly endorses "AST-extracted identifiers prepended as a dense-embedding prefix." The closest precedents are CodeT5 / GraphCodeBERT, which extract identifiers from AST leaves/terminals, filter language keywords (not a generic stoplist), and concatenate them with the source as model input. Anthropic's Contextual Retrieval prepends natural-language context, not identifiers. Our manifest design is an extrapolation of these techniques, not a direct citation. Treat this as a principled engineering choice, not a research-validated method.

---

## 1. GraphCodeBERT — arXiv:2009.08366

**Source:** ar5iv HTML, Section 3 (Data Flow) and Section 4.1 (Model Architecture).

> "nodes represent variables and edges represent the relation of 'where-the-value-comes-from' between variables" — §3

> "terminals (leaves) are used to identify the variable sequence, denoted as V = {v₁, v₂, …, vₖ}" — §3

> "Given a source code C = {c₁, c₂, …, cₙ}, we first parse the code into an abstract syntax tree (AST)... The AST includes syntax information of the code and terminals (leaves) are used to identify the variable sequence" — §3

> "we concatenate the comment, source code and the set of variables as the sequence input X = {[CLS], W, [SEP], C, [SEP], V}" — §4.1

**Takeaway for our use case.**
- They define "variables" as **AST terminal (leaf) nodes** — exactly the leaves that ESTree calls `Identifier`.
- They concatenate the variable list **after** the source code (suffix), not as a prefix. So they don't directly support our prefix placement; arXiv:2412.15241's positional-bias finding is what justifies prefix placement, not GraphCodeBERT.
- They are training a *transformer* with attention over `V` — not stuffing tokens into a frozen embedder. Important distinction.

## 2. CodeT5 — arXiv:2109.00859 (predecessor of CodeT5+)

**Source:** ar5iv HTML, Sections 3.1 and 4.1.

> "we focus on the type of identifiers (e.g., function names and variables) as they are one of the most PL-agnostic features" — §3.1

> "we leverage the tree-sitter to convert the PL into an abstract syntax tree and then extract its node type information" — §4.1

> "We filter out reserved keywords for each PL from its identifier list" — §4.1

> "we construct a sequence of binary labels y ∈ {0,1}^m for the PL segment, where each yᵢ ∈ {0,1} represents whether the code token cᵢ is an identifier or not" — §3.1

**Takeaway for our use case.**
- This is the **strongest** precedent. CodeT5 explicitly uses tree-sitter AST node-type information to label identifier tokens, and explicitly filters **reserved keywords per PL** — *not* a generic stoplist of common variable names.
- Our current `MANIFEST_STOP` mixes two categories: (a) JS reserved keywords (`const`, `let`, `for`, `while`, `class` etc.) and (b) common type names + library names (`string`, `number`, `useState`, `useEffect`, `react`, `console`).
- Following CodeT5's principle: (a) is unnecessary because oxc-parser's ESTree never emits keywords as `Identifier` nodes — they parse as keyword tokens / dedicated AST node types (e.g. `IfStatement`, `ForStatement`). The "block" list for those entries is dead code. (b) is an empirical denoising choice, *not* what CodeT5 does — they keep `string`, `number` etc. and rely on the model to learn their low information content.

## 3. UniXcoder — arXiv:2203.03850

**Source:** ar5iv HTML, Section 3.1 (Algorithm 1 / one-to-one AST mapping).

> "we propose a one-to-one mapping function ℱ, described in Algorithm 1, to transform an AST into a sequence that retains all structural information" — §3.1

> "Taking 'parameters → (data)' as an example, the mapping function ℱ transforms the subtree to '<parameters,left> ( data ) <parameters,right>'" — §3.1

**Takeaway.** UniXcoder serializes the *whole* AST structure (internal nodes wrapped with `<name,left>` / `<name,right>` sentinels). Not a "manifest of identifiers" — a complete tree linearization. **Does not match our use case** (we want a compact identifier bag, not a tree serialization).

## 4. CodeT5+ — arXiv:2305.07922

**Source:** ar5iv HTML, Section 2.

> "In CodeT5+, we efficiently activate component modules for different tasks and do not rely on code-specific features." — §2

**Takeaway.** CodeT5+ explicitly **abandons** AST/identifier features that CodeT5 used. The newer paper takes a position *against* identifier-aware input formatting, suggesting raw code + scale beats identifier engineering. So citing CodeT5+ as research backing for manifest extraction is incorrect — if anything, it's a counter-citation.

## 5. Anthropic Contextual Retrieval (no arXiv ID — blog post)

**Source:** anthropic.com/news/contextual-retrieval.

> "This chunk is from an SEC filing on ACME corp's performance in Q2 2023; the previous quarter's revenue was $314 million. The company's revenue grew by 3% over the previous quarter."

> Prompt: "Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk."

**Takeaway.** Anthropic's prepend is **natural-language situational context generated by an LLM** — not an extracted identifier bag. They rely on a Haiku-class model + prompt caching to keep cost low. Different mechanism from our manifest. Cited correctly only as "prepending context to chunks works for retrieval"; not as a citation for AST extraction.

## 6. arXiv:2412.15241 — Positional Bias in Embeddings

**Source:** ar5iv HTML, §1, §3.2.

> "embedding models, regardless of their positional encoding mechanisms, disproportionately weigh the beginning of a text input" — §1

> "inserting irrelevant text at the beginning of a document reduces the cosine similarity between the altered and original document embeddings by up to 8.5% more than when inserted in the middle, and 12.3% more than when inserted at the end" — §1

**Takeaway.** This is a **legitimate** citation for *prefix* placement (not for what to put in the prefix). Confirms: if we put the manifest somewhere, the head of the input has the most embedding influence. Does not say anything about whether identifiers help.

## 7. arXiv:2601.11863 (RAGMATE-10K / metadata-as-prefix)

**This citation is mis-attributed in our embedder.ts comment.** The paper is about *domain-specific structured metadata* (`company_name`, `form_type`) for SEC-style RAG — not about generic AST identifier extraction. It validates "structured metadata as prefix improves retrieval over a noisy chunk" but does not validate the AST-extraction mechanism. Keep as supporting context, not as the algorithmic source.

## 8. arXiv:2503.05315 (LoRACode)

**This citation is mis-attributed.** LoRACode adapts a base model with LoRA for code search. It does not specify identifier extraction or manifest formatting. Drop from comments.

## 9. Local precedent: claude-context, SocratiCode, our own tool

- **claude-context** (`packages/core/src/splitter/ast-splitter.ts`): tree-sitter AST splitter. Embeds **raw chunk content only**. No manifest, no path prefix. Confirmed by reading the file end-to-end.
- **SocratiCode** (`src/services/embeddings.ts:115`): single-line prefix
  ```ts
  return `search_document: ${filePath}\n${content}`;
  ```
  Just task instruction (nomic-style) + filePath + raw content. **No identifier manifest.**
- **Our v12 (current)** (`src/chunker.ts:178`): collects ESTree `Identifier.name` and identifier-shaped string `Literal.value`, filters via `MANIFEST_STOP` set + length filter + 50-token cap.

We are doing something **none of the local references do**. Not necessarily wrong, but it means there is no off-the-shelf algorithm to copy.

---

## Recommended extraction algorithm (principled, not "research-backed")

We have two grounded principles:

1. **CodeT5 §4.1**: extract from AST node *types*, then filter reserved keywords. Quote: *"We filter out reserved keywords for each PL from its identifier list."*
2. **GraphCodeBERT §3**: variables are **terminal (leaf) AST nodes**. Quote: *"terminals (leaves) are used to identify the variable sequence."*

Translated to ESTree (oxc-parser output) for TypeScript/JavaScript, the principled extraction is:

```
COLLECT  Identifier.name  when the Identifier appears in a position that
         carries domain semantics (declaration sites + property keys + literal
         column names), not type-system positions:

  - VariableDeclarator.id          → const sandboxId = ...
  - FunctionDeclaration.id          → function listSandboxes() {}
  - FunctionExpression.id
  - ArrowFunctionExpression — params
  - ClassDeclaration.id / ClassExpression.id
  - MethodDefinition.key            → class { listSandboxes() {} }
  - Property.key (when not computed) → { sandbox_id: ... }
  - PropertyDefinition.key
  - ImportSpecifier.imported / ImportDefaultSpecifier.local
  - ExportSpecifier.exported

ALSO   Literal.value when it matches /^[a-z][a-z0-9_]+$/i AND length 3–40
       (catches Drizzle-style `'sandbox_id'` column-name string literals).

SKIP   - TSTypeReference.typeName        (string, number, boolean — primitives carry no domain)
       - TSTypeAliasDeclaration.id type-side annotations
       - JSXIdentifier when it matches a known component (use a lightweight heuristic: starts with uppercase = component; we keep it because ComponentName IS domain vocab)
       - Identifier that is a direct child of an ImportDeclaration.source

DEDUPE: Set; cap at 50 tokens; skip tokens length < 3.
```

This is a positional rule (which AST positions to *collect*), exactly the level of specificity the user asked for. It is **derived from** GraphCodeBERT's "leaves are variables" + CodeT5's "filter reserved keywords per PL" — but adapted to ESTree (which has no analog to tree-sitter's `node.type === 'identifier'` at every leaf; ESTree wraps identifiers under role-specific parent fields).

### Why this is better than the current implementation

Current code (`chunker.ts:188`) collects **every** `Identifier` node anywhere in the tree, then filters via a hardcoded keyword stoplist. Two problems:

1. **Stoplist is partly dead code.** Entries like `const`, `let`, `for`, `class`, `if`, `else` are never emitted as ESTree `Identifier` nodes. They are reserved words and parse as dedicated node types or as the keyword token of a statement node. Verifying this: oxc-parser produces e.g. `VariableDeclaration` with kind `'const'` (a string field on the node, not an `Identifier` child). So `MANIFEST_STOP.has('const')` never fires.
2. **It collects `Identifier` nodes at type positions.** `TSTypeReference.typeName` for `string` / `number` / `Promise` etc. **does** parse as `Identifier`. These leak into the manifest as low-signal noise. The current stoplist tries to compensate with `'string', 'number', 'boolean', ...`, which is exactly the hardcoded-keyword-list hack the user pushed back on.

Switching to position-based collection eliminates both: type-position identifiers are *never collected* in the first place, and reserved keywords *can never* appear because they aren't `Identifier` nodes.

### What this is NOT

- **Not** a paper-validated algorithm. No paper says "extract `VariableDeclarator.id` and prepend to the embed text." We are extrapolating CodeT5's "AST node-type extraction + keyword filtering" principle into ESTree positions.
- **Not** guaranteed to improve retrieval. The intuition (prefix carries embedding weight per arXiv:2412.15241; identifier bag adds domain vocab to dense space) is sound, but our v8a regression (R@1 79% → 15% when raw code was concatenated) shows that adding code-flavoured tokens to a description embedder can hurt. The manifest must stay *short* and *high-signal*. The 50-token cap is a guess, not a measured optimum — benchmark before/after with token caps {20, 50, 100} on the prettier/SWE-PolyBench harness.

### Concrete code change

In `src/chunker.ts:extractManifest()`:

1. Replace generic `node.type === 'Identifier'` collection with a **parent-aware visitor** that only collects when entering specific child positions of specific parent types (list above).
2. Drop `MANIFEST_STOP` entirely. With position-based collection it becomes redundant. (If a small empirical denoise list is still wanted, scope it to known low-signal type names like `Promise`, `Array`, `Record`, `Partial` — but only after measuring.)
3. Keep the identifier-shaped `Literal.value` extraction — it's the only way to get Drizzle column-name strings, and they are unambiguously domain vocabulary.
4. Update the comment block to drop arXiv:2503.05315 and arXiv:2601.11863 as "backing" — they are **not** sources for the algorithm. Cite GraphCodeBERT §3 + CodeT5 §4.1 as the principled inspiration; cite arXiv:2412.15241 only for prefix placement.

### Honest framing for the user

> "Research-backed" is too strong. The positional-extraction rule is *consistent with* GraphCodeBERT and CodeT5's identifier-handling principles, but neither paper describes prepending an identifier bag to a frozen text-embedder's input as a dense-retrieval signal — they use identifiers as transformer training input. Our manifest is a principled engineering choice; the only valid measure of success is the benchmark.
