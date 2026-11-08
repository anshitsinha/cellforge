/**
 * Report starters: a ready report built for the sheet at hand, so nobody
 * starts from {{template}} syntax. Each starter picks the sheet's main
 * amount, its main category and its date (charts/defaults.ts) and lays out
 * headings, key figures, a summary table, a chart and the detail.
 *
 * It reads the sheet first, so the content means something:
 * - a flux or trial balance sheet (a Flag column, or amounts that net to
 *   nothing) starts with the movements flagged for explanation and totals
 *   by report line, never a headline total of 0.00;
 * - the category is a grouping column (Report line, Category…), never the
 *   flag or the notes, and blank categories are left out;
 * - the period comes from the data's dates (or a month named in the
 *   workbook), else the month just ended.
 *
 * Pure: give it the sheet's columns (readSheetColumns) and it returns a
 * Report that runs with runReport / runBook like any other.
 */
import { columnLetter } from "@cellforge/grid";
import type { DateGroup, PivotAgg } from "@cellforge/core";
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

/** A month: "2026-10" and "October 2026". */
export interface Period {
  key: string;
  label: string;
}

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
  /** the amounts net to nothing (a balanced journal): summaries count lines instead */
  balanced?: boolean;
  /** the amount columns worth totalling (This month, Last month, Change…), main one first */
  measures?: number[];
  /** a column that flags lines for attention (Flag: "Explain"), and its flag value */
  flag?: number | null;
  flagValue?: string;
  /** the column where explanations or notes go */
  note?: number | null;
  /** the category's values, when some rows have none (the summaries leave the blanks out) */
  categoryValues?: string[];
  /** the month the data is for */
  period?: Period;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const periodOf = (y: number, m: number): Period => ({ key: `${y}-${String(m + 1).padStart(2, "0")}`, label: `${MONTHS[m]} ${y}` });

/**
 * The month a sheet is for: the month of its latest date; else a month named
 * in the hints ("October 2026", "Oct-26", "2026-10"); else the month just
 * ended (a close pack is prepared after month end).
 */
export function inferPeriod(dates: ArrayLike<number> | null, texts: readonly string[] = [], today = new Date()): Period {
  if (dates) {
    let max = -Infinity;
    for (let i = 0; i < dates.length; i++) if (dates[i] > max && dates[i] < 2_958_466) max = dates[i];
    if (Number.isFinite(max) && max > 0) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(max) * 86_400_000);
      return periodOf(d.getUTCFullYear(), d.getUTCMonth());
    }
  }
  const named = new RegExp(`\\b(${[...MONTHS, "Sept", ...MONTHS.map((m) => m.slice(0, 3))].join("|")})\\.?[\\s\\-'’]+(\\d{4}|\\d{2})\\b`, "i");
  for (const t of texts) {
    const m = named.exec(t);
    if (m) {
      const month = MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase());
      const y = Number(m[2]);
      return periodOf(y < 100 ? 2000 + y : y, month);
    }
    const iso = /\b(20\d{2})[-/](0[1-9]|1[0-2])\b/.exec(t);
    if (iso) return periodOf(Number(iso[1]), Number(iso[2]) - 1);
  }
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return periodOf(prev.getFullYear(), prev.getMonth());
}

const FLAG_NAME = /\b(flag|flags|flagged|status|exception|alert|review)\b/i;
const NOTE_NAME = /\b(explanation|explain|comment|comments|commentary|reason|note|notes|why)\b/i;
const GROUP_NAME = /\b(report line|line|category|group|class|type|department|dept|cost cent(re|er)|region|segment|entity|division|caption|heading)\b/i;
const PERCENT_NAME = /%|percent|\bpct\b|\brate\b/i;

/** What the starters need to know about a sheet. `hints`: other text in the workbook that may name the period. */
export function sheetFacts(sheetId: string, sheetName: string, data: SheetColumns | null, hints: { texts?: readonly string[]; today?: Date } = {}): SheetFacts {
  if (!data || !data.columns.length) return { sheetId, sheetName, names: [], rows: 0, headerRow: true, amount: null, category: null, date: null, period: inferPeriod(null, [sheetName, ...(hints.texts ?? [])], hints.today) };
  // the used area often ends in blank rows (template formulas showing ""): count up to the last row with something in it
  let rows = data.rows;
  const filled = (c: (typeof data.columns)[number], i: number) => (c.kind === "number" ? c.values[i] === c.values[i] : c.codes[i] !== 0 && c.dict[c.codes[i] - 1] !== "");
  while (rows > 0 && !data.columns.some((c) => filled(c, rows - 1))) rows--;
  const infos: ColumnInfo[] = quickInfos({ ...data, rows });
  const text = (c: ColumnInfo) => c.kind === "text";
  const flagInfo = infos.find((c) => text(c) && FLAG_NAME.test(c.name) && c.distinct > 0 && c.distinct <= 5);
  const flag = flagInfo?.col ?? null;
  const note = infos.find((c) => text(c) && c.col !== flag && NOTE_NAME.test(c.name))?.col ?? null;
  // a grouping column: few values, repeated; one named like a grouping (Report line) may have no repeats yet
  const groups = infos.filter((c) => text(c) && c.col !== flag && c.col !== note && (!isIdLike(c) || GROUP_NAME.test(c.name)) && c.distinct > 0 && c.distinct <= 60 && (c.distinct < c.count || GROUP_NAME.test(c.name)));
  const category = (groups.find((c) => GROUP_NAME.test(c.name)) ?? groups[0])?.col ?? null;
  const date = infos.find((c) => c.kind === "date")?.col ?? null;
  const measures = measureColumns(infos, 6).filter((c) => !PERCENT_NAME.test(data.names[c]) && !/%/.test(data.numFmts[c] ?? ""));
  const amount = measures[0] ?? measureColumns(infos, 1)[0] ?? null;
  const balanced = amount !== null && !!infos[amount]?.balanced;

  const facts: SheetFacts = { sheetId, sheetName, names: data.names, rows, headerRow: data.first === 1, amount, category, date, ...(balanced ? { balanced } : {}), measures, flag, note };
  if (flag !== null) {
    // the flag value: the most common non-blank one
    const col = data.columns[flag];
    if (col.kind === "string") {
      const counts = new Map<number, number>();
      for (let i = 0; i < rows; i++) if (col.codes[i] && col.dict[col.codes[i] - 1].trim()) counts.set(col.codes[i], (counts.get(col.codes[i]) ?? 0) + 1);
      const top = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (top) facts.flagValue = col.dict[top[0] - 1];
    }
  }
  if (category !== null) {
    const col = data.columns[category];
    if (col.kind === "string") {
      let blank = false;
      const seen = new Set<string>();
      // every row the pivot will read, template rows showing "" included
      for (let i = 0; i < data.rows; i++) {
        const v = col.codes[i] ? col.dict[col.codes[i] - 1] : "";
        if (v.trim()) seen.add(v);
        else blank = true;
      }
      if (blank) facts.categoryValues = [...seen];
    }
  }
  const dateCol = date !== null ? data.columns[date] : null;
  const dates = dateCol?.kind === "number" ? dateCol.values.subarray(0, rows) : null;
  facts.period = inferPeriod(dates, [sheetName, ...data.names, ...(hints.texts ?? [])], hints.today);
  return facts;
}

/** A flux or trial balance sheet: lines flagged for explanation, or amounts that net to nothing by category. */
export const isFlux = (f: SheetFacts) => (f.flag != null && !!f.flagValue && (f.measures?.length ?? 0) >= 1) || (!!f.balanced && f.category !== null && (f.measures?.length ?? 0) >= 2);

const id = () => newId("b");
const heading = (text: string, level: 1 | 2 | 3 = 1): ReportBlock => ({ id: id(), kind: "heading", text, level });
const para = (text: string): ReportBlock => ({ id: id(), kind: "paragraph", text });
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

function pivotOf(f: SheetFacts, rows: number, group?: DateGroup, values: number[] = f.balanced || f.amount === null ? [] : [f.amount]): SavedPivot {
  const keep = rows === f.category && f.categoryValues && !group ? [{ field: rows, keep: f.categoryValues }] : [];
  return {
    rows: [{ field: rows, ...(group ? { group } : {}) }],
    cols: [],
    values: values.length ? values.map((v) => ({ field: v, agg: "sum" as PivotAgg })) : [{ field: rows, agg: "count" }],
    filters: keep,
    subtotals: false,
    // amounts that net to nothing have a grand total of nothing
    grandTotals: !f.balanced || !values.length,
    names: f.names,
  };
}

function pivotTable(f: SheetFacts, rows: number, group?: DateGroup, values?: number[]): ReportBlock {
  return { id: id(), kind: "table", source: "pivot", sheetId: f.sheetId, pivot: pivotOf(f, rows, group, values), totals: true };
}

function pivotChart(f: SheetFacts, rows: number, title: string, group?: DateGroup, values?: number[]): ReportBlock {
  const p = pivotOf(f, rows, group, values?.slice(0, 1));
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

/** The flagged lines (every column), through a parameter the report filters on. */
function flaggedLines(f: SheetFacts, param: string): ReportBlock {
  const last = columnLetter(Math.max(0, f.names.length - 1));
  return { id: id(), kind: "table", source: "range", sheetId: f.sheetId, range: `A1:${last}${Math.max(1, f.rows + (f.headerRow ? 1 : 0))}`, headerRow: true, filter: { param, column: f.flag! } };
}

/** "Total Amount: {{…}} across {{…}} lines." Amounts that net to nothing get their debits instead of a total of 0.00. */
function keyFigures(f: SheetFacts, where = ""): string {
  if (f.amount === null) return `${f.sheetName} has ${f.rows.toLocaleString("en-US")} lines.`;
  const col = columnLetter(f.amount);
  const name = f.names[f.amount];
  const range = `${col}:${col}`;
  if (f.balanced && !where) return `Debits in ${name}: {{=TEXT(ROUND(SUMIF(${range},">0"),2),"#,##0.00")}} across {{=TEXT(COUNT(${range}),"#,##0")}} lines; debits and credits net to nothing.`;
  if (!where) return `Total ${name}: {{=TEXT(ROUND(SUM(${range}),2),"#,##0.00")}} across {{=TEXT(COUNT(${range}),"#,##0")}} lines.`;
  return `Total ${name}: {{=TEXT(ROUND(SUMIFS(${range},${where}),2),"#,##0.00")}} across {{=TEXT(COUNTIFS(${where},${range},">-1E+300"),"#,##0")}} lines.`;
}

/** The flux opening line: how many lines need an explanation. */
function fluxOverview(f: SheetFacts): string {
  const flag = columnLetter(f.flag!);
  const count = f.amount !== null ? columnLetter(f.amount) : flag;
  const what = f.category !== null ? "accounts" : "lines";
  return `{{=TEXT(COUNTIF(${flag}:${flag},${q(f.flagValue!)}),"#,##0")}} of {{=TEXT(COUNT(${count}:${count}),"#,##0")}} ${what} moved by more than the threshold and are flagged "${f.flagValue}"; each needs an explanation.`;
}

/** Blocks for a flux or trial balance sheet. */
function fluxBlocks(r: Report, f: SheetFacts): ReportBlock[] {
  const blocks: ReportBlock[] = [heading("Overview")];
  const measures = (f.measures ?? []).slice(0, 3);
  if (f.flag != null && f.flagValue) {
    r.params.push({ name: "flagged", value: f.flagValue });
    blocks.push(para(fluxOverview(f)), heading("Movements over threshold", 2), flaggedLines(f, "flagged"));
  } else blocks.push(para(keyFigures(f)));
  if (f.category !== null && measures.length) {
    const cat = f.names[f.category];
    blocks.push(heading(`Totals by ${cat}`, 2), pivotTable(f, f.category, undefined, measures));
    const change = measures.find((m) => /change|movement|variance|diff/i.test(f.names[m])) ?? measures[0];
    blocks.push(pivotChart(f, f.category, `${f.names[change]} by ${cat}`, undefined, [change]));
  }
  return blocks;
}

/** A starter report for the sheet. */
export function starterReport(kind: StarterKind, f: SheetFacts): Report {
  const r = newReport(f.sheetId, kind === "blank" ? "Report" : `${f.sheetName} ${kind === "close" ? "month-end pack" : kind === "entity" ? "by " + (f.category === null ? "item" : f.names[f.category]) : "summary"}`);
  if (kind === "blank" || !f.names.length) return r;
  const amount = f.amount === null || f.balanced ? "Lines" : f.names[f.amount];
  const period = f.period ?? inferPeriod(null);
  const blocks: ReportBlock[] = [];
  const flux = isFlux(f);

  if (kind === "summary") {
    r.subtitle = `Prepared from ${f.sheetName}, ${period.label}`;
    if (flux) blocks.push(...fluxBlocks(r, f));
    else {
      blocks.push(heading("Overview"), para(keyFigures(f)));
      if (f.category !== null) {
        const t = `${amount} by ${f.names[f.category]}`;
        blocks.push(heading(t, 2), pivotTable(f, f.category), pivotChart(f, f.category, t));
      } else if (f.date !== null) {
        const t = `${amount} by month`;
        blocks.push(heading(t, 2), pivotTable(f, f.date, "month"), pivotChart(f, f.date, t, "month"));
      }
    }
    blocks.push({ id: id(), kind: "pageBreak" }, heading("Detail", 2), detail(f));
  } else if (kind === "close") {
    r.params = [{ name: "period", value: period.label }];
    r.title = "Month-end close pack";
    r.subtitle = `${f.sheetName}, period {{period}}`;
    if (flux) blocks.push(...fluxBlocks(r, f));
    else {
      blocks.push(heading("Summary"), para(keyFigures(f)));
      if (f.date !== null) {
        const t = `${amount} by month`;
        blocks.push(heading(t, 2), pivotTable(f, f.date, "month"), pivotChart(f, f.date, t, "month"));
      }
      if (f.category !== null) blocks.push(heading(`${amount} by ${f.names[f.category]}`, 2), pivotTable(f, f.category));
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
    blocks.push(heading(`{{${param}}}`), para(keyFigures({ ...f, balanced: false }, `${catCol}:${catCol},{${param}}`)));
    if (f.date !== null) {
      const t = `${amount} by month`;
      const table = pivotTable(f, f.date, "month");
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
