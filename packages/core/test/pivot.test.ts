import { describe, expect, it } from "vitest";
import type { ColumnData } from "../src/columns";
import { dateToSerial } from "../src/numfmt";
import { codeField, compareKeys, dateKey, dateKeyLabel, fieldMembers, hashNumber, histogramBins, HyperLogLog, medianOf, pivot, profile, textPattern, type PivotAgg, type PivotResult } from "../src/pivot";

function text(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const at = new Map<string, number>();
  const codes = Uint32Array.from(values, (v) => {
    if (v === null || v === "") return 0;
    let c = at.get(v);
    if (c === undefined) {
      c = dict.push(v);
      at.set(v, c);
    }
    return c;
  });
  return { kind: "string", name, codes, dict };
}
const num = (name: string, values: (number | null)[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values, (v) => v ?? NaN) });

// region, product, amount, qty
const region = ["East", "West", "East", "West", "East", "North", null, "East"];
const product = ["A", "A", "B", "B", "A", "B", "A", "B"];
const amount = [10, 20, 30, null, 50, 60, 70, 80];
const qty = [1, 2, 3, 4, 5, 6, 7, 8];
const cols = [text("Region", region), text("Product", product), num("Amount", amount), num("Qty", qty)];

/** The whole result as rows of [labels..., values...] for easy reading. */
function grid(r: PivotResult, v = 0): (string | number)[][] {
  return r.rowItems.map((it, i) => [
    it.kind === "grand" ? "Grand total" : it.labels.join("/") + (it.kind === "subtotal" ? " total" : ""),
    ...r.colItems.map((_, c) => {
      const x = r.value(i, c, v);
      return x === x ? +x.toFixed(10) : "";
    }),
  ]);
}

describe("pivot", () => {
  it("sums by one row field with blank last and a grand total", () => {
    const r = pivot(cols, { rows: [0], cols: [], values: [{ field: 2, agg: "sum" }] });
    expect(r.valueNames).toEqual(["Sum of Amount"]);
    expect(grid(r)).toEqual([
      ["East", 170],
      ["North", 60],
      ["West", 20],
      ["(blank)", 70],
      ["Grand total", 320],
    ]);
    expect(r.rowsUsed).toBe(8);
  });

  it("crosses rows and columns with totals both ways", () => {
    const r = pivot(cols, { rows: [0], cols: [1], values: [{ field: 2, agg: "sum" }] });
    expect(r.colItems.map((c) => c.kind)).toEqual(["leaf", "leaf", "grand"]);
    expect(grid(r)).toEqual([
      ["East", 60, 110, 170],
      ["North", "", 60, 60],
      ["West", 20, "", 20],
      ["(blank)", 70, "", 70],
      ["Grand total", 150, 170, 320],
    ]);
  });

  it("an empty cell is blank but a group of blanks sums to blank and counts zero", () => {
    // West/B only has a blank amount
    const r = pivot(cols, { rows: [0], cols: [1], values: [{ field: 2, agg: "sum" }, { field: 2, agg: "count" }] });
    const west = r.rowItems.findIndex((it) => it.labels[0] === "West");
    expect(r.value(west, 1, 0)).toBeNaN();
    expect(r.value(west, 1, 1)).toBe(0);
    const north = r.rowItems.findIndex((it) => it.labels[0] === "North");
    expect(r.value(north, 0, 1)).toBeNaN(); // no rows at all
  });

  it("adds subtotals for outer row fields", () => {
    const r = pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 3, agg: "sum" }] });
    expect(grid(r)).toEqual([
      ["East/A", 6],
      ["East/B", 11],
      ["East total", 17],
      ["North/B", 6],
      ["North total", 6],
      ["West/A", 2],
      ["West/B", 4],
      ["West total", 6],
      ["(blank)/A", 7],
      ["(blank) total", 7],
      ["Grand total", 36],
    ]);
    const noSubs = pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 3, agg: "sum" }], subtotals: false, grandTotals: false });
    expect(noSubs.rowItems.every((it) => it.kind === "leaf")).toBe(true);
    expect(noSubs.rowItems.length).toBe(6);
  });

  it("computes every aggregation", () => {
    const aggs: PivotAgg[] = ["sum", "count", "countDistinct", "avg", "min", "max", "median", "stdev"];
    const r = pivot(cols, { rows: [0], cols: [], values: aggs.map((agg) => ({ field: 2, agg })) });
    const east = 0;
    // East amounts: 10, 30, 50, 80
    const got = aggs.map((_, v) => r.value(east, 0, v));
    const sd = Math.sqrt([10, 30, 50, 80].reduce((s, x) => s + (x - 42.5) ** 2, 0) / 3);
    expect(got.slice(0, 7)).toEqual([170, 4, 4, 42.5, 10, 80, 40]);
    expect(got[7]).toBeCloseTo(sd, 10);
    const g = r.rowItems.length - 1;
    // all: 10,20,30,50,60,70,80
    expect(r.value(g, 0, 6)).toBe(50);
    expect(r.value(g, 0, 1)).toBe(7);
  });

  it("counts text values and distinct text", () => {
    const r = pivot(cols, { rows: [1], cols: [], values: [{ field: 0, agg: "count" }, { field: 0, agg: "countDistinct" }, { field: 0, agg: "sum" }] });
    // A: East, West, East, null -> 3 values, 2 distinct
    expect(r.value(0, 0, 0)).toBe(3);
    expect(r.value(0, 0, 1)).toBe(2);
    expect(r.value(0, 0, 2)).toBeNaN();
    expect(r.value(2, 0, 1)).toBe(3); // grand: East, West, North
  });

  it("filters rows by member keys, including blank", () => {
    const r = pivot(cols, { rows: [0], cols: [], values: [{ field: 2, agg: "sum" }], filters: [{ field: 1, keep: new Set(["A"]) }] });
    expect(grid(r)).toEqual([
      ["East", 60],
      ["West", 20],
      ["(blank)", 70],
      ["Grand total", 150],
    ]);
    expect(r.rowsUsed).toBe(4);
    const b = pivot(cols, { rows: [], cols: [], values: [{ field: 2, agg: "sum" }], filters: [{ field: 0, keep: new Set([null, "North"]) }] });
    expect(b.value(0, 0, 0)).toBe(130);
    const none = pivot(cols, { rows: [0], cols: [], values: [{ field: 2, agg: "sum" }], filters: [{ field: 0, keep: new Set() }] });
    expect(none.rowsUsed).toBe(0);
    expect(none.rowItems.length).toBe(1);
    expect(none.value(0, 0, 0)).toBeNaN();
  });

  it("drills down to member rows of any cell", () => {
    const r = pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }] });
    const at = (label: string) => r.rowItems.findIndex((it) => grid(r)[r.rowItems.indexOf(it)][0] === label);
    expect([...r.members(at("East/B"), 0)]).toEqual([2, 7]);
    expect([...r.members(at("East total"), 0)]).toEqual([0, 2, 4, 7]);
    expect([...r.members(r.rowItems.length - 1, 0)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const x = pivot(cols, { rows: [0], cols: [1], values: [] });
    expect([...x.members(0, 1)]).toEqual([2, 7]); // East, B
    expect([...x.members(x.rowItems.length - 1, 0)]).toEqual([0, 1, 4, 6]); // product A
    const f = pivot(cols, { rows: [0], cols: [], values: [], filters: [{ field: 1, keep: new Set(["B"]) }] });
    expect([...f.members(f.rowItems.length - 1, 0)]).toEqual([2, 3, 5, 7]);
  });

  it("shows values as shares of totals", () => {
    const base = { rows: [0], cols: [1], filters: [{ field: 0, keep: new Set<string | null>(["East", "West"]) }] };
    const g = pivot(cols, { ...base, values: [{ field: 3, agg: "sum", showAs: "pctGrand" }] });
    // East A 6, East B 11, West A 2, West B 4 -> total 23
    expect(g.value(0, 0, 0)).toBeCloseTo(6 / 23);
    expect(g.value(2, 2, 0)).toBe(1);
    expect(g.raw[0][0]).toBe(6);
    const row = pivot(cols, { ...base, values: [{ field: 3, agg: "sum", showAs: "pctRow" }] });
    expect(row.value(0, 1, 0)).toBeCloseTo(11 / 17);
    expect(row.value(1, 2, 0)).toBe(1);
    const col = pivot(cols, { ...base, values: [{ field: 3, agg: "sum", showAs: "pctCol" }] });
    expect(col.value(0, 0, 0)).toBeCloseTo(6 / 8);
    expect(col.value(2, 1, 0)).toBe(1);
  });

  it("running totals restart within each parent", () => {
    const r = pivot(cols, { rows: [0, 1], cols: [], values: [{ field: 3, agg: "sum", showAs: "running" }] });
    expect(grid(r).map((x) => x[1])).toEqual([6, 17, 17, 6, 23, 2, 6, 29, 7, 36, 36]);
    // no row fields: runs across the columns
    const c = pivot(cols, { rows: [], cols: [1], values: [{ field: 3, agg: "sum", showAs: "running" }] });
    expect([0, 1, 2].map((i) => c.value(0, i, 0))).toEqual([15, 36, 36]);
  });

  it("groups numeric dates by year, quarter, month and day", () => {
    const d = [dateToSerial(2023, 12, 31), dateToSerial(2024, 1, 15), dateToSerial(2024, 2, 1), dateToSerial(2024, 4, 30) + 0.5, NaN];
    const c = [num("Date", d), num("Amt", [1, 2, 4, 8, 16])];
    const y = pivot(c, { rows: [{ field: 0, group: "year" }], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(y)).toEqual([["2023", 1], ["2024", 14], ["(blank)", 16], ["Grand total", 31]]);
    const q = pivot(c, { rows: [{ field: 0, group: "quarter" }], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(q).map((r) => r[0])).toEqual(["2023 Q4", "2024 Q1", "2024 Q2", "(blank)", "Grand total"]);
    expect(grid(q)[1][1]).toBe(6);
    const m = pivot(c, { rows: [{ field: 0, group: "year" }, { field: 0, group: "month" }], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(m).map((r) => r[0])).toEqual(["2023/2023-12 Dec", "2023 total", "2024/2024-01 Jan", "2024/2024-02 Feb", "2024/2024-04 Apr", "2024 total", "(blank)/(blank)", "(blank) total", "Grand total"]);
    const day = pivot(c, { rows: [{ field: 0, group: "day" }], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(day)[3]).toEqual(["2024-04-30", 8]);
  });

  it("groups text dates, keeping text that isn't a date", () => {
    const c = [text("When", ["15/01/2024", "2024-02-03", "3 March 2025", "soon", null]), num("Amt", [1, 2, 4, 8, 16])];
    const y = pivot(c, { rows: [{ field: 0, group: "year" }], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(y)).toEqual([["2024", 3], ["2025", 4], ["soon", 8], ["(blank)", 16], ["Grand total", 31]]);
  });

  it("filters on grouped dates", () => {
    const d = [dateToSerial(2023, 5, 1), dateToSerial(2024, 1, 15), dateToSerial(2024, 7, 1)];
    const c = [num("Date", d), num("Amt", [1, 2, 4])];
    const r = pivot(c, { rows: [], cols: [], values: [{ field: 1, agg: "sum" }], filters: [{ field: 0, group: "year", keep: new Set([2024]) }] });
    expect(r.value(0, 0, 0)).toBe(6);
  });

  it("groups by plain numbers, fractions and huge ranges", () => {
    const c = [num("Acct", [4000, 1000, 4000, 1e12, 2.5, 2.5]), num("Amt", [1, 2, 3, 4, 5, 6])];
    const r = pivot(c, { rows: [0], cols: [], values: [{ field: 1, agg: "sum" }] });
    expect(grid(r)).toEqual([["2.5", 11], ["1000", 2], ["4000", 4], ["1000000000000", 4], ["Grand total", 21]]);
    const w = pivot([num("Acct", [7, 3, 7, 5])], { rows: [0], cols: [], values: [{ field: 0, agg: "count" }] });
    expect(grid(w)).toEqual([["3", 1], ["5", 1], ["7", 2], ["Grand total", 4]]);
  });

  it("matches a brute-force reference on random data", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const n = 3000;
    const a = Array.from({ length: n }, () => (rnd() < 0.05 ? null : `k${Math.floor(rnd() * 7)}`));
    const b = Array.from({ length: n }, () => Math.floor(rnd() * 5));
    const c2 = Array.from({ length: n }, () => (rnd() < 0.03 ? null : `c${Math.floor(rnd() * 4)}`));
    const v = Array.from({ length: n }, () => (rnd() < 0.1 ? null : Math.round(rnd() * 1000) / 10));
    const data = [text("A", a), num("B", b), text("C", c2), num("V", v)];
    const aggs: PivotAgg[] = ["sum", "count", "countDistinct", "avg", "min", "max", "median", "stdev"];
    const r = pivot(data, { rows: [0, 1], cols: [2], values: aggs.map((agg) => ({ field: 3, agg })) });
    const ref = (rows: number[]) => {
      const xs = rows.map((i) => v[i]).filter((x): x is number => x !== null);
      const s = xs.reduce((p, x) => p + x, 0);
      const m = s / xs.length;
      const sorted = [...xs].sort((p, q) => p - q);
      const h = sorted.length >> 1;
      return [
        xs.length ? s : NaN,
        xs.length,
        new Set(xs).size,
        xs.length ? m : NaN,
        xs.length ? Math.min(...xs) : NaN,
        xs.length ? Math.max(...xs) : NaN,
        !xs.length ? NaN : sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2,
        xs.length > 1 ? Math.sqrt(xs.reduce((p, x) => p + (x - m) ** 2, 0) / (xs.length - 1)) : NaN,
      ];
    };
    const keyA = (i: number) => a[i];
    for (let ri = 0; ri < r.rowItems.length; ri++) {
      const it = r.rowItems[ri];
      for (let ci = 0; ci < r.colItems.length; ci++) {
        const ct = r.colItems[ci];
        const rows: number[] = [];
        for (let i = 0; i < n; i++) {
          if (it.depth >= 1 && r.rowFields[0].keys[it.path[0]] !== keyA(i)) continue;
          if (it.depth >= 2 && r.rowFields[1].keys[it.path[1]] !== b[i]) continue;
          if (ct.depth >= 1 && r.colFields[0].keys[ct.path[0]] !== c2[i]) continue;
          rows.push(i);
        }
        expect([...r.members(ri, ci)]).toEqual(rows);
        const want = ref(rows);
        aggs.forEach((_, k) => {
          const got = r.value(ri, ci, k);
          if (!rows.length) expect(got).toBeNaN();
          else if (Number.isNaN(want[k])) expect(got).toBeNaN();
          else expect(got).toBeCloseTo(want[k], 6);
        });
      }
    }
  });

  it("uses the hashed path for many combinations and refuses too many", () => {
    const n = 5000;
    const a = num("A", Array.from({ length: n }, (_, i) => i * 1.5));
    const b = num("B", Array.from({ length: n }, (_, i) => (i * 7919) % 5003));
    const r = pivot([a, b], { rows: [0, 1], cols: [], values: [{ field: 0, agg: "count" }], subtotals: false });
    expect(r.rowItems.length).toBe(n + 1);
    expect(r.value(n, 0, 0)).toBe(n);
    expect(() => pivot([a, b], { rows: [0], cols: [1], values: [], maxCells: 1000 })).toThrow(/combinations/);
  });

  it("handles no columns and no rows", () => {
    const r = pivot([], { rows: [], cols: [], values: [] });
    expect(r.rowItems.length).toBe(1);
    expect(r.rowCount).toBe(0);
    const e = pivot([num("X", [])], { rows: [0], cols: [], values: [{ field: 0, agg: "sum" }] });
    expect(e.rowItems.map((x) => x.kind)).toEqual(["grand"]);
    expect(() => pivot(cols, { rows: [9], cols: [], values: [] })).toThrow(/no column 10/);
  });
});

describe("pivot fields", () => {
  it("sorts numbers, then text naturally, then blank", () => {
    expect([null, "b", 2, "Item 10", 1, "Item 9"].sort(compareKeys)).toEqual([1, 2, "b", "Item 9", "Item 10", null]);
  });

  it("codes text through the dictionary, unused entries dropped", () => {
    const c: ColumnData = { kind: "string", name: "T", codes: Uint32Array.from([2, 0, 2, 3]), dict: ["unused", "z", "a"] };
    const f = codeField(c);
    expect(f.keys).toEqual(["a", "z", null]);
    expect([...f.codes]).toEqual([1, 2, 1, 0]);
  });

  it("labels date buckets", () => {
    const s = dateToSerial(2024, 3, 15);
    expect(dateKeyLabel(dateKey(s, "quarter"), "quarter")).toBe("2024 Q1");
    expect(dateKeyLabel(dateKey(s, "month"), "month")).toBe("2024-03 Mar");
    expect(dateKeyLabel(dateKey(s + 0.75, "day"), "day")).toBe("2024-03-15");
  });

  it("lists members with counts for slicers", () => {
    expect(fieldMembers(cols[0])).toEqual([
      { key: "East", label: "East", count: 4 },
      { key: "North", label: "North", count: 1 },
      { key: "West", label: "West", count: 2 },
      { key: null, label: "(blank)", count: 1 },
    ]);
  });
});

describe("median", () => {
  it("selects the middle of random arrays", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
    for (let t = 0; t < 50; t++) {
      const len = 1 + Math.floor(rnd() * 60);
      const a = Float64Array.from({ length: len }, () => Math.floor(rnd() * 10));
      const s = [...a].sort((x, y) => x - y);
      const want = len % 2 ? s[len >> 1] : (s[len / 2 - 1] + s[len / 2]) / 2;
      expect(medianOf(a, len)).toBe(want);
    }
    expect(medianOf(new Float64Array(0), 0)).toBeNaN();
  });
});

describe("HyperLogLog", () => {
  it("estimates distinct counts within a few percent", () => {
    for (const n of [100, 10_000, 300_000]) {
      const h = new HyperLogLog();
      for (let i = 0; i < n; i++) h.addNumber(i * 0.37);
      for (let i = 0; i < n; i++) h.addNumber(i * 0.37); // repeats don't count
      expect(Math.abs(h.estimate() - n) / n).toBeLessThan(0.03);
    }
    const s = new HyperLogLog();
    for (let i = 0; i < 5000; i++) s.addString(`INV-${i}`);
    expect(Math.abs(s.estimate() - 5000) / 5000).toBeLessThan(0.03);
    expect(hashNumber(0)).toBe(hashNumber(-0));
  });
});

describe("profile", () => {
  it("profiles a number column", () => {
    const p = profile(num("Amount", [5, 1, null, 3, 3, -2, 0, null, 3]));
    expect(p).toMatchObject({ type: "number", count: 9, blanks: 2, filled: 7, distinct: 5, distinctExact: true });
    expect(p.numbers).toMatchObject({ min: -2, max: 5, sum: 13, median: 3, zeros: 1, negatives: 1, wholes: 7, medianExact: true });
    expect(p.numbers!.mean).toBeCloseTo(13 / 7);
    expect(p.top[0]).toEqual({ value: 3, count: 3 });
    expect(p.histogram!.counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(p.histogram!.edges[0]).toBeLessThanOrEqual(-2);
    expect(p.histogram!.edges[p.histogram!.edges.length - 1]).toBeGreaterThanOrEqual(5);
  });

  it("estimates distinct numbers past the cap and samples the median past the limit", () => {
    const n = 50_000;
    const p = profile(num("Id", Array.from({ length: n }, (_, i) => i)), { distinctCap: 1000, exactLimit: 10_000 });
    expect(p.distinctExact).toBe(false);
    expect(Math.abs(p.distinct - n) / n).toBeLessThan(0.03);
    expect(p.numbers!.medianExact).toBe(false);
    expect(Math.abs(p.numbers!.median - n / 2) / n).toBeLessThan(0.01);
    expect(p.top.length).toBeLessThanOrEqual(3); // unique values: only a few shown
  });

  it("profiles dates", () => {
    const d = [dateToSerial(2024, 1, 1), dateToSerial(2024, 6, 30), dateToSerial(2024, 12, 31)];
    const p = profile(num("D", d), { date: true });
    expect(p.type).toBe("date");
    expect(p.dates).toEqual({ min: d[0], max: d[2] });
    const t = profile(text("D", ["2024-01-05", "2024-03-01", "1/2/2023", null]));
    expect(t.type).toBe("date");
    expect(t.dates!.min).toBe(dateToSerial(2023, 2, 1));
  });

  it("profiles text: lengths, top values and patterns", () => {
    const p = profile(text("Ref", ["INV-0001", "INV-0002", "INV-0002", "CR-12", null, "inv 9"]));
    expect(p).toMatchObject({ type: "text", count: 6, blanks: 1, filled: 5, distinct: 4 });
    expect(p.top[0]).toEqual({ value: "INV-0002", count: 2 });
    expect(p.text).toMatchObject({ minLength: 5, maxLength: 8, numeric: 0 });
    expect(p.text!.meanLength).toBeCloseTo((8 * 3 + 5 + 5) / 5);
    expect(p.patterns![0]).toEqual({ pattern: "AAA-9999", count: 3, example: "INV-0001" });
    expect(p.patterns!.map((x) => x.pattern)).toEqual(["AAA-9999", "AA-99", "AAA 9"]);
  });

  it("handles empty columns", () => {
    expect(profile(num("E", [null, null]))).toMatchObject({ type: "empty", blanks: 2, filled: 0 });
    expect(profile(text("E", [null]))).toMatchObject({ type: "empty", blanks: 1 });
  });

  it("makes patterns and round histogram bins", () => {
    expect(textPattern("AB-12/x é")).toBe("AA-99/A A");
    expect(textPattern("x".repeat(30), 5)).toBe("AAAAA…");
    const h = histogramBins(Float64Array.from([0, 10, 20, 100]), 0, 100, 10);
    expect(h.edges[0]).toBe(0);
    expect(h.edges[h.edges.length - 1]).toBe(100);
    expect(h.counts.length).toBe(10);
    expect(h.counts[9]).toBe(1); // 100 sits on the top edge
    expect(histogramBins(Float64Array.from([4, 4]), 4, 4, 10).counts).toEqual([2]);
  });
});
