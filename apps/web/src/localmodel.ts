/**
 * The local AI model: one place that knows whether a model is kept in this
 * browser, downloading, loading or ready, and tells whoever listens.
 *
 * A model gets here two ways, both started by the user:
 * - a .gguf file they pick from their disk (`installModel`), or
 * - a download from the catalog (`downloadModel`), streamed straight into
 *   the browser's private storage (OPFS) with progress, pause, resume (HTTP
 *   Range requests) and cancel, then checked against its exact size and
 *   SHA-256 before it's used.
 *
 * Either way the file is kept in OPFS and read into memory once, when it
 * loads; the model that was loaded before is released first. It runs on this
 * computer with kiln (graphics card when the browser has WebGPU, otherwise
 * the processor). Nothing is ever sent anywhere; the only network use is a
 * download the user starts.
 */
import { detectHardware, IntegrityError, Kiln, ModelManager, OpfsStorage, type FetchLike, type HardwareInfo, type LoadOptions, type ModelStorage } from "@cellforge/kiln";
import { formatBytes, modelByFile, type CatalogModel } from "./aimodels";

export interface LoadedModel {
  /** what people see: the catalog name, or the file name */
  name: string;
  /** the file in the browser's storage (or the picked file's name) */
  file: string;
  size: number;
  kiln: Kiln;
  /** where it runs */
  backend: "GPU" | "CPU";
  /** from a short warm-up when it loaded; null when it couldn't be measured */
  tokensPerSecond: number | null;
  /** the graphics card failed and it fell back to the processor */
  gpuFailed: boolean;
}

export type AiState = "none" | "stored" | "downloading" | "paused" | "loading" | "ready" | "error";

export interface StoredModel {
  file: string;
  name: string;
  bytes: number;
  /** a download that hasn't finished (file.gguf.part) */
  partial: boolean;
  catalogId: string | null;
}

export interface AiStatus {
  state: AiState;
  /** a few words for a tooltip or chip: "Ready: Qwen2.5 1.5B Instruct (GPU)" */
  label: string;
  ready: Omit<LoadedModel, "kiln"> | null;
  /** models kept in this browser, finished or not */
  stored: StoredModel[];
  download: { id: string; name: string; loaded: number; total: number; paused: boolean; phase: "downloading" | "checking" } | null;
  loading: { name: string; step: string } | null;
  /** the last thing that went wrong, in plain words (cleared by the next action) */
  error: string | null;
}

export interface LocalAiDeps {
  /** where models are kept; null when the browser can't keep files */
  storage: () => ModelStorage | null;
  /** turn GGUF bytes into a runnable model */
  load: (bytes: Uint8Array, opts?: LoadOptions) => Promise<Kiln>;
  /** only used by downloads the user starts */
  fetch: FetchLike | null;
  hardware: () => Promise<HardwareInfo>;
  /** the model to load next time */
  prefs: { get(): string | null; set(file: string | null): void };
  /** ask the browser not to evict stored models */
  persist?: () => Promise<unknown>;
}

export class SizeMismatchError extends Error {
  constructor(site: string, got: number, expected: number) {
    super(`The file on ${site} is ${formatBytes(got)}, not the ${formatBytes(expected)} expected, so it may have been replaced. Nothing was kept.`);
    this.name = "SizeMismatchError";
  }
}

/** Plain words for whatever went wrong. */
export function humanError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  const msg = err?.message ?? String(e);
  if (e instanceof IntegrityError)
    return "The downloaded file didn't match the published one (its fingerprint differs), so it was thrown away. Try the download again; if it keeps happening, the file on the site has changed.";
  if (e instanceof SizeMismatchError) return e.message;
  if (err?.name === "QuotaExceededError" || /quota/i.test(msg)) return "There isn't enough free storage for this site. Free some disk space or remove another model, then try again.";
  if (e instanceof RangeError || /allocation failed|out of memory|array buffer|invalid array length/i.test(msg))
    return "This computer ran out of memory loading the model. Close other tabs or programs, or pick a smaller model.";
  const arch = /architecture "([^"]+)" is not supported/.exec(msg);
  if (arch) return `This model's design (${arch[1]}) isn't one the built-in AI runs. Pick a Qwen2, Llama or Mistral model, or one from the list.`;
  const type = /type (\w+) is not supported|unsupported type (\w+)/.exec(msg);
  if (type) return `This model file is compressed in a way the built-in AI can't run yet (${type[1] ?? type[2]}). Look for a Q4_K_M, Q4_0 or Q8_0 version of it, or pick one from the list.`;
  if (/GGUF/i.test(msg)) return "That file isn't a GGUF model file the built-in AI can read. Model files end in .gguf.";
  if (/tokenizer/i.test(msg)) return "This model's vocabulary format isn't supported. Pick a Qwen2, Llama or Mistral model, or one from the list.";
  const http = /HTTP (\d+)/.exec(msg);
  if (http) {
    const code = Number(http[1]);
    if (code === 404) return "The download site no longer has this file (404). Nothing was kept.";
    if (code === 429) return "The download site is busy and asked us to slow down. Wait a minute, then press Resume.";
    return `The download site answered with an error (HTTP ${code}). Press Resume to try again.`;
  }
  if (err?.name === "TypeError" && /fetch|network|load failed/i.test(msg))
    return "The download stopped: the connection dropped or the site couldn't be reached. Press Resume to carry on from where it stopped.";
  if (/incomplete|wrong byte range/.test(msg)) return "The download ended early. Press Resume to carry on from where it stopped.";
  return msg.replace(/^kiln: /, "");
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";


/** Errors that would happen on the CPU too: no point retrying there. */
const fileProblem = (e: unknown) => e instanceof RangeError || /GGUF|architecture|not supported|unsupported|tokenizer|missing|dims|values, expected/i.test((e as Error)?.message ?? "");

/** A fetch that checks the server is sending the file we expect, by size. */
function sizeChecked(f: FetchLike, site: string, expected: number): FetchLike {
  return async (url, init) => {
    const res = await f(url, init);
    let total: number | null = null;
    if (res.status === 206) {
      const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
      if (m) total = Number(m[1]);
    } else if (res.status === 200) {
      const len = res.headers.get("content-length");
      if (len) total = Number(len);
    }
    if (total !== null && total !== expected) {
      void res.body?.cancel().catch(() => undefined);
      throw new SizeMismatchError(site, total, expected);
    }
    return res;
  };
}

type Download = NonNullable<AiStatus["download"]> & { file: string; ctrl: AbortController; cancelled: boolean };

export class LocalAi {
  private current: LoadedModel | null = null;
  private stored: StoredModel[] = [];
  private download: Download | null = null;
  private loading: AiStatus["loading"] = null;
  private error: string | null = null;
  private listeners = new Set<(s: AiStatus) => void>();
  private loadSeq = 0;
  private restoring: Promise<LoadedModel | null> | null = null;
  private scanned: Promise<void> | null = null;
  private lastPermille = -1;
  /** loading the kept model on its own failed once this session: don't keep retrying */
  private autoRestoreFailed = false;

  /** display names of files downloaded this session (catalog entries)*/
  private names = new Map<string, string>();

  constructor(private deps: LocalAiDeps) {}

  private nameOf(file: string): string {
    return this.names.get(file) ?? modelByFile(file)?.name ?? file;
  }

  // ---- status ----------------------------------------------------------

  status(): AiStatus {
    const d = this.download;
    const state: AiState = this.loading
      ? "loading"
      : d && !d.paused
        ? "downloading"
        : this.current
          ? "ready"
          : this.error
            ? "error"
            : d?.paused || this.stored.some((s) => s.partial)
              ? "paused"
              : this.stored.length
                ? "stored"
                : "none";
    const pct = d && d.total ? Math.floor((d.loaded / d.total) * 100) : 0;
    let label: string;
    switch (state) {
      case "loading":
        label = `Loading ${this.loading!.name}…`;
        break;
      case "downloading":
        label = d!.phase === "checking" ? `Checking ${d!.name}…` : `Downloading ${d!.name}… ${pct}%`;
        break;
      case "ready":
        label = `Ready: ${this.current!.name} (${this.current!.backend})`;
        break;
      case "error":
        label = "The local AI needs attention";
        break;
      case "paused":
        label = "Model download paused";
        break;
      case "stored":
        label = `${this.nameOf(this.preferred() ?? this.stored[0].file)} is kept here; it loads when needed`;
        break;
      default:
        label = "No AI model yet";
    }
    let ready: AiStatus["ready"] = null;
    if (this.current) {
      const { kiln: _kiln, ...rest } = this.current;
      ready = rest;
    }
    return {
      state,
      label,
      ready,
      stored: this.stored.map((s) => ({ ...s })),
      download: d ? { id: d.id, name: d.name, loaded: d.loaded, total: d.total, paused: d.paused, phase: d.phase } : null,
      loading: this.loading ? { ...this.loading } : null,
      error: this.error,
    };
  }

  subscribe(cb: (s: AiStatus) => void): () => void {
    this.listeners.add(cb);
    void this.scan();
    return () => void this.listeners.delete(cb);
  }

  private emit() {
    const s = this.status();
    for (const cb of [...this.listeners]) cb(s);
  }

  loaded(): LoadedModel | null {
    return this.current;
  }

  private preferred(): string | null {
    const p = this.deps.prefs.get();
    return p && this.stored.some((s) => s.file === p && !s.partial) ? p : null;
  }

  /** Look at what's kept in storage (no network). */
  scan(force = false): Promise<void> {
    if (force) this.scanned = null;
    this.scanned ??= (async () => {
      const store = this.deps.storage();
      if (!store) return;
      const out: StoredModel[] = [];
      try {
        for (const n of await store.list()) {
          const partial = n.endsWith(".gguf.part");
          if (!partial && !/\.gguf$/i.test(n)) continue;
          const file = partial ? n.slice(0, -5) : n;
          const cat = modelByFile(file);
          out.push({ file, name: cat?.name ?? file, bytes: (await store.size(n)) ?? 0, partial, catalogId: cat?.id ?? null });
        }
      } catch {
        /* storage blocked: treat as empty */
      }
      this.stored = out.sort((a, b) => a.name.localeCompare(b.name));
      this.emit();
    })();
    return this.scanned;
  }

  // ---- loading ---------------------------------------------------------

  /** Drop the loaded model (and its GPU memory) before loading another, so two are never held at once. */
  private release() {
    const old = this.current;
    this.current = null;
    try {
      old?.kiln.dispose?.();
    } catch {
      /* already gone */
    }
  }

  private async loadBytes(bytes: Uint8Array, file: string, seq: number): Promise<LoadedModel | null> {
    const name = this.nameOf(file);
    this.loading = { name, step: "Preparing the model…" };
    this.emit();
    let kiln: Kiln;
    let gpuFailed = false;
    try {
      kiln = await this.deps.load(bytes, { backend: "auto" });
    } catch (e) {
      if (fileProblem(e)) throw e;
      // the graphics card failed (out of GPU memory, device lost): the processor still works
      kiln = await this.deps.load(bytes, { backend: "cpu" });
      gpuFailed = true;
    }
    if (seq !== this.loadSeq) {
      kiln.dispose?.();
      return null;
    }
    this.loading = { name, step: "Measuring its speed…" };
    this.emit();
    let tokensPerSecond: number | null = null;
    try {
      const r = await kiln.generate("Hello", { maxTokens: 3 });
      tokensPerSecond = r.tokensPerSecond > 0 ? r.tokensPerSecond : null;
      kiln.reset();
    } catch {
      /* speed unknown; the model still works */
    }
    if (seq !== this.loadSeq) {
      kiln.dispose?.();
      return null;
    }
    this.current = { name, file, size: bytes.length, kiln, backend: kiln.backend?.name === "webgpu" ? "GPU" : "CPU", tokensPerSecond, gpuFailed };
    this.loading = null;
    this.error = null;
    this.deps.prefs.set(file);
    this.emit();
    return this.current;
  }

  /** Load a model kept in storage: read once, then hand the bytes to kiln. */
  async useStored(file: string): Promise<LoadedModel | null> {
    const seq = ++this.loadSeq;
    const store = this.deps.storage();
    if (!store) throw new Error("This browser can't keep files for websites (a private window?), so there's no stored model.");
    this.release();
    this.error = null;
    this.loading = { name: this.nameOf(file), step: "Reading the model file…" };
    this.emit();
    try {
      const bytes = await store.readAll(file);
      if (!bytes) throw new Error(`${file} isn't kept in this browser any more.`);
      return await this.loadBytes(bytes, file, seq);
    } catch (e) {
      if (seq === this.loadSeq) {
        this.loading = null;
        this.error = humanError(e);
        this.emit();
      }
      throw e;
    }
  }

  /** The model kept from last time, loaded when first needed. Never downloads. */
  restore(): Promise<LoadedModel | null> {
    if (this.current) return Promise.resolve(this.current);
    if (this.loading || (this.download && !this.download.paused) || this.autoRestoreFailed) return Promise.resolve(null);
    this.restoring ??= (async () => {
      await this.scan();
      const file = this.preferred() ?? this.stored.find((s) => !s.partial)?.file;
      if (!file) return null;
      return this.useStored(file);
    })()
      .catch(() => {
        this.autoRestoreFailed = true;
        return null;
      })
      .finally(() => (this.restoring = null));
    return this.restoring;
  }

  /** Keep a picked .gguf file in this browser and load it (the file is read into memory once). */
  async install(file: File): Promise<LoadedModel> {
    const fail = (m: string) => {
      this.error = m;
      this.emit();
      return new Error(m);
    };
    if (!/\.gguf$/i.test(file.name)) throw fail("Pick a .gguf model file.");
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (String.fromCharCode(...head) !== "GGUF") throw fail(humanError(new Error("not a GGUF file")));
    const store = this.deps.storage();
    const seq = ++this.loadSeq;
    this.release();
    this.error = null;
    const name = this.nameOf(file.name);
    try {
      if (!store) {
        // no storage: load for this session only
        this.loading = { name, step: "Reading the model file…" };
        this.emit();
        const m = await this.loadBytes(new Uint8Array(await file.arrayBuffer()), file.name, seq);
        if (!m) throw new DOMException("replaced by another model", "AbortError");
        return m;
      }
      this.loading = { name, step: "Keeping a copy in this browser… 0%" };
      this.emit();
      await store.remove(file.name);
      const w = await store.openWriter(file.name);
      const reader = file.stream().getReader();
      let done = 0;
      let shown = 0;
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          await w.write(value);
          done += value.length;
          const pct = Math.floor((done / Math.max(1, file.size)) * 100);
          if (pct !== shown) {
            shown = pct;
            this.loading = { name, step: `Keeping a copy in this browser… ${pct}%` };
            this.emit();
          }
        }
      } finally {
        await w.close();
      }
      await this.scan(true);
      if (seq !== this.loadSeq) throw new DOMException("replaced by another model", "AbortError");
      const m = await this.useStored(file.name);
      if (!m) throw new DOMException("replaced by another model", "AbortError");
      return m;
    } catch (e) {
      if (seq === this.loadSeq) {
        this.loading = null;
        this.error = humanError(e);
        this.emit();
      }
      throw e;
    }
  }

  /** Unload the model (it stays stored). */
  unload() {
    this.loadSeq++;
    this.release();
    this.loading = null;
    this.emit();
  }

  /** Delete a stored model (and any partial download of it). */
  async remove(file: string): Promise<void> {
    const store = this.deps.storage();
    if (this.current?.file === file) this.unload();
    if (this.download?.file === file) await this.cancel();
    if (store) {
      await store.remove(file);
      await store.remove(file + ".part");
    }
    if (this.deps.prefs.get() === file) this.deps.prefs.set(null);
    this.error = null;
    await this.scan(true);
  }

  /** Forget every model. */
  async removeAll(): Promise<void> {
    await this.scan(true);
    for (const s of this.stored) await this.remove(s.file);
    this.unload();
  }

  // ---- downloads -------------------------------------------------------

  /**
   * Download a catalog model into storage (resuming a partial download),
   * check it, then load it. Only ever called from a button the user pressed.
   */
  async downloadModel(m: CatalogModel): Promise<LoadedModel | null> {
    if (this.download && !this.download.paused) return null;
    const store = this.deps.storage();
    this.error = null;
    if (!store || !this.deps.fetch) {
      this.error = !store
        ? "This browser can't keep files for websites (a private window, or site storage turned off), so a model can't be downloaded here. You can still pick a .gguf file you already have."
        : "This browser can't download files from here.";
      this.emit();
      return null;
    }
    const part = `${m.file}.part`;
    const have = Math.min((await store.size(part)) ?? 0, m.bytes);
    try {
      const hw = await this.deps.hardware();
      const need = m.bytes - have;
      if (hw.storageAvailableBytes !== null && hw.storageAvailableBytes < need + 64 * 2 ** 20) {
        this.error = `There isn't enough free storage for this site: the model needs ${formatBytes(need)} and about ${formatBytes(Math.max(0, hw.storageAvailableBytes))} is free. Free some disk space or remove another model.`;
        this.emit();
        return null;
      }
    } catch {
      /* unknown: try anyway */
    }
    await this.deps.persist?.().catch(() => undefined);
    this.names.set(m.file, m.name);
    const dl: Download = { id: m.id, file: m.file, name: m.name, loaded: have, total: m.bytes, paused: false, phase: have >= m.bytes ? "checking" : "downloading", ctrl: new AbortController(), cancelled: false };
    this.download = dl;
    this.lastPermille = -1;
    this.emit();
    const mgr = new ModelManager({ storage: store, fetch: sizeChecked(this.deps.fetch, m.site, m.bytes) });
    try {
      await mgr.download(
        { id: m.file.replace(/\.gguf$/, ""), url: m.url, sha256: m.sha256, bytes: m.bytes },
        {
          signal: dl.ctrl.signal,
          onProgress: (loaded) => {
            dl.loaded = loaded;
            if (loaded >= m.bytes) dl.phase = "checking";
            const pm = Math.floor((loaded / m.bytes) * 1000);
            if (pm !== this.lastPermille) {
              this.lastPermille = pm;
              this.emit();
            }
          },
        },
      );
    } catch (e) {
      if (this.download !== dl) return null;
      if (dl.cancelled) {
        await store.remove(part);
        this.download = null;
      } else if (isAbort(e) || dl.ctrl.signal.aborted) {
        dl.paused = true;
        dl.loaded = (await store.size(part)) ?? dl.loaded;
      } else {
        // keep a partial file to resume from, unless the file itself is wrong
        if (e instanceof SizeMismatchError || e instanceof IntegrityError) await store.remove(part);
        const kept = (await store.size(part)) ?? 0;
        this.download = kept > 0 ? { ...dl, loaded: kept, paused: true, phase: "downloading" } : null;
        this.error = humanError(e);
      }
      await this.scan(true);
      this.emit();
      return null;
    }
    this.download = null;
    this.loading = { name: m.name, step: "Reading the model file…" };
    await this.scan(true);
    return this.useStored(m.file).catch(() => null);
  }

  /** Stop the download but keep what's arrived; downloadModel() again resumes it. */
  pause() {
    if (this.download && !this.download.paused) this.download.ctrl.abort();
  }

  /** Stop the download (or a paused one) and delete what's arrived. */
  async cancel(): Promise<void> {
    const d = this.download;
    if (d && !d.paused) {
      d.cancelled = true;
      d.ctrl.abort();
      return;
    }
    this.download = null;
    const file = d?.file;
    if (file) await this.deps.storage()?.remove(`${file}.part`);
    this.error = null;
    await this.scan(true);
  }

  /** Delete the partial download of a catalog model (also one left from an earlier visit). */
  async discardPartial(m: CatalogModel): Promise<void> {
    if (this.download?.id === m.id) return this.cancel();
    await this.deps.storage()?.remove(`${m.file}.part`);
    await this.scan(true);
  }

  clearError() {
    if (!this.error) return;
    this.error = null;
    this.emit();
  }
}

// ---- the app's instance ---------------------------------------------------

const PREF_KEY = "cellforge.ai.model";

const browserFetch: FetchLike | null =
  typeof fetch === "function"
    ? (url, init) =>
        // no cookies, no referrer, and not into the HTTP cache (the file goes to OPFS, once)
        fetch(url, { headers: init?.headers, signal: init?.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" })
    : null;

let hw: Promise<HardwareInfo> | null = null;
/** What this computer can run (asked once; free storage is re-read each time). */
export function cachedHardware(): Promise<HardwareInfo> {
  hw ??= detectHardware();
  return hw.then(async (h) => {
    try {
      const e = await navigator.storage?.estimate?.();
      return e?.quota !== undefined ? { ...h, storageAvailableBytes: e.quota - (e.usage ?? 0) } : h;
    } catch {
      return h;
    }
  });
}

export const localAi = new LocalAi({
  storage: () => (OpfsStorage.available() ? new OpfsStorage("kiln-models") : null),
  load: (bytes, opts) => Kiln.load(bytes, opts),
  fetch: browserFetch,
  hardware: () => cachedHardware(),
  prefs: {
    get: () => {
      try {
        return localStorage.getItem(PREF_KEY);
      } catch {
        return null;
      }
    },
    set: (v) => {
      try {
        if (v) localStorage.setItem(PREF_KEY, v);
        else localStorage.removeItem(PREF_KEY);
      } catch {
        /* storage blocked */
      }
    },
  },
  persist: async () => navigator.storage?.persist?.(),
});

export const loadedModel = (): LoadedModel | null => localAi.loaded();
/** The local AI's state right now. */
export const aiStatus = (): AiStatus => localAi.status();
/** Be told whenever the local AI's state changes; returns an unsubscribe function. */
export const onAiStatus = (cb: (s: AiStatus) => void): (() => void) => localAi.subscribe(cb);

/**
 * The model for the features that use it (ask bar, explain, categorise,
 * spelling variants): the loaded one, or null while one kept from last time
 * starts loading in the background.
 */
export function currentModel(): Kiln | null {
  const m = localAi.loaded();
  if (!m) void localAi.restore();
  return m?.kiln ?? null;
}

/** Keep a picked model file and load it. */
export const installModel = (file: File): Promise<LoadedModel> => localAi.install(file);

/** The model kept from last time, loaded when first needed. */
export const restoreModel = (): Promise<LoadedModel | null> => localAi.restore();

/** Forget every model (and its stored copy). */
export const removeModel = (): Promise<void> => localAi.removeAll();

/** A model file to pick. */
export function pickModelFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".gguf" });
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}
