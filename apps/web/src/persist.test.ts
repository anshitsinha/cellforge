import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { Table } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { AutoSaver, fromFile, MemoryStore, packWorkbook, toFile, unpackWorkbook, type JournalEntry } from "./persist";
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

function session(workbook: Workbook) {
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const history = new ActionHistory(sheetActions(), () => ctx);
  return { ctx, history };
}

const R = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });

/** Everything visible about a workbook, to compare before and after saving. */
function look(wb: Workbook) {
  return wb.sheets.map((s) => {
    const src = s.source;
    const cells: unknown[] = [];
    for (let r = 0; r < Math.min(src.rowCount, 12); r++) {
      for (let c = 0; c < src.colCount; c++) cells.push([src.getEditText(r, c), src.getCell(r, c), src.getStyle(r, c)]);
    }
    return {
      name: s.name,
      color: s.color,
      rows: src.rowCount,
      cols: src.colCount,
      cells,
      hidden: src.hiddenRowIntervals(),
      heights: [...src.rowHeightsByView()],
      widths: [...src.columnWidths],
      frozen: src.frozen,
      merges: src.merges,
    };
  });
}

async function build() {
  const table = new Table([
    { kind: "number", name: "amount", values: Float64Array.from([30, 10, 20, NaN]) },
    { kind: "string", name: "region", codes: Uint32Array.from([1, 2, 1, 0]), dict: ["North", "South"] },
  ]);
  const wb = new Workbook({ name: "Data", source: new EditableSource(table, 2) });
  const { history, ctx } = session(wb);
  await history.run(setCells([{ row: 0, col: 2, input: "=A1*2" }, { row: 1, col: 3, input: "12%" }]));
  await history.run({ type: "fill.down", params: { range: R(0, 2, 3, 2) } });
  await history.run({ type: "rows.sort", params: { col: 0 } });
  await history.run({ type: "format.set", params: { range: R(0, 0, 1, 1), style: { bold: true, fill: "#ffeeaa" } } });
  await history.run({ type: "rows.height", params: { at: 2, height: 40 } });
  await history.run({ type: "view.freeze", params: { rows: 1, cols: 1 } });
  await history.run({ type: "cols.width", params: { at: 0, width: 180 } });
  await history.run({ type: "sheet.add", params: { name: "Notes" } });
  const notes = wb.sheets[1].id;
  await history.run(setCells([{ row: 0, col: 0, input: "=Data!A1+1" }], undefined, notes));
  await history.run({ type: "cells.merge", params: { range: R(2, 0, 3, 1), sheet: notes } });
  await history.run({ type: "rows.hide", params: { at: 5, count: 2, hidden: true, sheet: notes } });
  await history.run({ type: "sheet.color", params: { sheet: notes, color: "#ff7033" } });
  return { wb, history, ctx };
}

describe("saving workbooks", () => {
  it("round-trips everything through metadata + files", async () => {
    const { wb } = await build();
    const before = look(wb);
    const packed = packWorkbook(wb, wb.sheets[1].id, "Book");
    const json = JSON.parse(JSON.stringify(packed.meta));
    const back = await unpackWorkbook(json, async (n) => packed.files.get(n)!);
    expect(back.name).toBe("Book");
    expect(back.active).toBe(wb.sheets[1].id);
    expect(look(back.workbook)).toEqual(before);
  });

  it("round-trips through a single .cellforge file", async () => {
    const { wb } = await build();
    const blob = toFile(packWorkbook(wb, wb.sheets[0].id, "Book"));
    const back = fromFile(await blob.arrayBuffer());
    const restored = await unpackWorkbook(back.meta, async (n) => back.files.get(n)!);
    expect(look(restored.workbook)).toEqual(look(wb));
  });

  it("refuses something that isn't a cellforge file", () => {
    expect(() => fromFile(new TextEncoder().encode("a,b,c\n1,2,3").buffer as ArrayBuffer)).toThrow(/cellforge/);
  });

  it("autosave: snapshot + journal replay restores the exact state, including undo", async () => {
    const store = new MemoryStore();
    const saver = new AutoSaver(store);
    const wb = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(20, 5)) });
    const { history } = session(wb);
    await saver.snapshot(wb, wb.sheets[0].id, "Untitled");
    const ran = async (entry: JournalEntry) => {
      if (entry.op === "run") await history.run(entry.action);
      else if (entry.op === "undo") await history.undo();
      else await history.redo();
      await saver.record(entry);
    };
    await ran({ op: "run", action: setCells([{ row: 0, col: 0, input: "5" }]) });
    await ran({ op: "run", action: setCells([{ row: 1, col: 0, input: "=A1*3" }]) });
    await ran({ op: "run", action: { type: "format.set", params: { range: R(1, 0), style: { italic: true } } } });
    await ran({ op: "undo" });
    await ran({ op: "run", action: { type: "rows.insert", params: { at: 0, count: 1 } } });
    await saver.flush();

    const loaded = await AutoSaver.load(store);
    expect(loaded).not.toBeNull();
    const { history: h2 } = session(loaded!.workbook);
    for (const e of loaded!.journal) {
      if (e.op === "run") await h2.run(e.action);
      else if (e.op === "undo") await h2.undo();
      else await h2.redo();
    }
    expect(look(loaded!.workbook)).toEqual(look(wb));
    // undo works after the reload
    await h2.undo();
    expect(loaded!.workbook.sheets[0].source.getCell(0, 0)).toBe(5);
  });

  it("a snapshot clears the journal and stale files; base data is written once", async () => {
    const store = new MemoryStore();
    const saver = new AutoSaver(store);
    const { wb } = await build();
    await saver.snapshot(wb, wb.sheets[0].id, "Book");
    await saver.record({ op: "undo" });
    await saver.snapshot(wb, wb.sheets[0].id, "Book");
    await saver.flush();
    expect(store.files.get("journal.ndjson")).toBe("");
    const loaded = await AutoSaver.load(store);
    expect(look(loaded!.workbook)).toEqual(look(wb));
  });
});

describe("named versions", () => {
  it("save, compare, go back, undo, and survive saving", async () => {
    const wb = new Workbook({ name: "Ledger", source: new EditableSource(new BlankSource(10, 4)) });
    const { history } = session(wb);
    // B reads its own row, so the formula keeps working when rows are sorted
    await history.run(setCells([{ row: 0, col: 0, input: "5" }, { row: 1, col: 0, input: "100" }, { row: 1, col: 1, input: "=A2*2" }]));
    await history.run({ type: "version.save", params: { name: "sent to auditor" } });
    await history.run(setCells([{ row: 1, col: 0, input: "150" }, { row: 2, col: 1, input: "note" }]));
    await history.run({ type: "rows.sort", params: { col: 0, descending: true } });

    const { compareWorkbooks, versionWorkbook } = await import("./versions");
    const diff = compareWorkbooks(versionWorkbook(wb.versions[0]), wb);
    const byCell = Object.fromEntries(diff.changes.map((c) => [c.cell, `${c.before} | ${c.after}`]));
    // matched by row, so the sort doesn't make every cell look changed
    expect(Object.values(byCell)).toContain("100 | 150");
    // the 150 row sorted to the top: its formula now reads row 1
    expect(byCell.B1).toBe("=A2*2 → 200 | =A1*2 → 300");
    expect(Object.values(byCell)).toContain(" | note");
    expect(diff.changes).toHaveLength(3);
    expect(diff.notes.join(" ")).toMatch(/different order/);

    // survives a save and reopen
    const packed = packWorkbook(wb, wb.sheets[0].id, "Ledger");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(packed.meta)), async (n) => packed.files.get(n)!);
    expect(back.workbook.versions.map((v) => v.name)).toEqual(["sent to auditor"]);

    await history.run({ type: "version.restore", params: { name: "sent to auditor" } });
    expect(wb.sheets[0].source.getCell(1, 0)).toBe(100);
    expect(wb.sheets[0].source.getCell(2, 1)).toBeNull();
    await history.undo();
    expect(wb.sheets[0].source.rowOrder).not.toBeNull();
    expect(wb.sheets[0].source.getCell(2, 1)).toBe("note");

    await expect(history.run({ type: "version.save", params: { name: "Sent To Auditor" } })).rejects.toThrow(/already/);
    await history.run({ type: "version.delete", params: { name: "sent to auditor" } });
    expect(wb.versions).toEqual([]);
    await history.undo();
    expect(wb.versions.map((v) => v.name)).toEqual(["sent to auditor"]);
  });
});
