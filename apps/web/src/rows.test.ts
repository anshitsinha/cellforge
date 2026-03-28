import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { mapRow } from "@cellforge/core";
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

function setup(rows = 12, cols = 5) {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(rows, cols)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const type = (cells: [string, string][], sheet?: string) =>
    history.run(
      setCells(
        cells.map(([ref, input]) => ({ row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65, input })),
        undefined,
        sheet,
      ),
    );
  return { ctx, history, workbook, sheet: workbook.sheets[0].source, type };
}

const text = (s: EditableSource, ref: string) => s.getEditText(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);
const val = (s: EditableSource, ref: string) => s.getCell(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);

describe("inserting rows", () => {
  it("moves data down and adjusts formulas like Excel", async () => {
    const { history, sheet, type } = setup();
    await type([["A1", "1"], ["A2", "2"], ["A3", "3"], ["A4", "4"], ["B1", "=SUM(A1:A4)"], ["C3", "=A3*10"]]);
    await history.run({ type: "rows.insert", params: { at: 1, count: 2 } });
    expect([1, 2, 3, 4, 5, 6].map((r) => val(sheet, `A${r}`))).toEqual([1, null, null, 2, 3, 4]);
    expect(text(sheet, "B1")).toBe("=SUM(A1:A6)");
    expect(val(sheet, "B1")).toBe(10);
    expect(text(sheet, "C5")).toBe("=A5*10");
    expect(val(sheet, "C5")).toBe(30);
    expect(sheet.rowCount).toBe(14);
  });

  it("filled blocks keep every row right, split where needed", async () => {
    const { history, sheet, type } = setup(20, 4);
    for (let r = 1; r <= 10; r++) await type([[`A${r}`, String(r)]]);
    await type([["B2", "=A1+A2"]]); // reads the row above and its own row
    await history.run({ type: "fill.down", params: { range: { top: 1, left: 1, bottom: 9, right: 1 } } });
    const before = Array.from({ length: 10 }, (_, r) => sheet.getCell(r, 1));
    await history.run({ type: "rows.insert", params: { at: 5, count: 3 } });
    // every filled row shows what it showed before, wherever it moved
    for (let r = 0; r < 10; r++) expect(sheet.getCell(mapRow({ at: 5, count: 3, insert: true }, r)!, 1)).toBe(before[r]);
    // the row just below the insertion reads across it, so its formula changed
    expect(text(sheet, "B9")).toBe("=A5+A9");
  });

  it("adjusts other sheets' references to the sheet", async () => {
    const { history, workbook, type } = setup();
    await type([["A5", "42"]]);
    await history.run({ type: "sheet.add", params: { name: "Report" } });
    const report = workbook.sheets[1];
    await type([["A1", "=Sheet1!A5*2"]], report.id);
    await history.run({ type: "rows.insert", params: { at: 0, count: 1, sheet: workbook.sheets[0].id } });
    expect(text(report.source, "A1")).toBe("=Sheet1!A6*2");
    expect(val(report.source, "A1")).toBe(84);
  });
});

describe("deleting rows", () => {
  it("references to deleted cells become #REF!; undo restores everything exactly", async () => {
    const { history, sheet, type } = setup();
    await type([["A1", "1"], ["A2", "2"], ["A3", "3"], ["B1", "=A2*2"], ["B5", "=SUM(A1:A3)"], ["C2", "kept?"]]);
    await history.run({ type: "rows.delete", params: { at: 1, count: 1 } });
    expect(text(sheet, "B1")).toBe("=#REF!*2");
    expect(val(sheet, "B1")).toBe("#REF!");
    expect(text(sheet, "B4")).toBe("=SUM(A1:A2)");
    expect(val(sheet, "B4")).toBe(4);
    await history.undo();
    expect(text(sheet, "B1")).toBe("=A2*2");
    expect(val(sheet, "B1")).toBe(4);
    expect(val(sheet, "C2")).toBe("kept?");
    expect(text(sheet, "B5")).toBe("=SUM(A1:A3)");
    expect(sheet.rowCount).toBe(12);
    expect(sheet.rowOrder).toBeNull(); // back to the original layout: fast paths return
  });

  it("works on a sorted sheet", async () => {
    const { history, sheet, type } = setup(4, 2);
    await type([["A1", "3"], ["A2", "1"], ["A3", "2"], ["B1", "=A1*2"]]);
    await history.run({ type: "rows.sort", params: { col: 0 } });
    // sorted: 1, 2, 3(with B=6), blank
    await history.run({ type: "rows.delete", params: { at: 0, count: 1 } });
    expect(val(sheet, "A2")).toBe(3);
    expect(val(sheet, "B2")).toBe(6);
  });
});

describe("randomised: insert keeps every value; insert/delete + undo is exact", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const ROWS = 10;
  const COLS = 4;
  const L = (c: number) => String.fromCharCode(65 + c);

  for (const seed of Array.from({ length: 16 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const { history, sheet } = setup(ROWS, COLS);
      const cells = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const p = rand();
          const ref = () => `${rand() < 0.2 ? "$" : ""}${L(Math.floor(rand() * c))}${rand() < 0.2 ? "$" : ""}${1 + Math.floor(rand() * ROWS)}`;
          if (c > 0 && p < 0.35) cells.push({ row: r, col: c, input: rand() < 0.5 ? `=${ref()}*2` : `=SUM(${L(Math.floor(rand() * c))}1:${L(Math.floor(rand() * c))}${ROWS})` });
          else if (p < 0.8) cells.push({ row: r, col: c, input: String(Math.floor(rand() * 9)) });
        }
      }
      await history.run(setCells(cells));
      if (rand() < 0.5) {
        const r = Math.floor(rand() * (ROWS - 4));
        await history.run({ type: "fill.down", params: { range: { top: r, left: 3, bottom: r + 3, right: 3 } } });
      }
      const snap = () => {
        const out: unknown[] = [];
        for (let r = 0; r < sheet.rowCount; r++) for (let c = 0; c < COLS; c++) out.push([sheet.getCell(r, c), sheet.getEditText(r, c)]);
        return out;
      };
      const original = snap();
      const values = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => sheet.getCell(r, c)));

      const at = Math.floor(rand() * ROWS);
      const count = 1 + Math.floor(rand() * 3);
      await history.run({ type: "rows.insert", params: { at, count } });
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const moved = mapRow({ at, count, insert: true }, r)!;
          expect(sheet.getCell(moved, c), `seed ${seed}: ${L(c)}${r + 1} -> row ${moved + 1}`).toEqual(values[r][c]);
        }
      }
      await history.undo();
      expect(snap()).toEqual(original);

      const dAt = Math.floor(rand() * (ROWS - 3));
      await history.run({ type: "rows.delete", params: { at: dAt, count: 1 + Math.floor(rand() * 2) } });
      await history.undo();
      expect(snap()).toEqual(original);
      await history.redo();
      await history.undo();
      expect(snap()).toEqual(original);
    });
  }
});

describe("columns", () => {
  it("insert moves data right and adjusts formulas, whole columns included", async () => {
    const { history, sheet, type } = setup(5, 6);
    await type([["A1", "1"], ["B1", "2"], ["C1", "3"], ["D1", "=SUM(A1:C1)"], ["E1", "=SUM(B:C)"], ["F1", "=C1*10"]]);
    await history.run({ type: "cols.insert", params: { at: 1, count: 2 } });
    expect(sheet.colCount).toBe(8);
    expect([0, 1, 2, 3, 4].map((c) => sheet.getCell(0, c))).toEqual([1, null, null, 2, 3]);
    expect(text(sheet, "F1")).toBe("=SUM(A1:E1)");
    expect(val(sheet, "F1")).toBe(6);
    expect(text(sheet, "G1")).toBe("=SUM(D:E)");
    expect(text(sheet, "H1")).toBe("=E1*10");
    expect(val(sheet, "H1")).toBe(30);
  });

  it("delete makes #REF! of deleted references; undo restores data and formulas", async () => {
    const { history, sheet, type } = setup(5, 5);
    await type([["A1", "1"], ["B1", "2"], ["C1", "=B1*2"], ["D1", "=SUM(A1:B1)"], ["B3", "note"]]);
    await history.run({ type: "cols.delete", params: { at: 1, count: 1 } });
    expect(text(sheet, "B1")).toBe("=#REF!*2");
    expect(text(sheet, "C1")).toBe("=SUM(A1:A1)");
    expect(val(sheet, "C1")).toBe(1);
    await history.undo();
    expect(val(sheet, "B3")).toBe("note");
    expect(text(sheet, "C1")).toBe("=B1*2");
    expect(val(sheet, "D1")).toBe(3);
    expect(sheet.colCount).toBe(5);
  });

  it("a compiled fill moves with its column and stays compiled", async () => {
    const { history, sheet, type } = setup(50, 4);
    for (let r = 1; r <= 50; r++) await type([[`A${r}`, String(r)]]);
    await type([["B1", "=A1*2"]]);
    await history.run({ type: "fill.down", params: { range: { top: 0, left: 1, bottom: 49, right: 1 } } });
    await history.run({ type: "cols.insert", params: { at: 0, count: 1 } });
    expect(sheet.getCell(39, 2)).toBe(80);
    expect(sheet.getEditText(39, 2)).toBe("=B40*2");
  });

  it("other sheets' references follow", async () => {
    const { history, workbook, type } = setup();
    await type([["C2", "7"]]);
    await history.run({ type: "sheet.add", params: { name: "R" } });
    await type([["A1", "=Sheet1!C2"]], workbook.sheets[1].id);
    await history.run({ type: "cols.delete", params: { at: 0, count: 1, sheet: workbook.sheets[0].id } });
    expect(text(workbook.sheets[1].source, "A1")).toBe("=Sheet1!B2");
    expect(val(workbook.sheets[1].source, "A1")).toBe(7);
  });
});

describe("imported data after restructuring", () => {
  it("whole-column sums don't count deleted rows (fast path guard)", async () => {
    const { ColumnBuilder, Table } = await import("@cellforge/core");
    const n = new ColumnBuilder("n");
    for (const v of ["1", "2", "3", "4"]) n.push(v);
    const s = new EditableSource(new Table([n.finish()]), 2);
    s.setCell(0, 1, (await import("./editable")).parseInput("=SUM(A:A)"));
    expect(s.getCell(0, 1)).toBe(10);
    s.deleteRows(2, 1); // drop the 3
    expect(s.getCell(0, 1)).toBe(7);
    expect(s.baseColumn(0)).toBeNull();
  });
});

describe("randomised: column insert keeps every value; insert/delete + undo is exact", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const ROWS = 6;
  const COLS = 6;
  const L = (c: number) => String.fromCharCode(65 + c);

  for (const seed of Array.from({ length: 12 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const { history, sheet } = setup(ROWS, COLS);
      const cells = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const p = rand();
          const anyRef = () => `${rand() < 0.2 ? "$" : ""}${L(Math.floor(rand() * COLS))}${1 + Math.floor(rand() * ROWS)}`;
          if (p < 0.3) cells.push({ row: r, col: c, input: rand() < 0.5 ? `=${anyRef()}+1` : `=SUM(${L(Math.floor(rand() * COLS))}:${L(Math.floor(rand() * COLS))})` });
          else if (p < 0.8) cells.push({ row: r, col: c, input: String(Math.floor(rand() * 9)) });
        }
      }
      await history.run(setCells(cells));
      const snap = () => {
        const out: unknown[] = [];
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < sheet.colCount; c++) out.push([sheet.getCell(r, c), sheet.getEditText(r, c)]);
        return out;
      };
      const original = snap();
      const values = Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => sheet.getCell(r, c)));
      const at = Math.floor(rand() * COLS);
      const count = 1 + Math.floor(rand() * 2);
      await history.run({ type: "cols.insert", params: { at, count } });
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const moved = c >= at ? c + count : c;
          expect(sheet.getCell(r, moved), `seed ${seed}: ${L(c)}${r + 1}`).toEqual(values[r][c]);
        }
      }
      await history.undo();
      expect(snap()).toEqual(original);
      await history.run({ type: "cols.delete", params: { at: Math.floor(rand() * (COLS - 2)), count: 1 + Math.floor(rand() * 2) } });
      await history.undo();
      expect(snap()).toEqual(original);
      await history.redo();
      await history.undo();
      expect(snap()).toEqual(original);
    });
  }
});

describe("hiding rows and columns", () => {
  it("hidden rows follow their data through sorts, inserts and undo", async () => {
    const { history, sheet, type } = setup(6, 2);
    await type([["A1", "5"], ["A2", "3"], ["A3", "9"], ["A4", "1"]]);
    await history.run({ type: "rows.hide", params: { at: 1, count: 2, hidden: true } }); // 3 and 9
    expect(sheet.hiddenRowIntervals()).toEqual([[1, 2]]);
    await history.run({ type: "rows.sort", params: { col: 0 } }); // 1 3 5 9
    expect(sheet.hiddenRowIntervals()).toEqual([[1, 1], [3, 3]]);
    await history.run({ type: "rows.insert", params: { at: 0, count: 1 } });
    expect(sheet.hiddenRowIntervals()).toEqual([[2, 2], [4, 4]]);
    await history.undo();
    await history.undo();
    expect(sheet.hiddenRowIntervals()).toEqual([[1, 2]]);
    await history.undo();
    expect(sheet.hiddenRowIntervals()).toEqual([]);
    await history.redo();
    expect(sheet.hiddenRowIntervals()).toEqual([[1, 2]]);
  });

  it("unhiding a range shows only the hidden rows inside it", async () => {
    const { history, sheet } = setup(10, 2);
    await history.run({ type: "rows.hide", params: { at: 2, count: 1, hidden: true } });
    await history.run({ type: "rows.hide", params: { at: 6, count: 2, hidden: true } });
    await history.run({ type: "rows.hide", params: { at: 0, count: 5, hidden: false } });
    expect(sheet.hiddenRowIntervals()).toEqual([[6, 7]]);
    await history.undo();
    expect(sheet.hiddenRowIntervals()).toEqual([[2, 2], [6, 7]]);
  });

  it("deleted rows stop being hidden; undoing the delete hides them again", async () => {
    const { history, sheet } = setup(8, 2);
    await history.run({ type: "rows.hide", params: { at: 3, count: 2, hidden: true } });
    await history.run({ type: "rows.delete", params: { at: 2, count: 2 } });
    expect(sheet.hiddenRowIntervals()).toEqual([[2, 2]]);
    await history.undo();
    expect(sheet.hiddenRowIntervals()).toEqual([[3, 4]]);
  });

  it("hidden columns move with inserts and deletes", async () => {
    const { history, sheet } = setup(4, 6);
    await history.run({ type: "cols.hide", params: { at: 2, count: 2, hidden: true } }); // C, D
    await history.run({ type: "cols.insert", params: { at: 0, count: 1 } });
    expect([...sheet.hiddenColumns].sort()).toEqual([3, 4]);
    await history.run({ type: "cols.delete", params: { at: 3, count: 1 } });
    expect([...sheet.hiddenColumns]).toEqual([3]);
    await history.undo();
    expect([...sheet.hiddenColumns].sort()).toEqual([3, 4]);
    await history.undo();
    await history.undo();
    expect([...sheet.hiddenColumns]).toEqual([]);
  });

  it("refuses to hide every column", async () => {
    const { history, sheet } = setup(2, 3);
    await expect(history.run({ type: "cols.hide", params: { at: 0, count: 3, hidden: true } })).rejects.toThrow(/visible/);
    expect(sheet.hiddenColumns.size).toBe(0);
  });
});

describe("randomised: hidden rows and columns follow their data", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  for (const seed of Array.from({ length: 12 }, (_, i) => i + 1)) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      const pick = (n: number) => Math.floor(rand() * n);
      const { history, sheet, type } = setup(14, 6);
      // every row tagged in A, every column tagged in row 1
      for (let r = 2; r <= 14; r++) await type([[`A${r}`, `r${r}`]]);
      await type([["A1", "hdr"]]);
      for (let c = 1; c < 6; c++) await type([[`${String.fromCharCode(65 + c)}1`, `c${c}`]]);
      // sorting moves the tag row too, so find it each time
      const hdr = () => { for (let r = 0; r < sheet.rowCount; r++) if (sheet.getCell(r, 0) === "hdr") return r; return -1; };
      const shot = () => ({
        rows: sheet.hiddenRowIntervals().flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => String(sheet.getCell(a + i, 0)))),
        cols: [...sheet.hiddenColumns].map((c) => String(sheet.getCell(hdr(), c))).sort(),
      });
      const start = shot();
      let hiddenRows = new Set<string>();
      let hiddenCols = new Set<string>();
      for (let step = 0; step < 25; step++) {
        const k = pick(7);
        const n = sheet.rowCount;
        if (k === 0 || k === 1) {
          const at = 1 + pick(n - 1);
          const count = 1 + pick(3);
          const hidden = k === 0;
          await history.run({ type: "rows.hide", params: { at, count, hidden } });
          for (let r = at; r < Math.min(n, at + count); r++) {
            const tag = String(sheet.getCell(r, 0));
            if (hidden) hiddenRows.add(tag);
            else hiddenRows.delete(tag);
          }
        } else if (k === 2 && sheet.colCount > 3) {
          const at = 1 + pick(sheet.colCount - 2);
          await history.run({ type: "cols.hide", params: { at, count: 1, hidden: rand() < 0.6 } });
          hiddenCols = new Set([...sheet.hiddenColumns].map((c) => String(sheet.getCell(hdr(), c))));
        } else if (k === 3) {
          await history.run({ type: "rows.insert", params: { at: 1 + pick(n - 1), count: 1 + pick(2) } });
        } else if (k === 4 && n > 6) {
          const at = 1 + pick(n - 2);
          if (at === hdr()) continue; // keep the column tags
          for (let r = at; r < at + 1; r++) hiddenRows.delete(String(sheet.getCell(r, 0)));
          await history.run({ type: "rows.delete", params: { at, count: 1 } });
        } else if (k === 5) {
          await history.run({ type: "cols.insert", params: { at: 1 + pick(sheet.colCount - 1), count: 1 } });
        } else {
          await history.run({ type: "rows.sort", params: { col: 0, descending: rand() < 0.5 } });
        }
        const now = shot();
        expect(new Set(now.rows.filter((t) => t !== "null" && t !== "hdr")), `seed ${seed} step ${step} rows`).toEqual(
          new Set([...hiddenRows].filter((t) => t !== "null" && t !== "hdr")),
        );
        expect(new Set(now.cols.filter((t) => t !== "null")), `seed ${seed} step ${step} cols`).toEqual(
          new Set([...hiddenCols].filter((t) => t !== "null")),
        );
        hiddenRows = new Set(now.rows);
        hiddenCols = new Set(now.cols);
      }
      while (history.canUndo) await history.undo();
      expect(shot()).toEqual({ rows: [], cols: [] });
      expect(start).toEqual({ rows: [], cols: [] });
    });
  }
});

describe("row heights and freeze panes", () => {
  it("heights follow their rows through sort and insert, and undo exactly", async () => {
    const { history, sheet, type } = setup(6, 1);
    await type([["A1", "3"], ["A2", "1"], ["A3", "2"]]);
    await history.run({ type: "rows.height", params: { at: 0, count: 1, height: 60 } }); // the 3
    expect([...sheet.rowHeightsByView()]).toEqual([[0, 60]]);
    await history.run({ type: "rows.sort", params: { col: 0 } });
    expect([...sheet.rowHeightsByView()]).toEqual([[2, 60]]);
    await history.run({ type: "rows.insert", params: { at: 0, count: 1 } });
    expect([...sheet.rowHeightsByView()]).toEqual([[3, 60]]);
    await history.undo();
    await history.undo();
    await history.undo();
    expect(sheet.rowHeightsByView().size).toBe(0);
  });

  it("per-row heights are one undo step; null goes back to the default", async () => {
    const { history, sheet } = setup(6, 1);
    await history.run({ type: "rows.height", params: { at: 1, heights: [40, null, 50] } });
    expect([...sheet.rowHeightsByView()].sort()).toEqual([[1, 40], [3, 50]]);
    await history.run({ type: "rows.height", params: { at: 1, height: null } });
    expect([...sheet.rowHeightsByView()]).toEqual([[3, 50]]);
    await history.undo();
    await history.undo();
    expect(sheet.rowHeightsByView().size).toBe(0);
  });

  it("freeze panes is an action and undoes", async () => {
    const { history, sheet } = setup();
    await history.run({ type: "view.freeze", params: { rows: 1, cols: 2 } });
    expect(sheet.frozen).toEqual({ rows: 1, cols: 2 });
    expect(sheet.clone().frozen).toEqual({ rows: 1, cols: 2 });
    await history.undo();
    expect(sheet.frozen).toEqual({ rows: 0, cols: 0 });
  });
});
