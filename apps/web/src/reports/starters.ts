/**
 * Report starters: a ready report built for the sheet at hand, so nobody
 * starts from {{template}} syntax. Each starter picks the sheet's main
 * amount, its main category and its date (charts/defaults.ts) and lays out
 * headings, key figures, a summary table, a chart and the detail.
 *
 * Pure: give it the sheet's columns (readSheetColumns) and it returns a
 * Report that runs with runReport / runBook like any other.
 */
import { columnLetter } from "@cellforge/grid";
import type { DateGroup } from "@cellforge/core";
import { isIdLike, measureColumns, type ColumnInfo } from "../charts/defaults";
import type { SavedPivot } from "../charts/model";
import { pivotChartSpec } from "../charts/pivotspec";
import { quickInfos, type SheetColumns } from "../pivotpanel";
import { newId, newReport, type Report, type ReportBlock } from "./model";

export type StarterKind = "summary" | "close" | "entity" | "blank";

export interface Starter {
  kind: StarterKind;
  title: string;
  text: string;
}

export const STARTERS: readonly Starter[] = [
  { kind: "summary", title: "Summary pack", text: "Key figures, a table and a chart of the main amounts, then the detail." },
  { kind: "close", title: "Month-end pack", text: "A period on the cover, totals by month and by category, and room for review notes." },
  { kind: "entity", title: "One report per item", text: "The same report for every vendor, entity or cost centre, plus a consolidated one, in one PDF." },
  { kind: "blank", title: "Blank report", text: "Start with an empty page and add headings, text, tables and charts." },
];

/** The parts of a sheet the starters build on. */
export interface SheetFacts {
  sheetId: string;
  sheetName: string;
  names: string[];
  /** rows of data below the header */
  rows: number;
  /** the header is in row 1 of the sheet (not column names) */
  headerRow: boolean;
  amount: number | null;
  category: number | null;
  date: number | null;
}

/** What the starters need to know about a sheet. */
export function sheetFacts(sheetId: string, sheetName: string, data: SheetColumns | null): SheetFacts {
  if (!data || !data.columns.length) return { sheetId, sheetName, names: [], rows: 0, headerRow: true, amount: null, category: null, date: null };
  const infos: ColumnInfo[] = quickInfos(data);
  const amount = measureColumns(infos, 1)[0] ?? null;
  const category = infos.find((c) => c.kind === "text" && !isIdLike(c) && c.distinct < c.count && c.distinct <= 60)?.col ?? null;
  const date = infos.find((c) => c.kind === "date")?.col ?? null;
  return { sheetId, sheetName, names: data.names, rows: data.rows, headerRow: data.first === 1, amount, category, date };
}

const id = () => newId("b");
const heading = (text: string, level: 1 | 2 | 3 = 1): ReportBlock => ({ id: id(), kind: "heading", text, level });
const para = (text: string): ReportBlock => ({ id: id(), kind: "paragraph", text });

function pivotOf(f: SheetFacts, rows: number, group?: DateGroup, value = f.amount): SavedPivot {
  return {
    rows: [{ field: rows, ...(group ? { group } : {}) }],
    cols: [],
    values: [value === null ? { field: rows, agg: "count" } : { field: value, agg: "sum" }],
    filters: [],
    subtotals: false,
    grandTotals: true,
    names: f.names,
  };
}

function pivotTable(f: SheetFacts, rows: number, title: string, group?: DateGroup): ReportBlock {
  // the heading above says what it is, so no caption
  void title;
  return { id: id(), kind: "table", source: "pivot", sheetId: f.sheetId, pivot: pivotOf(f, rows, group), totals: true };
}

function pivotChart(f: SheetFacts, rows: number, title: string, group?: DateGroup): ReportBlock {
  const p = pivotOf(f, rows, group);
  // the chart has no grand total row: a total bar would dwarf the rest
  const spec = pivotChartSpec(newId("rchart"), f.sheetId, { ...p, grandTotals: false }, group ? "column" : "bar", title);
  return { id: id(), kind: "chart", spec, title };
}

/** The first rows of the sheet as a table, with the header. */
function detail(f: SheetFacts, max = 25): ReportBlock {
  const last = columnLetter(Math.max(0, f.names.length - 1));
  const bottom = Math.min(f.rows, max) + (f.headerRow ? 1 : 0);
  return { id: id(), kind: "table", source: "range", sheetId: f.sheetId, range: `A1:${last}${Math.max(1, bottom)}`, headerRow: true, title: f.rows > max ? `First ${max} of ${f.rows.toLocaleString("en-US")} lines` : "All lines" };
}

/** "Total Amount: {{=TEXT(SUM(F:F),"#,##0.00")}} across {{=…}} lines." */
function keyFigures(f: SheetFacts, where = ""): string {
  if (f.amount === null) return `${f.sheetName} has {{=TEXT(${f.rows},"#,##0")}} lines.`;
  const col = columnLetter(f.amount);
  const name = f.names[f.amount];
  if (!where) return `Total ${name}: {{=TEXT(SUM(${col}:${col}),"#,##0.00")}} across {{=TEXT(COUNT(${col}:${col}),"#,##0")}} lines.`;
  return `Total ${name}: {{=TEXT(SUMIFS(${col}:${col},${where}),"#,##0.00")}} across {{=TEXT(COUNTIFS(${where},${col}:${col},">-1E+300"),"#,##0")}} lines.`;
}

/** A starter report for the sheet. */
export function starterReport(kind: StarterKind, f: SheetFacts): Report {
  const r = newReport(f.sheetId, kind === "blank" ? "Report" : `${f.sheetName} ${kind === "close" ? "month-end pack" : kind === "entity" ? "by " + (f.category === null ? "item" : f.names[f.category]) : "summary"}`);
  if (kind === "blank" || !f.names.length) return r;
  const amount = f.amount === null ? "Lines" : f.names[f.amount];
  const blocks: ReportBlock[] = [];

  if (kind === "summary") {
    r.subtitle = `Prepared from ${f.sheetName}`;
    blocks.push(heading("Overview"), para(keyFigures(f)));
    if (f.category !== null) {
      const t = `${amount} by ${f.names[f.category]}`;
      blocks.push(heading(t, 2), pivotTable(f, f.category, t), pivotChart(f, f.category, t));
    } else if (f.date !== null) {
      const t = `${amount} by month`;
      blocks.push(heading(t, 2), pivotTable(f, f.date, t, "month"), pivotChart(f, f.date, t, "month"));
    }
    blocks.push({ id: id(), kind: "pageBreak" }, heading("Detail", 2), detail(f));
  } else if (kind === "close") {
    const now = new Date();
    r.params = [{ name: "period", value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}` }];
    r.title = "Month-end close pack";
    r.subtitle = `${f.sheetName}, period {{period}}`;
    blocks.push(heading("Summary"), para(keyFigures(f)));
    if (f.date !== null) {
      const t = `${amount} by month`;
      blocks.push(heading(t, 2), pivotTable(f, f.date, t, "month"), pivotChart(f, f.date, t, "month"));
    }
    if (f.category !== null) {
      const t = `${amount} by ${f.names[f.category]}`;
      blocks.push(heading(t, 2), pivotTable(f, f.category, t));
    }
    blocks.push({ id: id(), kind: "pageBreak" }, heading("Review notes", 2), para("Prepared by: ____________    Reviewed by: ____________"), heading("Detail", 2), detail(f));
  } else {
    const cat = f.category;
    if (cat === null) return starterReport("summary", f);
    const name = f.names[cat];
    const catCol = columnLetter(cat);
    const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    const param = /^[a-z_]/.test(slug) ? slug : "item";
    r.params = [{ name: param, value: "" }];
    r.runFor = { param, sheetId: f.sheetId, column: cat, consolidated: true, allLabel: "Consolidated" };
    r.title = `${f.sheetName} by ${name}`;
    blocks.push(heading(`{{${param}}}`), para(keyFigures(f, `${catCol}:${catCol},{${param}}`)));
    if (f.date !== null) {
      const t = `${amount} by month`;
      const table = pivotTable(f, f.date, t, "month");
      const chart = pivotChart(f, f.date, t, "month");
      blocks.push(heading(t, 2), { ...table, filter: { param, column: cat } } as ReportBlock, { ...chart, filter: { param, column: cat } } as ReportBlock);
    }
    // every line of the item (whole columns) on sheets small enough to scan per item
    const lines = f.rows <= 50_000 ? { ...detail(f), range: `A:${columnLetter(Math.max(0, f.names.length - 1))}` } : detail(f, 200);
    blocks.push(heading("Lines", 2), { ...lines, title: undefined, filter: { param, column: cat } } as ReportBlock);
  }
  r.blocks = blocks;
  return r;
}
