import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { cellLink, resolvePlace, safeLink } from "./links";
import { Workbook } from "./workbook";

async function setup() {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(10, 4)) });
  workbook.add("Data 2", new EditableSource(new BlankSource(10, 4)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async (s, col, desc) => {
    const rows = Array.from({ length: s.rowCount }, (_, i) => i);
    rows.sort((a, b) => {
      const x = s.getCell(a, col);
      const y = s.getCell(b, col);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * (desc ? -1 : 1);
    });
    return Uint32Array.from(rows);
  } };
  const h = new ActionHistory(sheetActions(), () => ctx);
  return { workbook, h, sheet: workbook.sheets[0].source };
}

describe("notes and links", () => {
  it("are undoable, follow their row through a sort and their column through inserts, and are saved", async () => {
    const { h, sheet } = await setup();
    await h.run(setCells([{ row: 0, col: 0, input: "3" }, { row: 1, col: 0, input: "1" }, { row: 2, col: 0, input: "2" }]));
    await h.run({ type: "cells.extra", params: { row: 0, col: 0, note: "checked with the bank" } });
    await h.run({ type: "cells.extra", params: { row: 1, col: 1, link: "https://example.com" } });
    expect(sheet.extraAt(0, 0)).toEqual({ note: "checked with the bank" });
    expect(sheet.getDisplayStyle(1, 1)?.underline).toBe(true);
    expect(sheet.hasUserNote(0, 0)).toBe(true);

    await h.run({ type: "rows.sort", params: { col: 0 } });
    // the 3 moved to the bottom, its note with it
    expect(sheet.getCell(2, 0)).toBe(3);
    expect(sheet.extraAt(2, 0)?.note).toBe("checked with the bank");
    expect(sheet.extraAt(0, 1)?.link).toBe("https://example.com");

    await h.run({ type: "cols.insert", params: { at: 0, count: 1 } });
    expect(sheet.extraAt(2, 1)?.note).toBe("checked with the bank");
    await h.run({ type: "cols.delete", params: { at: 1, count: 1 } });
    expect(sheet.allExtras().map((x) => x.extra)).toEqual([{ link: "https://example.com" }]);
    await h.undo();
    expect(sheet.extraAt(2, 1)?.note).toBe("checked with the bank");

    const { state, binary } = sheet.toState();
    const back = EditableSource.fromState(new BlankSource(10, 4), 0, JSON.parse(JSON.stringify(state)), binary);
    expect(back.allExtras().length).toBe(2);

    await h.run({ type: "cells.extra", params: { row: 2, col: 1, note: null } });
    expect(sheet.extraAt(2, 1)).toBe(null);
    await h.undo();
    expect(sheet.extraAt(2, 1)?.note).toBe("checked with the bank");
  });

  it("only allows safe links", async () => {
    const { h } = await setup();
    expect([safeLink("https://a.b/c"), safeLink("mailto:x@y.z"), safeLink("#Sheet1!A1"), safeLink("javascript:alert(1)"), safeLink("data:text/html,x")]).toEqual([true, true, true, false, false]);
    await expect(h.run({ type: "cells.extra", params: { row: 0, col: 0, link: "javascript:alert(1)" } })).rejects.toThrow(/web addresses/);
  });

  it("finds places in the workbook and HYPERLINK addresses", async () => {
    const { h, workbook, sheet } = await setup();
    const active = workbook.sheets[0].id;
    expect(resolvePlace(workbook, active, "#'Data 2'!C5")).toEqual({ sheetId: workbook.sheets[1].id, row: 4, col: 2 });
    expect(resolvePlace(workbook, active, "#B2")).toEqual({ sheetId: active, row: 1, col: 1 });
    expect(resolvePlace(workbook, active, "#Nowhere!A1")).toBe(null);
    await h.run(setCells([{ row: 3, col: 0, input: '=HYPERLINK("https://example.com/" & "x", "site")' }]));
    expect(sheet.getCell(3, 0)).toBe("site");
    expect(cellLink(sheet, 3, 0)).toBe("https://example.com/x");
  });
});
