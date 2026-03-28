import { describe, expect, it } from "vitest";
import { RowLayout } from "../src/rowlayout";
import { RowVisibility } from "../src/rows";

describe("RowLayout", () => {
  it("default heights are a multiplication", () => {
    const l = new RowLayout(20);
    l.update(new Map(), new RowVisibility(), 100_000_000);
    expect(l.top(5)).toBe(100);
    expect(l.indexAt(119)).toBe(5);
    expect(l.total).toBe(2_000_000_000);
    expect(l.indexAt(1e12)).toBe(99_999_999);
  });

  it("matches a brute-force model with custom heights and hidden rows", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let round = 0; round < 30; round++) {
      const rows = 40;
      const vis = new RowVisibility();
      const hiddenRows = new Set<number>();
      const intervals: [number, number][] = [];
      for (let k = 0; k < 3; k++) {
        const a = Math.floor(rand() * rows);
        const b = Math.min(rows - 1, a + Math.floor(rand() * 3));
        intervals.push([a, b]);
        for (let r = a; r <= b; r++) hiddenRows.add(r);
      }
      vis.set(intervals);
      const custom = new Map<number, number>();
      for (let k = 0; k < 8; k++) custom.set(Math.floor(rand() * rows), 10 + Math.floor(rand() * 60));
      const l = new RowLayout(20);
      const visible = Array.from({ length: rows }, (_, r) => r).filter((r) => !hiddenRows.has(r));
      l.update(custom, vis, visible.length);
      let y = 0;
      visible.forEach((r, d) => {
        const h = custom.get(r) ?? 20;
        expect(l.top(d)).toBe(y);
        expect(l.height(d)).toBe(h);
        expect(l.indexAt(y)).toBe(d);
        expect(l.indexAt(y + h - 1)).toBe(d);
        y += h;
      });
      expect(l.total).toBe(y);
    }
  });
});
