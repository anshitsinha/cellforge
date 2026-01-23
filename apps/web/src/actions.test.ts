import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";

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
  const ctx: SheetCtx = { sheet: new EditableSource(new BlankSource(rows, cols)), blobs: new BlobStore(), sortRows };
  const registry = sheetActions();
  const history = new ActionHistory(registry, () => ctx);
  return { ctx, registry, history, sheet: ctx.sheet };
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
    expect(registry.catalog().map((c) => c.type)).toEqual(["cells.set", "fill.down", "rows.sort"]);
  });
});
