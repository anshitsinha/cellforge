import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { compileQuery, find, FindError, findNext, planReplace, registerFindActions, replaceAction } from "./findreplace";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(100, 10)) });
  workbook.add("Data", new EditableSource(new BlankSource(100, 10)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const registry = sheetActions();
  registerFindActions(registry);
  const history = new ActionHistory(registry, () => ctx);
  const [s1, s2] = workbook.sheets;
  return { ctx, history, workbook, s1, s2 };
}

/** Type a block of rows into a sheet, starting at A1. */
async function type(history: ActionHistory<SheetCtx>, sheet: string, rows: (string | null)[][]) {
  const cells = rows.flatMap((r, row) => r.map((input, col) => ({ row, col, input })).filter((c) => c.input !== null));
  await history.run(setCells(cells, undefined, sheet));
}

const at = (ms: { row: number; col: number }[]) => ms.map((m) => `${m.row},${m.col}`);

describe("compileQuery", () => {
  it("matches case-insensitively by default, whole cell on request", () => {
    expect(compileQuery("abc", {}).test("xxABCxx")).toBe(true);
    expect(compileQuery("abc", { matchCase: true }).test("xxABCxx")).toBe(false);
    expect(compileQuery("abc", { wholeCell: true }).test("xxabc")).toBe(false);
    expect(compileQuery("abc", { wholeCell: true }).test("ABC")).toBe(true);
  });

  it("treats regex characters literally unless regex is on", () => {
    expect(compileQuery("a.c", {}).test("abc")).toBe(false);
    expect(compileQuery("a.c", {}).test("a.c")).toBe(true);
    expect(compileQuery("a.c", { regex: true }).test("abc")).toBe(true);
    expect(compileQuery("$5", {}).replace("cost $5", "$1")).toBe("cost $1"); // $ stays literal
  });

  it("supports groups in regex replacements", () => {
    expect(compileQuery("(\\w+), (\\w+)", { regex: true }).replace("Smith, Jane", "$2 $1")).toBe("Jane Smith");
    expect(compileQuery("a|b", { regex: true, wholeCell: true }).test("ab")).toBe(false);
  });

  it("explains a bad regex or an empty query", () => {
    expect(() => compileQuery("(", { regex: true })).toThrow(FindError);
    expect(() => compileQuery("(", { regex: true })).toThrow(/valid regular expression/);
    expect(() => compileQuery("", {})).toThrow(/Type something/);
    expect(() => compileQuery("(", {})).not.toThrow();
  });
});

describe("find", () => {
  it("looks in values or in formulas as typed", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["10", "=A1*2", "total"]]);
    const values = find(workbook, "20", { sheetId: s1.id, lookIn: "values" });
    expect(at(values)).toEqual(["0,1"]);
    expect(find(workbook, "A1", { sheetId: s1.id, lookIn: "values" })).toEqual([]);
    const formulas = find(workbook, "a1", { sheetId: s1.id, lookIn: "formulas" });
    expect(formulas).toEqual([{ sheetId: s1.id, row: 0, col: 1, text: "=A1*2" }]);
  });

  it("finds formatted values the way they show", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["12%"]]);
    expect(at(find(workbook, "12%", { sheetId: s1.id }))).toEqual(["0,0"]);
    expect(find(workbook, "0.12", { sheetId: s1.id })).toEqual([]);
  });

  it("orders by rows or by columns and respects the scope", async () => {
    const { history, workbook, s1, s2 } = setup();
    await type(history, s1.id, [
      ["x", "x"],
      ["x", "y"],
    ]);
    await type(history, s2.id, [["x"]]);
    expect(at(find(workbook, "x", { sheetId: s1.id }))).toEqual(["0,0", "0,1", "1,0"]);
    expect(at(find(workbook, "x", { sheetId: s1.id, byColumns: true }))).toEqual(["0,0", "1,0", "0,1"]);
    expect(at(find(workbook, "x", { sheetId: s1.id, scope: "selection", range: { top: 1, left: 0, bottom: 5, right: 5 } }))).toEqual(["1,0"]);
    const all = find(workbook, "x", { sheetId: s1.id, scope: "all" });
    expect(all.map((m) => m.sheetId)).toEqual([s1.id, s1.id, s1.id, s2.id]);
    expect(find(workbook, "x", { sheetId: s1.id, limit: 2 })).toHaveLength(2);
  });

  it("only looks at the used range of a big sheet", () => {
    const workbook = new Workbook({ name: "Big", source: new EditableSource(new BlankSource(1_000_000, 16_384)) });
    const sheet = workbook.sheets[0];
    sheet.source.setCell(5, 3, "needle");
    const t = performance.now();
    expect(at(find(workbook, "needle", { sheetId: sheet.id }))).toEqual(["5,3"]);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("whole cell and regex search across a sheet", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["INV-001"], ["inv-002 paid"], ["INV-3"]]);
    expect(at(find(workbook, "INV-\\d{3}", { sheetId: s1.id, regex: true, matchCase: true }))).toEqual(["0,0"]);
    expect(at(find(workbook, "inv-\\d+", { sheetId: s1.id, regex: true, wholeCell: true }))).toEqual(["0,0", "2,0"]);
  });
});

describe("findNext", () => {
  it("moves forward and back from the active cell, wrapping around", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["a", null, "a"], [null, "a"]]);
    const o = { sheetId: s1.id };
    const from = (row: number, col: number) => ({ sheetId: s1.id, row, col });
    expect(findNext(workbook, "a", o, from(0, 0))).toMatchObject({ row: 0, col: 2 });
    expect(findNext(workbook, "a", o, from(0, 2))).toMatchObject({ row: 1, col: 1 });
    expect(findNext(workbook, "a", o, from(1, 1))).toMatchObject({ row: 0, col: 0 }); // wraps
    expect(findNext(workbook, "a", o, from(0, 0), true)).toMatchObject({ row: 1, col: 1 }); // wraps back
    expect(findNext(workbook, "a", o, from(1, 1), true)).toMatchObject({ row: 0, col: 2 });
    expect(findNext(workbook, "a", o, from(50, 5))).toMatchObject({ row: 0, col: 0 }); // past the data
    expect(findNext(workbook, "zzz", o, from(0, 0))).toBeNull();
  });

  it("goes on to the next sheet when searching all sheets", async () => {
    const { history, workbook, s1, s2 } = setup();
    await type(history, s1.id, [["k"]]);
    await type(history, s2.id, [[null, "k"]]);
    const o = { sheetId: s1.id, scope: "all" as const };
    expect(findNext(workbook, "k", o, { sheetId: s1.id, row: 0, col: 0 })).toMatchObject({ sheetId: s2.id, row: 0, col: 1 });
    expect(findNext(workbook, "k", o, { sheetId: s2.id, row: 0, col: 1 })).toMatchObject({ sheetId: s1.id, row: 0, col: 0 });
    expect(findNext(workbook, "k", o, { sheetId: s1.id, row: 0, col: 0 }, true)).toMatchObject({ sheetId: s2.id });
  });

  it("finds the only match again from itself", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["one"]]);
    expect(findNext(workbook, "one", { sheetId: s1.id }, { sheetId: s1.id, row: 0, col: 0 })).toMatchObject({ row: 0, col: 0 });
  });
});

describe("replace", () => {
  it("replaces in formula text and keeps formulas as formulas", async () => {
    const { history, workbook, s1, ctx } = setup();
    await type(history, s1.id, [["1", "2", "=A1+A1", "A1 note"]]);
    const plan = planReplace(workbook, "A1", "B1", { sheetId: s1.id, lookIn: "formulas" });
    expect(plan.sheets[0].cells).toEqual([
      { row: 0, col: 2, input: "=B1+B1" },
      { row: 0, col: 3, input: "B1 note" },
    ]);
    await history.run(replaceAction(plan, "replace")!);
    const src = ctx.workbook.get(s1.id).source;
    expect(src.getCell(0, 2)).toBe(4);
    expect(src.getEditText(0, 2)).toBe("=B1+B1");
    expect(src.getCell(0, 3)).toBe("B1 note");
  });

  it("puts the = back if a regex removes it", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["3", "=A1*2"]]);
    const plan = planReplace(workbook, "^=A1", "A1+1", { sheetId: s1.id, regex: true });
    expect(plan.sheets[0].cells).toEqual([{ row: 0, col: 1, input: "=A1+1*2" }]);
  });

  it("never touches cells that don't match or wouldn't change", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["apple", "banana", "Apple"]]);
    const plan = planReplace(workbook, "apple", "apple", { sheetId: s1.id });
    expect(plan.count).toBe(1); // "Apple" -> "apple"; "apple" is unchanged
    expect(plan.sheets[0].cells).toEqual([{ row: 0, col: 2, input: "apple" }]);
    expect(planReplace(workbook, "cherry", "x", { sheetId: s1.id }).count).toBe(0);
    expect(replaceAction(planReplace(workbook, "cherry", "x", { sheetId: s1.id }), "r")).toBeNull();
  });

  it("uses regex groups", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["2024-01-15 ref"], ["no date"]]);
    const plan = planReplace(workbook, "(\\d{4})-(\\d\\d)-(\\d\\d)", "$3/$2/$1", { sheetId: s1.id, regex: true });
    expect(plan.sheets[0].cells).toEqual([{ row: 0, col: 0, input: "15/01/2024 ref" }]);
  });

  it("keeps text as text when the result looks like a number or formula", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["'007", "x=1", "'12%"]]);
    const plan = planReplace(workbook, "7", "8", { sheetId: s1.id });
    await history.run(replaceAction(plan, "r")!);
    expect(s1.source.getCell(0, 0)).toBe("008");
    await history.run(replaceAction(planReplace(workbook, "x", "", { sheetId: s1.id }), "r")!);
    expect(s1.source.getCell(0, 1)).toBe("=1");
    await history.run(replaceAction(planReplace(workbook, "12", "13", { sheetId: s1.id }), "r")!);
    expect(s1.source.getCell(0, 2)).toBe("13%");
  });

  it("numbers that change are typed again", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["1200"]]);
    await history.run(replaceAction(planReplace(workbook, "12", "13", { sheetId: s1.id }), "r")!);
    expect(s1.source.getCell(0, 0)).toBe(1300);
  });

  it("replaces only inside the selection", async () => {
    const { history, workbook, s1 } = setup();
    await type(history, s1.id, [["a", "a"], ["a", "a"]]);
    const plan = planReplace(workbook, "a", "b", { sheetId: s1.id, scope: "selection", range: { top: 0, left: 1, bottom: 1, right: 1 } });
    await history.run(replaceAction(plan, "r")!);
    expect([s1.source.getCell(0, 0), s1.source.getCell(0, 1), s1.source.getCell(1, 0), s1.source.getCell(1, 1)]).toEqual(["a", "b", "a", "b"]);
  });

  it("replaces across sheets as one undo step", async () => {
    const { history, workbook, s1, s2 } = setup();
    await type(history, s1.id, [["old", "keep"]]);
    await type(history, s2.id, [[null, "old news"]]);
    const plan = planReplace(workbook, "old", "new", { sheetId: s1.id, scope: "all" });
    expect(plan.count).toBe(2);
    const action = replaceAction(plan, "replace old")!;
    expect(action.type).toBe("cells.setMany");
    await history.run(action);
    expect(s1.source.getCell(0, 0)).toBe("new");
    expect(s2.source.getCell(0, 1)).toBe("new news");
    expect(s1.source.getCell(0, 1)).toBe("keep");
    await history.undo();
    expect(s1.source.getCell(0, 0)).toBe("old");
    expect(s2.source.getCell(0, 1)).toBe("old news");
    await history.undo(); // the typing on Data, not the replace
    expect(s2.source.getStored(0, 1)).toBeUndefined();
    expect(s1.source.getCell(0, 0)).toBe("old");
    await history.redo();
    await history.redo();
    expect(s1.source.getCell(0, 0)).toBe("new");
    expect(s2.source.getCell(0, 1)).toBe("new news");
  });

  it("undoes the sheets already changed if a later one fails", async () => {
    const { history, s1 } = setup();
    await type(history, s1.id, [["a"]]);
    const bad = { type: "cells.setMany", params: { edits: [{ sheet: s1.id, cells: [{ row: 0, col: 0, input: "b" }] }, { sheet: s1.id, cells: [{ row: 999_999, col: 0, input: "c" }] }] } };
    await expect(history.run(bad)).rejects.toThrow();
    expect(s1.source.getCell(0, 0)).toBe("a");
  });

  it("a bad regex is an error, not a silent no-op", () => {
    const { workbook, s1 } = setup();
    expect(() => planReplace(workbook, "[", "x", { sheetId: s1.id, regex: true })).toThrow(/valid regular expression/);
  });
});
