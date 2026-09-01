// Reports kept as columns: a large CSV is parsed into one array per column
// (ColumnCollector), unwrapped without an array per row (unwrapColumns) and
// checked as a bank statement one line at a time (columnsToLines), with the
// same answers as the row-based functions.
import { describe, expect, it } from "vitest";
import { columnsToLines, parseStatement, rowsToLines } from "../src/clean/bank";
import { ColumnCollector, tableRow, unwrapColumns, unwrapReport } from "../src/clean/unwrap";
import { CsvParser } from "../src/csv";

const collect = (rows: string[][]) => {
  const t = new ColumnCollector();
  for (const r of rows) t.add(r);
  return t;
};
const toRows = (u: { columns: string[][]; rows: number }) => Array.from({ length: u.rows }, (_, k) => u.columns.map((c) => c[k]));

const REPORT = [
  ["ACME Ltd — Sales by region", "", "", ""],
  ["Period: January 2024"],
  [""],
  ["Region", "Rep", "Revenue", ""],
  ["", "", "Q1", "Q2"],
  ["North", "Ann", " 100", "120"],
  ["", "Bob", "80", "90"],
  ["Subtotal North", "", "180", "210"],
  ["South", "Cid", "50", "60", "late note"],
  ["Page 1 of 2"],
  ["Region", "Rep", "Revenue", ""],
  ["", "Dee", "70", "75"],
  ["Grand total", "", "300", "345"],
];

describe("ColumnCollector", () => {
  it("keeps ragged rows as columns, with each row's width", () => {
    const t = collect([["a", "b"], ["c"], ["d", "e", "f"]]);
    expect(t.rows).toBe(3);
    expect(t.columns).toEqual([
      ["a", "c", "d"],
      ["b", "", "e"],
      ["", "", "f"],
    ]);
    expect(Array.from(t.widths)).toEqual([2, 1, 3]);
    expect(tableRow(t, 1)).toEqual(["c"]);
  });
  it("takes rows straight from the CSV parser", () => {
    const t = new ColumnCollector();
    const p = new CsvParser((r) => t.add(r));
    p.push('x,y\n1,"a,b"\n2');
    p.push(",c\n");
    p.end();
    expect(t.columns).toEqual([
      ["x", "1", "2"],
      ["y", "a,b", "c"],
    ]);
  });
  it("grows past its first block of rows", () => {
    const t = collect(Array.from({ length: 5000 }, (_, i) => [String(i)]));
    expect(t.widths.length).toBe(5000);
    expect(t.columns[0][4999]).toBe("4999");
  });
});

describe("unwrapColumns", () => {
  it("gives what unwrapReport gives: header, data, source rows, dropped rows, fill-down", () => {
    const want = unwrapReport(REPORT);
    const got = unwrapColumns(collect(REPORT));
    expect(got.header).toEqual(want.header);
    expect(toRows(got)).toEqual(want.rows);
    expect(Array.from(got.sourceRows)).toEqual(want.sourceRows);
    expect(got.dropped).toEqual(want.dropped);
    expect(got.filledDown).toEqual(want.filledDown);
    expect(got.headerRow).toBe(want.headerRow);
    expect(toRows(got)[0]).toEqual(["North", "Ann", "100", "120", ""]);
  });
  it("compacts the parsed columns in place rather than copying them", () => {
    const t = collect(REPORT);
    const first = t.columns[1];
    const u = unwrapColumns(t);
    expect(u.columns[1]).toBe(first);
    expect(first).toEqual(["Ann", "Bob", "Cid", "Dee"]);
  });
});

describe("parseStatement over columns", () => {
  it("reads the same transactions and balance checks one line at a time", () => {
    const rows = [
      ["Northbank plc"],
      ["Date", "Description", "Paid out", "Paid in", "Balance"],
      ["01 Mar 2025", "BALANCE BROUGHT FORWARD", "", "", "1,000.00"],
      ["02 Mar 2025", "FPO OAK MEDIA", "100.00", "", "900.00"],
      ["03 Mar 2025", "BGC PINE FOODS", "", "250.50", "1,150.50"],
      ["04 Mar 2025", "BANK CHARGES", "5.00", "", "1,140.50"],
      ["04 Mar 2025", "CLOSING BALANCE", "", "", "1,140.50"],
    ];
    const want = parseStatement(rowsToLines(rows));
    const got = parseStatement(columnsToLines(collect(rows)));
    expect(got).toEqual(want);
    expect(got.transactions).toHaveLength(3);
    expect(got.closingMatches).toBe(true);
  });
});
