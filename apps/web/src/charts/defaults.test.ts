import { describe, expect, it } from "vitest";
import type { CellValue } from "@cellforge/grid";
import type { ChartSource } from "./data";
import { buildChart } from "./data";
import { dateGroupFor, describeColumn, isIdLike, lastFilledRow, measureColumns, profileColumns, suggestChart, type ColumnInfo } from "./defaults";
import { defaultSpec } from "./model";

function sheet(rows: CellValue[][], fmts: Record<number, string> = {}): ChartSource {
  return {
    getCell: (r, c) => rows[r]?.[c] ?? null,
    getStyle: (r, c) => (r > 0 && fmts[c] ? { numFmt: fmts[c] } : null),
    usedRange: () => ({ rows: rows.length, cols: Math.max(...rows.map((r) => r.length)) }),
  };
}

const VENDORS = ["Acme", "Globex", "Initech", "Umbrella"];
/** A small ledger: Date, Ref, Vendor, Description, Account, Amount. */
function ledger(n = 40, sortedDates = false): ChartSource {
  const rows: CellValue[][] = [["Date", "Ref", "Vendor", "Description", "Account", "Amount"]];
  for (let i = 0; i < n; i++) {
    const date = sortedDates ? 46023 + i : 46023 + ((i * 37) % 200);
    rows.push([date, `INV-${1000 + i}`, VENDORS[i % 4], `Invoice ${i}`, 6000 + (i % 5) * 10, 100 + ((i * 7919) % 5000) + 0.5]);
  }
  return sheet(rows, { 0: "yyyy-mm-dd" });
}
const whole = (src: ChartSource) => ({ sheetId: "s", top: 0, left: 0, bottom: src.usedRange!().rows - 1, right: src.usedRange!().cols - 1 });

describe("column profiles", () => {
  it("tells dates, amounts, codes and text apart", () => {
    const src = ledger();
    const cols = profileColumns(src, whole(src), true);
    expect(cols.map((c) => c.kind)).toEqual(["date", "text", "text", "text", "number", "number"]);
    expect(cols.map((c) => c.name)).toEqual(["Date", "Ref", "Vendor", "Description", "Account", "Amount"]);
    const account = cols[4];
    expect(account.integer).toBe(true);
    expect(account.distinct).toBe(5);
  });

  it("treats IDs, references and account codes as identifiers, not measures", () => {
    const src = ledger();
    const cols = profileColumns(src, whole(src), true);
    expect(cols.filter(isIdLike).map((c) => c.name)).toEqual(["Ref", "Account"]);
  });

  it("spots unnamed sequence numbers and repeated codes by their values", () => {
    const seq = describeColumn(0, "Col", [101, 102, 103, 104, 105]);
    expect(isIdLike(seq)).toBe(true);
    const codes = describeColumn(0, "Col", [4000, 4100, 4000, 4100, 4000, 4100, 4000, 4100, 4000, 4100]);
    expect(isIdLike(codes)).toBe(true);
    const amounts = describeColumn(0, "Col", [120, 8039.5, 15959, 23877, 31796.5]);
    expect(isIdLike(amounts)).toBe(false);
    // named like a measure: never an ID even with ID-ish words
    expect(isIdLike(describeColumn(0, "Invoice amount", [10, 20, 30]))).toBe(false);
  });

  it("picks amounts first among the number columns", () => {
    const cols: ColumnInfo[] = [describeColumn(0, "Score", [1, 5, 2, 9]), describeColumn(1, "Net amount", [1.5, 2, 3, 4]), describeColumn(2, "Account", [6000, 6000, 6010, 6010])];
    expect(measureColumns(cols)).toEqual([1]);
    expect(measureColumns(cols.slice(0, 1))).toEqual([0]);
  });

  it("reads only a sample of a long sheet", () => {
    let reads = 0;
    const big: ChartSource = {
      getCell: (r, c) => {
        reads++;
        return r === 0 ? `C${c}` : r;
      },
      usedRange: () => ({ rows: 10_000_000, cols: 2 }),
    };
    profileColumns(big, { sheetId: "s", top: 0, left: 0, bottom: 9_999_999, right: 1 }, true);
    expect(reads).toBeLessThan(20_000);
  });
});

describe("suggested chart", () => {
  it("never plots the reference, vendor or account columns as series", () => {
    const src = ledger();
    const s = suggestChart(profileColumns(src, whole(src), true));
    expect(s.kind).toBe("range");
    if (s.kind !== "range") return;
    expect(s.series).toEqual([5]);
    expect(s.labelCol).toBe(0);
  });

  it("sums amounts by month when dates repeat or jump about and a pivot is possible", () => {
    const src = ledger();
    const s = suggestChart(profileColumns(src, whole(src), true), { canPivot: true });
    expect(s).toMatchObject({ kind: "pivot", rowField: 0, group: "month", values: [5], agg: "sum", type: "column" });
    expect(s.kind === "pivot" && s.title).toBe("Amount by month");
  });

  it("draws a line over time when the dates are in order and unique", () => {
    const src = ledger(30, true);
    const s = suggestChart(profileColumns(src, whole(src), true), { canPivot: true });
    expect(s).toMatchObject({ kind: "range", type: "line", labelCol: 0, series: [5] });
  });

  it("sums by a repeating category when there is no date", () => {
    const rows: CellValue[][] = [["Ref", "Vendor", "Amount"]];
    for (let i = 0; i < 20; i++) rows.push([`R${i}`, VENDORS[i % 4], i * 10.5]);
    const src = sheet(rows);
    expect(suggestChart(profileColumns(src, whole(src), true), { canPivot: true })).toMatchObject({ kind: "pivot", rowField: 1, values: [2], type: "column", title: "Amount by Vendor" });
    // without a pivot: the cells as they are, labelled by vendor
    expect(suggestChart(profileColumns(src, whole(src), true))).toMatchObject({ kind: "range", labelCol: 1, series: [2] });
  });

  it("charts a small summary table as it is", () => {
    const src = sheet([["Region", "Budget", "Actual"], ["North", 100, 120], ["South", 90, 80], ["West", 50, 55]]);
    expect(suggestChart(profileColumns(src, whole(src), true), { canPivot: true })).toMatchObject({ kind: "range", type: "column", labelCol: 0, series: [1, 2] });
  });

  it("counts rows by category when there are no numbers, or says why not", () => {
    const rows: CellValue[][] = [["Ref", "Status"]];
    for (let i = 0; i < 12; i++) rows.push([`R${i}`, i % 3 ? "Open" : "Closed"]);
    const src = sheet(rows);
    expect(suggestChart(profileColumns(src, whole(src), true), { canPivot: true })).toMatchObject({ kind: "pivot", agg: "count", rowField: 1 });
    expect(suggestChart(profileColumns(src, whole(src), true)).kind).toBe("none");
    expect(suggestChart([]).kind).toBe("none");
  });

  it("groups dates by day, month or year by their span", () => {
    expect(dateGroupFor(46000, 46030)).toBe("day");
    expect(dateGroupFor(46000, 46300)).toBe("month");
    expect(dateGroupFor(40000, 46300)).toBe("year");
  });
});

describe("charting chosen columns", () => {
  it("reads only the series columns and the label column it is given", () => {
    const src = ledger(5, true);
    const spec = defaultSpec("c", whole(src), "line");
    spec.series = [5];
    spec.labelCol = 0;
    const data = buildChart(src, spec);
    expect(data.series.map((s) => s.name)).toEqual(["Amount"]);
    expect(data.series[0].values.length).toBe(5);
    expect(data.xs?.[0]).toBe(46023);
  });

  it("without a choice still reads every column, as before", () => {
    const src = sheet([["Month", "A", "B"], ["Jan", 1, 2], ["Feb", 3, 4]]);
    const data = buildChart(src, defaultSpec("c", whole(src)));
    expect(data.series.map((s) => s.name)).toEqual(["A", "B"]);
  });
});

describe("balanced journals", () => {
  it("counts lines rather than adding amounts that net to nothing", () => {
    const rows: CellValue[][] = [["Entry", "Date", "Account", "Amount"]];
    for (let i = 0; i < 30; i++) {
      const amt = 100 + i * 37.5;
      rows.push([1000 + i, 46023 + (i % 9), 4000, amt], [1000 + i, 46023 + (i % 9), 2000, -amt]);
    }
    const src = sheet(rows, { 1: "yyyy-mm-dd" });
    const cols = profileColumns(src, whole(src), true);
    expect(cols[3].balanced).toBe(true);
    expect(suggestChart(cols, { canPivot: true })).toMatchObject({ kind: "pivot", rowField: 1, group: "day", agg: "count", values: [1], title: "Lines by day" });
  });

  it("an amount column of one sign is never balanced", () => {
    expect(describeColumn(0, "Amount", [10, 20, 30]).balanced).toBeUndefined();
    expect(describeColumn(0, "Amount", [10, -2, 30]).balanced).toBeUndefined();
  });
});

describe("trial balances and trailing blanks", () => {
  it("plots the net balance, not Debit and Credit beside it", () => {
    const cols = [describeColumn(0, "Code", [1000, 1100, 2000]), describeColumn(1, "Debit", [10, 20, null]), describeColumn(2, "Credit", [null, null, 30]), describeColumn(3, "Balance", [10, 20, -30])];
    expect(measureColumns(cols)).toEqual([3]);
    // without a net column, both sides
    expect(measureColumns(cols.slice(0, 3))).toEqual([1, 2]);
  });

  it("finds the last row with data under a used area padded with blanks", () => {
    const rows: CellValue[][] = [["A", "B"], [1, 2], [3, null]];
    const src = sheet(rows);
    const padded: ChartSource = { ...src, getCell: (r, c) => (r < 3 ? src.getCell(r, c) : null) };
    expect(lastFilledRow(padded, 0, 1999, 0, 1)).toBe(2);
    expect(lastFilledRow(padded, 0, 1999, 0, 1, 10)).toBe(1999);
  });
});
