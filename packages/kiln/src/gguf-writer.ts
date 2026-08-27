/**
 * Minimal GGUF v3 writer. Used to build tiny models in memory for tests and
 * benchmarks; also handy for re-packing a model.
 */
import { GGUF_VALUE, tensorBytes, type GGMLType } from "./gguf";

export type GGUFWriteValue =
  | string
  | boolean
  | number // integers -> u32 (i32 if negative), others -> f32
  | { type: number; value: number | bigint }
  | { arrayOf: number; values: ArrayLike<number> | readonly string[] | readonly boolean[] };

export const gv = {
  u8: (value: number) => ({ type: GGUF_VALUE.UINT8, value }),
  u32: (value: number) => ({ type: GGUF_VALUE.UINT32, value }),
  i32: (value: number) => ({ type: GGUF_VALUE.INT32, value }),
  u64: (value: number) => ({ type: GGUF_VALUE.UINT64, value }),
  f32: (value: number) => ({ type: GGUF_VALUE.FLOAT32, value }),
  f64: (value: number) => ({ type: GGUF_VALUE.FLOAT64, value }),
  strings: (values: readonly string[]) => ({ arrayOf: GGUF_VALUE.STRING, values }),
  f32s: (values: ArrayLike<number>) => ({ arrayOf: GGUF_VALUE.FLOAT32, values }),
  i32s: (values: ArrayLike<number>) => ({ arrayOf: GGUF_VALUE.INT32, values }),
  u32s: (values: ArrayLike<number>) => ({ arrayOf: GGUF_VALUE.UINT32, values }),
};

export interface GGUFWriteTensor {
  name: string;
  /** ggml order: dims[0] contiguous */
  dims: number[];
  type: GGMLType;
  data: Uint8Array;
}

class Buf {
  private parts: Uint8Array[] = [];
  length = 0;
  private enc = new TextEncoder();
  bytes(b: Uint8Array) { this.parts.push(b); this.length += b.length; }
  num(n: number, size: number, set: (dv: DataView) => void) {
    const b = new Uint8Array(size);
    set(new DataView(b.buffer));
    this.bytes(b);
    void n;
  }
  u8(n: number) { this.num(n, 1, (d) => d.setUint8(0, n)); }
  i8(n: number) { this.num(n, 1, (d) => d.setInt8(0, n)); }
  u16(n: number) { this.num(n, 2, (d) => d.setUint16(0, n, true)); }
  i16(n: number) { this.num(n, 2, (d) => d.setInt16(0, n, true)); }
  u32(n: number) { this.num(n, 4, (d) => d.setUint32(0, n, true)); }
  i32(n: number) { this.num(n, 4, (d) => d.setInt32(0, n, true)); }
  f32(n: number) { this.num(n, 4, (d) => d.setFloat32(0, n, true)); }
  f64(n: number) { this.num(n, 8, (d) => d.setFloat64(0, n, true)); }
  u64(n: number | bigint) { this.num(0, 8, (d) => d.setBigUint64(0, BigInt(n), true)); }
  i64(n: number | bigint) { this.num(0, 8, (d) => d.setBigInt64(0, BigInt(n), true)); }
  str(s: string) { const b = this.enc.encode(s); this.u64(b.length); this.bytes(b); }
  pad(align: number) { const p = (align - (this.length % align)) % align; if (p) this.bytes(new Uint8Array(p)); }
  scalar(t: number, v: number | bigint | string | boolean) {
    switch (t) {
      case GGUF_VALUE.UINT8: return this.u8(Number(v));
      case GGUF_VALUE.INT8: return this.i8(Number(v));
      case GGUF_VALUE.UINT16: return this.u16(Number(v));
      case GGUF_VALUE.INT16: return this.i16(Number(v));
      case GGUF_VALUE.UINT32: return this.u32(Number(v));
      case GGUF_VALUE.INT32: return this.i32(Number(v));
      case GGUF_VALUE.FLOAT32: return this.f32(Number(v));
      case GGUF_VALUE.BOOL: return this.u8(v ? 1 : 0);
      case GGUF_VALUE.STRING: return this.str(String(v));
      case GGUF_VALUE.UINT64: return this.u64(typeof v === "bigint" ? v : Number(v));
      case GGUF_VALUE.INT64: return this.i64(typeof v === "bigint" ? v : Number(v));
      case GGUF_VALUE.FLOAT64: return this.f64(Number(v));
      default: throw new Error(`gguf writer: bad value type ${t}`);
    }
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export function writeGGUF(metadata: Record<string, GGUFWriteValue>, tensors: GGUFWriteTensor[], opts: { version?: 2 | 3; alignment?: number } = {}): Uint8Array {
  const alignment = opts.alignment ?? 32;
  const b = new Buf();
  b.u32(0x46554747);
  b.u32(opts.version ?? 3);
  b.u64(tensors.length);
  const entries = Object.entries(metadata);
  if (alignment !== 32 && !("general.alignment" in metadata)) entries.push(["general.alignment", gv.u32(alignment)]);
  b.u64(entries.length);
  for (const [key, v] of entries) {
    b.str(key);
    if (typeof v === "string") { b.u32(GGUF_VALUE.STRING); b.str(v); }
    else if (typeof v === "boolean") { b.u32(GGUF_VALUE.BOOL); b.u8(v ? 1 : 0); }
    else if (typeof v === "number") {
      const t = Number.isInteger(v) ? (v < 0 ? GGUF_VALUE.INT32 : GGUF_VALUE.UINT32) : GGUF_VALUE.FLOAT32;
      b.u32(t);
      b.scalar(t, v);
    } else if ("arrayOf" in v) {
      b.u32(GGUF_VALUE.ARRAY);
      b.u32(v.arrayOf);
      b.u64(v.values.length);
      for (let i = 0; i < v.values.length; i++) b.scalar(v.arrayOf, v.values[i] as number | string | boolean);
    } else {
      b.u32(v.type);
      b.scalar(v.type, v.value);
    }
  }
  let rel = 0;
  const offsets: number[] = [];
  for (const t of tensors) {
    const n = t.dims.reduce((a, c) => a * c, 1);
    if (tensorBytes(t.type, n) !== t.data.length) throw new Error(`gguf writer: ${t.name} has ${t.data.length} bytes, expected ${tensorBytes(t.type, n)}`);
    offsets.push(rel);
    rel += t.data.length;
    rel = Math.ceil(rel / alignment) * alignment;
  }
  tensors.forEach((t, i) => {
    b.str(t.name);
    b.u32(t.dims.length);
    for (const d of t.dims) b.u64(d);
    b.u32(t.type);
    b.u64(offsets[i]!);
  });
  b.pad(alignment);
  for (const t of tensors) {
    b.bytes(t.data);
    b.pad(alignment);
  }
  return b.concat();
}
