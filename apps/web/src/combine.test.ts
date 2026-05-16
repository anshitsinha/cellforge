import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { alignColumns, combineParts, Table } from "@cellforge/core";
import { sheetActions, type SheetCtx } from "./actions";
import { textToColumns } from "./combine";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

describe("combining files", () => {
  it("types messy text columns, combines, and adds one sheet as one undo step", async () => {
    const jan = { name: "jan.csv", ...textToColumns(["Date", "Amount"], [["31/01/2024", "(1,200.00)"], ["15/01/2024", "300"]]) };
    const feb = { name: "feb.csv", ...textToColumns(["amount", "date", "Note"], [["50", "01/02/2024", "late"]]) };
    expect(jan.columns.map((c) => c.kind)).toEqual(["number", "number"]);
    expect(jan.numFmts[0]).toBe("yyyy-mm-dd");

    const { columns, numFmts } = combineParts([jan, feb], alignColumns([["Date", "Amount"], ["amount", "date", "Note"]]));
    const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(10, 3)) });
    const blobs = new BlobStore();
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs, sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const source = new EditableSource(new Table(columns), 5);
    await h.run({ type: "sheet.insert", params: { name: "Exports", source: blobs.put(source), numFmts: numFmts.map((f) => f ?? "") } });

    const sheet = workbook.sheets[1];
    expect(sheet.name).toBe("Exports");
    expect([0, 1, 2, 3].map((c) => sheet.source.getColumnName(c))).toEqual(["source file", "Date", "Amount", "Note"]);
    expect([0, 1, 2].map((r) => sheet.source.getCell(r, 2))).toEqual([-1200, 300, 50]);
    expect(sheet.source.getCell(2, 1)).toBe(45323);
    expect(sheet.source.getStyle(0, 1)?.numFmt).toBe("yyyy-mm-dd");
    expect(sheet.source.getCell(2, 0)).toBe("feb.csv");
    await h.undo();
    expect(workbook.sheets.length).toBe(1);
    await h.redo();
    expect(workbook.sheets[1].source.getCell(0, 2)).toBe(-1200);
  });
});
