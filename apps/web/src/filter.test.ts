import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { distinctValues, valueKey } from "./filter";
import { Workbook } from "./workbook";

async function sortRows(sheet: EditableSource, col: number, descending: boolean) {
  const rows = Array.from({ length: sheet.rowCount }, (_, i) => i);
  const key = (r: number) => sheet.getCell(r, col);
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * (descending ? -1 : 1);
  });
  return Uint32Array.from(rows);
}

async function setup() {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(8, 3)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const data = [
    ["Region", "Amount", "Rep"],
    ["North", "10", "Ann"],
    ["South", "40", "Bob"],
    ["north", "30", ""],
    ["East", "20", "Ann"],
    ["", "50", "Cy"],
  ];
  await history.run(setCells(data.flatMap((r, row) => r.map((input, col) => ({ row, col, input: input || null })))));
  const sheet = workbook.sheets[0].source;
  const visible = () =>
    Array.from({ length: 6 }, (_, r) => r)
      .filter((r) => !sheet.isFilteredOut(r))
      .map((r) => sheet.getCell(r, 0));
  return { history, sheet, visible };
}

describe("filters", () => {
  it("keeps rows whose value is in the list, ignoring case, and undo shows them again", async () => {
    const { history, sheet, visible } = await setup();
    await history.run({ type: "filter.set", params: { col: 0, condition: { kind: "values", keys: ["s:north", ""] } } });
    expect(visible()).toEqual(["Region", "North", "north", null]);
    expect(sheet.hiddenRowIntervals()).toEqual([
      [2, 2],
      [4, 4],
    ]);
    await history.undo();
    expect(visible().length).toBe(6);
    await history.redo();
    expect(visible().length).toBe(4);
  });

  it("combines columns, and number / text rules", async () => {
    const { history, visible } = await setup();
    await history.run({ type: "filter.set", params: { col: 1, condition: { kind: "number", op: ">=", a: 20 } } });
    expect(visible()).toEqual(["Region", "South", "north", "East", null]);
    await history.run({ type: "filter.set", params: { col: 2, condition: { kind: "text", op: "contains", value: "an" } } });
    expect(visible()).toEqual(["Region", "East"]);
    await history.run({ type: "filter.set", params: { col: 2, condition: null } });
    await history.run({ type: "filter.set", params: { col: 1, condition: { kind: "number", op: "top", a: 2 } } });
    expect(visible()).toEqual(["Region", "South", null]);
    await history.run({ type: "filter.clear", params: {} });
    expect(visible().length).toBe(6);
  });

  it("stays on the same rows through a sort, and reapply picks up edits", async () => {
    const { history, sheet, visible } = await setup();
    await history.run({ type: "filter.set", params: { col: 2, condition: { kind: "blanks", blank: false } } });
    expect(visible()).toEqual(["Region", "North", "South", "East", null]);
    await history.run({ type: "rows.sortBy", params: { keys: [{ col: 1, descending: true }], hasHeader: true } });
    expect(Array.from({ length: 6 }, (_, r) => sheet.getCell(r, 1))).toEqual(["Amount", 50, 40, 30, 20, 10]);
    expect(visible()).toEqual(["Region", null, "South", "East", "North"]);
    await history.run(setCells([{ row: 3, col: 2, input: "Dee" }])); // the "north" row
    expect(visible()).not.toContain("north"); // not until reapplied, like Excel
    await history.run({ type: "filter.reapply", params: {} });
    expect(visible()).toContain("north");
  });

  it("sorts by several keys", async () => {
    const { history, sheet } = await setup();
    await history.run({ type: "rows.sortBy", params: { keys: [{ col: 2 }, { col: 1, descending: true }], hasHeader: true } });
    expect(Array.from({ length: 6 }, (_, r) => [sheet.getCell(r, 2), sheet.getCell(r, 1)])).toEqual([
      ["Rep", "Amount"],
      ["Ann", 20],
      ["Ann", 10],
      ["Bob", 40],
      ["Cy", 50],
      [null, 30],
    ]);
    await history.undo();
    expect(sheet.getCell(1, 0)).toBe("North");
  });

  it("saves and switches views", async () => {
    const { history, sheet, visible } = await setup();
    await history.run({ type: "filter.set", params: { col: 0, condition: { kind: "values", keys: ["s:east"] } } });
    await history.run({ type: "filter.saveView", params: { name: "East only" } });
    await history.run({ type: "filter.clear", params: {} });
    await history.run({ type: "rows.sortBy", params: { keys: [{ col: 1 }], hasHeader: true } });
    await history.run({ type: "filter.saveView", params: { name: "By amount" } });
    expect(sheet.filterViews.map((v) => v.name)).toEqual(["East only", "By amount"]);
    await history.run({ type: "filter.applyView", params: { name: "East only" } });
    expect(visible()).toEqual(["Region", "East"]);
    await history.undo();
    expect(visible().length).toBe(6);
    await history.run({ type: "filter.deleteView", params: { name: "east only" } });
    expect(sheet.filterViews.map((v) => v.name)).toEqual(["By amount"]);
  });

  it("lists a column's values with counts, blanks first, numbers in order", async () => {
    const { sheet } = await setup();
    const { values } = distinctValues(sheet, 0, 0, (v) => String(v));
    expect(values.map((v) => [v.label, v.count])).toEqual([
      ["(Blanks)", 1],
      ["East", 1],
      ["North", 2],
      ["South", 1],
    ]);
    expect(valueKey(12.5)).toBe("n:12.5");
  });

  it("is saved with the sheet", async () => {
    const { history, sheet } = await setup();
    await history.run({ type: "filter.set", params: { col: 1, condition: { kind: "number", op: "<", a: 25 } } });
    const { state, binary } = sheet.toState();
    const back = EditableSource.fromState(new BlankSource(8, 3), 0, JSON.parse(JSON.stringify(state)), binary);
    expect(back.filter?.conditions.length).toBe(1);
    expect(back.isFilteredOut(2)).toBe(true);
    expect(back.isFilteredOut(1)).toBe(false);
  });
});
