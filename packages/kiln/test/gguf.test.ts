import { describe, expect, it } from "vitest";
import { GGML, GGUF_VALUE, bf16ToF32, f16ToF32, f32ToF16, metaNumber, parseGGUF, tensorBytes } from "../src/gguf";
import { gv, writeGGUF } from "../src/gguf-writer";
import { makeQMatrix } from "../src/quant";

describe("half precision", () => {
  it("decodes known f16 bit patterns", () => {
    expect(f16ToF32(0x3c00)).toBe(1);
    expect(f16ToF32(0xc000)).toBe(-2);
    expect(f16ToF32(0x3800)).toBe(0.5);
    expect(f16ToF32(0x7bff)).toBe(65504);
    expect(f16ToF32(0x0001)).toBe(2 ** -24);
    expect(f16ToF32(0x7c00)).toBe(Infinity);
    expect(f16ToF32(0x8000)).toBe(-0);
    expect(Number.isNaN(f16ToF32(0x7e00))).toBe(true);
  });
  it("encodes with round-to-nearest-even and round-trips every finite half", () => {
    expect(f32ToF16(1)).toBe(0x3c00);
    expect(f32ToF16(-2)).toBe(0xc000);
    expect(f32ToF16(65504)).toBe(0x7bff);
    expect(f32ToF16(1e6)).toBe(0x7c00);
    expect(f32ToF16(2 ** -24)).toBe(0x0001);
    // 1 + 2^-11 is exactly between 1 and the next half: ties to even (1)
    expect(f32ToF16(1 + 2 ** -11)).toBe(0x3c00);
    expect(f32ToF16(1 + 3 * 2 ** -11)).toBe(0x3c02);
    for (let h = 0; h < 0x7c00; h++) expect(f32ToF16(f16ToF32(h))).toBe(h);
  });
  it("decodes bf16", () => {
    expect(bf16ToF32(0x3f80)).toBe(1);
    expect(bf16ToF32(0xc040)).toBe(-3);
  });
});

describe("GGUF reader", () => {
  const f32 = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const build = (version: 2 | 3, alignment = 32) =>
    writeGGUF(
      {
        "general.architecture": "llama",
        "general.name": "tiny ✓",
        "test.u8": gv.u8(200),
        "test.i32": -7,
        "test.u32": 4000000000,
        "test.f32": gv.f32(0.25),
        "test.f64": gv.f64(Math.PI),
        "test.u64": gv.u64(2 ** 40),
        "test.bool": true,
        "test.strings": gv.strings(["a", "▁b", "<0x0A>"]),
        "test.floats": gv.f32s([0.5, -1.5]),
        "test.ints": gv.i32s([1, -2, 3]),
      },
      [
        { name: "a", dims: [4, 2], type: GGML.F32, data: new Uint8Array(f32.buffer) },
        { name: "b", dims: [32], type: GGML.Q8_0, data: new Uint8Array(34).fill(1) },
      ],
      { version, alignment },
    );

  for (const version of [2, 3] as const) {
    it(`parses metadata and tensor infos (v${version})`, () => {
      const bytes = build(version);
      const f = parseGGUF(bytes.buffer as ArrayBuffer);
      expect(f.version).toBe(version);
      expect(f.metadata.get("general.name")).toBe("tiny ✓");
      expect(f.metadata.get("test.u8")).toBe(200);
      expect(f.metadata.get("test.i32")).toBe(-7);
      expect(f.metadata.get("test.u32")).toBe(4000000000);
      expect(f.metadata.get("test.f32")).toBe(0.25);
      expect(f.metadata.get("test.f64")).toBe(Math.PI);
      expect(f.metadata.get("test.u64")).toBe(2 ** 40);
      expect(f.metadata.get("test.bool")).toBe(true);
      expect(f.metadata.get("test.strings")).toEqual(["a", "▁b", "<0x0A>"]);
      expect(Array.from(f.metadata.get("test.floats") as Float32Array)).toEqual([0.5, -1.5]);
      expect(Array.from(f.metadata.get("test.ints") as Int32Array)).toEqual([1, -2, 3]);
      expect(metaNumber(f, "test.i32")).toBe(-7);
      expect(f.tensors.map((t) => [t.name, t.dims, t.type])).toEqual([
        ["a", [4, 2], GGML.F32],
        ["b", [32], GGML.Q8_0],
      ]);
      expect(f.dataOffset % 32).toBe(0);
    });
  }

  it("maps tensors without copying", () => {
    const bytes = build(3);
    const f = parseGGUF(bytes);
    const a = f.tensor("a")!;
    expect(a.data.buffer).toBe(bytes.buffer);
    expect(a.offset % 32).toBe(0);
    const m = makeQMatrix(a.type, 2, 4, a.data);
    expect(m.f32!.buffer).toBe(bytes.buffer);
    expect(Array.from(m.f32!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(f.tensor("b")!.byteLength).toBe(34);
  });

  it("honours general.alignment", () => {
    const f = parseGGUF(build(3, 64));
    expect(f.alignment).toBe(64);
    expect(f.dataOffset % 64).toBe(0);
    expect(f.tensor("b")!.offset % 64).toBe(0);
  });

  it("rejects bad input clearly", () => {
    const bytes = build(3);
    const bad = bytes.slice();
    bad[0] = 0;
    expect(() => parseGGUF(bad)).toThrow(/magic/);
    expect(() => parseGGUF(bytes.slice(0, bytes.length - 40))).toThrow(/truncated/);
    const v1 = bytes.slice();
    v1[4] = 1;
    expect(() => parseGGUF(v1)).toThrow(/version 1/);
    expect(GGUF_VALUE.ARRAY).toBe(9);
  });

  it("knows block sizes of unsupported types but refuses to compute with them", () => {
    expect(tensorBytes(GGML.Q5_K, 256)).toBe(176);
    const bytes = writeGGUF({}, [{ name: "q5", dims: [256], type: GGML.Q5_K, data: new Uint8Array(176) }]);
    const t = parseGGUF(bytes).tensor("q5")!;
    expect(() => makeQMatrix(t.type, 1, 256, t.data)).toThrow(/Q5_K is not supported/);
  });
});
