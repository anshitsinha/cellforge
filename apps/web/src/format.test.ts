import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

async function sortRows(sheet: EditableSource, col: number, descending: boolean) {
  const rows = Array.from({ length: sheet.rowCount }, (_, i) => i);
  const key = (r: number) => sheet.getCell(r, col);
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return a - b;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * (descending ? -1 : 1);
  });
  return Uint32Array.from(rows);
}

function setup(rows = 10, cols = 4) {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(rows, cols)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const sheet = workbook.sheets[0].source;
  const type = (cells: [number, number, string][]) => history.run(setCells(cells.map(([row, col, input]) => ({ row, col, input }))));
  return { history, sheet, type };
}

const R = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

describe("format actions", () => {
  it("formats a range and undoes exactly", async () => {
    const { history, sheet } = setup();
    await history.run({ type: "format.set", params: { range: R(1, 0, 3, 1), style: { bold: true, fill: "#ffff00" } } });
    expect(sheet.getStyle(2, 1)).toEqual({ bold: true, fill: "#ffff00" });
    expect(sheet.getStyle(4, 1)).toBeNull();
    await history.run({ type: "format.set", params: { range: R(2, 1), style: { bold: null, color: "#c00000" } } });
    expect(sheet.getStyle(2, 1)).toEqual({ fill: "#ffff00", color: "#c00000" });
    await history.undo();
    expect(sheet.getStyle(2, 1)).toEqual({ bold: true, fill: "#ffff00" });
    await history.undo();
    expect(sheet.getStyle(2, 1)).toBeNull();
    await history.redo();
    expect(sheet.getStyle(3, 0)).toEqual({ bold: true, fill: "#ffff00" });
  });

  it("formatting stays with its row through sort, insert and delete", async () => {
    const { history, sheet, type } = setup(6, 2);
    await type([[0, 0, "30"], [1, 0, "10"], [2, 0, "20"]]);
    await history.run({ type: "format.set", params: { range: R(0, 0, 0, 1), style: { italic: true } } }); // the 30 row
    await history.run({ type: "rows.sort", params: { col: 0 } });
    expect(sheet.getCell(2, 0)).toBe(30);
    expect(sheet.getStyle(2, 1)).toEqual({ italic: true });
    expect(sheet.getStyle(0, 1)).toBeNull();
    await history.run({ type: "rows.insert", params: { at: 0, count: 2 } });
    expect(sheet.getStyle(4, 0)).toEqual({ italic: true });
    expect(sheet.getStyle(0, 0)).toBeNull();
    await history.run({ type: "rows.delete", params: { at: 4, count: 1 } });
    expect(sheet.getStyle(4, 0)).toBeNull();
    await history.undo();
    expect(sheet.getStyle(4, 0)).toEqual({ italic: true });
  });

  it("formats a scattered range on a sorted sheet", async () => {
    const { history, sheet, type } = setup(6, 1);
    await type([[0, 0, "3"], [1, 0, "1"], [2, 0, "2"], [3, 0, "0"]]);
    await history.run({ type: "rows.sort", params: { col: 0 } }); // 0 1 2 3
    await history.run({ type: "format.set", params: { range: R(1, 0, 2, 0), style: { underline: true } } });
    expect([0, 1, 2, 3].map((r) => sheet.getStyle(r, 0)?.underline ?? false)).toEqual([false, true, true, false]);
    await history.undo(); // the format
    await history.undo(); // the sort
    // the 1 and the 2 were rows 2 and 3 originally
    await history.redo();
    await history.redo();
    expect([0, 1, 2, 3].map((r) => sheet.getStyle(r, 0)?.underline ?? false)).toEqual([false, true, true, false]);
  });

  it("whole columns are one entry and move with column inserts and deletes", async () => {
    const { history, sheet } = setup(1000, 4);
    await history.run({ type: "format.set", params: { range: R(0, 1, 999, 1), style: { fill: "#eee" } } });
    expect(sheet.getStyle(999, 1)).toEqual({ fill: "#eee" });
    await history.run({ type: "cols.insert", params: { at: 0, count: 1 } });
    expect(sheet.getStyle(500, 2)).toEqual({ fill: "#eee" });
    expect(sheet.getStyle(500, 1)).toBeNull();
    await history.run({ type: "cols.delete", params: { at: 2, count: 1 } });
    expect(sheet.getStyle(500, 2)).toBeNull();
    await history.undo();
    expect(sheet.getStyle(500, 2)).toEqual({ fill: "#eee" });
  });

  it("borders: outline, inner and none", async () => {
    const { history, sheet } = setup();
    const line = { style: "thin", color: "#000000" };
    await history.run({ type: "format.borders", params: { range: R(0, 0, 2, 2), which: "outline", line } });
    expect(sheet.getStyle(0, 0)).toEqual({ borderTop: line, borderLeft: line });
    expect(sheet.getStyle(1, 1)).toBeNull();
    expect(sheet.getStyle(2, 2)).toEqual({ borderBottom: line, borderRight: line });
    await history.run({ type: "format.borders", params: { range: R(0, 0, 2, 2), which: "inner", line } });
    expect(sheet.getStyle(1, 1)).toEqual({ borderBottom: line, borderRight: line });
    await history.run({ type: "format.borders", params: { range: R(0, 0, 2, 2), which: "none" } });
    expect(sheet.getStyle(0, 0)).toBeNull();
    await history.undo();
    expect(sheet.getStyle(1, 1)).toEqual({ borderBottom: line, borderRight: line });
  });

  it("clear formatting keeps values; duplicate sheet copies formatting", async () => {
    const { history, sheet, type } = setup();
    await type([[0, 0, "5"]]);
    await history.run({ type: "format.set", params: { range: R(0, 0), style: { bold: true } } });
    const copy = sheet.clone();
    await history.run({ type: "format.clear", params: { range: R(0, 0) } });
    expect(sheet.getStyle(0, 0)).toBeNull();
    expect(sheet.getCell(0, 0)).toBe(5);
    expect(copy.getStyle(0, 0)).toEqual({ bold: true });
  });

  it("rejects bad style values", async () => {
    const { history } = setup();
    await expect(history.run({ type: "format.set", params: { range: R(0, 0), style: { align: "sideways" } } })).rejects.toThrow();
    await expect(history.run({ type: "format.set", params: { range: R(0, 0), style: { glow: true } } })).rejects.toThrow();
  });
});

describe("number formats", () => {
  it("typing 12%, $1,200 or a date stores a number and sets a matching format", async () => {
    const { history, sheet, type } = setup();
    await type([[0, 0, "12%"], [1, 0, "$1,200.50"], [2, 0, "2024-01-15"], [3, 0, "plain"]]);
    expect(sheet.getCell(0, 0)).toBe(0.12);
    expect(sheet.getStyle(0, 0)?.numFmt).toBe("0%");
    expect(sheet.formatValue(sheet.getCell(1, 0), sheet.getStyle(1, 0)).text).toBe("$1,200.50");
    expect(sheet.getCell(2, 0)).toBe(45306);
    expect(sheet.getEditText(2, 0)).toBe("2024-01-15");
    expect(sheet.getEditText(0, 0)).toBe("12%");
    expect(sheet.getStyle(3, 0)).toBeNull();
    await history.undo();
    expect(sheet.getCell(0, 0)).toBeNull();
    expect(sheet.getStyle(0, 0)).toBeNull();
    await history.redo();
    expect(sheet.getStyle(2, 0)?.numFmt).toBe("yyyy-mm-dd");
  });

  it("a cell's own format wins over the typed one", async () => {
    const { history, sheet, type } = setup();
    await history.run({ type: "format.set", params: { range: R(0, 0), style: { numFmt: "0.000" } } });
    await type([[0, 0, "50%"]]);
    expect(sheet.getCell(0, 0)).toBe(0.5);
    expect(sheet.formatValue(0.5, sheet.getStyle(0, 0)).text).toBe("0.500");
  });

  it("format.set applies a code; colours from the code come through", async () => {
    const { history, sheet, type } = setup();
    await type([[0, 0, "-1234.5"]]);
    await history.run({ type: "format.set", params: { range: R(0, 0), style: { numFmt: "#,##0.00;[Red](#,##0.00)" } } });
    expect(sheet.formatValue(sheet.getCell(0, 0), sheet.getStyle(0, 0))).toEqual({ text: "(1,234.50)", color: "#ff0000" });
  });
});

describe("fill.series", () => {
  it("continues numbers down, text across, and undoes in one step", async () => {
    const { history, sheet, type } = setup(10, 6);
    await type([[0, 0, "1"], [1, 0, "2"], [0, 1, "Mon"]]);
    await history.run({ type: "fill.series", params: { source: R(0, 0, 1, 0), target: R(0, 0, 4, 0) } });
    expect([2, 3, 4].map((r) => sheet.getCell(r, 0))).toEqual([3, 4, 5]);
    await history.run({ type: "fill.series", params: { source: R(0, 1), target: R(0, 1, 0, 4) } });
    expect([2, 3, 4].map((c) => sheet.getCell(0, c))).toEqual(["Tue", "Wed", "Thu"]);
    await history.undo();
    await history.undo();
    expect(sheet.getCell(2, 0)).toBeNull();
    expect(sheet.getCell(0, 2)).toBeNull();
  });

  it("moves formulas by row filling down and by column filling right", async () => {
    const { history, sheet, type } = setup(10, 6);
    await type([[0, 0, "5"], [1, 0, "7"], [0, 1, "=A1*2"]]);
    await history.run({ type: "fill.series", params: { source: R(0, 1), target: R(0, 1, 1, 1) } });
    expect(sheet.getEditText(1, 1)).toBe("=A2*2");
    expect(sheet.getCell(1, 1)).toBe(14);
    await history.run({ type: "fill.series", params: { source: R(0, 1), target: R(0, 1, 0, 2) } });
    expect(sheet.getEditText(0, 2)).toBe("=B1*2");
    expect(sheet.getCell(0, 2)).toBe(20);
  });

  it("dates step by month and keep their format; filling up goes backwards", async () => {
    const { history, sheet, type } = setup(10, 2);
    await type([[4, 0, "2024-01-31"], [5, 0, "2024-02-29"]]);
    await history.run({ type: "fill.series", params: { source: R(4, 0, 5, 0), target: R(4, 0, 7, 0) } });
    expect(sheet.getEditText(6, 0)).toBe("2024-03-31");
    expect(sheet.getStyle(7, 0)?.numFmt).toBe("yyyy-mm-dd");
    await type([[0, 1, "Item 5"]]);
    await history.run({ type: "fill.series", params: { source: R(0, 1), target: R(0, 1, 2, 1) } });
    await history.run({ type: "fill.series", params: { source: R(1, 1, 2, 1), target: R(0, 1, 2, 1) } });
    expect(sheet.getCell(0, 1)).toBe("Item 5");
  });

  it("rejects a target that doesn't extend the source in one direction", async () => {
    const { history } = setup();
    await expect(history.run({ type: "fill.series", params: { source: R(1, 1), target: R(0, 0, 3, 3) } })).rejects.toThrow(/one direction/);
  });
});

describe("cells.paste", () => {
  it("pastes formulas moved, values, and formats; undo restores", async () => {
    const { history, sheet, type } = setup(10, 6);
    await type([[0, 0, "4"], [1, 0, "6"], [0, 1, "=A1*2"]]);
    await history.run({ type: "format.set", params: { range: R(0, 1), style: { bold: true } } });
    await history.run({ type: "cells.paste", params: { from: R(0, 1), to: { row: 1, col: 1 } } });
    expect(sheet.getEditText(1, 1)).toBe("=A2*2");
    expect(sheet.getCell(1, 1)).toBe(12);
    expect(sheet.getStyle(1, 1)).toEqual({ bold: true });
    await history.run({ type: "cells.paste", params: { from: R(0, 1), to: { row: 0, col: 3 }, mode: "values" } });
    expect(sheet.getEditText(0, 3)).toBe("8");
    expect(sheet.getStyle(0, 3)).toBeNull();
    await history.run({ type: "cells.paste", params: { from: R(0, 1), to: { row: 5, col: 5 }, mode: "formats" } });
    expect(sheet.getCell(5, 5)).toBeNull();
    expect(sheet.getStyle(5, 5)).toEqual({ bold: true });
    await history.undo();
    await history.undo();
    await history.undo();
    expect(sheet.getCell(1, 1)).toBeNull();
    expect(sheet.getStyle(1, 1)).toBeNull();
  });

  it("handles overlapping source and target", async () => {
    const { history, sheet, type } = setup(10, 2);
    await type([[0, 0, "1"], [1, 0, "2"], [2, 0, "3"]]);
    await history.run({ type: "cells.paste", params: { from: R(0, 0, 2, 0), to: { row: 1, col: 0 } } });
    expect([0, 1, 2, 3].map((r) => sheet.getCell(r, 0))).toEqual([1, 1, 2, 3]);
  });
});
