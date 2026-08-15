/**
 * Running a report: parameters put into text and formulas, {{=formula}}
 * worked out against the workbook, tables read from ranges or pivots
 * (filtered to the entity), charts built from their specs. The result is
 * plain data that the HTML preview and the PDF writer both draw.
 *
 * Nothing here touches the DOM.
 */
import { CellError, formatValue, parseFormula } from "@cellforge/core";
import type { CellValue } from "@cellforge/grid";
import { buildChart, clampRange, makeResolver, type ChartData, type ChartSource } from "../charts/data";
import { LAST_ROW, parseRange, type ChartSpec } from "../charts/model";
import { chartInput, pivotOf } from "../charts/pivotchart";
import { loadPivot, withMemberFilter } from "../charts/pivotspec";
import type { EditableSource } from "../editable";
import { readSheetColumns, type ColumnSource } from "../pivotpanel";
import type { Workbook } from "../workbook";
import type { ParamFilter, ParamValue, Report, ReportBlock } from "./model";

// -------------------------------------------------------------- the workbook --

/** A sheet as a report reads it. EditableSource fits. */
export type ReportSheet = ChartSource & ColumnSource;

/** What running a report needs from the workbook. */
export interface ReportEnv {
  /** work out a formula (without "=") as if typed on the sheet */
  evaluate(formula: string, sheetId: string): unknown;
  sheet(sheetId: string): ReportSheet | null;
  sheetName(sheetId: string): string | null;
  /** a saved chart */
  chart(id: string): ChartSpec | null;
}

/** Formulas are worked out as if typed far away from the data, so nothing reads itself. */
const ANCHOR = { row: 1_048_575, col: 16_383 };

/** Work out a formula against a sheet. Parse errors come back as an error value. */
export function evaluateOn(src: Pick<EditableSource, "evalAt">, formula: string): unknown {
  let ast;
  try {
    ast = parseFormula(formula.trim().startsWith("=") ? formula.trim() : `=${formula.trim()}`);
  } catch {
    return new CellError("#ERROR!");
  }
  return src.evalAt(ast, ANCHOR.row, ANCHOR.col);
}

/** The report environment over a workbook. */
export function workbookEnv(wb: Workbook): ReportEnv {
  return {
    evaluate: (formula, sheetId) => {
      const sh = wb.has(sheetId) ? wb.get(sheetId) : wb.sheets[0];
      return sh ? evaluateOn(sh.source, formula) : new CellError("#REF!");
    },
    sheet: (id) => (wb.has(id) ? wb.get(id).source : null),
    sheetName: (id) => (wb.has(id) ? wb.get(id).name : null),
    chart: (id) => wb.charts.find((c) => c.id === id) ?? null,
  };
}

// -------------------------------------------------------------- parameters --

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A parameter as a formula value: a number, DATE(...) for yyyy-mm-dd, "*" when consolidated, otherwise text. */
export function paramLiteral(p: ParamValue): string {
  if (p.all) return '"*"';
  const v = p.value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  const d = ISO_DATE.exec(v);
  if (d) return `DATE(${Number(d[1])},${Number(d[2])},${Number(d[3])})`;
  return `"${p.value.replace(/"/g, '""')}"`;
}

const paramLabel = (p: ParamValue) => p.label ?? (p.all ? "All" : p.value);

/** Put {name} parameters into a formula (outside its text literals). Unknown {…} are left alone (array constants). */
export function substituteFormula(formula: string, params: Record<string, ParamValue>): string {
  const byLower = new Map(Object.entries(params).map(([k, v]) => [k.toLowerCase(), v]));
  let out = "";
  let inStr = false;
  for (let i = 0; i < formula.length; i++) {
    const c = formula[i];
    if (inStr) {
      out += c;
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "{") {
      const m = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/.exec(formula.slice(i));
      const p = m ? byLower.get(m[1].toLowerCase()) : undefined;
      if (m && p) {
        out += paramLiteral(p);
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** A formula's result as report text: numbers with thousands separators (use TEXT() for anything else). */
export function resultText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof CellError) return v.code;
  if (typeof v === "number") return Number.isFinite(v) ? formatValue(v, Number.isInteger(v) ? "#,##0" : "#,##0.00").text : "#NUM!";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  return String(v);
}

export interface TextPart {
  kind: "text" | "param" | "formula";
  text: string;
}

/** Split template text into plain text, {{param}} and {{=formula}} parts. */
export function parseTemplate(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let plain = "";
  let i = 0;
  const flush = () => {
    if (plain) parts.push({ kind: "text", text: plain });
    plain = "";
  };
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      if (text[i + 2] === "=") {
        // find the closing }} outside strings and the formula's own braces
        let j = i + 3;
        let depth = 0;
        let inStr = false;
        let end = -1;
        for (; j < text.length; j++) {
          const c = text[j];
          if (inStr) {
            if (c === '"') inStr = false;
          } else if (c === '"') inStr = true;
          else if (c === "{") depth++;
          else if (c === "}") {
            if (depth > 0) depth--;
            else if (text[j + 1] === "}") {
              end = j;
              break;
            }
          }
        }
        if (end >= 0) {
          flush();
          parts.push({ kind: "formula", text: text.slice(i + 3, end) });
          i = end + 2;
          continue;
        }
      } else {
        const m = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(text.slice(i));
        if (m) {
          flush();
          parts.push({ kind: "param", text: m[1] });
          i += m[0].length;
          continue;
        }
      }
    }
    plain += text[i++];
  }
  flush();
  return parts;
}

/**
 * Fill in template text. `problems` collects formulas that came out as
 * errors and parameters that don't exist, for the report's warnings.
 */
export function expandText(text: string, params: Record<string, ParamValue>, evaluate: (formula: string) => unknown, problems: string[] = []): string {
  const byLower = new Map(Object.entries(params).map(([k, v]) => [k.toLowerCase(), v]));
  return parseTemplate(text)
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "param") {
        const v = byLower.get(p.text.toLowerCase());
        if (!v) {
          problems.push(`There's no parameter called "${p.text}".`);
          return `{{${p.text}}}`;
        }
        return paramLabel(v);
      }
      const value = evaluate(substituteFormula(p.text, params));
      if (value instanceof CellError) problems.push(`{{=${p.text}}} gives ${value.code}.`);
      return resultText(value);
    })
    .join("");
}

// ------------------------------------------------------------ roll forward --

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The period `steps` on from `value` (back when negative), in the same
 * style: 2026-03-31 (month ends stay month ends), 2026-03, Mar 2026,
 * March 2026, Q1 2026, 2026 Q1, FY2026, 2026, or a plain number. Null when
 * the value doesn't look like a period.
 */
export function rollPeriod(value: string, steps = 1): string | null {
  const v = value.trim();
  let m: RegExpExecArray | null;
  const addMonths = (y: number, mo: number, k: number) => {
    const t = y * 12 + (mo - 1) + k;
    return [Math.floor(t / 12), (t % 12) + 1] as const;
  };
  if ((m = ISO_DATE.exec(v))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const [y2, m2] = addMonths(y, mo, steps);
    const day = d === daysIn(y, mo) ? daysIn(y2, m2) : Math.min(d, daysIn(y2, m2));
    return `${y2}-${pad(m2)}-${pad(day)}`;
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(v))) {
    const [y2, m2] = addMonths(Number(m[1]), Number(m[2]), steps);
    return `${y2}-${pad(m2)}`;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(v))) {
    const k = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (k < 0) return null;
    const [y2, m2] = addMonths(Number(m[2]), k + 1, steps);
    const long = m[1].length > 3;
    const name = long ? MONTH_NAMES[m2 - 1] : MONTH_NAMES[m2 - 1].slice(0, 3);
    const cased = m[1] === m[1].toUpperCase() ? name.toUpperCase() : name;
    return `${cased} ${y2}`;
  }
  if ((m = /^Q([1-4])(\s*)(\d{4})$/i.exec(v))) {
    const t = Number(m[3]) * 4 + Number(m[1]) - 1 + steps;
    return `${v[0]}${(t % 4) + 1}${m[2]}${Math.floor(t / 4)}`;
  }
  if ((m = /^(\d{4})(\s*-?\s*)Q([1-4])$/i.exec(v))) {
    const t = Number(m[1]) * 4 + Number(m[3]) - 1 + steps;
    return `${Math.floor(t / 4)}${m[2]}${v[v.length - 2]}${(t % 4) + 1}`;
  }
  if ((m = /^(FY\s*)(\d{2}|\d{4})$/i.exec(v))) {
    const n = Number(m[2]) + steps;
    return `${m[1]}${m[2].length === 2 ? pad(((n % 100) + 100) % 100) : n}`;
  }
  if (/^-?\d+$/.test(v)) return String(Number(v) + steps);
  return null;
}

/**
 * Move a report's period on: the named parameter, or every parameter that
 * looks like a period (except the one it's run for each of). Returns the new
 * report and the parameters that changed.
 */
export function rollForward(report: Report, steps = 1, param?: string): { report: Report; changed: string[] } {
  const changed: string[] = [];
  const params = report.params.map((p) => {
    if (param ? p.name.toLowerCase() !== param.toLowerCase() : p.name === report.runFor?.param) return p;
    const next = rollPeriod(p.value, steps);
    if (next === null) return p;
    changed.push(p.name);
    return { ...p, value: next };
  });
  return { report: { ...report, params }, changed };
}

// ------------------------------------------------------------------ tables --

export interface RenderedTable {
  title?: string;
  headers: string[];
  /** right for numbers */
  align: ("left" | "right")[];
  rows: { cells: string[]; bold?: boolean }[];
  /** a note under the table (cut short, filtered) */
  note?: string;
}

/** Most rows a table block shows. */
export const MAX_TABLE_ROWS = 5000;

/** Does a cell match a parameter value? Text ignores case and spaces at the ends; numbers compare as numbers. */
export function matchesParam(v: CellValue | boolean, want: string): boolean {
  if (v === null || v === undefined) return want.trim() === "";
  if (typeof v === "number") {
    const n = Number(want.replace(/,/g, ""));
    if (want.trim() !== "" && Number.isFinite(n)) return Math.abs(v - n) < 1e-9;
    const d = ISO_DATE.exec(want.trim());
    if (d) return Math.floor(v) === Math.round((Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])) - Date.UTC(1899, 11, 30)) / 86400000);
    return false;
  }
  return String(v).trim().toLowerCase() === want.trim().toLowerCase();
}

const TOTAL_ROW = /^\s*(grand\s+)?(sub-?)?total\b/i;

/** A range of a sheet as a table (the first row as headers when headerRow), filtered to rows whose column matches. */
export function rangeTable(src: ReportSheet, rangeText: string, headerRow: boolean, filter?: { column: number; value: string }): RenderedTable {
  const r0 = parseRange(rangeText);
  if (!r0) throw new Error(`"${rangeText}" isn't a range like A1:D20.`);
  const r = clampRange(src, { sheetId: "", ...r0 });
  if (r0.bottom >= LAST_ROW && !src.usedRange) throw new Error("Whole columns need a sheet.");
  const text = (row: number, col: number) => {
    const v = src.getCell(row, col);
    return v === null ? "" : typeof v === "number" ? formatValue(v, src.getStyle(row, col)?.numFmt).text : String(v);
  };
  const cols = r.right - r.left + 1;
  // a sheet with column names (an imported file) has them above row 1, so row 1 is data
  const named = headerRow && r.top === 0 ? Array.from({ length: cols }, (_, c) => src.getColumnName?.(r.left + c) ?? "") : null;
  const useNames = !!named?.some(Boolean);
  const headers: string[] = [];
  for (let c = 0; c < cols; c++) headers.push(useNames ? named![c] : headerRow ? text(r.top, r.left + c) : "");
  const numeric = new Array<number>(cols).fill(0);
  const other = new Array<number>(cols).fill(0);
  const rows: RenderedTable["rows"] = [];
  let total = 0;
  for (let row = r.top + (headerRow && !useNames ? 1 : 0); row <= r.bottom; row++) {
    if (filter && !matchesParam(src.getCell(row, filter.column), filter.value)) continue;
    total++;
    if (rows.length >= MAX_TABLE_ROWS) continue;
    const cells: string[] = [];
    let bold = false;
    for (let c = 0; c < cols; c++) {
      const v = src.getCell(row, r.left + c);
      if (typeof v === "number") numeric[c]++;
      else if (v !== null && v !== "") other[c]++;
      const t = text(row, r.left + c);
      if (c === 0 && TOTAL_ROW.test(t)) bold = true;
      cells.push(t);
    }
    rows.push({ cells, ...(bold ? { bold } : {}) });
  }
  const notes: string[] = [];
  if (total > rows.length) notes.push(`Showing the first ${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} rows.`);
  if (filter && !total) notes.push("No rows for this entity.");
  return { headers, align: numeric.map((n, c) => (n > 0 && n >= other[c] ? "right" : "left")), rows, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

/** A saved pivot of a sheet as a table, with subtotal and total rows in bold. */
export function pivotReportTable(src: ColumnSource, block: Extract<ReportBlock, { source: "pivot" }>, filter?: { column: number; value: string }): RenderedTable {
  const data = readSheetColumns(src);
  let spec = loadPivot(block.pivot, data.names);
  if (block.totals === false) spec = { ...spec, subtotals: false, grandTotals: false };
  if (filter) spec = withMemberFilter(spec, filter.column, filter.value);
  const t = pivotOf(data, spec);
  const rows = t.rows.slice(0, MAX_TABLE_ROWS).map((row) => ({
    cells: row.cells.map((v, j) => (v === null ? "" : typeof v === "number" ? formatValue(v, t.numFmts[j] || "#,##0.##").text : v)),
    ...(row.kind !== "leaf" ? { bold: true } : {}),
  }));
  return {
    headers: t.headers,
    align: t.headers.map((_, j) => (j < t.labelCols ? "left" : "right")),
    rows,
    ...(t.rows.length > MAX_TABLE_ROWS ? { note: `Showing the first ${MAX_TABLE_ROWS.toLocaleString("en-US")} of ${t.rows.length.toLocaleString("en-US")} rows.` } : {}),
  };
}

// ------------------------------------------------------------------ charts --

/** A range chart cut to the rows whose column matches (series in columns only). */
export function filteredChartInput(src: ChartSource, spec: ChartSpec, column: number, value: string): { src: ChartSource; spec: ChartSpec } {
  const r = clampRange(src, spec.range);
  const keep: number[] = [];
  if (spec.names) keep.push(r.top);
  for (let row = r.top + (spec.names ? 1 : 0); row <= r.bottom; row++) if (matchesParam(src.getCell(row, column), value)) keep.push(row);
  return {
    src: {
      getCell: (row, col) => (row < keep.length ? src.getCell(keep[row], col) : null),
      getStyle: (row, col) => (row < keep.length ? (src.getStyle?.(keep[row], col) ?? null) : null),
      usedRange: () => ({ rows: keep.length, cols: r.right + 1 }),
    },
    spec: { ...spec, range: { ...spec.range, top: 0, bottom: Math.max(0, keep.length - 1), left: r.left, right: r.right } },
  };
}

// ---------------------------------------------------------------- the run --

export type RenderedBlock =
  | { kind: "heading"; text: string; level: 1 | 2 | 3 }
  | { kind: "paragraph"; text: string }
  | ({ kind: "table" } & RenderedTable)
  | { kind: "chart"; title: string; spec: ChartSpec; data: ChartData }
  | { kind: "chart"; title: string; error: string }
  | { kind: "error"; text: string }
  | { kind: "pageBreak" };

export interface RenderedReport {
  title: string;
  subtitle: string;
  blocks: RenderedBlock[];
  /** formulas with errors, missing parameters, missing sheets */
  warnings: string[];
  /** the parameter values of this run */
  params: Record<string, ParamValue>;
}

/** The parameter values for a run: the report's own, with `over` on top. */
export function paramValues(report: Report, over: Record<string, ParamValue> = {}): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of report.params) out[p.name] = { value: p.value };
  for (const [k, v] of Object.entries(over)) {
    const name = report.params.find((p) => p.name.toLowerCase() === k.toLowerCase())?.name ?? k;
    out[name] = v;
  }
  return out;
}

/** Run a report once with the given parameter values. */
export function runReport(report: Report, env: ReportEnv, over: Record<string, ParamValue> = {}): RenderedReport {
  const params = paramValues(report, over);
  const warnings: string[] = [];
  const evaluate = (f: string) => env.evaluate(f, report.sheetId);
  const expand = (t: string) => expandText(t, params, evaluate, warnings);
  const filterOf = (f: ParamFilter | undefined): { column: number; value: string } | undefined => {
    if (!f) return undefined;
    const p = Object.entries(params).find(([k]) => k.toLowerCase() === f.param.toLowerCase())?.[1];
    if (!p) {
      warnings.push(`A filter uses "${f.param}", which isn't a parameter.`);
      return undefined;
    }
    return p.all ? undefined : { column: f.column, value: p.value };
  };
  const blocks: RenderedBlock[] = [];
  for (const b of report.blocks) {
    try {
      switch (b.kind) {
        case "heading":
          blocks.push({ kind: "heading", text: expand(b.text), level: b.level });
          break;
        case "paragraph":
          blocks.push({ kind: "paragraph", text: expand(b.text) });
          break;
        case "pageBreak":
          blocks.push({ kind: "pageBreak" });
          break;
        case "table": {
          const src = env.sheet(b.sheetId);
          if (!src) throw new Error("The sheet this table reads has been deleted.");
          const t = b.source === "range" ? rangeTable(src, b.range, b.headerRow, filterOf(b.filter)) : pivotReportTable(src, b, filterOf(b.filter));
          blocks.push({ kind: "table", ...t, ...(b.title ? { title: expand(b.title) } : {}) });
          break;
        }
        case "chart": {
          const spec = b.spec ?? (b.chartId ? env.chart(b.chartId) : null);
          const title = b.title ? expand(b.title) : (spec?.title ?? "");
          if (!spec) {
            blocks.push({ kind: "chart", title, error: b.chartId ? "That chart has been deleted." : "Pick a chart for this block." });
            break;
          }
          const f = filterOf(b.filter);
          let input: { src: ChartSource; spec: ChartSpec } | null;
          if (spec.pivot) input = chartInput(spec, (id) => env.sheet(id), f ? (s) => withMemberFilter(s, f.column, f.value) : undefined);
          else {
            input = chartInput(spec, (id) => env.sheet(id));
            if (input && f) input = filteredChartInput(input.src, input.spec, f.column, f.value);
          }
          if (!input) {
            blocks.push({ kind: "chart", title, error: "The sheet this chart reads has been deleted." });
            break;
          }
          const data = buildChart(input.src, input.spec, makeResolver((sheet, row, col) => env.sheet(sheet)?.getCell(row, col) ?? null));
          blocks.push({ kind: "chart", title, spec: { ...input.spec, title }, data });
          break;
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      warnings.push(msg);
      if (b.kind === "chart") blocks.push({ kind: "chart", title: b.title ?? "", error: msg });
      else blocks.push({ kind: "error", text: msg });
    }
  }
  return { title: expand(report.title), subtitle: report.subtitle ? expand(report.subtitle) : "", blocks, warnings: [...new Set(warnings)], params };
}

/** The values "Run for each" goes through: a typed list, or the distinct values of a column (sorted). */
export function runForValues(report: Report, env: ReportEnv): string[] {
  const rf = report.runFor;
  if (!rf) return [];
  if (rf.list?.length) return [...new Set(rf.list.map((x) => x.trim()).filter(Boolean))];
  if (rf.sheetId === undefined || rf.column === undefined) return [];
  const src = env.sheet(rf.sheetId);
  if (!src) return [];
  const data = readSheetColumns(src);
  const col = data.columns[rf.column];
  if (!col) return [];
  const seen = new Set<string>();
  if (col.kind === "number") {
    for (let i = 0; i < data.rows; i++) {
      const v = col.values[i];
      if (v === v) seen.add(formatValue(v, data.numFmts[rf.column] || "General").text);
    }
  } else for (let i = 0; i < data.rows; i++) if (col.codes[i]) seen.add(col.dict[col.codes[i] - 1]);
  return [...seen].filter((s) => s.trim()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Run a report once per value of its "Run for each" parameter, with a
 * consolidated run first when asked. Without runFor, runs it once.
 */
export function runBook(report: Report, env: ReportEnv, values = runForValues(report, env)): RenderedReport[] {
  const rf = report.runFor;
  if (!rf) return [runReport(report, env)];
  const out: RenderedReport[] = [];
  if (rf.consolidated) out.push(runReport(report, env, { [rf.param]: { value: "*", all: true, label: rf.allLabel || "All" } }));
  for (const v of values) out.push(runReport(report, env, { [rf.param]: { value: v } }));
  return out;
}
