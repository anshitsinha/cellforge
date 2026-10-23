/**
 * The audit tests as dialogs: pick columns of the active sheet, set the
 * test's options, see a summary, and add the result as a new sheet. Every
 * result keeps the original sheet row number so items can be traced back.
 */
import type { Action } from "@cellforge/actions";
import { dateParts, formatValue, parseDateLoose, Table, type ColumnData, type DateOrder } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import {
  ageing,
  benford,
  findDuplicates,
  musSample,
  newSeed,
  pareto,
  randomSample,
  sequenceCode,
  sequenceGaps,
  stratifiedSample,
  stratify,
  systematicSample,
  topN,
  type AuditValue,
  type BenfordTest,
  type DupKey,
  type SampleResult,
} from "@cellforge/core";
import { namedHeader } from "./cleanup";
import { EditableSource } from "./editable";
import { dataExtent } from "./usedrange";
import "./audittools.css";
import { columnKind, defaultDuplicateKeys, firstOfKind, formatForKind, guessRoles, type ColumnKind, type ColumnSample } from "./colguess";
import { activeSheetId, button, el, emptyState, field as tkField, headline, navigator, notice, report, section, type HeadlineOptions } from "./toolkit";
import { setCells } from "./actions";
import { currentWorkbook } from "./checksui";
import { RESULTS_ROWS, type ResultsTest } from "./templates";
import type { Workbook } from "./workbook";
import { openSidePanel } from "./ui/sidepanel";
import { renderTable, type TableColumn } from "./ui/table";

export type AuditToolKind = "duplicates" | "sequence" | "benford" | "stratify" | "topn" | "pareto" | "ageing" | "sample";

export interface AuditDeps {
  source: () => EditableSource;
  sheetName: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
  /** show a sheet row (makes result rows links); optional */
  goTo?: (sheetId: string, row: number, col: number) => void;
  /** the sheet on screen, for goTo; optional */
  activeSheet?: () => string;
  /** the workbook, to record results on its Results sheet; optional (the bound one otherwise) */
  workbook?: () => Workbook;
}

// ------------------------------------------------------ the Results sheet --

/** What a test found, for the audit template's Results sheet. */
export interface TestOutcome {
  test: ResultsTest;
  /** exceptions found; null when the test doesn't find exceptions (a sample) */
  exceptions: number | null;
  /** status to set; default "Done: exceptions" / "Done: no exceptions" */
  status?: string;
  /** one line: what was run and where the detail is */
  detail: string;
  /** a new label for the test's row ("Sample (seed 154)") */
  label?: string;
}

/** The audit template's Results sheet: "Test" and "Status" headers, the test names down column A. */
export function resultsSheet(wb: Pick<Workbook, "sheets">): { id: string; name: string } | null {
  for (const s of wb.sheets) {
    if (String(s.source.getCell(0, 0) ?? "").trim() === "Test" && String(s.source.getCell(0, 1) ?? "").trim() === "Status") return { id: s.id, name: s.name };
  }
  return null;
}

/** The cells that record an outcome on Results (status, exceptions, detail; the conclusion stays the auditor's). Pure. */
export function outcomeCells(o: TestOutcome): { row: number; col: number; input: string | null }[] {
  const row = RESULTS_ROWS[o.test];
  const status = o.status ?? (o.exceptions ? "Done: exceptions" : "Done: no exceptions");
  const cells = [
    { row, col: 1, input: status },
    { row, col: 2, input: o.exceptions === null ? null : String(o.exceptions) },
    { row, col: 5, input: o.detail },
  ];
  if (o.label) cells.push({ row, col: 0, input: o.label });
  return cells;
}

/**
 * Record a test's outcome on the workbook's Results sheet, when it has one
 * (the audit template), with a link from the detail to the results sheet.
 * Every run writes it again, so rerunning a test updates Results. For the
 * other audit tools too (the journal entry tests): call it after adding
 * their results sheet.
 */
export async function recordOnResults(wb: Workbook | null | undefined, run: (a: Action) => Promise<unknown>, o: TestOutcome, resultSheet?: string): Promise<boolean> {
  const res = wb ? resultsSheet(wb) : null;
  if (!res) return false;
  await run(setCells(outcomeCells(o), `record ${o.test} on ${res.name}`, res.id));
  if (resultSheet) await run({ type: "cells.extra", params: { row: RESULTS_ROWS[o.test], col: 5, link: `#'${resultSheet.replace(/'/g, "''")}'!A1`, sheet: res.id } });
  return true;
}

const MONEY = "#,##0.00;(#,##0.00)";
const PCT = "0.0%";
const money = (n: number) => formatValue(n, MONEY).text;
const pct = (n: number) => formatValue(n, PCT).text;
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${count(n)} ${n === 1 ? one : many}`;

// ------------------------------------------------------------ the sheet --

/** The active sheet as columns: names from the grid header or the first row, values below. */
export interface SheetData {
  names: string[];
  /** First data row (1 when the first row holds the names). */
  first: number;
  /** Data rows. */
  rows: number;
  col(c: number): AuditValue[];
  numFmt(c: number): string;
  /** Sheet row number (as shown in the grid) of data row i. */
  sheetRow(i: number): number;
  /** Data row indexes that have at least one value. */
  nonBlank(): number[];
}

export function readSheet(src: EditableSource): SheetData {
  // the rows that show data: a template's formula rows that show "" aren't data
  const { rows, cols } = dataExtent(src);
  const named = namedHeader(src);
  const first = named ? 0 : 1;
  const names = Array.from({ length: cols }, (_, c) => {
    const raw = named ? named[c] : src.getCell(0, c);
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    return text ? `${columnLetter(c)}: ${text}` : `Column ${columnLetter(c)}`;
  });
  const cache = new Map<number, AuditValue[]>();
  const n = Math.max(0, rows - first);
  return {
    names,
    first,
    rows: n,
    col(c) {
      let v = cache.get(c);
      if (!v) {
        v = new Array<AuditValue>(n);
        for (let i = 0; i < n; i++) {
          const x = src.getCell(i + first, c);
          v[i] = typeof x === "string" && !x.trim() ? null : x;
        }
        cache.set(c, v);
      }
      return v;
    },
    numFmt(c) {
      return src.getStyle(first, c)?.numFmt ?? "";
    },
    sheetRow: (i) => i + first + 1,
    nonBlank() {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < cols; c++) {
          const x = src.getCell(i + first, c);
          if (x !== null && x !== "") {
            out.push(i);
            break;
          }
        }
      }
      return out;
    },
  };
}

/** The columns as samples for colguess (header names without the "A: " prefix). */
export function sheetSamples(data: SheetData, max = 300): ColumnSample[] {
  return data.names.map((n, c) => ({ name: /^Column [A-Z]+$/.test(n) ? "" : n.replace(/^[A-Z]+: /, ""), values: data.col(c).slice(0, max), numFmt: data.numFmt(c) }));
}

const kinds = new WeakMap<SheetData, ColumnKind[]>();
/** Each column's kind (cached per read). */
export function columnKinds(data: SheetData): ColumnKind[] {
  let k = kinds.get(data);
  if (!k) {
    k = sheetSamples(data).map(columnKind);
    kinds.set(data, k);
  }
  return k;
}

/** Day-first unless some text date can only be month-first. */
function guessDateOrder(values: AuditValue[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const p = dateParts(v);
    if (!p || p[0] > 31) continue;
    if (p[0] > 12) dmy++;
    else if (p[1] > 12) mdy++;
    if (dmy + mdy > 50) break;
  }
  return mdy > dmy ? "mdy" : "dmy";
}

// --------------------------------------------------------- result columns --

function textCol(name: string, values: string[]): ColumnData {
  const dict: string[] = [];
  const lookup = new Map<string, number>();
  const codes = Uint32Array.from(values, (v) => {
    if (!v) return 0;
    let c = lookup.get(v);
    if (c === undefined) {
      c = dict.push(v);
      lookup.set(v, c);
    }
    return c;
  });
  return { kind: "string", name, codes, dict };
}

function numCol(name: string, values: ArrayLike<number | null>): ColumnData {
  return { kind: "number", name, values: Float64Array.from({ length: values.length }, (_, i) => values[i] ?? NaN) };
}

/** A result being built: columns with their number formats. */
class Out {
  columns: ColumnData[] = [];
  numFmts: string[] = [];
  text(name: string, values: string[]): this {
    this.columns.push(textCol(name, values));
    this.numFmts.push("");
    return this;
  }
  num(name: string, values: ArrayLike<number | null>, fmt = ""): this {
    this.columns.push(numCol(name, values));
    this.numFmts.push(fmt);
    return this;
  }
  /** Every column of the sheet, for these data rows (null = an empty row). */
  copy(data: SheetData, rows: (number | null)[]): this {
    data.names.forEach((name, c) => {
      const all = data.col(c);
      const vals = rows.map((r) => (r === null ? null : all[r]));
      const label = name.replace(/^[A-Z]+: /, "");
      if (vals.every((v) => v === null || typeof v === "number")) this.num(label, vals as (number | null)[], data.numFmt(c));
      else this.text(label, vals.map((v) => (v === null ? "" : String(v))));
    });
    return this;
  }
}

interface Preview {
  lines: { text: string; warn?: boolean }[];
  /** the headline figure for the result */
  headline?: HeadlineOptions;
  table?: string[][];
  /** a formatted table whose rows can link to a sheet row (1-based, as shown) */
  grid?: { columns: TableColumn<Record<string, unknown>>[]; rows: Record<string, unknown>[]; sheetRow?: (r: Record<string, unknown>) => number; empty?: string };
  chart?: SVGSVGElement;
  /** The sheets to add, or null when there's nothing to add. */
  sheets: { name: string; out: Out }[] | null;
  done: string;
  /** what to record on the audit template's Results sheet */
  outcome?: Omit<TestOutcome, "detail"> & { detail: string };
}

interface Tool {
  title: string;
  intro: string;
  fields: HTMLElement[];
  compute(): Preview;
}

// ------------------------------------------------------------- controls --

const field = (label: string, control: HTMLElement, hint?: string): HTMLLabelElement => tkField(label, control, hint);

function columnSelect(data: SheetData, opts: { none?: string; prefer?: "number" | "date" | "text"; skip?: number } = {}): HTMLSelectElement {
  const sel = document.createElement("select");
  if (opts.none) sel.append(new Option(opts.none, "-1"));
  data.names.forEach((n, c) => sel.append(new Option(n, String(c))));
  if (opts.prefer) {
    const samples = sheetSamples(data);
    const roles = guessRoles(samples);
    const kinds = columnKinds(data);
    let pick = -1;
    if (opts.prefer === "number") pick = roles.amount >= 0 ? roles.amount : firstOfKind(samples, ["amount", "number"]);
    else if (opts.prefer === "date") pick = roles.date >= 0 ? roles.date : firstOfKind(samples, ["date"]);
    else pick = roles.party >= 0 ? roles.party : roles.description >= 0 ? roles.description : kinds.findIndex((k) => k === "text");
    if (pick === opts.skip) pick = -1;
    if (pick >= 0) sel.value = String(pick);
  }
  return sel;
}

function numberInput(value: number | string, attrs: { min?: number; step?: string; placeholder?: string } = {}): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.value = String(value);
  if (attrs.min !== undefined) i.min = String(attrs.min);
  i.step = attrs.step ?? "any";
  if (attrs.placeholder) i.placeholder = attrs.placeholder;
  return i;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function choice(options: [string, string][], value?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, label] of options) sel.append(new Option(label, v));
  if (value !== undefined) sel.value = value;
  return sel;
}

function checkbox(label: string, checked = false): { el: HTMLLabelElement; input: HTMLInputElement } {
  const el = document.createElement("label");
  el.className = "tk-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  el.append(input, label);
  return { el, input };
}

/** "0, 1000; 50000" as numbers (no thousands separators: commas and spaces split the list). */
function numberList(text: string): number[] {
  return text
    .split(/[;,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

const colOf = (sel: HTMLSelectElement) => Number(sel.value);
const label = (data: SheetData, c: number) => data.names[c].replace(/^[A-Z]+: /, "");
const sheetRows = (data: SheetData, rows: number[], max = 12) => rows.slice(0, max).map((r) => data.sheetRow(r)).join(", ") + (rows.length > max ? ` and ${rows.length - max} more` : "");

// ---------------------------------------------------------------- tools --

function duplicatesTool(data: SheetData, sheet: string): Tool {
  const HOW: [string, string][] = [
    ["exact", "Exactly"],
    ["text", "Same text, any case"],
    ["fuzzy", "Similar (% alike)"],
    ["number", "Number within"],
    ["date", "Date within (days)"],
  ];
  const guess = defaultDuplicateKeys(sheetSamples(data));
  const keys = [0, 1, 2].map((i) => {
    const col = columnSelect(data, { none: "(not used)" });
    col.value = String(guess[i]?.col ?? -1);
    col.setAttribute("aria-label", `Key column ${i + 1}`);
    const how = choice(HOW, guess[i]?.how === "text" ? "text" : "exact");
    how.setAttribute("aria-label", `How key ${i + 1} must match`);
    const tol = numberInput("", { min: 0 });
    const row = document.createElement("div");
    row.className = "audit-key";
    row.append(col, how, tol);
    const sync = () => {
      const h = how.value;
      tol.hidden = h === "exact" || h === "text";
      if (h === "fuzzy" && (tol.value === "" || Number(tol.value) > 100 || Number(tol.value) < 50)) tol.value = "90";
      if (h === "number" && tol.value === "") tol.value = "0.01";
      if (h === "date" && tol.value === "") tol.value = "3";
      tol.setAttribute("aria-label", h === "fuzzy" ? "Percent alike" : h === "date" ? "Days apart" : "Largest difference");
    };
    how.addEventListener("change", () => {
      tol.value = "";
      sync();
    });
    sync();
    return { col, how, tol, row };
  });
  const box = document.createElement("div");
  box.className = "audit-keys";
  box.append(...keys.map((k) => k.row));
  return {
    title: "Find duplicates",
    intro: "Rows count as duplicates when every key column matches. Blank keys are never duplicates. Near matches chain: if A is near B and B is near C, all three are one group.",
    fields: [field("Key columns and how they must match", box, "Starts on the classic test: same vendor (or reference) and same amount. Add an invoice date within 7 days to catch re-keyed invoices.")],
    compute() {
      const used = keys.filter((k) => colOf(k.col) >= 0);
      if (!used.length) return { lines: [{ text: "Pick at least one key column.", warn: true }], sheets: null, done: "" };
      const dk: DupKey[] = used.map((k) => {
        const values = data.col(colOf(k.col));
        const t = Number(k.tol.value) || 0;
        switch (k.how.value) {
          case "text":
            return { values, match: "text" };
          case "fuzzy":
            return { values, match: "text", similarity: Math.min(1, Math.max(0.5, t / 100)) };
          case "number":
            return { values, match: "number", tolerance: t };
          case "date":
            return { values, match: "date", tolerance: t, dateOrder: guessDateOrder(values) };
          default:
            return { values };
        }
      });
      const r = findDuplicates(dk);
      const lines: Preview["lines"] = [];
      if (!r.groups.length) lines.push({ text: `No duplicates in ${plural(data.rows, "row")}.` });
      else lines.push({ text: `${plural(r.groups.length, "group")} of duplicates, ${plural(r.flagged, "row")} in all.`, warn: true });
      if (r.blanks) lines.push({ text: `${plural(r.blanks, "row")} left out because a key is blank${used.some((k) => k.how.value === "number" || k.how.value === "date") ? " or not a number / date" : ""}.` });
      const kinds = columnKinds(data);
      const keyCols = used.map((k) => colOf(k.col));
      const grid: Preview["grid"] = {
        columns: [
          ...keyCols.map((c) => ({ key: `k${c}`, label: label(data, c), format: formatForKind(kinds[c]) })),
          { key: "n", label: "Rows", format: "integer" as const },
          { key: "where", label: "Sheet rows" },
        ],
        rows: r.groups.slice(0, 500).map((g) => {
          const row: Record<string, unknown> = { n: g.rows.length, where: sheetRows(data, g.rows, 6), first: data.sheetRow(g.rows[0]) };
          for (const c of keyCols) row[`k${c}`] = data.col(c)[g.rows[0]];
          return row;
        }),
        sheetRow: (x) => x.first as number,
        empty: "No duplicates.",
      };
      const keyNames = keyCols.map((c) => label(data, c)).join(" + ");
      const rows: (number | null)[] = [];
      const group: (number | null)[] = [];
      r.groups.forEach((g, i) => {
        for (const row of g.rows) {
          rows.push(row);
          group.push(i + 1);
        }
      });
      const out = new Out()
        .num("Group", group)
        .num(
          "Row",
          rows.map((x) => data.sheetRow(x!)),
        )
        .copy(data, rows);
      lines.shift();
      return {
        lines,
        headline: {
          value: count(r.groups.length),
          unit: r.groups.length === 1 ? "group of duplicates" : "groups of duplicates",
          tone: r.groups.length ? "mismatch" : "match",
          caption: r.groups.length ? `${plural(r.flagged, "row")} share the same ${keyNames}. Click a group to see its first row.` : `No two rows share the same ${keyNames}, out of ${plural(data.rows, "row")}.`,
        },
        grid: r.groups.length ? grid : undefined,
        sheets: r.groups.length ? [{ name: `${sheet} duplicates`, out }] : null,
        done: `Duplicates: ${plural(r.groups.length, "group")}, ${plural(r.flagged, "row")}`,
        outcome: { test: "duplicates", exceptions: r.groups.length, detail: `Same ${keyNames}: ${plural(r.groups.length, "group")}, ${plural(r.flagged, "row")}` },
      };
    },
  };
}

/**
 * Does this column look like a journal's entry numbers, where every line of
 * an entry repeats its number? True when at least a fifth of the filled rows
 * repeat the row above. Pure.
 */
export function looksLikeEntryLines(values: readonly AuditValue[]): boolean {
  let filled = 0;
  let repeats = 0;
  let prev: AuditValue = null;
  for (const v of values) {
    if (v === null || v === "") continue;
    filled++;
    if (prev !== null && String(prev) === String(v)) repeats++;
    prev = v;
  }
  return filled >= 4 && repeats / filled >= 0.2;
}

/**
 * Gaps in a sequence. With `entries`, the lines of one entry (the same
 * number on consecutive rows) count once, so a journal is tested over its
 * distinct entry numbers: a number that comes back later, after other
 * entries, is still "used more than once". Row numbers in the result are
 * data rows of `values`. Pure.
 */
export function sequenceTest(values: readonly AuditValue[], entries: boolean): ReturnType<typeof sequenceGaps> & { entries: number } {
  if (!entries) {
    const r = sequenceGaps(values as AuditValue[]);
    return { ...r, entries: values.filter((v) => v !== null && v !== "").length };
  }
  const kept: AuditValue[] = [];
  const rowOf: number[] = [];
  let prev: AuditValue = null;
  values.forEach((v, i) => {
    if (v === null || v === "") return;
    if (prev !== null && String(prev) === String(v)) return;
    kept.push(v);
    rowOf.push(i);
    prev = v;
  });
  const r = sequenceGaps(kept);
  const at = (i: number) => rowOf[i];
  return {
    ...r,
    entries: kept.length,
    skipped: r.skipped.map(at),
    series: r.series.map((s) => ({ ...s, duplicates: s.duplicates.map((x) => ({ ...x, rows: x.rows.map(at) })), outOfOrder: s.outOfOrder.map((o) => ({ ...o, row: at(o.row) })) })),
  };
}

function sequenceTool(data: SheetData, sheet: string): Tool {
  const col = columnSelect(data);
  const perEntry = checkbox("Lines of one entry share its number: test distinct entries", looksLikeEntryLines(data.col(0)));
  col.addEventListener("change", () => (perEntry.input.checked = looksLikeEntryLines(data.col(colOf(col)))));
  return {
    title: "Find gaps in a sequence",
    intro: "For invoice, cheque, journal or receipt numbers. Codes like INV-0001 work too; codes with different text around the number are checked as separate series.",
    fields: [field("Numbers in", col), perEntry.el],
    compute() {
      const values = data.col(colOf(col));
      const r = sequenceTest(values, perEntry.input.checked);
      const lines: Preview["lines"] = [];
      const table = [["Series", "First", "Last", "Count", "Missing", "Used twice or more", "Out of order"]];
      const series: string[] = [];
      const issue: string[] = [];
      const from: string[] = [];
      const to: string[] = [];
      const counts: number[] = [];
      const where: string[] = [];
      const add = (s: string, i: string, f: string, t: string, n: number, w: string) => {
        series.push(s);
        issue.push(i);
        from.push(f);
        to.push(t);
        counts.push(n);
        where.push(w);
      };
      for (const s of r.series) {
        const name = s.prefix + "#".repeat(Math.max(1, s.width)) + s.suffix;
        const code = (n: number) => sequenceCode(s, n);
        table.push([name, code(s.first), code(s.last), count(s.count), count(s.missingCount), count(s.duplicates.length), count(s.outOfOrder.length)]);
        for (const g of s.missing) add(name, "missing", code(g.from), code(g.to), g.count, "");
        for (const d of s.duplicates) add(name, "used more than once", code(d.number), "", d.rows.length, sheetRows(data, d.rows, 1000));
        for (const o of s.outOfOrder) add(name, "out of order", code(o.number), `after ${code(o.previous)}`, 1, String(data.sheetRow(o.row)));
      }
      const missing = r.series.reduce((a, s) => a + s.missingCount, 0);
      const dups = r.series.reduce((a, s) => a + s.duplicates.length, 0);
      const ooo = r.series.reduce((a, s) => a + s.outOfOrder.length, 0);
      const journal = perEntry.input.checked;
      if (!r.series.length) lines.push({ text: "No numbers found in this column.", warn: true });
      else {
        lines.push({ text: `${journal ? `${plural(r.entries, "entry", "entries")} (lines of one entry counted once). ` : ""}${plural(missing, "number")} missing, ${plural(dups, "number")} used more than once, ${plural(ooo, journal ? "entry" : "row", journal ? "entries" : "rows")} out of order.`, warn: missing + dups + ooo > 0 });
        if (r.series.length > 1) lines.push({ text: `${plural(r.series.length, "series", "series")}: a stray code with a different prefix shows up as its own series.` });
      }
      if (r.skipped.length) lines.push({ text: `${plural(r.skipped.length, "row")} without a whole number left out (blank, text only, or a fraction).` });
      const out = new Out().text("Series", series).text("Issue", issue).text("Number", from).text("To", to).num("Count", counts).text("Sheet rows", where);
      return {
        lines,
        headline: r.series.length ? { value: count(missing + dups + ooo), unit: missing + dups + ooo === 1 ? "exception" : "exceptions", tone: missing + dups + ooo ? "mismatch" : "match", caption: lines.shift()!.text } : undefined,
        table: r.series.length ? table : undefined,
        sheets: series.length ? [{ name: `${sheet} gaps`, out }] : null,
        done: `Sequence: ${plural(missing, "missing number")}, ${plural(dups, "duplicate")}, ${count(ooo)} out of order`,
        outcome: r.series.length ? { test: "sequence", exceptions: missing + dups + ooo, detail: `${label(data, colOf(col))}${journal ? ` (${plural(r.entries, "entry", "entries")})` : ""}: ${plural(missing, "missing number")}, ${plural(dups, "number")} used twice, ${count(ooo)} out of order` } : undefined,
      };
    },
  };
}

function benfordChart(digits: { digit: number; expected: number; actual: number; z: number }[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const W = 560;
  const H = 150;
  const pad = 18;
  const max = Math.max(...digits.map((d) => Math.max(d.expected, d.actual)), 0.01);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "audit-chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Actual digit shares as bars, Benford's expected shares as a line");
  const bw = (W - 2 * pad) / digits.length;
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  let path = "";
  digits.forEach((d, i) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", String(pad + i * bw + bw * 0.12));
    r.setAttribute("width", String(bw * 0.76));
    r.setAttribute("y", String(y(d.actual)));
    r.setAttribute("height", String(Math.max(0, H - pad - y(d.actual))));
    r.setAttribute("class", d.z > 1.96 ? "audit-bar audit-bar-hot" : "audit-bar");
    const t = document.createElementNS(ns, "title");
    t.textContent = `${d.digit}: actual ${pct(d.actual)}, expected ${pct(d.expected)}, z ${d.z.toFixed(2)}`;
    r.append(t);
    svg.append(r);
    path += `${i ? "L" : "M"}${pad + (i + 0.5) * bw},${y(d.expected)}`;
    if (digits.length <= 9 || d.digit % 10 === 0) {
      const tx = document.createElementNS(ns, "text");
      tx.setAttribute("x", String(pad + (i + 0.5) * bw));
      tx.setAttribute("y", String(H - 4));
      tx.setAttribute("class", "audit-axis");
      tx.textContent = String(d.digit);
      svg.append(tx);
    }
  });
  const line = document.createElementNS(ns, "path");
  line.setAttribute("d", path);
  line.setAttribute("class", "audit-expected");
  svg.append(line);
  return svg;
}

const CONFORMITY: Record<string, string> = {
  close: "close conformity",
  acceptable: "acceptable conformity",
  marginal: "marginally acceptable conformity",
  nonconformity: "nonconformity",
};

function benfordTool(data: SheetData, sheet: string): Tool {
  const col = columnSelect(data, { prefer: "number" });
  const test = choice(
    [
      ["first", "First digit (1-9)"],
      ["firstTwo", "First two digits (10-99)"],
    ],
    "first",
  );
  return {
    title: "Benford's law test",
    intro: "Compares how often each leading digit appears with what Benford's law expects. Zeros, blanks and text are left out; so are values under 10 for the first-two-digits test. Works best with a few thousand amounts or more that span several orders of magnitude.",
    fields: [field("Amounts in", col), field("Test", test)],
    compute() {
      const r = benford(data.col(colOf(col)), test.value as BenfordTest);
      const lines: Preview["lines"] = [];
      if (!r.n) {
        lines.push({ text: "No usable amounts in this column.", warn: true });
        return { lines, sheets: null, done: "" };
      }
      const chiOk = r.chiSquare <= r.critical5;
      lines.push({ text: `${plural(r.n, "value")} tested, ${count(r.ignored)} left out.` });
      lines.push({ text: `MAD ${r.mad.toFixed(4)}: ${CONFORMITY[r.conformity]} (Nigrini: close up to ${r.bands[0]}, acceptable up to ${r.bands[1]}, marginal up to ${r.bands[2]}).`, warn: r.conformity === "nonconformity" || r.conformity === "marginal" });
      lines.push({ text: `Chi-square ${r.chiSquare.toFixed(2)} with ${r.df} degrees of freedom (${chiOk ? "below" : "above"} ${r.critical5.toFixed(2)}, the 5% level; p ${r.pValue < 0.0001 ? "< 0.0001" : "= " + r.pValue.toFixed(4)}).`, warn: !chiOk });
      if (r.n > 5000 && !chiOk) lines.push({ text: "With this many values chi-square flags even small differences; MAD is the better guide." });
      const hot = r.digits.filter((d) => d.z > 1.96).sort((a, b) => b.z - a.z);
      if (hot.length) lines.push({ text: `Digits that stand out (z above 1.96): ${hot.slice(0, 8).map((d) => `${d.digit} (${d.actual > d.expected ? "more" : "fewer"} than expected)`).join(", ")}${hot.length > 8 ? "…" : ""}.`, warn: true });
      const summary = [
        ["Values tested", `${count(r.n)} (${count(r.ignored)} left out: zero, blank, not a number${r.test === "firstTwo" ? " or under 10" : ""})`],
        ["MAD", `${r.mad.toFixed(5)}: ${CONFORMITY[r.conformity]}`],
        ["Chi-square", `${r.chiSquare.toFixed(2)}, ${r.df} degrees of freedom, 5% critical value ${r.critical5.toFixed(2)}, p ${r.pValue < 0.0001 ? "< 0.0001" : "= " + r.pValue.toFixed(4)}`],
      ];
      const pad = <T,>(a: T[], fill: T) => [...a, ...Array<T>(summary.length + 1).fill(fill)];
      const out = new Out()
        .text("Digit", [...r.digits.map((d) => String(d.digit)), "", ...summary.map((s) => s[0])])
        .num("Expected share", pad(r.digits.map((d) => d.expected), null), PCT)
        .num("Actual share", pad(r.digits.map((d) => d.actual), null), PCT)
        .num("Expected count", pad(r.digits.map((d) => Math.round(d.expectedCount * 10) / 10), null), "#,##0.0")
        .num("Actual count", pad(r.digits.map((d) => d.count), null), "#,##0")
        .num("Difference", pad(r.digits.map((d) => Math.round((d.count - d.expectedCount) * 10) / 10), null), "#,##0.0")
        .num("Z", pad(r.digits.map((d) => Math.round(d.z * 1000) / 1000), null), "0.000")
        .text("Note", [...r.digits.map((d) => (d.z > 1.96 ? (d.count > d.expectedCount ? "more than expected" : "fewer than expected") : "")), "", ...summary.map((s) => s[1])]);
      return {
        lines: lines.slice(2),
        headline: { value: r.mad.toFixed(4), unit: "MAD", tone: r.conformity === "nonconformity" ? "mismatch" : r.conformity === "marginal" ? "unmatched" : "match", caption: `${CONFORMITY[r.conformity][0].toUpperCase()}${CONFORMITY[r.conformity].slice(1)} (Nigrini: close up to ${r.bands[0]}, acceptable up to ${r.bands[1]}, marginal up to ${r.bands[2]}). ${lines[0].text}` },
        chart: benfordChart(r.digits),
        sheets: [{ name: `${sheet} Benford`, out }],
        done: `Benford (${r.test === "first" ? "first digit" : "first two digits"}): MAD ${r.mad.toFixed(4)}, ${CONFORMITY[r.conformity]}`,
        outcome: {
          test: "benford",
          exceptions: hot.length,
          status: r.conformity === "nonconformity" || r.conformity === "marginal" || hot.length ? "Done: exceptions" : "Done: no exceptions",
          detail: `${label(data, colOf(col))}, ${count(r.n)} values: MAD ${r.mad.toFixed(4)}, ${CONFORMITY[r.conformity]}${hot.length ? `; digits standing out: ${hot.slice(0, 5).map((x) => x.digit).join(", ")}` : ""}`,
        },
      };
    },
  };
}

function stratifyTool(data: SheetData, sheet: string): Tool {
  const col = columnSelect(data, { prefer: "number" });
  const bounds = textInput("", "e.g. 0, 1000, 10000, 100000");
  const bands = numberInput(5, { min: 1, step: "1" });
  return {
    title: "Stratify values into bands",
    intro: "Counts and totals per value band. Give your own band boundaries, or leave them empty for round bands of equal width.",
    fields: [field("Amounts in", col), field("Band boundaries", bounds, "Each boundary starts a new band: 1000 means under 1,000 and 1,000 and over."), field("Number of bands (when no boundaries are given)", bands)],
    compute() {
      const list = numberList(bounds.value);
      const r = stratify(data.col(colOf(col)), list.length ? { bounds: list } : { bands: Math.max(1, Math.min(50, Number(bands.value) || 5)) });
      const lines: Preview["lines"] = [{ text: `${plural(r.count, "value")} in ${plural(r.strata.length, "band")}, total ${money(r.total)}.` + (r.ignored ? ` ${count(r.ignored)} blank or not a number left out.` : "") }];
      const table = [["Band", "Count", "Count %", "Total", "Value %"], ...r.strata.map((s) => [s.label, count(s.count), pct(s.countShare), money(s.total), pct(s.valueShare)])];
      const S = r.strata;
      const out = new Out()
        .text("Band", [...S.map((s) => s.label), "Total"])
        .num("From", [...S.map((s) => s.from), null], MONEY)
        .num("To (not included)", [...S.map((s) => s.to), null], MONEY)
        .num("Count", [...S.map((s) => s.count), r.count], "#,##0")
        .num("Count %", [...S.map((s) => s.countShare), r.count ? 1 : 0], PCT)
        .num("Total", [...S.map((s) => s.total), r.total], MONEY)
        .num("Value %", [...S.map((s) => s.valueShare), r.count ? 1 : 0], PCT)
        .num("Smallest", [...S.map((s) => (s.count ? s.min : null)), null], MONEY)
        .num("Largest", [...S.map((s) => (s.count ? s.max : null)), null], MONEY);
      return {
        lines,
        table,
        sheets: r.count ? [{ name: `${sheet} strata`, out }] : null,
        done: `Stratified ${plural(r.count, "value")} into ${plural(S.length, "band")}`,
        outcome: r.count ? { test: "stratify", exceptions: null, status: "Done: no exceptions", detail: `${label(data, colOf(col))}: ${plural(r.count, "value")} in ${plural(S.length, "band")}, total ${money(r.total)}` } : undefined,
      };
    },
  };
}

function topNTool(data: SheetData, sheet: string): Tool {
  const col = columnSelect(data, { prefer: "number" });
  const n = numberInput(25, { min: 1, step: "1" });
  const abs = checkbox("Rank by size, ignoring the sign (large credits count too)", true);
  return {
    title: "Largest items (top N)",
    intro: "The biggest values with their share of the total and the running share.",
    fields: [field("Amounts in", col), field("How many", n), abs.el],
    compute() {
      const r = topN(data.col(colOf(col)), Math.max(1, Math.floor(Number(n.value) || 25)), { abs: abs.input.checked });
      const last = r.items[r.items.length - 1];
      const lines: Preview["lines"] = [{ text: r.items.length ? `The top ${count(r.items.length)} of ${plural(r.count, "value")} make up ${pct(last.cumulative)} of the total (by size).` : "No numbers in this column.", warn: !r.items.length }];
      const table = [["Rank", "Sheet row", "Value", "Cumulative"], ...r.items.slice(0, 10).map((it, i) => [String(i + 1), String(data.sheetRow(it.row)), money(it.value), pct(it.cumulative)])];
      const out = new Out()
        .num(
          "Rank",
          r.items.map((_, i) => i + 1),
        )
        .num(
          "Row",
          r.items.map((it) => data.sheetRow(it.row)),
        )
        .num(
          "Share",
          r.items.map((it) => it.share),
          PCT,
        )
        .num(
          "Cumulative share",
          r.items.map((it) => it.cumulative),
          PCT,
        )
        .copy(
          data,
          r.items.map((it) => it.row),
        );
      return { lines, table: r.items.length ? table : undefined, sheets: r.items.length ? [{ name: `${sheet} top ${r.items.length}`, out }] : null, done: `Top ${r.items.length} items` };
    },
  };
}

function paretoTool(data: SheetData, sheet: string): Tool {
  const col = columnSelect(data, { prefer: "number" });
  const key = columnSelect(data, { none: "(each row on its own)", prefer: "text" });
  const cutoff = numberInput(80, { min: 1, step: "1" });
  return {
    title: "Pareto analysis",
    intro: "Totals per item (vendor, customer, account…) from largest to smallest, with the running share, to show how few items make up most of the value. Sizes ignore the sign.",
    fields: [field("Amounts in", col), field("Group by", key), field("Cut-off (% of the total)", cutoff)],
    compute() {
      const k = colOf(key);
      const cut = Math.min(100, Math.max(1, Number(cutoff.value) || 80)) / 100;
      const r = pareto(data.col(colOf(col)), k >= 0 ? data.col(k) : undefined, cut);
      const items = k >= 0 ? r.items : r.items.map((it) => ({ ...it, key: `Row ${data.sheetRow(it.rows[0])}` }));
      const lines: Preview["lines"] = [];
      if (!items.length) lines.push({ text: "No numbers in this column.", warn: true });
      else lines.push({ text: `${plural(r.itemsToCutoff, "item")} of ${count(items.length)} (${pct(r.itemsToCutoff / items.length)}) make up ${pct(cut)} of the total.` });
      const table = [["Rank", "Item", "Total", "Cumulative"], ...items.slice(0, 10).map((it, i) => [String(i + 1), it.key || "(blank)", money(it.total), pct(it.cumulative)])];
      const out = new Out()
        .num(
          "Rank",
          items.map((_, i) => i + 1),
        )
        .text(
          k >= 0 ? label(data, k) : "Item",
          items.map((it) => it.key || "(blank)"),
        );
      if (k >= 0)
        out.num(
          "Rows",
          items.map((it) => it.rows.length),
          "#,##0",
        );
      else
        out.num(
          "Row",
          items.map((it) => data.sheetRow(it.rows[0])),
        );
      out
        .num(
          "Total",
          items.map((it) => it.total),
          MONEY,
        )
        .num(
          "Share",
          items.map((it) => it.share),
          PCT,
        )
        .num(
          "Cumulative share",
          items.map((it) => it.cumulative),
          PCT,
        )
        .text(
          `In the top ${pct(cut)}`,
          items.map((_, i) => (i < r.itemsToCutoff ? "yes" : "")),
        );
      return { lines, table: items.length ? table : undefined, sheets: items.length ? [{ name: `${sheet} Pareto`, out }] : null, done: `Pareto: ${r.itemsToCutoff} of ${items.length} items make ${pct(cut)}` };
    },
  };
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ageingTool(data: SheetData, sheet: string): Tool {
  const dateCol = columnSelect(data, { prefer: "date" });
  const amountCol = columnSelect(data, { none: "(count items only)", prefer: "number" });
  const asOf = textInput(todayIso(), "yyyy-mm-dd");
  const limits = textInput("30, 60, 90");
  const detail = checkbox("Also add a sheet listing every row with its age");
  return {
    title: "Ageing buckets",
    intro: "Ages each item by the days from its date to the as-of date. Dates after the as-of date go in Not yet due.",
    fields: [field("Dates in", dateCol), field("Amounts in", amountCol), field("As of", asOf, "A date such as 2024-12-31."), field("Bucket ends (days)", limits, "30, 60, 90 gives 0-30, 31-60, 61-90 and Over 90."), detail.el],
    compute() {
      const dates = data.col(colOf(dateCol));
      const a = colOf(amountCol);
      const when = parseDateLoose(asOf.value, "ymd") ?? parseDateLoose(asOf.value, guessDateOrder([asOf.value]));
      if (when === null) return { lines: [{ text: "Type the as-of date as a date, such as 2024-12-31.", warn: true }], sheets: null, done: "" };
      const lim = numberList(limits.value).filter((x) => x >= 0);
      const r = ageing(dates, when, { limits: lim.length ? lim : [30, 60, 90], amounts: a >= 0 ? data.col(a) : undefined, dateOrder: guessDateOrder(dates) });
      const dated = data.rows - r.noDate;
      const lines: Preview["lines"] = [{ text: `${plural(dated, "item")} aged` + (a >= 0 ? `, total ${money(r.total)}.` : ".") }];
      if (r.noDate) lines.push({ text: `${plural(r.noDate, "row")} without a date left out.`, warn: true });
      const table = [["Bucket", "Items", ...(a >= 0 ? ["Total"] : []), "Share"], ...r.buckets.map((b) => [b.label, count(b.count), ...(a >= 0 ? [money(b.total)] : []), pct(b.share)])];
      const B = r.buckets;
      const summary = new Out()
        .text("Bucket", [...B.map((b) => b.label), "Total"])
        .num("From (days)", [...B.map((b) => b.from), null])
        .num("To (days)", [...B.map((b) => b.to), null])
        .num("Items", [...B.map((b) => b.count), dated], "#,##0");
      if (a >= 0) summary.num("Total", [...B.map((b) => b.total), r.total], MONEY);
      summary.num("Share", [...B.map((b) => b.share), dated ? 1 : 0], PCT);
      const sheets = [{ name: `${sheet} ageing`, out: summary }];
      if (detail.input.checked) {
        const rows: number[] = [];
        for (let i = 0; i < data.rows; i++) if (r.rowBucket[i] >= 0) rows.push(i);
        sheets.push({
          name: `${sheet} ageing rows`,
          out: new Out()
            .num(
              "Row",
              rows.map((i) => data.sheetRow(i)),
            )
            .num(
              "Days",
              rows.map((i) => r.rowDays[i]),
              "#,##0",
            )
            .text(
              "Bucket",
              rows.map((i) => B[r.rowBucket[i]].label),
            )
            .copy(data, rows),
        });
      }
      return { lines, table, sheets: dated ? sheets : null, done: `Ageing as of ${asOf.value}: ${plural(dated, "item")}` };
    },
  };
}

function sampleTool(data: SheetData, sheet: string): Tool {
  const method = choice(
    [
      ["random", "Random"],
      ["systematic", "Systematic (every nth row from a random start)"],
      ["stratified", "Stratified (random within value bands)"],
      ["mus", "Monetary unit (MUS)"],
    ],
    "random",
  );
  const size = numberInput(25, { min: 1, step: "1" });
  const seed = numberInput(newSeed(), { min: 1, step: "1" });
  const amountCol = columnSelect(data, { prefer: "number" });
  const interval = numberInput("", { min: 0, placeholder: "worked out from the sample size" });
  const bounds = textInput("", "e.g. 1000, 10000 (empty: 3 equal bands)");
  const fAmount = field("Amounts in", amountCol);
  const fInterval = field("Sampling interval", interval, "Items at or above the interval are always picked (sure-take).");
  const fBounds = field("Band boundaries", bounds);
  const sync = () => {
    const m = method.value;
    fAmount.hidden = m !== "mus" && m !== "stratified";
    fInterval.hidden = m !== "mus";
    fBounds.hidden = m !== "stratified";
  };
  method.addEventListener("change", sync);
  sync();
  return {
    title: "Pick a sample",
    intro: "The seed is recorded with the sample; the same seed on the same rows picks the same items again. Blank rows are never picked.",
    fields: [field("Method", method), field("Sample size", size), field("Seed", seed, "Keep the number given, or type the seed of an earlier sample to repeat it."), fAmount, fInterval, fBounds],
    compute() {
      const m = method.value;
      const want = Math.max(0, Math.floor(Number(size.value) || 0));
      const s = Math.floor(Number(seed.value)) || 1;
      const lines: Preview["lines"] = [];
      let r: SampleResult;
      let note: string;
      if (m === "mus") {
        const amounts = data.col(colOf(amountCol));
        const iv = Number(interval.value) || 0;
        r = musSample(amounts, iv > 0 ? { interval: iv, seed: s } : { size: want, seed: s });
        const sure = r.items.filter((i) => i.reason === "sure-take").length;
        lines.push({ text: `Book value ${money(r.bookValue ?? 0)}, interval ${money(r.interval ?? 0)}, random start ${money(r.start ?? 0)}.` });
        lines.push({ text: `${plural(r.items.length, "item")} picked: ${count(sure)} sure-take (${money(r.sureTakeValue ?? 0)}) and ${count(r.items.length - sure)} by interval.` });
        if (r.excluded) lines.push({ text: `${plural(r.excluded, "row")} with zero, negative or no amount can't be picked by MUS; test them separately.`, warn: true });
        note = `MUS, seed ${s}, interval ${money(r.interval ?? 0)}, start ${money(r.start ?? 0)}`;
      } else if (m === "stratified") {
        const amounts = data.col(colOf(amountCol));
        const list = numberList(bounds.value);
        const st = stratify(amounts, list.length ? { bounds: list } : { bands: 3 });
        r = stratifiedSample(st.rowStratum, want, s);
        lines.push({ text: `${plural(r.items.length, "item")} from ${plural(r.population, "row")} in ${plural(st.strata.length, "band")}.` });
        for (const x of r.strata ?? []) lines.push({ text: `${st.strata[x.stratum].label}: ${count(x.sample)} of ${count(x.population)}` });
        if (st.ignored) lines.push({ text: `${plural(st.ignored, "row")} without an amount left out.` });
        note = `stratified, seed ${s}`;
        r.items = r.items.map((it) => ({ ...it, reason: st.strata[Number(it.reason.split(" ")[1]) - 1]?.label ?? it.reason }));
      } else {
        const pop = data.nonBlank();
        r = m === "systematic" ? systematicSample(pop.length, want, s) : randomSample(pop.length, want, s);
        r.items = r.items.map((it) => ({ ...it, row: pop[it.row] }));
        lines.push({ text: `${plural(r.items.length, "item")} from ${plural(pop.length, "row")}.` + (m === "systematic" && r.interval ? ` Every ${r.interval.toFixed(2)} rows from position ${(r.start ?? 0) + 1}.` : "") });
        note = m === "systematic" ? `systematic, seed ${s}, interval ${(r.interval ?? 0).toFixed(2)}` : `random, seed ${s}`;
      }
      if (!r.items.length) lines.push({ text: "Nothing to pick: check the sample size and the column.", warn: true });
      const out = new Out()
        .num(
          "Sample #",
          r.items.map((_, i) => i + 1),
        )
        .num(
          "Row",
          r.items.map((it) => data.sheetRow(it.row)),
        )
        .text(
          "Selected because",
          r.items.map((it) => (m === "mus" ? (it.reason === "sure-take" ? "sure-take (at or above the interval)" : `interval hit at ${money(it.hit ?? 0)}`) : it.reason)),
        )
        .text(
          "Method",
          r.items.map((_, i) => (i ? "" : note)),
        )
        .copy(
          data,
          r.items.map((it) => it.row),
        );
      return {
        lines,
        headline: { value: count(r.items.length), unit: r.items.length === 1 ? "item picked" : "items picked", tone: r.items.length ? "accent" : "unmatched", caption: `Seed ${s}: the same seed on the same rows picks the same items again.` },
        sheets: r.items.length ? [{ name: `${sheet} sample`, out }] : null,
        done: `Sample: ${plural(r.items.length, "item")} (${note})`,
        // picking is the start of the test: the items still have to be tested, so it's "In progress"
        outcome: r.items.length ? { test: "sample", exceptions: null, status: "In progress", label: `Sample (seed ${s})`, detail: `${plural(r.items.length, "item")}, ${note}` } : undefined,
      };
    },
  };
}

const TOOLS: Record<AuditToolKind, (data: SheetData, sheet: string) => Tool> = {
  duplicates: duplicatesTool,
  sequence: sequenceTool,
  benford: benfordTool,
  stratify: stratifyTool,
  topn: topNTool,
  pareto: paretoTool,
  ageing: ageingTool,
  sample: sampleTool,
};

// --------------------------------------------------------------- dialog --

/** A plain string table as a data table: numeric-looking columns right-aligned; a "Sheet row" column makes rows links. */
export function stringGrid(table: string[][], goRow: ((row: number) => void) | null): HTMLElement {
  const [head, ...body] = table;
  const numeric = head.map((_, c) => body.length > 0 && body.every((r) => !r[c] || /^[-+(]?[\d,.]+%?\)?$/.test(r[c].trim())));
  const rowCol = head.findIndex((h) => /^(sheet )?row$/i.test(h));
  const t = renderTable<string[]>({
    columns: head.map((h, c) => ({ key: String(c), label: h, value: (r) => r[c], align: numeric[c] ? "right" : "left" })),
    rows: body,
    onRowClick: goRow && rowCol >= 0 ? (r) => goRow(Number(r[rowCol])) : undefined,
    maxHeight: "44vh",
  });
  return t.element;
}

export function openAuditTool(kind: AuditToolKind, d: AuditDeps): void {
  const data = readSheet(d.source());
  const sheetName = d.sheetName();
  const sheet = sheetName.slice(0, 18);
  const goTo = navigator(d.goTo);
  const sheetId = activeSheetId(d.activeSheet);
  const goRow = goTo && sheetId ? (row: number, col = 0) => goTo(sheetId, row - 1, col) : null;
  if (!data.names.length || !data.rows) {
    openSidePanel({
      id: `audit-${kind}`,
      title: "Audit tests",
      subtitle: sheetName,
      render: (p) => {
        p.body.append(emptyState({ icon: "audit", title: "This sheet has no data to test", text: "Open or paste the data first (a ledger, an invoice list, a bank statement), with the column names in the first row. Then run the test again from that sheet." }));
      },
      onClose: () => d.focusGrid(),
    });
    return;
  }
  const tool = TOOLS[kind](data, sheet);
  let preview: Preview | null = null;
  openSidePanel({ minWidth: 520,
    id: `audit-${kind}`,
    title: tool.title,
    subtitle: `On ${sheetName} · ${plural(data.rows, "row")}`,
    onClose: () => d.focusGrid(),
    render: (p) => {
      const fields = el("div", { className: "audit-fields" }, ...tool.fields);
      const result = el("div", { className: "audit-result" });
      result.setAttribute("aria-live", "polite");
      p.body.append(el("p", { className: "tk-muted audit-intro", textContent: tool.intro }), section("Settings", fields), section("Result", result));
      const create = button("Create results sheet", () => {
        clearTimeout(timer);
        update();
        const pv = preview;
        if (!pv) return;
        if (!pv.sheets) {
          if (!pv.outcome) return;
          void recordOnResults(d.workbook?.() ?? currentWorkbook(), d.run, pv.outcome).then((ok) => ok && report(d.status, `${pv.done} · recorded on Results`));
          return;
        }
        create.disabled = true;
        void (async () => {
          const wb = d.workbook?.() ?? currentWorkbook();
          const before = new Set(wb?.sheets.map((s) => s.id) ?? []);
          for (const s of pv.sheets!) {
            const source = new EditableSource(new Table(s.out.columns), 5);
            await d.run({ type: "sheet.insert", params: { name: s.name.slice(0, 31), source: d.putBlob(source), numFmts: s.out.numFmts } });
          }
          // the sheet just added (its name may have a number added when the test was run before)
          const added = wb?.sheets.find((s) => !before.has(s.id))?.name;
          const recorded = pv.outcome ? await recordOnResults(wb, d.run, { ...pv.outcome, detail: added ? `${pv.outcome.detail}: see ${added}` : pv.outcome.detail }, added) : false;
          report(d.status, `${pv.done || `Added ${pv.sheets!.length === 1 ? "the results sheet" : "the results sheets"}`}${recorded ? " · recorded on Results" : ""}`);
          create.disabled = false;
        })();
      }, "primary");
      p.footer.append(create);

      const update = () => {
        result.replaceChildren();
        try {
          preview = tool.compute();
        } catch (e) {
          preview = null;
          result.append(notice((e as Error).message, "danger"));
          create.disabled = true;
          return;
        }
        const pv = preview;
        const lines = [...pv.lines];
        if (pv.headline) result.append(headline(pv.headline));
        else if (lines.length && !lines[0].warn) result.append(el("p", { className: "tk-lead", textContent: lines.shift()!.text }));
        for (const l of lines) result.append(l.warn ? notice(l.text, "warning") : el("p", { className: "tk-muted", textContent: l.text }));
        if (pv.chart) result.append(pv.chart);
        if (pv.grid) {
          const g = pv.grid;
          const t = renderTable<Record<string, unknown>>({ columns: g.columns, rows: g.rows, onRowClick: goRow && g.sheetRow ? (r) => goRow(g.sheetRow!(r)) : undefined, empty: g.empty, maxHeight: "44vh" });
          result.append(t.element);
          if (goRow && g.sheetRow && g.rows.length) result.append(el("p", { className: "tk-muted", textContent: "Click a row to see it in the sheet." }));
        } else if (pv.table) result.append(stringGrid(pv.table, goRow));
        // nothing to list (no duplicates, say) still goes on the audit template's Results sheet
        const wbNow = d.workbook?.() ?? currentWorkbook();
        const recordOnly = !pv.sheets && !!pv.outcome && !!wbNow && !!resultsSheet(wbNow);
        create.disabled = !pv.sheets && !recordOnly;
        create.textContent = recordOnly ? "Record on Results" : pv.sheets && pv.sheets.length > 1 ? "Create results sheets" : "Create results sheet";
        create.title = pv.sheets || recordOnly ? "" : "Nothing to put on a sheet yet";
      };
      let timer = 0;
      const later = () => {
        clearTimeout(timer);
        timer = window.setTimeout(update, 200);
      };
      fields.addEventListener("input", later);
      fields.addEventListener("change", later);
      update();
      (fields.querySelector("select, input") as HTMLElement | null)?.focus();
      return () => clearTimeout(timer);
    },
  });


}
