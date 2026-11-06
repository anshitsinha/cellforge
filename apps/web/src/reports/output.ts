/**
 * A run report as output: sections for the PDF writer, and HTML for the
 * preview (charts left as empty figures for the panel to draw into).
 * Pure: chart pictures come from a callback, so this is tested without a DOM.
 */
import { PAGE_SIZES, textWidth, writeBook, type BookOptions, type BookSection, type FlowBlock, type PdfImage } from "@cellforge/core";
import type { RenderedBlock, RenderedReport } from "./engine";

// ---------------------------------------------------------- fit the page --

/** Page margin of the PDF writer, in points. */
const MARGIN = 50;
/** Table text size: normal, and compact for wide tables. */
export const TABLE_PT = 9;
export const COMPACT_PT = 7.5;

type TableBlock = Extract<RenderedBlock, { kind: "table" }>;

/** The width a table wants at `size` points, the way the PDF writer measures it (headers wrap at words). */
export function tableWidth(b: Pick<TableBlock, "headers" | "rows">, size = TABLE_PT): number {
  const pad = size * 0.45;
  let total = 0;
  b.headers.forEach((h, j) => {
    let w = Math.max(0, ...h.split(/\s+/).map((word) => textWidth(word, "Helvetica-Bold", size)));
    for (const r of b.rows) w = Math.max(w, textWidth(r.cells[j] ?? "", r.bold ? "Helvetica-Bold" : "Helvetica", size));
    total += w + 2 * pad;
  });
  return total;
}

export interface PageFit {
  /** print landscape (asked for, or turned automatically) */
  landscape: boolean;
  /** turned to landscape because a table didn't fit across */
  auto: boolean;
  /** tables ("report:block") printed in the smaller size */
  compact: Set<string>;
  /** tables still wider than the page: their columns are squeezed */
  squeezed: Set<string>;
  /** one sentence for the preview, or "" */
  note: string;
}

/**
 * How the reports fit the paper: a table too wide for a portrait page is
 * first set smaller, then the page turns to landscape (unless landscape was
 * already chosen), and only then are its columns squeezed. Nothing is cut
 * off at the page edge.
 */
export function fitPage(reports: readonly RenderedReport[], page: { size: "A4" | "Letter"; landscape: boolean } = { size: "A4", landscape: false }): PageFit {
  const [pw, ph] = PAGE_SIZES[page.size];
  const across = (landscape: boolean) => (landscape ? ph : pw) - 2 * MARGIN;
  const tables: { key: string; normal: number; compact: number }[] = [];
  reports.forEach((r, ri) =>
    r.blocks.forEach((b, bi) => {
      if (b.kind === "table" && b.headers.length) tables.push({ key: `${ri}:${bi}`, normal: tableWidth(b), compact: tableWidth(b, COMPACT_PT) });
    }),
  );
  const widest = Math.max(0, ...tables.map((t) => t.compact));
  const auto = !page.landscape && widest > across(false);
  const landscape = page.landscape || auto;
  const room = across(landscape);
  const compact = new Set(tables.filter((t) => t.normal > room).map((t) => t.key));
  const squeezed = new Set(tables.filter((t) => t.compact > room).map((t) => t.key));
  const note = squeezed.size
    ? `${squeezed.size === 1 ? "A table is" : `${squeezed.size} tables are`} wider than the page even in landscape, so long text is cut short. Show fewer columns to fit.`
    : auto
      ? "Printed in landscape so every column of the widest table fits."
      : "";
  return { landscape, auto, compact, squeezed, note };
}

/** A chart block that has data. */
export type ChartBlock = Extract<RenderedBlock, { kind: "chart"; data: unknown }>;

/** Draws a chart as a picture of w x h points (the browser uses a canvas). */
export type ChartPainter = (block: ChartBlock, w: number, h: number) => PdfImage | null;

/** Chart size in a PDF, in points (scaled down to the page width if wider). */
export const PDF_CHART = { w: 480, h: 270 };

/** The parameter values of a run, as a line under the title ("entity: North · period: 2026-03"). */
export function paramLine(r: RenderedReport): string {
  return Object.entries(r.params)
    .map(([k, v]) => `${k}: ${v.label ?? (v.all ? "All" : v.value)}`)
    .join(" · ");
}

/** One report as a section of a PDF book. */
export function toSection(r: RenderedReport, paint?: ChartPainter, opts: { showParams?: boolean; compact?: (blockIndex: number) => boolean } = {}): BookSection {
  const blocks: FlowBlock[] = [];
  for (const [bi, b] of r.blocks.entries()) {
    switch (b.kind) {
      case "heading":
        blocks.push({ kind: "heading", text: b.text, level: b.level });
        break;
      case "paragraph":
        if (b.text.trim()) blocks.push({ kind: "paragraph", text: b.text });
        break;
      case "pageBreak":
        blocks.push({ kind: "pageBreak" });
        break;
      case "error":
        blocks.push({ kind: "paragraph", text: `[${b.text}]`, italic: true, color: [0.7, 0.1, 0.1] });
        break;
      case "table":
        blocks.push({
          kind: "table",
          columns: b.headers.map((h, j) => ({ header: h, align: b.align[j] })),
          rows: b.rows.map((row) => ({ cells: row.cells, ...(row.bold ? { bold: true } : {}) })),
          ...(b.title ? { caption: b.title } : {}),
          ...(opts.compact?.(bi) ? { size: COMPACT_PT } : {}),
        });
        if (b.note) blocks.push({ kind: "paragraph", text: b.note, italic: true, size: 8 });
        break;
      case "chart": {
        if ("error" in b) {
          blocks.push({ kind: "paragraph", text: `[Chart${b.title ? ` "${b.title}"` : ""}: ${b.error}]`, italic: true, color: [0.7, 0.1, 0.1] });
          break;
        }
        const img = paint?.(b, PDF_CHART.w, PDF_CHART.h);
        if (img) blocks.push({ kind: "image", image: img, width: PDF_CHART.w, ...(b.data.notes.length ? { caption: b.data.notes.join(" ") } : {}) });
        else blocks.push({ kind: "paragraph", text: `[Chart: ${b.title || "untitled"}]`, italic: true });
        break;
      }
    }
  }
  const subtitle = [r.subtitle, opts.showParams ? paramLine(r) : ""].filter(Boolean).join(" — ");
  return { title: r.title || "Report", ...(subtitle ? { subtitle } : {}), blocks };
}

/** A PDF of one or more run reports (a report book gets a contents page). */
export function reportPdf(reports: RenderedReport[], opts: BookOptions & { showParams?: boolean } = {}, paint?: ChartPainter): Promise<Uint8Array> {
  const fit = fitPage(reports, { size: opts.size === "Letter" ? "Letter" : "A4", landscape: !!opts.landscape });
  const sections = reports.map((r, ri) => toSection(r, paint, { showParams: opts.showParams ?? reports.length > 1, compact: (bi) => fit.compact.has(`${ri}:${bi}`) }));
  opts = { ...opts, landscape: fit.landscape };
  // the same title for every entity reads badly in the contents: add the entity
  if (reports.length > 1 && new Set(sections.map((s) => s.title)).size < sections.length) {
    sections.forEach((s, i) => {
      const values = Object.values(reports[i].params).map((v) => v.label ?? (v.all ? "All" : v.value));
      if (values.length) s.title = `${s.title} — ${values.join(", ")}`;
    });
  }
  return writeBook(sections, { contents: reports.length > 1, ...opts });
}

// -------------------------------------------------------------------- HTML --

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Reports as HTML for the preview. Chart blocks become
 * <figure class="report-chart" data-chart="report index:block index"> for
 * the panel to draw into.
 */
export function reportHtml(reports: RenderedReport[], fit?: PageFit): string {
  const out: string[] = [];
  reports.forEach((r, ri) => {
    out.push(`<article class="report-page${fit?.landscape ? " report-page--landscape" : ""}${ri ? " report-break" : ""}">`);
    out.push(`<h1>${escapeHtml(r.title || "Report")}</h1>`);
    const sub = [r.subtitle, reports.length > 1 ? paramLine(r) : ""].filter(Boolean).join(" — ");
    if (sub) out.push(`<p class="report-subtitle">${escapeHtml(sub)}</p>`);
    r.blocks.forEach((b, bi) => {
      switch (b.kind) {
        case "heading": {
          const h = b.level + 1;
          out.push(`<h${h}>${escapeHtml(b.text)}</h${h}>`);
          break;
        }
        case "paragraph":
          if (b.text.trim()) out.push(`<p>${escapeHtml(b.text).replace(/\n/g, "<br>")}</p>`);
          break;
        case "pageBreak":
          out.push(`<div class="report-pagebreak" aria-hidden="true"></div>`);
          break;
        case "error":
          out.push(`<p class="report-error">${escapeHtml(b.text)}</p>`);
          break;
        case "table": {
          const cls = (j: number) => (b.align[j] === "right" ? ' class="num"' : "");
          const rows = b.rows.map((row) => `<tr${row.bold ? ' class="total"' : ""}>${row.cells.map((c, j) => `<td${cls(j)}>${escapeHtml(c)}</td>`).join("")}</tr>`);
          const head = b.headers.some((h) => h) ? `<thead><tr>${b.headers.map((h, j) => `<th${cls(j)}>${escapeHtml(h)}</th>`).join("")}</tr></thead>` : "";
          const key = `${ri}:${bi}`;
          const size = fit?.squeezed.has(key) ? " report-table--compact report-table--squeeze" : fit?.compact.has(key) ? " report-table--compact" : "";
          out.push(`<table class="report-table${size}">${b.title ? `<caption>${escapeHtml(b.title)}</caption>` : ""}${head}<tbody>${rows.join("")}</tbody></table>`);
          if (b.note) out.push(`<p class="report-note">${escapeHtml(b.note)}</p>`);
          break;
        }
        case "chart":
          if ("error" in b) out.push(`<p class="report-error">${escapeHtml(`Chart${b.title ? ` "${b.title}"` : ""}: ${b.error}`)}</p>`);
          else {
            const notes = b.data.notes.length ? `<figcaption>${escapeHtml(b.data.notes.join(" "))}</figcaption>` : "";
            out.push(`<figure class="report-chart" data-chart="${ri}:${bi}" role="img" aria-label="${escapeHtml(b.title || "Chart")}"></figure>${notes}`);
          }
          break;
      }
    });
    if (r.warnings.length) out.push(`<aside class="report-warnings"><b>Check:</b><ul>${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul></aside>`);
    out.push("</article>");
  });
  return out.join("\n");
}
