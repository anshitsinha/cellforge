import { describe, expect, it } from "vitest";
import { parseGGUF } from "../src/gguf";
import { gv, writeGGUF } from "../src/gguf-writer";
import { GPT2_BYTE_CHARS, TOKEN_TYPE, Tokenizer } from "../src/tokenizer";
import { SPECIALS, buildTinyModel, trainGpt2Vocab } from "./tiny";

const SAMPLES = [
  "",
  "hello world",
  "The quick brown fox jumps over the lazy dog.",
  '{"type": "rows.sort", "params": {"col": 3}}',
  "  leading and trailing spaces  ",
  "tabs\tand\nnewlines\r\n\n",
  "naïve café — 東京 🙂👍🏽 ﷽",
  "numbers 1234567 3.14159 -0.5e10",
  "it's we're they'll I'd",
  "\u0000\u0001 control \u007f",
];

describe("gpt2 byte-level BPE", () => {
  const G = "Ġ"; // GPT-2's stand-in for a space
  const base = [...GPT2_BYTE_CHARS];
  const tk = new Tokenizer({
    model: "gpt2",
    tokens: [...base, G + "t", "he", G + "the", "<|endoftext|>", "<|im_start|>"],
    merges: [`${G} t`, "h e", `${G}t he`],
    tokenTypes: [...base.map(() => TOKEN_TYPE.NORMAL), 1, 1, 1, TOKEN_TYPE.CONTROL, TOKEN_TYPE.CONTROL],
    bos: 259,
    eos: 259,
  });
  const id = (s: string) => tk.tokenId(s)!;

  it("applies merges in rank order within each pre-token", () => {
    // "the" -> t + he (no "t he" merge); " the" -> Ġt + he -> Ġthe
    expect(tk.encode("the the")).toEqual([id("t"), id("he"), id(G + "the")]);
  });

  it("splits out special tokens, and can ignore them", () => {
    expect(tk.encode("<|im_start|>the")).toEqual([id("<|im_start|>"), id("t"), id("he")]);
    expect(tk.encode("<|im_start|>", { special: false })).not.toContain(id("<|im_start|>"));
    expect(tk.decode(tk.encode("<|im_start|>x"))).toBe("x");
    expect(tk.decode(tk.encode("<|im_start|>x"), { special: true })).toBe("<|im_start|>x");
  });

  it("round-trips arbitrary text through bytes", () => {
    for (const s of SAMPLES) expect(tk.decode(tk.encode(s, { special: false }))).toBe(s);
  });

  it("has a single-byte token for every byte", () => {
    for (let b = 0; b < 256; b++) expect(Array.from(tk.tokenBytes(tk.byteToken(b))!)).toEqual([b]);
  });
});

describe("gpt2 vocab from GGUF metadata (trained merges)", () => {
  const tk = Tokenizer.fromGGUF(parseGGUF(buildTinyModel({ dim: 32, nLayers: 1, nHeads: 2, nKvHeads: 1 }).bytes));
  it("loads tokens, merges, types and special ids", () => {
    expect(tk.model).toBe("gpt2");
    expect(tk.vocabSize).toBe(300);
    expect(tk.eos).toBe(tk.tokenId("<|im_end|>"));
    expect(tk.eog.has(tk.tokenId("<|endoftext|>")!)).toBe(true);
    expect(tk.addBos).toBe(false);
  });
  it("compresses text it was trained on and round-trips everything", () => {
    const s = '{"type": "rows.sort", "params": {"col": 3, "descending": true}}';
    expect(tk.encode(s).length).toBeLessThan(new TextEncoder().encode(s).length * 0.7);
    for (const x of SAMPLES) expect(tk.decode(tk.encode(x, { special: false }))).toBe(x);
    expect(tk.decode(tk.encode(SPECIALS[1] + "hi" + SPECIALS[2]), { special: true })).toBe("<|im_start|>hi<|im_end|>");
  });
  it("trains deterministically", () => {
    expect(trainGpt2Vocab(280)).toEqual(trainGpt2Vocab(280));
  });
});

describe("SentencePiece BPE (llama)", () => {
  const bytes = Array.from({ length: 256 }, (_, b) => `<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`);
  const pieces: [string, number][] = [
    ["▁t", -1],
    ["he", -2],
    ["▁the", -0.5],
    ["at", -3],
    ["▁", -4],
    ["a", -5],
    ["t", -5],
    ["h", -5],
    ["e", -5],
    ["▁▁", -6],
  ];
  const tokens = ["<unk>", "<s>", "</s>", ...bytes, ...pieces.map((p) => p[0])];
  const scores = [0, 0, 0, ...bytes.map(() => 0), ...pieces.map((p) => p[1])];
  const types = [TOKEN_TYPE.UNKNOWN, TOKEN_TYPE.CONTROL, TOKEN_TYPE.CONTROL, ...bytes.map(() => TOKEN_TYPE.BYTE), ...pieces.map(() => TOKEN_TYPE.NORMAL)];
  const gguf = writeGGUF(
    {
      "tokenizer.ggml.model": "llama",
      "tokenizer.ggml.tokens": gv.strings(tokens),
      "tokenizer.ggml.scores": gv.f32s(scores),
      "tokenizer.ggml.token_type": gv.i32s(types),
      "tokenizer.ggml.bos_token_id": 1,
      "tokenizer.ggml.eos_token_id": 2,
      "tokenizer.ggml.unknown_token_id": 0,
    },
    [],
  );
  const tk = Tokenizer.fromGGUF(parseGGUF(gguf));
  const id = (s: string) => tk.tokenId(s)!;

  it("merges the highest-scoring pair first and falls back to bytes", () => {
    // "▁the▁cat": ▁t (-1), he (-2), then ▁the (-0.5); "at" (-3); "c" is not a piece -> <0x63>
    expect(tk.encode("the cat")).toEqual([1, id("▁the"), id("▁"), id("<0x63>"), id("at")]);
  });

  it("adds BOS and the space prefix by default", () => {
    expect(tk.addBos).toBe(true);
    expect(tk.encode("a", { addBos: false })).toEqual([id("▁"), id("a")]);
  });

  it("recognises control tokens in text", () => {
    expect(tk.encode("</s>a", { addBos: false })).toEqual([2, id("a")]);
  });

  it("round-trips through byte fallback", () => {
    for (const s of SAMPLES) expect(tk.decode(tk.encode(s, { special: false }))).toBe(s);
    expect(tk.decode(tk.encode(" leading"))).toBe(" leading");
  });

  it("maps every byte to a token", () => {
    for (let b = 0; b < 256; b++) expect(Array.from(tk.tokenBytes(tk.byteToken(b))!)).toEqual([b]);
  });
});
