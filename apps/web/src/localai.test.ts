import { describe, expect, it } from "vitest";
import { MemoryStorage, Sha256, type FetchLike, type HardwareInfo, type Kiln } from "@cellforge/kiln";
import type { CatalogModel } from "./aimodels";
import { humanError, LocalAi, type AiStatus, type LocalAiDeps } from "./localmodel";

const BYTES = Uint8Array.from({ length: 10_000 }, (_, i) => (i * 7 + 3) & 255);
const sha = (b: Uint8Array) => {
  const h = new Sha256();
  h.update(b);
  return h.hex();
};

const MODEL: CatalogModel = {
  id: "tiny-test-q8_0",
  name: "Tiny Test",
  size: "Small",
  params: "1 thousand",
  arch: "qwen2",
  quant: "Q8_0",
  tensorTypes: ["Q8_0", "F32"],
  file: "tiny-test-q8_0.gguf",
  bytes: BYTES.length,
  sha256: sha(BYTES),
  url: "https://huggingface.co/x/y/resolve/main/tiny-test-q8_0.gguf",
  site: "huggingface.co",
  page: "https://huggingface.co/x/y",
  licence: { name: "MIT", url: "", note: "" },
  goodFor: "",
  minMemoryGB: 1,
  gpu: "optional",
  tier: "small",
};

interface ServerOpts {
  /** the bytes the server has */
  data?: Uint8Array;
  /** drop the connection after this many bytes of the response body (first request only) */
  dropAfter?: number;
  /** answer every request whole (ignore Range) */
  ignoreRange?: boolean;
  /** pretend the file is this big */
  claimSize?: number;
  status?: number;
  chunk?: number;
}

function fakeServer(o: ServerOpts = {}) {
  const data = o.data ?? BYTES;
  const requests: { range: string | null }[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const range = init?.headers?.Range ?? null;
    requests.push({ range });
    if (o.status) return { status: o.status, headers: new Headers(), body: null };
    const start = range && !o.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const body = data.subarray(start);
    const total = o.claimSize ?? data.length;
    const headers = new Headers(start > 0 ? { "content-range": `bytes ${start}-${data.length - 1}/${total}`, "content-length": String(body.length) } : { "content-length": String(o.claimSize ?? body.length) });
    const chunk = o.chunk ?? 1000;
    const drop = requests.length === 1 ? o.dropAfter : undefined;
    let sent = 0;
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (signal?.aborted) return c.error(new DOMException("aborted", "AbortError"));
        if (drop !== undefined && sent >= drop) return c.error(new TypeError("Failed to fetch"));
        if (sent >= body.length) return c.close();
        const n = Math.min(chunk, body.length - sent, drop !== undefined ? drop - sent : Infinity);
        c.enqueue(body.slice(sent, sent + n));
        sent += n;
      },
    });
    return { status: start > 0 ? 206 : 200, headers, body: stream };
  };
  return { fetch, requests };
}

const HW: HardwareInfo = { webgpu: null, deviceMemoryGB: 8, cores: 8, storageAvailableBytes: 10 ** 10 };

function fakeKiln(backend: "cpu" | "webgpu" = "cpu") {
  const k = {
    disposed: false,
    backend: { name: backend },
    propose: async () => "{}",
    generate: async () => ({ tokensPerSecond: 12.5 }),
    reset: () => undefined,
    dispose() {
      k.disposed = true;
    },
  };
  return k;
}

function setup(server = fakeServer(), extra: Partial<LocalAiDeps> = {}) {
  const storage = new MemoryStorage();
  let reads = 0;
  const readAll = storage.readAll.bind(storage);
  storage.readAll = async (n) => {
    reads++;
    return readAll(n);
  };
  const loads: { bytes: Uint8Array; backend?: string }[] = [];
  const kilns: ReturnType<typeof fakeKiln>[] = [];
  let pref: string | null = null;
  const deps: LocalAiDeps = {
    storage: () => storage,
    fetch: server.fetch,
    hardware: async () => HW,
    load: async (bytes, opts) => {
      loads.push({ bytes, backend: opts?.backend });
      const k = fakeKiln();
      kilns.push(k);
      return k as unknown as Kiln;
    },
    prefs: { get: () => pref, set: (v) => (pref = v) },
    ...extra,
  };
  const ai = new LocalAi(deps);
  const seen: AiStatus[] = [];
  ai.subscribe((s) => seen.push(s));
  return { ai, storage, loads, kilns, seen, reads: () => reads, server, pref: () => pref };
}

const states = (seen: AiStatus[]) => seen.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]);

describe("downloading a model", () => {
  it("streams it into storage with progress, checks it, then loads it once", async () => {
    const t = setup(fakeServer({ chunk: 2500 }));
    await t.ai.scan();
    const m = await t.ai.downloadModel(MODEL);
    expect(m?.name).toBe("Tiny Test");
    expect(m?.tokensPerSecond).toBe(12.5);
    expect(m?.backend).toBe("CPU");
    expect(await t.storage.size(MODEL.file)).toBe(BYTES.length);
    expect(await t.storage.size(MODEL.file + ".part")).toBeNull();
    const progress = t.seen.filter((s) => s.state === "downloading").map((s) => s.download!.loaded);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress).toContain(5000);
    expect(progress.at(-1)).toBe(BYTES.length);
    expect(states(t.seen)).toEqual(["none", "downloading", "loading", "ready"]);
    expect(t.loads).toHaveLength(1);
    expect(t.reads()).toBe(1);
    expect(t.loads[0].bytes).toEqual(BYTES);
    expect(t.pref()).toBe(MODEL.file);
    expect(t.ai.status().label).toBe("Ready: Tiny Test (CPU)");
  });

  it("resumes a dropped download with a Range request", async () => {
    const t = setup(fakeServer({ dropAfter: 4000 }));
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    let s = t.ai.status();
    expect(s.error).toMatch(/connection dropped.*Resume/);
    expect(s.download).toMatchObject({ paused: true, loaded: 4000 });
    expect(s.stored).toEqual([expect.objectContaining({ file: MODEL.file, partial: true, bytes: 4000 })]);
    const m = await t.ai.downloadModel(MODEL);
    expect(m).not.toBeNull();
    expect(t.server.requests.map((r) => r.range)).toEqual([null, "bytes=4000-"]);
    expect(await t.storage.readAll(MODEL.file)).toEqual(BYTES);
    s = t.ai.status();
    expect(s.state).toBe("ready");
    expect(s.error).toBeNull();
  });

  it("pauses and resumes", async () => {
    const t = setup(fakeServer({ chunk: 1000 }));
    t.ai.subscribe((s) => {
      if (s.download && !s.download.paused && s.download.loaded >= 3000) t.ai.pause();
    });
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    const s = t.ai.status();
    expect(s.state).toBe("paused");
    expect(s.download?.paused).toBe(true);
    const kept = (await t.storage.size(MODEL.file + ".part"))!;
    expect(kept).toBeGreaterThanOrEqual(3000);
    expect(kept).toBeLessThan(BYTES.length);
    // a fresh instance (as after a reload) sees the partial download too
    const t2 = setup(t.server, { storage: () => t.storage });
    await t2.ai.scan();
    expect(t2.ai.status().state).toBe("paused");
    const m = await t2.ai.downloadModel(MODEL);
    expect(m).not.toBeNull();
    expect(t.server.requests.at(-1)!.range).toBe(`bytes=${kept}-`);
    expect(await t.storage.readAll(MODEL.file)).toEqual(BYTES);
  });

  it("starts over when the server ignores the range", async () => {
    const t = setup(fakeServer({ dropAfter: 3000, ignoreRange: true }));
    await t.ai.downloadModel(MODEL);
    expect(await t.ai.downloadModel(MODEL)).not.toBeNull();
    expect(await t.storage.readAll(MODEL.file)).toEqual(BYTES);
  });

  it("refuses a file of the wrong size and keeps nothing", async () => {
    const t = setup(fakeServer({ claimSize: BYTES.length + 1 }));
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    const s = t.ai.status();
    expect(s.state).toBe("error");
    expect(s.error).toMatch(/huggingface\.co is 10 KB, not the 10 KB expected|may have been replaced/);
    expect(s.download).toBeNull();
    expect(await t.storage.list()).toEqual([]);
    expect(t.loads).toHaveLength(0);
  });

  it("throws away a file whose SHA-256 doesn't match", async () => {
    const bad = BYTES.slice();
    bad[1234] ^= 1;
    const t = setup(fakeServer({ data: bad }));
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    expect(t.ai.status().error).toMatch(/didn't match the published one/);
    expect(await t.storage.list()).toEqual([]);
  });

  it("cancels and deletes what arrived", async () => {
    const t = setup(fakeServer({ chunk: 1000 }));
    t.ai.subscribe((s) => {
      if (s.download && s.download.loaded >= 2000) void t.ai.cancel();
    });
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    const s = t.ai.status();
    expect(s.state).toBe("none");
    expect(s.download).toBeNull();
    expect(s.error).toBeNull();
    expect(await t.storage.list()).toEqual([]);
  });

  it("cancels a paused download", async () => {
    const t = setup(fakeServer({ dropAfter: 5000 }));
    await t.ai.downloadModel(MODEL);
    expect(t.ai.status().stored).toHaveLength(1);
    await t.ai.cancel();
    expect(t.ai.status().state).toBe("none");
    expect(await t.storage.list()).toEqual([]);
  });

  it("says when the site has no such file", async () => {
    const t = setup(fakeServer({ status: 404 }));
    await t.ai.downloadModel(MODEL);
    expect(t.ai.status().error).toMatch(/no longer has this file/);
  });

  it("checks free storage before it starts", async () => {
    const t = setup(fakeServer(), { hardware: async () => ({ ...HW, storageAvailableBytes: 100 }) });
    expect(await t.ai.downloadModel(MODEL)).toBeNull();
    expect(t.ai.status().error).toMatch(/isn't enough free storage/);
    expect(t.server.requests).toHaveLength(0);
  });

  it("never touches the network unless asked to download", async () => {
    const t = setup();
    await t.ai.scan();
    await t.ai.restore();
    t.ai.status();
    expect(t.server.requests).toHaveLength(0);
  });
});

describe("loading a model", () => {
  const ggufFile = (name = "my-model.gguf", bytes = new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0, 9, 9])) => {
    const f = new File([bytes], name);
    // the whole file must never be read into memory: it streams into storage and is read back once
    Object.defineProperty(f, "arrayBuffer", { value: () => Promise.reject(new Error("read the whole picked file")) });
    const slice = f.slice.bind(f);
    Object.defineProperty(f, "slice", { value: (a?: number, b?: number) => slice(a, b) });
    return f;
  };

  it("keeps a picked file and reads it into memory exactly once", async () => {
    const t = setup();
    const m = await t.ai.install(ggufFile());
    expect(m.name).toBe("my-model.gguf");
    expect(t.reads()).toBe(1);
    expect(t.loads).toHaveLength(1);
    expect(Array.from(t.loads[0].bytes.subarray(0, 4))).toEqual([71, 71, 85, 70]);
    expect(t.ai.status().stored.map((s) => s.file)).toEqual(["my-model.gguf"]);
  });

  it("refuses files that aren't GGUF", async () => {
    const t = setup();
    await expect(t.ai.install(new File(["hello"], "notes.txt"))).rejects.toThrow(/\.gguf/);
    await expect(t.ai.install(new File(["hello world"], "fake.gguf"))).rejects.toThrow(/isn't a GGUF model file/);
    expect(t.loads).toHaveLength(0);
    expect(t.ai.status().state).toBe("error");
  });

  it("releases the old model before loading another", async () => {
    const t = setup();
    await t.ai.install(ggufFile("a.gguf"));
    await t.ai.install(ggufFile("b.gguf"));
    expect(t.kilns[0].disposed).toBe(true);
    expect(t.kilns[1].disposed).toBe(false);
    expect(t.ai.loaded()?.file).toBe("b.gguf");
    await t.ai.useStored("a.gguf");
    expect(t.kilns[1].disposed).toBe(true);
    expect(t.ai.loaded()?.file).toBe("a.gguf");
  });

  it("goes through loading to ready, and back to stored when unloaded", async () => {
    const t = setup();
    await t.ai.scan();
    await t.ai.install(ggufFile());
    expect(states(t.seen)).toEqual(["none", "loading", "ready"]);
    expect(t.seen.filter((s) => s.state === "loading").map((s) => s.loading!.step)).toEqual(
      expect.arrayContaining(["Keeping a copy in this browser… 0%", "Reading the model file…", "Preparing the model…", "Measuring its speed…"]),
    );
    t.ai.unload();
    expect(t.ai.status().state).toBe("stored");
    await t.ai.remove("my-model.gguf");
    expect(t.ai.status().state).toBe("none");
    expect(t.pref()).toBeNull();
  });

  it("restores the model used last time, once, without asking twice", async () => {
    const t = setup();
    await t.ai.install(ggufFile("a.gguf"));
    await t.ai.install(ggufFile("b.gguf"));
    const fresh = setup(t.server, { storage: () => t.storage, prefs: { get: () => "a.gguf", set: () => undefined } });
    const [x, y] = await Promise.all([fresh.ai.restore(), fresh.ai.restore()]);
    expect(x?.file).toBe("a.gguf");
    expect(y?.file).toBe("a.gguf");
    expect(fresh.loads).toHaveLength(1);
  });

  it("falls back to the processor when the graphics card fails", async () => {
    let first = true;
    const t = setup(fakeServer(), {
      load: async () => {
        if (first) {
          first = false;
          throw new Error("GPU device lost");
        }
        return fakeKiln() as unknown as Kiln;
      },
    });
    const m = await t.ai.install(ggufFile());
    expect(m.gpuFailed).toBe(true);
    expect(m.backend).toBe("CPU");
  });

  it("explains an unsupported file in plain words", async () => {
    const t = setup(fakeServer(), {
      load: async () => {
        throw new Error("kiln: tensor blk.0.attn_q.weight has unsupported type Q5_0");
      },
    });
    await expect(t.ai.install(ggufFile())).rejects.toThrow();
    expect(t.ai.status().error).toMatch(/compressed in a way.*\(Q5_0\).*Q4_K_M/);
    expect(t.ai.status().state).toBe("error");
  });
});

describe("error messages", () => {
  it.each([
    [new RangeError("Array buffer allocation failed"), /ran out of memory/],
    [new Error('kiln: architecture "gemma2" is not supported (llama, mistral, qwen2)'), /design \(gemma2\)/],
    [new Error("not a GGUF file (bad magic)"), /isn't a GGUF model file/],
    [new TypeError("Failed to fetch"), /connection dropped/],
    [new Error("download of x failed: HTTP 503"), /HTTP 503.*Resume/],
    [Object.assign(new Error("quota"), { name: "QuotaExceededError" }), /enough free storage/],
  ])("%s", (e, re) => expect(humanError(e)).toMatch(re));
});
