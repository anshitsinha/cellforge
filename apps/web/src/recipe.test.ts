import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { RecipeRecorder, unbindAction, type RecipeStep } from "./recipe";
import { Workbook } from "./workbook";

function setup(names = ["Data", "Out"]) {
  const workbook = new Workbook({ name: names[0], source: new EditableSource(new BlankSource(10, 3)) });
  for (const n of names.slice(1)) workbook.add(n, new EditableSource(new BlankSource(10, 3)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  return { workbook, ctx, h, cell: (sheet: number, r: number, c: number) => workbook.sheets[sheet].source.getCell(r, c) };
}

/** Steps as the app records them: sheet ids become names. */
function record(wb: Workbook, actions: { action: Action; on: string }[]): RecipeStep[] {
  return actions.map(({ action, on }) => ({
    action: unbindAction(action, (id) => (wb.has(id) ? wb.get(id).name : undefined)),
    sheet: on,
    label: action.type,
    enabled: true,
  }));
}

describe("recipes", () => {
  it("run recorded steps as one undo step, on sheets found by name", async () => {
    const first = setup();
    const outId = first.workbook.sheets[1].id;
    const steps = record(first.workbook, [
      { action: setCells([{ row: 0, col: 0, input: "10" }]), on: "Data" },
      { action: setCells([{ row: 0, col: 0, input: "=Data!A1*2" }], undefined, outId), on: "Data" },
      { action: { type: "format.set", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, style: { bold: true } } }, on: "Out" },
    ]);
    expect((steps[1].action.params as { sheet: string }).sheet).toBe("@Out");

    // a different workbook with the same sheet names (in another order)
    const other = setup(["Out", "Data"]);
    await other.h.run({ type: "recipe.run", params: { name: "Monthly", steps } });
    expect(other.cell(1, 0, 0)).toBe(10); // Data!A1
    expect(other.cell(0, 0, 0)).toBe(20); // Out!A1
    expect(other.workbook.sheets[0].source.getStyle(0, 0)?.bold).toBe(true);
    expect(other.h.timeline.done.map((d) => d.label)).toEqual(['recipe "Monthly"']);

    await other.h.undo();
    expect([other.cell(1, 0, 0), other.cell(0, 0, 0), other.workbook.sheets[0].source.getStyle(0, 0)]).toEqual([null, null, null]);
    await other.h.redo();
    expect(other.cell(0, 0, 0)).toBe(20);
  });

  it("skips disabled steps, and a failing step undoes the ones before it and says which it was", async () => {
    const { workbook, h, cell } = setup();
    const steps = record(workbook, [
      { action: setCells([{ row: 0, col: 0, input: "1" }]), on: "Data" },
      { action: setCells([{ row: 1, col: 0, input: "2" }]), on: "Data" },
    ]);
    steps[1].enabled = false;
    await h.run({ type: "recipe.run", params: { steps } });
    expect([cell(0, 0, 0), cell(0, 1, 0)]).toEqual([1, null]);
    await h.undo();

    const bad = record(workbook, [
      { action: setCells([{ row: 0, col: 0, input: "5" }]), on: "Data" },
      { action: { type: "rows.hide", params: { at: 0, hidden: true } }, on: "Missing" },
    ]);
    await expect(h.run({ type: "recipe.run", params: { steps: bad } })).rejects.toThrow(/no sheet called "Missing"/);
    const failing = record(workbook, [
      { action: setCells([{ row: 0, col: 0, input: "5" }]), on: "Data" },
      { action: { type: "cells.merge", params: { range: { top: 0, left: 0, bottom: 99, right: 0 } } }, on: "Data" },
    ]);
    await expect(h.run({ type: "recipe.run", params: { steps: failing } })).rejects.toThrow(/Step 2/);
    expect(cell(0, 0, 0)).toBe(null); // step 1 was rolled back
  });

  it("the recorder follows undo and redo", () => {
    const r = new RecipeRecorder();
    r.record({ action: { type: "a", params: {} }, sheet: "S", label: "one" });
    r.record({ action: { type: "b", params: {} }, sheet: "S", label: "two" });
    r.undo("two");
    expect(r.steps.map((s) => s.label)).toEqual(["one"]);
    r.redo("two");
    expect(r.steps.map((s) => s.label)).toEqual(["one", "two"]);
    r.undo("not recorded"); // an undo of something that wasn't recorded leaves it alone
    expect(r.steps.length).toBe(2);
  });
});
