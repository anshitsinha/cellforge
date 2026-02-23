import { describe, expect, it } from "vitest";
import { RowVisibility } from "../src/rows";

describe("RowVisibility", () => {
  it("maps between real rows and display positions", () => {
    const v = new RowVisibility();
    v.set([
      [4, 4],
      [10, 12],
    ]); // hide row 5 and rows 11-13 (0-based 4, 10..12)
    expect(v.hiddenCount).toBe(4);
    expect([0, 3, 5, 9, 13].map((r) => v.toDisplay(r))).toEqual([0, 3, 4, 8, 9]);
    expect([0, 3, 4, 8, 9].map((d) => v.toRow(d))).toEqual([0, 3, 5, 9, 13]);
    expect(v.toDisplay(4)).toBe(4); // a hidden row maps to where the next visible one shows
    expect(v.isHidden(11)).toBe(true);
    expect(v.isHidden(13)).toBe(false);
  });

  it("merges overlapping and adjacent intervals", () => {
    const v = new RowVisibility();
    v.set([
      [5, 7],
      [8, 9],
      [6, 6],
      [20, 19], // empty: ignored
    ]);
    expect(v.intervals).toEqual([[5, 9]]);
  });

  it("finds the nearest visible row in either direction", () => {
    const v = new RowVisibility();
    v.set([
      [3, 5],
      [6, 8],
    ]);
    expect(v.nearest(3, 1, 20)).toBe(9);
    expect(v.nearest(8, -1, 20)).toBe(2);
    expect(v.nearest(0, -1, 20)).toBe(0);
    v.set([[0, 19]]);
    expect(v.nearest(5, 1, 20)).toBeNull();
  });

  it("round-trips every visible row, randomised", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let t = 0; t < 50; t++) {
      const v = new RowVisibility();
      const intervals: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const a = Math.floor(rand() * 200);
        intervals.push([a, a + Math.floor(rand() * 10)]);
      }
      v.set(intervals);
      const hidden = new Set<number>();
      for (const [a, b] of intervals) for (let r = a; r <= b; r++) hidden.add(r);
      let d = 0;
      for (let r = 0; r < 260; r++) {
        if (hidden.has(r)) continue;
        expect(v.toDisplay(r)).toBe(d);
        expect(v.toRow(d)).toBe(r);
        d++;
      }
    }
  });
});
