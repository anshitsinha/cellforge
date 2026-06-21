/**
 * Reshaping and extraction tools as dialogs: remove duplicates, text to
 * columns, unpivot, pivot, extract by pattern, and Goal Seek. Each shows a
 * live preview of the first rows. Tools that make a new table add a sheet
 * (the original is never changed); tools that add columns write them next
 * to the source column as one undo step, warning before they overwrite.
 */
import type { Action } from "@cellforge/actions";
import { columnIndex, formatValue, isDateFormat, Table, type ColumnData } from "@cellforge/core";
import { columnLetter, type CellRange, type CellRef } from "@cellforge/grid";
import {
  extractPattern,
  goalSeek,
  PATTERN_LABELS,
  pivotWider,
  removeDuplicates,
  textToColumns,
  unpivot,
  type GoalSeekOptions,
  type GoalSeekResult,
  type PatternKind,
  type PatternSpec,
  type WiderAgg,
  type RemoveDupOptions,
  type SplitOptions,
} from "@cellforge/core";
import { readSheet, type SheetData } from "./audittools";
import { setCells } from "./actions";
import { EditableSource } from "./editable";
import "./transformtools.css";

export type TransformKind = "dedupe" | "split" | "unpivot" | "pivot" | "extract" | "goalseek";

export interface TransformDeps {
  source: () => EditableSource;
  /** Id of the active sheet (writes go there even if the user switches away). */
  activeSheet: () => string;
  sheetName: () => string;
  range: () => CellRange;
  selection: () => CellRef;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

/** Most cells one tool writes into the sheet in one go. */
export const MAX_WRITE_CELLS = 1_000_000;
const PREVIEW_ROWS = 10;

type V = string | number | null;
type CellInput = { row: number; col: number; input: string | null };

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${count(n)} ${n === 1 ? one : many}`;
const A1 = (r: CellRef) => `${columnLetter(r.col)}${r.row + 1}`;
const label = (data: SheetData, c: number) => data.names[c]?.replace(/^[A-Z]+: /, "") ?? "";

// ------------------------------------------------------------- helpers --

/** "B3", "$B$3" or "b3" as a cell, or null. */
export function parseCellRef(text: string): CellRef | null {
  const m = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*$/.exec(text);
  if (!m || Number(m[2]) < 1) return null;
  return { row: Number(m[2]) - 1, col: columnIndex(m[1].toUpperCase()) };
}

/** A cell's value as text the way it reads on screen (dates as ISO text). */
export function cellText(src: EditableSource, row: number, col: number): string {
  const v = src.getCell(row, col);
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    const code = src.getStyle(row, col)?.numFmt;
    if (code && isDateFormat(code)) return formatValue(v, v % 1 ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd").text;
    return String(v);
  }
  return String(v);
}

/**
 * A value as it should be typed into a cell so it comes back as the same
 * value: text gets a leading apostrophe (so "007" and "=x" stay text), dates
 * go in as ISO dates (so they get a date format), percentages as "12.5%".
 */
export function toInput(v: V | boolean, kind: "number" | "date" | "text" = "number", numFmt?: string): string | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return "'" + v;
  if (!Number.isFinite(v)) return null;
  if (kind === "date") return formatValue(v, v % 1 ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd").text;
  if (numFmt && /%/.test(numFmt)) return `${Number((v * 100).toPrecision(15))}%`;
  return String(v);
}

/** Result columns: numeric where every value is a number or blank, text otherwise. */
export function buildColumns(header: readonly string[], rows: readonly (readonly V[])[], numFmts: readonly string[] = []): { columns: ColumnData[]; numFmts: string[] } {
  const columns: ColumnData[] = [];
  const fmts: string[] = [];
  header.forEach((name, c) => {
    const vals = rows.map((r) => r[c] ?? null);
    if (vals.every((v) => v === null || typeof v === "number")) {
      columns.push({ kind: "number", name, values: Float64Array.from(vals, (v) => (v === null ? NaN : (v as number))) });
      fmts.push(numFmts[c] ?? "");
    } else {
      const dict: string[] = [];
      const lookup = new Map<string, number>();
      const codes = Uint32Array.from(vals, (v) => {
        if (v === null || v === "") return 0;
        const s = String(v);
        let code = lookup.get(s);
        if (code === undefined) {
          code = dict.push(s);
          lookup.set(s, code);
        }
        return code;
      });
      columns.push({ kind: "string", name, codes, dict });
      fmts.push("");
    }
  });
  return { columns, numFmts: fmts };
}

/** A new sheet's contents. */
export interface SheetOut {
  name: string;
  header: string[];
  rows: V[][];
  numFmts: string[];
}

/** The rows of the sheet's data as arrays (all columns). */
function rowsOf(data: SheetData, rows?: readonly number[]): V[][] {
  const cols = data.names.map((_, c) => data.col(c));
  const pick = rows ?? Array.from({ length: data.rows }, (_, i) => i);
  return pick.map((i) => cols.map((col) => col[i] ?? null));
}

/** A value for the preview, in its column's format. */
function show(v: V, fmt = ""): string {
  if (v === null) return "";
  if (typeof v === "number") return formatValue(v, fmt || undefined).text;
  return v;
}

function previewOf(out: SheetOut): string[][] {
  return [out.header, ...out.rows.slice(0, PREVIEW_ROWS).map((r) => r.map((v, c) => show(v, out.numFmts[c])))];
}

/** The data rows a column tool works on: the selected rows when more than one is selected, else all. */
export function targetRows(data: SheetData, range: CellRange): number[] {
  const all = Array.from({ length: data.rows }, (_, i) => i);
  if (range.bottom <= range.top) return all;
  return all.filter((i) => {
    const r = i + data.first;
    return r >= range.top && r <= range.bottom;
  });
}

/** Cells in the way: those that would be overwritten and aren't empty. */
function filledCount(src: EditableSource, cells: readonly CellInput[]): number {
  let n = 0;
  for (const c of cells) {
    if (c.col >= src.colCount || c.row >= src.rowCount) continue;
    const v = src.getCell(c.row, c.col);
    if (v !== null && v !== "") n++;
  }
  return n;
}

/**
 * Ready the writes: blanks into cells that are already empty do nothing, so
 * they're left out; a cell formatted as Text keeps what's typed exactly, so
 * text going there doesn't need (and mustn't get) the leading apostrophe.
 */
function dropNoops(src: EditableSource, cells: CellInput[]): CellInput[] {
  const inside = (c: CellInput) => c.col < src.colCount && c.row < src.rowCount;
  return cells
    .filter((c) => c.input !== null || (inside(c) && src.getCell(c.row, c.col) !== null && src.getCell(c.row, c.col) !== ""))
    .map((c) => (c.input?.startsWith("'") && inside(c) && src.getStyle(c.row, c.col)?.numFmt === "@" ? { ...c, input: c.input.slice(1) } : c));
}

// ---------------------------------------------------- remove duplicates --

export function dedupePlan(data: SheetData, sheet: string, keyCols: number[], opts: RemoveDupOptions, withRemoved = false): { removed: number; groups: number; sheets: SheetOut[] } {
  const rows = rowsOf(data);
  const r = removeDuplicates(rows, keyCols, opts);
  const header = data.names.map((_, c) => label(data, c) || `Column ${columnLetter(c)}`);
  const numFmts = data.names.map((_, c) => data.numFmt(c));
  const sheets: SheetOut[] = [{ name: `${sheet} unique`, header, rows: r.kept.map((i) => rows[i]), numFmts }];
  if (withRemoved && r.removed.length) {
    sheets.push({
      name: `${sheet} removed`,
      header: ["Row", "Same as row", ...header],
      rows: r.removed.map((i, k) => [data.sheetRow(i), data.sheetRow(r.keptFor[k]), ...rows[i]]),
      numFmts: ["", "", ...numFmts],
    });
  }
  return { removed: r.removed.length, groups: r.groups, sheets };
}

// ------------------------------------------------------ text to columns --

export interface ColumnWrite {
  cells: CellInput[];
  /** Non-empty cells that would be overwritten. */
  overwrite: number;
  /** How many new columns. */
  columns: number;
  /** Columns that have to be added at the right edge of the sheet first. */
  addColumns: number;
  preview: string[][];
}

export function splitPlan(src: EditableSource, data: SheetData, col: number, rows: number[], opts: SplitOptions): ColumnWrite {
  const texts = rows.map((i) => cellText(src, i + data.first, col));
  const r = textToColumns(texts, opts);
  // one piece per value means there was nothing to split
  const n = r.columns.length;
  const cells: CellInput[] = [];
  const name = label(data, col) || columnLetter(col);
  for (let k = 0; k < n; k++) {
    const target = col + 1 + k;
    if (data.first === 1 && rows.length === data.rows) cells.push({ row: 0, col: target, input: `'${name} ${k + 1}` });
    const p = r.profiles[k];
    rows.forEach((i, j) => {
      const v = r.values[k][j];
      const kind = typeof v === "string" ? "text" : p.type === "date" ? "date" : "number";
      cells.push({ row: i + data.first, col: target, input: toInput(v, kind, p.numFmt) });
    });
  }
  if (cells.length > MAX_WRITE_CELLS) throw new Error(`That would write ${count(cells.length)} cells; the most at once is ${count(MAX_WRITE_CELLS)}. Select fewer rows.`);
  const header = [name, ...r.columns.map((_, k) => `${columnLetter(col + 1 + k)}: ${name} ${k + 1}`)];
  const preview = [
    header,
    ...rows.slice(0, PREVIEW_ROWS).map((_, j) => [
      texts[j],
      ...r.values.map((vals, k) => {
        const v = vals[j];
        return typeof v === "number" ? show(v, r.profiles[k].type === "date" ? (r.profiles[k].hasTime ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd") : (r.profiles[k].numFmt ?? "")) : (v ?? "");
      }),
    ]),
  ];
  return { cells: dropNoops(src, cells), overwrite: filledCount(src, cells), columns: n, addColumns: Math.max(0, col + 1 + n - src.colCount), preview };
}

// ------------------------------------------------------------- extract --

export function extractPlan(src: EditableSource, data: SheetData, col: number, rows: number[], spec: PatternSpec, opts: { all?: boolean; flag?: boolean } = {}): ColumnWrite & { found: number } {
  const texts = rows.map((i) => cellText(src, i + data.first, col));
  const r = extractPattern(texts, spec, { all: opts.all });
  const name = label(data, col) || columnLetter(col);
  const what = spec.kind === "after" ? spec.keyword.trim() || "reference" : spec.kind === "regex" ? "match" : spec.kind;
  const cells: CellInput[] = [];
  const target = col + 1;
  if (data.first === 1 && rows.length === data.rows) {
    cells.push({ row: 0, col: target, input: `'${name} ${what}` });
    if (opts.flag) cells.push({ row: 0, col: target + 1, input: `'${what} found` });
  }
  rows.forEach((i, j) => {
    cells.push({ row: i + data.first, col: target, input: toInput(r.values[j], r.type) });
    if (opts.flag) cells.push({ row: i + data.first, col: target + 1, input: r.matched[j] ? "TRUE" : "FALSE" });
  });
  if (cells.length > MAX_WRITE_CELLS) throw new Error(`That would write ${count(cells.length)} cells; the most at once is ${count(MAX_WRITE_CELLS)}. Select fewer rows.`);
  const fmt = r.type === "date" ? "yyyy-mm-dd" : "";
  const preview = [
    [name, `${columnLetter(target)}: ${what}`, ...(opts.flag ? [`${columnLetter(target + 1)}: found`] : [])],
    ...rows.slice(0, PREVIEW_ROWS).map((_, j) => [texts[j], show(r.values[j], fmt), ...(opts.flag ? [r.matched[j] ? "TRUE" : "FALSE"] : [])]),
  ];
  const n = opts.flag ? 2 : 1;
  return { cells: dropNoops(src, cells), overwrite: filledCount(src, cells), columns: n, addColumns: Math.max(0, target + n - src.colCount), preview, found: r.count };
}

// ------------------------------------------------------ unpivot / pivot --

export function unpivotPlan(data: SheetData, sheet: string, idCols: number[], valueCols: number[], opts: { nameColumn?: string; valueColumn?: string; skipBlanks?: boolean }): SheetOut {
  const header = data.names.map((_, c) => label(data, c) || `Column ${columnLetter(c)}`);
  const r = unpivot(header, rowsOf(data), idCols, valueCols, opts);
  // the value column keeps the format the unpivoted columns share, if they share one
  const fmts = new Set(valueCols.map((c) => data.numFmt(c)));
  const valueFmt = fmts.size === 1 ? [...fmts][0] : "";
  return { name: `${sheet} unpivoted`, header: r.header, rows: r.rows, numFmts: [...idCols.map((c) => data.numFmt(c)), "", valueFmt] };
}

export function pivotPlan(data: SheetData, sheet: string, rowKeys: number[], colKey: number, valueCol: number, agg: WiderAgg): SheetOut & { skipped: number } {
  const r = pivotWider(rowsOf(data), rowKeys, colKey, valueCol, agg);
  const header = [...rowKeys.map((c) => label(data, c) || `Column ${columnLetter(c)}`), ...r.columns];
  const valueFmt = agg === "count" ? "" : data.numFmt(valueCol);
  return {
    name: `${sheet} pivoted`,
    header,
    rows: r.keys.map((k, i) => [...k, ...r.values[i]]),
    numFmts: [...rowKeys.map((c) => data.numFmt(c)), ...r.columns.map(() => valueFmt)],
    skipped: r.skipped,
  };
}

// ----------------------------------------------------------- goal seek --

export interface SeekResult extends GoalSeekResult {
  /** The value the changing cell had to start with. */
  start: number;
}

/**
 * Goal Seek without touching the sheet: candidates go into a copy of it, and
 * only the answer is written back (by the caller, as one undo step).
 */
export function seekOnClone(src: EditableSource, set: CellRef, change: CellRef, target: number, opts: GoalSeekOptions = {}): SeekResult {
  if (!src.getEditText(set.row, set.col).trim().startsWith("=")) throw new Error(`${A1(set)} has no formula. The set cell must hold a formula that depends on the changing cell.`);
  if (src.getEditText(change.row, change.col).trim().startsWith("=")) throw new Error(`${A1(change)} holds a formula. The changing cell must hold a plain number.`);
  const current = src.getCell(change.row, change.col);
  if (current !== null && current !== "" && typeof current !== "number") throw new Error(`${A1(change)} holds text. The changing cell must hold a number (or be empty).`);
  const copy = src.clone();
  copy.resolveSheet = src.resolveSheet;
  copy.resolveName = src.resolveName;
  copy.resolveTable = src.resolveTable;
  const start = typeof current === "number" ? current : 0;
  let lo = Infinity;
  let hi = -Infinity;
  const f = (x: number) => {
    copy.setCell(change.row, change.col, x);
    const v = copy.getCell(set.row, set.col);
    if (typeof v !== "number") return NaN;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    return v;
  };
  const r = goalSeek(f, target, start, opts);
  if (!r.converged && lo === hi) return { ...r, start, reason: `${A1(set)} doesn't change when ${A1(change)} changes. Check that its formula uses ${A1(change)}.` };
  return { ...r, start };
}

// ------------------------------------------------------------- controls --

function field(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const l = document.createElement("label");
  l.append(text, control);
  if (hint) {
    const s = document.createElement("small");
    s.textContent = hint;
    l.append(s);
  }
  return l;
}

function columnSelect(data: SheetData, value = 0, none?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  if (none) sel.append(new Option(none, "-1"));
  data.names.forEach((n, c) => sel.append(new Option(n, String(c))));
  sel.value = String(value);
  return sel;
}

function choice(options: [string, string][], value?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, text] of options) sel.append(new Option(text, v));
  if (value !== undefined) sel.value = value;
  return sel;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function checkbox(text: string, checked = false): { el: HTMLLabelElement; input: HTMLInputElement } {
  const el = document.createElement("label");
  el.className = "tx-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  el.append(input, text);
  return { el, input };
}

/** A list of the sheet's columns with a checkbox each. */
function columnChecks(data: SheetData, checked: (c: number) => boolean): { el: HTMLElement; values: () => number[] } {
  const el = document.createElement("div");
  el.className = "tx-cols";
  const boxes = data.names.map((n, c) => {
    const b = checkbox(n, checked(c));
    el.append(b.el);
    return b.input;
  });
  return { el, values: () => boxes.flatMap((b, c) => (b.checked ? [c] : [])) };
}

/** Columns whose values are mostly numbers (amounts, months of figures). */
function numericColumns(data: SheetData): Set<number> {
  const out = new Set<number>();
  data.names.forEach((_, c) => {
    const vals = data.col(c).slice(0, 200).filter((v) => v !== null);
    if (vals.length && vals.filter((v) => typeof v === "number").length / vals.length > 0.8) out.add(c);
  });
  return out;
}

// ---------------------------------------------------------------- tools --

interface Preview {
  lines: { text: string; warn?: boolean }[];
  table?: string[][];
  /** Does the work, or null when there's nothing to do. */
  apply: (() => Promise<void>) | null;
  ok: string;
}

interface Tool {
  title: string;
  intro: string;
  fields: HTMLElement[];
  compute(): Preview;
}

interface Ctx {
  d: TransformDeps;
  src: EditableSource;
  data: SheetData;
  sheet: string;
  sheetId: string;
}

async function addSheets(d: TransformDeps, sheets: SheetOut[]): Promise<void> {
  for (const s of sheets) {
    const { columns, numFmts } = buildColumns(s.header, s.rows, s.numFmts);
    const source = new EditableSource(new Table(columns), 5);
    await d.run({ type: "sheet.insert", params: { name: s.name.slice(0, 31), source: d.putBlob(source), numFmts } });
  }
}

/** Write planned columns: add columns at the edge first if needed, then one cells.set (one undo step). */
async function writeColumns(c: Ctx, w: ColumnWrite, what: string): Promise<void> {
  if (w.addColumns > 0) await c.d.run({ type: "cols.insert", params: { sheet: c.sheetId, at: c.src.colCount, count: w.addColumns } });
  if (w.cells.length) await c.d.run(setCells(w.cells, what, c.sheetId));
}

/** Lines warning about overwriting and adding columns, and the button text to match. */
function writeWarnings(w: ColumnWrite, verb: string): { lines: Preview["lines"]; ok: string } {
  const lines: Preview["lines"] = [];
  if (w.addColumns) lines.push({ text: `The sheet needs ${plural(w.addColumns, "more column")} on the right; they'll be added first (a separate undo step).` });
  if (w.overwrite) lines.push({ text: `${plural(w.overwrite, "cell")} to the right already ${w.overwrite === 1 ? "has" : "have"} something in ${w.overwrite === 1 ? "it" : "them"} and will be overwritten. Insert empty columns first to keep them.`, warn: true });
  return { lines, ok: w.overwrite ? `Overwrite ${plural(w.overwrite, "cell")} and ${verb}` : verb[0].toUpperCase() + verb.slice(1) };
}

function dedupeTool(c: Ctx): Tool {
  const keys = columnChecks(c.data, () => true);
  const ignoreCase = checkbox("Ignore upper and lower case");
  const trim = checkbox("Ignore extra spaces", true);
  const keep = choice(
    [
      ["first", "Keep the first row of each set"],
      ["last", "Keep the last row of each set"],
    ],
    "first",
  );
  const withRemoved = checkbox("Also add a sheet listing the removed rows");
  return {
    title: "Remove duplicates",
    intro: "Rows count as duplicates when all the ticked columns match. The result goes on a new sheet; this sheet is not changed.",
    fields: [field("Compare these columns", keys.el), ignoreCase.el, trim.el, field("Which row stays", keep), withRemoved.el],
    compute() {
      const cols = keys.values();
      if (!cols.length) return { lines: [{ text: "Tick at least one column to compare.", warn: true }], apply: null, ok: "Add the sheet" };
      const p = dedupePlan(c.data, c.sheet, cols, { ignoreCase: ignoreCase.input.checked, trim: trim.input.checked, keep: keep.value as "first" | "last" }, withRemoved.input.checked);
      const kept = p.sheets[0].rows.length;
      const lines = [{ text: p.removed ? `${plural(p.removed, "duplicate row")} removed (${plural(p.groups, "set")} of duplicates); ${plural(kept, "row")} kept.` : `No duplicates: all ${plural(kept, "row")} are different.` }];
      return {
        lines,
        table: previewOf(p.sheets[0]),
        ok: p.sheets.length > 1 ? "Add the sheets" : "Add the sheet",
        apply: async () => {
          await addSheets(c.d, p.sheets);
          c.d.status(`Remove duplicates: ${plural(p.removed, "row")} removed, ${plural(kept, "row")} kept on "${p.sheets[0].name}"`);
        },
      };
    },
  };
}

function splitTool(c: Ctx): Tool {
  const col = columnSelect(c.data, Math.min(c.d.range().left, c.data.names.length - 1));
  const mode = choice(
    [
      ["delimited", "Split at characters such as commas"],
      ["fixed", "Cut at fixed character positions"],
    ],
    "delimited",
  );
  const delims: [string, string, boolean][] = [
    ["\t", "Tab", false],
    [",", "Comma", true],
    [";", "Semicolon", false],
    [" ", "Space", false],
    ["|", "Bar |", false],
  ];
  const boxes = delims.map(([d, text, on]) => ({ d, ...checkbox(text, on) }));
  const other = textInput("", "other");
  other.setAttribute("aria-label", "Other delimiter");
  const delimBox = document.createElement("div");
  delimBox.className = "tx-delims";
  delimBox.append(...boxes.map((b) => b.el), other);
  const consecutive = checkbox("Treat delimiters in a row as one");
  const qualifier = choice(
    [
      ['"', 'Text in "double quotes" stays together'],
      ["'", "Text in 'single quotes' stays together"],
      ["", "No quotes"],
    ],
    '"',
  );
  const breaks = textInput("", "e.g. 4, 10, 25");
  const delimField = field("Split at", delimBox, "Tick one or more. Other can be several characters, such as \" - \".");
  const qualField = field("Quotes", qualifier);
  const breaksField = field("Cut after character", breaks, "Positions counted from the start, separated by commas.");
  const sync = () => {
    const fixed = mode.value === "fixed";
    delimField.hidden = fixed;
    consecutive.el.hidden = fixed;
    qualField.hidden = fixed;
    breaksField.hidden = !fixed;
  };
  mode.addEventListener("change", sync);
  sync();
  return {
    title: "Text to columns",
    intro: "Splits a column into new columns to its right. Each new column becomes numbers, dates or text by what it holds. With more than one row selected, only those rows are split.",
    fields: [field("Column", col), field("How", mode), delimField, consecutive.el, qualField, breaksField],
    compute() {
      const cIdx = Number(col.value);
      let opts: SplitOptions;
      if (mode.value === "fixed") {
        const b = breaks.value
          .split(/[;,\s]+/)
          .filter(Boolean)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0);
        if (!b.length) return { lines: [{ text: "Type the positions to cut at.", warn: true }], apply: null, ok: "Split" };
        opts = { mode: "fixed", breaks: b };
      } else {
        const ds = boxes.filter((b) => b.input.checked).map((b) => b.d);
        if (other.value) ds.push(other.value);
        if (!ds.length) return { lines: [{ text: "Tick at least one delimiter.", warn: true }], apply: null, ok: "Split" };
        opts = { mode: "delimited", delimiters: ds, consecutiveAsOne: consecutive.input.checked, qualifier: qualifier.value };
      }
      const rows = targetRows(c.data, c.d.range());
      const w = splitPlan(c.src, c.data, cIdx, rows, opts);
      if (w.columns < 2 && mode.value === "delimited") return { lines: [{ text: "Nothing to split: no value has that delimiter.", warn: true }], table: w.preview, apply: null, ok: "Split" };
      const warn = writeWarnings(w, `split into ${plural(w.columns, "column")}`);
      return {
        lines: [{ text: `${plural(rows.length, "row")} into ${plural(w.columns, "new column")}, ${columnLetter(cIdx + 1)} to ${columnLetter(cIdx + w.columns)}.` }, ...warn.lines],
        table: w.preview,
        ok: warn.ok,
        apply: async () => {
          await writeColumns(c, w, `text to columns (${columnLetter(cIdx)})`);
          c.d.status(`Text to columns: ${columnLetter(cIdx)} split into ${plural(w.columns, "column")}`);
        },
      };
    },
  };
}

function unpivotTool(c: Ctx): Tool {
  const nums = numericColumns(c.data);
  const firstNum = c.data.names.findIndex((_, i) => nums.has(i));
  const roles = c.data.names.map((n, i) => {
    const sel = choice(
      [
        ["id", "Keep on every row"],
        ["value", "Turn into rows"],
        ["drop", "Leave out"],
      ],
      firstNum < 0 ? (i === 0 ? "id" : "value") : i < firstNum ? "id" : "value",
    );
    sel.setAttribute("aria-label", n);
    const row = document.createElement("div");
    row.className = "tx-role";
    const name = document.createElement("span");
    name.textContent = n;
    row.append(name, sel);
    return { sel, row };
  });
  const box = document.createElement("div");
  box.className = "tx-roles";
  box.append(...roles.map((r) => r.row));
  const nameCol = textInput("Attribute");
  const valueCol = textInput("Value");
  const skip = checkbox("Leave out blank values", true);
  return {
    title: "Unpivot (columns to rows)",
    intro: "Turns a wide table (one column per month, say) into a long one: one row per value, with the old column name beside it. The result goes on a new sheet.",
    fields: [field("Columns", box), field("Name for the column of old column names", nameCol), field("Name for the column of values", valueCol), skip.el],
    compute() {
      const ids = roles.flatMap((r, i) => (r.sel.value === "id" ? [i] : []));
      const vals = roles.flatMap((r, i) => (r.sel.value === "value" ? [i] : []));
      if (!vals.length) return { lines: [{ text: "Pick at least one column to turn into rows.", warn: true }], apply: null, ok: "Add the sheet" };
      const out = unpivotPlan(c.data, c.sheet, ids, vals, { nameColumn: nameCol.value.trim(), valueColumn: valueCol.value.trim(), skipBlanks: skip.input.checked });
      return {
        lines: [{ text: `${plural(c.data.rows, "row")} × ${plural(vals.length, "column")} → ${plural(out.rows.length, "row")}.` }],
        table: previewOf(out),
        ok: "Add the sheet",
        apply: async () => {
          await addSheets(c.d, [out]);
          c.d.status(`Unpivot: ${plural(out.rows.length, "row")} on "${out.name}"`);
        },
      };
    },
  };
}

function pivotTool(c: Ctx): Tool {
  const nums = numericColumns(c.data);
  const lastNum = [...nums].pop() ?? c.data.names.length - 1;
  const keys = [0, 1, 2].map((i) => columnSelect(c.data, i ? -1 : 0, i ? "(not used)" : undefined));
  const keyBox = document.createElement("div");
  keyBox.className = "tx-keys";
  keyBox.append(...keys);
  const colKey = columnSelect(c.data, Math.min(1, c.data.names.length - 1));
  const valueCol = columnSelect(c.data, lastNum);
  const agg = choice(
    [
      ["sum", "Sum"],
      ["count", "Count"],
      ["avg", "Average"],
      ["min", "Smallest"],
      ["max", "Largest"],
      ["first", "First value"],
    ],
    "sum",
  );
  return {
    title: "Pivot (rows to columns)",
    intro: "Turns a long table into a wide one: one row per distinct row label, one column per distinct value of the column you pick, holding the values combined. The result goes on a new sheet.",
    fields: [field("Row labels from", keyBox), field("New columns from", colKey), field("Values from", valueCol), field("Combine values by", agg)],
    compute() {
      const rk = [...new Set(keys.map((k) => Number(k.value)).filter((k) => k >= 0))];
      const ck = Number(colKey.value);
      const vc = Number(valueCol.value);
      if (rk.includes(ck)) return { lines: [{ text: "The new columns can't come from a row label column.", warn: true }], apply: null, ok: "Add the sheet" };
      const out = pivotPlan(c.data, c.sheet, rk, ck, vc, agg.value as WiderAgg);
      const width = out.header.length - rk.length;
      const lines: Preview["lines"] = [{ text: `${plural(out.rows.length, "row")} × ${plural(width, "new column")}.` }];
      if (width > 500) lines.push({ text: `That's a lot of columns: check that "${label(c.data, ck)}" is the right column to spread out.`, warn: true });
      if (out.skipped) lines.push({ text: `${plural(out.skipped, "value")} that aren't numbers left out.`, warn: true });
      return {
        lines,
        table: previewOf(out),
        ok: "Add the sheet",
        apply: async () => {
          await addSheets(c.d, [out]);
          c.d.status(`Pivot: ${plural(out.rows.length, "row")} × ${plural(width, "column")} on "${out.name}"`);
        },
      };
    },
  };
}

function extractTool(c: Ctx): Tool {
  const col = columnSelect(c.data, Math.min(c.d.range().left, c.data.names.length - 1));
  const kinds = Object.entries(PATTERN_LABELS) as [PatternKind, string][];
  const kind = choice(kinds, "code");
  const keyword = textInput("Ref", "e.g. Ref, Invoice, PO");
  const regex = textInput("", "e.g. Order (\\d+)");
  const keywordField = field("Keyword", keyword, "The text right after it is taken, skipping : # . - and spaces.");
  const regexField = field("Pattern", regex, "A regular expression. With a (capture group), only that part is taken.");
  const all = checkbox("Take every match, separated by ;");
  const flag = checkbox("Also add a column saying whether anything was found");
  const sync = () => {
    keywordField.hidden = kind.value !== "after";
    regexField.hidden = kind.value !== "regex";
  };
  kind.addEventListener("change", sync);
  sync();
  return {
    title: "Extract by pattern",
    intro: "Pulls a piece out of text (bank narratives, memo lines) into a new column to the right of it. With more than one row selected, only those rows are read.",
    fields: [field("Column", col), field("Find", kind), keywordField, regexField, all.el, flag.el],
    compute() {
      const k = kind.value as PatternKind;
      const spec: PatternSpec = k === "after" ? { kind: "after", keyword: keyword.value } : k === "regex" ? { kind: "regex", regex: regex.value } : { kind: k };
      if (k === "after" && !keyword.value.trim()) return { lines: [{ text: "Type the keyword the reference follows.", warn: true }], apply: null, ok: "Add the column" };
      const cIdx = Number(col.value);
      const rows = targetRows(c.data, c.d.range());
      const w = extractPlan(c.src, c.data, cIdx, rows, spec, { all: all.input.checked, flag: flag.input.checked });
      const verb = w.columns > 1 ? "add the columns" : "add the column";
      const warn = writeWarnings(w, verb);
      return {
        lines: [{ text: `Found in ${count(w.found)} of ${plural(rows.length, "row")}.`, warn: w.found === 0 }, ...warn.lines],
        table: w.preview,
        ok: warn.ok,
        apply: w.found
          ? async () => {
              await writeColumns(c, w, `extract ${PATTERN_LABELS[k].toLowerCase()} (${columnLetter(cIdx)})`);
              c.d.status(`Extract: found in ${count(w.found)} of ${plural(rows.length, "row")}, written to ${columnLetter(cIdx + 1)}`);
            }
          : null,
      };
    },
  };
}

function goalSeekTool(c: Ctx): Tool {
  const sel = c.d.selection();
  const setCell = textInput(A1(sel), "e.g. C10");
  const toValue = textInput("", "e.g. 1000");
  const byCell = textInput("", "e.g. B3");
  return {
    title: "Goal Seek",
    intro: "Finds the value for one input cell that makes a formula give the result you want. Nothing changes until you keep the value, and then it's one undo step.",
    fields: [field("Set cell", setCell, "A cell with a formula."), field("To value", toValue), field("By changing cell", byCell, "A cell with a number that the formula depends on.")],
    compute() {
      const set = parseCellRef(setCell.value);
      const by = parseCellRef(byCell.value);
      const target = Number(toValue.value.replace(/[,\s]/g, ""));
      if (!set || !by || toValue.value.trim() === "" || !Number.isFinite(target)) return { lines: [{ text: "Fill in the three boxes: cells like B3, and a number to reach." }], apply: null, ok: "Keep this value" };
      if (set.row >= c.src.rowCount || set.col >= c.src.colCount || by.row >= c.src.rowCount || by.col >= c.src.colCount) throw new Error("That cell is outside the sheet.");
      const r = seekOnClone(c.src, set, by, target);
      const fmtSet = c.src.getStyle(set.row, set.col)?.numFmt;
      const fmtBy = c.src.getStyle(by.row, by.col)?.numFmt;
      const lines: Preview["lines"] = [];
      if (r.converged) lines.push({ text: `${A1(by)} = ${formatValue(r.x, fmtBy).text} makes ${A1(set)} = ${formatValue(r.value, fmtSet).text} (found in ${plural(r.iterations, "step")}).` });
      else {
        lines.push({ text: r.reason ?? "No answer found.", warn: true });
        if (Number.isFinite(r.value)) lines.push({ text: `Closest: ${A1(by)} = ${formatValue(r.x, fmtBy).text} gives ${A1(set)} = ${formatValue(r.value, fmtSet).text}.` });
      }
      lines.push({ text: `${A1(by)} is ${formatValue(r.start, fmtBy).text} now.` });
      const usable = Number.isFinite(r.x) && Number.isFinite(r.value) && r.x !== r.start;
      return {
        lines,
        ok: r.converged ? "Keep this value" : "Keep the closest value",
        apply: usable
          ? async () => {
              await c.d.run(setCells([{ row: by.row, col: by.col, input: String(r.x) }], `goal seek ${A1(set)} = ${toValue.value.trim()}`, c.sheetId));
              c.d.status(`Goal Seek: ${A1(by)} set to ${formatValue(r.x, fmtBy).text}`);
            }
          : null,
      };
    },
  };
}

const TOOLS: Record<TransformKind, (c: Ctx) => Tool> = {
  dedupe: dedupeTool,
  split: splitTool,
  unpivot: unpivotTool,
  pivot: pivotTool,
  extract: extractTool,
  goalseek: goalSeekTool,
};

// --------------------------------------------------------------- dialog --

export function openTransform(kind: TransformKind, d: TransformDeps): void {
  const src = d.source();
  const data = readSheet(src);
  const c: Ctx = { d, src, data, sheet: d.sheetName().slice(0, 18), sheetId: d.activeSheet() };
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog" role="dialog"><div class="palette-form tx-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  const h = document.createElement("h3");
  const buttons = document.createElement("div");
  buttons.className = "numfmt-actions";

  if (kind !== "goalseek" && (!data.names.length || !data.rows)) {
    h.textContent = "Nothing to work on";
    const p = document.createElement("p");
    p.textContent = "This sheet has no data. Open or paste the data first; the first row (or the column names) should name the columns.";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "Close";
    ok.addEventListener("click", close);
    buttons.append(ok);
    body.append(h, p, buttons);
    document.body.append(back);
    ok.focus();
    return;
  }

  const tool = TOOLS[kind](c);
  back.querySelector(".palette")!.setAttribute("aria-label", tool.title);
  h.textContent = tool.title;
  const intro = document.createElement("p");
  intro.className = "hp-muted";
  intro.textContent = tool.intro;
  const fields = document.createElement("div");
  fields.className = "fields";
  fields.append(...tool.fields);
  const result = document.createElement("div");
  result.className = "tx-result";
  result.setAttribute("aria-live", "polite");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  buttons.append(cancel, okBtn);
  body.append(h, intro, fields, result, buttons);

  let preview: Preview | null = null;
  const update = () => {
    result.replaceChildren();
    try {
      preview = tool.compute();
    } catch (e) {
      preview = null;
      const p = document.createElement("p");
      p.className = "cleanup-warn";
      p.textContent = (e as Error).message;
      result.append(p);
      okBtn.disabled = true;
      return;
    }
    for (const l of preview.lines) {
      const p = document.createElement("p");
      p.textContent = l.text;
      if (l.warn) p.className = "cleanup-warn";
      result.append(p);
    }
    if (preview.table) {
      const table = document.createElement("table");
      preview.table.forEach((row, i) => {
        const tr = document.createElement("tr");
        for (const v of row) {
          const cell = document.createElement(i ? "td" : "th");
          cell.textContent = v;
          tr.append(cell);
        }
        table.append(tr);
      });
      const wrap = document.createElement("div");
      wrap.className = "import-preview";
      wrap.append(table);
      result.append(wrap);
    }
    okBtn.textContent = preview.ok;
    okBtn.disabled = !preview.apply;
  };
  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(update, 200);
  };
  fields.addEventListener("input", later);
  fields.addEventListener("change", later);
  update();

  cancel.addEventListener("click", close);
  okBtn.addEventListener("click", () => {
    clearTimeout(timer);
    update();
    const apply = preview?.apply;
    if (!apply) return;
    back.remove();
    void apply()
      .catch((e: unknown) => d.status((e as Error).message))
      .finally(() => d.focusGrid());
  });
  document.body.append(back);
  (fields.querySelector(kind === "goalseek" ? "label:nth-child(2) input" : "select, input") as HTMLElement | null)?.focus();
}
