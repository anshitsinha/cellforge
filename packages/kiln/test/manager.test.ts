import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IntegrityError, MemoryStorage, ModelManager, TIERS, chooseTier, detectHardware, tierFit, type FetchLike, type HardwareInfo, type ModelSpec } from "../src/manager";
import { makeRng } from "../src/sample";
import { Sha256, sha256Hex } from "../src/sha256";

describe("SHA-256", () => {
  it("matches the standard vectors", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches node:crypto for any length and chunking", () => {
    const rng = makeRng(5);
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
      const data = Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
      const h = new Sha256();
      for (let i = 0; i < n; ) {
        const step = 1 + Math.floor(rng() * 100);
        h.update(data.subarray(i, i + step));
        i += step;
      }
      expect(h.hex()).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
});

const hw = (o: Partial<HardwareInfo> = {}): HardwareInfo => ({ webgpu: null, deviceMemoryGB: 8, cores: 8, storageAvailableBytes: null, ...o });
const gpu = (mb: number) => ({ vendor: "test", architecture: "", maxBufferSize: mb * 2 ** 20, maxStorageBufferBindingSize: mb * 2 ** 20, isFallbackAdapter: false });

describe("hardware and tiers", () => {
  it("detects through an injected navigator", async () => {
    const info = await detectHardware({
      hardwareConcurrency: 12,
      deviceMemory: 8,
      gpu: { requestAdapter: async () => ({ limits: { maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30 }, info: { vendor: "acme", architecture: "x" } }) as never },
      storage: { estimate: async () => ({ quota: 10e9, usage: 1e9 }) },
    });
    expect(info).toEqual({
      webgpu: { vendor: "acme", architecture: "x", maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, isFallbackAdapter: false },
      deviceMemoryGB: 8,
      cores: 12,
      storageAvailableBytes: 9e9,
    });
    expect((await detectHardware(undefined)).webgpu).toBeNull();
    expect((await detectHardware({ gpu: { requestAdapter: async () => { throw new Error("blocked"); } } })).webgpu).toBeNull();
  });

  it("picks the largest tier that fits", () => {
    expect(chooseTier(hw()).id).toBe("small"); // no WebGPU: CPU tiers only
    expect(chooseTier(hw({ deviceMemoryGB: 2 })).id).toBe("tiny");
    expect(chooseTier(hw({ deviceMemoryGB: 1 })).id).toBe("none");
    expect(chooseTier(hw({ webgpu: gpu(512) })).id).toBe("medium");
    expect(chooseTier(hw({ webgpu: gpu(2048) })).id).toBe("large");
    expect(chooseTier(hw({ webgpu: { ...gpu(2048), isFallbackAdapter: true } })).id).toBe("small");
    expect(chooseTier(hw({ webgpu: gpu(2048), storageAvailableBytes: 600 * 2 ** 20 })).id).toBe("small");
    expect(tierFit(hw(), TIERS.find((t) => t.id === "large")!).reasons).toContain("needs WebGPU");
  });
});

// a fake HTTP server for one file, with Range support and fault injection
function server(file: Uint8Array, opts: { ignoreRange?: boolean; failAfter?: number; chunk?: number } = {}) {
  const log: { range: string | undefined; status: number }[] = [];
  let failAfter = opts.failAfter;
  const fetch: FetchLike = async (_url, init) => {
    const range = init?.headers?.Range;
    let start = 0;
    let status = 200;
    if (range && !opts.ignoreRange) {
      start = Number(/bytes=(\d+)-/.exec(range)![1]);
      status = start >= file.length ? 416 : 206;
    }
    log.push({ range, status });
    const body = file.subarray(start);
    const chunk = opts.chunk ?? 1000;
    let sent = 0;
    const limit = failAfter;
    failAfter = undefined; // only the first response fails
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (limit !== undefined && sent >= limit) return c.error(new Error("connection reset"));
        if (sent >= body.length) return c.close();
        c.enqueue(body.slice(sent, sent + chunk));
        sent += chunk;
      },
    });
    const headers = new Map<string, string>([["content-length", String(body.length)]]);
    if (status === 206) headers.set("content-range", `bytes ${start}-${file.length - 1}/${file.length}`);
    return { status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, body: status === 416 ? null : stream };
  };
  return { fetch, log };
}

describe("model cache and downloads", () => {
  const rng = makeRng(9);
  const file = Uint8Array.from({ length: 25_000 }, () => Math.floor(rng() * 256));
  const spec: ModelSpec = { id: "tiny-q4", url: "https://models.invalid/tiny.gguf", sha256: createHash("sha256").update(file).digest("hex"), bytes: file.length };

  it("does nothing on construction and never fetches without a URL", async () => {
    let calls = 0;
    const m = new ModelManager({ storage: new MemoryStorage(), fetch: async () => { calls++; throw new Error("offline"); } });
    expect(await m.isCached(spec)).toBe(false);
    expect(await m.load(spec)).toBeNull();
    await expect(m.ensure({ ...spec, url: undefined })).rejects.toThrow(/no download URL/);
    expect(calls).toBe(0);
  });

  it("downloads, verifies, caches, then works offline", async () => {
    const storage = new MemoryStorage();
    const { fetch, log } = server(file);
    const progress: number[] = [];
    const m = new ModelManager({ storage, fetch });
    const got = await m.ensure(spec, { onProgress: (n) => progress.push(n) });
    expect(got).toEqual(file);
    expect(log).toEqual([{ range: undefined, status: 200 }]);
    expect(progress.at(-1)).toBe(file.length);
    expect(await storage.list()).toEqual(["tiny-q4.gguf"]);
    expect(await m.verify(spec)).toBe(true);
    const offline = new ModelManager({ storage, fetch: async () => { throw new Error("offline"); } });
    expect(await offline.ensure(spec)).toEqual(file);
  });

  it("resumes an interrupted download with a Range request", async () => {
    const storage = new MemoryStorage();
    const { fetch, log } = server(file, { failAfter: 12_000, chunk: 1000 });
    const m = new ModelManager({ storage, fetch });
    await expect(m.ensure(spec, { checkpointBytes: 4000 })).rejects.toThrow(/connection reset/);
    const partial = (await storage.size("tiny-q4.gguf.part"))!;
    expect(partial).toBe(12_000);
    expect(await m.ensure(spec)).toEqual(file);
    expect(log.map((l) => l.status)).toEqual([200, 206]);
    expect(log[1]!.range).toBe("bytes=12000-");
  });

  it("starts over when the server ignores Range", async () => {
    const storage = new MemoryStorage();
    const w = await storage.openWriter("tiny-q4.gguf.part");
    await w.write(file.subarray(0, 5000));
    await w.close();
    const { fetch, log } = server(file, { ignoreRange: true });
    expect(await new ModelManager({ storage, fetch }).ensure(spec)).toEqual(file);
    expect(log).toEqual([{ range: "bytes=5000-", status: 200 }]);
  });

  it("verifies a part file that is already complete (416)", async () => {
    const storage = new MemoryStorage();
    const w = await storage.openWriter("tiny-q4.gguf.part");
    await w.write(file);
    await w.close();
    const { fetch, log } = server(file);
    expect(await new ModelManager({ storage, fetch }).ensure({ ...spec, bytes: undefined })).toEqual(file);
    expect(log.map((l) => l.status)).toEqual([416]);
  });

  it("rejects a corrupted file and throws the bad part away", async () => {
    const storage = new MemoryStorage();
    const bad = file.slice();
    bad[100] ^= 1;
    const { fetch } = server(bad);
    const m = new ModelManager({ storage, fetch });
    await expect(m.ensure(spec)).rejects.toBeInstanceOf(IntegrityError);
    expect(await storage.list()).toEqual([]);
  });

  it("removes cached models", async () => {
    const storage = new MemoryStorage();
    const m = new ModelManager({ storage, fetch: server(file).fetch });
    await m.ensure(spec);
    await m.remove(spec);
    expect(await m.isCached(spec)).toBe(false);
  });
});

describe("checkpoints", () => {
  it("each checkpoint at least doubles the committed file, so reopening (which copies it in OPFS) stays linear", async () => {
    const file = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 31) & 255);
    const spec: ModelSpec = { id: "big", url: "https://models.invalid/big.gguf", sha256: createHash("sha256").update(file).digest("hex"), bytes: file.length };
    const storage = new MemoryStorage();
    const reopenedAt: number[] = [];
    const open = storage.openWriter.bind(storage);
    storage.openWriter = async (name) => {
      reopenedAt.push((await storage.size(name)) ?? 0);
      return open(name);
    };
    const { fetch } = server(file, { chunk: 1000 });
    await new ModelManager({ storage, fetch }).ensure(spec, { checkpointBytes: 1000 });
    const copied = reopenedAt.reduce((a, b) => a + b, 0);
    expect(reopenedAt.length).toBeGreaterThan(3);
    expect(reopenedAt.length).toBeLessThan(12);
    expect(copied).toBeLessThan(2 * file.length);
  });
});
