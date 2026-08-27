/**
 * Llama-style decoder: token embedding -> N x (RMSNorm, attention with RoPE
 * and grouped-query heads, residual, RMSNorm, SwiGLU MLP, residual) ->
 * RMSNorm -> output projection.
 *
 * Covers the GGUF architectures "llama" (Llama 2/3, SmolLM, TinyLlama,
 * Mistral-style), "mistral" and "qwen2" (adds q/k/v biases, NeoX RoPE).
 * Weights stay in their quantised GGUF blocks; matVec reads them directly.
 */
import { metaNumber, metaString, typeName, type GGUFFile, type GGUFTensor } from "./gguf";
import { isSupportedType, makeQMatrix, matRow, matVec, type QMatrix } from "./quant";

export interface ModelConfig {
  arch: string;
  dim: number;
  nLayers: number;
  nHeads: number;
  nKvHeads: number;
  headDim: number;
  /** dimensions rotated by RoPE (<= headDim) */
  nRot: number;
  ffnDim: number;
  vocabSize: number;
  contextLength: number;
  normEps: number;
  ropeBase: number;
  /** "norm": adjacent pairs (llama); "neox": first half with second half (qwen2) */
  ropeStyle: "norm" | "neox";
}

export interface LayerWeights {
  attnNorm: Float32Array;
  wq: QMatrix;
  wk: QMatrix;
  wv: QMatrix;
  wo: QMatrix;
  bq?: Float32Array;
  bk?: Float32Array;
  bv?: Float32Array;
  ffnNorm: Float32Array;
  wGate: QMatrix;
  wUp: QMatrix;
  wDown: QMatrix;
}

export interface ModelWeights {
  tokenEmbd: QMatrix;
  layers: LayerWeights[];
  outputNorm: Float32Array;
  /** tied to tokenEmbd when the file has no output.weight */
  output: QMatrix;
}

const NEOX_ARCHS = new Set(["qwen2", "qwen2moe", "qwen3", "phi2", "phi3", "gptneox", "stablelm", "olmo2", "gemma", "gemma2"]);
const SUPPORTED_ARCHS = new Set(["llama", "mistral", "qwen2"]);

export function readConfig(f: GGUFFile): ModelConfig {
  const arch = metaString(f, "general.architecture") ?? "llama";
  if (!SUPPORTED_ARCHS.has(arch)) throw new Error(`kiln: architecture "${arch}" is not supported (llama, mistral, qwen2)`);
  const k = (name: string) => `${arch}.${name}`;
  const req = (name: string) => {
    const v = metaNumber(f, k(name));
    if (v === undefined) throw new Error(`kiln: GGUF is missing ${k(name)}`);
    return v;
  };
  const dim = req("embedding_length");
  const nHeads = req("attention.head_count");
  const nKvHeads = metaNumber(f, k("attention.head_count_kv"), nHeads);
  const headDim = metaNumber(f, k("attention.key_length"), dim / nHeads);
  const tokens = f.metadata.get("tokenizer.ggml.tokens");
  const embd = f.tensor("token_embd.weight");
  const vocabSize = metaNumber(f, k("vocab_size")) ?? (Array.isArray(tokens) ? tokens.length : (embd?.dims[1] ?? 0));
  return {
    arch,
    dim,
    nLayers: req("block_count"),
    nHeads,
    nKvHeads,
    headDim,
    nRot: metaNumber(f, k("rope.dimension_count"), headDim),
    ffnDim: req("feed_forward_length"),
    vocabSize,
    contextLength: metaNumber(f, k("context_length"), 2048),
    normEps: metaNumber(f, k("attention.layer_norm_rms_epsilon"), 1e-5),
    ropeBase: metaNumber(f, k("rope.freq_base"), 10000),
    ropeStyle: NEOX_ARCHS.has(arch) ? "neox" : "norm",
  };
}

function tensor(f: GGUFFile, name: string): GGUFTensor {
  const t = f.tensor(name);
  if (!t) throw new Error(`kiln: GGUF is missing tensor ${name}`);
  if (!isSupportedType(t.type)) throw new Error(`kiln: tensor ${name} has unsupported type ${typeName(t.type)}`);
  return t;
}

function matrix(f: GGUFFile, name: string, rows: number, cols: number): QMatrix {
  const t = tensor(f, name);
  if (t.dims[0] !== cols || (t.dims[1] ?? 1) !== rows) throw new Error(`kiln: ${name} has dims [${t.dims}], expected [${cols}, ${rows}]`);
  return makeQMatrix(t.type, rows, cols, t.data);
}

function vector(f: GGUFFile, name: string, n: number): Float32Array {
  const t = tensor(f, name);
  if (t.nElements !== n) throw new Error(`kiln: ${name} has ${t.nElements} values, expected ${n}`);
  return matRow(makeQMatrix(t.type, 1, n, t.data), 0);
}

function optVector(f: GGUFFile, name: string, n: number): Float32Array | undefined {
  return f.tensor(name) ? vector(f, name, n) : undefined;
}

export function loadWeights(f: GGUFFile, c: ModelConfig): ModelWeights {
  const qDim = c.nHeads * c.headDim;
  const kvDim = c.nKvHeads * c.headDim;
  const layers: LayerWeights[] = [];
  for (let i = 0; i < c.nLayers; i++) {
    const p = `blk.${i}.`;
    layers.push({
      attnNorm: vector(f, p + "attn_norm.weight", c.dim),
      wq: matrix(f, p + "attn_q.weight", qDim, c.dim),
      wk: matrix(f, p + "attn_k.weight", kvDim, c.dim),
      wv: matrix(f, p + "attn_v.weight", kvDim, c.dim),
      wo: matrix(f, p + "attn_output.weight", c.dim, qDim),
      bq: optVector(f, p + "attn_q.bias", qDim),
      bk: optVector(f, p + "attn_k.bias", kvDim),
      bv: optVector(f, p + "attn_v.bias", kvDim),
      ffnNorm: vector(f, p + "ffn_norm.weight", c.dim),
      wGate: matrix(f, p + "ffn_gate.weight", c.ffnDim, c.dim),
      wUp: matrix(f, p + "ffn_up.weight", c.ffnDim, c.dim),
      wDown: matrix(f, p + "ffn_down.weight", c.dim, c.ffnDim),
    });
  }
  const tokenEmbd = matrix(f, "token_embd.weight", c.vocabSize, c.dim);
  return {
    tokenEmbd,
    layers,
    outputNorm: vector(f, "output_norm.weight", c.dim),
    output: f.tensor("output.weight") ? matrix(f, "output.weight", c.vocabSize, c.dim) : tokenEmbd,
  };
}

/** Keys and values for every layer, positions [0, length). */
export class KVCache {
  readonly k: Float32Array[];
  readonly v: Float32Array[];
  length = 0;
  constructor(
    readonly nLayers: number,
    readonly capacity: number,
    readonly kvDim: number,
  ) {
    this.k = Array.from({ length: nLayers }, () => new Float32Array(capacity * kvDim));
    this.v = Array.from({ length: nLayers }, () => new Float32Array(capacity * kvDim));
  }
  /** Forget positions >= n (keeps a shared prompt prefix). */
  truncate(n: number) {
    this.length = Math.min(this.length, n);
  }
}

/** Something that turns (token, position) into next-token logits, keeping its own cache. */
export interface Backend {
  readonly name: "cpu" | "webgpu";
  readonly config: ModelConfig;
  /** KV cache size in tokens */
  readonly capacity: number;
  /** tokens currently held in the KV cache */
  readonly cached: number;
  /** drop cached positions >= n */
  truncate(n: number): void;
  /** run one token at position `cached`; returns the logits (valid until the next call) */
  forward(token: number): Float32Array | Promise<Float32Array>;
}

export function rmsNorm(out: Float32Array, x: Float32Array, w: Float32Array, eps: number) {
  let ss = 0;
  for (let i = 0; i < x.length; i++) ss += x[i]! * x[i]!;
  const s = 1 / Math.sqrt(ss / x.length + eps);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! * s * w[i]!;
}

/** Inverse frequencies for RoPE: base^(-2i/nRot). */
export function ropeFreqs(c: ModelConfig): Float32Array {
  const f = new Float32Array(c.nRot / 2);
  for (let i = 0; i < f.length; i++) f[i] = Math.pow(c.ropeBase, (-2 * i) / c.nRot);
  return f;
}

/** Rotate each head of `v` (nHeads x headDim) in place for position `pos`. */
export function applyRope(v: Float32Array, nHeads: number, c: ModelConfig, freqs: Float32Array, pos: number) {
  const half = c.nRot / 2;
  for (let i = 0; i < half; i++) {
    const a = pos * freqs[i]!;
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let h = 0; h < nHeads; h++) {
      const o = h * c.headDim;
      const i0 = c.ropeStyle === "norm" ? o + 2 * i : o + i;
      const i1 = c.ropeStyle === "norm" ? i0 + 1 : o + i + half;
      const x0 = v[i0]!, x1 = v[i1]!;
      v[i0] = x0 * cos - x1 * sin;
      v[i1] = x0 * sin + x1 * cos;
    }
  }
}

/** The CPU forward pass. */
export class CpuBackend implements Backend {
  readonly name = "cpu" as const;
  readonly cache: KVCache;
  private freqs: Float32Array;
  private x: Float32Array;
  private xb: Float32Array;
  private q: Float32Array;
  private k: Float32Array;
  private v: Float32Array;
  private att: Float32Array;
  private scores: Float32Array;
  private hb: Float32Array;
  private hb2: Float32Array;
  private logits: Float32Array;

  constructor(
    readonly config: ModelConfig,
    readonly weights: ModelWeights,
    contextLength = config.contextLength,
  ) {
    const c = config;
    const qDim = c.nHeads * c.headDim;
    const kvDim = c.nKvHeads * c.headDim;
    this.cache = new KVCache(c.nLayers, contextLength, kvDim);
    this.freqs = ropeFreqs(c);
    this.x = new Float32Array(c.dim);
    this.xb = new Float32Array(Math.max(c.dim, qDim));
    this.q = new Float32Array(qDim);
    this.k = new Float32Array(kvDim);
    this.v = new Float32Array(kvDim);
    this.att = new Float32Array(qDim);
    this.scores = new Float32Array(contextLength);
    this.hb = new Float32Array(c.ffnDim);
    this.hb2 = new Float32Array(c.ffnDim);
    this.logits = new Float32Array(c.vocabSize);
  }

  get cached() {
    return this.cache.length;
  }

  get capacity() {
    return this.cache.capacity;
  }

  truncate(n: number) {
    this.cache.truncate(n);
  }

  forward(token: number): Float32Array {
    const c = this.config;
    const W = this.weights;
    const pos = this.cache.length;
    if (pos >= this.cache.capacity) throw new Error(`kiln: context full (${this.cache.capacity} tokens)`);
    if (token < 0 || token >= c.vocabSize) throw new Error(`kiln: token ${token} out of range`);
    const { x, xb, q, k, v, att, scores, hb, hb2 } = this;
    const hd = c.headDim;
    const kvDim = c.nKvHeads * hd;
    const qDim = c.nHeads * hd;
    const group = c.nHeads / c.nKvHeads;
    const scale = 1 / Math.sqrt(hd);
    matRow(W.tokenEmbd, token, x);

    for (let l = 0; l < c.nLayers; l++) {
      const L = W.layers[l]!;
      // attention
      rmsNorm(xb, x, L.attnNorm, c.normEps);
      matVec(L.wq, xb, q);
      matVec(L.wk, xb, k);
      matVec(L.wv, xb, v);
      if (L.bq) for (let i = 0; i < qDim; i++) q[i] = q[i]! + L.bq[i]!;
      if (L.bk) for (let i = 0; i < kvDim; i++) k[i] = k[i]! + L.bk[i]!;
      if (L.bv) for (let i = 0; i < kvDim; i++) v[i] = v[i]! + L.bv[i]!;
      applyRope(q, c.nHeads, c, this.freqs, pos);
      applyRope(k, c.nKvHeads, c, this.freqs, pos);
      const K = this.cache.k[l]!, V = this.cache.v[l]!;
      K.set(k, pos * kvDim);
      V.set(v, pos * kvDim);
      for (let h = 0; h < c.nHeads; h++) {
        const qo = h * hd;
        const ko = Math.floor(h / group) * hd;
        let max = -Infinity;
        for (let t = 0; t <= pos; t++) {
          const kt = t * kvDim + ko;
          let s = 0;
          for (let i = 0; i < hd; i++) s += q[qo + i]! * K[kt + i]!;
          s *= scale;
          scores[t] = s;
          if (s > max) max = s;
        }
        let sum = 0;
        for (let t = 0; t <= pos; t++) {
          const e = Math.exp(scores[t]! - max);
          scores[t] = e;
          sum += e;
        }
        att.fill(0, qo, qo + hd);
        for (let t = 0; t <= pos; t++) {
          const a = scores[t]! / sum;
          const vt = t * kvDim + ko;
          for (let i = 0; i < hd; i++) att[qo + i] = att[qo + i]! + a * V[vt + i]!;
        }
      }
      matVec(L.wo, att, xb);
      for (let i = 0; i < c.dim; i++) x[i] = x[i]! + xb[i]!;

      // SwiGLU MLP
      rmsNorm(xb, x, L.ffnNorm, c.normEps);
      matVec(L.wGate, xb.subarray(0, c.dim), hb);
      matVec(L.wUp, xb.subarray(0, c.dim), hb2);
      for (let i = 0; i < c.ffnDim; i++) {
        const g = hb[i]!;
        hb[i] = (g / (1 + Math.exp(-g))) * hb2[i]!;
      }
      matVec(L.wDown, hb, xb);
      for (let i = 0; i < c.dim; i++) x[i] = x[i]! + xb[i]!;
    }
    rmsNorm(x, x, W.outputNorm, c.normEps);
    matVec(W.output, x, this.logits);
    this.cache.length = pos + 1;
    return this.logits;
  }
}

/** A parsed model: config + weights, ready to make backends. */
export class Model {
  constructor(
    readonly config: ModelConfig,
    readonly weights: ModelWeights,
  ) {}

  static fromGGUF(f: GGUFFile): Model {
    const config = readConfig(f);
    return new Model(config, loadWeights(f, config));
  }

  cpu(contextLength = Math.min(this.config.contextLength, 4096)): CpuBackend {
    return new CpuBackend(this.config, this.weights, contextLength);
  }
}
