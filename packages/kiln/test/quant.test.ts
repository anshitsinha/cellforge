import { describe, expect, it } from "vitest";
import { GGML, type GGMLType } from "../src/gguf";
import { dequantize, makeQMatrix, matRow, matVec, quantize } from "../src/quant";
import { makeRng } from "../src/sample";
import { packForGpu, packedMatVec } from "../src/webgpu";

const le16 = (h: number) => [h & 0xff, h >> 8];

describe("dequantisation against hand-computed blocks", () => {
  it("Q8_0: x = d * q", () => {
    // d = 0.5 (f16 0x3800)
    const q = [0, 1, -1, 127, -128, 2, -2, 64, ...new Array(24).fill(3)];
    const block = new Uint8Array([...le16(0x3800), ...q.map((v) => v & 0xff)]);
    const x = dequantize(GGML.Q8_0, block, 32);
    expect(Array.from(x.subarray(0, 8))).toEqual([0, 0.5, -0.5, 63.5, -64, 1, -1, 32]);
    expect(x[31]).toBe(1.5);
  });

  it("Q4_0: low nibbles are values 0..15, high nibbles 16..31, offset 8", () => {
    // d = 2; byte j = j | (15-j) << 4
    const qs = Array.from({ length: 16 }, (_, j) => j | ((15 - j) << 4));
    const x = dequantize(GGML.Q4_0, new Uint8Array([...le16(0x4000), ...qs]), 32);
    expect(Array.from(x.subarray(0, 4))).toEqual([-16, -14, -12, -10]); // (j-8)*2
    expect(x[15]).toBe(14);
    expect(Array.from(x.subarray(16, 20))).toEqual([14, 12, 10, 8]); // (15-j-8)*2
    expect(x[31]).toBe(-16);
  });

  // d = 1, dmin = 0.5; sub-block scales 1..7,63 and mins 0..6,63 packed by hand:
  //   bytes 0-3:  sc0..3 | high2(sc4..7) << 6   -> 1, 2, 3, 4|3<<6
  //   bytes 4-7:  m0..3  | high2(m4..7) << 6    -> 0, 1, 2, 3|3<<6
  //   bytes 8-11: low4(sc4..7) | low4(m4..7)<<4 -> 5|4<<4, 6|5<<4, 7|6<<4, 15|15<<4
  const Q4K_SCALES = [1, 2, 3, 196, 0, 1, 2, 195, 69, 86, 103, 255];
  it("Q4_K: 6-bit scales/mins and the shared nibble layout", () => {
    const block = new Uint8Array([...le16(0x3c00), ...le16(0x3800), ...Q4K_SCALES, ...new Array(128).fill(0x21)]);
    const x = dequantize(GGML.Q4_K, block, 256);
    // even sub-blocks read the low nibble (1), odd ones the high nibble (2): d*sc*q - dmin*m
    const expected = [1 * 1 - 0, 2 * 2 - 0.5, 3 * 1 - 1, 4 * 2 - 1.5, 5 * 1 - 2, 6 * 2 - 2.5, 7 * 1 - 3, 63 * 2 - 31.5];
    expect(expected).toEqual([1, 3.5, 2, 6.5, 3, 9.5, 4, 94.5]);
    for (let j = 0; j < 8; j++) for (let l = 0; l < 32; l++) expect(x[j * 32 + l]).toBe(expected[j]);
  });

  it("Q4_K: element order within a 64-value chunk", () => {
    // byte l of chunk c = (l & 15) | (15 - (l & 15)) << 4
    const qs = Array.from({ length: 128 }, (_, i) => (i % 16) | ((15 - (i % 16)) << 4));
    const x = dequantize(GGML.Q4_K, new Uint8Array([...le16(0x3c00), ...le16(0x3800), ...Q4K_SCALES, ...qs]), 256);
    expect(x[0]).toBe(0); // sub-block 0: 1*0 - 0
    expect(x[5]).toBe(5);
    expect(x[32]).toBe(2 * 15 - 0.5); // sub-block 1, l=0: high nibble 15
    expect(x[37]).toBe(2 * 10 - 0.5);
    expect(x[64 + 3]).toBe(3 * 3 - 1); // sub-block 2
    expect(x[224 + 1]).toBe(63 * 14 - 31.5); // sub-block 7, l=1
  });

  it("Q6_K: 4+2 bit values, int8 scales, ql/qh layout", () => {
    // d = 0.5, all scales 1 except scale 15 = -2
    const scales = [...new Array(15).fill(1), -2 & 0xff];
    // ql bytes 0x21 (low 1, high 2); qh bits per l: q1 0, q2 1, q3 2, q4 3 -> 0b11100100
    const block = new Uint8Array([...new Array(128).fill(0x21), ...new Array(64).fill(0xe4), ...scales, ...le16(0x3800)]);
    const x = dequantize(GGML.Q6_K, block, 256);
    // q1 = 1-32, q2 = 1|16 -32, q3 = 2|32 -32, q4 = 2|48 -32 -> -31, -15, 2, 18; times 0.5
    expect(x[0]).toBe(-15.5);
    expect(x[40]).toBe(-7.5);
    expect(x[70]).toBe(1);
    expect(x[100]).toBe(9);
    expect(x[128]).toBe(-15.5);
    expect(x[255]).toBe(9 * -2); // last group uses scale -2
    const zeros = new Uint8Array([...new Array(192).fill(0), ...scales, ...le16(0x3800)]);
    expect(dequantize(GGML.Q6_K, zeros, 256)[3]).toBe(-16); // q = -32
  });

  it("F16 / BF16 / F32 rows", () => {
    expect(Array.from(dequantize(GGML.F16, new Uint8Array([...le16(0x3c00), ...le16(0xc000)]), 2))).toEqual([1, -2]);
    expect(Array.from(dequantize(GGML.BF16, new Uint8Array([...le16(0x3f80), ...le16(0xc040)]), 2))).toEqual([1, -3]);
    expect(Array.from(dequantize(GGML.F32, new Uint8Array(new Float32Array([1.5, -2]).buffer), 2))).toEqual([1.5, -2]);
  });

  it("names unsupported types", () => {
    expect(() => dequantize(GGML.Q5_K, new Uint8Array(176), 256)).toThrow(/Q5_K is not supported/);
    expect(() => dequantize(GGML.IQ4_XS, new Uint8Array(136), 256)).toThrow(/not supported/);
  });
});

describe("quantisers", () => {
  const rng = makeRng(7);
  const data = Float32Array.from({ length: 512 }, () => (rng() - 0.5) * 4);
  const cases: [string, GGMLType, number][] = [
    ["F16", GGML.F16, 2e-3],
    ["Q8_0", GGML.Q8_0, 0.02],
    ["Q6_K", GGML.Q6_K, 0.05],
    ["Q4_0", GGML.Q4_0, 0.3],
    ["Q4_K", GGML.Q4_K, 0.2],
  ];
  for (const [name, t, tol] of cases) {
    it(`${name} round-trips within its precision`, () => {
      const back = dequantize(t, quantize(t, data), data.length);
      let worst = 0;
      for (let i = 0; i < data.length; i++) worst = Math.max(worst, Math.abs(back[i]! - data[i]!));
      expect(worst).toBeLessThan(tol);
    });
  }
});

describe("matVec on quantised blocks", () => {
  const rows = 6, cols = 512;
  const rng = makeRng(11);
  const w = Float32Array.from({ length: rows * cols }, () => rng() * 2 - 1);
  const x = Float32Array.from({ length: cols }, () => rng() * 2 - 1);
  for (const t of [GGML.F32, GGML.F16, GGML.Q8_0, GGML.Q4_0, GGML.Q4_K, GGML.Q6_K]) {
    it(`type ${t}: equals the dot product of the dequantised rows, and the GPU packing agrees`, () => {
      const m = makeQMatrix(t, rows, cols, quantize(t, w));
      const y = new Float32Array(rows);
      matVec(m, x, y);
      const packed = packedMatVec(packForGpu(m), x);
      for (let r = 0; r < rows; r++) {
        const row = matRow(m, r);
        let ref = 0;
        for (let c = 0; c < cols; c++) ref += row[c]! * x[c]!;
        expect(y[r]).toBeCloseTo(ref, 4);
        expect(packed[r]).toBeCloseTo(ref, 4);
      }
    });
  }
  it("respects a row range", () => {
    const m = makeQMatrix(GGML.Q4_0, rows, cols, quantize(GGML.Q4_0, w));
    const y = new Float32Array(rows);
    matVec(m, x, y, 2, 4);
    expect(y[0]).toBe(0);
    expect(y[2]).not.toBe(0);
    expect(y[4]).toBe(0);
  });
});
