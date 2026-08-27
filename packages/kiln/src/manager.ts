/**
 * Model manager: what the machine can run, which model tier fits, and a
 * local cache of model files (OPFS in the browser) with resumable downloads
 * and SHA-256 integrity checks.
 *
 * Nothing is ever downloaded unless `ensure()` is called with a spec that
 * has a URL; the catalog ships without URLs. Once a model is cached it loads
 * with no network at all.
 *
 * fetch and storage are injectable, so all of this is tested without a
 * network or a browser.
 */
/// <reference types="@webgpu/types" />
import { Sha256 } from "./sha256";

// ---- hardware ----------------------------------------------------------

export interface HardwareInfo {
  webgpu: null | {
    vendor: string;
    architecture: string;
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
    isFallbackAdapter: boolean;
  };
  /** navigator.deviceMemory (GB, Chrome rounds and caps it at 8); null when unknown */
  deviceMemoryGB: number | null;
  cores: number;
  /** navigator.storage.estimate(): bytes still free for this origin; null when unknown */
  storageAvailableBytes: number | null;
}

type NavigatorLike = {
  gpu?: { requestAdapter(o?: GPURequestAdapterOptions): Promise<GPUAdapter | null> };
  deviceMemory?: number;
  hardwareConcurrency?: number;
  storage?: { estimate?(): Promise<{ quota?: number; usage?: number }> };
};

export async function detectHardware(nav: NavigatorLike | undefined = globalThis.navigator as NavigatorLike | undefined): Promise<HardwareInfo> {
  let webgpu: HardwareInfo["webgpu"] = null;
  try {
    const adapter = nav?.gpu ? await nav.gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
    if (adapter) {
      const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
      webgpu = {
        vendor: info?.vendor ?? "",
        architecture: info?.architecture ?? "",
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        isFallbackAdapter: (adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter ?? info?.isFallbackAdapter ?? false,
      };
    }
  } catch {
    webgpu = null;
  }
  let storageAvailableBytes: number | null = null;
  try {
    const e = await nav?.storage?.estimate?.();
    if (e && e.quota !== undefined) storageAvailableBytes = e.quota - (e.usage ?? 0);
  } catch {
    storageAvailableBytes = null;
  }
  return {
    webgpu,
    deviceMemoryGB: typeof nav?.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: nav?.hardwareConcurrency ?? 1,
    storageAvailableBytes,
  };
}

// ---- tiers -------------------------------------------------------------

export type TierId = "none" | "tiny" | "small" | "medium" | "large";

export interface ModelTier {
  id: TierId;
  params: string;
  /** approximate Q4_K_M file size */
  fileMB: number;
  /** minimum navigator.deviceMemory (which tops out at 8) */
  minMemoryGB: number;
  /** needs WebGPU to be usably fast */
  needsWebGpu: boolean;
  /** largest single tensor the GPU must hold */
  minStorageBufferMB: number;
  /** candidate GGUF models (Q4_K_M) for this tier; not downloaded by kiln */
  examples: readonly string[];
}

export const TIERS: readonly ModelTier[] = [
  { id: "tiny", params: "135M-360M", fileMB: 280, minMemoryGB: 2, needsWebGpu: false, minStorageBufferMB: 0, examples: ["SmolLM2-360M-Instruct"] },
  { id: "small", params: "0.5B", fileMB: 400, minMemoryGB: 4, needsWebGpu: false, minStorageBufferMB: 0, examples: ["Qwen2.5-0.5B-Instruct"] },
  { id: "medium", params: "1.5B", fileMB: 1100, minMemoryGB: 8, needsWebGpu: true, minStorageBufferMB: 256, examples: ["Qwen2.5-1.5B-Instruct", "SmolLM2-1.7B-Instruct"] },
  { id: "large", params: "3B", fileMB: 2000, minMemoryGB: 8, needsWebGpu: true, minStorageBufferMB: 1024, examples: ["Qwen2.5-3B-Instruct", "Llama-3.2-3B-Instruct"] },
];

/** Why each tier does or doesn't fit. */
export function tierFit(hw: HardwareInfo, tier: ModelTier): { fits: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const mem = hw.deviceMemoryGB ?? 4; // unknown: assume a modest machine
  if (mem < tier.minMemoryGB) reasons.push(`needs ${tier.minMemoryGB} GB memory, have ${mem} GB`);
  const gpu = hw.webgpu && !hw.webgpu.isFallbackAdapter ? hw.webgpu : null;
  if (tier.needsWebGpu && !gpu) reasons.push("needs WebGPU");
  if (gpu && tier.needsWebGpu && gpu.maxStorageBufferBindingSize < tier.minStorageBufferMB * 2 ** 20)
    reasons.push(`GPU storage buffers are limited to ${Math.round(gpu.maxStorageBufferBindingSize / 2 ** 20)} MB`);
  if (hw.storageAvailableBytes !== null && hw.storageAvailableBytes < tier.fileMB * 1.1 * 2 ** 20) reasons.push(`needs ${tier.fileMB} MB of storage`);
  return { fits: reasons.length === 0, reasons };
}

/** The largest tier this machine can run, or "none". */
export function chooseTier(hw: HardwareInfo, tiers: readonly ModelTier[] = TIERS): ModelTier | { id: "none" } {
  let best: ModelTier | null = null;
  for (const t of tiers) if (tierFit(hw, t).fits) best = t;
  return best ?? { id: "none" };
}

// ---- storage -----------------------------------------------------------

export interface StorageWriter {
  write(chunk: Uint8Array): Promise<void>;
  /** commit what was written so far */
  close(): Promise<void>;
}

export interface ModelStorage {
  /** byte size, or null if the file doesn't exist */
  size(name: string): Promise<number | null>;
  /** append to (or create) a file */
  openWriter(name: string): Promise<StorageWriter>;
  /** stream a file's contents */
  read(name: string): AsyncIterable<Uint8Array>;
  /** whole file in memory (for loading the model) */
  readAll(name: string): Promise<Uint8Array | null>;
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

/** In-memory storage (tests, or a session-only cache). */
export class MemoryStorage implements ModelStorage {
  files = new Map<string, Uint8Array[]>();
  async size(name: string) {
    const f = this.files.get(name);
    return f ? f.reduce((a, c) => a + c.length, 0) : null;
  }
  async openWriter(name: string): Promise<StorageWriter> {
    if (!this.files.has(name)) this.files.set(name, []);
    const pending: Uint8Array[] = [];
    return {
      write: async (chunk) => void pending.push(chunk.slice()),
      // like OPFS: data only lands on close
      close: async () => void this.files.get(name)?.push(...pending.splice(0)),
    };
  }
  async *read(name: string) {
    for (const c of this.files.get(name) ?? []) yield c;
  }
  async readAll(name: string) {
    const f = this.files.get(name);
    if (!f) return null;
    const out = new Uint8Array(f.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of f) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
  async rename(from: string, to: string) {
    const f = this.files.get(from);
    if (!f) throw new Error(`no file ${from}`);
    this.files.set(to, f);
    this.files.delete(from);
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async list() {
    return [...this.files.keys()];
  }
}

/** Origin Private File System storage (browser). */
export class OpfsStorage implements ModelStorage {
  constructor(readonly dirName = "kiln-models") {}

  static available(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function";
  }

  private async dir(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(this.dirName, { create: true });
  }
  private async file(name: string, create = false): Promise<FileSystemFileHandle | null> {
    try {
      return await (await this.dir()).getFileHandle(name, { create });
    } catch {
      return null;
    }
  }
  async size(name: string) {
    const h = await this.file(name);
    return h ? (await h.getFile()).size : null;
  }
  async openWriter(name: string): Promise<StorageWriter> {
    const h = (await this.file(name, true))!;
    const size = (await h.getFile()).size;
    const w = await h.createWritable({ keepExistingData: true });
    await w.seek(size);
    return { write: (chunk) => w.write(chunk as Uint8Array<ArrayBuffer>), close: () => w.close() };
  }
  async *read(name: string) {
    const h = await this.file(name);
    if (!h) return;
    const reader = (await h.getFile()).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }
  async readAll(name: string) {
    const h = await this.file(name);
    return h ? new Uint8Array(await (await h.getFile()).arrayBuffer()) : null;
  }
  async rename(from: string, to: string) {
    const h = await this.file(from);
    if (!h) throw new Error(`no file ${from}`);
    const movable = h as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
    if (movable.move) {
      await this.remove(to);
      await movable.move(to);
      return;
    }
    await this.remove(to);
    const w = await this.openWriter(to);
    for await (const c of this.read(from)) await w.write(c);
    await w.close();
    await this.remove(from);
  }
  async remove(name: string) {
    try {
      await (await this.dir()).removeEntry(name);
    } catch {
      /* not there */
    }
  }
  async list() {
    const out: string[] = [];
    const d = (await this.dir()) as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
    for await (const k of d.keys()) out.push(k);
    return out;
  }
}

// ---- downloads ---------------------------------------------------------

export interface ModelSpec {
  id: string;
  /** where to fetch the GGUF from; kiln ships no URLs */
  url?: string;
  /** lowercase hex SHA-256 of the whole file */
  sha256: string;
  bytes?: number;
  tier?: TierId;
}

export class IntegrityError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`model file failed its integrity check (sha256 ${actual}, expected ${expected})`);
  }
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

export interface EnsureOptions {
  onProgress?: (loaded: number, total: number | null) => void;
  signal?: AbortSignal;
  /** commit the partial file every N bytes so a crash loses at most that much (default 8 MiB) */
  checkpointBytes?: number;
}

export class ModelManager {
  readonly storage: ModelStorage;
  private fetchFn: FetchLike | null;

  constructor(opts: { storage: ModelStorage; fetch?: FetchLike }) {
    this.storage = opts.storage;
    this.fetchFn = opts.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : null);
  }

  fileName(spec: ModelSpec) {
    return `${spec.id}.gguf`;
  }

  async isCached(spec: ModelSpec): Promise<boolean> {
    return (await this.storage.size(this.fileName(spec))) !== null;
  }

  /** Cached bytes, or null. Never touches the network. */
  async load(spec: ModelSpec): Promise<Uint8Array | null> {
    return this.storage.readAll(this.fileName(spec));
  }

  async remove(spec: ModelSpec) {
    await this.storage.remove(this.fileName(spec));
    await this.storage.remove(this.fileName(spec) + ".part");
  }

  async hash(name: string): Promise<string> {
    const h = new Sha256();
    for await (const c of this.storage.read(name)) h.update(c);
    return h.hex();
  }

  /** Re-hash a cached model. */
  async verify(spec: ModelSpec): Promise<boolean> {
    if (!(await this.isCached(spec))) return false;
    return (await this.hash(this.fileName(spec))) === spec.sha256.toLowerCase();
  }

  /**
   * Make sure the model is cached, downloading (or resuming a partial
   * download with a Range request) if needed, then return its bytes.
   */
  async ensure(spec: ModelSpec, opts: EnsureOptions = {}): Promise<Uint8Array> {
    const cached = await this.load(spec);
    if (cached) return cached;
    await this.download(spec, opts);
    return (await this.load(spec))!;
  }

  async download(spec: ModelSpec, opts: EnsureOptions = {}): Promise<void> {
    if (!spec.url) throw new Error(`model ${spec.id} has no download URL`);
    if (!this.fetchFn) throw new Error("no fetch available");
    const part = this.fileName(spec) + ".part";
    let have = (await this.storage.size(part)) ?? 0;
    if (spec.bytes !== undefined && have > spec.bytes) {
      await this.storage.remove(part);
      have = 0;
    }
    const complete = spec.bytes !== undefined && have === spec.bytes;
    if (!complete) {
      const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
      const res = await this.fetchFn(spec.url, { headers, signal: opts.signal });
      let total: number | null = spec.bytes ?? null;
      if (res.status === 416) {
        // nothing left to fetch: the part file is (claimed to be) complete
      } else if (res.status === 206 || res.status === 200) {
        if (res.status === 206) {
          const m = /bytes (\d+)-\d+\/(\d+|\*)/.exec(res.headers.get("content-range") ?? "");
          if (!m || Number(m[1]) !== have) throw new Error("server sent the wrong byte range");
          if (m[2] !== "*") total ??= Number(m[2]);
        } else {
          // server ignored the range: start over
          if (have > 0) await this.storage.remove(part);
          have = 0;
          const len = res.headers.get("content-length");
          if (len) total ??= Number(len);
        }
        if (!res.body) throw new Error("empty response body");
        await this.writeStream(part, res.body, have, total, opts);
      } else {
        throw new Error(`download of ${spec.id} failed: HTTP ${res.status}`);
      }
    }
    const size = (await this.storage.size(part)) ?? 0;
    if (spec.bytes !== undefined && size !== spec.bytes) throw new Error(`download of ${spec.id} is incomplete (${size} of ${spec.bytes} bytes)`);
    const actual = await this.hash(part);
    if (actual !== spec.sha256.toLowerCase()) {
      await this.storage.remove(part);
      throw new IntegrityError(spec.sha256.toLowerCase(), actual);
    }
    await this.storage.rename(part, this.fileName(spec));
  }

  private async writeStream(name: string, body: ReadableStream<Uint8Array>, start: number, total: number | null, opts: EnsureOptions) {
    const checkpoint = opts.checkpointBytes ?? 8 * 2 ** 20;
    let w = await this.storage.openWriter(name);
    let loaded = start;
    let sinceCheckpoint = 0;
    const reader = body.getReader();
    try {
      for (;;) {
        if (opts.signal?.aborted) throw new DOMException("download aborted", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        await w.write(value);
        loaded += value.length;
        sinceCheckpoint += value.length;
        opts.onProgress?.(loaded, total);
        if (sinceCheckpoint >= checkpoint) {
          await w.close();
          w = await this.storage.openWriter(name);
          sinceCheckpoint = 0;
        }
      }
    } finally {
      // keep what we have so the next attempt can resume
      await w.close();
    }
  }
}
