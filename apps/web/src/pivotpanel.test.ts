import { describe, expect, it } from "vitest";
import { dateToSerial, Table, type ColumnData } from "@cellforge/core";
import { pivot } from "../../../packages/core/src/pivot";
import { EditableSource } from "./editable";
import { defaultZone, describeCell, drillColumns, emptyLayout, looksLikeDates, pivotSheetColumns, pivotTable, placeField, readSheetColumns, toSpec, valueFormat } from "./pivotpanel";
import { profileLines, profileOf, topLines } from "./profilepanel";

function text(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const codes = Uint32Array.from(values, (v) => {
    if (!v) return 0;
    const i = dict.indexOf(v);
    return i >= 0 ? i + 1 : dict.push(v);
  });
  return { kind: "string", name, codes, dict };
}
const num = (name: string, values: (number | null)[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values, (v) => v ?? NaN) });

const d = (m: number, day: number) => dateToSerial(2024, m, day);
function sales(): EditableSource {
  const src = new EditableSource(
    new Table([
      text("Region", ["East", "West", "East", "West", "East"]),
      text("Product", ["A", "A", "B", "B", "A"]),
      num("Amount", [10, 20, 30, 40, 50]),
      num("Date", [d(1, 5), d(1, 20), d(2, 3), d(4, 9), d(4, 30)]),
    ]),
    5,
  );
  src.styles.apply(2, "all", { numFmt: "#,##0.00" });
  src.styles.apply(3, "all", { numFmt: "yyyy-mm-dd" });
  return src;
}

describe("pivot panel: reading the sheet", () => {
  it("uses the imported columns as they are when nothing was edited", () => {
    const src = sales();
    const data = readSheetColumns(src);
    expect(data.names).toEqual(["Region", "Product", "Amount", "Date"]);
    expect(data.first).toBe(0);
    expect(data.rows).toBe(5);
    expect(data.isDate).toEqual([false, false, false, true]);
    expect(data.numFmts[2]).toBe("#,##0.00");
    // same buffer, no copy
    const base = src.baseColumn(2)!;
    expect(base.kind === "number" && data.columns[2].kind === "number" && data.columns[2].values.buffer === base.values.buffer).toBe(true);
  });

  it("reads edited columns cell by cell and follows a sort", () => {
    const src = sales();
    src.setCell(1, 2, 99);
    src.setRowOrder(Uint32Array.from([4, 3, 2, 1, 0]));
    const data = readSheetColumns(src);
    const amt = data.columns[2];
    expect(amt.kind).toBe("number");
    if (amt.kind === "number") expect([...amt.values]).toEqual([50, 40, 30, 99, 10]);
    const region = data.columns[0];
    expect(region.kind === "string" && [...region.codes].map((c) => region.dict[c - 1])).toEqual(["East", "West", "East", "West", "East"].reverse());
  });

  it("takes names from row 1 when the columns have none, and mixed columns become text", () => {
    const src = new EditableSource(new Table([text("", ["Vendor", "Acme", "Bolt", null]), text("", ["Amount", "5", null, null])]), 5);
    src.setCell(2, 1, 7);
    const data = readSheetColumns(src);
    expect(data.names).toEqual(["Vendor", "Amount"]);
    expect(data.first).toBe(1);
    expect(data.rows).toBe(3); // usedRange keeps the imported blank last row
    const v = data.columns[0];
    expect(v.kind === "string" && [...v.codes].map((c) => v.dict[c - 1])).toEqual(["Acme", "Bolt", undefined]);
    const a = data.columns[1];
    expect(a.kind === "string" && [...a.codes].map((c) => (c ? a.dict[c - 1] : null))).toEqual(["5", "7", null]);
  });

  it("names unnamed columns by letter", () => {
    const src = new EditableSource(new Table([text("", ["Name", "x"]), text("", [null, "y"])]), 0);
    expect(readSheetColumns(src).names).toEqual(["Name", "Column B"]);
  });
});

describe("pivot panel: layout", () => {
  const data = readSheetColumns(sales());

  it("places clicked fields: numbers to values, text and dates to rows (dates by month)", () => {
    expect(defaultZone(data, 0)).toBe("rows");
    expect(defaultZone(data, 2)).toBe("values");
    expect(defaultZone(data, 3)).toBe("rows");
    let l = placeField(emptyLayout(), data, 0, "rows");
    l = placeField(l, data, 3, "cols");
    l = placeField(l, data, 2, "values");
    l = placeField(l, data, 0, "cols", 0); // moves Region from rows to the front of columns
    expect(l.rows).toEqual([]);
    expect(l.cols).toEqual([{ field: 0 }, { field: 3, group: "month" }]);
    expect(l.values).toEqual([{ field: 2, agg: "sum", showAs: "value" }]);
    l = placeField(l, data, 1, "filters");
    expect(l.filters).toEqual([{ field: 1, keep: null }]);
    expect(toSpec(l).filters).toEqual([]);
    l.filters[0].keep = new Set(["A"]);
    expect(toSpec(l).filters).toEqual([{ field: 1, keep: new Set(["A"]) }]);
  });

  it("formats value columns", () => {
    expect(valueFormat({ field: 2, agg: "sum" }, data)).toBe("#,##0.00");
    expect(valueFormat({ field: 2, agg: "count" }, data)).toBe("#,##0");
    expect(valueFormat({ field: 2, agg: "sum", showAs: "pctRow" }, data)).toBe("0.0%");
    expect(valueFormat({ field: 3, agg: "max" }, data)).toBe("yyyy-mm-dd");
    expect(valueFormat({ field: 0, agg: "avg" }, data)).toBe("#,##0.00");
  });

  it("lays out the result sheet with labels, subtotals and a grand total", () => {
    const r = pivot(data.columns, { rows: [0, 1], cols: [], values: [{ field: 2, agg: "sum" }, { field: 2, agg: "count" }] });
    const t = pivotTable(r, data);
    expect(t.headers).toEqual(["Region", "Product", "Sum of Amount", "Count of Amount"]);
    expect(t.rows.map((x) => x.cells)).toEqual([
      ["East", "A", 60, 2],
      ["East", "B", 30, 1],
      ["East Total", null, 90, 3],
      ["West", "A", 20, 1],
      ["West", "B", 40, 1],
      ["West Total", null, 60, 2],
      ["Grand total", null, 150, 5],
    ]);
    expect(t.numFmts).toEqual(["", "", "#,##0.00", "#,##0"]);
    const sheet = pivotSheetColumns(t);
    expect(sheet.columns.map((c) => c.kind)).toEqual(["string", "string", "number", "number"]);
    const tbl = new Table(sheet.columns);
    expect(tbl.getCell(2, 0)).toBe("East Total");
    expect(tbl.getCell(2, 1)).toBe(null);
    expect(tbl.getCell(6, 2)).toBe(150);
    expect(describeCell(t, 1, 2)).toBe("East / B, Sum of Amount");
  });

  it("names value columns after column items, with date groups and blanks for empty cells", () => {
    const r = pivot(data.columns, { rows: [0], cols: [{ field: 3, group: "month" }], values: [{ field: 2, agg: "sum" }] });
    const t = pivotTable(r, data);
    expect(t.headers).toEqual(["Region", "2024-01 Jan", "2024-02 Feb", "2024-04 Apr", "Grand total"]);
    expect(t.rows[0].cells).toEqual(["East", 10, 30, 50, 90]);
    expect(t.rows[1].cells).toEqual(["West", 20, null, 40, 60]);
    const two = pivotTable(pivot(data.columns, { rows: [], cols: [1], values: [{ field: 2, agg: "sum" }, { field: 2, agg: "max" }] }), data);
    expect(two.headers).toEqual(["", "A · Sum of Amount", "A · Max of Amount", "B · Sum of Amount", "B · Max of Amount", "Grand total · Sum of Amount", "Grand total · Max of Amount"]);
    expect(two.rows).toEqual([{ kind: "grand", cells: ["Total", 80, 50, 70, 40, 150, 50] }]);
  });

  it("formats numeric row items like the source column", () => {
    const src = new EditableSource(new Table([num("Account", [4000, 1000, 4000]), num("Amount", [1, 2, 3])]), 0);
    src.styles.apply(0, "all", { numFmt: "0000" });
    const dd = readSheetColumns(src);
    const t = pivotTable(pivot(dd.columns, { rows: [0], cols: [], values: [{ field: 1, agg: "sum" }] }), dd);
    expect(t.rows.map((x) => x.cells[0])).toEqual(["1000", "4000", "Grand total"]);
  });

  it("drills down to every column of the member rows with sheet row numbers", () => {
    const r = pivot(data.columns, { rows: [0], cols: [], values: [{ field: 2, agg: "sum" }] });
    const sheet = drillColumns(data, r.members(1, 0)); // West
    const t = new Table(sheet.columns);
    expect(sheet.columns.map((c) => c.name)).toEqual(["Row", "Region", "Product", "Amount", "Date"]);
    expect(t.rowCount).toBe(2);
    expect([t.getCell(0, 0), t.getCell(0, 1), t.getCell(0, 3)]).toEqual([2, "West", 20]);
    expect([t.getCell(1, 0), t.getCell(1, 2), t.getCell(1, 3)]).toEqual([4, "B", 40]);
    expect(sheet.numFmts).toEqual(["0", "", "", "#,##0.00", "yyyy-mm-dd"]);
  });

  it("numbers rows from row 2 when row 1 holds the names", () => {
    const src = new EditableSource(new Table([text("", ["Vendor", "Acme", "Bolt", "Acme"])]), 0);
    const dd = readSheetColumns(src);
    const r = pivot(dd.columns, { rows: [0], cols: [], values: [] });
    const t = new Table(drillColumns(dd, r.members(0, 0)).columns);
    expect([t.getCell(0, 0), t.getCell(1, 0)]).toEqual([2, 4]);
  });
});

describe("column profiles", () => {
  const data = readSheetColumns(sales());

  it("profiles numbers in the column's format", () => {
    const p = profileOf(data, 2);
    const lines = Object.fromEntries(profileLines(p, data.numFmts[2]).map(([k, v]) => [k, v]));
    expect(lines).toMatchObject({ Rows: "5", Blank: "0 (0.0%)", Distinct: "5 (all different)", Min: "10.00", Max: "50.00", Sum: "150.00", Median: "30.00" });
  });

  it("profiles dates as a range", () => {
    const p = profileOf(data, 3);
    expect(p.type).toBe("date");
    const lines = Object.fromEntries(profileLines(p, data.numFmts[3]).map(([k, v]) => [k, v]));
    expect(lines.From).toBe("2024-01-05");
    expect(lines.To).toBe("2024-04-30");
  });

  it("profiles text with top values", () => {
    const p = profileOf(data, 0);
    expect(topLines(p)).toEqual([
      ["East", "3"],
      ["West", "2"],
    ]);
    const lines = Object.fromEntries(profileLines(p).map(([k, v]) => [k, v]));
    expect(lines.Length).toBe("4");
  });
});

describe("pivot panel: text dates", () => {
  it("offers date grouping for text columns that hold dates", () => {
    expect(looksLikeDates(text("When", ["2024-01-05", "5/2/2024", "3 March 2024"]))).toBe(true);
    expect(looksLikeDates(text("Who", ["Acme", "Bolt", "2024-01-05"]))).toBe(false);
    expect(looksLikeDates(num("N", [1, 2]))).toBe(false);
  });
});

describe("pivot panel: the same date twice", () => {
  it("keeps a date on Rows by year and by month", () => {
    const data = readSheetColumns(sales());
    let l = placeField(emptyLayout(), data, 3, "rows");
    l = { ...l, rows: [{ field: 3, group: "year" }] };
    l = placeField(l, data, 3, "rows");
    expect(l.rows).toEqual([{ field: 3, group: "year" }, { field: 3, group: "month" }]);
    expect(placeField(l, data, 3, "rows").rows.length).toBe(2);
  });
});
