import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { attachDocument, checkLink, pdfPages, regionNumbers, regionText, type DocBytes } from "./docstore";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";
import { simplePdf, textContent } from "../../../packages/core/test/pdfbuild";

function memory(): DocBytes {
  const m = new Map<string, Uint8Array>();
  return { read: async (n) => m.get(n) ?? null, write: async (n, d) => void m.set(n, d) };
}

const statement = () =>
  simplePdf([
    textContent([
      [50, 60, "Bank letter"],
      [50, 100, "Balance at 31 March"],
      [400, 100, "1,234.50"],
      [50, 130, "Overdraft limit"],
      [400, 130, "(5,000.00)"],
    ]),
  ]);

describe("supporting documents", () => {
  it("are kept by fingerprint, once", async () => {
    const store = memory();
    const file = new File([statement() as BlobPart], "letter.pdf", { type: "application/pdf" });
    const a = await attachDocument(store, file);
    const b = await attachDocument(store, file);
    expect(a.sha256).toBe(b.sha256);
    expect(a).toMatchObject({ name: "letter.pdf", type: "application/pdf" });
  });

  it("read the text and numbers in a region of a PDF page", async () => {
    const store = memory();
    const meta = await attachDocument(store, new File([statement() as BlobPart], "letter.pdf", { type: "application/pdf" }));
    const [page] = await pdfPages(store, meta.sha256);
    // the right-hand column, from about 100 to 140 points down a 792-point page
    const region = { x: 0.6, y: 100 / 792 - 0.02, w: 0.35, h: 60 / 792 };
    expect(regionText(page, region)).toBe("1,234.50\n(5,000.00)");
    expect(regionNumbers(page, region)).toEqual([1234.5, -5000]);
  });

  it("link cells to evidence and check them", async () => {
    const store = memory();
    const workbook = new Workbook({ name: "Cash", source: new EditableSource(new BlankSource(5, 2)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const meta = await attachDocument(store, new File([statement() as BlobPart], "letter.pdf", { type: "application/pdf" }));
    await h.run({ type: "documents.set", params: { docs: [meta] } });
    await h.run(setCells([{ row: 0, col: 0, input: "1234.5" }, { row: 1, col: 0, input: "1243.5" }]));
    const link = { doc: meta.sha256, page: 1, region: { x: 0.6, y: 0.11, w: 0.35, h: 0.03 } };
    await h.run({ type: "evidence.link", params: { row: 0, col: 0, link } });
    await h.run({ type: "evidence.link", params: { row: 1, col: 0, link } });
    const sheet = workbook.sheets[0].source;
    expect(sheet.extraAt(0, 0)?.evidence).toEqual(link);
    expect((await checkLink(store, workbook.documents, link, sheet.getCell(0, 0))).status).toBe("agrees");
    expect(await checkLink(store, workbook.documents, link, sheet.getCell(1, 0))).toMatchObject({ status: "differs", found: [1234.5] });
    await h.undo();
    expect(sheet.extraAt(1, 0)).toBe(null);
    await expect(h.run({ type: "evidence.link", params: { row: 0, col: 1, link: { doc: "nope" } } })).rejects.toThrow(/isn't attached/);
  });
});
