import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { appendLog } from "./evidence";
import { changedSince } from "./review";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "Bank rec", source: new EditableSource(new BlankSource(10, 3)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  return { workbook, h, sheet: workbook.sheets[0].source, id: workbook.sheets[0].id };
}

describe("review mode", () => {
  it("puts tick marks on a range and takes them off, undoably", async () => {
    const { h, sheet } = setup();
    await h.run({ type: "review.mark", params: { range: { top: 0, left: 0, bottom: 1, right: 1 }, mark: "agreed", on: true } });
    await h.run({ type: "review.mark", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, mark: "footed", on: true } });
    expect(sheet.extraAt(0, 0)?.marks).toEqual(["agreed", "footed"]);
    expect(sheet.extraAt(1, 1)?.marks).toEqual(["agreed"]);
    sheet.markLook = (id) => ({ glyph: id === "agreed" ? "✓" : "F", color: "#000000" });
    expect(sheet.getDisplayStyle(0, 0)?.marks).toEqual([{ glyph: "✓", color: "#000000" }, { glyph: "F", color: "#000000" }]);
    await h.run({ type: "review.mark", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, mark: "agreed", on: false } });
    expect(sheet.extraAt(0, 0)?.marks).toEqual(["footed"]);
    await h.undo();
    await h.undo();
    expect(sheet.extraAt(0, 0)?.marks).toEqual(["agreed"]);
    await expect(h.run({ type: "review.mark", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, mark: "nope", on: true } })).rejects.toThrow(/no tick mark/);
  });

  it("keeps review notes open until cleared, and open notes block sign-off", async () => {
    const { h, sheet, workbook, id } = setup();
    await h.run(setCells([{ row: 0, col: 0, input: "100" }]));
    await h.run({ type: "review.note", params: { row: 0, col: 0, text: "Agree to the bank letter", by: "RV" } });
    expect(sheet.openReviewNotes().length).toBe(1);
    expect(sheet.getDisplayStyle(0, 0)?.openReview).toBe(true);
    await h.run({ type: "review.signoff", params: { role: "prepared", by: "PR" } }).catch((e: Error) => expect(e.message).toMatch(/1 review note is still open/));
    expect(workbook.review.sheets[id]?.prepared).toBeUndefined();

    await h.run({ type: "review.note", params: { row: 0, col: 0, by: "PR", clear: true } });
    expect(sheet.openReviewNotes().length).toBe(0);
    expect(sheet.extraAt(0, 0)?.review?.cleared?.by).toBe("PR");
    await expect(h.run({ type: "review.signoff", params: { role: "reviewed", by: "RV" } })).rejects.toThrow(/prepared first/);
    await h.run({ type: "review.signoff", params: { role: "prepared", by: "PR" } });
    await h.run({ type: "review.signoff", params: { role: "reviewed", by: "RV" } });
    expect(workbook.review.sheets[id]).toMatchObject({ prepared: { by: "PR" }, reviewed: { by: "RV" } });
    await h.undo();
    expect(workbook.review.sheets[id]?.reviewed).toBeUndefined();
  });

  it("knows when a sheet changed after it was signed off", async () => {
    const { workbook } = setup();
    const log = workbook.evidence.log;
    await appendLog(log, { kind: "run", label: "edit", sheet: "Bank rec" });
    const sign = { by: "RV", at: Date.now(), logHash: log[0].hash, logLength: log.length };
    expect(changedSince(sign, log, "Bank rec")).toBe(0);
    await appendLog(log, { kind: "run", label: "edit", sheet: "Other" });
    await appendLog(log, { kind: "import", label: "read x.csv" });
    expect(changedSince(sign, log, "Bank rec")).toBe(0);
    await appendLog(log, { kind: "run", label: "edit", sheet: "Bank rec" });
    expect(changedSince(sign, log, "Bank rec")).toBe(1);
  });

  it("gives sheets workpaper references and saves review state", async () => {
    const { h, workbook, id, sheet } = setup();
    await h.run({ type: "review.ref", params: { ref: "B-3" } });
    await h.run({ type: "review.mark", params: { range: { top: 2, left: 1, bottom: 2, right: 1 }, mark: "traced", on: true } });
    expect(workbook.review.sheets[id].ref).toBe("B-3");
    const { packWorkbook, unpackWorkbook } = await import("./persist");
    const packed = packWorkbook(workbook, id, "Book");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(packed.meta)), async (n) => packed.files.get(n)!);
    expect(back.workbook.review.sheets[id].ref).toBe("B-3");
    expect(back.workbook.sheets[0].source.extraAt(2, 1)?.marks).toEqual(["traced"]);
    void sheet;
  });
});
