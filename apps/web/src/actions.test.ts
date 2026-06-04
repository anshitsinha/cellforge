import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

/** Sort by a column's display value in-process (the app does this in a worker). */
async function sortRows(sheet: EditableSource, col: number, descending: boolean) {
  const rows = Array.from({ length: sheet.rowCount }, (_, i) => i);
  const key = (r: number) => sheet.getCell(r, col);
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return a - b;
    if (x === null) return 1; // blanks last either way
    if (y === null) return -1;
    return (x < y ? -1 : 1) * (descending ? -1 : 1);
  });
  return Uint32Array.from(rows);
}

function setup(rows = 10, cols = 4) {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(rows, cols)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const registry = sheetActions();
  const history = new ActionHistory(registry, () => ctx);
  return { ctx, registry, history, workbook, sheet: workbook.sheets[0].source };
}

const column = (sheet: EditableSource, col: number, n: number) => Array.from({ length: n }, (_, r) => sheet.getCell(r, col));

describe("sheet actions", () => {
  it("edits are undoable and keep 'never edited' distinct from 'emptied'", async () => {
    const { history, sheet } = setup();
    await history.run(setCells([{ row: 0, col: 0, input: "5" }]));
    await history.run(setCells([{ row: 0, col: 0, input: null }]));
    expect(sheet.getStored(0, 0)).toBeNull(); // edited to empty
    await history.undo();
    expect(sheet.getCell(0, 0)).toBe(5);
    await history.undo();
    expect(sheet.getStored(0, 0)).toBeUndefined(); // untouched again
    expect(sheet.editCount).toBe(0);
    await history.redo();
    await history.redo();
    expect(sheet.getStored(0, 0)).toBeNull();
  });

  it("formulas evaluate and survive an undo round trip", async () => {
    const { history, sheet } = setup();
    await history.run(
      setCells([
        { row: 0, col: 0, input: "2" },
        { row: 1, col: 0, input: "3" },
        { row: 2, col: 0, input: "=A1*A2" },
      ]),
    );
    expect(sheet.getCell(2, 0)).toBe(6);
    await history.run(setCells([{ row: 2, col: 0, input: "=A1+A2" }]));
    expect(sheet.getCell(2, 0)).toBe(5);
    await history.undo();
    expect(sheet.getCell(2, 0)).toBe(6);
    expect(sheet.getEditText(2, 0)).toBe("=A1*A2");
  });

  it("rejects bad input before touching the sheet", async () => {
    const { history, sheet } = setup(5, 2);
    await expect(history.run({ type: "cells.set", params: { cells: [{ row: 0, col: 0, input: 5 }] } })).rejects.toThrow(/params.cells\[0\].input/);
    await expect(history.run(setCells([{ row: 9, col: 0, input: "x" }]))).rejects.toThrow(/outside the sheet/);
    expect(sheet.editCount).toBe(0);
    expect(history.canUndo).toBe(false);
  });

  it("fill down (unsorted) is one fill per column and undoes cleanly", async () => {
    const { history, sheet } = setup();
    await history.run(
      setCells([
        { row: 0, col: 0, input: "1" },
        { row: 0, col: 1, input: "=A1*10" },
        { row: 4, col: 1, input: "keep me" }, // covered by the fill, restored on undo
      ]),
    );
    for (let r = 1; r < 6; r++) await history.run(setCells([{ row: r, col: 0, input: String(r + 1) }]));
    await history.run({ type: "fill.down", params: { range: { top: 0, left: 1, bottom: 5, right: 1 } } });
    expect(column(sheet, 1, 6)).toEqual([10, 20, 30, 40, 50, 60]);
    await history.undo();
    expect(column(sheet, 1, 6)).toEqual([10, null, null, null, "keep me", null]);
    await history.redo();
    expect(column(sheet, 1, 6)).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("sort is async, undoable, and fill down on a sorted sheet writes cells", async () => {
    const { history, sheet } = setup(4, 2);
    await history.run(
      setCells([
        { row: 0, col: 0, input: "3" },
        { row: 1, col: 0, input: "1" },
        { row: 2, col: 0, input: "2" },
        { row: 3, col: 0, input: "0" },
        { row: 0, col: 1, input: "=A1+100" },
      ]),
    );
    await history.run({ type: "rows.sort", params: { col: 0 } });
    expect(column(sheet, 0, 4)).toEqual([0, 1, 2, 3]);
    await history.run({ type: "rows.sort", params: { col: 0, descending: true } });
    expect(column(sheet, 0, 4)).toEqual([3, 2, 1, 0]);
    // B1's formula moved with its row to the top; fill it down in the sorted view
    await history.run({ type: "fill.down", params: { range: { top: 0, left: 1, bottom: 3, right: 1 } } });
    expect(column(sheet, 1, 4)).toEqual([103, 102, 101, 100]);
    await history.undo(); // fill
    await history.undo(); // descending sort
    expect(column(sheet, 0, 4)).toEqual([0, 1, 2, 3]);
    await history.undo(); // ascending sort
    expect(column(sheet, 0, 4)).toEqual([3, 1, 2, 0]);
    expect(sheet.rowOrder).toBeNull();
  });

  it("a JSON log of user actions replays onto a fresh sheet (recipes)", async () => {
    const { registry, history, sheet } = setup();
    const log: string[] = [];
    registry.subscribe((a) => a.origin === "user" && log.push(JSON.stringify(a.action)));
    await history.run(setCells([{ row: 0, col: 0, input: "4" }, { row: 1, col: 0, input: "1" }]));
    await history.run(setCells([{ row: 0, col: 1, input: "=A1*2" }]));
    await history.run({ type: "fill.down", params: { range: { top: 0, left: 1, bottom: 1, right: 1 } } });
    await history.run({ type: "rows.sort", params: { col: 0 } });

    const fresh = setup();
    for (const json of log) await fresh.registry.apply(fresh.ctx, JSON.parse(json), "recipe");
    expect(column(fresh.sheet, 0, 2)).toEqual(column(sheet, 0, 2));
    expect(column(fresh.sheet, 1, 2)).toEqual(column(sheet, 1, 2));
    expect(column(fresh.sheet, 1, 2)).toEqual([2, 8]);
  });

  it("only public actions are offered as tools", () => {
    const { registry } = setup();
    expect(registry.catalog().map((c) => c.type)).toEqual([
      "cells.set",
      "fill.down",
      "rows.sort",
      "chart.set",
      "filter.set",
      "filter.clear",
      "filter.reapply",
      "filter.saveView",
      "filter.deleteView",
      "rows.sortBy",
      "filter.applyView",
      "format.conditionalAdd",
      "format.conditionalUpdate",
      "format.conditionalMove",
      "format.conditionalDelete",
      "validation.add",
      "validation.clear",
      "rows.insert",
      "rows.delete",
      "cols.insert",
      "cols.delete",
      "rows.hide",
      "cols.hide",
      "fill.series",
      "cells.paste",
      "data.cleanup",
      "cells.trim",
      "cells.toNumber",
      "tables.create",
      "tables.delete",
      "calc.iterative",
      "names.define",
      "names.delete",
      "version.save",
      "version.delete",
      "version.restore",
      "cells.merge",
      "cells.unmerge",
      "rows.height",
      "cols.width",
      "view.freeze",
      "format.set",
      "format.borders",
      "format.clear",
      "sheet.add",
      "sheet.delete",
      "sheet.duplicate",
      "sheet.rename",
      "sheet.move",
      "sheet.color",
      "sheet.hide",
    ]);
  });
});

describe("sheet actions", () => {
  const names = (wb: Workbook) => wb.sheets.map((x) => x.name);

  it("adds sheets with the next free name, and undo removes them", async () => {
    const { history, workbook } = setup();
    await history.run({ type: "sheet.add", params: {} });
    await history.run({ type: "sheet.add", params: { name: "Bank" } });
    expect(names(workbook)).toEqual(["Sheet1", "Sheet2", "Bank"]);
    await history.undo();
    await history.undo();
    expect(names(workbook)).toEqual(["Sheet1"]);
    await history.redo();
    expect(names(workbook)).toEqual(["Sheet1", "Sheet2"]);
  });

  it("enforces Excel's naming rules and unique names", async () => {
    const { history, workbook } = setup();
    const id = workbook.sheets[0].id;
    await expect(history.run({ type: "sheet.add", params: { name: "sheet1" } })).rejects.toThrow(/already a sheet/);
    await expect(history.run({ type: "sheet.rename", params: { sheet: id, name: "a/b" } })).rejects.toThrow(/can't contain/);
    await expect(history.run({ type: "sheet.rename", params: { sheet: id, name: "x".repeat(32) } })).rejects.toThrow();
    expect(names(workbook)).toEqual(["Sheet1"]);
  });

  it("delete keeps the data for undo; the last visible sheet can't go", async () => {
    const { history, workbook, sheet } = setup();
    await history.run(setCells([{ row: 0, col: 0, input: "keep" }]));
    await history.run({ type: "sheet.add", params: { name: "Other" } });
    const first = workbook.sheets[0].id;
    await history.run({ type: "sheet.delete", params: { sheet: first } });
    expect(names(workbook)).toEqual(["Other"]);
    await expect(history.run({ type: "sheet.delete", params: { sheet: workbook.sheets[0].id } })).rejects.toThrow(/at least one visible/);
    await history.undo();
    expect(names(workbook)).toEqual(["Sheet1", "Other"]);
    expect(workbook.sheets[0].source).toBe(sheet);
    expect(sheet.getCell(0, 0)).toBe("keep");
  });

  it("duplicate is independent of the original", async () => {
    const { history, workbook, sheet } = setup();
    await history.run(setCells([{ row: 0, col: 0, input: "2" }, { row: 0, col: 1, input: "=A1*10" }]));
    await history.run({ type: "sheet.duplicate", params: { sheet: workbook.sheets[0].id } });
    expect(names(workbook)).toEqual(["Sheet1", "Sheet1 (2)"]);
    const copy = workbook.sheets[1];
    expect(copy.source.getCell(0, 1)).toBe(20);
    await history.run(setCells([{ row: 0, col: 0, input: "5" }], undefined, copy.id));
    expect(copy.source.getCell(0, 1)).toBe(50);
    expect(sheet.getCell(0, 1)).toBe(20);
  });

  it("undo targets the sheet that was edited, even after switching", async () => {
    const { history, workbook, ctx, sheet } = setup();
    await history.run(setCells([{ row: 0, col: 0, input: "on sheet 1" }]));
    await history.run({ type: "sheet.add", params: { name: "Two" } });
    ctx.activeSheet = workbook.sheets[1].id; // user switched tabs
    await history.run(setCells([{ row: 0, col: 0, input: "on sheet 2" }]));
    await history.undo(); // sheet 2 edit
    await history.undo(); // add sheet
    await history.undo(); // sheet 1 edit
    expect(sheet.getStored(0, 0)).toBeUndefined();
    expect(names(workbook)).toEqual(["Sheet1"]);
  });

  it("rename, move, colour and hide are undoable", async () => {
    const { history, workbook } = setup();
    await history.run({ type: "sheet.add", params: { name: "B" } });
    await history.run({ type: "sheet.add", params: { name: "C" } });
    const [a, , c] = workbook.sheets.map((x) => x.id);
    await history.run({ type: "sheet.rename", params: { sheet: a, name: "A" } });
    await history.run({ type: "sheet.move", params: { sheet: c, index: 0 } });
    await history.run({ type: "sheet.color", params: { sheet: a, color: "#e37400" } });
    await history.run({ type: "sheet.hide", params: { sheet: a, hidden: true } });
    expect(names(workbook)).toEqual(["C", "A", "B"]);
    expect(workbook.visible.map((x) => x.name)).toEqual(["C", "B"]);
    expect(workbook.get(a).color).toBe("#e37400");
    for (let i = 0; i < 4; i++) await history.undo();
    expect(names(workbook)).toEqual(["Sheet1", "B", "C"]);
    expect(workbook.get(a).color).toBeUndefined();
    expect(workbook.get(a).hidden).toBeUndefined();
  });

  it("can't hide the only visible sheet", async () => {
    const { history, workbook } = setup();
    await expect(history.run({ type: "sheet.hide", params: { sheet: workbook.sheets[0].id, hidden: true } })).rejects.toThrow(
      /at least one visible/,
    );
  });
});

describe("cross-sheet references", () => {
  async function twoSheets() {
    const t = setup();
    await t.history.run({ type: "sheet.add", params: { name: "Data" } });
    const data = t.workbook.sheets[1];
    await t.history.run(setCells([{ row: 0, col: 0, input: "10" }, { row: 1, col: 0, input: "32" }], undefined, data.id));
    return { ...t, data };
  }

  it("reads other sheets and follows their edits", async () => {
    const { history, sheet, data } = await twoSheets();
    await history.run(setCells([{ row: 0, col: 0, input: "=SUM(Data!A1:A2)*2" }]));
    expect(sheet.getCell(0, 0)).toBe(84);
    await history.run(setCells([{ row: 0, col: 0, input: "100" }], undefined, data.id));
    expect(sheet.getCell(0, 0)).toBe(264); // recalculated after an edit elsewhere
  });

  it("renaming a sheet rewrites formulas that point at it, and undo reverts", async () => {
    const { history, sheet, data } = await twoSheets();
    await history.run(setCells([{ row: 0, col: 0, input: "=Data!A2" }]));
    await history.run({ type: "sheet.rename", params: { sheet: data.id, name: "Bank Jan" } });
    expect(sheet.getEditText(0, 0)).toBe("='Bank Jan'!A2");
    expect(sheet.getCell(0, 0)).toBe(32);
    await history.undo();
    expect(sheet.getEditText(0, 0)).toBe("=Data!A2");
    expect(sheet.getCell(0, 0)).toBe(32);
  });

  it("deleting a sheet shows #REF! until undone", async () => {
    const { history, sheet, data } = await twoSheets();
    await history.run(setCells([{ row: 0, col: 0, input: "=Data!A1+1" }]));
    await history.run({ type: "sheet.delete", params: { sheet: data.id } });
    expect(sheet.getCell(0, 0)).toBe("#REF!");
    await history.undo();
    expect(sheet.getCell(0, 0)).toBe(11);
  });

  it("a cycle across sheets is #CYCLE!, not a hang", async () => {
    const { history, sheet, data } = await twoSheets();
    await history.run(setCells([{ row: 0, col: 1, input: "=Data!B1" }]));
    await history.run(setCells([{ row: 0, col: 1, input: "=Sheet1!B1" }], undefined, data.id));
    expect(sheet.getCell(0, 1)).toBe("#CYCLE!");
  });
});
