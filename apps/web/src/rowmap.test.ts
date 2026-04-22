import { describe, expect, it } from "vitest";
import { RowMap, runsLength, runsOf } from "./rowmap";

describe("RowMap", () => {
  it("matches a plain array through random inserts and deletes", () => {
    let seed = 3;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (const startAsArray of [false, true]) {
      let model = Array.from({ length: 50 }, (_, i) => i);
      let map = startAsArray ? RowMap.fromArray(Uint32Array.from(model)) : RowMap.identity(50);
      let next = 50;
      for (let step = 0; step < 300; step++) {
        const at = Math.floor(rand() * (model.length + 1));
        if (rand() < 0.5 && model.length > 2) {
          const n = Math.min(model.length - at, 1 + Math.floor(rand() * 5));
          const { map: m2, removed } = map.splice(at, n, []);
          const gone = model.splice(at, n);
          expect(runsLength(removed)).toBe(gone.length);
          expect(removed).toEqual(runsOf(gone));
          map = m2;
          // and sometimes undo it straight away
          if (rand() < 0.3) {
            map = map.splice(at, 0, removed).map;
            model.splice(at, 0, ...gone);
          }
        } else {
          const n = 1 + Math.floor(rand() * 4);
          const ids = Array.from({ length: n }, () => next++);
          map = map.splice(at, 0, runsOf(ids)).map;
          model.splice(at, 0, ...ids);
        }
        expect(map.length).toBe(model.length);
        expect(Array.from(map.toArray())).toEqual(model);
        const v = Math.floor(rand() * model.length);
        expect(map.get(v)).toBe(model[v]);
        const inv = map.inverse(next);
        expect(inv(model[v])).toBe(v);
      }
      if (!startAsArray) expect(map.isArray).toBe(false);
    }
  });

  it("inserting into 100M rows is a few runs, not a 100M array", () => {
    let map = RowMap.identity(100_000_000);
    const t = performance.now();
    for (let i = 0; i < 1000; i++) map = map.splice(i * 50_000, 0, [[100_000_000 + i, 1]]).map;
    expect(performance.now() - t).toBeLessThan(500);
    expect(map.length).toBe(100_001_000);
    expect(map.runCount).toBeLessThan(2100);
    expect(map.get(50_000)).toBe(100_000_001);
    expect(map.isIdentity(100_000_000)).toBe(false);
    const { map: back } = map.splice(50_000, 1, []);
    expect(back.get(50_000)).toBe(49_999);
  });
});
