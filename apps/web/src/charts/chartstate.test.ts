import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { sheetActions, type SheetCtx } from "../actions";
import { BlankSource, EditableSource } from "../editable";
import { packWorkbook, unpackWorkbook } from "../persist";
import { Workbook } from "../workbook";
import { defaultSpec } from "./model";

describe("charts in the workbook", () => {
  it("add, change and delete are undoable, and charts are saved with the file", async () => {
    const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(10, 3)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const spec = defaultSpec("c1", { sheetId: workbook.sheets[0].id, top: 0, left: 0, bottom: 4, right: 1 });
    await h.run({ type: "chart.set", params: { id: "c1", spec } });
    await h.run({ type: "chart.set", params: { id: "c1", spec: { ...spec, title: "Sales" } } });
    expect(workbook.charts.map((c) => c.title)).toEqual(["Sales"]);
    await h.undo();
    expect(workbook.charts[0].title).toBe(spec.title);
    await h.run({ type: "chart.set", params: { id: "c1", spec: null } });
    expect(workbook.charts).toEqual([]);
    await h.undo();
    expect(workbook.charts.length).toBe(1);

    const packed = packWorkbook(workbook, workbook.sheets[0].id, "Book");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(packed.meta)), async (n) => packed.files.get(n)!);
    expect(back.workbook.charts.map((c) => c.id)).toEqual(["c1"]);
  });
});
