import { describe, expect, it } from "vitest";
import { dateToSerial, formatValue } from "../src/numfmt";
import { extendSeries } from "../src/series";
import { formatFormula, moveFormula, parseFormula } from "../src/formula";

const ext = (v: (number | string)[], n: number, backwards = false) => extendSeries(v, n, { backwards });

describe("fill series (Excel's results)", () => {
  it("numbers", () => {
    expect(ext([5], 3)).toEqual([5, 5, 5]);
    expect(ext([1, 2], 3)).toEqual([3, 4, 5]);
    expect(ext([10, 8], 3)).toEqual([6, 4, 2]);
    expect(ext([0.1, 0.2], 3)).toEqual([0.3, 0.4, 0.5]);
    // best-fit trend, like Excel (TREND of 1, 2, 4)
    const [a, b] = ext([1, 2, 4], 2) as number[];
    expect(a).toBeCloseTo(16 / 3, 10);
    expect(b).toBeCloseTo(41 / 6, 10);
    expect(ext([3, 4], 2, true)).toEqual([2, 1]);
  });

  it("dates by day, month and year", () => {
    const d = (y: number, m: number, day: number) => dateToSerial(y, m, day);
    const show = (xs: (number | string | null)[]) => xs.map((x) => formatValue(x as number, "yyyy-mm-dd").text);
    expect(show(extendSeries([d(2024, 1, 30)], 3, { dates: true }))).toEqual(["2024-01-31", "2024-02-01", "2024-02-02"]);
    expect(show(extendSeries([d(2024, 1, 31), d(2024, 2, 29)], 3, { dates: true }))).toEqual(["2024-03-31", "2024-04-30", "2024-05-31"]);
    expect(show(extendSeries([d(2024, 1, 15), d(2024, 4, 15)], 2, { dates: true }))).toEqual(["2024-07-15", "2024-10-15"]);
    expect(show(extendSeries([d(2022, 6, 30), d(2023, 6, 30)], 1, { dates: true }))).toEqual(["2024-06-30"]);
    expect(show(extendSeries([d(2024, 1, 1), d(2024, 1, 8)], 2, { dates: true }))).toEqual(["2024-01-15", "2024-01-22"]);
  });

  it("day and month names keep their case and wrap", () => {
    expect(ext(["Mon"], 3)).toEqual(["Tue", "Wed", "Thu"]);
    expect(ext(["friday"], 3)).toEqual(["saturday", "sunday", "monday"]);
    expect(ext(["NOV"], 3)).toEqual(["DEC", "JAN", "FEB"]);
    expect(ext(["January", "March"], 2)).toEqual(["May", "July"]);
    expect(ext(["Mon"], 2, true)).toEqual(["Sun", "Sat"]);
  });

  it("text with numbers, quarters, and plain text", () => {
    expect(ext(["Item 7"], 2)).toEqual(["Item 8", "Item 9"]);
    expect(ext(["Week 2", "Week 4"], 2)).toEqual(["Week 6", "Week 8"]);
    expect(ext(["INV-007"], 2)).toEqual(["INV-008", "INV-009"]);
    expect(ext(["Q3"], 3)).toEqual(["Q4", "Q1", "Q2"]);
    expect(ext(["a", "b"], 3)).toEqual(["a", "b", "a"]);
    expect(ext(["x", 1], 3)).toEqual(["x", 1, "x"]);
  });
});

describe("moveFormula", () => {
  const mv = (f: string, r: number, c: number) => formatFormula(moveFormula(parseFormula(f), r, c));
  it("moves relative parts and keeps anchors", () => {
    expect(mv("=A1+$B$2+C$3+$D4", 1, 2)).toBe("=C2+$B$2+E$3+$D5");
    expect(mv("=SUM(A1:B2)", 2, 1)).toBe("=SUM(B3:C4)");
    expect(mv("=SUM(A:A)", 5, 1)).toBe("=SUM(B:B)");
    expect(mv("=A1", -1, 0)).toBe("=#REF!");
  });
});
