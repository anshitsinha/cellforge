/**
 * Saving workbooks, on this computer only.
 *
 * A workbook saves as a small JSON description (sheets, edits, formats...)
 * plus binary files for big things: the imported data's columns and a
 * sorted sheet's row order. The same pieces are written to the browser's
 * private file system (OPFS) for autosave, or packed into one `.cellforge`
 * file for Save / Open.
 *
 * Between snapshots every change is appended to a journal (the action that
 * ran, or "undo" / "redo"), so a crash loses nothing: on the next start the
 * last snapshot is loaded and the journal replayed through the same
 * actions, which also rebuilds undo.
 */
import type { Action } from "@cellforge/actions";
import { Table, type ColumnData } from "@cellforge/core";
import type { DataSource } from "@cellforge/grid";
import { SyntheticSource } from "./demo";
import { BlankSource, EditableSource, type SheetState } from "./editable";
import { Workbook, type Sheet } from "./workbook";
import type { Version } from "./versions";

export type BaseState =
  | { kind: "blank"; rows: number; cols: number }
  | { kind: "demo"; rows: number }
  | { kind: "table"; rows: number; columns: { name: string; kind: "number" | "string" }[] };

export interface WorkbookState {
  format: "cellforge";
  v: 1;
  name: string;
  active: string;
  bases: Record<string, BaseState>;
  sheets: SavedSheet[];
  /** defined names (added after v1 shipped) */
  names?: { name: string; formula: string; comment?: string }[];
  /** named versions (added after v1 shipped; missing means none) */
  versions?: { name: string; at: number; sheets: SavedSheet[] }[];
}

export interface SavedSheet {
  id: string;
  name: string;
  color?: string;
  hidden?: boolean;
  base: string;
  extra: number;
  state: SheetState;
}

export type FileData = Uint8Array | string;

export interface Packed {
  meta: WorkbookState;
  files: Map<string, FileData>;
}

export type JournalEntry = { op: "run"; action: Action } | { op: "undo" } | { op: "redo" };

// stable ids for base data, so a base is written once however often we save
const baseIds = new WeakMap<DataSource, string>();
let baseCounter = 0;
function baseIdOf(base: DataSource): string {
  let id = baseIds.get(base);
  if (!id) {
    id = `b${Date.now().toString(36)}${(baseCounter++).toString(36)}`;
    baseIds.set(base, id);
  }
  return id;
}

const bytesOf = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** File names for a base's columns. */
export const baseFile = (base: string, col: number, part: "data" | "dict") => `${base}-c${col}-${part}`;
export const orderFile = (sheet: string) => `order-${sheet}`;

/** A workbook as metadata plus files. */
export function packWorkbook(wb: Workbook, active: string, name: string): Packed {
  const files = new Map<string, FileData>();
  const bases: Record<string, BaseState> = {};
  const sheets: WorkbookState["sheets"] = [];
  const addBase = (base: DataSource): string => {
    const bid = baseIdOf(base);
    if (!bases[bid]) {
      if (base instanceof Table) {
        bases[bid] = { kind: "table", rows: base.rowCount, columns: base.columns.map((c) => ({ name: c.name, kind: c.kind })) };
        base.columns.forEach((c, i) => {
          if (c.kind === "number") files.set(baseFile(bid, i, "data"), bytesOf(c.values));
          else {
            files.set(baseFile(bid, i, "data"), bytesOf(c.codes));
            files.set(baseFile(bid, i, "dict"), JSON.stringify(c.dict));
          }
        });
      } else if (base instanceof SyntheticSource) bases[bid] = { kind: "demo", rows: base.rowCount };
      else if (base instanceof BlankSource) bases[bid] = { kind: "blank", rows: base.rowCount, cols: base.colCount };
      else throw new Error("This sheet's data can't be saved yet.");
    }
    return bid;
  };
  for (const s of wb.sheets) {
    const src = s.source;
    const bid = addBase(src.baseSource);
    const { state, binary } = src.toState();
    if (binary.order) files.set(orderFile(s.id), bytesOf(binary.order));
    sheets.push({
      id: s.id,
      name: s.name,
      ...(s.color ? { color: s.color } : {}),
      ...(s.hidden ? { hidden: true } : {}),
      base: bid,
      extra: src.extraColumnCount,
      state,
    });
  }
  const versions = wb.versions.map((v, i) => ({
    name: v.name,
    at: v.at,
    sheets: v.sheets.map((vs) => {
      if (vs.order) files.set(`v${i}-${orderFile(vs.id)}`, bytesOf(vs.order));
      return {
        id: vs.id,
        name: vs.name,
        ...(vs.color ? { color: vs.color } : {}),
        ...(vs.hidden ? { hidden: true } : {}),
        base: addBase(vs.base),
        extra: vs.extra,
        state: vs.state,
      };
    }),
  }));
  const names = wb.definedNames;
  return { meta: { format: "cellforge", v: 1, name, active, bases, sheets, ...(versions.length ? { versions } : {}), ...(names.length ? { names } : {}) }, files };
}

/** Rebuild a workbook from its metadata, reading files as needed. */
export async function unpackWorkbook(
  meta: WorkbookState,
  read: (name: string) => Promise<FileData>,
): Promise<{ workbook: Workbook; active: string; name: string }> {
  if (meta.format !== "cellforge" || meta.v !== 1) throw new Error("This isn't a cellforge workbook (or it's from a newer version).");
  const bases = new Map<string, DataSource>();
  for (const [bid, b] of Object.entries(meta.bases)) {
    let base: DataSource;
    if (b.kind === "blank") base = new BlankSource(b.rows, b.cols);
    else if (b.kind === "demo") base = new SyntheticSource(b.rows);
    else {
      const columns: ColumnData[] = [];
      for (let i = 0; i < b.columns.length; i++) {
        const c = b.columns[i];
        const data = await read(baseFile(bid, i, "data"));
        if (typeof data === "string") throw new Error("A data file is damaged.");
        if (c.kind === "number") columns.push({ kind: "number", name: c.name, values: new Float64Array(copyBuffer(data)) });
        else {
          const dict = JSON.parse((await read(baseFile(bid, i, "dict"))) as string) as string[];
          columns.push({ kind: "string", name: c.name, codes: new Uint32Array(copyBuffer(data)), dict });
        }
      }
      base = new Table(columns);
    }
    baseIds.set(base, bid);
    bases.set(bid, base);
  }
  const sheets: Sheet[] = [];
  for (const s of meta.sheets) {
    const base = bases.get(s.base);
    if (!base) throw new Error(`Sheet "${s.name}" is missing its data.`);
    let order: Uint32Array | undefined;
    if (s.state.order === "order") {
      const data = await read(orderFile(s.id));
      if (typeof data === "string") throw new Error("A data file is damaged.");
      order = new Uint32Array(copyBuffer(data));
    }
    const source = EditableSource.fromState(base, s.extra, s.state, { order });
    sheets.push({ id: s.id, name: s.name, source, ...(s.color ? { color: s.color } : {}), ...(s.hidden ? { hidden: true } : {}) });
  }
  const workbook = Workbook.restore(sheets);
  const versions: Version[] = [];
  for (const [i, v] of (meta.versions ?? []).entries()) {
    const vsheets: Version["sheets"] = [];
    for (const s of v.sheets) {
      const base = bases.get(s.base);
      if (!base) throw new Error(`Version "${v.name}" is missing its data.`);
      let order: Uint32Array | undefined;
      if (s.state.order === "order") {
        const data = await read(`v${i}-${orderFile(s.id)}`);
        if (typeof data === "string") throw new Error("A data file is damaged.");
        order = new Uint32Array(copyBuffer(data));
      }
      vsheets.push({ ...s, base, ...(order ? { order } : {}) });
    }
    versions.push({ name: v.name, at: v.at, sheets: vsheets });
  }
  workbook.versions = versions;
  if (meta.names?.length) workbook.restoreNames(meta.names);
  const active = workbook.has(meta.active) ? meta.active : workbook.sheets[0].id;
  return { workbook, active, name: meta.name };
}

// ---------------------------------------------------------------------------
// one file: "CELLFORGE 1\n", header length, header JSON, then the files' bytes

const MAGIC = "CELLFORGE 1\n";

export function toFile(p: Packed): Blob {
  const enc = new TextEncoder();
  const entries: { name: string; kind: "bin" | "text"; size: number }[] = [];
  const parts: Uint8Array[] = [];
  for (const [name, data] of p.files) {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    entries.push({ name, kind: typeof data === "string" ? "text" : "bin", size: bytes.byteLength });
    parts.push(bytes);
  }
  const header = enc.encode(JSON.stringify({ meta: p.meta, files: entries }));
  return new Blob([MAGIC, `${header.byteLength}\n`, header as BlobPart, ...(parts as BlobPart[])], { type: "application/x-cellforge" });
}

export function fromFile(buf: ArrayBuffer): Packed {
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("This isn't a cellforge file.");
  let at = MAGIC.length;
  const nl = bytes.indexOf(10, at);
  const len = Number(dec.decode(bytes.subarray(at, nl)));
  at = nl + 1;
  const header = JSON.parse(dec.decode(bytes.subarray(at, at + len))) as { meta: WorkbookState; files: { name: string; kind: "bin" | "text"; size: number }[] };
  at += len;
  const files = new Map<string, FileData>();
  for (const f of header.files) {
    const slice = bytes.subarray(at, at + f.size);
    files.set(f.name, f.kind === "text" ? dec.decode(slice) : slice);
    at += f.size;
  }
  return { meta: header.meta, files };
}

// ---------------------------------------------------------------------------
// storage: the browser's private file system, or memory (tests)

export interface Store {
  read(name: string): Promise<FileData | null>;
  write(name: string, data: FileData): Promise<void>;
  append(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export class MemoryStore implements Store {
  files = new Map<string, FileData>();
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async write(name: string, data: FileData) {
    this.files.set(name, typeof data === "string" ? data : data.slice());
  }
  async append(name: string, text: string) {
    this.files.set(name, ((this.files.get(name) as string | undefined) ?? "") + text);
  }
  async remove(name: string) {
    this.files.delete(name);
  }
  async list() {
    return [...this.files.keys()];
  }
}

const TEXT_FILES = /\.(json|ndjson)$|-dict$/;

export class OpfsStore implements Store {
  private constructor(private readonly dir: FileSystemDirectoryHandle) {}

  /** The autosave folder, or null where the browser has no private file system. */
  static async open(folder = "autosave"): Promise<OpfsStore | null> {
    try {
      const root = await navigator.storage.getDirectory();
      return new OpfsStore(await root.getDirectoryHandle(folder, { create: true }));
    } catch {
      return null;
    }
  }

  async read(name: string): Promise<FileData | null> {
    try {
      const file = await (await this.dir.getFileHandle(name)).getFile();
      return TEXT_FILES.test(name) ? await file.text() : new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(name: string, data: FileData): Promise<void> {
    const handle = await this.dir.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(data as FileSystemWriteChunkType);
    await w.close();
  }

  async append(name: string, text: string): Promise<void> {
    const handle = await this.dir.getFileHandle(name, { create: true });
    const size = (await handle.getFile()).size;
    const w = await handle.createWritable({ keepExistingData: true });
    await w.write({ type: "write", position: size, data: text });
    await w.close();
  }

  async remove(name: string): Promise<void> {
    try {
      await this.dir.removeEntry(name);
    } catch {
      // already gone
    }
  }

  async list(): Promise<string[]> {
    const names: string[] = [];
    for await (const key of (this.dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(key);
    return names;
  }
}

// ---------------------------------------------------------------------------
// autosave: snapshots + journal

const META = "workbook.json";
const JOURNAL = "journal.ndjson";

export class AutoSaver {
  private queue: Promise<unknown> = Promise.resolve();
  /** order arrays already on disk, so a snapshot only rewrites changed ones */
  private written = new WeakMap<Uint32Array, string>();
  private writtenBases = new Set<string>();
  /** journal entries since the last snapshot */
  pending = 0;

  constructor(readonly store: Store) {}

  /** Run storage work one piece at a time, in order. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Append one change to the journal. */
  record(entry: JournalEntry): Promise<void> {
    this.pending++;
    return this.enqueue(() => this.store.append(JOURNAL, JSON.stringify(entry) + "\n"));
  }

  /** Write the whole workbook and start a fresh journal. */
  snapshot(wb: Workbook, active: string, name: string): Promise<void> {
    // capture now (synchronously), write in the background
    const packed = packWorkbook(wb, active, name);
    const orders = new Map<string, Uint32Array>();
    for (const s of wb.sheets) {
      const order = s.source.rowOrder;
      if (order?.isArray) orders.set(orderFile(s.id), order.toArray());
    }
    this.pending = 0;
    return this.enqueue(async () => {
      const keep = new Set<string>([META, JOURNAL]);
      for (const [file, data] of packed.files) {
        keep.add(file);
        const isBase = /^b[0-9a-z]+-c\d+-/.test(file);
        if (isBase && this.writtenBases.has(file)) continue;
        const order = orders.get(file);
        if (order && this.written.get(order) === file) continue;
        await this.store.write(file, data);
        if (isBase) this.writtenBases.add(file);
        if (order) this.written.set(order, file);
      }
      await this.store.write(META, JSON.stringify(packed.meta));
      await this.store.write(JOURNAL, "");
      for (const f of await this.store.list()) if (!keep.has(f)) await this.store.remove(f);
    });
  }

  /** Wait for everything queued to reach storage. */
  flush(): Promise<unknown> {
    return this.queue;
  }

  /** The last snapshot and the journal after it, or null if nothing was saved. */
  static async load(store: Store): Promise<{ workbook: Workbook; active: string; name: string; journal: JournalEntry[] } | null> {
    const meta = await store.read(META);
    if (typeof meta !== "string" || !meta) return null;
    const restored = await unpackWorkbook(JSON.parse(meta) as WorkbookState, async (name) => {
      const data = await store.read(name);
      if (data === null) throw new Error(`Missing saved file ${name}.`);
      return data;
    });
    const text = ((await store.read(JOURNAL)) as string | null) ?? "";
    const journal: JournalEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        journal.push(JSON.parse(line) as JournalEntry);
      } catch {
        break; // a half-written last line from a crash: stop there
      }
    }
    return { ...restored, journal };
  }
}
