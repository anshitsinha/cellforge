/**
 * Data checks: rules about a table that can be run again and again (column
 * not blank, unique, of a type, in a range, matching a pattern, in a master
 * list; totals that must agree; a row count; no duplicate keys; a formula
 * that must be TRUE on every row). Checks are plain JSON so they can be saved
 * with a workbook. runChecks gives each a pass / fail / warn, how many rows
 * were checked and failed, the first failing rows with their values, and a
 * message in plain words.
 *
 * Tables are read through a small accessor, so this stays independent of
 * the sheet model; formulas are worked out by a callback for the same reason.
 */
import { parseDateLoose } from "../clean/values";
import { isDateFormat } from "../numfmt";

export type CheckValue = number | string | boolean | null;

/** How values are compared with a master list (or with each other for unique / duplicate keys). */
export interface CheckNormalise {
  /** ignore upper / lower case (default true) */
  ignoreCase?: boolean;
  /** trim and collapse runs of spaces (default true) */
  spaces?: boolean;
  /** drop leading zeros from codes: 00123 = 123 */
  leadingZeros?: boolean;
  /** drop punctuation: A-123 = A123, Smith & Co. = Smith Co */
  punctuation?: boolean;
}

export type CheckKind = "notBlank" | "unique" | "type" | "range" | "pattern" | "inList" | "totalsEqual" | "rowCount" | "noDuplicateKeys" | "formula";

interface CheckBase {
  /** stable id, so results and edits can refer to the check */
  id: string;
  /** what the reviewer calls it; a description is made up when empty */
  name?: string;
  /** the sheet the check reads (an id or a name; the table accessor resolves it) */
  sheet: string;
  /** "warn": a failure shows amber and doesn't block export (default "fail") */
  severity?: "fail" | "warn";
  /** false: skipped */
  enabled?: boolean;
}

export type CheckDef = CheckBase &
  (
    | { kind: "notBlank"; col: number }
    | { kind: "unique"; col: number; normalise?: CheckNormalise }
    | { kind: "type"; col: number; type: "number" | "date" | "text"; allowBlank?: boolean }
    | { kind: "range"; col: number; min?: number; max?: number; allowBlank?: boolean }
    | { kind: "pattern"; col: number; pattern: string; ignoreCase?: boolean; allowBlank?: boolean }
    | { kind: "inList"; col: number; listSheet: string; listCol: number; normalise?: CheckNormalise; allowBlank?: boolean }
    /**
     * Sum of `col` must equal: the sum of `otherCol` (on `otherSheet`, default
     * the same sheet), or else `control` (0 when neither is given: a signed
     * amount column whose debits and credits cancel). Within `tolerance`.
     */
    | { kind: "totalsEqual"; col: number; otherCol?: number; otherSheet?: string; control?: number; tolerance?: number }
    | { kind: "rowCount"; min?: number; max?: number }
    | { kind: "noDuplicateKeys"; cols: number[]; normalise?: CheckNormalise }
    /** a formula written for the first data row (like =C2>0), moved down for each row; must be TRUE */
    | { kind: "formula"; formula: string }
  );

/** One table to check: data rows only (no header), 0-based. */
export interface CheckTable {
  rows: number;
  cols: number;
  get(row: number, col: number): CheckValue;
  /** column names, for messages */
  names?: readonly string[];
  /** number format of a column: dates are numbers shown with a date format */
  numFmt?(col: number): string;
}

export interface CheckSource {
  /** the table for a sheet id or name, or null when there's no such sheet */
  table(sheet: string): CheckTable | null;
}

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckFailure {
  /** data row (0-based, not counting the header); -1 for a check about the whole table */
  row: number;
  /** column, or -1 */
  col: number;
  value: CheckValue;
  /** why this row failed, when the value alone doesn't say */
  note?: string;
}

export interface CheckResult {
  id: string;
  name: string;
  kind: CheckKind;
  sheet: string;
  status: CheckStatus;
  /** rows looked at */
  checked: number;
  /** rows that broke the rule (for totals and row counts: 1 when it fails) */
  failed: number;
  /** the first failing rows, in sheet order */
  failures: CheckFailure[];
  message: string;
  /** set when the check couldn't run (missing sheet, bad pattern…) */
  problem?: string;
  /** totals: the two sides and the difference */
  totals?: { left: number; right: number; difference: number };
}

export interface RunChecksOptions {
  /** failing rows kept per check (default 20) */
  maxFailures?: number;
  /**
   * Work out a formula check's formula for one data row of a sheet. Without
   * it, formula checks report that they can't run.
   */
  evalFormula?(formula: string, sheet: string, row: number): unknown;
}

export const CHECK_KIND_LABEL: Record<CheckKind, string> = {
  notBlank: "Not blank",
  unique: "Unique",
  type: "Type",
  range: "In range",
  pattern: "Matches pattern",
  inList: "In master list",
  totalsEqual: "Totals agree",
  rowCount: "Row count",
  noDuplicateKeys: "No duplicate keys",
  formula: "Formula TRUE on every row",
};

const isBlank = (v: CheckValue) => v === null || (typeof v === "string" && v.trim() === "");
const textOf = (v: CheckValue) => (v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
const fmtNum = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 6 }));
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The key a value is compared by: normalised text (numbers by their digits). */
export function normaliseKey(v: CheckValue, n: CheckNormalise = {}): string {
  let t = textOf(v);
  if (n.spaces !== false) t = t.trim().replace(/\s+/g, " ");
  if (n.ignoreCase !== false) t = t.toLowerCase();
  if (n.punctuation) t = t.replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  if (n.leadingZeros) t = t.replace(/(^|[^\d.])0+(?=\d)/g, "$1");
  return t;
}

/** Why a check can't be run as written, or null. */
export function checkProblem(def: CheckDef): string | null {
  if (!def.sheet) return "Pick a sheet.";
  switch (def.kind) {
    case "range":
      if (def.min === undefined && def.max === undefined) return "Give a lowest or a highest value (or both).";
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) return "The lowest value is above the highest.";
      return null;
    case "pattern":
      if (!def.pattern) return "Type a pattern.";
      try {
        new RegExp(def.pattern);
      } catch (e) {
        return `That isn't a valid pattern: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`;
      }
      return null;
    case "inList":
      return def.listSheet ? null : "Pick the sheet that holds the master list.";
    case "rowCount":
      if (def.min === undefined && def.max === undefined) return "Give a lowest or a highest row count (or both).";
      if (def.min !== undefined && def.max !== undefined && def.min > def.max) return "The lowest count is above the highest.";
      return null;
    case "noDuplicateKeys":
      return def.cols.length ? null : "Pick the key columns.";
    case "formula":
      return def.formula.replace(/^=/, "").trim() ? null : "Type a formula.";
    case "totalsEqual":
      if (def.tolerance !== undefined && def.tolerance < 0) return "The tolerance can't be negative.";
      return null;
    default:
      return null;
  }
}

const colName = (t: CheckTable | null, c: number) => {
  const n = t?.names?.[c];
  return n ? n : `column ${c + 1}`;
};

/** A short description of what a check tests, for lists and default names. */
export function describeCheck(def: CheckDef, names?: readonly string[], listNames?: readonly string[]): string {
  const col = (c: number, ns = names) => ns?.[c] || `column ${c + 1}`;
  switch (def.kind) {
    case "notBlank":
      return `${col(def.col)} is never blank`;
    case "unique":
      return `${col(def.col)} has no repeated values`;
    case "type":
      return `${col(def.col)} is all ${def.type === "number" ? "numbers" : def.type === "date" ? "dates" : "text"}`;
    case "range":
      return def.min !== undefined && def.max !== undefined
        ? `${col(def.col)} is between ${fmtNum(def.min)} and ${fmtNum(def.max)}`
        : def.min !== undefined
          ? `${col(def.col)} is at least ${fmtNum(def.min)}`
          : `${col(def.col)} is at most ${fmtNum(def.max ?? 0)}`;
    case "pattern":
      return `${col(def.col)} matches ${def.pattern}`;
    case "inList":
      return `${col(def.col)} is in the master list (${col(def.listCol, listNames)})`;
    case "totalsEqual": {
      const tol = def.tolerance ? ` (within ${fmtNum(def.tolerance)})` : "";
      if (def.otherCol !== undefined && def.otherCol >= 0) return `total of ${col(def.col)} = total of ${col(def.otherCol, def.otherSheet && def.otherSheet !== def.sheet ? listNames : names)}${tol}`;
      return `total of ${col(def.col)} = ${fmtNum(def.control ?? 0)}${tol}`;
    }
    case "rowCount":
      return def.min !== undefined && def.max !== undefined
        ? `between ${fmtNum(def.min)} and ${fmtNum(def.max)} rows`
        : def.min !== undefined
          ? `at least ${plural(def.min, "row")}`
          : `at most ${plural(def.max ?? 0, "row")}`;
    case "noDuplicateKeys":
      return `no two rows share the same ${def.cols.map((c) => col(c)).join(" + ")}`;
    case "formula":
      return `${def.formula.startsWith("=") ? def.formula : "=" + def.formula} is TRUE on every row`;
  }
}

function isDateValue(v: CheckValue, dateFormatted: boolean | null): boolean {
  if (typeof v === "number") return dateFormatted === null ? v >= 1 && v < 2_958_466 : dateFormatted;
  if (typeof v === "string") return parseDateLoose(v, "dmy") !== null || parseDateLoose(v, "mdy") !== null;
  return false;
}

const truthy = (r: unknown) => r === true || (typeof r === "number" && r !== 0 && Number.isFinite(r)) || (typeof r === "string" && r.toUpperCase() === "TRUE");

/** Run the checks against the tables. Disabled checks are left out. */
export function runChecks(defs: readonly CheckDef[], source: CheckSource, opts: RunChecksOptions = {}): CheckResult[] {
  const max = opts.maxFailures ?? 20;
  const out: CheckResult[] = [];
  for (const def of defs) {
    if (def.enabled === false) continue;
    out.push(runOne(def, source, max, opts));
  }
  return out;
}

function runOne(def: CheckDef, source: CheckSource, max: number, opts: RunChecksOptions): CheckResult {
  const table = source.table(def.sheet);
  const failures: CheckFailure[] = [];
  let failed = 0;
  let checked = 0;
  let listTable: CheckTable | null = null;
  if (def.kind === "inList") listTable = source.table(def.listSheet);
  if (def.kind === "totalsEqual" && def.otherSheet) listTable = source.table(def.otherSheet);
  const name = def.name?.trim() || describeCheck(def, table?.names, listTable?.names);
  const base = { id: def.id, name, kind: def.kind, sheet: def.sheet };
  const broken = (problem: string): CheckResult => ({ ...base, status: def.severity === "warn" ? "warn" : "fail", checked: 0, failed: 0, failures: [], message: `Can't run: ${problem}`, problem });
  const problem = checkProblem(def);
  if (problem) return broken(problem);
  if (!table) return broken(`there's no sheet "${def.sheet}".`);
  const fail = (row: number, col: number, value: CheckValue, note?: string) => {
    failed++;
    if (failures.length < max) failures.push(note ? { row, col, value, note } : { row, col, value });
  };
  const needCol = (c: number, t: CheckTable = table) => c >= 0 && c < Math.max(t.cols, 1);
  if ("col" in def && !needCol(def.col)) return broken(`${colName(table, def.col)} isn't in the sheet.`);
  let totals: CheckResult["totals"];
  let summary = "";

  switch (def.kind) {
    case "notBlank":
      for (let r = 0; r < table.rows; r++) {
        checked++;
        const v = table.get(r, def.col);
        if (isBlank(v)) fail(r, def.col, v);
      }
      summary = `${plural(failed, "blank cell")} in ${colName(table, def.col)}`;
      break;
    case "unique":
    case "noDuplicateKeys": {
      const cols = def.kind === "unique" ? [def.col] : def.cols;
      for (const c of cols) if (!needCol(c)) return broken(`${colName(table, c)} isn't in the sheet.`);
      const first = new Map<string, number>();
      for (let r = 0; r < table.rows; r++) {
        const vals = cols.map((c) => table.get(r, c));
        if (vals.every(isBlank)) continue;
        checked++;
        const key = vals.map((v) => normaliseKey(v, def.normalise)).join("\u0001");
        const at = first.get(key);
        if (at === undefined) first.set(key, r);
        else fail(r, cols[0], vals.length === 1 ? vals[0] : vals.map(textOf).join(" | "), `same as row ${at + 1} of the data`);
      }
      summary = `${plural(failed, "repeated row")} (${cols.map((c) => colName(table, c)).join(" + ")})`;
      break;
    }
    case "type": {
      const fmt = table.numFmt ? table.numFmt(def.col) : undefined;
      const dateFormatted = fmt === undefined ? null : isDateFormat(fmt);
      for (let r = 0; r < table.rows; r++) {
        const v = table.get(r, def.col);
        if (isBlank(v)) {
          if (def.allowBlank === false) {
            checked++;
            fail(r, def.col, v, "blank");
          }
          continue;
        }
        checked++;
        if (def.type === "number") {
          if (typeof v !== "number") fail(r, def.col, v, typeof v === "string" && /^\s*[-+(]?[$£€]?\s*[\d,]+(\.\d+)?\)?\s*$/.test(v) ? "number stored as text" : "not a number");
        } else if (def.type === "date") {
          if (!isDateValue(v, dateFormatted)) fail(r, def.col, v, "not a date");
        } else if (typeof v !== "string") fail(r, def.col, v, "not text");
      }
      summary = `${plural(failed, "value")} in ${colName(table, def.col)} ${failed === 1 ? "isn't" : "aren't"} ${def.type === "number" ? "a number" : def.type === "date" ? "a date" : "text"}`;
      break;
    }
    case "range":
      for (let r = 0; r < table.rows; r++) {
        const v = table.get(r, def.col);
        if (isBlank(v)) {
          if (def.allowBlank === false) {
            checked++;
            fail(r, def.col, v, "blank");
          }
          continue;
        }
        checked++;
        if (typeof v !== "number") fail(r, def.col, v, "not a number");
        else if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) fail(r, def.col, v, def.min !== undefined && v < def.min ? "too low" : "too high");
      }
      summary = `${plural(failed, "value")} out of range in ${colName(table, def.col)}`;
      break;
    case "pattern": {
      const re = new RegExp(def.pattern, def.ignoreCase ? "iu" : "u");
      for (let r = 0; r < table.rows; r++) {
        const v = table.get(r, def.col);
        if (isBlank(v)) {
          if (def.allowBlank === false) {
            checked++;
            fail(r, def.col, v, "blank");
          }
          continue;
        }
        checked++;
        if (!re.test(textOf(v))) fail(r, def.col, v);
      }
      summary = `${plural(failed, "value")} in ${colName(table, def.col)} ${failed === 1 ? "doesn't" : "don't"} match`;
      break;
    }
    case "inList": {
      if (!listTable) return broken(`there's no sheet "${def.listSheet}" for the master list.`);
      if (!needCol(def.listCol, listTable)) return broken(`the master list column isn't in "${def.listSheet}".`);
      const keys = new Set<string>();
      for (let r = 0; r < listTable.rows; r++) {
        const v = listTable.get(r, def.listCol);
        if (!isBlank(v)) keys.add(normaliseKey(v, def.normalise));
      }
      if (!keys.size) return broken("the master list is empty.");
      for (let r = 0; r < table.rows; r++) {
        const v = table.get(r, def.col);
        if (isBlank(v)) {
          if (def.allowBlank === false) {
            checked++;
            fail(r, def.col, v, "blank");
          }
          continue;
        }
        checked++;
        if (!keys.has(normaliseKey(v, def.normalise))) fail(r, def.col, v, "not in the master list");
      }
      summary = `${plural(failed, "value")} in ${colName(table, def.col)} ${failed === 1 ? "isn't" : "aren't"} in the master list (${plural(keys.size, "entry", "entries")})`;
      break;
    }
    case "totalsEqual": {
      const sum = (t: CheckTable, c: number) => {
        let s = 0;
        let n = 0;
        let text = 0;
        for (let r = 0; r < t.rows; r++) {
          const v = t.get(r, c);
          if (typeof v === "number" && Number.isFinite(v)) {
            s += v;
            n++;
          } else if (!isBlank(v)) text++;
        }
        return { s, n, text };
      };
      const a = sum(table, def.col);
      checked = a.n;
      let right = def.control ?? 0;
      let rightLabel = fmtNum(right);
      let skipped = a.text;
      if (def.otherCol !== undefined && def.otherCol >= 0) {
        const t = def.otherSheet ? listTable : table;
        if (!t) return broken(`there's no sheet "${def.otherSheet}".`);
        if (!needCol(def.otherCol, t)) return broken(`${colName(t, def.otherCol)} isn't in the sheet.`);
        const b = sum(t, def.otherCol);
        right = b.s;
        rightLabel = `${colName(t, def.otherCol)} ${fmtNum(round(right))}`;
        checked += t === table ? 0 : b.n;
        skipped += b.text;
      }
      const diff = round(a.s - right);
      totals = { left: round(a.s), right: round(right), difference: diff };
      const ok = Math.abs(diff) <= (def.tolerance ?? 0) + 1e-9;
      if (!ok) {
        failed = 1;
        failures.push({ row: -1, col: def.col, value: diff, note: "difference" });
      }
      summary = `${colName(table, def.col)} ${fmtNum(round(a.s))} vs ${rightLabel}: ${ok ? (diff === 0 ? "they agree" : `difference ${fmtNum(diff)}, within tolerance`) : `difference ${fmtNum(diff)}`}${skipped ? `; ${plural(skipped, "text value")} not added` : ""}`;
      break;
    }
    case "rowCount": {
      let n = 0;
      for (let r = 0; r < table.rows; r++) {
        for (let c = 0; c < table.cols; c++) {
          if (!isBlank(table.get(r, c))) {
            n++;
            break;
          }
        }
      }
      checked = n;
      const ok = (def.min === undefined || n >= def.min) && (def.max === undefined || n <= def.max);
      if (!ok) {
        failed = 1;
        failures.push({ row: -1, col: -1, value: n, note: def.min !== undefined && n < def.min ? "too few rows" : "too many rows" });
      }
      summary = `${plural(n, "row")} (${describeCheck(def)})`;
      break;
    }
    case "formula": {
      if (!opts.evalFormula) return broken("formulas can't be worked out here.");
      for (let r = 0; r < table.rows; r++) {
        let empty = true;
        for (let c = 0; c < table.cols && empty; c++) if (!isBlank(table.get(r, c))) empty = false;
        if (empty) continue;
        checked++;
        let v: unknown;
        try {
          v = opts.evalFormula(def.formula, def.sheet, r);
        } catch (e) {
          v = (e as Error).message;
        }
        if (!truthy(v)) fail(r, -1, typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : v === null || v === undefined ? null : String(v), "formula isn't TRUE");
      }
      summary = `${plural(failed, "row")} where the formula isn't TRUE`;
      break;
    }
  }
  const status: CheckStatus = failed === 0 ? "pass" : def.severity === "warn" ? "warn" : "fail";
  const message = failed === 0 && def.kind !== "totalsEqual" && def.kind !== "rowCount" ? `All ${plural(checked, "row")} pass` : summary;
  return { ...base, status, checked, failed, failures, message, ...(totals ? { totals } : {}) };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** True when no check fails (warnings don't count). */
export function checksAllPass(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.status !== "fail");
}
