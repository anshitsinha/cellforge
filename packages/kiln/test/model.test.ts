import { describe, expect, it } from "vitest";
import { GGML, parseGGUF, type GGMLType } from "../src/gguf";
import { Model, readConfig } from "../src/model";
import { webGpuAvailable } from "../src/webgpu";
import { referenceLogits } from "./reference";
import { buildTinyModel, type TinyOptions } from "./tiny";

function maxRelErr(a: ArrayLike<number>, b: ArrayLike<number>) {
  let num = 0, den = 0;
  for (let i = 0; i < a.length; i++) {
    num = Math.max(num, Math.abs(a[i]! - b[i]!));
    den = Math.max(den, Math.abs(b[i]!));
  }
  return num / den;
}

const TOKENS = [5, 17, 260, 3, 99, 299, 0, 42, 42, 150, 7, 250];

function check(opts: TinyOptions) {
  const tiny = buildTinyModel(opts);
  const model = Model.fromGGUF(parseGGUF(tiny.bytes));
  const cpu = model.cpu(64);
  const ref = referenceLogits(tiny, TOKENS);
  TOKENS.forEach((t, pos) => {
    const logits = cpu.forward(t);
    expect(maxRelErr(logits, ref[pos]!)).toBeLessThan(1e-4);
  });
  return { tiny, model, cpu };
}

describe("CPU forward pass vs a float reference (2 layers, dim 64, 4 heads, 2 kv heads, vocab 300)", () => {
  const types: [string, GGMLType][] = [
    ["F32", GGML.F32],
    ["F16", GGML.F16],
    ["Q8_0", GGML.Q8_0],
    ["Q4_0", GGML.Q4_0],
  ];
  for (const [name, type] of types) it(`${name} weights`, () => void check({ type }));

  it("reads the config from metadata", () => {
    const { model } = check({ type: GGML.F32 });
    expect(model.config).toMatchObject({ arch: "llama", dim: 64, nLayers: 2, nHeads: 4, nKvHeads: 2, headDim: 16, ffnDim: 128, vocabSize: 300, ropeStyle: "norm" });
  });

  it("the comparison is sensitive: the wrong RoPE pairing disagrees", () => {
    const tiny = buildTinyModel({ type: GGML.F32 });
    const cpu = Model.fromGGUF(parseGGUF(tiny.bytes)).cpu(64);
    const wrong = referenceLogits(tiny, TOKENS, "neox");
    const errs = TOKENS.map((t, pos) => maxRelErr(cpu.forward(t), wrong[pos]!));
    expect(errs[0]).toBeLessThan(1e-4); // position 0 is not rotated
    expect(Math.max(...errs)).toBeGreaterThan(1e-2);
  });

  it("tied output embeddings", () => void check({ type: GGML.Q8_0, tied: true }));
  it("multi-query attention (1 kv head)", () => void check({ type: GGML.F32, nKvHeads: 1 }));
  it("qwen2: q/k/v biases and NeoX RoPE", () => {
    const { model } = check({ type: GGML.Q8_0, arch: "qwen2" });
    expect(model.config.ropeStyle).toBe("neox");
  });
});

describe("K-quants need 256-wide rows", () => {
  it("Q4_K matrices with a Q6_K embedding/output (like Q4_K_M files), dim 256", () => {
    check({ type: GGML.Q4_K, embdType: GGML.Q6_K, dim: 256, nHeads: 4, nKvHeads: 2, ffnDim: 512, nLayers: 1 });
  });
});

describe("KV cache", () => {
  it("truncating and re-running gives the same logits as the first time", () => {
    const tiny = buildTinyModel({ type: GGML.Q4_0 });
    const cpu = Model.fromGGUF(parseGGUF(tiny.bytes)).cpu(32);
    const first = TOKENS.map((t) => Float32Array.from(cpu.forward(t)));
    cpu.truncate(5);
    expect(cpu.cached).toBe(5);
    for (let i = 5; i < TOKENS.length; i++) expect(Array.from(cpu.forward(TOKENS[i]!))).toEqual(Array.from(first[i]!));
  });

  it("refuses to run past its capacity", () => {
    const tiny = buildTinyModel({ type: GGML.F32, nLayers: 1 });
    const cpu = Model.fromGGUF(parseGGUF(tiny.bytes)).cpu(2);
    cpu.forward(1);
    cpu.forward(2);
    expect(() => cpu.forward(3)).toThrow(/context full/);
  });
});

describe("WebGPU path", () => {
  it("is unavailable in Node, so the CPU path runs", () => {
    expect(webGpuAvailable()).toBe(false);
  });
});

describe("config errors", () => {
  it("rejects unsupported architectures", () => {
    const tiny = buildTinyModel({ type: GGML.F32, nLayers: 1 });
    const f = parseGGUF(tiny.bytes);
    f.metadata.set("general.architecture", "mamba");
    expect(() => readConfig(f)).toThrow(/mamba/);
  });
});
