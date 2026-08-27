/**
 * Quantisation kernels: dequantisation, fused dot products that read the
 * quantised blocks directly (no dequantised copy of the weights), and
 * quantisers (used to build test models and the benchmark model).
 *
 * Block formats (identical to ggml):
 *   Q8_0  32 values: f16 d | i8 q[32]                     x = d*q
 *   Q4_0  32 values: f16 d | u8 qs[16]                    x = d*(nibble-8)
 *         value j<16 is the low nibble of qs[j], value j+16 the high nibble
 *   Q4_K 256 values: f16 d | f16 dmin | u8 scales[12] | u8 qs[128]
 *         8 sub-blocks of 32 with 6-bit scale sc and 6-bit min m:
 *         x = d*sc*nibble - dmin*m. Each 64-value chunk shares 32 bytes of qs:
 *         low nibbles are the first sub-block, high nibbles the second.
 *   Q6_K 256 values: u8 ql[128] | u8 qh[64] | i8 scales[16] | f16 d
 *         x = d*scale[sub]*(q6-32), 16 sub-blocks of 16
 *   F16, BF16, F32 plain arrays.
 */
import { GGML, GGML_TYPES, bf16ToF32, f16Table, f32ToF16, typeName, type GGMLType } from "./gguf";

/** Q4_K / Q5_K scale+min unpacking (ggml's get_scale_min_k4). */
export function scaleMinK4(j: number, q: Uint8Array, o: number): [number, number] {
  if (j < 4) return [q[o + j]! & 63, q[o + j + 4]! & 63];
  return [(q[o + j + 4]! & 0xf) | ((q[o + j - 4]! >> 6) << 4), (q[o + j + 4]! >> 4) | ((q[o + j]! >> 6) << 4)];
}

/**
 * Dequantise `n` values starting at byte offset `off` of `src` into
 * `dst[dstOff..]`. `n` must be a multiple of the block size.
 */
export function dequantizeInto(type: GGMLType, src: Uint8Array, off: number, n: number, dst: Float32Array, dstOff = 0): void {
  const h = f16Table();
  switch (type) {
    case GGML.F32: {
      const dv = new DataView(src.buffer, src.byteOffset + off, n * 4);
      for (let i = 0; i < n; i++) dst[dstOff + i] = dv.getFloat32(i * 4, true);
      return;
    }
    case GGML.F16:
      for (let i = 0; i < n; i++) dst[dstOff + i] = h[src[off + 2 * i]! | (src[off + 2 * i + 1]! << 8)]!;
      return;
    case GGML.BF16:
      for (let i = 0; i < n; i++) dst[dstOff + i] = bf16ToF32(src[off + 2 * i]! | (src[off + 2 * i + 1]! << 8));
      return;
    case GGML.Q8_0:
      for (let b = 0; b < n / 32; b++) {
        const o = off + b * 34;
        const d = h[src[o]! | (src[o + 1]! << 8)]!;
        for (let j = 0; j < 32; j++) dst[dstOff + b * 32 + j] = d * ((src[o + 2 + j]! << 24) >> 24);
      }
      return;
    case GGML.Q4_0:
      for (let b = 0; b < n / 32; b++) {
        const o = off + b * 18;
        const d = h[src[o]! | (src[o + 1]! << 8)]!;
        const y = dstOff + b * 32;
        for (let j = 0; j < 16; j++) {
          const q = src[o + 2 + j]!;
          dst[y + j] = d * ((q & 0xf) - 8);
          dst[y + j + 16] = d * ((q >> 4) - 8);
        }
      }
      return;
    case GGML.Q4_K:
      for (let b = 0; b < n / 256; b++) {
        const o = off + b * 144;
        const d = h[src[o]! | (src[o + 1]! << 8)]!;
        const dmin = h[src[o + 2]! | (src[o + 3]! << 8)]!;
        const sc = o + 4;
        let q = o + 16;
        let y = dstOff + b * 256;
        for (let c = 0; c < 4; c++) {
          const [s1, m1] = scaleMinK4(2 * c, src, sc);
          const [s2, m2] = scaleMinK4(2 * c + 1, src, sc);
          const d1 = d * s1, mm1 = dmin * m1, d2 = d * s2, mm2 = dmin * m2;
          for (let l = 0; l < 32; l++) dst[y + l] = d1 * (src[q + l]! & 0xf) - mm1;
          for (let l = 0; l < 32; l++) dst[y + 32 + l] = d2 * (src[q + l]! >> 4) - mm2;
          q += 32;
          y += 64;
        }
      }
      return;
    case GGML.Q6_K:
      for (let b = 0; b < n / 256; b++) {
        const o = off + b * 210;
        let ql = o;
        let qh = o + 128;
        let sc = o + 192;
        const d = h[src[o + 208]! | (src[o + 209]! << 8)]!;
        let y = dstOff + b * 256;
        for (let half = 0; half < 2; half++) {
          for (let l = 0; l < 32; l++) {
            const is = l >> 4;
            const hb = src[qh + l]!;
            const q1 = ((src[ql + l]! & 0xf) | ((hb & 3) << 4)) - 32;
            const q2 = ((src[ql + l + 32]! & 0xf) | (((hb >> 2) & 3) << 4)) - 32;
            const q3 = ((src[ql + l]! >> 4) | (((hb >> 4) & 3) << 4)) - 32;
            const q4 = ((src[ql + l + 32]! >> 4) | (((hb >> 6) & 3) << 4)) - 32;
            dst[y + l] = d * ((src[sc + is]! << 24) >> 24) * q1;
            dst[y + l + 32] = d * ((src[sc + is + 2]! << 24) >> 24) * q2;
            dst[y + l + 64] = d * ((src[sc + is + 4]! << 24) >> 24) * q3;
            dst[y + l + 96] = d * ((src[sc + is + 6]! << 24) >> 24) * q4;
          }
          y += 128;
          ql += 64;
          qh += 32;
          sc += 8;
        }
      }
      return;
    default:
      throw new Error(`kiln: tensor type ${typeName(type)} is not supported (supported: F32, F16, BF16, Q8_0, Q4_0, Q4_K, Q6_K)`);
  }
}

export function dequantize(type: GGMLType, src: Uint8Array, n: number): Float32Array {
  const out = new Float32Array(n);
  dequantizeInto(type, src, 0, n, out, 0);
  return out;
}

export function isSupportedType(type: GGMLType): boolean {
  return GGML_TYPES[type]?.supported ?? false;
}

// ---- matrices ----------------------------------------------------------

/** A row-major weight matrix in its storage format: `rows` rows of `cols` values. */
export interface QMatrix {
  type: GGMLType;
  rows: number;
  cols: number;
  /** raw bytes (a view into the GGUF buffer) */
  data: Uint8Array;
  /** bytes per row */
  rowBytes: number;
  /** F32 weights as a Float32Array view (when the bytes are 4-aligned) */
  f32?: Float32Array;
  /** the same bytes as signed (for Q8_0) */
  i8?: Int8Array;
}

export function makeQMatrix(type: GGMLType, rows: number, cols: number, data: Uint8Array): QMatrix {
  if (!isSupportedType(type)) throw new Error(`kiln: tensor type ${typeName(type)} is not supported`);
  const info = GGML_TYPES[type]!;
  if (cols % info.blockSize !== 0) throw new Error(`kiln: ${typeName(type)} row length ${cols} is not a multiple of ${info.blockSize}`);
  const rowBytes = (cols / info.blockSize) * info.typeSize;
  if (data.byteLength < rows * rowBytes) throw new Error("kiln: matrix data too short");
  const m: QMatrix = { type, rows, cols, data, rowBytes };
  if (type === GGML.Q8_0) m.i8 = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
  if (type === GGML.F32) {
    m.f32 = (data.byteOffset & 3) === 0 ? new Float32Array(data.buffer, data.byteOffset, rows * cols) : new Float32Array(data.slice().buffer, 0, rows * cols);
  }
  return m;
}

/** Dequantise one row (e.g. an embedding lookup). */
export function matRow(m: QMatrix, row: number, out: Float32Array = new Float32Array(m.cols)): Float32Array {
  dequantizeInto(m.type, m.data, row * m.rowBytes, m.cols, out, 0);
  return out;
}

/**
 * out[r] = sum_c W[r][c] * x[c] for rows [r0, r1). Works on the stored
 * blocks directly; activations stay in f32.
 */
export function matVec(m: QMatrix, x: Float32Array, out: Float32Array, r0 = 0, r1 = m.rows): void {
  const { cols, data: q, rowBytes } = m;
  const h = f16Table();
  switch (m.type) {
    case GGML.F32: {
      const w = m.f32!;
      for (let r = r0; r < r1; r++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        const o = r * cols;
        let c = 0;
        for (; c + 3 < cols; c += 4) {
          s0 += w[o + c]! * x[c]!;
          s1 += w[o + c + 1]! * x[c + 1]!;
          s2 += w[o + c + 2]! * x[c + 2]!;
          s3 += w[o + c + 3]! * x[c + 3]!;
        }
        for (; c < cols; c++) s0 += w[o + c]! * x[c]!;
        out[r] = s0 + s1 + s2 + s3;
      }
      return;
    }
    case GGML.F16:
      for (let r = r0; r < r1; r++) {
        let s = 0;
        const o = r * rowBytes;
        for (let c = 0; c < cols; c++) s += h[q[o + 2 * c]! | (q[o + 2 * c + 1]! << 8)]! * x[c]!;
        out[r] = s;
      }
      return;
    case GGML.Q8_0: {
      const i8 = m.i8!;
      const nb = cols / 32;
      for (let r = r0; r < r1; r++) {
        let s = 0;
        let o = r * rowBytes;
        for (let b = 0; b < nb; b++, o += 34) {
          const d = h[q[o]! | (q[o + 1]! << 8)]!;
          const xb = b * 32;
          let a = 0;
          const qo = o + 2;
          for (let j = 0; j < 32; j++) a += i8[qo + j]! * x[xb + j]!;
          s += d * a;
        }
        out[r] = s;
      }
      return;
    }
    case GGML.Q4_0: {
      const nb = cols / 32;
      // sum(x) per block, so the -8 offset is applied once per block
      const xsum = blockSums(x, cols, 32);
      for (let r = r0; r < r1; r++) {
        let s = 0;
        let o = r * rowBytes;
        for (let b = 0; b < nb; b++, o += 18) {
          const d = h[q[o]! | (q[o + 1]! << 8)]!;
          const xb = b * 32;
          let a = 0;
          for (let j = 0; j < 16; j++) {
            const v = q[o + 2 + j]!;
            a += (v & 0xf) * x[xb + j]! + (v >> 4) * x[xb + j + 16]!;
          }
          s += d * (a - 8 * xsum[b]!);
        }
        out[r] = s;
      }
      return;
    }
    case GGML.Q4_K: {
      const nb = cols / 256;
      const xsum = blockSums(x, cols, 32);
      for (let r = r0; r < r1; r++) {
        let s = 0;
        let o = r * rowBytes;
        for (let b = 0; b < nb; b++, o += 144) {
          const d = h[q[o]! | (q[o + 1]! << 8)]!;
          const dmin = h[q[o + 2]! | (q[o + 3]! << 8)]!;
          const sc = o + 4;
          let qo = o + 16;
          let xb = b * 256;
          let sumScaled = 0, sumMin = 0;
          for (let c = 0; c < 4; c++) {
            const j = 2 * c;
            // inline get_scale_min_k4 for sub-blocks j and j+1
            let s1: number, m1: number, s2: number, m2: number;
            if (j < 4) {
              s1 = q[sc + j]! & 63; m1 = q[sc + j + 4]! & 63;
              s2 = q[sc + j + 1]! & 63; m2 = q[sc + j + 5]! & 63;
            } else {
              s1 = (q[sc + j + 4]! & 0xf) | ((q[sc + j - 4]! >> 6) << 4);
              m1 = (q[sc + j + 4]! >> 4) | ((q[sc + j]! >> 6) << 4);
              s2 = (q[sc + j + 5]! & 0xf) | ((q[sc + j - 3]! >> 6) << 4);
              m2 = (q[sc + j + 5]! >> 4) | ((q[sc + j + 1]! >> 6) << 4);
            }
            let a1 = 0, a2 = 0;
            for (let l = 0; l < 32; l++) {
              const v = q[qo + l]!;
              a1 += (v & 0xf) * x[xb + l]!;
              a2 += (v >> 4) * x[xb + 32 + l]!;
            }
            const sb = (b * 256 + c * 64) / 32;
            sumScaled += s1 * a1 + s2 * a2;
            sumMin += m1 * xsum[sb]! + m2 * xsum[sb + 1]!;
            qo += 32;
            xb += 64;
          }
          s += d * sumScaled - dmin * sumMin;
        }
        out[r] = s;
      }
      return;
    }
    default: {
      // generic path (Q6_K, BF16): dequantise a row at a time into scratch
      const row = new Float32Array(cols);
      for (let r = r0; r < r1; r++) {
        dequantizeInto(m.type, q, r * rowBytes, cols, row, 0);
        let s = 0;
        for (let c = 0; c < cols; c++) s += row[c]! * x[c]!;
        out[r] = s;
      }
    }
  }
}

function blockSums(x: Float32Array, n: number, bs: number): Float32Array {
  const out = new Float32Array(n / bs);
  for (let b = 0; b < out.length; b++) {
    let s = 0;
    for (let j = 0; j < bs; j++) s += x[b * bs + j]!;
    out[b] = s;
  }
  return out;
}

// ---- quantisers --------------------------------------------------------

const f16r = (v: number) => f32ToF16(v);
const f16v = (v: number) => f16Table()[f32ToF16(v)]!;

function put16(dst: Uint8Array, o: number, h: number) {
  dst[o] = h & 0xff;
  dst[o + 1] = h >> 8;
}

/** ggml's quantize_row_q8_0 reference */
export function quantizeQ8_0(x: Float32Array): Uint8Array {
  const nb = x.length / 32;
  const out = new Uint8Array(nb * 34);
  for (let b = 0; b < nb; b++) {
    let amax = 0;
    for (let j = 0; j < 32; j++) amax = Math.max(amax, Math.abs(x[b * 32 + j]!));
    const d = amax / 127;
    const id = d ? 1 / d : 0;
    put16(out, b * 34, f16r(d));
    for (let j = 0; j < 32; j++) out[b * 34 + 2 + j] = Math.round(x[b * 32 + j]! * id) & 0xff;
  }
  return out;
}

/** ggml's quantize_row_q4_0 reference */
export function quantizeQ4_0(x: Float32Array): Uint8Array {
  const nb = x.length / 32;
  const out = new Uint8Array(nb * 18);
  for (let b = 0; b < nb; b++) {
    let amax = 0, max = 0;
    for (let j = 0; j < 32; j++) {
      const v = x[b * 32 + j]!;
      if (Math.abs(v) > amax) { amax = Math.abs(v); max = v; }
    }
    const d = max / -8;
    const id = d ? 1 / d : 0;
    put16(out, b * 18, f16r(d));
    for (let j = 0; j < 16; j++) {
      const q0 = Math.min(15, Math.trunc(x[b * 32 + j]! * id + 8.5));
      const q1 = Math.min(15, Math.trunc(x[b * 32 + j + 16]! * id + 8.5));
      out[b * 18 + 2 + j] = q0 | (q1 << 4);
    }
  }
  return out;
}

/** Simple (not ggml's iterative) Q4_K quantiser: min/max per sub-block, 6-bit scales. */
export function quantizeQ4_K(x: Float32Array): Uint8Array {
  const nb = x.length / 256;
  const out = new Uint8Array(nb * 144);
  for (let b = 0; b < nb; b++) {
    const base = b * 256;
    const scales: number[] = [], mins: number[] = [];
    for (let j = 0; j < 8; j++) {
      let mn = 0, mx = 0;
      for (let l = 0; l < 32; l++) {
        const v = x[base + j * 32 + l]!;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      scales.push((mx - mn) / 15);
      mins.push(-mn);
    }
    const d = f16v(Math.max(...scales) / 63);
    const dmin = f16v(Math.max(...mins) / 63);
    const sc = scales.map((s) => (d ? Math.min(63, Math.round(s / d)) : 0));
    const m = mins.map((v) => (dmin ? Math.min(63, Math.round(v / dmin)) : 0));
    const o = b * 144;
    put16(out, o, f32ToF16(d));
    put16(out, o + 2, f32ToF16(dmin));
    const s12 = out.subarray(o + 4, o + 16);
    for (let j = 0; j < 8; j++) {
      if (j < 4) {
        s12[j] = (s12[j]! & 0xc0) | sc[j]!;
        s12[j + 4] = (s12[j + 4]! & 0xc0) | m[j]!;
      } else {
        s12[j + 4] = (sc[j]! & 0xf) | ((m[j]! & 0xf) << 4);
        s12[j - 4] = s12[j - 4]! | ((sc[j]! >> 4) << 6);
        s12[j] = s12[j]! | ((m[j]! >> 4) << 6);
      }
    }
    const qs = out.subarray(o + 16, o + 144);
    for (let c = 0; c < 4; c++) {
      for (const [k, shift] of [[0, 0], [1, 4]] as const) {
        const j = 2 * c + k;
        const dd = d * sc[j]!;
        const mm = dmin * m[j]!;
        for (let l = 0; l < 32; l++) {
          const v = x[base + j * 32 + l]!;
          const qv = dd ? Math.max(0, Math.min(15, Math.round((v + mm) / dd))) : 0;
          qs[c * 32 + l] = qs[c * 32 + l]! | (qv << shift);
        }
      }
    }
  }
  return out;
}

/** Simple Q6_K quantiser: per-16 int8 scales, 6-bit values. */
export function quantizeQ6_K(x: Float32Array): Uint8Array {
  const nb = x.length / 256;
  const out = new Uint8Array(nb * 210);
  for (let b = 0; b < nb; b++) {
    const base = b * 256;
    const s: number[] = [];
    for (let g = 0; g < 16; g++) {
      let amax = 0;
      for (let j = 0; j < 16; j++) amax = Math.max(amax, Math.abs(x[base + g * 16 + j]!));
      s.push(amax / 31);
    }
    const d = f16v(Math.max(...s) / 127);
    const sc = s.map((v) => (d ? Math.min(127, Math.round(v / d)) : 0));
    const v = new Uint8Array(256);
    for (let e = 0; e < 256; e++) {
      const dd = d * sc[e >> 4]!;
      v[e] = (dd ? Math.max(-32, Math.min(31, Math.round(x[base + e]! / dd))) : 0) + 32;
    }
    const o = b * 210;
    for (let half = 0; half < 2; half++) {
      const ql = o + half * 64, qh = o + 128 + half * 32, h0 = half * 128;
      for (let l = 0; l < 32; l++) {
        const q1 = v[h0 + l]!, q2 = v[h0 + l + 32]!, q3 = v[h0 + l + 64]!, q4 = v[h0 + l + 96]!;
        out[ql + l] = (q1 & 0xf) | ((q3 & 0xf) << 4);
        out[ql + l + 32] = (q2 & 0xf) | ((q4 & 0xf) << 4);
        out[qh + l] = (q1 >> 4) | ((q2 >> 4) << 2) | ((q3 >> 4) << 4) | ((q4 >> 4) << 6);
      }
    }
    for (let g = 0; g < 16; g++) out[o + 192 + g] = sc[g]! & 0xff;
    put16(out, o + 208, f32ToF16(d));
  }
  return out;
}

export function quantizeF16(x: Float32Array): Uint8Array {
  const out = new Uint8Array(x.length * 2);
  for (let i = 0; i < x.length; i++) put16(out, 2 * i, f32ToF16(x[i]!));
  return out;
}

export function quantizeF32(x: Float32Array): Uint8Array {
  return new Uint8Array(new Float32Array(x).buffer);
}

/** Quantise to any type kiln can write (F32, F16, Q8_0, Q4_0, Q4_K). */
export function quantize(type: GGMLType, x: Float32Array): Uint8Array {
  switch (type) {
    case GGML.F32: return quantizeF32(x);
    case GGML.F16: return quantizeF16(x);
    case GGML.Q8_0: return quantizeQ8_0(x);
    case GGML.Q4_0: return quantizeQ4_0(x);
    case GGML.Q4_K: return quantizeQ4_K(x);
    case GGML.Q6_K: return quantizeQ6_K(x);
    default: throw new Error(`kiln: cannot quantise to ${typeName(type)}`);
  }
}
