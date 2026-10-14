/**
 * Time and schedule tools as dialogs: fiscal period columns, period
 * comparison (MoM / YoY / rolling), budget vs actual, currency conversion
 * and revaluation, accrual / prepayment / deferred income schedules, and a
 * journal export template (CSV for an accounting system's import).
 *
 * Tools that make tables add new sheets; tools that add columns insert them
 * next to the column they work from (or overwrite, if asked), as one undo
 * step each. Every dialog previews the first rows as the options change.
 */
import { openToolDialog, openToolNotice, type ToolPreview, type ToolSpec } from "./tooldialog";
import type { Action } from "@cellforge/actions";
import { cellDate, cellNumber, formatValue, isDateFormat, Table, type AuditValue, type DateOrder } from "@cellforge/core";
import { columnLetter, type CellRange, type CellRef } from "@cellforge/grid";
import {
  budgetVsActual,
  buildSchedule,
  changeNames,
  convertAmounts,
  fiscalPeriod,
  GRAIN_LABELS,
  journalBalance,
  periodSummary,
  rateTable,
  revalue,
  SCHEDULE_ACCOUNTS,
  SCHEDULE_LABELS,
  type FiscalOptions,
  type PeriodGrain,
  type PostingDay,
  type RateRow,
  type RateTable,
  type ScheduleInput,
  type ScheduleKind,
  type ScheduleMethod,
  type SignConvention,
  type WeekPattern,
} from "@cellforge/core";
import { readSheet, type SheetData } from "./audittools";
import { setCells } from "./actions";
import { EditableSource } from "./editable";
import { guessDateOrder } from "./jetools";
import { buildColumns, targetRows, toInput, type SheetOut } from "./transformtools";
import type { Workbook } from "./workbook";
import "./transformtools.css";
import "./timetools.css";

export type TimeToolKind = "fiscal" | "periods" | "bva" | "currency" | "schedule" | "journal";

export interface TimeDeps {
  workbook: () => Workbook;
  source: () => EditableSource;
  /** Id of the active sheet (writes go there even if the user switches away). */
  activeSheet: () => string;
  range: () => CellRange;
  selection: () => CellRef;
  sheetName: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

type V = string | number | null;
type CellInput = { row: number; col: number; input: string | null };

export const MONEY = "#,##0.00;(#,##0.00)";
export const PCT = "0.0%";
export const DATE = "yyyy-mm-dd";
const PREVIEW_ROWS = 10;
/** Most cells one tool writes into the sheet in one go. */
const MAX_WRITE_CELLS = 1_000_000;

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${count(n)} ${n === 1 ? one : many}`;
const money = (n: number) => formatValue(n, MONEY).text;
/** Column name without the "A: " the pickers show. */
const bare = (name: string) => name.replace(/^[A-Z]+: /, "");
const pad2 = (n: number) => String(n).padStart(2, "0");

// ------------------------------------------------------------ reading --

/** The first column whose header matches, among those not yet taken; -1 if none. */
export function guessColumn(names: readonly string[], re: RegExp, taken: readonly number[] = []): number {
  return names.findIndex((n, c) => !taken.includes(c) && re.test(bare(n)));
}

/** Guess a column for each role from the header names, in the order given; each column is used once. */
export function guessMap<R extends string>(names: readonly string[], rules: readonly (readonly [R, RegExp])[]): Record<R, number> {
  const out = {} as Record<R, number>;
  const taken: number[] = [];
  for (const [role, re] of rules) {
    const c = guessColumn(names, re, taken);
    out[role] = c;
    if (c >= 0) taken.push(c);
  }
  return out;
}

/** Does the column hold dates (a date format, or mostly text that reads as dates)? */
export function isDateColumn(data: SheetData, c: number): boolean {
  if (c < 0) return false;
  const fmt = data.numFmt(c);
  if (fmt && isDateFormat(fmt)) return true;
  const vals = data.col(c).slice(0, 200).filter((v) => v !== null);
  if (!vals.length) return false;
  const order = guessDateOrder(vals);
  return vals.filter((v) => typeof v === "string" && cellDate(v, order) !== null).length / vals.length > 0.8;
}

/** The column's values as date serials (null where it isn't a date). */
export function datesOf(data: SheetData, c: number): (number | null)[] {
  if (c < 0) return new Array<number | null>(data.rows).fill(null);
  const vals = data.col(c);
  const order: DateOrder = guessDateOrder(vals.slice(0, 5000));
  return vals.map((v) => {
    const d = cellDate(v, order);
    return d !== null && d >= 1 ? d : null;
  });
}

/** The column's values as numbers (text such as "1,200.50" or "(30)" read too). */
export function numbersOf(data: SheetData, c: number): (number | null)[] {
  if (c < 0) return new Array<number | null>(data.rows).fill(null);
  return data.col(c).map((v) => cellNumber(v));
}

/** The column's values as trimmed text. */
export function textsOf(data: SheetData, c: number): string[] {
  if (c < 0) return new Array<string>(data.rows).fill("");
  return data.col(c).map((v) => (v === null ? "" : String(v).trim()));
}

/** First date column, else -1. */
function firstDateColumn(data: SheetData): number {
  const byName = guessColumn(data.names, /date|day|period|month/i);
  if (byName >= 0 && isDateColumn(data, byName)) return byName;
  return data.names.findIndex((_, c) => isDateColumn(data, c));
}

/** Columns whose values are mostly numbers (and not dates). */
function numericColumns(data: SheetData): number[] {
  return data.names.flatMap((_, c) => {
    if (isDateColumn(data, c)) return [];
    const vals = data.col(c).slice(0, 200).filter((v) => v !== null);
    return vals.length && vals.filter((v) => cellNumber(v) !== null).length / vals.length > 0.8 ? [c] : [];
  });
}

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * A period cell as "2025-01" so budget and actual periods match however
 * they're written: a date, "2025-01", "2025/1", "Jan 2025", "January-25",
 * "01/2025". Anything else comes back as its text.
 */
export function monthKey(v: AuditValue | undefined, order: DateOrder = "dmy"): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    // 202501 as a year and month; 1-12 as a month number; else a date serial
    if (Number.isInteger(v) && v >= 190001 && v <= 299912 && v % 100 >= 1 && v % 100 <= 12) return `${Math.floor(v / 100)}-${pad2(v % 100)}`;
    if (!Number.isFinite(v) || v <= 12 || v >= 2958466) return String(v);
    return formatValue(v, "yyyy-mm").text;
  }
  const s = v.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) return `${m[1]}-${pad2(Number(m[2]))}`;
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return `${m[2]}-${pad2(Number(m[1]))}`;
  if ((m = /^([A-Za-z]{3,9})\.?[\s\-/']+(\d{2}|\d{4})$/.exec(s))) {
    const mo = MONTH_NAMES[m[1].toLowerCase().slice(0, 3)];
    if (mo) return `${m[2].length === 2 ? "20" + m[2] : m[2]}-${pad2(mo)}`;
  }
  const d = cellDate(s, order);
  if (d !== null) return formatValue(d, "yyyy-mm").text;
  return s;
}

// --------------------------------------------------------- writing columns --

export interface ColumnWrite {
  cells: CellInput[];
  /** Non-empty cells that would be overwritten (0 when inserting). */
  overwrite: number;
  /** New columns. */
  columns: number;
  /** Where the new columns go, and whether they are inserted there first. */
  at: number;
  insert: boolean;
  preview: string[][];
}

export interface NewColumn {
  name: string;
  values: V[];
  kind?: "number" | "date" | "text";
  /** Format for the preview. */
  fmt?: string;
}

/**
 * Cells for new columns at `at` (for the data rows in `rows`), with a header
 * when the sheet's first row is a header row. With `insert`, the columns are
 * inserted first so nothing is overwritten.
 */
export function columnWrite(src: EditableSource, data: SheetData, at: number, rows: readonly number[], cols: readonly NewColumn[], insert: boolean, lead?: { name: string; values: string[] }): ColumnWrite {
  const cells: CellInput[] = [];
  cols.forEach((col, k) => {
    if (data.first === 1) cells.push({ row: 0, col: at + k, input: "'" + col.name });
    rows.forEach((i, j) => cells.push({ row: i + data.first, col: at + k, input: toInput(col.values[j] ?? null, col.kind ?? "number") }));
  });
  if (cells.length > MAX_WRITE_CELLS) throw new Error(`That would write ${count(cells.length)} cells; the most at once is ${count(MAX_WRITE_CELLS)}. Select fewer rows.`);
  let overwrite = 0;
  if (!insert)
    for (const c of cells) {
      if (c.col >= src.colCount || c.row >= src.rowCount) continue;
      const v = src.getCell(c.row, c.col);
      if (v !== null && v !== "") overwrite++;
    }
  const show = (v: V, fmt = "") => (v === null ? "" : typeof v === "number" ? formatValue(v, fmt || undefined).text : v);
  const preview = [
    [...(lead ? [lead.name] : []), ...cols.map((c, k) => `${columnLetter(at + k)}: ${c.name}`)],
    ...rows.slice(0, PREVIEW_ROWS).map((_, j) => [...(lead ? [lead.values[j] ?? ""] : []), ...cols.map((c) => show(c.values[j] ?? null, c.fmt ?? (c.kind === "date" ? DATE : "")))]),
  ];
  // blanks into empty cells do nothing
  const live = insert ? cells.filter((c) => c.input !== null) : cells.filter((c) => c.input !== null || (c.col < src.colCount && c.row < src.rowCount && src.getCell(c.row, c.col) !== null && src.getCell(c.row, c.col) !== ""));
  return { cells: live, overwrite, columns: cols.length, at, insert, preview };
}

// ------------------------------------------------------------- fiscal --

export interface FiscalColumns {
  year: boolean;
  quarter: boolean;
  period: boolean;
  label: boolean;
}

/** New columns holding the fiscal year, quarter, period and label of each date. */
export function fiscalColumns(dates: readonly (number | null)[], opts: FiscalOptions, which: FiscalColumns): { cols: NewColumn[]; bad: number } {
  let bad = 0;
  const per = dates.map((d) => {
    if (d === null) {
      bad++;
      return null;
    }
    return fiscalPeriod(d, opts);
  });
  const cols: NewColumn[] = [];
  if (which.year) cols.push({ name: "Fiscal year", values: per.map((f) => f?.fiscalYear ?? null), fmt: "0" });
  if (which.quarter) cols.push({ name: "Fiscal quarter", values: per.map((f) => f?.quarter ?? null) });
  if (which.period) cols.push({ name: "Fiscal period", values: per.map((f) => f?.period ?? null) });
  if (which.label) cols.push({ name: "Fiscal label", values: per.map((f) => f?.label ?? null), kind: "text" });
  return { cols, bad };
}

// ------------------------------------------------------------ periods --

/** The period comparison as a sheet. */
export function periodSheet(data: SheetData, sheet: string, dateCol: number, valueCol: number, groupCol: number, grain: PeriodGrain, fiscal: FiscalOptions, rolling: number): SheetOut & { badDates: number; badValues: number; periods: number } {
  const r = periodSummary(datesOf(data, dateCol), numbersOf(data, valueCol), { grain, fiscal, rolling, groups: groupCol >= 0 ? textsOf(data, groupCol) : undefined });
  const names = changeNames(grain);
  const fmt = data.numFmt(valueCol) && !isDateFormat(data.numFmt(valueCol)) ? data.numFmt(valueCol) : MONEY;
  const valueName = bare(data.names[valueCol] ?? "Amount");
  const yearly = grain === "year" || grain === "fiscal-year";
  const quarterly = grain === "quarter" || grain === "fiscal-quarter";
  const header: string[] = [];
  const fmts: string[] = [];
  const col = (name: string, f = "") => {
    header.push(name);
    fmts.push(f);
  };
  if (groupCol >= 0) col(bare(data.names[groupCol]));
  col("Period");
  col("Start", DATE);
  col("End", DATE);
  col("Rows");
  col(valueName, fmt);
  col(names.prior, fmt);
  col(`${names.change} change`, fmt);
  col(`${names.change} %`, PCT);
  if (!yearly) {
    col("Same period last year", fmt);
    col("YoY change", fmt);
    col("YoY %", PCT);
  }
  col(grain.startsWith("fiscal") ? "Fiscal YTD" : "YTD", fmt);
  if (!yearly && !quarterly) col("QTD", fmt);
  if (rolling > 0) {
    col(`Rolling ${rolling} sum`, fmt);
    col(`Rolling ${rolling} average`, fmt);
  }
  const rows: V[][] = r.rows.map((p) => {
    const row: V[] = [];
    if (groupCol >= 0) row.push(p.group || "(blank)");
    row.push(p.label, p.start, p.end, p.count, p.sum, p.prior, p.change, p.changePct);
    if (!yearly) row.push(p.lastYear, p.yoyChange, p.yoyPct);
    row.push(p.ytd);
    if (!yearly && !quarterly) row.push(p.qtd);
    if (rolling > 0) row.push(p.rollingSum, p.rollingAvg);
    return row;
  });
  return { name: `${sheet} by ${grain.replace("fiscal-", "fiscal ")}`, header, rows, numFmts: fmts, badDates: r.badDates, badValues: r.badValues, periods: r.rows.length };
}

// ------------------------------------------------------ budget vs actual --

export type BvaRole = "account" | "centre" | "period" | "amount" | "type";
export const BVA_ROLES: readonly BvaRole[] = ["account", "centre", "period", "amount", "type"];
export const BVA_LABEL: Record<BvaRole, string> = { account: "Account", centre: "Cost centre", period: "Period", amount: "Amount", type: "Account type" };
const BVA_RULES: [BvaRole, RegExp][] = [
  ["type", /type|class|category|kind|nature/i],
  ["account", /account|acct|a\/c|gl|nominal|ledger|line item|description|name/i],
  ["centre", /cost ?cent|cent(re|er)|department|dept|division|entity|project|branch|location/i],
  ["period", /period|month|date|year|quarter|mth/i],
  ["amount", /amount|actual|budget|value|total|balance|net|sum|spend|ytd|\$|£|€/i],
];

export function guessBvaMap(data: SheetData): Record<BvaRole, number> {
  const m = guessMap(data.names, BVA_RULES);
  if (m.amount < 0) m.amount = numericColumns(data).filter((c) => c !== m.account && c !== m.centre && c !== m.period).pop() ?? -1;
  if (m.account < 0) m.account = data.names.findIndex((_, c) => c !== m.amount && c !== m.period && c !== m.centre && c !== m.type);
  return m;
}

/** The lines of one side: keys (account, centre, period by month) and amount. */
export function bvaLines(data: SheetData, map: Record<BvaRole, number>): { keys: string[]; amount: number; type: string }[] {
  const acct = textsOf(data, map.account);
  const centre = textsOf(data, map.centre);
  const periodVals = map.period >= 0 ? data.col(map.period) : [];
  const order = guessDateOrder(periodVals.slice(0, 5000));
  const amounts = numbersOf(data, map.amount);
  const types = textsOf(data, map.type);
  const out: { keys: string[]; amount: number; type: string }[] = [];
  for (let i = 0; i < data.rows; i++) {
    if (!acct[i] && amounts[i] === null) continue;
    const keys = [acct[i]];
    if (map.centre >= 0) keys.push(centre[i]);
    if (map.period >= 0) keys.push(monthKey(periodVals[i], order));
    out.push({ keys, amount: amounts[i] ?? 0, type: types[i] });
  }
  return out;
}

export function bvaSheet(a: SheetData, b: SheetData, mapA: Record<BvaRole, number>, mapB: Record<BvaRole, number>, sign: SignConvention, name: string): SheetOut & { totals: ReturnType<typeof budgetVsActual>["totals"] } {
  const r = budgetVsActual(bvaLines(a, mapA), bvaLines(b, mapB), { sign });
  const keyNames = ["Account", ...(mapA.centre >= 0 ? ["Cost centre"] : []), ...(mapA.period >= 0 ? ["Period"] : [])];
  const hasType = mapA.type >= 0 || mapB.type >= 0;
  const header = [...keyNames, ...(hasType ? ["Account type"] : []), "Actual", "Budget", "Variance", "Variance %", "Favourable?", "Note"];
  const fav = (f: boolean | null, v: number) => (f === true ? "Favourable" : f === false ? "Unfavourable" : v === 0 ? "On budget" : "");
  const note = (s: string) => (s === "both" ? "" : s === "actual only" ? "Not in the budget" : "No actual");
  const rows: V[][] = r.rows.map((x) => [...x.keys, ...(hasType ? [x.type] : []), x.actual, x.budget, x.variance, x.variancePct, fav(x.favourable, x.variance), note(x.status)]);
  const t = r.totals;
  rows.push([...keyNames.map((_, i) => (i ? null : "Total")), ...(hasType ? [null] : []), t.actual, t.budget, t.variance, t.budget === 0 ? null : t.variance / Math.abs(t.budget), null, null]);
  const numFmts = [...keyNames.map(() => ""), ...(hasType ? [""] : []), MONEY, MONEY, MONEY, PCT, "", ""];
  return { name, header, rows, numFmts, totals: t };
}

// ----------------------------------------------------------- currency --

export type RateRole = "date" | "from" | "to" | "rate";
const RATE_RULES: [RateRole, RegExp][] = [
  ["date", /date|day|as ?of|effective/i],
  ["rate", /rate|fx|price|value|mid|close/i],
  ["from", /from|base|source|currency|ccy|cur/i],
  ["to", /\bto\b|quote|target|into|counter/i],
];

export function guessRateMap(data: SheetData): Record<RateRole, number> {
  return guessMap(data.names, RATE_RULES);
}

/**
 * The rate rows. Without a "to" column every row is against `other`: with
 * `direction` "from-other" a row says 1 `other` = rate × the row's currency,
 * with "to-other" 1 of the row's currency = rate × `other`.
 */
export function readRates(data: SheetData, map: Record<RateRole, number>, other = "", direction: "to-other" | "from-other" = "to-other"): RateRow[] {
  const dates = datesOf(data, map.date);
  const from = textsOf(data, map.from);
  const to = textsOf(data, map.to);
  const rates = numbersOf(data, map.rate);
  const out: RateRow[] = [];
  for (let i = 0; i < data.rows; i++) {
    const d = dates[i];
    const r = rates[i];
    if (d === null || r === null) continue;
    if (map.to >= 0) out.push({ date: d, from: from[i], to: to[i], rate: r });
    else if (direction === "to-other") out.push({ date: d, from: from[i], to: other, rate: r });
    else out.push({ date: d, from: other, to: from[i], rate: r });
  }
  return out;
}

export interface ConvertSpec {
  amountCol: number;
  /** Column of currency codes, or -1 to use `currency`. */
  currencyCol: number;
  currency: string;
  /** Column of dates, or -1 to use `date`. */
  dateCol: number;
  date: number | null;
  to: string;
  decimals: number;
}

/** The converted columns for the given data rows. */
export function convertColumns(table: RateTable, data: SheetData, rows: readonly number[], spec: ConvertSpec): { cols: NewColumn[]; missing: number; noDate: number } {
  const amounts = numbersOf(data, spec.amountCol);
  const curs = spec.currencyCol >= 0 ? textsOf(data, spec.currencyCol) : [];
  const dates = spec.dateCol >= 0 ? datesOf(data, spec.dateCol) : [];
  let noDate = 0;
  const d = rows.map((i) => {
    const x = spec.dateCol >= 0 ? dates[i] : spec.date;
    if (x === null && amounts[i] !== null) noDate++;
    return x ?? NaN;
  });
  const r = convertAmounts(
    table,
    rows.map((i) => amounts[i]),
    rows.map((i) => (spec.currencyCol >= 0 ? curs[i] : spec.currency)),
    d,
    spec.to,
    spec.decimals,
  );
  const to = spec.to.trim().toUpperCase();
  const cols: NewColumn[] = [
    { name: `Rate to ${to}`, values: r.rates.map((x) => (x === null ? null : Number(x.toPrecision(10)))), fmt: "0.0000##" },
    { name: `Amount in ${to}`, values: r.values, fmt: MONEY },
    { name: "Rate date", values: r.rateDates, kind: "date" },
  ];
  return { cols, missing: r.missing, noDate };
}

export type RevalRole = "label" | "currency" | "amount" | "booked";
const REVAL_RULES: [RevalRole, RegExp][] = [
  ["currency", /currency|ccy|cur\b/i],
  ["booked", /book|carr|base|historic|local|functional|reporting/i],
  ["amount", /foreign|amount|balance|fc\b|original/i],
  ["label", /account|name|description|label|bank|customer|supplier/i],
];

export function guessRevalMap(data: SheetData): Record<RevalRole, number> {
  return guessMap(data.names, REVAL_RULES);
}

export function revalueSheet(table: RateTable, data: SheetData, map: Record<RevalRole, number>, date: number, base: string, name: string): SheetOut & { gainLoss: number; missing: number } {
  const labels = textsOf(data, map.label);
  const curs = textsOf(data, map.currency);
  const amounts = numbersOf(data, map.amount);
  const booked = numbersOf(data, map.booked);
  const bal = [];
  for (let i = 0; i < data.rows; i++) {
    if (amounts[i] === null && booked[i] === null) continue;
    bal.push({ label: labels[i] || `Row ${data.sheetRow(i)}`, currency: curs[i], amount: amounts[i] ?? 0, booked: booked[i] ?? 0 });
  }
  const r = revalue(table, bal, date, base);
  const B = base.trim().toUpperCase();
  const rows: V[][] = r.rows.map((x) => [x.label, x.currency, x.amount, x.booked, x.closingRate === null ? null : Number(x.closingRate.toPrecision(10)), x.rateDate, x.revalued, x.gainLoss, x.closingRate === null ? "No rate" : x.gainLoss! > 0 ? "Gain" : x.gainLoss! < 0 ? "Loss" : ""]);
  rows.push(["Total", null, null, null, null, null, null, r.gainLoss, null]);
  return {
    name,
    header: ["Balance", "Currency", "Foreign amount", `Booked ${B}`, `Closing rate to ${B}`, "Rate date", `Revalued ${B}`, "FX gain (loss)", "Note"],
    rows,
    numFmts: ["", "", MONEY, MONEY, "0.0000##", DATE, MONEY, MONEY, ""],
    gainLoss: r.gainLoss,
    missing: r.missing,
  };
}

// ----------------------------------------------------------- schedules --

/** The schedule and its journal as two sheets. */
export function scheduleSheets(input: ScheduleInput, name: string): { schedule: SheetOut; journal: SheetOut; months: number } {
  const s = buildSchedule(input);
  const releases = input.kind !== "accrual";
  const schedule: SheetOut = {
    name: `${name} schedule`,
    header: ["#", "Month", "Posting date", "Days", "Opening balance", releases ? "Released" : "Charged", "Closing balance", releases ? "Released to date" : "Charged to date"],
    rows: s.rows.map((r) => [r.n, r.month, r.postingDate, r.days, r.opening, r.amount, r.closing, r.cumulative]),
    numFmts: ["", "", DATE, "", MONEY, MONEY, MONEY, MONEY],
  };
  schedule.rows.push([null, "Total", null, s.totalDays, null, s.rows.reduce((a, r) => Math.round((a + r.amount) * 1e6) / 1e6, 0), null, null]);
  const journal: SheetOut = {
    name: `${name} journal`,
    header: ["Entry", "Date", "Account", "Description", "Debit", "Credit"],
    rows: s.journal.map((l) => [l.entry, l.date, l.account, l.description, l.debit || null, l.credit || null]),
    numFmts: ["", DATE, "", "", MONEY, MONEY],
  };
  return { schedule, journal, months: s.rows.length };
}

// ----------------------------------------------------- journal export --

export type JournalRole = "date" | "account" | "description" | "debit" | "credit" | "amount" | "reference";
export const JOURNAL_ROLES: readonly JournalRole[] = ["date", "account", "description", "debit", "credit", "amount", "reference"];
export const JOURNAL_LABEL: Record<JournalRole, string> = {
  date: "Date",
  account: "Account",
  description: "Description",
  debit: "Debit",
  credit: "Credit",
  amount: "Amount (+ debit, - credit)",
  reference: "Reference / entry",
};
const JOURNAL_RULES: [JournalRole, RegExp][] = [
  ["debit", /^debit|^dr\b|debit amount/i],
  ["credit", /^credit|^cr\b|credit amount/i],
  ["date", /date|posting|period/i],
  ["account", /account|acct|gl|nominal|ledger|code/i],
  ["description", /desc|narr|memo|detail|text|particular/i],
  ["reference", /entry|ref|journal|voucher|doc|batch|#|number|no\.?$/i],
  ["amount", /amount|value|net|sum/i],
];

export function guessJournalMap(data: SheetData): Record<JournalRole, number> {
  const m = guessMap(data.names, JOURNAL_RULES);
  if (m.debit >= 0 && m.credit >= 0) m.amount = -1;
  return m;
}

export type DateStyle = "yyyy-mm-dd" | "dd/mm/yyyy" | "mm/dd/yyyy";

export interface JournalLayout {
  /** Output column names, in order: date, account, description, debit, credit (or amount), reference. */
  names: { date: string; account: string; description: string; debit: string; credit: string; amount: string; reference: string };
  /** Separate debit and credit columns, or one signed amount. */
  amounts: "split" | "signed";
  dateStyle: DateStyle;
  /** Include the reference column. */
  reference: boolean;
  decimals: number;
}

export const DEFAULT_LAYOUT: JournalLayout = {
  names: { date: "Date", account: "Account", description: "Description", debit: "Debit", credit: "Credit", amount: "Amount", reference: "Reference" },
  amounts: "split",
  dateStyle: "yyyy-mm-dd",
  reference: false,
  decimals: 2,
};

export interface JournalExport {
  header: string[];
  /** Rows as text, ready for CSV. */
  rows: string[][];
  /** Rows as values, for a sheet. */
  values: V[][];
  debit: number;
  credit: number;
  /** Rows left out: no account and no amount. */
  skipped: number;
  /** Rows whose date couldn't be read. */
  badDates: number;
  /** References (or dates, without them) whose lines don't balance. */
  unbalanced: string[];
}

/** Turn a sheet of journal lines into the import layout. */
export function journalExport(data: SheetData, map: Record<JournalRole, number>, layout: JournalLayout): JournalExport {
  const dates = datesOf(data, map.date);
  const accounts = textsOf(data, map.account);
  const descs = textsOf(data, map.description);
  const refs = textsOf(data, map.reference);
  const dr = numbersOf(data, map.debit);
  const cr = numbersOf(data, map.credit);
  const amt = numbersOf(data, map.amount);
  const split = map.debit >= 0 || map.credit >= 0;
  const dp = layout.decimals;
  const n = layout.names;
  const header = [n.date, n.account, n.description, ...(layout.amounts === "split" ? [n.debit, n.credit] : [n.amount]), ...(layout.reference ? [n.reference] : [])];
  const rows: string[][] = [];
  const values: V[][] = [];
  let skipped = 0;
  let badDates = 0;
  const lines: { debit: number; credit: number; entry: number }[] = [];
  const entryIds = new Map<string, number>();
  for (let i = 0; i < data.rows; i++) {
    let net = split ? (dr[i] ?? 0) - (cr[i] ?? 0) : (amt[i] ?? 0);
    net = Math.round(net * 10 ** dp) / 10 ** dp;
    if (!accounts[i] && net === 0) {
      skipped++;
      continue;
    }
    if (dates[i] === null && map.date >= 0 && data.col(map.date)[i] !== null) badDates++;
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    const dateText = dates[i] === null ? "" : formatValue(dates[i]!, layout.dateStyle).text;
    const text = [dateText, accounts[i], descs[i]];
    const vals: V[] = [dates[i], accounts[i], descs[i]];
    if (layout.amounts === "split") {
      text.push(debit ? debit.toFixed(dp) : "", credit ? credit.toFixed(dp) : "");
      vals.push(debit || null, credit || null);
    } else {
      text.push(net.toFixed(dp));
      vals.push(net);
    }
    if (layout.reference) {
      text.push(refs[i]);
      vals.push(refs[i]);
    }
    rows.push(text);
    values.push(vals);
    const key = map.reference >= 0 ? refs[i] : dateText;
    let id = entryIds.get(key);
    if (id === undefined) entryIds.set(key, (id = entryIds.size));
    lines.push({ debit, credit, entry: id });
  }
  const bal = journalBalance(lines);
  const keys = [...entryIds.keys()];
  return { header, rows, values, debit: bal.debit, credit: bal.credit, skipped, badDates, unbalanced: bal.unbalanced.map((e) => keys[e] || "(blank)") };
}

/** CSV text: fields with commas, quotes or line breaks are quoted; lines end with CRLF. */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[], delimiter = ","): string {
  const field = (s: string) => (s.includes(delimiter) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [header, ...rows].map((r) => r.map(field).join(delimiter)).join("\r\n") + "\r\n";
}

/** "2025-01-31" or "31/01/2025" as a serial, or null. */
export function parseDateInput(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const d = cellDate(t, /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && Number(t.split("/")[1]) > 12 ? "mdy" : "dmy");
  return d !== null && d >= 1 ? Math.floor(d) : null;
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

function fillColumns(sel: HTMLSelectElement, names: readonly string[], value: number, none?: string): void {
  sel.replaceChildren();
  if (none) sel.append(new Option(none, "-1"));
  names.forEach((n, c) => sel.append(new Option(n, String(c))));
  sel.value = String(none ? value : Math.max(0, value));
}

function columnSelect(names: readonly string[], value: number, none?: string, aria?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  fillColumns(sel, names, value, none);
  if (aria) sel.setAttribute("aria-label", aria);
  return sel;
}

function choice(options: readonly (readonly [string, string])[], value?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, text] of options) sel.append(new Option(text, v));
  if (value !== undefined) sel.value = value;
  return sel;
}

function textInput(value: string, placeholder = "", type = "text"): HTMLInputElement {
  const i = document.createElement("input");
  i.type = type;
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

function grid(...children: HTMLElement[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "tt-grid";
  d.append(...children);
  return d;
}

const MONTH_OPTIONS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m, i) => [String(i + 1), m] as const);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => [String(i), d] as const);

/** Fiscal calendar settings, shared by two tools. */
function fiscalFields(): { els: HTMLElement[]; value: () => FiscalOptions; sync: (on: boolean) => void } {
  const start = choice(MONTH_OPTIONS, "1");
  const named = choice(
    [
      ["end", "the calendar year it ends in (FY2025 = Jul 2024 to Jun 2025)"],
      ["start", "the calendar year it starts in (FY2024 = Jul 2024 to Jun 2025)"],
    ],
    "end",
  );
  const weeks = choice(
    [
      ["", "Calendar months"],
      ["4-4-5", "4-4-5 weeks"],
      ["4-5-4", "4-5-4 weeks"],
      ["5-4-4", "5-4-4 weeks"],
    ],
    "",
  );
  const weekEnd = choice(WEEKDAYS, "6");
  const yearEnd = choice(
    [
      ["last", "on the last one in the year's last month"],
      ["nearest", "on the one nearest the end of the year's last month"],
    ],
    "last",
  );
  const startF = field("Year starts in", start);
  const namedF = field("Name the year by", named);
  const weeksF = field("Periods", weeks, "A 52/53-week year splits each quarter into periods of 4, 4 and 5 weeks (or 4-5-4, 5-4-4).");
  const weekEndF = field("Weeks end on", weekEnd);
  const yearEndF = field("The year ends", yearEnd);
  const syncWeeks = () => {
    weekEndF.hidden = yearEndF.hidden = !weeks.value || startF.hidden;
  };
  weeks.addEventListener("change", syncWeeks);
  syncWeeks();
  return {
    els: [startF, namedF, weeksF, weekEndF, yearEndF],
    value: () => ({
      yearStartMonth: Number(start.value),
      yearNamedBy: named.value as "start" | "end",
      ...(weeks.value ? { weeks: weeks.value as WeekPattern, weekEndDay: Number(weekEnd.value), yearEnd: yearEnd.value as "last" | "nearest" } : {}),
    }),
    sync(on: boolean) {
      startF.hidden = namedF.hidden = weeksF.hidden = !on;
      syncWeeks();
    },
  };
}

// ---------------------------------------------------------------- tools --

type Preview = ToolPreview;
type Tool = ToolSpec;

interface Ctx {
  d: TimeDeps;
  src: EditableSource;
  data: SheetData;
  sheet: string;
  sheetId: string;
}

const tablePreview = (out: SheetOut): string[][] => [
  out.header,
  ...out.rows.slice(0, PREVIEW_ROWS).map((r) => r.map((v, c) => (v === null ? "" : typeof v === "number" ? formatValue(v, out.numFmts[c] || undefined).text : v))),
];

async function addSheets(d: TimeDeps, sheets: SheetOut[]): Promise<void> {
  for (const s of sheets) {
    const { columns, numFmts } = buildColumns(s.header, s.rows, s.numFmts);
    const source = new EditableSource(new Table(columns), 5);
    await d.run({ type: "sheet.insert", params: { name: s.name.slice(0, 31), source: d.putBlob(source), numFmts } });
  }
}

async function writeColumns(c: Ctx, w: ColumnWrite, what: string): Promise<void> {
  if (w.insert) await c.d.run({ type: "cols.insert", params: { sheet: c.sheetId, at: Math.min(w.at, c.src.colCount), count: w.columns } });
  else if (w.at + w.columns > c.src.colCount) await c.d.run({ type: "cols.insert", params: { sheet: c.sheetId, at: c.src.colCount, count: w.at + w.columns - c.src.colCount } });
  if (w.cells.length) await c.d.run(setCells(w.cells, what, c.sheetId));
}

function writeLines(w: ColumnWrite): { lines: Preview["lines"]; ok: string } {
  const where = `${columnLetter(w.at)}${w.columns > 1 ? ` to ${columnLetter(w.at + w.columns - 1)}` : ""}`;
  const lines: Preview["lines"] = [{ text: w.insert ? `${plural(w.columns, "new column")} inserted at ${where}; the columns after move right.` : `Written into ${where}.` }];
  if (w.overwrite) lines.push({ text: `${plural(w.overwrite, "cell")} there already ${w.overwrite === 1 ? "has" : "have"} something in ${w.overwrite === 1 ? "it" : "them"} and will be overwritten. Tick "Insert new columns" to keep them.`, warn: true });
  return { lines, ok: w.overwrite ? `Overwrite ${plural(w.overwrite, "cell")}` : w.columns > 1 ? "Add the columns" : "Add the column" };
}

function fiscalTool(c: Ctx): Tool {
  const dc = firstDateColumn(c.data);
  const col = columnSelect(c.data.names, dc >= 0 ? dc : Math.min(c.d.range().left, c.data.names.length - 1));
  const fiscal = fiscalFields();
  const which = {
    year: checkbox("Fiscal year", true),
    quarter: checkbox("Quarter", true),
    period: checkbox("Period", true),
    label: checkbox("Label (FY2025 P03)", false),
  };
  const whichBox = grid(which.year.el, which.quarter.el, which.period.el, which.label.el);
  const insert = checkbox("Insert new columns (nothing is overwritten)", true);
  return {
    title: "Fiscal periods",
    intro: "Adds the fiscal year, quarter and period of each date in a column, in new columns to its right. With more than one row selected, only those rows are filled.",
    fields: [field("Date column", col), ...fiscal.els, field("Add", whichBox), insert.el],
    compute() {
      const cIdx = Number(col.value);
      const cols = { year: which.year.input.checked, quarter: which.quarter.input.checked, period: which.period.input.checked, label: which.label.input.checked };
      if (!Object.values(cols).some(Boolean)) return { lines: [{ text: "Tick at least one column to add.", warn: true }], apply: null, ok: "Add the columns" };
      const rows = targetRows(c.data, c.d.range());
      const all = datesOf(c.data, cIdx);
      const dates = rows.map((i) => all[i]);
      const r = fiscalColumns(dates, fiscal.value(), cols);
      const shown = rows.map((i) => {
        const v = c.data.col(cIdx)[i];
        return all[i] !== null ? formatValue(all[i]!, DATE).text : v === null ? "" : String(v);
      });
      const w = columnWrite(c.src, c.data, cIdx + 1, rows, r.cols, insert.input.checked, { name: bare(c.data.names[cIdx]), values: shown });
      const out = writeLines(w);
      const lines: Preview["lines"] = [...out.lines];
      if (r.bad === rows.length) return { lines: [{ text: `No dates in ${bare(c.data.names[cIdx])}. Pick the column that holds the dates.`, warn: true }], table: w.preview, apply: null, ok: out.ok };
      if (r.bad) lines.unshift({ text: `${plural(r.bad, "row")} with no date ${r.bad === 1 ? "is" : "are"} left blank.`, warn: true });
      return {
        lines,
        table: w.preview,
        ok: out.ok,
        apply: async () => {
          await writeColumns(c, w, `fiscal periods (${columnLetter(cIdx)})`);
          c.d.status(`Fiscal periods: ${plural(rows.length - r.bad, "date")} in ${plural(w.columns, "column")} from ${columnLetter(w.at)}`);
        },
      };
    },
  };
}

function periodsTool(c: Ctx): Tool {
  const dc = firstDateColumn(c.data);
  const nums = numericColumns(c.data);
  const dateCol = columnSelect(c.data.names, dc >= 0 ? dc : 0);
  const valueCol = columnSelect(c.data.names, nums[nums.length - 1] ?? Math.min(1, c.data.names.length - 1));
  const groupCol = columnSelect(c.data.names, -1, "(one series for everything)");
  const grain = choice(Object.entries(GRAIN_LABELS), "month");
  const rolling = textInput("3", "", "number");
  rolling.min = "0";
  rolling.max = "120";
  const fiscal = fiscalFields();
  const sync = () => fiscal.sync(grain.value.startsWith("fiscal"));
  grain.addEventListener("change", sync);
  sync();
  return {
    title: "Period comparison (MoM / YoY / rolling)",
    intro: "Totals a column by period and compares each period with the one before, with the same period last year, and with the year and quarter so far. Periods with no rows show as 0, so nothing is skipped. The result goes on a new sheet.",
    fields: [grid(field("Dates in", dateCol), field("Amounts in", valueCol)), field("Separate series for each", groupCol, "Account, entity or product: each gets its own run of periods."), field("Period", grain), ...fiscal.els, field("Rolling window (periods)", rolling, "Rolling sum and average over this many periods, this one included. 0 for none.")],
    compute() {
      const n = Math.max(0, Math.min(120, Math.trunc(Number(rolling.value) || 0)));
      const out = periodSheet(c.data, c.sheet, Number(dateCol.value), Number(valueCol.value), Number(groupCol.value), grain.value as PeriodGrain, fiscal.value(), n);
      if (!out.rows.length) return { lines: [{ text: `No dates in ${bare(c.data.names[Number(dateCol.value)])}. Pick the column that holds the dates.`, warn: true }], apply: null, ok: "Add the sheet" };
      const lines: Preview["lines"] = [{ text: `${plural(out.periods, "period")}${Number(groupCol.value) >= 0 ? " across the series" : ""}.` }];
      if (out.badDates) lines.push({ text: `${plural(out.badDates, "row")} left out: the date isn't a date.`, warn: true });
      if (out.badValues) lines.push({ text: `${plural(out.badValues, "amount")} that aren't numbers counted as 0.`, warn: true });
      return {
        lines,
        table: tablePreview(out),
        ok: "Add the sheet",
        apply: async () => {
          await addSheets(c.d, [out]);
          c.d.status(`Period comparison: ${plural(out.periods, "period")} on "${out.name.slice(0, 31)}"`);
        },
      };
    },
  };
}

/** Pick a sheet and map its columns to roles; the selects refill when the sheet changes. */
function sheetMapper<R extends string>(wb: Workbook, sheetId: string, roles: readonly R[], labels: Record<R, string>, optional: readonly R[], guess: (data: SheetData) => Record<R, number>, aria: string) {
  const visible = wb.sheets.filter((s) => !s.hidden);
  const sheet = document.createElement("select");
  sheet.setAttribute("aria-label", aria);
  for (const s of visible) sheet.append(new Option(s.name, s.id));
  sheet.value = sheetId;
  const state = { data: readSheet(wb.get(sheetId).source) };
  const selects = roles.map((r) => columnSelect([], -1, optional.includes(r) ? "(none)" : undefined, `${aria}: ${labels[r]}`));
  const refill = () => {
    state.data = readSheet(wb.get(sheet.value).source);
    const g = guess(state.data);
    roles.forEach((r, i) => fillColumns(selects[i], state.data.names, g[r], optional.includes(r) ? "(none)" : undefined));
  };
  sheet.addEventListener("change", refill);
  refill();
  return {
    sheet,
    fields: roles.map((r, i) => field(labels[r], selects[i])),
    data: () => state.data,
    name: () => wb.get(sheet.value).name,
    map: () => Object.fromEntries(roles.map((r, i) => [r, Number(selects[i].value)])) as Record<R, number>,
  };
}

function bvaTool(c: Ctx): Tool {
  const wb = c.d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  const budgetSheet = visible.find((s) => /budget|plan|forecast/i.test(s.name)) ?? visible.find((s) => s.id !== c.sheetId) ?? visible[0];
  const actualSheet = visible.find((s) => s.id === c.sheetId && s.id !== budgetSheet.id) ?? visible.find((s) => s.id !== budgetSheet.id) ?? visible[0];
  const optional: BvaRole[] = ["centre", "period", "type"];
  const A = sheetMapper(wb, actualSheet.id, BVA_ROLES, BVA_LABEL, optional, guessBvaMap, "Actual");
  const B = sheetMapper(wb, budgetSheet.id, BVA_ROLES, BVA_LABEL, optional, guessBvaMap, "Budget");
  const sign = choice(
    [
      ["natural", "Income and costs both positive (more income or less cost is favourable)"],
      ["debit-positive", "Ledger signs: costs positive, income negative (lower is favourable)"],
    ],
    "natural",
  );
  const box = (title: string, m: ReturnType<typeof sheetMapper<BvaRole>>) => {
    const d = document.createElement("fieldset");
    d.className = "tt-side";
    const lg = document.createElement("legend");
    lg.textContent = title;
    d.append(lg, field("Sheet", m.sheet), ...m.fields);
    return d;
  };
  return {
    title: "Budget vs actual",
    intro: "Matches actual and budget lines by account (and cost centre and period, if you pick them), adds up each side, and shows the variance and whether it's favourable. Periods match by month however they're written (a date, 2025-01, Jan 2025). The result goes on a new sheet.",
    fields: [grid(box("Actual", A), box("Budget", B)), field("Amounts are", sign, "Income or expense is read from the account type column, or else from the account name.")],
    compute() {
      if (visible.length < 2) return { lines: [{ text: "Put the actuals and the budget on two sheets first.", warn: true }], apply: null, ok: "Add the sheet" };
      const ma = A.map();
      const mb = B.map();
      if (A.sheet.value === B.sheet.value) return { lines: [{ text: "Pick two different sheets.", warn: true }], apply: null, ok: "Add the sheet" };
      if ((ma.centre >= 0) !== (mb.centre >= 0) || (ma.period >= 0) !== (mb.period >= 0)) return { lines: [{ text: "Pick the cost centre and period on both sides, or on neither: lines match on the same keys.", warn: true }], apply: null, ok: "Add the sheet" };
      const out = bvaSheet(A.data(), B.data(), ma, mb, sign.value as SignConvention, "Budget vs actual");
      const t = out.totals;
      const lines: Preview["lines"] = [
        { text: `Actual ${money(t.actual)}, budget ${money(t.budget)}, variance ${money(t.variance)}.` },
        { text: `${plural(t.both, "line")} on both sides; ${plural(t.favourable, "favourable variance")}, ${plural(t.unfavourable, "unfavourable")}.` },
      ];
      if (t.actualOnly) lines.push({ text: `${plural(t.actualOnly, "line")} with actuals but no budget.`, warn: true });
      if (t.budgetOnly) lines.push({ text: `${plural(t.budgetOnly, "budget line")} with no actuals.`, warn: true });
      return {
        lines,
        table: tablePreview(out),
        ok: "Add the sheet",
        apply: async () => {
          await addSheets(c.d, [out]);
          c.d.status(`Budget vs actual: variance ${money(t.variance)} over ${plural(out.rows.length - 1, "line")}`);
        },
      };
    },
  };
}

function currencyTool(c: Ctx): Tool {
  const wb = c.d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  const ratesGuess = visible.find((s) => s.id !== c.sheetId && /rate|fx|currenc|exchange/i.test(s.name)) ?? visible.find((s) => s.id !== c.sheetId) ?? visible[0];
  const R = sheetMapper(wb, ratesGuess.id, ["date", "from", "to", "rate"] as const, { date: "Date", from: "From currency", to: "To currency", rate: "Rate" }, ["to"], guessRateMap, "Rates");
  const other = textInput("USD", "e.g. USD");
  const direction = choice(
    [
      ["to-other", "1 unit of the row's currency = rate × this currency"],
      ["from-other", "1 unit of this currency = rate × the row's currency"],
    ],
    "to-other",
  );
  const otherF = field("Rates are against", other, "Used when the rates sheet has no To column.");
  const directionF = field("Each rate means", direction);
  const ratesBox = document.createElement("fieldset");
  ratesBox.className = "tt-side";
  const lg = document.createElement("legend");
  lg.textContent = "Rates";
  ratesBox.append(lg, field("Sheet", R.sheet), ...R.fields, otherF, directionF);

  const mode = choice(
    [
      ["convert", "Convert each row (adds rate and converted amount columns)"],
      ["revalue", "Revalue balances at a closing rate (new sheet with FX gain or loss)"],
    ],
    "convert",
  );
  const nums = numericColumns(c.data);
  const amountCol = columnSelect(c.data.names, nums[nums.length - 1] ?? 0, undefined, "Amount");
  const curGuess = guessColumn(c.data.names, /currency|ccy|cur\b/i);
  const curCol = columnSelect(c.data.names, curGuess, "(all the same currency)", "Currency column");
  const fixedCur = textInput("EUR", "e.g. EUR");
  const dc = firstDateColumn(c.data);
  const dateCol = columnSelect(c.data.names, dc, "(one date for every row)", "Date column");
  const fixedDate = textInput(formatValue(Math.floor(Date.now() / 86_400_000) + 25_569, DATE).text, "yyyy-mm-dd", "date");
  const to = textInput("USD", "e.g. USD");
  const base = textInput("", "e.g. USD");
  const decimals = textInput("2", "", "number");
  const insert = checkbox("Insert new columns (nothing is overwritten)", true);
  const rv = guessRevalMap(c.data);
  const labelCol = columnSelect(c.data.names, rv.label, "(none)", "Balance name");
  const rvCur = columnSelect(c.data.names, rv.currency >= 0 ? rv.currency : 0, undefined, "Currency");
  const rvAmt = columnSelect(c.data.names, rv.amount >= 0 ? rv.amount : (nums[0] ?? 0), undefined, "Foreign amount");
  const rvBooked = columnSelect(c.data.names, rv.booked >= 0 ? rv.booked : (nums[1] ?? 0), undefined, "Booked amount");
  const closing = textInput(fixedDate.value, "yyyy-mm-dd", "date");

  const convertEls = [field("Amount", amountCol), grid(field("Currency column", curCol), field("Currency", fixedCur)), grid(field("Date column", dateCol), field("Date", fixedDate)), field("Decimals", decimals), insert.el];
  const revalEls = [field("Balance name", labelCol), field("Currency", rvCur), grid(field("Amount in the foreign currency", rvAmt), field("Booked amount (base currency)", rvBooked)), field("Closing date", closing, "The latest rate on or before this date is used.")];
  const toF = field("Convert to", to);
  const baseF = field("Triangulate through", base, "When a pair has no rate, it goes through this currency (GBP → USD → JPY). Blank: the currency used most in the rates.");
  const sync = () => {
    const revalue = mode.value === "revalue";
    for (const e of convertEls) e.hidden = revalue;
    for (const e of revalEls) e.hidden = !revalue;
    fixedCur.parentElement!.hidden = Number(curCol.value) >= 0 || revalue;
    fixedDate.parentElement!.hidden = Number(dateCol.value) >= 0 || revalue;
    toF.firstChild!.textContent = revalue ? "Base currency" : "Convert to";
    const noTo = R.map().to < 0;
    otherF.hidden = directionF.hidden = !noTo;
  };
  [mode, curCol, dateCol, R.sheet, ...ratesBox.querySelectorAll("select")].forEach((e) => e.addEventListener("change", sync));
  sync();
  return {
    title: "Convert currency",
    intro: "Converts amounts with a sheet of exchange rates (date, from, to, rate). Each row uses the latest rate on or before its date; a missing pair is inverted or worked out through a base currency.",
    fields: [field("What to do", mode), ...convertEls, ...revalEls, grid(toF, baseF), ratesBox],
    compute() {
      if (R.sheet.value === c.sheetId) return { lines: [{ text: "Pick the sheet with the rates (not this one).", warn: true }], apply: null, ok: "Convert" };
      const map = R.map();
      const rows = readRates(R.data(), map, other.value, direction.value as "to-other" | "from-other");
      const table = rateTable(rows, { base: base.value.trim() || undefined });
      const target = to.value.trim().toUpperCase();
      if (!rows.length) return { lines: [{ text: `No rates read from "${R.name()}". Check its date and rate columns.`, warn: true }], apply: null, ok: "Convert" };
      if (!target) return { lines: [{ text: "Type the currency to convert to.", warn: true }], apply: null, ok: "Convert" };
      const rateLine = { text: `${plural(rows.length, "rate")} for ${table.currencies.join(", ")}.` };
      if (mode.value === "revalue") {
        const date = parseDateInput(closing.value);
        if (date === null) return { lines: [{ text: "Give the closing date.", warn: true }], apply: null, ok: "Add the sheet" };
        const out = revalueSheet(table, c.data, { label: Number(labelCol.value), currency: Number(rvCur.value), amount: Number(rvAmt.value), booked: Number(rvBooked.value) }, date, target, `${c.sheet} FX revaluation`);
        const lines: Preview["lines"] = [rateLine, { text: `FX ${out.gainLoss >= 0 ? "gain" : "loss"} ${money(Math.abs(out.gainLoss))} over ${plural(out.rows.length - 1, "balance")}.` }];
        if (out.missing) lines.push({ text: `${plural(out.missing, "balance")} with no closing rate.`, warn: true });
        return {
          lines,
          table: tablePreview(out),
          ok: "Add the sheet",
          apply: async () => {
            await addSheets(c.d, [out]);
            c.d.status(`FX revaluation: ${out.gainLoss >= 0 ? "gain" : "loss"} ${money(Math.abs(out.gainLoss))}`);
          },
        };
      }
      const spec: ConvertSpec = {
        amountCol: Number(amountCol.value),
        currencyCol: Number(curCol.value),
        currency: fixedCur.value,
        dateCol: Number(dateCol.value),
        date: parseDateInput(fixedDate.value),
        to: target,
        decimals: Math.max(0, Math.min(6, Math.trunc(Number(decimals.value) || 0))),
      };
      if (spec.dateCol < 0 && spec.date === null) return { lines: [{ text: "Give the date to take the rates from.", warn: true }], apply: null, ok: "Convert" };
      const dataRows = targetRows(c.data, c.d.range());
      const r = convertColumns(table, c.data, dataRows, spec);
      const amounts = numbersOf(c.data, spec.amountCol);
      const w = columnWrite(c.src, c.data, spec.amountCol + 1, dataRows, r.cols, insert.input.checked, { name: bare(c.data.names[spec.amountCol]), values: dataRows.map((i) => (amounts[i] === null ? "" : money(amounts[i]!))) });
      const out = writeLines(w);
      const converted = r.cols[1].values.filter((v) => v !== null).length;
      const lines: Preview["lines"] = [rateLine, { text: `${plural(converted, "amount")} converted to ${target}.` }, ...out.lines];
      if (r.missing) lines.push({ text: `${plural(r.missing, "amount")} with no rate on or before ${r.noDate ? "its date (or no date)" : "its date"}: left blank.`, warn: true });
      return {
        lines,
        table: w.preview,
        ok: out.ok,
        apply: converted
          ? async () => {
              await writeColumns(c, w, `convert to ${target}`);
              c.d.status(`Convert currency: ${plural(converted, "amount")} converted to ${target}`);
            }
          : null,
      };
    },
  };
}

function scheduleTool(c: Ctx): Tool {
  const kind = choice(Object.entries(SCHEDULE_LABELS), "prepayment");
  const desc = textInput("", "e.g. Insurance 2025");
  const amount = textInput("", "e.g. 12,000.00");
  amount.inputMode = "decimal";
  const today = new Date();
  const y = today.getFullYear();
  const start = textInput(`${y}-01-01`, "yyyy-mm-dd", "date");
  const end = textInput(`${y}-12-31`, "yyyy-mm-dd", "date");
  const method = choice(
    [
      ["straight-line", "Straight-line: the same each month"],
      ["daily", "Daily: by the days in each month"],
    ],
    "straight-line",
  );
  const posting = choice(
    [
      ["month-end", "Last day of the month"],
      ["month-start", "First day of the month"],
      ["day", "A day of the month"],
    ],
    "month-end",
  );
  const day = textInput("25", "", "number");
  day.min = "1";
  day.max = "31";
  const dayF = field("Day", day);
  const [dr0, cr0] = SCHEDULE_ACCOUNTS.prepayment;
  const dr = textInput(dr0);
  const cr = textInput(cr0);
  let touched = false;
  for (const i of [dr, cr]) i.addEventListener("input", () => (touched = true));
  kind.addEventListener("change", () => {
    if (touched) return;
    [dr.value, cr.value] = SCHEDULE_ACCOUNTS[kind.value as ScheduleKind];
  });
  const decimals = textInput("2", "", "number");
  const sync = () => (dayF.hidden = posting.value !== "day");
  posting.addEventListener("change", sync);
  sync();
  return {
    title: "Accrual / prepayment schedule",
    intro: "Builds a month-by-month schedule (opening balance, release, closing balance) and the journal that posts it. Each month is rounded and the last month takes the remainder, so the total is exact. Two new sheets: the schedule and the journal.",
    fields: [field("Kind", kind), field("Description", desc), field("Amount", amount), grid(field("First day covered", start), field("Last day covered", end)), field("Spread", method), grid(field("Post on", posting), dayF), grid(field("Debit each month", dr), field("Credit each month", cr)), field("Decimals", decimals)],
    compute() {
      const amt = cellNumber(amount.value);
      const s = parseDateInput(start.value);
      const e = parseDateInput(end.value);
      if (amt === null) return { lines: [{ text: "Type the amount." }], apply: null, ok: "Add the sheets" };
      if (s === null || e === null) return { lines: [{ text: "Give the first and last day the amount covers.", warn: true }], apply: null, ok: "Add the sheets" };
      if (!dr.value.trim() || !cr.value.trim()) return { lines: [{ text: "Name the accounts to debit and credit.", warn: true }], apply: null, ok: "Add the sheets" };
      const post: PostingDay = posting.value === "day" ? Math.max(1, Math.min(31, Math.trunc(Number(day.value) || 1))) : (posting.value as PostingDay);
      const k = kind.value as ScheduleKind;
      const input: ScheduleInput = {
        kind: k,
        amount: amt,
        start: s,
        end: e,
        method: method.value as ScheduleMethod,
        posting: post,
        debitAccount: dr.value.trim(),
        creditAccount: cr.value.trim(),
        description: desc.value.trim(),
        decimals: Math.max(0, Math.min(6, Math.trunc(Number(decimals.value) || 0))),
      };
      const name = (desc.value.trim() || (k === "prepayment" ? "Prepayment" : k === "accrual" ? "Accrual" : "Deferred income")).slice(0, 20);
      const out = scheduleSheets(input, name);
      const first = out.schedule.rows[0];
      return {
        lines: [{ text: `${plural(out.months, "month")}, ${money(first[5] as number)} in the first month; ${plural(out.journal.rows.length, "journal line")}.` }],
        table: tablePreview(out.schedule),
        ok: "Add the sheets",
        apply: async () => {
          await addSheets(c.d, [out.schedule, out.journal]);
          c.d.status(`Schedule: ${plural(out.months, "month")} on "${out.schedule.name.slice(0, 31)}", journal on "${out.journal.name.slice(0, 31)}"`);
        },
      };
    },
  };
}

function journalTool(c: Ctx): Tool {
  const g = guessJournalMap(c.data);
  const required: JournalRole[] = ["date", "account"];
  const selects = Object.fromEntries(JOURNAL_ROLES.map((r) => [r, columnSelect(c.data.names, g[r], required.includes(r) ? undefined : "(none)", JOURNAL_LABEL[r])])) as Record<JournalRole, HTMLSelectElement>;
  const mapBox = grid(...JOURNAL_ROLES.map((r) => field(JOURNAL_LABEL[r], selects[r])));
  const names = Object.fromEntries((Object.keys(DEFAULT_LAYOUT.names) as (keyof JournalLayout["names"])[]).map((k) => [k, textInput(DEFAULT_LAYOUT.names[k])])) as Record<keyof JournalLayout["names"], HTMLInputElement>;
  const amounts = choice(
    [
      ["split", "Separate debit and credit columns"],
      ["signed", "One amount column (debits +, credits -)"],
    ],
    "split",
  );
  const dateStyle = choice(
    [
      ["yyyy-mm-dd", "2025-01-31"],
      ["dd/mm/yyyy", "31/01/2025"],
      ["mm/dd/yyyy", "01/31/2025"],
    ],
    "yyyy-mm-dd",
  );
  const withRef = checkbox("Include the reference column", g.reference >= 0);
  const asSheet = checkbox("Also add it as a new sheet", false);
  const nameBox = grid(...(["date", "account", "description", "debit", "credit", "amount", "reference"] as const).map((k) => field(k[0].toUpperCase() + k.slice(1), names[k])));
  const sync = () => {
    names.debit.parentElement!.hidden = names.credit.parentElement!.hidden = amounts.value !== "split";
    names.amount.parentElement!.hidden = amounts.value === "split";
    names.reference.parentElement!.hidden = !withRef.input.checked;
  };
  amounts.addEventListener("change", sync);
  withRef.input.addEventListener("change", sync);
  sync();
  const fileName = textInput(`${c.d.sheetName()} import.csv`);
  return {
    title: "Journal export template",
    intro: "Turns a schedule's journal, or any table of debits and credits, into a plain import layout: date, account, description, debit, credit. Map the columns, rename the headers to what your accounting system expects, and download a CSV.",
    fields: [field("Columns in this sheet", mapBox, "Map either Debit and Credit, or one signed Amount."), field("Amounts as", amounts), field("Dates as", dateStyle), withRef.el, field("Header names in the file", nameBox), field("File name", fileName), asSheet.el],
    compute() {
      const map = Object.fromEntries(JOURNAL_ROLES.map((r) => [r, Number(selects[r].value)])) as Record<JournalRole, number>;
      if (map.debit < 0 && map.credit < 0 && map.amount < 0) return { lines: [{ text: "Map the Debit and Credit columns, or an Amount column.", warn: true }], apply: null, ok: "Download CSV" };
      const layout: JournalLayout = {
        names: Object.fromEntries(Object.entries(names).map(([k, i]) => [k, i.value.trim() || DEFAULT_LAYOUT.names[k as keyof JournalLayout["names"]]])) as JournalLayout["names"],
        amounts: amounts.value as "split" | "signed",
        dateStyle: dateStyle.value as DateStyle,
        reference: withRef.input.checked,
        decimals: 2,
      };
      const out = journalExport(c.data, map, layout);
      const lines: Preview["lines"] = [{ text: `${plural(out.rows.length, "line")}: debits ${money(out.debit)}, credits ${money(out.credit)}.` }];
      const diff = Math.round((out.debit - out.credit) * 100) / 100;
      if (diff) lines.push({ text: `Debits and credits differ by ${money(diff)}: most systems will reject the file.`, warn: true });
      if (out.unbalanced.length) lines.push({ text: `${plural(out.unbalanced.length, "entry", "entries")} don't balance on their own (${out.unbalanced.slice(0, 5).join(", ")}${out.unbalanced.length > 5 ? "…" : ""}).`, warn: true });
      if (out.badDates) lines.push({ text: `${plural(out.badDates, "date")} couldn't be read and are left blank.`, warn: true });
      if (out.skipped) lines.push({ text: `${plural(out.skipped, "empty row")} left out.` });
      const file = (fileName.value.trim() || "journal.csv").replace(/[\\/:*?"<>|]/g, "_");
      return {
        lines,
        table: [out.header, ...out.rows.slice(0, PREVIEW_ROWS)],
        ok: asSheet.input.checked ? "Download and add the sheet" : "Download CSV",
        apply: out.rows.length
          ? async () => {
              downloadText(toCsv(out.header, out.rows), /\.csv$/i.test(file) ? file : `${file}.csv`);
              if (asSheet.input.checked) await addSheets(c.d, [{ name: `${c.sheet} import`, header: out.header, rows: out.values, numFmts: out.header.map((_, i) => (i === 0 ? DATE : i >= 3 && i < (layout.amounts === "split" ? 5 : 4) ? MONEY : "")) }]);
              c.d.status(`Journal export: ${plural(out.rows.length, "line")} saved to ${file}`);
            }
          : null,
      };
    },
  };
}

function downloadText(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const TOOLS: Record<TimeToolKind, (c: Ctx) => Tool> = {
  fiscal: fiscalTool,
  periods: periodsTool,
  bva: bvaTool,
  currency: currencyTool,
  schedule: scheduleTool,
  journal: journalTool,
};

// --------------------------------------------------------------- dialog --

export function openTimeTool(kind: TimeToolKind, d: TimeDeps): void {
  const src = d.source();
  const data = readSheet(src);
  const c: Ctx = { d, src, data, sheet: d.sheetName().slice(0, 18), sheetId: d.activeSheet() };
  const needsData = kind !== "schedule" && kind !== "bva";
  const noData = needsData && (!data.names.length || !data.rows);
  const fewSheets = (kind === "bva" || kind === "currency") && d.workbook().sheets.filter((s) => !s.hidden).length < 2;
  if (noData || fewSheets) {
    openToolNotice(
      noData ? "Nothing to work on" : "This needs two sheets",
      noData ? "This sheet has no data yet. Open or paste the data first, with a header row (or column names) naming the columns." : kind === "bva" ? "Put the actuals on one sheet and the budget on another, then try again." : "Put the exchange rates (date, from, to, rate) on a sheet of their own, then try again.",
      d.focusGrid,
    );
    return;
  }
  openToolDialog(TOOLS[kind](c), { focusGrid: d.focusGrid });
}
