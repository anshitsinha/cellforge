import { describe, expect, it } from "vitest";
import { radixSortIndices } from "../src/radix";

const sortBy = (values: number[], descending = false, kinds?: number[]) =>
  Array.from(
    radixSortIndices(Float64Array.from(values), kinds ? Uint8Array.from(kinds) : null, descending),
  );

describe("radixSortIndices", () => {
  it("sorts positives, negatives, zero and fractions", () => {
    const v = [3, -1.5, 0, 2.25, -100, 1e9, -0.001];
    const order = sortBy(v);
    expect(order.map((i) => v[i])).toEqual([...v].sort((a, b) => a - b));
  });

  it("sorts descending", () => {
    const v = [1, 5, -3, 2];
    expect(sortBy(v, true).map((i) => v[i])).toEqual([5, 2, 1, -3]);
  });

  it("is stable", () => {
    const v = [1, 0, 1, 0, 1];
    expect(sortBy(v)).toEqual([1, 3, 0, 2, 4]);
    expect(sortBy(v, true)).toEqual([0, 2, 4, 1, 3]);
  });

  it("uses kinds as the primary key", () => {
    // kind 2 (blank) last even though its key is smallest
    const v = [5, -1, 3];
    expect(sortBy(v, false, [0, 2, 0])).toEqual([2, 0, 1]);
  });

  it("matches Array#sort on random data", () => {
    const v = Array.from({ length: 10_000 }, () => (Math.random() - 0.5) * 1e6);
    const order = sortBy(v);
    expect(order.map((i) => v[i])).toEqual([...v].sort((a, b) => a - b));
  });
});
