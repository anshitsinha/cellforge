/**
 * A run report as output: sections for the PDF writer, and HTML for the
 * preview (charts left as empty figures for the panel to draw into).
 * Pure: chart pictures come from a callback, so this is tested without a DOM.
 */
import { writeBook, type BookOptions, type BookSection, type FlowBlock, type PdfImage } from "@cellforge/core";
import type { RenderedBlock, RenderedReport } from "./engine";

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
export function toSection(r: RenderedReport, paint?: ChartPainter, opts: { showParams?: boolean } = {}): BookSection {
  const blocks: FlowBlock[] = [];
  for (const b of r.blocks) {
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
  const sections = reports.map((r) => toSection(r, paint, { showParams: opts.showParams ?? reports.length > 1 }));
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
export function reportHtml(reports: RenderedReport[]): string {
  const out: string[] = [];
  reports.forEach((r, ri) => {
    out.push(`<article class="report-page${ri ? " report-break" : ""}">`);
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
          out.push(`<table class="report-table">${b.title ? `<caption>${escapeHtml(b.title)}</caption>` : ""}${head}<tbody>${rows.join("")}</tbody></table>`);
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
