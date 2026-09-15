/// <reference types="@webgpu/types" />
/**
 * WebGPU backend: the whole forward pass runs in compute shaders, with one
 * readback (the logits) per token.
 *
 * Weights are repacked once at load into two GPU-friendly formats that keep
 * them quantised (no f32 copy of the model):
 *   q4  per 32 values: f32 scale, f32 min, 4 x u32 nibbles (Q4_0 nibble order)
 *       x = scale*q + min        exact for Q4_0 (min = -8d) and Q4_K
 *   q8  per 16 values: f32 scale, 4 x u32 int8s
 *       x = scale*q               exact for Q8_0 and Q6_K (q6-32 fits in int8)
 *   f32 for F32 / F16 / BF16
 *
 * Kernels: matrix-vector (one workgroup per output row, 64 threads),
 * RMSNorm, RoPE (+bias, writing K straight into the cache), V copy,
 * attention (one workgroup per head), SwiGLU.
 *
 * `createWebGpuBackend` returns null when WebGPU is unavailable (as in Node
 * and in tests); callers fall back to the CPU backend.
 */
import { GGML, f16Table } from "./gguf";
import { dequantizeInto, matRow, scaleMinK4, type QMatrix } from "./quant";
import type { Backend, ModelConfig, ModelWeights } from "./model";

export type GpuFormat = "q4" | "q8" | "f32";

export interface PackedMatrix {
  format: GpuFormat;
  rows: number;
  cols: number;
  /** q4/q8: one per block; f32: the weights */
  scales: Float32Array;
  /** q4 only */
  mins?: Float32Array;
  /** q4/q8: packed quants */
  qs?: Uint32Array;
}

/** Repack a quantised matrix into the layout the shaders read. Pure CPU, tested. */
export function packForGpu(m: QMatrix): PackedMatrix {
  const { rows, cols, data } = m;
  const h = f16Table();
  if (m.type === GGML.Q4_0 || m.type === GGML.Q4_K) {
    const nb = (rows * cols) / 32;
    const scales = new Float32Array(nb), mins = new Float32Array(nb), qs = new Uint32Array(nb * 4);
    const qv = new Uint8Array(32);
    const put = (blk: number) => {
      for (let w = 0; w < 4; w++) {
        let word = 0;
        for (let k = 0; k < 4; k++) {
          const j = w * 4 + k;
          word |= (qv[j]! | (qv[j + 16]! << 4)) << (8 * k);
        }
        qs[blk * 4 + w] = word >>> 0;
      }
    };
    for (let r = 0; r < rows; r++) {
      const ro = r * m.rowBytes;
      if (m.type === GGML.Q4_0) {
        for (let b = 0; b < cols / 32; b++) {
          const o = ro + b * 18;
          const d = h[data[o]! | (data[o + 1]! << 8)]!;
          for (let j = 0; j < 16; j++) {
            qv[j] = data[o + 2 + j]! & 0xf;
            qv[j + 16] = data[o + 2 + j]! >> 4;
          }
          const blk = (r * cols) / 32 + b;
          scales[blk] = d;
          mins[blk] = -8 * d;
          put(blk);
        }
      } else {
        for (let sb = 0; sb < cols / 256; sb++) {
          const o = ro + sb * 144;
          const d = h[data[o]! | (data[o + 1]! << 8)]!;
          const dmin = h[data[o + 2]! | (data[o + 3]! << 8)]!;
          for (let j = 0; j < 8; j++) {
            const [sc, mn] = scaleMinK4(j, data, o + 4);
            const c = j >> 1, hi = j & 1;
            for (let l = 0; l < 32; l++) {
              const byte = data[o + 16 + c * 32 + l]!;
              qv[l] = hi ? byte >> 4 : byte & 0xf;
            }
            const blk = (r * cols) / 32 + sb * 8 + j;
            scales[blk] = d * sc;
            mins[blk] = -dmin * mn;
            put(blk);
          }
        }
      }
    }
    return { format: "q4", rows, cols, scales, mins, qs };
  }
  if (m.type === GGML.Q8_0 || m.type === GGML.Q6_K) {
    const nb = (rows * cols) / 16;
    const scales = new Float32Array(nb), qs = new Uint32Array(nb * 4);
    const q = new Int8Array(16);
    const put = (blk: number) => {
      for (let w = 0; w < 4; w++) {
        let word = 0;
        for (let k = 0; k < 4; k++) word |= (q[w * 4 + k]! & 0xff) << (8 * k);
        qs[blk * 4 + w] = word >>> 0;
      }
    };
    for (let r = 0; r < rows; r++) {
      const ro = r * m.rowBytes;
      if (m.type === GGML.Q8_0) {
        for (let b = 0; b < cols / 32; b++) {
          const o = ro + b * 34;
          const d = h[data[o]! | (data[o + 1]! << 8)]!;
          for (let half = 0; half < 2; half++) {
            for (let j = 0; j < 16; j++) q[j] = (data[o + 2 + half * 16 + j]! << 24) >> 24;
            const blk = (r * cols) / 16 + b * 2 + half;
            scales[blk] = d;
            put(blk);
          }
        }
      } else {
        for (let sb = 0; sb < cols / 256; sb++) {
          const o = ro + sb * 210;
          const d = h[data[o + 208]! | (data[o + 209]! << 8)]!;
          // element e of the 256 -> (q6 - 32), scale index e/16
          const vals = new Int8Array(256);
          for (let half = 0; half < 2; half++) {
            const ql = o + half * 64, qh = o + 128 + half * 32;
            for (let l = 0; l < 32; l++) {
              const hb = data[qh + l]!;
              vals[half * 128 + l] = ((data[ql + l]! & 0xf) | ((hb & 3) << 4)) - 32;
              vals[half * 128 + l + 32] = ((data[ql + l + 32]! & 0xf) | (((hb >> 2) & 3) << 4)) - 32;
              vals[half * 128 + l + 64] = ((data[ql + l]! >> 4) | (((hb >> 4) & 3) << 4)) - 32;
              vals[half * 128 + l + 96] = ((data[ql + l + 32]! >> 4) | (((hb >> 6) & 3) << 4)) - 32;
            }
          }
          for (let g = 0; g < 16; g++) {
            for (let j = 0; j < 16; j++) q[j] = vals[g * 16 + j]!;
            const blk = (r * cols) / 16 + sb * 16 + g;
            scales[blk] = d * ((data[o + 192 + g]! << 24) >> 24);
            put(blk);
          }
        }
      }
    }
    return { format: "q8", rows, cols, scales, qs };
  }
  const w = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) dequantizeInto(m.type, data, r * m.rowBytes, cols, w, r * cols);
  return { format: "f32", rows, cols, scales: w };
}

/** CPU mirror of the matvec shaders over a packed matrix (for tests). */
export function packedMatVec(p: PackedMatrix, x: Float32Array): Float32Array {
  const y = new Float32Array(p.rows);
  for (let r = 0; r < p.rows; r++) {
    let acc = 0;
    if (p.format === "f32") {
      for (let c = 0; c < p.cols; c++) acc += p.scales[r * p.cols + c]! * x[c]!;
    } else if (p.format === "q4") {
      const nb = p.cols / 32;
      for (let b = 0; b < nb; b++) {
        const blk = r * nb + b;
        let dot = 0, xs = 0;
        for (let w = 0; w < 4; w++) {
          const word = p.qs![blk * 4 + w]!;
          for (let k = 0; k < 4; k++) {
            const byte = (word >>> (8 * k)) & 0xff;
            const j = w * 4 + k;
            const x0 = x[b * 32 + j]!, x1 = x[b * 32 + j + 16]!;
            dot += (byte & 15) * x0 + (byte >> 4) * x1;
            xs += x0 + x1;
          }
        }
        acc += p.scales[blk]! * dot + p.mins![blk]! * xs;
      }
    } else {
      const nb = p.cols / 16;
      for (let b = 0; b < nb; b++) {
        const blk = r * nb + b;
        let dot = 0;
        for (let w = 0; w < 4; w++) {
          const word = p.qs![blk * 4 + w]!;
          for (let k = 0; k < 4; k++) dot += ((word << (24 - 8 * k)) >> 24) * x[b * 16 + w * 4 + k]!;
        }
        acc += p.scales[blk]! * dot;
      }
    }
    y[r] = acc;
  }
  return y;
}

// ---- WGSL --------------------------------------------------------------

const MATVEC_HEAD = /* wgsl */ `
struct P { rows: u32, cols: u32, add: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
var<workgroup> red: array<f32, 64>;
fn finish(row: u32, li: u32, acc: f32) {
  red[li] = acc;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) {
    if (li < s) { red[li] = red[li] + red[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    if (p.add != 0u) { y[row] = y[row] + red[0]; } else { y[row] = red[0]; }
  }
}
`;

export const WGSL = {
  matvecQ4: /* wgsl */ `${MATVEC_HEAD}
@group(0) @binding(3) var<storage, read> scales: array<f32>;
@group(0) @binding(4) var<storage, read> mins: array<f32>;
@group(0) @binding(5) var<storage, read> qs: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let row = wid.x + wid.y * 65535u;
  if (row >= p.rows) { return; }
  let nb = p.cols / 32u;
  var acc = 0.0;
  for (var b = li; b < nb; b = b + 64u) {
    let blk = row * nb + b;
    let xo = b * 32u;
    var dot = 0.0;
    var xs = 0.0;
    for (var w = 0u; w < 4u; w = w + 1u) {
      let word = qs[blk * 4u + w];
      for (var k = 0u; k < 4u; k = k + 1u) {
        let byte = (word >> (8u * k)) & 0xffu;
        let j = w * 4u + k;
        let x0 = x[xo + j];
        let x1 = x[xo + j + 16u];
        dot = dot + f32(byte & 15u) * x0 + f32(byte >> 4u) * x1;
        xs = xs + x0 + x1;
      }
    }
    acc = acc + scales[blk] * dot + mins[blk] * xs;
  }
  finish(row, li, acc);
}`,
  matvecQ8: /* wgsl */ `${MATVEC_HEAD}
@group(0) @binding(3) var<storage, read> scales: array<f32>;
@group(0) @binding(4) var<storage, read> qs: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let row = wid.x + wid.y * 65535u;
  if (row >= p.rows) { return; }
  let nb = p.cols / 16u;
  var acc = 0.0;
  for (var b = li; b < nb; b = b + 64u) {
    let blk = row * nb + b;
    let xo = b * 16u;
    var dot = 0.0;
    for (var w = 0u; w < 4u; w = w + 1u) {
      let word = qs[blk * 4u + w];
      for (var k = 0u; k < 4u; k = k + 1u) {
        let v = bitcast<i32>(word << (24u - 8u * k)) >> 24u;
        dot = dot + f32(v) * x[xo + w * 4u + k];
      }
    }
    acc = acc + scales[blk] * dot;
  }
  finish(row, li, acc);
}`,
  matvecF32: /* wgsl */ `${MATVEC_HEAD}
@group(0) @binding(3) var<storage, read> wt: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let row = wid.x + wid.y * 65535u;
  if (row >= p.rows) { return; }
  var acc = 0.0;
  let o = row * p.cols;
  for (var c = li; c < p.cols; c = c + 64u) { acc = acc + wt[o + c] * x[c]; }
  finish(row, li, acc);
}`,
  rmsnorm: /* wgsl */ `
struct P { n: u32, eps: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> w: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
var<workgroup> red: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  var ss = 0.0;
  for (var i = li; i < p.n; i = i + 256u) { ss = ss + x[i] * x[i]; }
  red[li] = ss;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) { red[li] = red[li] + red[li + s]; }
    workgroupBarrier();
  }
  let scale = inverseSqrt(red[0] / f32(p.n) + p.eps);
  for (var i = li; i < p.n; i = i + 256u) { y[i] = x[i] * scale * w[i]; }
}`,
  rope: /* wgsl */ `
struct P { nHeads: u32, headDim: u32, nRot: u32, neox: u32, base: f32, dstStride: u32, pad0: u32, pad1: u32 }
struct Pos { pos: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<uniform> ps: Pos;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let halfHd = p.headDim / 2u;
  let i = gid.x;
  if (i >= p.nHeads * halfHd) { return; }
  let h = i / halfHd;
  let q = i % halfHd;
  var i0 = 2u * q;
  var i1 = 2u * q + 1u;
  var rot = 2u * q < p.nRot;
  if (p.neox != 0u) {
    if (q < p.nRot / 2u) { i0 = q; i1 = q + p.nRot / 2u; rot = true; }
    else { i0 = p.nRot + 2u * (q - p.nRot / 2u); i1 = i0 + 1u; rot = false; }
  }
  let base = h * p.headDim;
  let a = src[base + i0] + bias[base + i0];
  let b = src[base + i1] + bias[base + i1];
  let o = ps.pos * p.dstStride + base;
  if (rot) {
    let theta = f32(ps.pos) * pow(p.base, -2.0 * f32(q) / f32(p.nRot));
    let c = cos(theta);
    let s = sin(theta);
    dst[o + i0] = a * c - b * s;
    dst[o + i1] = a * s + b * c;
  } else {
    dst[o + i0] = a;
    dst[o + i1] = b;
  }
}`,
  copyBias: /* wgsl */ `
struct P { n: u32, dstStride: u32, pad0: u32, pad1: u32 }
struct Pos { pos: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<uniform> ps: Pos;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  dst[ps.pos * p.dstStride + i] = src[i] + bias[i];
}`,
  attention: /* wgsl */ `
struct P { nHeads: u32, nKvHeads: u32, headDim: u32, kvDim: u32, ctx: u32, scale: f32, pad0: u32, pad1: u32 }
struct Pos { pos: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<uniform> ps: Pos;
@group(0) @binding(2) var<storage, read> q: array<f32>;
@group(0) @binding(3) var<storage, read> kc: array<f32>;
@group(0) @binding(4) var<storage, read> vc: array<f32>;
@group(0) @binding(5) var<storage, read_write> scores: array<f32>;
@group(0) @binding(6) var<storage, read_write> outv: array<f32>;
var<workgroup> red: array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let h = wid.x;
  let kvh = h / (p.nHeads / p.nKvHeads);
  let n = ps.pos + 1u;
  let qo = h * p.headDim;
  let ko = kvh * p.headDim;
  let so = h * p.ctx;
  var mx = -3.4e38;
  for (var t = li; t < n; t = t + 64u) {
    var s = 0.0;
    for (var d = 0u; d < p.headDim; d = d + 1u) { s = s + q[qo + d] * kc[t * p.kvDim + ko + d]; }
    s = s * p.scale;
    scores[so + t] = s;
    mx = max(mx, s);
  }
  red[li] = mx;
  workgroupBarrier();
  for (var st = 32u; st > 0u; st = st >> 1u) {
    if (li < st) { red[li] = max(red[li], red[li + st]); }
    workgroupBarrier();
  }
  let m = red[0];
  workgroupBarrier();
  var sum = 0.0;
  for (var t = li; t < n; t = t + 64u) {
    let e = exp(scores[so + t] - m);
    scores[so + t] = e;
    sum = sum + e;
  }
  red[li] = sum;
  workgroupBarrier();
  for (var st = 32u; st > 0u; st = st >> 1u) {
    if (li < st) { red[li] = red[li] + red[li + st]; }
    workgroupBarrier();
  }
  let total = red[0];
  storageBarrier();
  for (var d = li; d < p.headDim; d = d + 64u) {
    var acc = 0.0;
    for (var t = 0u; t < n; t = t + 1u) { acc = acc + scores[so + t] * vc[t * p.kvDim + ko + d]; }
    outv[qo + d] = acc / total;
  }
}`,
  swiglu: /* wgsl */ `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read> u: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let a = g[i];
  y[i] = a / (1.0 + exp(-a)) * u[i];
}`,
};

// ---- runtime -----------------------------------------------------------

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator && !!(navigator as Navigator).gpu;
}

interface GpuMatrix {
  rows: number;
  format: GpuFormat;
  buffers: GPUBuffer[];
}

type Dispatch = { pipeline: GPUComputePipeline; bind: GPUBindGroup; x: number; y: number };

export class WebGpuBackend implements Backend {
  readonly name = "webgpu" as const;
  private length = 0;
  private constructor(
    readonly config: ModelConfig,
    private weights: ModelWeights,
    private device: GPUDevice,
    readonly capacity: number,
    private xBuf: GPUBuffer,
    private posBuf: GPUBuffer,
    private logitsBuf: GPUBuffer,
    private staging: GPUBuffer,
    private dispatches: Dispatch[],
  ) {}

  get cached() {
    return this.length;
  }

  truncate(n: number) {
    this.length = Math.min(this.length, n);
  }

  async forward(token: number): Promise<Float32Array> {
    const c = this.config;
    const pos = this.length;
    if (pos >= this.capacity) throw new Error(`kiln: context full (${this.capacity} tokens)`);
    const q = this.device.queue;
    q.writeBuffer(this.xBuf, 0, matRow(this.weights.tokenEmbd, token));
    q.writeBuffer(this.posBuf, 0, new Uint32Array([pos, 0, 0, 0]));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    for (const d of this.dispatches) {
      pass.setPipeline(d.pipeline);
      pass.setBindGroup(0, d.bind);
      pass.dispatchWorkgroups(d.x, d.y);
    }
    pass.end();
    enc.copyBufferToBuffer(this.logitsBuf, 0, this.staging, 0, c.vocabSize * 4);
    q.submit([enc.finish()]);
    await this.staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(this.staging.getMappedRange().slice(0));
    this.staging.unmap();
    this.length = pos + 1;
    return out;
  }

  /** Release the GPU device and every buffer on it. */
  dispose() {
    this.device.destroy();
  }

  /** Build the backend, or return null when WebGPU (or a suitable adapter) is missing. */
  static async create(config: ModelConfig, weights: ModelWeights, contextLength: number): Promise<WebGpuBackend | null> {
    if (!webGpuAvailable()) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBuffersPerShaderStage: Math.min(adapter.limits.maxStorageBuffersPerShaderStage, 8),
      },
    });
    const c = config;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const U = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    const buf = (bytes: number, usage = S) => device.createBuffer({ size: Math.max(16, Math.ceil(bytes / 4) * 4), usage });
    const upload = (data: ArrayBufferView, usage = S) => {
      const b = buf(data.byteLength, usage);
      device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
      return b;
    };
    const uniform = (words: (number | { f: number })[]) => {
      const a = new ArrayBuffer(Math.max(16, Math.ceil(words.length / 4) * 16));
      const dv = new DataView(a);
      words.forEach((w, i) => (typeof w === "number" ? dv.setUint32(i * 4, w, true) : dv.setFloat32(i * 4, w.f, true)));
      return upload(new Uint8Array(a), U);
    };
    const pipes = new Map<string, GPUComputePipeline>();
    const pipe = (code: string) => {
      let p = pipes.get(code);
      if (!p) pipes.set(code, (p = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" } })));
      return p;
    };
    const matrix = (m: QMatrix): GpuMatrix => {
      const p = packForGpu(m);
      const buffers = p.format === "q4" ? [upload(p.scales), upload(p.mins!), upload(p.qs!)] : p.format === "q8" ? [upload(p.scales), upload(p.qs!)] : [upload(p.scales)];
      return { rows: m.rows, format: p.format, buffers };
    };
    const dispatches: Dispatch[] = [];
    const add = (code: string, entries: GPUBuffer[], x: number, y = 1) => {
      const pipeline = pipe(code);
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: entries.map((buffer, binding) => ({ binding, resource: { buffer } })) });
      dispatches.push({ pipeline, bind, x, y });
    };
    const matvec = (m: GpuMatrix, cols: number, x: GPUBuffer, y: GPUBuffer, accumulate: boolean) => {
      const code = m.format === "q4" ? WGSL.matvecQ4 : m.format === "q8" ? WGSL.matvecQ8 : WGSL.matvecF32;
      add(code, [uniform([m.rows, cols, accumulate ? 1 : 0, 0]), x, y, ...m.buffers], Math.min(m.rows, 65535), Math.ceil(m.rows / 65535));
    };
    const qDim = c.nHeads * c.headDim, kvDim = c.nKvHeads * c.headDim;
    const xBuf = buf(c.dim * 4), xb = buf(c.dim * 4), xb2 = buf(Math.max(c.dim, qDim) * 4);
    const qRaw = buf(qDim * 4), qRot = buf(qDim * 4), kRaw = buf(kvDim * 4), vRaw = buf(kvDim * 4), att = buf(qDim * 4);
    const scores = buf(c.nHeads * contextLength * 4);
    const g = buf(c.ffnDim * 4), u = buf(c.ffnDim * 4), hb = buf(c.ffnDim * 4);
    const logitsBuf = buf(c.vocabSize * 4);
    const staging = device.createBuffer({ size: c.vocabSize * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const posBuf = buf(16, U);
    const zerosQ = buf(qDim * 4), zerosKv = buf(kvDim * 4);
    const ropeQ = uniform([c.nHeads, c.headDim, c.nRot, c.ropeStyle === "neox" ? 1 : 0, { f: c.ropeBase }, 0, 0, 0]);
    const ropeK = uniform([c.nKvHeads, c.headDim, c.nRot, c.ropeStyle === "neox" ? 1 : 0, { f: c.ropeBase }, kvDim, 0, 0]);
    const vCopy = uniform([kvDim, kvDim, 0, 0]);
    const attP = uniform([c.nHeads, c.nKvHeads, c.headDim, kvDim, contextLength, { f: 1 / Math.sqrt(c.headDim) }, 0, 0]);
    const normP = uniform([c.dim, { f: c.normEps }, 0, 0]);
    const swP = uniform([c.ffnDim, 0, 0, 0]);

    for (const L of weights.layers) {
      const kc = buf(contextLength * kvDim * 4), vc = buf(contextLength * kvDim * 4);
      add(WGSL.rmsnorm, [normP, xBuf, upload(L.attnNorm), xb], 1);
      matvec(matrix(L.wq), c.dim, xb, qRaw, false);
      matvec(matrix(L.wk), c.dim, xb, kRaw, false);
      matvec(matrix(L.wv), c.dim, xb, vRaw, false);
      add(WGSL.rope, [ropeQ, posBuf, qRaw, L.bq ? upload(L.bq) : zerosQ, qRot], Math.ceil((qDim / 2) / 64));
      add(WGSL.rope, [ropeK, posBuf, kRaw, L.bk ? upload(L.bk) : zerosKv, kc], Math.ceil((kvDim / 2) / 64));
      add(WGSL.copyBias, [vCopy, posBuf, vRaw, L.bv ? upload(L.bv) : zerosKv, vc], Math.ceil(kvDim / 64));
      add(WGSL.attention, [attP, posBuf, qRot, kc, vc, scores, att], c.nHeads);
      matvec(matrix(L.wo), qDim, att, xBuf, true);
      add(WGSL.rmsnorm, [normP, xBuf, upload(L.ffnNorm), xb], 1);
      matvec(matrix(L.wGate), c.dim, xb, g, false);
      matvec(matrix(L.wUp), c.dim, xb, u, false);
      add(WGSL.swiglu, [swP, g, u, hb], Math.ceil(c.ffnDim / 64));
      matvec(matrix(L.wDown), c.ffnDim, hb, xBuf, true);
    }
    add(WGSL.rmsnorm, [normP, xBuf, upload(weights.outputNorm), xb2], 1);
    matvec(matrix(weights.output), c.dim, xb2, logitsBuf, false);
    return new WebGpuBackend(config, weights, device, contextLength, xBuf, posBuf, logitsBuf, staging, dispatches);
  }
}
