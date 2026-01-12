/// <reference types="@webgpu/types" />
import { WORKGROUP_SIZE, type WgslKernel } from "./wgsl";

export interface GpuTimings {
  /** f64 -> f32 conversion on the CPU */
  convertMs: number;
  /** writeBuffer for inputs */
  uploadMs: number;
  /** submit -> onSubmittedWorkDone for the compute pass alone */
  computeMs: number;
  /** copy to a mappable buffer + mapAsync */
  readbackMs: number;
  totalMs: number;
}

/**
 * Runs WGSL fill kernels. One instance owns a GPUDevice and caches compute
 * pipelines per shader source.
 *
 * Inputs larger than the device's storage-buffer binding limit are processed
 * in slices, each slice uploading only the input window it needs.
 */
export class GpuRunner {
  private pipelines = new Map<string, GPUComputePipeline>();

  private constructor(
    readonly device: GPUDevice,
    readonly adapterInfo: string,
  ) {}

  static async create(): Promise<GpuRunner | null> {
    if (!("gpu" in navigator)) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: {
        // ask for as much as the hardware allows - the defaults (128MB) cap a
        // single input at 32M f32 rows
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
      },
    });
    // validation errors don't throw - surface them instead of silently
    // getting zeros back
    device.addEventListener("uncapturederror", (e) =>
      console.error("WebGPU error:", (e as GPUUncapturedErrorEvent).error.message),
    );
    const info = adapter.info;
    const name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(" ") || "unknown GPU";
    return new GpuRunner(device, name);
  }

  get maxRowsPerSlice(): number {
    return Math.floor(this.device.limits.maxStorageBufferBindingSize / 4);
  }

  private pipeline(kernel: WgslKernel): GPUComputePipeline {
    let p = this.pipelines.get(kernel.code);
    if (!p) {
      const module = this.device.createShaderModule({ code: kernel.code });
      // Explicit layout rather than "auto": auto drops bindings the shader
      // never reads (e.g. `scalars` for a formula without $refs), and then
      // createBindGroup fails validation - silently, since WebGPU reports
      // errors asynchronously. Every dispatch was a no-op until this.
      const storage = (type: GPUBufferBindingType): GPUBindGroupLayoutEntry["buffer"] => ({ type });
      const layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: storage("uniform") },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: storage("read-only-storage") },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: storage("storage") },
          ...kernel.columns.map((_, i) => ({
            binding: i + 3,
            visibility: GPUShaderStage.COMPUTE,
            buffer: storage("read-only-storage"),
          })),
        ],
      });
      p = this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: "main" },
      });
      this.pipelines.set(kernel.code, p);
    }
    return p;
  }

  /**
   * Compute rows [0, n) of a fill. `columns[i]` is the full f64 input for
   * kernel.columns[i] (index = row). Returns f32 results.
   */
  async run(
    kernel: WgslKernel,
    columns: Float64Array[],
    scalars: number[],
    n: number,
  ): Promise<{ out: Float32Array; timings: GpuTimings }> {
    const { device } = this;
    const pipeline = this.pipeline(kernel);
    const t0 = performance.now();
    const timings: GpuTimings = { convertMs: 0, uploadMs: 0, computeMs: 0, readbackMs: 0, totalMs: 0 };

    const span = kernel.maxOffset - kernel.minOffset;
    const sliceRows = Math.max(1, this.maxRowsPerSlice - span);
    const out = new Float32Array(n);

    const scalarBuf = device.createBuffer({
      size: Math.max(16, scalars.length * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(scalarBuf, 0, new Float32Array(scalars.length ? scalars : [0, 0, 0, 0]));
    const paramBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    for (let start = 0; start < n; start += sliceRows) {
      const count = Math.min(sliceRows, n - start);
      const lo = Math.max(0, start + kernel.minOffset);
      const hi = Math.min(n - 1, start + count - 1 + kernel.maxOffset);

      // f64 -> f32 for this slice's input window
      let t = performance.now();
      const inputs32 = columns.map((c) => Float32Array.from(c.subarray(lo, hi + 1)));
      timings.convertMs += performance.now() - t;

      t = performance.now();
      const inputBufs = inputs32.map((data) => {
        const buf = device.createBuffer({ size: Math.max(4, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buf, 0, data);
        return buf;
      });
      const params = new ArrayBuffer(16);
      new Uint32Array(params, 0, 3).set([start, count, n]);
      new Int32Array(params, 12, 1)[0] = lo;
      device.queue.writeBuffer(paramBuf, 0, params);
      const outBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      await device.queue.onSubmittedWorkDone();
      timings.uploadMs += performance.now() - t;

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramBuf } },
          { binding: 1, resource: { buffer: scalarBuf } },
          { binding: 2, resource: { buffer: outBuf } },
          ...inputBufs.map((buffer, i) => ({ binding: i + 3, resource: { buffer } })),
        ],
      });

      t = performance.now();
      const groups = Math.ceil(count / WORKGROUP_SIZE);
      const x = Math.min(groups, device.limits.maxComputeWorkgroupsPerDimension);
      const y = Math.ceil(groups / x);
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(x, y);
      pass.end();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      timings.computeMs += performance.now() - t;

      t = performance.now();
      const readBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const copy = device.createCommandEncoder();
      copy.copyBufferToBuffer(outBuf, 0, readBuf, 0, count * 4);
      device.queue.submit([copy.finish()]);
      await readBuf.mapAsync(GPUMapMode.READ);
      out.set(new Float32Array(readBuf.getMappedRange()), start);
      readBuf.unmap();
      timings.readbackMs += performance.now() - t;

      for (const b of [...inputBufs, outBuf, readBuf]) b.destroy();
    }

    scalarBuf.destroy();
    paramBuf.destroy();
    timings.totalMs = performance.now() - t0;
    return { out, timings };
  }

  destroy(): void {
    this.device.destroy();
  }
}
