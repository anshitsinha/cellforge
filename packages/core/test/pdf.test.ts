import { describe, expect, it } from "vitest";
import { pageLines, readPdfText } from "../src";
import { deflate, pdf, simplePdf, stream, textContent } from "./pdfbuild";

const linesText = (lines: { text: string }[][]) => lines.map((l) => l.map((c) => c.text));

describe("reading PDF text", () => {
  it("reads text with positions and groups it into lines and columns", async () => {
    const content = textContent([
      [50, 50, "Statement"],
      [50, 100, "Date"],
      [150, 100, "Details"],
      [400, 100, "Balance"],
      [50, 115, "01/03/2024"],
      [150, 115, "Opening (brought forward)"],
      [400, 115, "1,000.00"],
    ]);
    const pages = await readPdfText(simplePdf([content]));
    expect(pages.length).toBe(1);
    expect(linesText(pageLines(pages[0]))).toEqual([["Statement"], ["Date", "Details", "Balance"], ["01/03/2024", "Opening (brought forward)", "1,000.00"]]);
    const first = pages[0].items[0];
    expect(Math.round(first.x)).toBe(50);
    expect(Math.round(first.y)).toBe(50);
  });

  it("reads compressed pages, in page order", async () => {
    const a = textContent([[50, 50, "Page one"]]);
    const b = textContent([[50, 50, "Page two"]]);
    const pages = await readPdfText(simplePdf([a, b], [await deflate(a), await deflate(b)]));
    expect(pages.map((p) => p.items.map((i) => i.text).join(" "))).toEqual(["Page one", "Page two"]);
  });

  it("joins pieces of one word and keeps spaced words in one cell", async () => {
    const content = "BT /F1 10 Tf 50 700 Td [(Amo) -10 (unt)] TJ ( due) Tj ET";
    const pages = await readPdfText(simplePdf([content]));
    expect(linesText(pageLines(pages[0]))).toEqual([["Amount due"]]);
  });

  it("decodes two-byte fonts through their ToUnicode map, from an object stream", async () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
      "1 begincodespacerange <0000> <FFFF> endcodespacerange",
      "2 beginbfchar <0001> <0054> <0002> <006F> endbfchar",
      "1 beginbfrange <0003> <0004> <0074> endbfrange",
      "endcmap end end",
    ].join("\n");
    // "Tott" -> codes 1 2 3 3 ; t=0x74 at code 3, u=0x75 at code 4
    const content = "BT /F1 12 Tf 72 700 Td <0001000200030003> Tj ET";
    // objects 4 (font) and 5 (descendant) live in an object stream (object 8)
    const font = "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>";
    const desc = "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 500 /W [1 [600 550] 3 4 300] >>";
    const header = `4 0 5 ${font.length + 1} `;
    const objstm = stream(`/Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode`, await deflate(header + font + "\n" + desc));
    const bytes = pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
      null,
      null,
      stream("", content),
      stream("", cmap),
      objstm,
    ]);
    const pages = await readPdfText(bytes);
    const item = pages[0].items[0];
    expect(item.text).toBe("Tott");
    // widths 600 550 300 300 at size 12 = 21 points
    expect(item.x2 - item.x).toBeCloseTo(21, 5);
  });

  it("says when a PDF is encrypted", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n");
    await expect(readPdfText(bytes)).rejects.toThrow(/password/);
  });
});
