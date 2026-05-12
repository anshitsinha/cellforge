import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { readXlsx, writeXlsx } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { packWorkbook, unpackWorkbook } from "./persist";
import { Workbook } from "./workbook";
import { workbookFromXlsx, workbookToXlsx } from "./xlsxio";

describe("Excel files", () => {
  it("a workbook survives a trip through .xlsx: values, formulas, formats, layout, names", async () => {
    const wb = new Workbook({ name: "Sales", source: new EditableSource(new BlankSource(50, 8)) });
    const ctx: SheetCtx = { workbook: wb, activeSheet: wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const R = (top: number, left: number, bottom = top, right = left) => ({ top, left, bottom, right });
    await h.run(
      setCells([
        { row: 0, col: 0, input: "Region" },
        { row: 0, col: 1, input: "Amount" },
        { row: 1, col: 0, input: "North" },
        { row: 1, col: 1, input: "1200" },
        { row: 2, col: 0, input: "South" },
        { row: 2, col: 1, input: "$800.50" },
        { row: 3, col: 1, input: "=SUM(B2:B3)" },
        { row: 4, col: 0, input: "TRUE" },
        { row: 5, col: 0, input: "=XLOOKUP(\"West\", A2:A3, B2:B3)" },
      ]),
    );
    await h.run({ type: "format.set", params: { range: R(0, 0, 0, 1), style: { bold: true, fill: "#ffeeaa" } } });
    await h.run({ type: "cells.merge", params: { range: R(7, 0, 7, 2) } });
    await h.run({ type: "cols.width", params: { at: 0, width: 160 } });
    await h.run({ type: "view.freeze", params: { rows: 1, cols: 0 } });
    await h.run({ type: "names.define", params: { name: "Amounts", refersTo: "Sales!$B$2:$B$3" } });
    await h.run({ type: "sheet.add", params: { name: "Notes" } });

    const back = workbookFromXlsx(await readXlsx(await writeXlsx(workbookToXlsx(wb))));
    const s = back.sheets[0].source;
    expect(back.sheets.map((x) => x.name)).toEqual(["Sales", "Notes"]);
    expect([s.getCell(1, 0), s.getCell(1, 1), s.getCell(2, 1), s.getCell(3, 1)]).toEqual(["North", 1200, 800.5, 2000.5]);
    expect(s.getEditText(3, 1)).toBe("=SUM(B2:B3)");
    expect(s.getStored(4, 0)).toBe(true);
    expect(s.getCell(5, 0)).toBe("#N/A");
    expect(s.getStyle(0, 0)).toEqual({ bold: true, fill: "#ffeeaa" });
    expect(s.getStyle(2, 1)?.numFmt).toBe("$#,##0.00");
    expect(s.merges).toEqual([R(7, 0, 7, 2)]);
    expect(s.columnWidths.get(0)).toBe(160);
    expect(s.frozen).toEqual({ rows: 1, cols: 0 });
    expect(back.getName("amounts")?.formula).toBe("Sales!$B$2:$B$3");
    // and the imported sheet saves and reopens as a .cellforge file
    const p = packWorkbook(back, back.sheets[0].id, "x");
    const again = await unpackWorkbook(JSON.parse(JSON.stringify(p.meta)), async (n) => p.files.get(n)!);
    expect(again.workbook.sheets[0].source.getCell(3, 1)).toBe(2000.5);
  });
});
