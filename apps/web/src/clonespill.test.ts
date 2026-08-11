import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

describe("copies of sheets with spilling formulas", () => {
  it("still spill", async () => {
    const workbook = new Workbook({ name: "S", source: new EditableSource(new BlankSource(10, 3)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells([{ row: 0, col: 0, input: "=SEQUENCE(3)" }, { row: 0, col: 1, input: "=SUM(A1:A3)" }]));
    expect(workbook.sheets[0].source.getCell(0, 1)).toBe(6);
    const copy = new Workbook({ name: "S", source: workbook.sheets[0].source.clone() });
    expect(copy.sheets[0].source.getCell(2, 0)).toBe(3);
    expect(copy.sheets[0].source.getCell(0, 1)).toBe(6);
  });
});
