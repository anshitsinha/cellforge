/**
 * Supporting documents for a workbook: PDFs and images attached as
 * evidence, kept in the browser's private storage under their SHA-256 (not
 * inside the workbook file, which stays small), and cells linked to a place
 * in them: a PDF page and region, or an image region. A link to a region of
 * a text PDF can be checked: the number printed there against the cell.
 */
import { pageLines, parseNumberLoose, readPdfText, type PdfPage } from "@cellforge/core";
import { sha256Hex } from "./evidence";

export interface DocMeta {
  sha256: string;
  name: string;
  size: number;
  type: string;
  at: number;
}

/** A region as fractions of the page (0–1), so it doesn't depend on zoom. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EvidenceLink {
  doc: string;
  /** PDF page, from 1 */
  page?: number;
  region?: Region;
}

/** Where documents' bytes live (the app passes its browser store; tests a memory one). */
export interface DocBytes {
  read(name: string): Promise<Uint8Array | ArrayBuffer | string | null>;
  write(name: string, data: Uint8Array): Promise<void>;
}

const key = (sha: string) => `docs/${sha}`;

/** Keep a file and return what the workbook records about it. Same bytes = same document. */
export async function attachDocument(store: DocBytes, file: File): Promise<DocMeta> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (!(await store.read(key(sha256)))) await store.write(key(sha256), bytes);
  return { sha256, name: file.name, size: file.size, type: file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "application/octet-stream"), at: Date.now() };
}

export async function documentBytes(store: DocBytes, sha256: string): Promise<Uint8Array | null> {
  const d = await store.read(key(sha256));
  if (d === null) return null;
  return typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d);
}

const pdfCache = new Map<string, Promise<PdfPage[]>>();

/** A PDF's pages (cached per document). */
export function pdfPages(store: DocBytes, sha256: string): Promise<PdfPage[]> {
  let p = pdfCache.get(sha256);
  if (!p) {
    p = documentBytes(store, sha256).then((b) => {
      if (!b) throw new Error("That document isn't in this browser's storage any more.");
      return readPdfText(b);
    });
    pdfCache.set(sha256, p);
  }
  return p;
}

/** The text inside a region of a PDF page, line by line. */
export function regionText(page: PdfPage, r: Region): string {
  const inside = {
    ...page,
    items: page.items.filter((it) => {
      const cx = (it.x + it.x2) / 2 / page.width;
      const cy = (it.y - it.size * 0.3) / page.height;
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    }),
  };
  return pageLines(inside)
    .map((cells) => cells.map((c) => c.text).join(" "))
    .join("\n");
}

/** The numbers printed in a region (accounting brackets, thousands separators and CR / DR understood). */
export function regionNumbers(page: PdfPage, r: Region): number[] {
  const text = regionText(page, r);
  const out: number[] = [];
  for (const m of text.matchAll(/\(?-?[\d][\d,.' ]*\d(?:\.\d+)?\)?(?:\s?(?:CR|DR))?|\(?-?\d\)?/gi)) {
    const v = parseNumberLoose(m[0].trim());
    if (v !== null) out.push(v);
  }
  return out;
}

export type LinkCheck = { status: "agrees" | "differs" | "no number" | "not checkable"; found?: number[]; text?: string };

/** Does the cell's value appear in the linked region? */
export async function checkLink(store: DocBytes, docs: readonly DocMeta[], link: EvidenceLink, value: unknown): Promise<LinkCheck> {
  const meta = docs.find((d) => d.sha256 === link.doc);
  if (!meta || meta.type !== "application/pdf" || !link.region || !link.page) return { status: "not checkable" };
  const pages = await pdfPages(store, link.doc);
  const page = pages[link.page - 1];
  if (!page) return { status: "not checkable" };
  const found = regionNumbers(page, link.region);
  const text = regionText(page, link.region);
  if (!found.length) return { status: "no number", text };
  if (typeof value !== "number") return { status: "differs", found, text };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
  return { status: found.some((f) => near(f, value) || near(Math.abs(f), Math.abs(value))) ? "agrees" : "differs", found, text };
}
