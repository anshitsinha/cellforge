// Test helpers: a tiny trained-on-the-spot BPE vocabulary and a tiny
// random llama-style model, written to an in-memory GGUF buffer.
import { GGML, type GGMLType } from "../src/gguf";
import { gv, writeGGUF, type GGUFWriteTensor, type GGUFWriteValue } from "../src/gguf-writer";
import { dequantize, quantize } from "../src/quant";
import { makeRng } from "../src/sample";
import { GPT2_BYTE_CHARS, TOKEN_TYPE, preTokenizerPattern } from "../src/tokenizer";

export const CORPUS = [
  'The quick brown fox jumps over the lazy dog. {"type": "rows.sort", "params": {"col": 3, "descending": true}}',
  '{"name": "Total", "value": 12.5, "ok": false, "tags": ["a", "b"], "note": null}',
  "Sort the sheet by amount, then filter rows where the region is North. Sum the column and format it as currency.",
  '[{"row": 1, "col": 2}, {"row": 10, "col": 20}] true false null 0 1 2 3 4 5 6 7 8 9',
];

/** Train byte-level BPE merges on CORPUS until the vocab has `size` regular tokens. */
export function trainGpt2Vocab(size: number): { tokens: string[]; merges: string[] } {
  const tokens = [...GPT2_BYTE_CHARS];
  const merges: string[] = [];
  const re = new RegExp(preTokenizerPattern(undefined), "gu");
  const enc = new TextEncoder();
  let words: string[][] = [];
  for (const line of CORPUS)
    for (const m of line.matchAll(re)) words.push(Array.from(enc.encode(m[0]), (b) => GPT2_BYTE_CHARS[b]!));
  const have = new Set(tokens);
  while (tokens.length < size) {
    const counts = new Map<string, number>();
    for (const w of words) for (let i = 0; i + 1 < w.length; i++) {
      const k = w[i] + " " + w[i + 1];
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let best = "";
    let bc = 0;
    for (const [k, c] of counts) if (c > bc || (c === bc && k < best)) { best = k; bc = c; }
    if (!best) break;
    const [a, b] = best.split(" ") as [string, string];
    merges.push(best);
    if (!have.has(a + b)) { tokens.push(a + b); have.add(a + b); }
    words = words.map((w) => {
      const out: string[] = [];
      for (let i = 0; i < w.length; i++) {
        if (i + 1 < w.length && w[i] === a && w[i + 1] === b) { out.push(a + b); i++; }
        else out.push(w[i]!);
      }
      return out;
    });
  }
  return { tokens, merges };
}

export const SPECIALS = ["<|endoftext|>", "<|im_start|>", "<|im_end|>"];

export interface TinyOptions {
  dim?: number;
  nLayers?: number;
  nHeads?: number;
  nKvHeads?: number;
  ffnDim?: number;
  vocab?: number;
  /** storage type for the big matrices */
  type?: GGMLType;
  /** storage type for the embedding / output matrices (default: type) */
  embdType?: GGMLType;
  arch?: "llama" | "qwen2";
  tied?: boolean;
  seed?: number;
  contextLength?: number;
  /** multiply weights by this (bigger = peakier logits) */
  scale?: number;
}

export interface TinyModel {
  bytes: Uint8Array;
  /** the weights as stored (dequantised), for the reference implementation */
  floats: Map<string, Float32Array>;
  cfg: Required<Omit<TinyOptions, "type" | "embdType" | "seed" | "scale" | "tied">> & { tied: boolean; normEps: number; ropeBase: number; headDim: number };
}

export function buildTinyModel(o: TinyOptions = {}): TinyModel {
  const dim = o.dim ?? 64, nLayers = o.nLayers ?? 2, nHeads = o.nHeads ?? 4, nKvHeads = o.nKvHeads ?? 2;
  const ffnDim = o.ffnDim ?? 2 * dim, vocab = o.vocab ?? 300, arch = o.arch ?? "llama";
  const type = o.type ?? GGML.F32;
  const embdType = o.embdType ?? type;
  const tied = o.tied ?? false;
  const contextLength = o.contextLength ?? 512;
  const headDim = dim / nHeads;
  const rng = makeRng(o.seed ?? 42);
  const scale = o.scale ?? 1;
  const randn = () => {
    const u = Math.max(rng(), 1e-12), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const { tokens, merges } = trainGpt2Vocab(vocab - SPECIALS.length);
  const allTokens = [...tokens, ...SPECIALS];
  const types = allTokens.map((_, i) => (i >= tokens.length ? TOKEN_TYPE.CONTROL : TOKEN_TYPE.NORMAL));

  const tensors: GGUFWriteTensor[] = [];
  const floats = new Map<string, Float32Array>();
  const add = (name: string, rows: number, cols: number, t: GGMLType, gen: () => number) => {
    const w = new Float32Array(rows * cols);
    for (let i = 0; i < w.length; i++) w[i] = gen();
    const data = quantize(t, w);
    floats.set(name, dequantize(t, data, w.length));
    tensors.push({ name, dims: rows === 1 ? [cols] : [cols, rows], type: t, data });
  };
  const mat = (std: number) => () => randn() * std * scale;
  const norm = () => 1 + 0.1 * randn();
  const qDim = nHeads * headDim, kvDim = nKvHeads * headDim;
  add("token_embd.weight", vocab, dim, embdType, mat(1));
  for (let l = 0; l < nLayers; l++) {
    const p = `blk.${l}.`;
    add(p + "attn_norm.weight", 1, dim, GGML.F32, norm);
    add(p + "attn_q.weight", qDim, dim, type, mat(1 / Math.sqrt(dim)));
    add(p + "attn_k.weight", kvDim, dim, type, mat(1 / Math.sqrt(dim)));
    add(p + "attn_v.weight", kvDim, dim, type, mat(1 / Math.sqrt(dim)));
    if (arch === "qwen2") {
      add(p + "attn_q.bias", 1, qDim, GGML.F32, mat(0.1));
      add(p + "attn_k.bias", 1, kvDim, GGML.F32, mat(0.1));
      add(p + "attn_v.bias", 1, kvDim, GGML.F32, mat(0.1));
    }
    add(p + "attn_output.weight", dim, qDim, type, mat(1 / Math.sqrt(qDim)));
    add(p + "ffn_norm.weight", 1, dim, GGML.F32, norm);
    add(p + "ffn_gate.weight", ffnDim, dim, type, mat(1 / Math.sqrt(dim)));
    add(p + "ffn_up.weight", ffnDim, dim, type, mat(1 / Math.sqrt(dim)));
    add(p + "ffn_down.weight", dim, ffnDim, type, mat(1 / Math.sqrt(ffnDim)));
  }
  add("output_norm.weight", 1, dim, GGML.F32, norm);
  if (!tied) add("output.weight", vocab, dim, embdType, mat(1 / Math.sqrt(dim)));

  const meta: Record<string, GGUFWriteValue> = {
    "general.architecture": arch,
    "general.name": "kiln-tiny",
    [`${arch}.context_length`]: contextLength,
    [`${arch}.embedding_length`]: dim,
    [`${arch}.block_count`]: nLayers,
    [`${arch}.feed_forward_length`]: ffnDim,
    [`${arch}.attention.head_count`]: nHeads,
    [`${arch}.attention.head_count_kv`]: nKvHeads,
    [`${arch}.attention.layer_norm_rms_epsilon`]: gv.f32(1e-5),
    [`${arch}.rope.freq_base`]: gv.f32(10000),
    "tokenizer.ggml.model": "gpt2",
    "tokenizer.ggml.pre": "default",
    "tokenizer.ggml.tokens": gv.strings(allTokens),
    "tokenizer.ggml.token_type": gv.i32s(types),
    "tokenizer.ggml.merges": gv.strings(merges),
    "tokenizer.ggml.bos_token_id": allTokens.indexOf("<|endoftext|>"),
    "tokenizer.ggml.eos_token_id": allTokens.indexOf("<|im_end|>"),
    "tokenizer.ggml.add_bos_token": false,
  };
  return {
    bytes: writeGGUF(meta, tensors),
    floats,
    cfg: { dim, nLayers, nHeads, nKvHeads, ffnDim, vocab, arch, tied, contextLength, normEps: 1e-5, ropeBase: 10000, headDim },
  };
}
