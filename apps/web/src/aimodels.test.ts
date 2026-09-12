import { describe, expect, it } from "vitest";
import { GGML, isSupportedType, type HardwareInfo } from "@cellforge/kiln";
import { AI_MODELS, describeHardware, formatBytes, modelFit, recommendModel } from "./aimodels";

const hw = (o: Partial<HardwareInfo> = {}): HardwareInfo => ({ webgpu: null, deviceMemoryGB: 8, cores: 8, storageAvailableBytes: 50e9, ...o });
const gpu = (mb: number) => ({ vendor: "intel", architecture: "", maxBufferSize: mb * 2 ** 20, maxStorageBufferBindingSize: mb * 2 ** 20, isFallbackAdapter: false });

describe("the model catalog", () => {
  it("has three models, smallest first, with unique ids", () => {
    expect(AI_MODELS).toHaveLength(3);
    expect(AI_MODELS.map((m) => m.size)).toEqual(["Small", "Medium", "Large"]);
    expect(new Set(AI_MODELS.map((m) => m.id)).size).toBe(3);
    const sizes = AI_MODELS.map((m) => m.bytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it.each(AI_MODELS.map((m) => [m.name, m] as const))("%s is well formed", (_, m) => {
    expect(Number.isSafeInteger(m.bytes)).toBe(true);
    expect(m.bytes).toBeGreaterThan(300e6);
    expect(m.bytes).toBeLessThan(3e9);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    const u = new URL(m.url);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe(m.site);
    expect(m.url).toMatch(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/main\/[\w.-]+\.gguf$/);
    expect(m.url.endsWith(`/${m.file}`)).toBe(true);
    expect(m.page && m.url.startsWith(m.page + "/resolve/main/")).toBe(true);
    expect(m.file).toBe(`${m.id}.gguf`);
    expect(m.file.toLowerCase()).toContain(m.quant.toLowerCase());
    expect(["qwen2", "llama"]).toContain(m.arch);
    expect(m.licence.name).toBeTruthy();
    expect(m.licence.url).toMatch(/^https:\/\//);
    expect(m.goodFor.length).toBeGreaterThan(20);
    expect(m.minMemoryGB).toBeGreaterThan(0);
  });

  it("only uses tensor types kiln can run", () => {
    for (const m of AI_MODELS) {
      expect(m.tensorTypes.length).toBeGreaterThan(0);
      for (const t of m.tensorTypes) expect(isSupportedType(GGML[t])).toBe(true);
    }
  });

  it("says plainly what the licence allows", () => {
    expect(AI_MODELS.filter((m) => /non-commercial/.test(m.licence.note)).map((m) => m.size)).toEqual(["Large"]);
  });
});

describe("hardware fit", () => {
  it("recommends the small model without a graphics card", () => {
    expect(recommendModel(hw()).size).toBe("Small");
    expect(recommendModel(hw({ deviceMemoryGB: null })).size).toBe("Small");
  });

  it("recommends the medium model with a graphics card, never the large one", () => {
    expect(recommendModel(hw({ webgpu: gpu(2048) })).size).toBe("Medium");
  });

  it("falls back to the small model on a fallback (software) GPU", () => {
    expect(recommendModel(hw({ webgpu: { ...gpu(2048), isFallbackAdapter: true } })).size).toBe("Small");
  });

  it("explains why a model doesn't fit", () => {
    const [small, medium, large] = AI_MODELS;
    expect(modelFit(hw(), small).fits).toBe(true);
    expect(modelFit(hw(), medium).reasons.join()).toMatch(/graphics card the browser can use/);
    expect(modelFit(hw({ webgpu: gpu(512) }), large).reasons.join()).toMatch(/graphics card is too small/);
    expect(modelFit(hw({ storageAvailableBytes: 100e6 }), small).reasons.join()).toMatch(/free browser storage/);
    expect(modelFit(hw({ deviceMemoryGB: 2 }), small).reasons.join()).toMatch(/needs 4 GB memory/);
  });

  it("describes the computer in plain words", () => {
    expect(describeHardware(hw({ webgpu: gpu(1024), storageAvailableBytes: 12e9 }))).toBe("8 GB or more memory · 8 processor cores · a graphics card the browser can use (intel) · 12 GB free for this site");
    expect(describeHardware(hw({ deviceMemoryGB: 4, cores: 1, storageAvailableBytes: null }))).toBe("4 GB memory · 1 processor core · no graphics card the browser can use");
  });

  it("formats sizes", () => {
    expect(AI_MODELS.map((m) => formatBytes(m.bytes))).toEqual(["676 MB", "1.1 GB", "2.1 GB"]);
  });
});
