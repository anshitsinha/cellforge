import { describe, expect, it } from "vitest";
import { dateToSerial, serialToParts } from "@cellforge/core";
import type { CellValue } from "@cellforge/grid";
import { BlankSource, EditableSource } from "../editable";
import { dateTicks, niceTicks, tickLabel } from "./axes";
import { ageing, benford, buildChart, firstDigit, guessLayout, histogram, lttb, makeResolver, minMaxBuckets, pareto, readBlock, thinScatter, waterfall, type ChartSource } from "./data";
import { defaultSpec, formatRange, LAST_ROW, parseLimit, parseRange } from "./model";

/** A sheet from rows of values. */
function sheet(rows: CellValue[][], fmts: Record<string, string> = {}): ChartSource {
  return {
    getCell: (r, c) => rows[r]?.[c] ?? null,
    getStyle: (r, c) => (fmts[`${r},${c}`] ? { numFmt: fmts[`${r},${c}`] } : null),
    usedRange: () => ({ rows: rows.length, cols: Math.max(...rows.map((r) => r.length)) }),
  };
}

const range = (top: number, left: number, bottom: number, right: number) => ({ sheetId: "s1", top, left, bottom, right });

describe("ranges", () => {
  it("parses A1 ranges in either order, single cells and whole columns", () => {
    expect(parseRange("A1:C20")).toEqual({ top: 0, left: 0, bottom: 19, right: 2 });
    expect(parseRange("c20:a1")).toEqual({ top: 0, left: 0, bottom: 19, right: 2 });
    expect(parseRange("$B$2:$D$4")).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
    expect(parseRange("AA10")).toEqual({ top: 9, left: 26, bottom: 9, right: 26 });
    expect(parseRange("Sheet1!A1:B2")).toEqual({ top: 0, left: 0, bottom: 1, right: 1 });
    expect(parseRange("B:D")).toEqual({ top: 0, left: 1, bottom: LAST_ROW, right: 3 });
    expect(parseRange("A0")).toBeNull();
    expect(parseRange("hello")).toBeNull();
    expect(parseRange("A1:B2:C3")).toBeNull();
  });

  it("formats back to the same text", () => {
    for (const t of ["A1:C20", "B2", "AA1:AB3", "B:D"]) expect(formatRange(parseRange(t)!)).toBe(t);
  });

  it("parses limits as numbers, cells or automatic", () => {
    expect(parseLimit("", "s1")).toBeNull();
    expect(parseLimit("1,000", "s1")).toBe(1000);
    expect(parseLimit("-2.5", "s1")).toBe(-2.5);
    expect(parseLimit("F1", "s1")).toEqual({ sheetId: "s1", row: 0, col: 5 });
    expect(parseLimit("nope", "s1")).toBeUndefined();
  });
});

describe("reading series", () => {
  const src = sheet([
    ["Month", "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 20, null],
    ["Mar", 30, 6],
  ]);

  it("reads names, labels and series in columns", () => {
    const b = readBlock(src, { range: range(0, 0, 3, 2), seriesIn: "columns", names: true, labels: true });
    expect(b.names).toEqual(["Sales", "Costs"]);
    expect(b.labelTexts).toEqual(["Jan", "Feb", "Mar"]);
    expect([...b.series[0]]).toEqual([10, 20, 30]);
    expect([...b.series[1]]).toEqual([4, NaN, 6]);
  });

  it("reads series in rows", () => {
    const b = readBlock(src, { range: range(0, 0, 3, 2), seriesIn: "rows", names: true, labels: true });
    expect(b.names).toEqual(["Jan", "Feb", "Mar"]);
    expect([...b.series[0]]).toEqual([10, 4]);
  });

  it("guesses names and labels", () => {
    expect(guessLayout(src, range(0, 0, 3, 2))).toEqual({ seriesIn: "columns", names: true, labels: true });
    expect(guessLayout(sheet([[1, 2], [3, 4]]), range(0, 0, 1, 1))).toEqual({ seriesIn: "columns", names: false, labels: false });
  });

  it("cuts whole columns to the used rows and works on an EditableSource", () => {
    const e = new EditableSource(new BlankSource(100, 5));
    e.setCell(0, 0, "x");
    e.setCell(0, 1, "y");
    for (let i = 1; i <= 5; i++) {
      e.setCell(i, 0, i);
      e.setCell(i, 1, i * i);
    }
    const spec = { ...defaultSpec("c", { sheetId: "s", ...parseRange("A:B")! }, "scatter") };
    const data = buildChart(e, spec);
    expect(data.mode).toBe("xy");
    expect([...data.xs!]).toEqual([1, 2, 3, 4, 5]);
    expect([...data.series[0].values]).toEqual([1, 4, 9, 16, 25]);
  });

  it("reads axis limits from cells", () => {
    const s = sheet([["a", 1], ["b", 2], [null, 50]]);
    const spec = { ...defaultSpec("c", range(0, 0, 1, 1)), names: false, yMax: { sheetId: "s1", row: 2, col: 1 }, yMin: 0 };
    const data = buildChart(s, spec, makeResolver((_, r, c) => s.getCell(r, c)));
    expect(data.limits.yMax).toBe(50);
    expect(data.limits.yMin).toBe(0);
  });
});

describe("histogram", () => {
  it("bins with a given width and keeps the maximum in the last bin", () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { width: 5 });
    expect(h.edges).toEqual([0, 5, 10]);
    expect(h.counts).toEqual([5, 6]);
    expect(h.n).toBe(11);
  });

  it("ignores blanks and text", () => {
    expect(histogram([1, NaN, 2, Infinity], { width: 1 }).n).toBe(2);
  });

  it("chooses round widths automatically and counts every value", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 100 + 500);
    for (const rule of ["fd", "sturges"] as const) {
      const h = histogram(xs, { rule });
      expect(h.counts.reduce((a, b) => a + b, 0)).toBe(1000);
      const w = h.edges[1] - h.edges[0];
      expect(w / 10 ** Math.floor(Math.log10(w))).toBeOneOf([1, 2, 2.5, 5]);
      expect(h.edges[0]).toBeLessThanOrEqual(Math.min(...xs));
      expect(h.edges[h.edges.length - 1]).toBeGreaterThanOrEqual(Math.max(...xs));
    }
    // Sturges for 1000 values: about 11 bins
    expect(histogram(xs, { rule: "sturges" }).counts.length).toBeLessThan(15);
  });

  it("copes with every value the same", () => {
    const h = histogram([7, 7, 7]);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("waterfall", () => {
  it("keeps a running total and treats total rows as bars from zero", () => {
    const w = waterfall([100, 30, -50, NaN, 20], [true, false, false, true, false]);
    expect([...w.base]).toEqual([0, 100, 130, 0, 80]);
    expect([...w.delta]).toEqual([100, 30, -50, 80, 20]);
    expect([...w.end]).toEqual([100, 130, 80, 80, 100]);
    expect([...w.role]).toEqual([2, 0, 1, 2, 0]);
  });

  it("marks rows labelled Total in a chart", () => {
    const s = sheet([["Opening", 100], ["Sales", 40], ["Refunds", -10], ["Closing", null]]);
    const data = buildChart(s, { ...defaultSpec("w", range(0, 0, 3, 1), "waterfall"), names: false });
    expect([...data.series[0].roles!]).toEqual([2, 0, 1, 2]);
    expect(data.series[0].values[3]).toBe(130);
  });
});

describe("Pareto", () => {
  it("sorts largest first with the cumulative share", () => {
    const p = pareto(["a", "b", "c", "d"], [10, 60, 30, 0]);
    expect(p.labels).toEqual(["b", "c", "a"]);
    expect(p.values).toEqual([60, 30, 10]);
    expect(p.cumulative).toEqual([0.6, 0.9, 1]);
  });
});

describe("Benford", () => {
  it("finds first digits", () => {
    expect([1234, 0.0567, -9, 1000, 0.1, 0].map(firstDigit)).toEqual([1, 5, 9, 1, 1, 0]);
  });

  it("matches Benford for powers of two", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => 2 ** (i % 300) * (1 + i / 1e4));
    const b = benford(xs);
    expect(b.n).toBe(1000);
    expect(b.actual[0]).toBeCloseTo(0.301, 1);
    expect(b.verdict).not.toBe("nonconformity");
  });

  it("flags made-up numbers", () => {
    const b = benford(Array.from({ length: 900 }, (_, i) => (i % 9) + 1));
    expect(b.verdict).toBe("nonconformity");
  });
});

describe("ageing", () => {
  it("buckets amounts by days old", () => {
    const asOf = dateToSerial(2024, 3, 31);
    const dates = [asOf + 5, asOf, asOf - 30, asOf - 31, asOf - 100, asOf - 400];
    const a = ageing(dates, [1, 2, 3, 4, 5, 6], asOf, [30, 60, 90]);
    expect(a.labels).toEqual(["Not due", "0–30", "31–60", "61–90", "91+"]);
    expect(a.values).toEqual([1, 5, 4, 0, 11]);
    expect(a.counts).toEqual([1, 2, 1, 0, 2]);
  });
});

describe("downsampling", () => {
  const n = 100_000;
  const xs = Float64Array.from({ length: n }, (_, i) => i);
  const ys = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 500) * 10);
  ys[12345] = 1000; // a spike
  ys[67890] = -1000; // a dip

  it("LTTB keeps endpoints and extremes", () => {
    const idx = lttb(xs, ys, 500);
    expect(idx.length).toBe(500);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(n - 1);
    expect([...idx]).toContain(12345);
    expect([...idx]).toContain(67890);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it("LTTB skips blanks and leaves short series alone", () => {
    expect([...lttb([0, 1, 2], [1, NaN, 3], 10)]).toEqual([0, 2]);
  });

  it("min/max buckets keep endpoints and extremes in order", () => {
    const idx = minMaxBuckets(xs, ys, 300);
    expect(idx.length).toBeLessThanOrEqual(1200);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(n - 1);
    expect([...idx]).toContain(12345);
    expect([...idx]).toContain(67890);
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });

  it("handles ten million points quickly", () => {
    const big = 10_000_000;
    const bx = new Float64Array(big);
    const by = new Float64Array(big);
    for (let i = 0; i < big; i++) {
      bx[i] = i;
      by[i] = (i * 7919) % 1000;
    }
    const t = performance.now();
    const idx = minMaxBuckets(bx, by, 1000);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(idx.length).toBeLessThanOrEqual(4000);
  });

  it("thins scatter points to one per pixel", () => {
    const idx = thinScatter([0, 0.1, 0.2, 5, 5.5], [0, 0.1, 0.2, 5, 5.5], (x) => x, (y) => y, 10, 10);
    expect([...idx]).toEqual([0, 3]);
  });
});

describe("axes", () => {
  it("makes round ticks that cover the data", () => {
    const t = niceTicks(3, 97, 6);
    expect(t.min).toBe(0);
    expect(t.max).toBe(100);
    expect(t.step).toBe(20);
    expect(t.values).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0.12, 0.87, 5).values).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(-45, 130, 6).values).toEqual([-50, 0, 50, 100, 150]);
  });

  it("keeps fixed limits", () => {
    const t = niceTicks(3, 97, 6, { min: 10, max: 90 });
    expect(t.min).toBe(10);
    expect(t.max).toBe(90);
    expect(t.values[0]).toBeGreaterThanOrEqual(10);
    expect(t.values[t.values.length - 1]).toBeLessThanOrEqual(90);
  });

  it("widens a flat range", () => {
    const t = niceTicks(5, 5, 5);
    expect(t.min).toBeLessThan(5);
    expect(t.max).toBeGreaterThan(5);
  });

  it("labels ticks with the cell format or sensible decimals", () => {
    expect(tickLabel(0.25, "0%", 0.05)).toBe("25%");
    expect(tickLabel(1500, "", 500)).toBe("1,500");
    expect(tickLabel(0.5, "", 0.1)).toBe("0.5");
    expect(tickLabel(2_500_000, "", 500_000)).toBe("2.5M");
  });

  it("puts date ticks on month starts", () => {
    const lo = dateToSerial(2024, 1, 15);
    const hi = dateToSerial(2024, 12, 10);
    const t = dateTicks(lo, hi, 6);
    expect(t.values.length).toBeGreaterThan(2);
    expect(t.values.length).toBeLessThanOrEqual(6);
    for (const v of t.values) {
      expect(serialToParts(v).d).toBe(1);
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
  });

  it("uses days for short spans and years for long ones", () => {
    const lo = dateToSerial(2024, 3, 1);
    expect(dateTicks(lo, lo + 5, 8).fmt).toBe("d mmm");
    const y = dateTicks(dateToSerial(2000, 1, 1), dateToSerial(2024, 1, 1), 6);
    expect(y.fmt).toBe("yyyy");
    for (const v of y.values) expect(serialToParts(v).m).toBe(1);
  });
});

describe("building charts", () => {
  it("line charts with dates go on a date axis", () => {
    const d0 = dateToSerial(2024, 1, 1);
    const s = sheet([["Date", "Price"], ...Array.from({ length: 10 }, (_, i) => [d0 + i, i] as CellValue[])], { "1,0": "yyyy-mm-dd" });
    const spec = { ...defaultSpec("l", range(0, 0, 10, 1), "line") };
    Object.assign(spec, guessLayout(s, spec.range));
    expect(spec.labels).toBe(true);
    const data = buildChart(s, spec);
    expect(data.mode).toBe("xy");
    expect(data.xIsDate).toBe(true);
  });

  it("pies fold small slices into Other", () => {
    const rows = Array.from({ length: 12 }, (_, i) => [`k${i}`, 12 - i] as CellValue[]);
    const data = buildChart(sheet(rows), { ...defaultSpec("p", range(0, 0, 11, 1), "pie"), names: false });
    expect(data.categories.length).toBe(8);
    expect(data.categories[7]).toBe("Other");
    expect(data.series[0].values[7]).toBe(5 + 4 + 3 + 2 + 1);
  });

  it("combo puts the last series on a line by default", () => {
    const s = sheet([["", "A", "B"], ["x", 1, 100], ["y", 2, 200]]);
    const data = buildChart(s, { ...defaultSpec("c", range(0, 0, 2, 2), "combo"), secondary: [1] });
    expect(data.series.map((x) => [x.kind, x.axis])).toEqual([["column", 0], ["line", 1]]);
  });

  it("Pareto adds a cumulative line on a 0–100% right axis", () => {
    const s = sheet([["a", 1], ["b", 3]]);
    const data = buildChart(s, { ...defaultSpec("p", range(0, 0, 1, 1), "pareto"), names: false });
    expect(data.categories).toEqual(["b", "a"]);
    expect([...data.series[1].values]).toEqual([0.75, 1]);
    expect(data.limits.y2Max).toBe(1);
  });
});
