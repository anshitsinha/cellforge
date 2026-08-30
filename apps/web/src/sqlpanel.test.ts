import { beforeEach, describe, expect, it } from "vitest";
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { resultRows } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { bindSqlStore, getSavedQueries, putResultOnSheet, registerSqlActions, runOnWorkbook, sheetColumnNames, sqlName, type SavedQuery } from "./sqlpanel";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "GL", source: new EditableSource(new BlankSource(100, 10)) });
  workbook.add("Bank Feb", new EditableSource(new BlankSource(100, 10)));
  const blobs = new BlobStore();
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs, sortRows: async () => null };
  const registry = sheetActions();
  registerSqlActions(registry);
  const history = new ActionHistory(registry, () => ctx);
  return { workbook, blobs, history, gl: workbook.sheets[0], bank: workbook.sheets[1] };
}

async function type(history: ActionHistory<SheetCtx>, sheet: string, rows: (string | null)[][]) {
  const cells = rows.flatMap((r, row) => r.map((input, col) => ({ row, col, input })).filter((c) => c.input !== null));
  await history.run(setCells(cells, undefined, sheet));
}

async function books() {
  const s = setup();
  await type(s.history, s.gl.id, [
    ["Date", "Account", "Ref", "Amount"],
    ["2024-01-05", "4000", "INV1", "100"],
    ["2024-01-20", "4000", "INV2", "250.50"],
    ["2024-02-03", "5000", "RENT", "-1200"],
  ]);
  await type(s.history, s.bank.id, [
    ["Ref", "Amount"],
    ["INV1", "100"],
    ["XYZ", "9"],
  ]);
  return s;
}

beforeEach(() => {
  let q: SavedQuery[] = [];
  bindSqlStore({ getQueries: () => q, setQueries: (x) => (q = x) });
});

describe("SQL over sheets", () => {
  it("names", () => {
    expect(sqlName("GL")).toBe("GL");
    expect(sqlName("Bank Feb")).toBe('"Bank Feb"');
    expect(sqlName("Order")).toBe('"Order"');
    expect(sqlName('a"b')).toBe('"a""b"');
  });

  it("reads sheets as tables, first row as names, dates kept", async () => {
    const { workbook, gl } = await books();
    expect(sheetColumnNames(gl)).toEqual(["Date", "Account", "Ref", "Amount"]);
    const r = runOnWorkbook("SELECT Account, DATE_TRUNC('month', Date) AS month, SUM(Amount) AS total FROM GL GROUP BY Account, month ORDER BY Account, month", workbook);
    expect(r.columns.map((c) => c.name)).toEqual(["Account", "month", "total"]);
    expect(resultRows(r).map((row) => [row[0], row[2]])).toEqual([
      [4000, 350.5],
      [5000, -1200],
    ]);
    expect(r.numFmts[1]).toMatch(/y/);
  });

  it("finds unmatched items across sheets with spaces in their names", async () => {
    const { workbook } = await books();
    const r = runOnWorkbook('SELECT g.Ref FROM GL g LEFT JOIN "bank feb" b ON g.Ref = b.Ref WHERE b.Ref IS NULL', workbook);
    expect(resultRows(r)).toEqual([["INV2"], ["RENT"]]);
  });

  it("puts the result on a new sheet, with its formats and origin", async () => {
    const { workbook, blobs, history } = await books();
    const sql = "SELECT Ref, Amount, Date FROM GL WHERE Amount > 0";
    const r = runOnWorkbook(sql, workbook);
    await putResultOnSheet(
      { workbook: () => workbook, activeSheet: () => workbook.sheets[0].id, run: (a: Action) => history.run(a), putBlob: (v) => blobs.put(v), status: () => {}, focusGrid: () => {} },
      r,
      sql,
      "Paid",
    );
    const sheet = workbook.sheets[2];
    expect(sheet.name).toBe("Paid");
    expect(sheet.origin).toBe(`SQL: ${sql}`);
    expect(sheet.source.getColumnName(0)).toBe("Ref");
    expect(sheet.source.getCell(1, 1)).toBe(250.5);
    expect(sheet.source.getStyle(0, 2)?.numFmt).toMatch(/y/);
    await history.undo();
    expect(workbook.sheets).toHaveLength(2);
  });

  it("explains a missing sheet", async () => {
    const { workbook } = await books();
    expect(() => runOnWorkbook("SELECT * FROM Ledger", workbook)).toThrow(/no table.*Ledger/);
  });
});

describe("saved queries", () => {
  it("sql.setSaved replaces the list and undoes", async () => {
    const { history } = setup();
    const a = { name: "Totals", sql: "SELECT 1" };
    await history.run({ type: "sql.setSaved", params: { queries: [a] } });
    expect(getSavedQueries()).toEqual([a]);
    await history.run({ type: "sql.setSaved", params: { queries: [a, { name: "Dupes", sql: "SELECT 2" }] } });
    expect(getSavedQueries()).toHaveLength(2);
    await history.undo();
    expect(getSavedQueries()).toEqual([a]);
    await history.undo();
    expect(getSavedQueries()).toEqual([]);
    await expect(history.run({ type: "sql.setSaved", params: { queries: [{ name: "x" }] } })).rejects.toThrow();
  });
});
