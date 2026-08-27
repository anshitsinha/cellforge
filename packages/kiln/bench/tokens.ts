// Tokens/second for the CPU path on tiny random models (no downloads).
// Run with: npm run bench:kiln   (or: node packages/kiln/bench/run.mjs)
import { GGML, typeName, type GGMLType } from "../src/gguf";
import { Kiln } from "../src/runtime";
import { s } from "../../actions/src/schema";
import { buildTinyModel, type TinyOptions } from "../test/tiny";

const configs: [string, TinyOptions][] = [
  ["tiny (2L, d64, 4h/2kv, vocab 300)", { dim: 64, nLayers: 2, nHeads: 4, nKvHeads: 2 }],
  ["small (4L, d256, 8h/2kv, ffn 768)", { dim: 256, nLayers: 4, nHeads: 8, nKvHeads: 2, ffnDim: 768 }],
];
const types: GGMLType[] = [GGML.F32, GGML.Q8_0, GGML.Q4_0, GGML.Q4_K];

const schema = s.object(
  {
    type: s.string(undefined, { enum: ["rows.sort", "cells.set", "col.format"] }),
    params: s.object({ col: s.int(undefined, 0, 100), descending: s.bool() }, ["col"]),
  },
  ["type", "params"],
);

const pad = (x: string, n: number) => x.padEnd(n);
console.log(`${pad("model", 38)} ${pad("weights", 8)} ${pad("free tok/s", 12)} ${pad("prefill tok/s", 14)} json tok/s`);
for (const [label, cfg] of configs) {
  for (const type of types) {
    if (type === GGML.Q4_K && (cfg.dim ?? 64) % 256 !== 0) continue;
    const tiny = buildTinyModel({ ...cfg, type, scale: 3 });
    const k = await Kiln.load(tiny.bytes, { backend: "cpu", contextLength: 512 });
    const prompt = "Sort the sheet by amount, then filter rows where the region is North.";
    await k.generate(prompt, { maxTokens: 200 }); // warm up the JIT
    let freeTps = 0, prefill = 0;
    for (let rep = 0; rep < 3; rep++) {
      k.reset();
      const free = await k.generate(prompt, { maxTokens: 200, temperature: 0.8, seed: rep });
      freeTps = Math.max(freeTps, free.tokensPerSecond);
      prefill = Math.max(prefill, (free.promptTokens / free.prefillMs) * 1000);
    }
    k.reset();
    let jsonTokens = 0, jsonMs = 0;
    for (let i = 0; i < 5; i++) {
      const r = await k.generate(prompt + ` (${i})`, { schema, maxTokens: 80, temperature: 1, seed: i });
      jsonTokens += r.tokens.length - r.forcedTokens;
      jsonMs += r.decodeMs;
    }
    console.log(
      `${pad(label, 38)} ${pad(typeName(type), 8)} ${pad(freeTps.toFixed(0), 12)} ${pad(prefill.toFixed(0), 14)} ${((jsonTokens / jsonMs) * 1000).toFixed(0)}`,
    );
  }
}
