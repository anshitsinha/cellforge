import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { appendLog } from "./evidence";
import { changedSince, onSignOffUndo, type SignOffUndo } from "./review";
import { signedWhen } from "./reviewui";
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

  it("signing off doesn't count as a change since signing off (the app logs the sign-off itself after it runs)", async () => {
    const { h, workbook, id } = setup();
    const log = workbook.evidence.log;
    // as the app does: run the action, then log it (with the action) a moment later
    const run = async (a: { type: string; params: Record<string, unknown> }) => {
      await h.run(a);
      await appendLog(log, { kind: "run", label: sheetActions().describe(a), sheet: "Bank rec", action: a });
    };
    await run(setCells([{ row: 0, col: 0, input: "100" }]));
    await run({ type: "review.signoff", params: { role: "prepared", by: "PR" } });
    const prepared = workbook.review.sheets[id].prepared!;
    expect(changedSince(prepared, log, "Bank rec")).toBe(0);
    // review work after it isn't a change either
    await run({ type: "review.mark", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, mark: "agreed", on: true } });
    await run({ type: "review.ref", params: { ref: "B-1" } });
    await appendLog(log, { kind: "undo", label: "tick agreed" });
    expect(changedSince(prepared, log, "Bank rec")).toBe(0);
    // an edit is
    await run(setCells([{ row: 1, col: 0, input: "5" }]));
    expect(changedSince(prepared, log, "Bank rec")).toBe(1);
    await appendLog(log, { kind: "undo", label: "edit B2" });
    expect(changedSince(prepared, log, "Bank rec")).toBe(2);
  });

  it("an edit logged late (after the sign-off read the log) still counts once, by the sign-off's hash", async () => {
    const { workbook } = setup();
    const log = workbook.evidence.log;
    await appendLog(log, { kind: "run", label: "edit", sheet: "Bank rec" });
    // signed while the next entry was still being written: logLength says 1, the hash names entry 0
    const sign = { by: "PR", at: Date.now(), logHash: log[0].hash, logLength: 2 };
    await appendLog(log, { kind: "run", label: "edit", sheet: "Bank rec" });
    expect(changedSince(sign, log, "Bank rec")).toBe(1);
  });

  it("says when undo takes a sign-off away, and when redo puts it back", async () => {
    const { h } = setup();
    const heard: SignOffUndo[] = [];
    const stop = onSignOffUndo((e) => heard.push(e));
    await h.run({ type: "review.signoff", params: { role: "prepared", by: "PR" } });
    expect(heard).toEqual([]);
    await h.undo();
    await h.redo();
    stop();
    expect(heard).toEqual([
      { sheet: "Bank rec", role: "prepared", by: "PR", removed: true },
      { sheet: "Bank rec", role: "prepared", by: "PR", removed: false },
    ]);
  });

  it("shows sign-off times the same way in every locale", () => {
    const at = new Date(2026, 10, 17, 1, 44).getTime();
    expect(signedWhen(at, at)).toBe("17 Nov, 01:44");
    expect(signedWhen(at, new Date(2027, 0, 2).getTime())).toBe("17 Nov 2026, 01:44");
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
