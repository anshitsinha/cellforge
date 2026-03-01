import { describe, expect, it } from "vitest";
import { RunList, SheetStyles, StyleTable } from "./styles";

describe("StyleTable", () => {
  it("interns equal styles to one id and treats false as missing", () => {
    const t = new StyleTable();
    const a = t.intern({ bold: true, color: "#f00" });
    expect(t.intern({ color: "#f00", bold: true })).toBe(a);
    expect(t.intern({ bold: false })).toBe(0);
    expect(t.apply(a, { bold: null })).toBe(t.intern({ color: "#f00" }));
  });
});

describe("RunList vs a plain array", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}`, () => {
      const rand = rng(seed);
      const N = 60;
      const model = new Array<number>(N).fill(0);
      const runs = new RunList();
      for (let step = 0; step < 200; step++) {
        // a few random disjoint intervals
        const cuts = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => Math.floor(rand() * N)).sort((a, b) => a - b);
        const intervals: [number, number][] = [];
        for (let i = 0; i + 1 < cuts.length; i += 2) {
          const lo = cuts[i];
          const hi = cuts[i + 1];
          if (!intervals.length || lo > intervals[intervals.length - 1][1]) intervals.push([lo, hi]);
        }
        if (!intervals.length) intervals.push([cuts[0], cuts[0]]);
        const k = Math.floor(rand() * 4);
        const fn = (id: number) => (k === 0 ? 0 : (id + k) % 5);
        runs.applyMany(intervals, fn, 0);
        for (const [lo, hi] of intervals) for (let r = lo; r <= hi; r++) model[r] = fn(model[r]);
        const got = Array.from({ length: N }, (_, r) => Math.max(0, runs.find(r)));
        expect(got, `seed ${seed} step ${step}`).toEqual(model);
        // runs are sorted, disjoint, merged, and never the gap style
        for (let i = 0; i < runs.length; i++) {
          expect(runs.ids[i]).not.toBe(0);
          expect(runs.starts[i]).toBeLessThanOrEqual(runs.ends[i]);
          if (i) {
            expect(runs.starts[i]).toBeGreaterThan(runs.ends[i - 1]);
            if (runs.starts[i] === runs.ends[i - 1] + 1) expect(runs.ids[i]).not.toBe(runs.ids[i - 1]);
          }
        }
      }
    });
  }
});

describe("SheetStyles", () => {
  it("a whole column is one entry; a later range overrides part of it", () => {
    const st = new SheetStyles();
    st.apply(1, "all", { bold: true });
    st.apply(1, [[10, 19]], { color: "red" });
    expect(st.get(5, 1)).toEqual({ bold: true });
    expect(st.get(12, 1)).toEqual({ bold: true, color: "red" });
    expect(st.get(99_999_999, 1)).toEqual({ bold: true });
    st.apply(1, "all", { bold: null });
    expect(st.get(5, 1)).toBeNull();
    expect(st.get(12, 1)).toEqual({ color: "red" });
    expect(st.get(0, 0)).toBeNull();
  });

  it("snapshot and restore round-trip; columns shift and come back", () => {
    const st = new SheetStyles();
    st.apply(2, [[0, 4]], { fill: "#ff0" });
    const snap = st.snapshot(2);
    st.apply(2, [[0, 9]], { italic: true });
    st.restore(2, snap);
    expect(st.get(3, 2)).toEqual({ fill: "#ff0" });
    expect(st.get(7, 2)).toBeNull();
    st.shift(1, 2);
    expect(st.get(3, 4)).toEqual({ fill: "#ff0" });
    const removed = st.remove(4, 1);
    expect(st.isEmpty).toBe(true);
    st.putBack(removed);
    expect(st.get(3, 4)).toEqual({ fill: "#ff0" });
  });
});
