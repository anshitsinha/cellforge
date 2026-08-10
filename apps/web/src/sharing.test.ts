import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { appendLog } from "./evidence";
import { packWorkbook, toFile, fromFile } from "./persist";
import { clearLocalData, decryptFile, encryptFile, isEncrypted, shareCheck } from "./sharing";
import { Workbook } from "./workbook";

describe("before you share", () => {
  it("finds hidden sheets and rows, notes, links, personal data and history", async () => {
    const workbook = new Workbook({ name: "People", source: new EditableSource(new BlankSource(10, 3)) });
    workbook.add("Workings", new EditableSource(new BlankSource(5, 2)), undefined, undefined, { hidden: true });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells([
      { row: 0, col: 0, input: "Name" }, { row: 0, col: 1, input: "Email" },
      { row: 1, col: 0, input: "Ann Lee" }, { row: 1, col: 1, input: "ann@example.com" },
      { row: 2, col: 0, input: "Bob Roe" }, { row: 2, col: 1, input: "bob@example.org" },
    ]));
    await h.run({ type: "rows.hide", params: { at: 2, hidden: true } });
    await h.run({ type: "cells.extra", params: { row: 1, col: 0, note: "VIP" } });
    await h.run({ type: "cells.extra", params: { row: 1, col: 1, link: "https://example.com" } });
    await appendLog(workbook.evidence.log, { kind: "run", label: "edit" });
    const kinds = shareCheck(workbook).map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["hidden sheet", "hidden rows", "notes", "links", "personal data", "history"]));
    const history = shareCheck(workbook).find((f) => f.kind === "history")!;
    expect(history.carriedBy).toEqual(["cellforge"]); // not in Excel or CSV exports
    expect(shareCheck(new Workbook({ name: "S", source: new EditableSource(new BlankSource(3, 3)) }))).toEqual([]);
  });
});

describe("password-protected files", () => {
  it("round-trip a workbook, and refuse the wrong password", async () => {
    const wb = new Workbook({ name: "Secret", source: new EditableSource(new BlankSource(3, 2)) });
    const bytes = new Uint8Array(await toFile(packWorkbook(wb, wb.sheets[0].id, "Secret")).arrayBuffer());
    const locked = await encryptFile(bytes, "correct horse");
    expect(isEncrypted(locked)).toBe(true);
    expect(isEncrypted(bytes)).toBe(false);
    expect(new TextDecoder().decode(locked).includes("Secret")).toBe(false);
    const back = await decryptFile(locked, "correct horse");
    expect(back).toEqual(bytes);
    expect(fromFile(back.buffer.slice(back.byteOffset, back.byteOffset + back.byteLength) as ArrayBuffer).meta.name).toBe("Secret");
    await expect(decryptFile(locked, "wrong password")).rejects.toThrow(/doesn't open/);
    await expect(encryptFile(bytes, "short")).rejects.toThrow(/8 characters/);
  });
});

describe("clearing local data", () => {
  it("removes everything in the store", async () => {
    const names = new Set(["autosave.json", "journal.ndjson", "versions/1.bin"]);
    const n = await clearLocalData({ list: async () => [...names], remove: async (x) => void names.delete(x) });
    expect(names.size).toBe(0);
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
