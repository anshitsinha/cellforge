# kiln: the local model runtime

`packages/kiln` (`@cellforge/kiln`) runs small decoder-only language models
in the browser, with no runtime dependencies and no server. It is the engine
behind the AI features in M9: `packages/ai` gives it a prompt and a JSON
schema, and gets back JSON that is guaranteed to parse and validate.

```
GGUF bytes ──► gguf.ts ──► model.ts (CPU) / webgpu.ts (GPU) ──► logits
                  │                                            │
                  └──► tokenizer.ts           grammar.ts ──► mask ──► sample.ts ──► token
                                                    ▲
manager.ts: hardware → tier → OPFS cache ──► bytes  │  runtime.ts (Kiln): prompt → tokens → JSON
```

## Files

| File | What it does |
| --- | --- |
| `gguf.ts` | GGUF v2/v3 reader: header, metadata, tensor infos. Tensors are `Uint8Array` views into your buffer (zero copy). f16/bf16 helpers. |
| `gguf-writer.ts` | Small GGUF v3 writer, used by tests and the bench to build models in memory. |
| `quant.ts` | Dequantisation, quantisers, and `matVec`, which multiplies straight from the quantised blocks. |
| `tokenizer.ts` | BPE from GGUF metadata: GPT-2 byte-level (`gpt2`) and SentencePiece (`llama`) vocabularies, special tokens, byte fallback. |
| `model.ts` | Llama-style decoder forward pass on the CPU, KV cache, the `Backend` interface. |
| `webgpu.ts` | WebGPU backend: weight repacking + WGSL kernels (mat-vec, RMSNorm, RoPE, attention, SwiGLU). |
| `sample.ts` | Greedy / temperature / top-k / top-p / repeat penalty, seeded RNG. |
| `grammar.ts` | JSON-schema → byte-level pushdown automaton → token masks. |
| `runtime.ts` | `Kiln`: ties it together, reuses the KV cache across calls, implements `propose()`. |
| `manager.ts`, `sha256.ts` | Hardware detection, model tiers, OPFS cache, resumable downloads, SHA-256. |

## Supported formats

**Architectures** (`general.architecture`): `llama` (Llama 2/3, SmolLM, TinyLlama),
`mistral`, `qwen2`. Grouped-query attention, partial
rotary (`rope.dimension_count`), optional q/k/v biases (Qwen2), tied output
embeddings. RoPE pairing is "normal" (adjacent pairs) for llama/mistral and
NeoX (first half with second half) for qwen2. Qwen3 (q/k norms), sliding
windows, MoE, RoPE scaling (`rope.scaling.*`, e.g. Llama 3.1+ long context)
are **not** implemented.

**Tensor types:**

| Type | Status | Notes |
| --- | --- | --- |
| F32, F16, BF16 | supported | |
| Q8_0 | supported | fused mat-vec on blocks |
| Q4_0 | supported | fused mat-vec on blocks |
| Q4_K | supported | fused mat-vec on blocks |
| Q6_K | supported | mat-vec dequantises a row at a time (CPU); exact int8 repack on GPU. Q4_K_M files use it for `output` / some `ffn_down`. |
| Q4_1, Q5_0, Q5_1, Q8_1, Q2_K, Q3_K, Q5_K, Q8_K, IQ*, I8..I64, F64 | **not supported** | the reader parses their block sizes, so the file opens; using such a tensor throws a clear "type X is not supported" error. |

So a **Q4_K_M** or **Q4_0 / Q8_0** GGUF of a supported architecture loads; a
Q5_K_M or IQ-quant file does not (yet).

**Tokenizers:** `tokenizer.ggml.model` = `gpt2` (byte-level BPE with
`merges`; pre-tokenizer regex chosen by `tokenizer.ggml.pre`: GPT-2's,
Llama-3's (`llama-bpe`, `llama3`, ...) or Qwen2's; unknown names fall back to
GPT-2's) or `llama` (SentencePiece BPE by score, `▁` for spaces, `<0xXX>`
byte fallback, `add_space_prefix`). Control and user-defined tokens are
matched literally in the prompt (`<|im_start|>` etc.) unless
`{ special: false }`. Unigram (`t5`) and WordPiece (`bert`) vocabularies are
not supported.

## CPU forward pass

`CpuBackend.forward(token)` runs one position: embedding row (dequantised on
the fly), then per layer RMSNorm → q/k/v mat-vecs (+bias) → RoPE → write
k/v into the cache → per-head softmax attention over the cache (heads share
kv heads in groups) → output projection + residual → RMSNorm → gate/up →
SiLU(gate)·up → down + residual; final RMSNorm and the output projection.

Weights never get dequantised as a whole. `matVec` reads Q4_0/Q4_K/Q8_0
blocks directly and keeps activations in f32: for Q4_0 the "-8" offset and
for Q4_K the per-sub-block minimum are applied once per block using
precomputed block sums of `x`. The KV cache is f32, `capacity × kvDim` per
layer; `truncate(n)` drops positions past `n`, which the runtime uses to
reuse a shared prompt prefix.

It is single-threaded plain TypeScript. Moving it into a worker (and,
later, WASM SIMD or several workers splitting rows) is the obvious next
step for CPU-only machines.

## WebGPU path

`WebGpuBackend.create()` returns `null` unless `navigator.gpu` gives an
adapter; `Kiln.load()` with `backend: "auto"` then falls back to the CPU.
At load, every matrix is repacked once into one of two formats the shaders
read (both exact for the source types, so the GPU computes the same values
as the CPU path):

- **q4**: per 32 values an f32 scale, an f32 min and 4 u32 of nibbles (Q4_0
  nibble order): `x = scale·q + min`. Q4_0 (`min = -8d`) and Q4_K
  (`scale = d·sc`, `min = -dmin·m`).
- **q8**: per 16 values an f32 scale and 4 u32 of int8: Q8_0 and Q6_K
  (`q6 - 32` fits in an int8, scales are per 16).
- **f32** for F32/F16/BF16 tensors.

Kernels: mat-vec (one 64-thread workgroup per output row, 2-D dispatch for
>65535 rows, optional accumulate for residuals), RMSNorm (one 256-thread
workgroup), RoPE+bias writing K straight into the cache, V copy into the
cache, attention (one workgroup per head: scores, max, exp-sum, weighted V),
SwiGLU. All dispatches for a token go in one compute pass; only the logits
are read back. The embedding row is looked up on the CPU and uploaded.

The repacking and a CPU mirror of the mat-vec shaders (`packedMatVec`) are
unit-tested against `matVec` for every type. **The shaders themselves have
not run in CI** (Node has no WebGPU); they need a first pass in a real
browser before the GPU path is turned on by default.

## Sampling and grammar-constrained decoding

`sample(logits, opts, rng, mask)` does greedy (`temperature <= 0`, the
default), or temperature + top-k + top-p, with an optional repeat penalty
and a seeded RNG (`makeRng(seed)`) for reproducible runs.

`JsonGrammar` takes the schema subset from `packages/actions/src/schema.ts`
(object / array / string / number / integer / boolean / null / enum /
anyOf, with `required`, `additionalProperties`, `minLength`/`maxLength`,
`minimum`/`maximum`, `minItems`/`maxItems`) and builds a byte-level
pushdown automaton. A state is an immutable set of stacks, one per live
`anyOf` branch, so states are shared freely. Properties:

- Every state it accepts can still be completed to a valid document (number
  bounds are checked against every number the current prefix could still
  become; `,` is refused when no key or item could follow; and so on).
- `completion(state)` returns a short completion; the decoder forces it
  (as single-byte tokens) when the token budget is about to run out, and
  near the budget only admits tokens after which the completion still fits.
  So the output always parses and validates, even from a random model.
- It works on bytes, so byte-level tokens that split a UTF-8 character are
  fine; strings are checked for valid UTF-8 and lengths are counted in
  UTF-16 units like `validate()` does.

`TokenMasker` builds a trie of the vocabulary's token bytes once and walks
it with the grammar state to produce the allowed-token mask, pruning every
prefix the grammar rejects.

Restrictions on what the model may write (all still valid JSON): no
exponents in numbers, at most 15 integer and 6 fraction digits, no `-0`; at
most two spaces/newlines between tokens and none after the value; enum
strings exactly as `JSON.stringify` writes them; object keys without
escapes; no `\u` surrogates. If the schema has `additionalProperties: true`,
unknown keys get any JSON value.

## The interface for packages/ai

```ts
import { Kiln, type ProposalModel } from "@cellforge/kiln";

const bytes = await manager.ensure(spec);              // or any ArrayBuffer of a GGUF
const model: ProposalModel = await Kiln.load(bytes);   // WebGPU if available, else CPU
const json = await model.propose(prompt, actionSchema); // string, JSON.parse-able, validates
```

```ts
interface ProposalModel {
  propose(prompt: string, grammar?: JsonSchema | null): Promise<string>;
}
```

- `grammar` is a `JsonSchema` from `packages/actions` (kiln has a
  structurally identical copy of the type, so there is no package
  dependency). Without a grammar, `propose` generates free text until an
  end-of-generation token.
- `prompt` is raw text: **kiln does not apply chat templates.** The caller
  formats the conversation (e.g. ChatML `<|im_start|>system ...<|im_end|>`
  for Qwen, or Llama 3's header tokens); special tokens in the text are
  recognised.
- `kiln.proposeOptions` sets the defaults (`maxTokens: 256`,
  `temperature: 0`). `kiln.generate(prompt, opts)` gives the full result:
  tokens, finish reason, prefill/decode time, tokens/s, tokens reused from
  the cache, tokens forced by the grammar.
- The KV cache persists between calls and the longest common token prefix
  is reused, so a tool loop that re-sends the same system prompt and
  catalog only pays for the new turn. `kiln.reset()` clears it.
- `kiln.dispose()` frees the GPU buffers (destroys the WebGPU device) right
  away instead of waiting for garbage collection; the app calls it before
  loading another model so two are never held at once.

## Model manager

- `detectHardware(navigator?)`: WebGPU adapter limits (`maxBufferSize`,
  `maxStorageBufferBindingSize`, fallback adapter), `deviceMemory` (Chrome
  caps it at 8), `hardwareConcurrency`, free storage from
  `navigator.storage.estimate()`.
- `TIERS` / `chooseTier(hw)`: tiny (135-360M, CPU ok), small (0.5B, CPU ok),
  medium (1.5B, needs WebGPU and 256 MB storage buffers), large (3B, needs
  WebGPU and 1 GB buffers). `tierFit()` explains why a tier doesn't fit.
  The tier table names candidate models but **ships no URLs or hashes**.
- `ModelManager({ storage, fetch })` with `OpfsStorage` (browser) or
  `MemoryStorage` (tests). `ensure(spec)` returns cached bytes or downloads:
  partial data goes to `<id>.gguf.part` and is committed every 8 MiB, a
  retry sends `Range: bytes=<have>-` (206 appends; 200 means the server
  ignored the range and it starts over; 416 means the part is complete),
  then the file is hashed with an incremental SHA-256 and renamed into
  place, or deleted with an `IntegrityError`. `load(spec)` never touches the
  network, so a cached model works offline.
- Nothing is downloaded unless `ensure()` is called with a spec that has a
  `url`.
- The app's catalog of downloadable models (pinned Hugging Face URLs,
  exact sizes and SHA-256s, each checked to use only tensor types kiln runs)
  lives in `apps/web/src/aimodels.ts`; `apps/web/src/localmodel.ts` drives
  `ModelManager.download()` from the AI panel's Download button.

## Tests and benchmark

`npx vitest run packages/kiln` (91 tests): hand-computed blocks for every
supported type, quantiser round trips, fused mat-vec and GPU repacking vs
dequantised dot products, GGUF round trips (v2/v3, alignment, zero copy,
errors), tokenizer round trips (both styles, Unicode, specials, byte
fallback), the CPU forward pass vs a plain float64 reference (whole
sequence, no cache, RoPE as complex multiplication) for F32/F16/Q8_0/Q4_0,
Q4_K+Q6_K, tied embeddings, MQA and Qwen2, random walks through the grammar
automaton for 8 schemas (every reachable state completes to a document that
`validate()` accepts), 50 sampled generations from a random model that all
validate, the download manager against a fake server with dropped
connections, and SHA-256 vs `node:crypto`.

`npm run bench:kiln` builds tiny random models and reports CPU tokens/s.
On an i5-10300H (Node 26, one thread):

| model | weights | free tok/s | prefill tok/s | JSON tok/s |
| --- | --- | --- | --- | --- |
| 2 layers, dim 64, 4/2 heads, vocab 300 | F32 | ~2000 | ~3300 | ~1600 |
| | Q8_0 | ~1600 | ~3300 | ~1900 |
| | Q4_0 | ~1900 | ~3500 | ~1900 |
| 4 layers, dim 256, 8/2 heads, ffn 768 | F32 | ~180 | ~200 | ~190 |
| | Q8_0 | ~170 | ~190 | ~180 |
| | Q4_0 | ~210 | ~250 | ~230 |
| | Q4_K | ~190 | ~220 | ~210 |

The second model is ~3M multiply-adds per token, which puts the CPU path
at roughly 0.6 GMAC/s. A 0.5B model needs ~0.5 GMAC per token, so on the
CPU path expect on the order of 1 token/s: fine for tests and tiny models,
too slow for 0.5B+ without WebGPU or a multi-threaded/WASM-SIMD CPU path.

## Checking the WebGPU kernels in a browser

Open `/kilncheck.html` on the dev server (`npm run dev`). It builds tiny random
models (F32, Q8_0, Q4_0 with Q8_0 embeddings, Q4_K qwen2, Q6_K with tied
embeddings, and a larger Q4_0), runs the same tokens through the CPU and
WebGPU backends, and reports the largest logit difference, how often the top
token agrees, and whether greedy decoding matches.

Result on 2026-11-16 (Brave 1.x, Windows, integrated GPU): every model within
2e-5 of the CPU relative to the logits' range, top token agreed 41/41 steps,
greedy output identical. On these tiny models the GPU is slower than the CPU
(about 300 tokens/s against thousands) because each step is dominated by
dispatch overhead; it pulls ahead as the model grows (the 512-wide 4-layer
model: 125 vs 67 tokens/s).
