/**
 * A Parquet reader for flat tables: plain and dictionary encodings, data
 * pages v1 and v2, uncompressed / Snappy / gzip, the common physical and
 * logical types. No library: Thrift's compact protocol, Snappy and the
 * RLE/bit-packed levels are small enough to write here.
 */
import type { ColumnData } from "./columns";

// ---------------------------------------------------------------- thrift

type TValue = number | bigint | boolean | Uint8Array | TValue[] | TStruct;
interface TStruct {
  [field: number]: TValue;
}

class Thrift {
  pos = 0;
  constructor(private readonly b: Uint8Array) {}

  private byte(): number {
    return this.b[this.pos++];
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const x = this.byte();
      result += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) return result;
      shift += 7;
    }
  }

  private varbig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const x = this.byte();
      result |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return result;
      shift += 7n;
    }
  }

  private zigzag(): number {
    const n = this.varint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  private value(type: number): TValue {
    switch (type) {
      case 1:
        return true;
      case 2:
        return false;
      case 3:
        return (this.byte() << 24) >> 24;
      case 4:
      case 5:
        return this.zigzag();
      case 6: {
        const z = this.varbig();
        const v = z & 1n ? -((z + 1n) >> 1n) : z >> 1n;
        return Number(v);
      }
      case 7: {
        const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, 8).getFloat64(0, true);
        this.pos += 8;
        return v;
      }
      case 8: {
        const n = this.varint();
        const out = this.b.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
      }
      case 9:
      case 10: {
        const h = this.byte();
        let size = h >> 4;
        const t = h & 0x0f;
        if (size === 15) size = this.varint();
        const out: TValue[] = [];
        for (let i = 0; i < size; i++) out.push(t === 1 || t === 2 ? this.byte() === 1 : this.value(t));
        return out;
      }
      case 11: {
        const size = this.varint();
        if (size === 0) return [];
        const kv = this.byte();
        for (let i = 0; i < size; i++) {
          this.value(kv >> 4);
          this.value(kv & 0x0f);
        }
        return [];
      }
      case 12:
        return this.struct();
      default:
        throw new Error(`Damaged Parquet metadata (type ${type}).`);
    }
  }

  struct(): TStruct {
    const out: TStruct = {};
    let last = 0;
    for (;;) {
      const h = this.byte();
      if (h === 0) return out;
      const delta = h >> 4;
      const type = h & 0x0f;
      const id = delta ? last + delta : this.zigzag();
      last = id;
      out[id] = this.value(type);
    }
  }
}

// ---------------------------------------------------------------- snappy

export function unsnappy(src: Uint8Array): Uint8Array {
  let p = 0;
  let len = 0;
  let shift = 0;
  for (;;) {
    const x = src[p++];
    len += (x & 0x7f) * 2 ** shift;
    if (!(x & 0x80)) break;
    shift += 7;
  }
  const out = new Uint8Array(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const kind = tag & 3;
    if (kind === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n |= src[p++] << (8 * i);
      }
      n += 1;
      out.set(src.subarray(p, p + n), o);
      p += n;
      o += n;
      continue;
    }
    let length: number;
    let offset: number;
    if (kind === 1) {
      length = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | src[p++];
    } else if (kind === 2) {
      length = (tag >> 2) + 1;
      offset = src[p] | (src[p + 1] << 8);
      p += 2;
    } else {
      length = (tag >> 2) + 1;
      offset = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
      p += 4;
    }
    // byte by byte: copies may overlap their own output
    for (let i = 0; i < length; i++, o++) out[o] = out[o - offset];
  }
  return out;
}

async function inflate(data: Uint8Array, format: "gzip"): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format) as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ------------------------------------------------------------ RLE / bits

/** Parquet's RLE / bit-packed hybrid: `count` values of `width` bits. */
export function rleHybrid(b: Uint8Array, pos: number, end: number, width: number, count: number): number[] {
  const out: number[] = [];
  const bytesPer = Math.ceil(width / 8);
  while (out.length < count && pos < end) {
    let header = 0;
    let shift = 0;
    for (;;) {
      const x = b[pos++];
      header += (x & 0x7f) * 2 ** shift;
      if (!(x & 0x80)) break;
      shift += 7;
    }
    if (header & 1) {
      const groups = header >>> 1;
      const total = groups * 8;
      let bitPos = 0;
      for (let i = 0; i < total; i++) {
        let v = 0;
        for (let k = 0; k < width; k++, bitPos++) {
          const byte = b[pos + (bitPos >> 3)];
          if ((byte >> (bitPos & 7)) & 1) v |= 1 << k;
        }
        if (out.length < count) out.push(v);
      }
      pos += groups * width;
    } else {
      const run = header >>> 1;
      let v = 0;
      for (let i = 0; i < bytesPer; i++) v |= b[pos++] << (8 * i);
      for (let i = 0; i < run && out.length < count; i++) out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------- values

interface Leaf {
  name: string;
  type: number;
  typeLength: number;
  optional: boolean;
  /** how to show it: text, a date / timestamp (as an Excel serial), decimal scale */
  kind: "text" | "number" | "bool" | "date" | "timestamp";
  scale: number;
  /** timestamp unit: 1 ms, 1000 µs, 1e6 ns per ms */
  perMs: number;
}

const EXCEL_EPOCH_DAYS = 25569; // 1970-01-01 as an Excel serial

function plain(leaf: Leaf, b: Uint8Array, pos: number, count: number): { values: (number | string | boolean)[]; pos: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const values: (number | string | boolean)[] = [];
  const dec = new TextDecoder();
  switch (leaf.type) {
    case 0:
      for (let i = 0; i < count; i++) values.push(((b[pos + (i >> 3)] >> (i & 7)) & 1) === 1);
      return { values, pos: pos + Math.ceil(count / 8) };
    case 1:
      for (let i = 0; i < count; i++, pos += 4) values.push(dv.getInt32(pos, true));
      return { values, pos };
    case 2:
      for (let i = 0; i < count; i++, pos += 8) values.push(Number(dv.getBigInt64(pos, true)));
      return { values, pos };
    case 3:
      // INT96: nanoseconds of the day, then the Julian day
      for (let i = 0; i < count; i++, pos += 12) {
        const nanos = Number(dv.getBigInt64(pos, true));
        const julian = dv.getInt32(pos + 8, true);
        values.push((julian - 2_440_588) * 86_400_000 + nanos / 1e6); // ms since 1970
      }
      return { values, pos };
    case 4:
      for (let i = 0; i < count; i++, pos += 4) values.push(dv.getFloat32(pos, true));
      return { values, pos };
    case 5:
      for (let i = 0; i < count; i++, pos += 8) values.push(dv.getFloat64(pos, true));
      return { values, pos };
    case 6:
      for (let i = 0; i < count; i++) {
        const n = dv.getUint32(pos, true);
        pos += 4;
        const bytes = b.subarray(pos, pos + n);
        pos += n;
        values.push(leaf.kind === "number" ? decimalOf(bytes, leaf.scale) : dec.decode(bytes));
      }
      return { values, pos };
    case 7:
      for (let i = 0; i < count; i++, pos += leaf.typeLength) {
        const bytes = b.subarray(pos, pos + leaf.typeLength);
        values.push(leaf.kind === "number" ? decimalOf(bytes, leaf.scale) : dec.decode(bytes));
      }
      return { values, pos };
    default:
      throw new Error(`Unsupported Parquet type ${leaf.type}.`);
  }
}

/** A big-endian two's-complement decimal. */
function decimalOf(bytes: Uint8Array, scale: number): number {
  let v = 0n;
  for (const x of bytes) v = (v << 8n) | BigInt(x);
  if (bytes.length && bytes[0] & 0x80) v -= 1n << BigInt(bytes.length * 8);
  return Number(v) / 10 ** scale;
}

/** A raw value as the cell shows it. */
function shown(leaf: Leaf, v: number | string | boolean): number | string {
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  if (leaf.kind === "date") return v + EXCEL_EPOCH_DAYS;
  if (leaf.kind === "timestamp") return v / leaf.perMs / 86_400_000 + EXCEL_EPOCH_DAYS;
  if (leaf.type === 1 && leaf.scale) return v / 10 ** leaf.scale;
  if (leaf.type === 2 && leaf.scale) return v / 10 ** leaf.scale;
  return v;
}

// ----------------------------------------------------------------- read

export interface ParquetResult {
  columns: ColumnData[];
  /** columns holding dates or date-times, to format as such */
  dateColumns: { col: number; withTime: boolean }[];
}

const PAR1 = 0x31524150;

export async function readParquet(buf: ArrayBuffer | Uint8Array): Promise<ParquetResult> {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12 || dv.getUint32(0, true) !== PAR1 || dv.getUint32(b.length - 4, true) !== PAR1) throw new Error("This isn't a Parquet file.");
  const metaLen = dv.getUint32(b.length - 8, true);
  const meta = new Thrift(b.subarray(b.length - 8 - metaLen, b.length - 8)).struct();
  const schema = (meta[2] as TStruct[]) ?? [];
  const numRows = Number(meta[3] ?? 0);
  const dec = new TextDecoder();
  const leaves: Leaf[] = [];
  for (const el of schema.slice(1)) {
    if (el[5] !== undefined && Number(el[5]) > 0) throw new Error("Nested Parquet columns aren't supported yet; flatten the file first.");
    if (Number(el[3] ?? 0) === 2) throw new Error("Repeated (list) Parquet columns aren't supported yet.");
    const type = Number(el[1]);
    const converted = el[6] !== undefined ? Number(el[6]) : -1;
    const logical = el[10] as TStruct | undefined;
    let kind: Leaf["kind"] = type === 6 || type === 7 ? "text" : type === 0 ? "bool" : "number";
    let perMs = 1;
    let scale = Number(el[7] ?? 0);
    if (converted === 6 || logical?.[6]) kind = "date";
    if (converted === 9 || converted === 10 || logical?.[8] || type === 3) {
      kind = "timestamp";
      const unit = (logical?.[8] as TStruct | undefined)?.[2] as TStruct | undefined;
      perMs = converted === 10 || unit?.[2] ? 1000 : unit?.[3] ? 1e6 : 1;
    }
    if (converted === 5 || logical?.[5]) {
      kind = "number";
      const d = logical?.[5] as TStruct | undefined;
      if (d?.[1] !== undefined) scale = Number(d[1]);
    }
    leaves.push({ name: dec.decode(el[4] as Uint8Array), type, typeLength: Number(el[2] ?? 0), optional: Number(el[3] ?? 0) === 1, kind, scale, perMs });
  }

  const values: (number | string | null)[][] = leaves.map(() => []);
  for (const rg of (meta[4] as TStruct[]) ?? []) {
    const chunks = rg[1] as TStruct[];
    for (let c = 0; c < chunks.length && c < leaves.length; c++) {
      const leaf = leaves[c];
      const md = chunks[c][3] as TStruct;
      const codec = Number(md[4] ?? 0);
      const numValues = Number(md[5]);
      let pos = Number(md[11] ?? md[9]);
      let dict: (number | string | boolean)[] = [];
      let read = 0;
      while (read < numValues) {
        const t = new Thrift(b.subarray(pos));
        const ph = t.struct();
        pos += t.pos;
        const pageType = Number(ph[1]);
        const compressed = Number(ph[3]);
        const uncompressed = Number(ph[2]);
        let raw = b.subarray(pos, pos + compressed);
        pos += compressed;
        const unpack = async (d: Uint8Array) => {
          if (codec === 0) return d;
          if (codec === 1) return unsnappy(d);
          if (codec === 2) return inflate(d, "gzip");
          throw new Error(`This Parquet file uses a compression cellforge can't read yet (codec ${codec}). Save it with Snappy, gzip or none.`);
        };
        if (pageType === 2) {
          const page = await unpack(raw);
          dict = plain(leaf, page, 0, Number((ph[7] as TStruct)[1])).values;
          continue;
        }
        let page: Uint8Array;
        let count: number;
        let encoding: number;
        let defs: number[] | null = null;
        let p = 0;
        if (pageType === 0) {
          const h = ph[5] as TStruct;
          count = Number(h[1]);
          encoding = Number(h[2]);
          page = await unpack(raw);
          if (leaf.optional) {
            const len = new DataView(page.buffer, page.byteOffset).getUint32(0, true);
            defs = rleHybrid(page, 4, 4 + len, 1, count);
            p = 4 + len;
          }
        } else if (pageType === 3) {
          const h = ph[8] as TStruct;
          count = Number(h[1]);
          encoding = Number(h[4]);
          const defLen = Number(h[5]);
          const repLen = Number(h[6]);
          if (leaf.optional) defs = rleHybrid(raw, repLen, repLen + defLen, 1, count);
          const body = raw.subarray(repLen + defLen);
          page = h[7] === false ? body : await unpack(body);
          p = 0;
          void uncompressed;
        } else continue;
        const present = defs ? defs.filter((d) => d === 1).length : count;
        let got: (number | string | boolean)[];
        if (encoding === 0) got = plain(leaf, page, p, present).values;
        else if (encoding === 2 || encoding === 8) {
          const width = page[p];
          got = rleHybrid(page, p + 1, page.length, width, present).map((i) => dict[i]);
        } else throw new Error(`This Parquet file uses an encoding cellforge can't read yet (${encoding}).`);
        let k = 0;
        for (let i = 0; i < count; i++) {
          if (defs && defs[i] === 0) values[c].push(null);
          else values[c].push(shown(leaf, got[k++]));
        }
        read += count;
        raw = new Uint8Array();
      }
    }
  }

  // into columns: numbers in Float64Arrays, everything else dictionary-coded text
  const rows = numRows || Math.max(0, ...values.map((v) => v.length));
  const columns: ColumnData[] = leaves.map((leaf, c) => {
    const vs = values[c];
    if (leaf.kind === "text" || leaf.kind === "bool") {
      const codes = new Uint32Array(rows);
      const dictList: string[] = [];
      const lookup = new Map<string, number>();
      vs.forEach((v, i) => {
        if (v === null || v === "") return;
        const s = String(v);
        let code = lookup.get(s);
        if (code === undefined) {
          dictList.push(s);
          code = dictList.length;
          lookup.set(s, code);
        }
        codes[i] = code;
      });
      return { kind: "string", name: leaf.name, codes, dict: dictList };
    }
    const arr = new Float64Array(rows).fill(NaN);
    vs.forEach((v, i) => {
      if (typeof v === "number") arr[i] = v;
    });
    return { kind: "number", name: leaf.name, values: arr };
  });
  const dateColumns = leaves.flatMap((l, col) => (l.kind === "date" ? [{ col, withTime: false }] : l.kind === "timestamp" ? [{ col, withTime: true }] : []));
  return { columns, dateColumns };
}
