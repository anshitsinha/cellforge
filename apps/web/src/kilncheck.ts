/**
 * Dev-only: the WebGPU kernels against the CPU path in a real browser.
 * Open /kilncheck.html on the dev server. Same tiny random models, same
 * tokens; reports the largest logit difference per model (relative to the
 * logits' range) and whether greedy decoding picks the same tokens.
 */
import { GGML, Kiln, webGpuAvailable } from "@cellforge/kiln";
import { buildTinyModel, type TinyOptions } from "../../../packages/kiln/test/tiny";

interface Row {
  model: string;
  backend: string;
  steps: number;
  maxAbsDiff: number;
  relDiff: number;
  argmaxAgree: string;
  greedySame: boolean;
  cpuTokS: number;
  gpuTokS: number;
}

const CASES: [string, TinyOptions][] = [
  ["F32 llama", { type: GGML.F32 }],
  ["Q8_0 llama", { type: GGML.Q8_0 }],
  ["Q4_0 / Q8_0 embd", { type: GGML.Q4_0, embdType: GGML.Q8_0, scale: 3 }],
  ["Q4_K qwen2", { type: GGML.Q4_K, arch: "qwen2", dim: 256, ffnDim: 512 }],
  ["Q6_K tied", { type: GGML.Q6_K, tied: true, dim: 256, ffnDim: 512 }],
  ["Q4_0 bigger", { type: GGML.Q4_0, dim: 512, nLayers: 4, nHeads: 8, nKvHeads: 4, ffnDim: 1024, scale: 3 }],
];

async function compare(name: string, o: TinyOptions): Promise<Row> {
  const tiny = buildTinyModel({ contextLength: 512, ...o });
  const cpu = await Kiln.load(tiny.bytes, { backend: "cpu" });
  const gpu = await Kiln.load(tiny.bytes, { backend: "webgpu" });
  const ids = cpu.tokenizer.encode("Sort the sheet by amount, then filter region North and total it");
  let maxAbs = 0;
  let range = 0;
  let agree = 0;
  for (const id of ids) {
    const a = await cpu.backend.forward(id);
    const b = await gpu.backend.forward(id);
    let am = 0, bm = 0;
    for (let i = 0; i < a.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
      range = Math.max(range, Math.abs(a[i]));
      if (a[i] > a[am]) am = i;
      if (b[i] > b[bm]) bm = i;
    }
    if (am === bm) agree++;
  }
  cpu.reset();
  gpu.reset();
  const ga = await cpu.generate("Hide column B", { maxTokens: 24, temperature: 0 });
  const gb = await gpu.generate("Hide column B", { maxTokens: 24, temperature: 0 });
  return {
    model: name,
    backend: gpu.backend.name,
    steps: ids.length,
    maxAbsDiff: +maxAbs.toExponential(2),
    relDiff: +(maxAbs / (range || 1)).toExponential(2),
    argmaxAgree: `${agree}/${ids.length}`,
    greedySame: ga.tokens.join() === gb.tokens.join(),
    cpuTokS: Math.round(ga.tokensPerSecond),
    gpuTokS: Math.round(gb.tokensPerSecond),
  };
}

const out = document.getElementById("out")!;
(async () => {
  if (!webGpuAvailable()) {
    out.textContent = "WebGPU isn't available in this browser.";
    return;
  }
  const rows: (Row | { model: string; error: string })[] = [];
  for (const [name, o] of CASES) {
    try {
      rows.push(await compare(name, o));
    } catch (e) {
      rows.push({ model: name, error: String((e as Error).stack ?? e) });
    }
    out.textContent = JSON.stringify(rows, null, 2);
  }
  (window as unknown as { kilnCheck: unknown }).kilnCheck = rows;
  out.textContent = "done\n" + JSON.stringify(rows, null, 2);
})();
