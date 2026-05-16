import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

describe("cleaning up an export", () => {
  it("makes a clean sheet and a dropped-rows sheet in one undo step", async () => {
    const workbook = new Workbook({ name: "Export", source: new EditableSource(new BlankSource(30, 6)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const rows = [
      ["Ledger export", "", ""],
      ["Date", "Account", "Amount"],
      ["15/01/2024", "Sales", "1.234,50"],
      ["16/01/2024", "Sales", "(200,00)"],
      ["Total", "", "1.034,50"],
      ["31/01/2024", "Fees", "n/a"],
    ];
    // typed as text the way an export arrives (a leading ' keeps it text)
    await h.run(setCells(rows.flatMap((r, i) => r.map((v, c) => ({ row: i, col: c, input: v ? "'" + v : null })))));
    await h.run({ type: "data.cleanup", params: {} });
    expect(workbook.sheets.map((s) => s.name)).toEqual(["Export", "Export clean", "Export dropped"]);
    const clean = workbook.sheets[1].source;
    expect(clean.getColumnName(0)).toBe("Date");
    expect([clean.getCell(0, 0), clean.getCell(0, 2), clean.getCell(1, 2)]).toEqual([45306, 1234.5, -200]);
    expect(clean.getStyle(0, 0)?.numFmt).toBe("yyyy-mm-dd");
    expect(clean.getCell(2, 2)).toBe("n/a"); // a value that didn't fit keeps its text
    const dropped = workbook.sheets[2].source;
    expect([dropped.getCell(0, 1), dropped.getCell(1, 1)]).toEqual(["title", "total"]);
    await h.undo();
    expect(workbook.sheets.map((s) => s.name)).toEqual(["Export"]);
    await h.redo();
    expect(workbook.sheets.length).toBe(3);

    // cleaning the clean sheet again: names come from its header, dates stay dates
    ctx.activeSheet = workbook.sheets[1].id;
    await h.run({ type: "data.cleanup", params: {} });
    const again = workbook.sheets[2];
    expect(again.name).toBe("Export clean clean");
    expect(again.source.getColumnName(2)).toBe("Amount");
    expect(again.source.getCell(0, 0)).toBe(45306);
    expect(again.source.getStyle(0, 0)?.numFmt).toBe("yyyy-mm-dd");
  });
});
