import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { packWorkbook, unpackWorkbook } from "./persist";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "Data", source: new EditableSource(new BlankSource(30, 8)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const sheet = workbook.sheets[0].source;
  const type = (cells: [string, string][]) =>
    history.run(setCells(cells.map(([ref, input]) => ({ row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65, input }))));
  const at = (ref: string) => sheet.getCell(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);
  return { workbook, history, sheet, type, at };
}
const R = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right });

describe("tables", () => {
  it("structured references, this-row references and growing when typing below", async () => {
    const { history, type, at, sheet } = setup();
    await type([["A1", "Region"], ["B1", "Amount"], ["A2", "North"], ["B2", "10"], ["A3", "South"], ["B3", "20"]]);
    await history.run({ type: "tables.create", params: { range: R(0, 0, 2, 1), name: "Sales" } });
    await type([["C1", "Double"], ["C2", "=[@Amount]*2"], ["C3", "=Sales[@Amount]*2"], ["E1", "=SUM(Sales[Amount])"], ["E2", "=ROWS(Sales)"], ["E3", '=SUMIF(Sales[Region], "North", Sales[Amount])']]);
    expect([at("C2"), at("C3"), at("E1"), at("E2"), at("E3")]).toEqual([20, 40, 30, 2, 10]);
    expect(sheet.getStyle(0, 0)?.bold).toBe(true);
    // typing under the table grows it
    await type([["A4", "East"], ["B4", "5"]]);
    expect(sheet.tables[0].bottom).toBe(3);
    expect(at("E1")).toBe(35);
    await history.undo();
    expect(sheet.tables[0].bottom).toBe(2);
    expect(at("E1")).toBe(30);
  });

  it("rows inserted inside a table grow it; tables are saved; removing one breaks references", async () => {
    const { workbook, history, type, at, sheet } = setup();
    await type([["A1", "Item"], ["A2", "x"], ["A3", "y"], ["D1", "=ROWS(Table1)"]]);
    await history.run({ type: "tables.create", params: { range: R(0, 0, 2, 0) } });
    expect(sheet.tables[0].name).toBe("Table1");
    await history.run({ type: "rows.insert", params: { at: 2, count: 1 } });
    expect(sheet.tables[0].bottom).toBe(3);
    expect(at("D1")).toBe(3);
    const p = packWorkbook(workbook, workbook.sheets[0].id, "b");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(p.meta)), async (n) => p.files.get(n)!);
    expect(back.workbook.sheets[0].source.tables).toEqual(sheet.tables);
    await history.run({ type: "tables.delete", params: { name: "table1" } });
    expect(at("D1")).toBe("#NAME?");
    await history.undo();
    expect(at("D1")).toBe(3);
  });

  it("needs unique headers and a data row", async () => {
    const { history, type } = setup();
    await type([["A1", "x"], ["B1", "X"], ["A2", "1"]]);
    await expect(history.run({ type: "tables.create", params: { range: R(0, 0, 1, 1) } })).rejects.toThrow(/different/);
    await expect(history.run({ type: "tables.create", params: { range: R(0, 0, 0, 0) } })).rejects.toThrow(/data/);
  });
});
