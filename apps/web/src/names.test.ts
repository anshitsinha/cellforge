import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { packWorkbook, unpackWorkbook } from "./persist";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "Sales", source: new EditableSource(new BlankSource(20, 6)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const sheet = workbook.sheets[0].source;
  const type = (cells: [string, string][]) =>
    history.run(setCells(cells.map(([ref, input]) => ({ row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65, input }))));
  const at = (ref: string) => sheet.getCell(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);
  return { workbook, history, sheet, type, at };
}

describe("defined names", () => {
  it("names work as ranges, in conditions and as constants, and follow edits", async () => {
    const { history, type, at } = setup();
    await type([["A1", "North"], ["A2", "South"], ["A3", "North"], ["B1", "10"], ["B2", "20"], ["B3", "30"]]);
    await history.run({ type: "names.define", params: { name: "Region", refersTo: "Sales!$A$1:$A$3" } });
    await history.run({ type: "names.define", params: { name: "Amount", refersTo: "=Sales!$B$1:$B$3" } });
    await history.run({ type: "names.define", params: { name: "VatRate", refersTo: "0.2" } });
    await type([["D1", "=SUM(Amount)"], ["D2", '=SUMIF(Region, "North", Amount)'], ["D3", "=D1*VatRate"], ["D4", "=Nope+1"]]);
    expect([at("D1"), at("D2"), at("D3"), at("D4")]).toEqual([60, 40, 12, "#NAME?"]);
    await type([["B1", "100"]]);
    expect(at("D1")).toBe(150);
  });

  it("names follow inserted rows and renamed sheets; undo restores them", async () => {
    const { workbook, history, type, at } = setup();
    await type([["B1", "10"], ["B2", "20"]]);
    await history.run({ type: "names.define", params: { name: "Amount", refersTo: "Sales!$B$1:$B$2" } });
    await type([["D5", "=SUM(Amount)"]]);
    await history.run({ type: "rows.insert", params: { at: 1, count: 1 } });
    expect(workbook.getName("Amount")?.formula).toBe("Sales!$B$1:$B$3");
    expect(at("D6")).toBe(30);
    await history.run({ type: "sheet.rename", params: { sheet: workbook.sheets[0].id, name: "Q1" } });
    expect(workbook.getName("amount")?.formula).toBe("'Q1'!$B$1:$B$3"); // Q1 is also a cell, so it's quoted
    await history.undo();
    await history.undo();
    expect(workbook.getName("Amount")?.formula).toBe("Sales!$B$1:$B$2");
  });

  it("rejects bad names, deletes, and survives saving", async () => {
    const { workbook, history } = setup();
    await expect(history.run({ type: "names.define", params: { name: "A1", refersTo: "1" } })).rejects.toThrow(/cell address/);
    await history.run({ type: "names.define", params: { name: "Fx", refersTo: "1.1", comment: "EUR rate" } });
    const p = packWorkbook(workbook, workbook.sheets[0].id, "b");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(p.meta)), async (n) => p.files.get(n)!);
    expect(back.workbook.getName("FX")).toEqual({ name: "Fx", formula: "1.1", comment: "EUR rate" });
    await history.run({ type: "names.delete", params: { name: "fx" } });
    expect(workbook.definedNames).toEqual([]);
    await history.undo();
    expect(workbook.definedNames.length).toBe(1);
  });
});

describe("lookup near misses", () => {
  it("explains the #N/A and the fix makes the lookup work, undoably", async () => {
    const { history, type, at, sheet } = setup();
    await type([["A1", "1001"], ["A2", "1002"], ["B1", "x"], ["B2", "y"], ["C1", "  North "], ["D1", "=VLOOKUP(1002, A1:B2, 2, FALSE)"], ["D2", '=MATCH("North", C1:C1, 0)']]);
    // stored as numbers by typing; make A2 text the way an export would
    await history.run(setCells([{ row: 1, col: 0, input: "'1002" }]));
    expect(at("A2")).toBe("1002");
    expect(at("D1")).toBe("#N/A");
    expect(sheet.hintAt(0, 3)?.fix?.kind).toBe("toNumber");
    expect(sheet.hasNote(0, 3)).toBe(true);
    await history.run({ type: "cells.toNumber", params: { range: sheet.hintAt(0, 3)!.fix!.range } });
    expect(at("D1")).toBe("y");
    expect(sheet.hintAt(1, 3)?.fix?.kind).toBe("trim");
    await history.run({ type: "cells.trim", params: { range: { top: 0, left: 2, bottom: 0, right: 2 } } });
    expect(at("D2")).toBe(1);
    await history.undo();
    expect(at("D2")).toBe("#N/A");
  });
});
