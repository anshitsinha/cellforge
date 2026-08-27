/**
 * BPE tokenizers built from GGUF metadata.
 *
 *   tokenizer.ggml.model      "gpt2" (byte-level BPE with merges) or "llama" (SentencePiece BPE with scores)
 *   tokenizer.ggml.tokens     string[]
 *   tokenizer.ggml.scores     f32[]  (llama)
 *   tokenizer.ggml.merges     string[] "left right", in priority order (gpt2)
 *   tokenizer.ggml.token_type i32[]  1 normal, 2 unknown, 3 control, 4 user defined, 5 unused, 6 byte
 *   tokenizer.ggml.pre        pre-tokenizer name for gpt2 models ("llama-bpe", "qwen2", "default", ...)
 *   tokenizer.ggml.bos_token_id / eos_token_id / unknown_token_id
 *   tokenizer.ggml.add_bos_token, add_space_prefix
 */
import { metaBool, metaNumber, metaString, type GGUFFile } from "./gguf";

export const TOKEN_TYPE = { NORMAL: 1, UNKNOWN: 2, CONTROL: 3, USER_DEFINED: 4, UNUSED: 5, BYTE: 6 } as const;

export interface TokenizerSpec {
  model: "gpt2" | "llama";
  tokens: readonly string[];
  scores?: ArrayLike<number>;
  merges?: readonly string[];
  tokenTypes?: ArrayLike<number>;
  pre?: string;
  bos?: number;
  eos?: number;
  unk?: number;
  /** extra end-of-generation tokens (e.g. <|eot_id|>, <|im_end|>) */
  eog?: number[];
  addBos?: boolean;
  addSpacePrefix?: boolean;
}

export interface EncodeOptions {
  /** prepend BOS (default: the model's add_bos_token, true for llama) */
  addBos?: boolean;
  /** recognise control / user-defined token text such as "<|im_start|>" (default true) */
  special?: boolean;
}

// GPT-2's reversible byte <-> printable-unicode map
function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const out: string[] = new Array(256);
  bs.forEach((b, i) => (out[b] = String.fromCodePoint(cs[i]!)));
  return out;
}
const BYTE_TO_UNI = bytesToUnicode();
/** GPT-2's printable stand-in character for each byte 0..255 */
export const GPT2_BYTE_CHARS: readonly string[] = BYTE_TO_UNI;
const UNI_TO_BYTE = new Map(BYTE_TO_UNI.map((c, b) => [c, b]));

// Pre-tokenizer regexes. JS has no inline (?i:...) everywhere, so the
// contractions are spelled out case-insensitively.
const CONTRACTIONS_CI = "'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD]";
const PRE_GPT2 = String.raw`'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`;
const PRE_LLAMA3 =
  CONTRACTIONS_CI + String.raw`|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`;
const PRE_QWEN2 =
  CONTRACTIONS_CI + String.raw`|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`;

/** Which regex a gpt2-style vocab uses, by tokenizer.ggml.pre. Unknown names fall back to GPT-2's. */
export function preTokenizerPattern(pre: string | undefined): string {
  switch (pre) {
    case "llama3":
    case "llama-bpe":
    case "llama-v3":
    case "dbrx":
    case "smaug-bpe":
      return PRE_LLAMA3;
    case "qwen2":
    case "deepseek-r1-qwen":
      return PRE_QWEN2;
    default:
      return PRE_GPT2;
  }
}

const utf8 = new TextEncoder();

export class Tokenizer {
  readonly model: "gpt2" | "llama";
  readonly tokens: readonly string[];
  readonly vocabSize: number;
  readonly bos: number | undefined;
  readonly eos: number | undefined;
  readonly unk: number | undefined;
  readonly addBos: boolean;
  readonly addSpacePrefix: boolean;
  /** tokens that end generation */
  readonly eog: ReadonlySet<number>;
  private types: ArrayLike<number> | undefined;
  private scores: ArrayLike<number> | undefined;
  private ids = new Map<string, number>();
  private mergeRank = new Map<string, number>();
  private specials: { text: string; id: number }[] = [];
  private byteTokens = new Int32Array(256).fill(-1);
  private preRe: RegExp | null = null;
  private bytesCache: (Uint8Array | null)[] = [];

  constructor(spec: TokenizerSpec) {
    this.model = spec.model;
    this.tokens = spec.tokens;
    this.vocabSize = spec.tokens.length;
    this.types = spec.tokenTypes;
    this.scores = spec.scores;
    this.bos = spec.bos;
    this.eos = spec.eos;
    this.unk = spec.unk;
    this.addBos = spec.addBos ?? spec.model === "llama";
    this.addSpacePrefix = spec.addSpacePrefix ?? spec.model === "llama";
    for (let i = 0; i < spec.tokens.length; i++) {
      const t = spec.tokens[i]!;
      if (!this.ids.has(t)) this.ids.set(t, i);
      const type = this.type(i);
      if ((type === TOKEN_TYPE.CONTROL || type === TOKEN_TYPE.USER_DEFINED) && t.length > 0) this.specials.push({ text: t, id: i });
    }
    // longest first, so "<|im_start|>" wins over "<|im"
    this.specials.sort((a, b) => b.text.length - a.text.length);
    (spec.merges ?? []).forEach((m, i) => {
      if (!this.mergeRank.has(m)) this.mergeRank.set(m, i);
    });
    if (spec.model === "gpt2") {
      this.preRe = new RegExp(preTokenizerPattern(spec.pre), "gu");
      for (let b = 0; b < 256; b++) this.byteTokens[b] = this.ids.get(BYTE_TO_UNI[b]!) ?? -1;
    } else {
      for (let b = 0; b < 256; b++) {
        const hex = `<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`;
        let id = this.ids.get(hex) ?? -1;
        // plain single-character ASCII pieces are as good as byte tokens
        if (id < 0 && b < 128) id = this.ids.get(b === 32 ? "▁" : String.fromCharCode(b)) ?? -1;
        this.byteTokens[b] = id;
      }
    }
    const eog = new Set<number>(spec.eog ?? []);
    if (spec.eos !== undefined) eog.add(spec.eos);
    for (const name of ["<|eot_id|>", "<|im_end|>", "<|end|>", "<end_of_turn>", "<|endoftext|>", "</s>"]) {
      const id = this.ids.get(name);
      if (id !== undefined && this.type(id) === TOKEN_TYPE.CONTROL) eog.add(id);
    }
    this.eog = eog;
  }

  static fromGGUF(f: GGUFFile): Tokenizer {
    const model = metaString(f, "tokenizer.ggml.model");
    const tokens = f.metadata.get("tokenizer.ggml.tokens");
    if (!Array.isArray(tokens)) throw new Error("GGUF has no tokenizer.ggml.tokens");
    if (model !== "gpt2" && model !== "llama") throw new Error(`tokenizer model "${model}" is not supported (gpt2, llama)`);
    const scores = f.metadata.get("tokenizer.ggml.scores");
    const merges = f.metadata.get("tokenizer.ggml.merges");
    const types = f.metadata.get("tokenizer.ggml.token_type");
    const eot = metaNumber(f, "tokenizer.ggml.eot_token_id");
    return new Tokenizer({
      model,
      tokens: tokens as string[],
      scores: scores instanceof Float32Array ? scores : undefined,
      merges: Array.isArray(merges) ? (merges as string[]) : undefined,
      tokenTypes: types instanceof Int32Array || types instanceof Uint32Array ? types : undefined,
      pre: metaString(f, "tokenizer.ggml.pre"),
      bos: metaNumber(f, "tokenizer.ggml.bos_token_id"),
      eos: metaNumber(f, "tokenizer.ggml.eos_token_id"),
      unk: metaNumber(f, "tokenizer.ggml.unknown_token_id"),
      eog: eot !== undefined ? [eot] : [],
      addBos: metaBool(f, "tokenizer.ggml.add_bos_token"),
      addSpacePrefix: metaBool(f, "tokenizer.ggml.add_space_prefix"),
    });
  }

  type(id: number): number {
    return this.types ? (this.types[id] ?? TOKEN_TYPE.NORMAL) : TOKEN_TYPE.NORMAL;
  }

  tokenId(text: string): number | undefined {
    return this.ids.get(text);
  }

  isSpecial(id: number): boolean {
    const t = this.type(id);
    return t === TOKEN_TYPE.CONTROL || t === TOKEN_TYPE.UNKNOWN || t === TOKEN_TYPE.UNUSED;
  }

  /** A token that encodes exactly the single byte `b`, or -1. */
  byteToken(b: number): number {
    return this.byteTokens[b]!;
  }

  encode(text: string, opts: EncodeOptions = {}): number[] {
    const out: number[] = [];
    if ((opts.addBos ?? this.addBos) && this.bos !== undefined) out.push(this.bos);
    const special = opts.special ?? true;
    let first = true;
    for (const frag of special ? this.splitSpecial(text) : [text]) {
      if (typeof frag === "number") out.push(frag);
      else if (frag.length > 0) {
        if (this.model === "gpt2") this.encodeGpt2(frag, out);
        else this.encodeSpm(frag, first, out);
      }
      first = false;
    }
    return out;
  }

  private splitSpecial(text: string): (string | number)[] {
    if (this.specials.length === 0) return [text];
    const out: (string | number)[] = [];
    let start = 0;
    let i = 0;
    const firsts = new Set(this.specials.map((s) => s.text.charCodeAt(0)));
    outer: while (i < text.length) {
      if (!firsts.has(text.charCodeAt(i))) {
        i++;
        continue;
      }
      for (const s of this.specials) {
        if (text.startsWith(s.text, i)) {
          if (i > start) out.push(text.slice(start, i));
          out.push(s.id);
          i += s.text.length;
          start = i;
          continue outer;
        }
      }
      i++;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
  }

  // ---- gpt2 byte-level BPE ----

  private encodeGpt2(text: string, out: number[]) {
    const re = this.preRe!;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const bytes = utf8.encode(m[0]);
      let word = "";
      for (const b of bytes) word += BYTE_TO_UNI[b];
      for (const piece of this.bpe(word)) {
        const id = this.ids.get(piece);
        if (id !== undefined) out.push(id);
        else for (const ch of piece) out.push(this.byteOrUnk(UNI_TO_BYTE.get(ch) ?? 0));
      }
    }
  }

  private bpe(word: string): string[] {
    let parts = Array.from(word);
    while (parts.length > 1) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < parts.length - 1; i++) {
        const r = this.mergeRank.get(parts[i] + " " + parts[i + 1]);
        if (r !== undefined && r < bestRank) {
          bestRank = r;
          best = i;
        }
      }
      if (best < 0) break;
      const a = parts[best]!, b = parts[best + 1]!;
      const next: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        if (i < parts.length - 1 && parts[i] === a && parts[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(parts[i]!);
      }
      parts = next;
    }
    return parts;
  }

  // ---- SentencePiece BPE (llama.cpp's llm_tokenizer_spm) ----

  private encodeSpm(text: string, first: boolean, out: number[]) {
    let s = text.replace(/ /g, "▁");
    if (first && this.addSpacePrefix) s = "▁" + s;
    const sym = Array.from(s);
    const n = sym.length;
    const prev = new Int32Array(n), next = new Int32Array(n);
    const textOf: string[] = sym.slice();
    for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1 < n ? i + 1 : -1; }
    // max-heap of candidate bigrams by score, ties to the leftmost
    type Bigram = { left: number; right: number; score: number; text: string };
    const heap: Bigram[] = [];
    const less = (a: Bigram, b: Bigram) => a.score < b.score || (a.score === b.score && a.left > b.left);
    const push = (bg: Bigram) => {
      heap.push(bg);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[p]!, heap[i]!)) break;
        [heap[p], heap[i]] = [heap[i]!, heap[p]!];
        i = p;
      }
    };
    const pop = (): Bigram => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && less(heap[m]!, heap[l]!)) m = l;
          if (r < heap.length && less(heap[m]!, heap[r]!)) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i]!, heap[m]!];
          i = m;
        }
      }
      return top;
    };
    const tryAdd = (l: number, r: number) => {
      if (l < 0 || r < 0) return;
      const t = textOf[l]! + textOf[r]!;
      const id = this.ids.get(t);
      if (id === undefined) return;
      push({ left: l, right: r, score: this.scores ? (this.scores[id] ?? 0) : -id, text: t });
    };
    for (let i = 0; i + 1 < n; i++) tryAdd(i, i + 1);
    while (heap.length > 0) {
      const bg = pop();
      // stale if either side changed since this bigram was queued
      if (textOf[bg.left] === "" || textOf[bg.right] === "" || textOf[bg.left]! + textOf[bg.right]! !== bg.text || next[bg.left] !== bg.right) continue;
      textOf[bg.left] = bg.text;
      textOf[bg.right] = "";
      next[bg.left] = next[bg.right]!;
      if (next[bg.right]! >= 0) prev[next[bg.right]!] = bg.left;
      tryAdd(prev[bg.left]!, bg.left);
      tryAdd(bg.left, next[bg.left]!);
    }
    for (let i = 0; i >= 0 && i < n; i = next[i]!) {
      const t = textOf[i]!;
      const id = this.ids.get(t);
      if (id !== undefined) out.push(id);
      else for (const b of utf8.encode(t.replace(/▁/g, " "))) out.push(this.byteOrUnk(b));
    }
  }

  private byteOrUnk(b: number): number {
    const id = this.byteTokens[b]!;
    if (id >= 0) return id;
    if (this.unk !== undefined) return this.unk;
    throw new Error(`tokenizer: no token for byte 0x${b.toString(16)}`);
  }

  // ---- decoding ----

  /** The raw bytes a token stands for; null for control/unknown/unused tokens. */
  tokenBytes(id: number): Uint8Array | null {
    if (id < 0 || id >= this.vocabSize) return null;
    const cached = this.bytesCache[id];
    if (cached !== undefined) return cached;
    let r: Uint8Array | null;
    const t = this.tokens[id]!;
    const type = this.type(id);
    if (type === TOKEN_TYPE.CONTROL || type === TOKEN_TYPE.UNKNOWN || type === TOKEN_TYPE.UNUSED) r = null;
    else if (type === TOKEN_TYPE.USER_DEFINED) r = utf8.encode(t);
    else if (this.model === "gpt2") {
      const bytes: number[] = [];
      for (const ch of t) {
        const b = UNI_TO_BYTE.get(ch);
        if (b === undefined) for (const x of utf8.encode(ch)) bytes.push(x);
        else bytes.push(b);
      }
      r = new Uint8Array(bytes);
    } else {
      const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(t);
      r = type === TOKEN_TYPE.BYTE || m ? new Uint8Array([parseInt(m![1]!, 16)]) : utf8.encode(t.replace(/▁/g, " "));
    }
    this.bytesCache[id] = r;
    return r;
  }

  decodeBytes(ids: readonly number[], opts: { special?: boolean } = {}): Uint8Array {
    const parts: Uint8Array[] = [];
    let len = 0;
    for (const id of ids) {
      let b = this.tokenBytes(id);
      if (!b && opts.special && id >= 0 && id < this.vocabSize) b = utf8.encode(this.tokens[id]!);
      if (b) {
        parts.push(b);
        len += b.length;
      }
    }
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /**
   * Token ids -> text. Control tokens are dropped unless `special`. For
   * SentencePiece vocabularies the space added in front of the first piece
   * is removed again (pass `stripLeadingSpace: false` when decoding a
   * continuation).
   */
  decode(ids: readonly number[], opts: { special?: boolean; stripLeadingSpace?: boolean } = {}): string {
    let s = new TextDecoder("utf-8").decode(this.decodeBytes(ids, opts));
    const strip = opts.stripLeadingSpace ?? true;
    if (strip && this.model === "llama" && this.addSpacePrefix && s.startsWith(" ")) {
      // only when the first content token carries the prefix
      const firstContent = ids.find((id) => !(id === this.bos));
      if (firstContent !== undefined && this.tokens[firstContent]?.startsWith("▁")) s = s.slice(1);
    }
    return s;
  }
}
