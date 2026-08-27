import { describe, expect, it } from "vitest";
import { s, validate } from "../../actions/src/schema";
import { GGML } from "../src/gguf";
import { Kiln, type ProposalModel } from "../src/runtime";
import { makeRng, sample } from "../src/sample";
import { buildTinyModel } from "./tiny";

const ACTION = s.object(
  {
    type: s.string(undefined, { enum: ["rows.sort", "cells.set", "col.format", "rows.filter"] }),
    params: s.anyOf(
      s.object({ col: s.int(undefined, 0, 100), descending: s.bool() }, ["col"]),
      s.object({ row: s.int(undefined, 1), value: s.anyOf(s.string(undefined, { maxLength: 8 }), s.number(), s.null()) }),
    ),
    tags: s.array(s.string(undefined, { minLength: 1, maxLength: 4 }), undefined, 0, 3),
  },
  ["type", "params"],
);

describe("sampling", () => {
  const logits = new Float32Array([1, 3, 2, -1, 0]);
  it("greedy picks the argmax among allowed tokens", () => {
    expect(sample(logits)).toBe(1);
    expect(sample(logits, {}, Math.random, new Uint8Array([1, 0, 1, 0, 0]))).toBe(2);
    expect(sample(logits, {}, Math.random, new Uint8Array(5))).toBe(-1);
  });
  it("top-k 1 is greedy and top-p keeps the head", () => {
    const rng = makeRng(1);
    for (let i = 0; i < 50; i++) expect(sample(logits, { temperature: 1, topK: 1 }, rng)).toBe(1);
    for (let i = 0; i < 50; i++) expect([1, 2]).toContain(sample(logits, { temperature: 1, topP: 0.8 }, rng));
  });
  it("temperature sampling follows the softmax", () => {
    const rng = makeRng(2);
    const counts = new Array(5).fill(0);
    for (let i = 0; i < 20000; i++) counts[sample(logits, { temperature: 1 }, rng)]++;
    const z = Array.from(logits).reduce((a, b) => a + Math.exp(b), 0);
    for (let i = 0; i < 5; i++) expect(counts[i] / 20000).toBeCloseTo(Math.exp(logits[i]!) / z, 1);
  });
  it("repeat penalty lowers recent tokens", () => {
    expect(sample(logits, { repeatPenalty: 10 }, Math.random, null, [1])).toBe(2);
  });
});

describe("Kiln runtime on a tiny random model", () => {
  const tiny = buildTinyModel({ type: GGML.Q4_0, embdType: GGML.Q8_0, scale: 3 });

  it("loads with backend auto (CPU in Node) and generates deterministically", async () => {
    const k = await Kiln.load(tiny.bytes);
    expect(k.backend.name).toBe("cpu");
    const a = await k.generate("Sort the sheet by amount", { maxTokens: 12 });
    k.reset();
    const b = await k.generate("Sort the sheet by amount", { maxTokens: 12 });
    expect(a.tokens).toEqual(b.tokens);
    expect(a.tokens.length).toBeGreaterThan(0);
    expect(a.tokensPerSecond).toBeGreaterThan(0);
  });

  it("reuses the KV cache for a shared prompt prefix with identical results", async () => {
    const k = await Kiln.load(tiny.bytes, { backend: "cpu" });
    const sys = "You are a spreadsheet assistant. Reply with one JSON action. ";
    await k.generate(sys + "first question", { maxTokens: 4 });
    const second = await k.generate(sys + "second question", { maxTokens: 8 });
    expect(second.reusedTokens).toBeGreaterThan(5);
    const fresh = await Kiln.load(tiny.bytes, { backend: "cpu" });
    const ref = await fresh.generate(sys + "second question", { maxTokens: 8 });
    expect(second.tokens).toEqual(ref.tokens);
  });

  it("stops at stop strings", async () => {
    const k = await Kiln.load(tiny.bytes, { backend: "cpu" });
    const all = await k.generate("x", { maxTokens: 30, temperature: 1, seed: 3 });
    const piece = all.text.slice(2, 4);
    if (piece.length === 2) {
      const r = await k.generate("x", { maxTokens: 30, temperature: 1, seed: 3, stop: [piece] });
      expect(r.finish).toBe("stop");
      expect(r.text).toBe(all.text.slice(0, all.text.indexOf(piece)));
    }
  });

  it("50 constrained generations all parse and validate against the schema", async () => {
    const k = await Kiln.load(tiny.bytes, { backend: "cpu", contextLength: 256 });
    let forced = 0;
    for (let i = 0; i < 50; i++) {
      const r = await k.generate(`Request ${i}: do something with column ${i % 7}`, {
        schema: ACTION,
        temperature: 1.2,
        topK: 40,
        seed: 1000 + i,
        maxTokens: 24 + (i % 5) * 12,
      });
      const value = JSON.parse(r.text);
      expect(validate(value, ACTION), r.text).toEqual([]);
      if (r.forcedTokens) forced++;
    }
    // the tight budgets make some runs finish by forced completion
    expect(forced).toBeGreaterThan(0);
  }, 60_000);

  it("propose() implements the packages/ai model interface", async () => {
    const k: ProposalModel = await Kiln.load(tiny.bytes, { backend: "cpu" });
    const out = await k.propose("Sort by column B", ACTION);
    expect(validate(JSON.parse(out), ACTION)).toEqual([]);
    const free = await k.propose("hello");
    expect(typeof free).toBe("string");
  });

  it("refuses a WebGPU-only load where WebGPU is missing", async () => {
    await expect(Kiln.load(tiny.bytes, { backend: "webgpu" })).rejects.toThrow(/WebGPU is not available/);
  });
});
