/**
 * GGUF reader (format versions 2 and 3).
 *
 * Layout (all little-endian):
 *   magic "GGUF" | u32 version | u64 tensor_count | u64 kv_count
 *   kv_count x (string key, u32 value_type, value)
 *   tensor_count x (string name, u32 n_dims, u64 dims[n_dims], u32 ggml_type, u64 offset)
 *   padding to `general.alignment` (default 32)
 *   tensor data; each tensor's `offset` is relative to the start of this section
 *
 * Strings are u64 length + UTF-8 bytes. `dims[0]` is the innermost
 * (contiguous) dimension, so a PyTorch weight of shape [out, in] is stored
 * with dims [in, out]: `out` rows of `in` values each.
 *
 * Tensor data is never copied: every tensor is a Uint8Array view into the
 * buffer you pass in.
 */

export const GGML = {
  F32: 0,
  F16: 1,
  Q4_0: 2,
  Q4_1: 3,
  Q5_0: 6,
  Q5_1: 7,
  Q8_0: 8,
  Q8_1: 9,
  Q2_K: 10,
  Q3_K: 11,
  Q4_K: 12,
  Q5_K: 13,
  Q6_K: 14,
  Q8_K: 15,
  IQ2_XXS: 16,
  IQ2_XS: 17,
  IQ3_XXS: 18,
  IQ1_S: 19,
  IQ4_NL: 20,
  IQ3_S: 21,
  IQ2_S: 22,
  IQ4_XS: 23,
  I8: 24,
  I16: 25,
  I32: 26,
  I64: 27,
  F64: 28,
  IQ1_M: 29,
  BF16: 30,
} as const;
export type GGMLType = number;

export interface GGMLTypeInfo {
  name: string;
  /** elements per block */
  blockSize: number;
  /** bytes per block */
  typeSize: number;
  /** whether kiln can dequantise / multiply with it */
  supported: boolean;
}

/** Block geometry for every type we know about; `supported` marks the ones kiln can compute with. */
export const GGML_TYPES: Record<number, GGMLTypeInfo> = {
  0: { name: "F32", blockSize: 1, typeSize: 4, supported: true },
  1: { name: "F16", blockSize: 1, typeSize: 2, supported: true },
  2: { name: "Q4_0", blockSize: 32, typeSize: 18, supported: true },
  3: { name: "Q4_1", blockSize: 32, typeSize: 20, supported: false },
  6: { name: "Q5_0", blockSize: 32, typeSize: 22, supported: false },
  7: { name: "Q5_1", blockSize: 32, typeSize: 24, supported: false },
  8: { name: "Q8_0", blockSize: 32, typeSize: 34, supported: true },
  9: { name: "Q8_1", blockSize: 32, typeSize: 36, supported: false },
  10: { name: "Q2_K", blockSize: 256, typeSize: 84, supported: false },
  11: { name: "Q3_K", blockSize: 256, typeSize: 110, supported: false },
  12: { name: "Q4_K", blockSize: 256, typeSize: 144, supported: true },
  13: { name: "Q5_K", blockSize: 256, typeSize: 176, supported: false },
  14: { name: "Q6_K", blockSize: 256, typeSize: 210, supported: true },
  15: { name: "Q8_K", blockSize: 256, typeSize: 292, supported: false },
  16: { name: "IQ2_XXS", blockSize: 256, typeSize: 66, supported: false },
  17: { name: "IQ2_XS", blockSize: 256, typeSize: 74, supported: false },
  18: { name: "IQ3_XXS", blockSize: 256, typeSize: 98, supported: false },
  19: { name: "IQ1_S", blockSize: 256, typeSize: 50, supported: false },
  20: { name: "IQ4_NL", blockSize: 32, typeSize: 18, supported: false },
  21: { name: "IQ3_S", blockSize: 256, typeSize: 110, supported: false },
  22: { name: "IQ2_S", blockSize: 256, typeSize: 82, supported: false },
  23: { name: "IQ4_XS", blockSize: 256, typeSize: 136, supported: false },
  24: { name: "I8", blockSize: 1, typeSize: 1, supported: false },
  25: { name: "I16", blockSize: 1, typeSize: 2, supported: false },
  26: { name: "I32", blockSize: 1, typeSize: 4, supported: false },
  27: { name: "I64", blockSize: 1, typeSize: 8, supported: false },
  28: { name: "F64", blockSize: 1, typeSize: 8, supported: false },
  29: { name: "IQ1_M", blockSize: 256, typeSize: 56, supported: false },
  30: { name: "BF16", blockSize: 1, typeSize: 2, supported: true },
};

export function typeName(t: GGMLType): string {
  return GGML_TYPES[t]?.name ?? `type#${t}`;
}

/** Bytes needed for `n` elements of type `t` (n must be a multiple of the block size). */
export function tensorBytes(t: GGMLType, n: number): number {
  const info = GGML_TYPES[t];
  if (!info) throw new Error(`unknown ggml type ${t}`);
  if (n % info.blockSize !== 0) throw new Error(`${info.name}: ${n} elements is not a multiple of the block size ${info.blockSize}`);
  return (n / info.blockSize) * info.typeSize;
}

/** GGUF metadata value types */
export const GGUF_VALUE = {
  UINT8: 0,
  INT8: 1,
  UINT16: 2,
  INT16: 3,
  UINT32: 4,
  INT32: 5,
  FLOAT32: 6,
  BOOL: 7,
  STRING: 8,
  ARRAY: 9,
  UINT64: 10,
  INT64: 11,
  FLOAT64: 12,
} as const;

export type GGUFValue =
  | number
  | boolean
  | string
  | readonly string[]
  | readonly boolean[]
  | readonly number[]
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int8Array
  | Uint8Array
  | readonly GGUFValue[];

export interface GGUFTensor {
  name: string;
  /** ggml order: dims[0] is contiguous */
  dims: number[];
  type: GGMLType;
  nElements: number;
  /** absolute byte offset in the buffer */
  offset: number;
  byteLength: number;
  /** zero-copy view of the raw (possibly quantised) bytes */
  data: Uint8Array;
}

export interface GGUFFile {
  version: number;
  alignment: number;
  metadata: Map<string, GGUFValue>;
  tensors: GGUFTensor[];
  /** absolute offset of the tensor data section */
  dataOffset: number;
  bytes: Uint8Array;
  tensor(name: string): GGUFTensor | undefined;
}

const MAGIC = 0x46554747; // "GGUF" read as LE u32

class Reader {
  pos = 0;
  private dv: DataView;
  private dec = new TextDecoder("utf-8");
  constructor(private bytes: Uint8Array) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number) {
    if (this.pos + n > this.bytes.byteLength) throw new Error(`GGUF truncated: need ${n} bytes at offset ${this.pos}`);
  }
  u8() { this.need(1); return this.dv.getUint8(this.pos++); }
  i8() { this.need(1); return this.dv.getInt8(this.pos++); }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  u64() {
    this.need(8);
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`GGUF: u64 value ${v} too large`);
    return Number(v);
  }
  i64() {
    this.need(8);
    const v = this.dv.getBigInt64(this.pos, true);
    this.pos += 8;
    return Number(v);
  }
  str() {
    const n = this.u64();
    this.need(n);
    const s = this.dec.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  scalar(t: number): number | boolean | string {
    switch (t) {
      case GGUF_VALUE.UINT8: return this.u8();
      case GGUF_VALUE.INT8: return this.i8();
      case GGUF_VALUE.UINT16: return this.u16();
      case GGUF_VALUE.INT16: return this.i16();
      case GGUF_VALUE.UINT32: return this.u32();
      case GGUF_VALUE.INT32: return this.i32();
      case GGUF_VALUE.FLOAT32: return this.f32();
      case GGUF_VALUE.BOOL: return this.u8() !== 0;
      case GGUF_VALUE.STRING: return this.str();
      case GGUF_VALUE.UINT64: return this.u64();
      case GGUF_VALUE.INT64: return this.i64();
      case GGUF_VALUE.FLOAT64: return this.f64();
      default: throw new Error(`GGUF: unknown value type ${t}`);
    }
  }
  value(t: number): GGUFValue {
    if (t !== GGUF_VALUE.ARRAY) return this.scalar(t);
    const et = this.u32();
    const n = this.u64();
    switch (et) {
      case GGUF_VALUE.FLOAT32: { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
      case GGUF_VALUE.INT32: { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i32(); return a; }
      case GGUF_VALUE.UINT32: { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = this.u32(); return a; }
      case GGUF_VALUE.INT8: { const a = new Int8Array(n); for (let i = 0; i < n; i++) a[i] = this.i8(); return a; }
      case GGUF_VALUE.UINT8: { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = this.u8(); return a; }
      case GGUF_VALUE.STRING: { const a: string[] = new Array(n); for (let i = 0; i < n; i++) a[i] = this.str(); return a; }
      case GGUF_VALUE.BOOL: { const a: boolean[] = new Array(n); for (let i = 0; i < n; i++) a[i] = this.u8() !== 0; return a; }
      case GGUF_VALUE.ARRAY: { const a: GGUFValue[] = new Array(n); for (let i = 0; i < n; i++) a[i] = this.value(GGUF_VALUE.ARRAY); return a; }
      default: { const a: number[] = new Array(n); for (let i = 0; i < n; i++) a[i] = this.scalar(et) as number; return a; }
    }
  }
}

/** Parse a GGUF file. Tensor data stays in `input`; nothing is copied. */
export function parseGGUF(input: ArrayBuffer | Uint8Array): GGUFFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a GGUF file (bad magic)");
  const version = r.u32();
  if (version !== 2 && version !== 3) throw new Error(`GGUF version ${version} is not supported (only 2 and 3)`);
  const nTensors = r.u64();
  const nKv = r.u64();
  const metadata = new Map<string, GGUFValue>();
  for (let i = 0; i < nKv; i++) {
    const key = r.str();
    const t = r.u32();
    metadata.set(key, r.value(t));
  }
  const alignment = typeof metadata.get("general.alignment") === "number" ? (metadata.get("general.alignment") as number) : 32;
  if (alignment <= 0 || (alignment & (alignment - 1)) !== 0) throw new Error(`GGUF: alignment ${alignment} is not a power of two`);
  const infos: { name: string; dims: number[]; type: number; rel: number }[] = [];
  for (let i = 0; i < nTensors; i++) {
    const name = r.str();
    const nd = r.u32();
    if (nd > 4) throw new Error(`GGUF: tensor ${name} has ${nd} dims`);
    const dims: number[] = [];
    for (let d = 0; d < nd; d++) dims.push(r.u64());
    const type = r.u32();
    const rel = r.u64();
    infos.push({ name, dims, type, rel });
  }
  const dataOffset = Math.ceil(r.pos / alignment) * alignment;
  const tensors: GGUFTensor[] = infos.map(({ name, dims, type, rel }) => {
    const nElements = dims.reduce((a, b) => a * b, 1);
    const info = GGML_TYPES[type];
    if (!info) throw new Error(`GGUF: tensor ${name} has unknown type ${type}`);
    const byteLength = tensorBytes(type, nElements);
    const offset = dataOffset + rel;
    if (offset + byteLength > bytes.byteLength) throw new Error(`GGUF truncated: tensor ${name} ends past the end of the file`);
    return { name, dims, type, nElements, offset, byteLength, data: bytes.subarray(offset, offset + byteLength) };
  });
  const byName = new Map(tensors.map((t) => [t.name, t]));
  return { version, alignment, metadata, tensors, dataOffset, bytes, tensor: (n) => byName.get(n) };
}

// ---- typed metadata accessors ------------------------------------------

export function metaNumber(f: GGUFFile, key: string): number | undefined;
export function metaNumber(f: GGUFFile, key: string, fallback: number): number;
export function metaNumber(f: GGUFFile, key: string, fallback?: number): number | undefined {
  const v = f.metadata.get(key);
  return typeof v === "number" ? v : fallback;
}

export function metaString(f: GGUFFile, key: string): string | undefined {
  const v = f.metadata.get(key);
  return typeof v === "string" ? v : undefined;
}

export function metaBool(f: GGUFFile, key: string): boolean | undefined {
  const v = f.metadata.get(key);
  return typeof v === "boolean" ? v : undefined;
}

// ---- half precision ----------------------------------------------------

let F16_TABLE: Float32Array | null = null;

/** f16 bit pattern -> f32, via a 64K-entry lookup table built on first use. */
export function f16Table(): Float32Array {
  if (F16_TABLE) return F16_TABLE;
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) t[h] = f16ToF32Slow(h);
  F16_TABLE = t;
  return t;
}

function f16ToF32Slow(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function f16ToF32(h: number): number {
  return f16Table()[h & 0xffff]!;
}

const cvtF32 = new Float32Array(1);
const cvtU32 = new Uint32Array(cvtF32.buffer);

/** f32 -> f16 bit pattern, round to nearest even (matches numpy / ggml). */
export function f32ToF16(v: number): number {
  cvtF32[0] = v;
  const x = cvtU32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  return sign | half;
}

/** bf16 bit pattern -> f32 */
export function bf16ToF32(h: number): number {
  cvtU32[0] = (h & 0xffff) << 16;
  return cvtF32[0]!;
}
