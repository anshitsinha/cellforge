import { describe, expect, it } from "vitest";
import { pageLines, readPdfText } from "../src/pdf/read";
import { fitText, imageFromRgba, jpegInfo, layoutBook, looksNumeric, pageDimensions, PdfDocument, textWidth, winAnsi, wrapText, writeBook, type BookSection } from "../src/pdf/write";

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) <= eps;

describe("fonts and text", () => {
  it("measures text with the standard metrics", () => {
    // Helvetica: "H" 722, "i" 222
    expect(textWidth("Hi", "Helvetica", 10)).toBeCloseTo(9.44, 5);
    expect(textWidth("Hi", "Helvetica-Bold", 10)).toBeCloseTo(10, 5);
    expect(textWidth("Hi", "Times-Roman", 10)).toBeCloseTo(10, 5);
    expect(textWidth("Hi", "Courier", 10)).toBeCloseTo(12, 5);
    // accented letters are as wide as their letter
    expect(textWidth("é", "Helvetica", 10)).toBe(textWidth("e", "Helvetica", 10));
  });

  it("encodes WinAnsi, with ? for what it can't hold", () => {
    expect(winAnsi("A€é–")).toBe("A\x80\xe9\x96");
    expect(winAnsi("日本")).toBe("??");
  });

  it("wraps at spaces and splits words longer than a line", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", "Helvetica", 10, 60);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(textWidth(l, "Helvetica", 10)).toBeLessThanOrEqual(60);
    expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
    expect(wrapText("a\nb", "Helvetica", 10, 100)).toEqual(["a", "b"]);
    const long = wrapText("x".repeat(50), "Helvetica", 10, 50);
    expect(long.join("")).toBe("x".repeat(50));
  });

  it("cuts text to a width with an ellipsis", () => {
    const t = fitText("A long piece of text", "Helvetica", 10, 40);
    expect(t.endsWith("…")).toBe(true);
    expect(textWidth(t, "Helvetica", 10)).toBeLessThanOrEqual(40);
    expect(fitText("ok", "Helvetica", 10, 40)).toBe("ok");
  });

  it("knows numbers when it sees them", () => {
    for (const s of ["1,234.50", "(12)", "-5", "45%", "$1,000", "-", "1.5e3"]) expect(looksNumeric(s)).toBe(true);
    for (const s of ["East", "Q1 2024", "12 apples", ""]) expect(looksNumeric(s)).toBe(false);
  });

  it("has A4 and Letter, portrait and landscape", () => {
    expect(pageDimensions("A4")).toEqual([595.28, 841.89]);
    expect(pageDimensions("Letter", true)).toEqual([792, 612]);
  });
});

describe("PdfDocument", () => {
  it("writes text that reads back at the same place, compressed or not", async () => {
    for (const compress of [true, false]) {
      const doc = new PdfDocument({ title: "Test" });
      const p = doc.addPage("Letter");
      p.text(72, 100, "Hello (world) \\ back", { font: "Helvetica", size: 12 });
      p.text(300, 200, "Right", { font: "Times-Bold", size: 10, align: "right" });
      p.text(200, 300, "Café € – ok", { size: 10 });
      p.line(72, 110, 300, 110);
      p.rect(72, 120, 100, 20, { fill: "#eeeeee", stroke: "#000" });
      const bytes = await doc.save({ compress });
      const pages = await readPdfText(bytes);
      expect(pages).toHaveLength(1);
      expect(pages[0].width).toBe(612);
      expect(pages[0].height).toBe(792);
      const [a, b, c] = pages[0].items;
      expect(a.text).toBe("Hello (world) \\ back");
      expect(near(a.x, 72) && near(a.y, 100)).toBe(true);
      expect(a.x2).toBeCloseTo(72 + textWidth("Hello (world) \\ back", "Helvetica", 12), 2);
      expect(a.size).toBe(12);
      expect(b.text).toBe("Right");
      expect(b.x2).toBeCloseTo(300, 2);
      expect(near(b.y, 200)).toBe(true);
      expect(c.text).toBe("Café € – ok");
    }
  });

  it("puts each font and image in the file once, and the outline in the catalog", async () => {
    const doc = new PdfDocument();
    const img = imageFromRgba(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128]), 2, 1, false);
    expect(img.alpha).toBeDefined();
    const p1 = doc.addPage();
    const p2 = doc.addPage("A4", true);
    p1.text(50, 50, "one");
    p2.text(50, 50, "two", { font: "Helvetica-Bold" });
    p2.text(50, 80, "three");
    p1.image(img, 50, 100, 200, 100);
    p2.image(img, 50, 100, 200, 100);
    p2.image({ width: 1, height: 1, jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 3, 1, 0x11, 0, 0xff, 0xd9]) }, 0, 0, 10, 10);
    const top = doc.bookmark("First", 0);
    doc.bookmark("Under", 1, 80, top);
    doc.bookmark("Ünïcode", 1);
    const raw = latin1(await doc.save({ compress: false }));
    expect(raw.match(/\/BaseFont \/Helvetica /g)).toHaveLength(1);
    expect(raw.match(/\/BaseFont \/Helvetica-Bold/g)).toHaveLength(1);
    expect(raw.match(/\/Subtype \/Image/g)).toHaveLength(3); // two pictures and one soft mask
    expect(raw).toContain("/Filter /DCTDecode");
    expect(raw).toContain("/SMask");
    expect(raw).toMatch(/\/Outlines \d+ 0 R/);
    expect(raw).toContain("/Title (First)");
    expect(raw).toContain("/Title <FEFF00DC006E00EF");
    expect(raw).toMatch(/\/Count 3/);
    expect(raw).toMatch(/startxref\n\d+\n%%EOF\n$/);
    // the xref offsets point at the objects
    const xref = raw.slice(raw.indexOf("xref\n"));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(raw.startsWith(`${i + 1} 0 obj`, off)).toBe(true));
    const pages = await readPdfText(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
    expect(pages.map((p) => [p.width, p.height])).toEqual([
      [595.28, 841.89],
      [841.89, 595.28],
    ]);
    expect(pages[1].items.map((i) => i.text)).toEqual(["two", "three"]);
  });

  it("reads a JPEG's size", () => {
    expect(jpegInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 11, 8, 0, 20, 0, 30, 3]))).toEqual({ width: 30, height: 20, components: 3 });
    expect(jpegInfo(Uint8Array.from([1, 2, 3]))).toBeNull();
  });
});

describe("writeBook", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ cells: [`Item ${i + 1}`, (i * 1000.5).toLocaleString("en-US", { minimumFractionDigits: 2 })] }));

  it("lays out a report: title, heading, wrapped paragraph and a table with numbers on the right", async () => {
    const sec: BookSection = {
      title: "Monthly report",
      subtitle: "North, March 2026",
      blocks: [
        { kind: "heading", text: "Summary" },
        { kind: "paragraph", text: "Revenue rose 12% on the month. ".repeat(10) },
        { kind: "table", columns: [{ header: "Account" }, { header: "Amount" }], rows: [...rows(3), { cells: ["Total", "3,001.50"], bold: true }] },
      ],
    };
    const bytes = await writeBook([sec], { size: "A4", compress: false });
    const [page] = await readPdfText(bytes);
    const texts = page.items.map((i) => i.text);
    expect(texts[0]).toBe("Monthly report");
    expect(texts).toContain("North, March 2026");
    expect(texts).toContain("Summary");
    expect(texts).toContain("Page 1 of 1");
    // the paragraph wrapped onto several lines inside the margins
    const para = page.items.filter((i) => i.text.startsWith("Revenue") || i.text.includes("rose"));
    expect(para.length).toBeGreaterThan(2);
    for (const it of para) expect(it.x2).toBeLessThanOrEqual(595.28 - 50 + 0.01);
    // table: numbers right-aligned to one edge, labels left-aligned to another
    const amounts = page.items.filter((i) => /^\d[\d,]*\.\d\d$/.test(i.text));
    expect(amounts.length).toBe(4);
    const right = amounts[0].x2;
    for (const a of amounts) expect(a.x2).toBeCloseTo(right, 2);
    const labels = page.items.filter((i) => /^Item \d$|^Total$|^Account$/.test(i.text));
    for (const l of labels) expect(l.x).toBeCloseTo(labels[0].x, 2);
    const lines = pageLines(page);
    expect(lines.some((l) => l.map((c) => c.text).join("|") === "Item 2|1,000.50")).toBe(true);
  });

  it("carries a long table over pages with the header repeated", async () => {
    const bytes = await writeBook([{ title: "Long", blocks: [{ kind: "table", columns: [{ header: "Name" }, { header: "Value" }], rows: rows(120) }] }], { size: "Letter" });
    const pages = await readPdfText(bytes);
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) {
      const t = p.items.map((i) => i.text);
      expect(t).toContain("Name");
      expect(t).toContain("Value");
      expect(t).toContain(`Page ${pages.indexOf(p) + 1} of ${pages.length}`);
    }
    // every row exactly once, in order
    const items = pages.flatMap((p) => p.items.map((i) => i.text)).filter((t) => /^Item \d+$/.test(t));
    expect(items).toEqual(rows(120).map((r) => r.cells[0]));
    // the header sits at the same place on every page
    const headY = pages.map((p) => p.items.find((i) => i.text === "Name")!.y);
    expect(headY[2]).toBeCloseTo(headY[1], 2);
  });

  it("makes a book: a contents page with the right page numbers, and bookmarks", async () => {
    const sections: BookSection[] = ["North", "South", "East"].map((e) => ({
      title: `Report: ${e}`,
      blocks: [{ kind: "heading", text: `${e} detail` }, { kind: "table", columns: [{ header: "Name" }, { header: "Value" }], rows: rows(e === "North" ? 80 : 5) }, { kind: "pageBreak" }, { kind: "heading", text: `${e} notes`, level: 2 }, { kind: "paragraph", text: "Notes." }],
    }));
    const { doc, contents } = await layoutBook(sections, { title: "Book" });
    const bytes = await doc.save();
    const pages = await readPdfText(bytes);
    expect(pages[0].items[0].text).toBe("Contents");
    // each entry says the page its title is on
    for (const e of contents) {
      const target = pages[e.page];
      expect(target.items.some((i) => i.text === e.title)).toBe(true);
      const line = pageLines(pages[0]).find((l) => l[0].text.startsWith(e.title));
      expect(line, e.title).toBeDefined();
      expect(line![line!.length - 1].text).toMatch(new RegExp(`(^|[ .])${e.page + 1}$`));
    }
    expect(contents.filter((e) => e.level === 0).map((e) => e.title)).toEqual(["Report: North", "Report: South", "Report: East"]);
    // North's table runs over two pages, so South starts later
    const north = contents.find((e) => e.title === "Report: North")!;
    const south = contents.find((e) => e.title === "Report: South")!;
    expect(south.page - north.page).toBeGreaterThanOrEqual(3);
    const raw = latin1(bytes);
    expect(raw).toContain("/PageMode /UseOutlines");
    expect(doc.outline.map((o) => o.title)).toEqual(["Contents", "Report: North", "Report: South", "Report: East"]);
    // a level-2 heading sits under the level-1 heading before it
    expect(doc.outline[1].children.map((c) => c.title)).toEqual(["North detail"]);
    expect(doc.outline[1].children[0].children.map((c) => c.title)).toEqual(["North notes"]);
  });

  it("puts images in the flow, scaled to the page width", async () => {
    const px = new Uint8ClampedArray(4 * 40 * 20).fill(200);
    const img = imageFromRgba(px, 40, 20);
    const { doc } = await layoutBook([{ title: "Pic", blocks: [{ kind: "image", image: img, caption: "A chart" }, { kind: "paragraph", text: "After" }] }], { contents: false });
    const ops = doc.pages[0].ops.join("\n");
    expect(ops).toMatch(/q 495\.28 0 0 247\.64 50 [\d.]+ cm \/Im1 Do Q/);
    const pages = await readPdfText(await doc.save());
    const cap = pages[0].items.find((i) => i.text === "A chart")!;
    const after = pages[0].items.find((i) => i.text === "After")!;
    expect(after.y).toBeGreaterThan(cap.y);
    expect(cap.y).toBeGreaterThan(247);
  });
});
