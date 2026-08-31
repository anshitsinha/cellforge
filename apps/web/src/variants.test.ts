import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { suggestMerges } from "@cellforge/ai";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { columnTexts, mergeCells } from "./variants";
import { Workbook } from "./workbook";

describe("fixing spelling variants in a column", () => {
  it("rewrites the variants to the commonest spelling, as one undoable step", async () => {
    const workbook = new Workbook({ name: "AP", source: new EditableSource(new BlankSource(10, 2)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const names = ["Vendor", "Acme Ltd", "ACME LTD.", "Acme Ltd", "Beta & Co", "beta and co", "Beta & Co", "2024 Supplies"];
    await h.run(setCells(names.map((input, row) => ({ row, col: 0, input }))));
    const src = workbook.sheets[0].source;
    const { first, values } = columnTexts(src, 0);
    expect(first).toBe(1);
    const { merges } = await suggestMerges(values);
    const cells = mergeCells(values, first, 0, merges);
    expect(cells).toEqual([
      { row: 2, col: 0, input: "Acme Ltd" },
      { row: 5, col: 0, input: "Beta & Co" },
    ]);
    await h.run(setCells(cells));
    expect(columnTexts(src, 0).values.slice(0, 6)).toEqual(["Acme Ltd", "Acme Ltd", "Acme Ltd", "Beta & Co", "Beta & Co", "Beta & Co"]);
    await h.undo();
    expect(src.getCell(2, 0)).toBe("ACME LTD.");
  });

  it("keeps a value that looks like a number as text", () => {
    expect(mergeCells(["2024 supplies", "2024 Supplies"], 1, 0, [{ from: ["2024 supplies"], to: "2024", cells: 1, by: "rules" }])).toEqual([{ row: 1, col: 0, input: "'2024" }]);
  });
});
