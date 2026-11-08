/**
 * A deterministic parser for the common things people type: "sort by
 * amount descending", "filter region is North", "freeze top row". No model:
 * a list of patterns, each turning a match into actions from the catalog,
 * with column names resolved against the sheet's headers (any case, close
 * spellings). When something is missing or unclear it says what to ask
 * instead of guessing; when nothing matches it returns null so a model (or
 * the "here's what I can do" help) can take over.
 */
import type { Action } from "@cellforge/actions";
import {
  type AskContext,
  type CellRange,
  type SheetInfo,
  activeSheet,
  closestColumns,
  colCount,
  columnData,
  columnIndex,
  columnLabel,
  columnLetter,
  findColumn,
  firstDataRow,
  rangeRef,
} from "./context";
import { COLORS, COLOR_WORDS, parseCount, parseDateSerial, parseNumber, splitList, unquote } from "./words";

export interface ParseResult {
  /** the action to run, when there is exactly one */
  action?: Action;
  /** the actions to run in order, when there are several */
  actions?: Action[];
  /**
   * A palette command to run instead of an action, for things that are not
   * actions themselves: "undo", "redo", or a tool to open ("pivot").
   */
  command?: string;
  /**
   * A figure to work out and show, not a change: "total of amount" →
   * SUM of the Amount column. The app shows the number and offers to
   * insert the formula.
   */
  figure?: Figure;
  /** 0..1: how sure the parser is that this is what was meant */
  confidence: number;
  /** plain English: what will happen */
  explanation: string;
  /** questions to ask before anything can run; empty when it's ready */
  missing: string[];
}

/** A single figure over one column: what "total of amount" asks for. */
export interface Figure {
  fn: "SUM" | "AVERAGE" | "COUNTA" | "MIN" | "MAX";
  col: number;
  /** the column's data cells */
  range: CellRange;
  /** set when the request named another sheet */
  sheet?: string;
  /** "Total of Amount (column C)" */
  label: string;
  /** "=SUM(C2:C200)", relative to the sheet it is on */
  formula: string;
}

/** Every action a result would run, in order. */
export function actionsOf(r: ParseResult | null): Action[] {
  if (!r) return [];
  return r.actions ?? (r.action ? [r.action] : []);
}

/** Thrown by a rule when it needs to ask something. */
class Ask {
  constructor(readonly question: string) {}
}

interface Env {
  ctx: AskContext;
  sheet: SheetInfo;
  /** set when the request named a sheet other than the active one */
  sheetParam?: string;
  fuzzy: boolean;
  usedSelection: boolean;
}

interface Out {
  actions?: Action[];
  command?: string;
  figure?: Figure;
  explanation: string;
  confidence?: number;
}

type Rule = { re: RegExp; run: (m: RegExpExecArray, env: Env) => Out };

// ------------------------------------------------------------ resolvers --

const SELECTION = /^(?:the\s+)?(?:current\s+|selected\s+|highlighted\s+)?(?:selection|selected(?:\s+(?:cells|range|area))?|cells|range|this|these|that|it|them|here)$/i;
const THIS_COLUMN = /^(?:this|the\s+(?:current|selected|active))\s+column$|^(?:this|the\s+current)\s+one$/i;

function quote(t: string) {
  return `"${t}"`;
}

function noColumn(env: Env, raw: string, why: "unknown" | "ambiguous" | "outside", candidates: number[]): Ask {
  const name = unquote(raw);
  if (why === "outside") return new Ask(`Column ${name.replace(/^col(?:umn)?\s+/i, "").toUpperCase()} is past the last column of ${env.sheet.name}.`);
  if (why === "ambiguous") return new Ask(`Which column do you mean by ${quote(name)}: ${candidates.map((c) => columnLabel(env.sheet, c)).join(" or ")}?`);
  const close = closestColumns(env.sheet, name);
  const named = env.sheet.columns.filter((c) => c);
  if (!named.length) return new Ask(`I can't find a column called ${quote(name)}. Use a column letter, like "column C".`);
  return new Ask(
    `I can't find a column called ${quote(name)}.` + (close.length ? ` Did you mean ${close.map((c) => quote(env.sheet.columns[c])).join(", ")}?` : ""),
  );
}

/** A single column, by header name or letter, or "this column". */
function column(env: Env, raw: string): number {
  const text = raw.trim();
  if (THIS_COLUMN.test(text) || SELECTION.test(text)) {
    env.usedSelection = true;
    return env.ctx.selection.left;
  }
  const m = findColumn(env.sheet, text);
  if (!m.ok) throw noColumn(env, text, m.reason, m.candidates);
  if (!m.exact) env.fuzzy = true;
  return m.col;
}

/** Spans of columns: "D", "D to F", "D:F", "Region and Amount", "the notes column". */
function columnSpans(env: Env, raw: string): [number, number][] {
  const text = raw.trim().replace(/^(?:the\s+)?(?:columns?|cols?)\s+/i, "");
  if (SELECTION.test(text) || /^(?:the\s+)?selected(?:\s+columns?)?$/i.test(text) || THIS_COLUMN.test(text)) {
    env.usedSelection = true;
    return [[env.ctx.selection.left, env.ctx.selection.right]];
  }
  const span = /^([A-Za-z]{1,3})\s*(?:to|through|thru|-|–|:)\s*([A-Za-z]{1,3})$/i.exec(text);
  if (span) {
    const a = columnIndex(span[1]);
    const b = columnIndex(span[2]);
    const n = colCount(env.sheet);
    if (Math.max(a, b) >= n) throw new Ask(`Column ${columnLetter(Math.max(a, b))} is past the last column of ${env.sheet.name}.`);
    return [[Math.min(a, b), Math.max(a, b)]];
  }
  const whole = findColumn(env.sheet, text);
  if (whole.ok) {
    if (!whole.exact) env.fuzzy = true;
    return [[whole.col, whole.col]];
  }
  const parts = splitList(text);
  if (parts.length < 2) throw noColumn(env, text, whole.reason, whole.candidates);
  return mergeSpans(parts.flatMap((p) => columnSpans(env, p)));
}

function mergeSpans(spans: [number, number][]): [number, number][] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

/** Spans of rows (0-based) from "5", "5 to 8", "5-8", "3, 5 and 9", "the selected rows". */
function rowSpans(env: Env, raw: string): [number, number][] {
  const text = raw.trim().replace(/^(?:the\s+)?rows?\s+/i, "");
  if (SELECTION.test(text) || /^(?:the\s+)?selected(?:\s+rows?)?$/i.test(text) || /^(?:this|the\s+current)\s+row$/i.test(text)) {
    env.usedSelection = true;
    return [[env.ctx.selection.top, env.ctx.selection.bottom]];
  }
  if (/^(?:the\s+)?(?:header|top|first)(?:\s+row)?$/i.test(text)) return [[0, 0]];
  if (/^(?:the\s+)?last(?:\s+row)?$/i.test(text)) return [[env.sheet.rowCount - 1, env.sheet.rowCount - 1]];
  const spans: [number, number][] = [];
  for (const part of text.split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)) {
    const m = /^(?:row\s+)?(\d+)(?:\s*(?:to|through|thru|until|-|–|:)\s*(?:row\s+)?(\d+))?$/i.exec(part.trim());
    if (!m) throw new Ask(`Which rows? Say something like "rows 5 to 8".`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (Math.min(a, b) < 1) throw new Ask("Rows are numbered from 1.");
    spans.push([Math.min(a, b) - 1, Math.max(a, b) - 1]);
  }
  const merged = mergeSpans(spans);
  const last = merged[merged.length - 1][1];
  if (last >= env.sheet.rowCount) throw new Ask(`Row ${last + 1} is past the end of ${env.sheet.name} (it has ${env.sheet.rowCount.toLocaleString("en-US")} rows).`);
  return merged;
}

interface Target {
  range: CellRange;
  label: string;
}

/**
 * Cells to act on: "the selection", "B2:B20", "row 3", "the header row",
 * "columns B to D", or a column by name or letter. `whole` makes a column
 * mean every row (for bold); otherwise the cells under the header.
 */
function target(env: Env, raw: string, whole: boolean): Target {
  const text = unquote(raw.replace(/^(?:the\s+)?(?:cells?\s+(?:in\s+)?|values\s+in\s+|range\s+)/i, ""));
  const n = colCount(env.sheet);
  const lastRow = Math.max(0, env.sheet.rowCount - 1);
  if (SELECTION.test(text)) {
    env.usedSelection = true;
    return { range: { ...env.ctx.selection }, label: `the selection (${rangeRef(env.ctx.selection)})` };
  }
  const a1 = /^\$?([A-Za-z]{1,3})\$?(\d+)(?:\s*:\s*\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(text);
  if (a1) {
    const c1 = columnIndex(a1[1]);
    const r1 = Number(a1[2]) - 1;
    const c2 = a1[3] ? columnIndex(a1[3]) : c1;
    const r2 = a1[4] ? Number(a1[4]) - 1 : r1;
    if (r1 < 0 || r2 < 0) throw new Ask("Rows are numbered from 1.");
    const range = { top: Math.min(r1, r2), bottom: Math.max(r1, r2), left: Math.min(c1, c2), right: Math.max(c1, c2) };
    if (range.right >= n) throw new Ask(`Column ${columnLetter(range.right)} is past the last column of ${env.sheet.name}.`);
    if (range.bottom > lastRow) throw new Ask(`Row ${range.bottom + 1} is past the end of ${env.sheet.name} (it has ${env.sheet.rowCount.toLocaleString("en-US")} rows).`);
    return { range, label: rangeRef(range) };
  }
  if (/^(?:the\s+)?(?:header|headers|heading|headings|column names|titles)(?:\s+row)?$/i.test(text) || /^(?:the\s+)?(?:top|first)\s+row$/i.test(text)) {
    if (env.sheet.headerRow < 0 && /head|title|name/i.test(text)) throw new Ask(`${env.sheet.name}'s column names are not in a row of cells, so they can't be formatted. Say "row 1" to format the first row.`);
    const row = Math.max(0, env.sheet.headerRow);
    return { range: { top: row, bottom: row, left: 0, right: Math.max(0, n - 1) }, label: env.sheet.headerRow >= 0 ? "the header row" : "row 1" };
  }
  if (/^(?:the\s+)?(?:rows?\s+\d|selected\s+rows?|current\s+row|this\s+row)/i.test(text)) {
    const spans = rowSpans(env, text);
    const range = { top: spans[0][0], bottom: spans[spans.length - 1][1], left: 0, right: Math.max(0, n - 1) };
    return { range, label: range.top === range.bottom ? `row ${range.top + 1}` : `rows ${range.top + 1} to ${range.bottom + 1}` };
  }
  if (/^(?:the\s+)?(?:whole\s+|entire\s+)?(?:sheet|table|data|everything)$/i.test(text)) {
    return { range: { top: 0, left: 0, bottom: lastRow, right: Math.max(0, n - 1) }, label: "the whole sheet" };
  }
  const spans = columnSpans(env, text);
  if (spans.length > 1) throw new Ask("Name one block of columns at a time, like \"columns B to D\".");
  const [l, r] = spans[0];
  const range = whole ? { top: 0, left: l, bottom: lastRow, right: r } : columnData(env.sheet, l, r);
  const label = l === r ? columnLabel(env.sheet, l) : `columns ${columnLetter(l)} to ${columnLetter(r)}`;
  return { range, label };
}

// --------------------------------------------------------------- values --

const NUMBER_FORMATS: [RegExp, string | null, string][] = [
  [/^(?:currency|money|dollars?|usd|\$)$/, "$#,##0.00", "currency ($1,234.50)"],
  [/^(?:euros?|eur|€)$/, "€#,##0.00", "euros (€1,234.50)"],
  [/^(?:pounds?|gbp|sterling|£)$/, "£#,##0.00", "pounds (£1,234.50)"],
  [/^(?:accounting|accountancy)$/, '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', "accounting"],
  [/^(?:percent|percents|percentages?|%|pct)$/, "0.0%", "a percentage (12.5%)"],
  [/^(?:dates?|short dates?|iso dates?)$/, "yyyy-mm-dd", "a date (2024-01-31)"],
  [/^(?:long dates?)$/, "d mmmm yyyy", "a long date (31 January 2024)"],
  [/^(?:times?)$/, "hh:mm", "a time (14:30)"],
  [/^(?:date and time|date ?times?|timestamps?)$/, "yyyy-mm-dd hh:mm", "a date and time"],
  [/^(?:numbers?|decimals?|two decimals|2 decimals|2 decimal places|two decimal places|comma style|commas)$/, "#,##0.00", "a number with two decimals (1,234.50)"],
  [/^(?:integers?|whole numbers?|thousands?|no decimals|0 decimals)$/, "#,##0", "a whole number (1,235)"],
  [/^(?:text|plain text|strings?)$/, "@", "text (kept exactly as typed)"],
  [/^(?:general|normal|default|no format)$/, null, "General (no number format)"],
];
const FORMAT_WORDS = "currency|money|dollars?|usd|euros?|eur|pounds?|gbp|sterling|accounting|accountancy|percent|percents|percentages?|pct|%|\\$|€|£|dates?|short dates?|iso dates?|long dates?|times?|date and time|date ?times?|timestamps?|numbers?|decimals?|two decimals|2 decimals|2 decimal places|two decimal places|comma style|commas|integers?|whole numbers?|thousands?|no decimals|0 decimals|text|plain text|strings?|general|normal|default|no format";

const OP_WORDS: [RegExp, string][] = [
  [/^(?:>=|=>|at least|greater than or equal to|more than or equal to|no less than|not less than|on or after)$/, ">="],
  [/^(?:<=|=<|at most|less than or equal to|no more than|not more than|up to|on or before)$/, "<="],
  [/^(?:>|over|above|greater than|more than|bigger than|larger than|higher than|exceeding|exceeds|after|later than)$/, ">"],
  [/^(?:<|under|below|less than|smaller than|fewer than|lower than|before|earlier than)$/, "<"],
  [/^(?:!=|<>|not|not equal to|does not equal|doesn't equal|isn't|aren't|other than)$/, "!="],
  [/^(?:=|==|equal to|equals|is|are|exactly|on)$/, "="],
  [/^(?:between)$/, "between"],
  [/^(?:not between|outside)$/, "notBetween"],
  [/^(?:contains|contain|containing|includes|including|with|has|like)$/, "contains"],
  [/^(?:does not contain|doesn't contain|not containing|without|excludes)$/, "notContains"],
  [/^(?:starts with|begins with|starting with|beginning with)$/, "begins"],
  [/^(?:ends with|ending with)$/, "ends"],
];
const OPS =
  ">=|=>|<=|=<|!=|<>|==|=|>|<|(?:is |are )?(?:at least|at most|greater than or equal to|more than or equal to|less than or equal to|no less than|not less than|no more than|not more than|up to|on or after|on or before|not equal to|equal to|greater than|more than|bigger than|larger than|higher than|less than|smaller than|fewer than|lower than|later than|earlier than|not between|between|outside|over|above|under|below|after|before|exactly|not containing|not|on)|does not equal|doesn't equal|isn't|aren't|other than|equals|exceeding|exceeds|does not contain|doesn't contain|contains|contain|containing|includes|including|excludes|starts with|begins with|starting with|beginning with|ends with|ending with|is|are";

function opOf(word: string): string {
  const w = word.toLowerCase().replace(/^(?:is|are)\s+(?=\S)/, "").trim();
  for (const [re, op] of OP_WORDS) if (re.test(w)) return op;
  return "=";
}

const OP_TEXT: Record<string, string> = {
  ">": "is over", ">=": "is at least", "<": "is under", "<=": "is at most", "=": "is", "!=": "isn't",
  between: "is between", notBetween: "is not between", contains: "contains", notContains: "doesn't contain", begins: "begins with", ends: "ends with",
};

const fmtNum = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 10 });

/** "10 and 20", "10-20", "10 to 20" → [10, 20] */
function twoValues(text: string): [string, string] | null {
  const m = /^(.+?)\s*(?:and|to|-|–)\s*(.+)$/i.exec(text.trim());
  return m ? [m[1], m[2]] : null;
}

const BLANK_WORDS = /^(?:blank|blanks|empty|missing|null|nothing)$/i;

// ---------------------------------------------------------------- rules --

const withSheet = (env: Env, params: Record<string, unknown>) => (env.sheetParam ? { ...params, sheet: env.sheetParam } : params);
const act = (env: Env, type: string, params: Record<string, unknown>): Action => ({ type, params: withSheet(env, params) });

function filterRule(env: Env, colText: string, opWord: string, valueText: string): Out {
  const col = column(env, colText);
  const label = columnLabel(env.sheet, col);
  const op = opOf(opWord);
  const value = unquote(valueText);
  const set = (condition: Record<string, unknown>, what: string): Out => ({
    actions: [act(env, "filter.set", { col, condition })],
    explanation: `Show only the rows where ${label} ${what}. Other rows are hidden, not deleted.`,
  });
  if ((op === "=" || op === "!=") && (BLANK_WORDS.test(value) || /^not\s+(?:blank|empty)$/i.test(value))) {
    const blank = op === "=" && !/^not\s/i.test(value);
    return set({ kind: "blanks", blank }, blank ? "is blank" : "is not blank");
  }
  if (op === "contains" || op === "notContains" || op === "begins" || op === "ends") {
    if (!value) throw new Ask("What text should it look for?");
    return set({ kind: "text", op, value }, `${OP_TEXT[op]} "${value}"`);
  }
  if (op === "between" || op === "notBetween") {
    const pair = twoValues(value);
    if (!pair) throw new Ask(`Between what? Say something like "between 100 and 500".`);
    const d1 = parseDateSerial(pair[0]);
    const d2 = parseDateSerial(pair[1]);
    if (!Number.isNaN(d1) && !Number.isNaN(d2) && op === "between") return set({ kind: "date", op: "between", a: Math.min(d1, d2), b: Math.max(d1, d2) }, `is between ${pair[0]} and ${pair[1]}`);
    const a = parseNumber(pair[0]);
    const b = parseNumber(pair[1]);
    if (Number.isNaN(a) || Number.isNaN(b)) throw new Ask(`Between which two numbers? I read "${pair[0]}" and "${pair[1]}".`);
    if (op === "notBetween") throw new Ask(`A filter can't say "not between" yet. Try two steps, or "${label} under ${fmtNum(Math.min(a, b))}".`);
    return set({ kind: "number", op: "between", a: Math.min(a, b), b: Math.max(a, b) }, `is between ${fmtNum(Math.min(a, b))} and ${fmtNum(Math.max(a, b))}`);
  }
  // dates: "after 2024-01-31"
  const serial = parseDateSerial(value);
  if (!Number.isNaN(serial) && (op === ">" || op === "<" || op === "=" || op === ">=" || op === "<=")) {
    const dateOp = op === ">" ? "after" : op === "<" ? "before" : op === "=" ? "on" : null;
    if (dateOp) return set({ kind: "date", op: dateOp, a: serial }, `is ${dateOp} ${value}`);
    return set({ kind: "number", op, a: serial }, `${OP_TEXT[op]} ${value}`);
  }
  if (/^(?:after|before|later than|earlier than|on or after|on or before)$/i.test(opWord.replace(/^(?:is|are)\s+/i, ""))) {
    throw new Ask(`Which date? Type it as year-month-day, like 2024-01-31.`);
  }
  if (op === "=" || op === "!=") {
    const items = splitList(value);
    if (op === "=" && items.length > 1) {
      const keys = items.map((v) => (Number.isNaN(parseNumber(v)) ? `s:${v.toLowerCase()}` : `n:${parseNumber(v)}`));
      return set({ kind: "values", keys }, `is ${items.map((v) => `"${v}"`).join(" or ")}`);
    }
    if (!value) throw new Ask(`What should ${label} be?`);
    const n = parseNumber(value);
    if (!Number.isNaN(n) && /\d/.test(value)) return set({ kind: "number", op, a: n }, `${op === "=" ? "is" : "isn't"} ${fmtNum(n)}`);
    return set({ kind: "text", op: op === "=" ? "equals" : "notEquals", value }, `${op === "=" ? "is" : "isn't"} "${value}"`);
  }
  const n = parseNumber(value);
  if (Number.isNaN(n)) throw new Ask(`What number should ${label} be compared with? I read "${value}".`);
  return set({ kind: "number", op, a: n }, `${OP_TEXT[op]} ${fmtNum(n)}`);
}

function sortKeys(env: Env, text: string, defaultDesc: boolean | undefined): { col: number; descending: boolean }[] {
  const DIR =
    /\s+(?:in\s+)?(asc|ascending|desc|descending|a\s*(?:to|-|→)\s*z|z\s*(?:to|-|→)\s*a|largest first|biggest first|highest first|smallest first|lowest first|newest first|latest first|most recent first|oldest first|earliest first|high to low|low to high|largest to smallest|smallest to largest|reversed?|alphabetically|alphabetical(?:ly)?)(?:\s+order)?$/i;
  const stripDir = (raw: string) => {
    const d = DIR.exec(" " + raw.trim());
    return d ? (" " + raw.trim()).slice(0, d.index).trim() : raw.trim();
  };
  const pieces = text
    .split(/\s*,\s*(?:and\s+)?(?:then\s+)?(?:by\s+)?|\s+(?:and\s+)?then\s+(?:by\s+)?/i)
    .filter((p) => p.trim())
    // "region and date": two keys, unless "and" is part of a header name
    .flatMap((p) => (/\s+and\s+/i.test(stripDir(p)) && !findColumn(env.sheet, stripDir(p)).ok ? p.split(/\s+and\s+/i) : [p]));
  const out: { col: number; descending: boolean }[] = [];
  for (const raw of pieces) {
    let p = raw.trim();
    let desc = defaultDesc;
    const d = DIR.exec(" " + p);
    if (d) {
      p = stripDir(p);
      desc = /^(?:desc|descending|z|largest first|biggest first|highest first|newest first|latest first|most recent first|high to low|largest to smallest|reversed?)/i.test(d[1]);
    }
    if (!p) throw new Ask("Sort by which column?");
    out.push({ col: column(env, p), descending: !!desc });
  }
  return out;
}

function sortOut(env: Env, keys: { col: number; descending: boolean }[]): Out {
  if (!keys.length) throw new Ask("Sort by which column?");
  const hasHeader = env.sheet.headerRow === 0;
  const words = keys.map((k, i) => `${i ? "then by " : ""}${columnLabel(env.sheet, k.col)}, ${k.descending ? "largest (or Z, or latest) first" : "smallest (or A, or earliest) first"}`);
  return {
    actions: [act(env, "rows.sortBy", { keys: keys.map((k) => ({ col: k.col, descending: k.descending })), hasHeader })],
    explanation: `Sort the rows by ${words.join("; ")}${hasHeader ? ", keeping the header row at the top" : ""}.`,
  };
}

function cfOut(env: Env, t: Target, rule: Record<string, unknown>, what: string, colorWord: string | undefined): Out {
  const c = COLORS[(colorWord ?? "red").toLowerCase()] ?? COLORS.red;
  const name = colorWord ? colorWord.toLowerCase() : "light red";
  return {
    actions: [act(env, "format.conditionalAdd", { rule: { ...rule, ranges: [t.range], format: { fill: c.fill, color: c.ink } } })],
    explanation: `Highlight cells in ${t.label} ${what} in ${name}. This is a conditional format, so it updates as the values change.`,
  };
}

function styleOut(env: Env, t: Target, style: Record<string, unknown>, what: string): Out {
  return { actions: [act(env, "format.set", { range: t.range, style })], explanation: `${what} ${t.label}.` };
}

function insertOut(env: Env, kind: "rows" | "cols", countText: string | undefined, where: string | undefined, posText: string | undefined): Out {
  const count = countText ? parseCount(countText) : 1;
  if (!Number.isFinite(count) || count < 1) throw new Ask(`How many ${kind === "rows" ? "rows" : "columns"}?`);
  const noun = kind === "rows" ? (count === 1 ? "row" : "rows") : count === 1 ? "column" : "columns";
  const w = (where ?? "").toLowerCase();
  let at: number;
  let place: string;
  if (kind === "rows") {
    if (posText && /^(?:the\s+)?(?:top|start|beginning)$/i.test(posText)) {
      at = 0;
      place = "at the top";
    } else if (posText && /^(?:the\s+)?(?:bottom|end)$/i.test(posText)) {
      at = env.sheet.rowCount;
      place = "at the end";
    } else if (posText) {
      const spans = rowSpans(env, posText);
      const below = /below|after|under/.test(w);
      at = below ? spans[spans.length - 1][1] + 1 : spans[0][0];
      place = below ? `below row ${at}` : `above row ${at + 1}`;
    } else {
      env.usedSelection = true;
      at = env.ctx.selection.top;
      place = `above row ${at + 1} (the selection)`;
    }
  } else if (posText && /^(?:the\s+)?(?:end|right)$/i.test(posText)) {
    at = colCount(env.sheet);
    place = "after the last column";
  } else if (posText) {
    const spans = columnSpans(env, posText);
    const right = /after|right/.test(w);
    at = right ? spans[spans.length - 1][1] + 1 : spans[0][0];
    place = right ? `to the right of column ${columnLetter(at - 1)}` : `to the left of column ${columnLetter(at)}`;
  } else {
    env.usedSelection = true;
    at = env.ctx.selection.left;
    place = `to the left of column ${columnLetter(at)} (the selection)`;
  }
  return {
    actions: [act(env, kind === "rows" ? "rows.insert" : "cols.insert", { at, count })],
    explanation: `Insert ${count} empty ${noun} ${place}. Formulas that point below or to the right move with their cells.`,
  };
}

function deleteOut(env: Env, kind: "rows" | "cols", spec: string): Out {
  if (kind === "rows") {
    const spans = rowSpans(env, spec);
    const total = spans.reduce((n, [a, b]) => n + b - a + 1, 0);
    if (total >= env.sheet.rowCount) throw new Ask("That would delete every row; a sheet needs at least one.");
    // bottom first, so earlier deletes don't move later ones
    const actions = [...spans].reverse().map(([a, b]) => act(env, "rows.delete", { at: a, count: b - a + 1 }));
    return { actions, explanation: `Delete ${describeSpans(spans, "row")}. Formulas that pointed at them show #REF!. You can undo this.` };
  }
  const spans = columnSpans(env, spec);
  const actions = [...spans].reverse().map(([a, b]) => act(env, "cols.delete", { at: a, count: b - a + 1 }));
  return { actions, explanation: `Delete ${describeColSpans(env, spans)}. Formulas that pointed at them show #REF!. You can undo this.` };
}

function describeSpans(spans: [number, number][], noun: string): string {
  const parts = spans.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1} to ${b + 1}`));
  const plural = spans.length > 1 || spans[0][0] !== spans[0][1];
  return `${noun}${plural ? "s" : ""} ${parts.join(", ")}`;
}

function describeColSpans(env: Env, spans: [number, number][]): string {
  const parts = spans.map(([a, b]) => (a === b ? columnLabel(env.sheet, a) : `columns ${columnLetter(a)} to ${columnLetter(b)}`));
  return parts.join(", ");
}

function hideOut(env: Env, hidden: boolean, kind: "rows" | "cols", spec: string): Out {
  const verb = hidden ? "Hide" : "Show";
  if (/^(?:all|every|all\s+the|all\s+hidden)(?:\s+(?:rows|columns|cols))?$/i.test(spec.trim()) || spec.trim() === "") {
    if (hidden) throw new Ask(`Hiding every ${kind === "rows" ? "row" : "column"} would leave nothing to see. Which ones?`);
    const n = kind === "rows" ? env.sheet.rowCount : colCount(env.sheet);
    return {
      actions: [act(env, kind === "rows" ? "rows.hide" : "cols.hide", { at: 0, count: Math.max(1, n), hidden: false })],
      explanation: `Show every hidden ${kind === "rows" ? "row" : "column"}.`,
    };
  }
  if (kind === "rows") {
    const spans = rowSpans(env, spec);
    return {
      actions: spans.map(([a, b]) => act(env, "rows.hide", { at: a, count: b - a + 1, hidden })),
      explanation: `${verb} ${describeSpans(spans, "row")}.${hidden ? " The data stays; unhide to see it again." : ""}`,
    };
  }
  const spans = columnSpans(env, spec);
  return {
    actions: spans.map(([a, b]) => act(env, "cols.hide", { at: a, count: b - a + 1, hidden })),
    explanation: `${verb} ${describeColSpans(env, spans)}.${hidden ? " The data stays; unhide to see it again." : ""}`,
  };
}

const AGG: Record<string, string> = {
  sum: "Sum", total: "Sum", totals: "Sum", average: "Average", avg: "Average", mean: "Average", count: "Count", number: "Count",
  min: "Min", minimum: "Min", lowest: "Min", smallest: "Min", max: "Max", maximum: "Max", highest: "Max", largest: "Max", biggest: "Max",
};

const COLOR_RE = `(${COLOR_WORDS})`;

// ------------------------------------------------------ figures, flags --

const FIGURE_FN: Record<string, { fn: Figure["fn"]; word: string }> = {
  sum: { fn: "SUM", word: "Total" }, total: { fn: "SUM", word: "Total" }, "grand total": { fn: "SUM", word: "Total" }, "add up": { fn: "SUM", word: "Total" },
  average: { fn: "AVERAGE", word: "Average" }, avg: { fn: "AVERAGE", word: "Average" }, mean: { fn: "AVERAGE", word: "Average" },
  count: { fn: "COUNTA", word: "Count" }, "number of": { fn: "COUNTA", word: "Count" },
  min: { fn: "MIN", word: "Smallest" }, minimum: { fn: "MIN", word: "Smallest" }, lowest: { fn: "MIN", word: "Smallest" }, smallest: { fn: "MIN", word: "Smallest" },
  max: { fn: "MAX", word: "Largest" }, maximum: { fn: "MAX", word: "Largest" }, highest: { fn: "MAX", word: "Largest" }, largest: { fn: "MAX", word: "Largest" }, biggest: { fn: "MAX", word: "Largest" },
};

function figureOut(env: Env, fnWord: string, colText: string): Out {
  const f = FIGURE_FN[fnWord.toLowerCase().replace(/\s+/g, " ")] ?? FIGURE_FN.sum;
  const col = column(env, colText.replace(/\s+(?:column|values|figures|numbers)$/i, ""));
  const range = columnData(env.sheet, col);
  const label = `${f.word} of ${columnLabel(env.sheet, col)}`;
  const figure: Figure = { fn: f.fn, col, range, label, formula: `=${f.fn}(${rangeRef(range)})` };
  if (env.sheetParam) figure.sheet = env.sheetParam;
  return { figure, explanation: `Work out the ${f.word.toLowerCase()} of ${columnLabel(env.sheet, col)} on ${env.sheet.name}. Nothing on the sheet changes unless you insert it.` };
}

const AMOUNT_HEADS = [/^(?:amount|amt|value|net amount)$/i, /amount|\bamt\b/i, /debit|\bnet\b|gross|value|total|balance/i];
const DATE_HEADS = [/^(?:date|posting date|entry date|transaction date|txn date|value date)$/i, /date/i, /posted|period/i];

/** The column whose header looks like a role (the amounts, the dates), or -1. */
function roleColumn(env: Env, heads: readonly RegExp[]): number {
  for (const re of heads) {
    const i = env.sheet.columns.findIndex((c) => !!c && re.test(c.trim()));
    if (i >= 0) return i;
  }
  return -1;
}

const OVER = /\b(over|above|more than|greater than|bigger than|larger than|exceeding|at least)\s+([-(]?[$€£¥]?[\d.,]+\s*(?:k|m|mn|bn)?\)?)(?=\s|$)/i;

/** The amount threshold in "… over 10,000", or none; asks when the number can't be read. */
function threshold(rest: string): { value?: number; atLeast: boolean } {
  const m = OVER.exec(rest);
  if (!m) {
    if (/\b(?:over|above|more than|greater than|exceeding|at least)\b/i.test(rest)) throw new Ask('What number should they be over? For example "over 10,000".');
    return { atLeast: false };
  }
  const value = parseNumber(m[2].replace(/\s+/g, ""));
  if (!Number.isFinite(value)) throw new Ask('What number should they be over? For example "over 10,000".');
  return { value, atLeast: /at least/i.test(m[1]) };
}

/** Highlight whole data rows where a formula (written for the first data row) holds. */
function flagRows(env: Env, formula: string, what: string, colorWord: string | undefined): Out {
  const n = colCount(env.sheet);
  const range = columnData(env.sheet, 0, Math.max(0, n - 1));
  const c = COLORS[(colorWord ?? "red").toLowerCase()] ?? COLORS.red;
  const name = colorWord ? colorWord.toLowerCase() : "light red";
  return {
    actions: [act(env, "format.conditionalAdd", { rule: { kind: "formula", formula, ranges: [range], format: { fill: c.fill, color: c.ink } } })],
    explanation: `Highlight the rows of ${env.sheet.name} ${what} in ${name}. It's a conditional format, so it follows the values as they change; nothing is deleted.`,
  };
}

function amountColumn(env: Env): number {
  const a = roleColumn(env, AMOUNT_HEADS);
  if (a < 0) throw new Ask(`Which column holds the amounts? ${env.sheet.name} has no Amount column.`);
  return a;
}

function weekendOut(env: Env, rest: string, colorWord: string | undefined): Out {
  const d = roleColumn(env, DATE_HEADS);
  if (d < 0) throw new Ask(`Which column holds the dates? ${env.sheet.name} has no Date column.`);
  const t = threshold(rest);
  const row = firstDataRow(env.sheet) + 1;
  const ref = (c: number) => `$${columnLetter(c)}${row}`;
  const weekend = `WEEKDAY(${ref(d)},2)>5`;
  const dated = `dated on a Saturday or Sunday (${columnLabel(env.sheet, d)})`;
  if (t.value === undefined) return flagRows(env, `=AND(ISNUMBER(${ref(d)}),${weekend})`, dated, colorWord);
  const a = amountColumn(env);
  const op = t.atLeast ? ">=" : ">";
  return flagRows(
    env,
    `=AND(ISNUMBER(${ref(d)}),${weekend},ABS(${ref(a)})${op}${t.value})`,
    `${dated} with ${columnLabel(env.sheet, a)} ${t.atLeast ? "of at least" : "over"} ${fmtNum(t.value)}, debit or credit,`,
    colorWord,
  );
}

function roundOut(env: Env, rest: string, colorWord: string | undefined): Out {
  const a = amountColumn(env);
  const t = threshold(rest);
  const ref = `$${columnLetter(a)}${firstDataRow(env.sheet) + 1}`;
  const over = t.value === undefined ? "" : `,ABS(${ref})${t.atLeast ? ">=" : ">"}${t.value}`;
  return flagRows(
    env,
    `=AND(ISNUMBER(${ref}),${ref}<>0,MOD(ABS(${ref}),1000)=0${over})`,
    `where ${columnLabel(env.sheet, a)} is a round amount (a multiple of 1,000)${t.value === undefined ? "" : ` ${t.atLeast ? "of at least" : "over"} ${fmtNum(t.value)}`}`,
    colorWord,
  );
}

const FLAG_VERB = "(?:flag|highlight|mark|find|show|spot|colou?r|shade|list|pick out)\\s+(?:me\\s+)?(?:the\\s+|all\\s+|any\\s+)?";

const TYPE_ROWS = "(rows?|columns?|cols?)";
const kindOf = (w: string): "rows" | "cols" => (/^row/i.test(w) ? "rows" : "cols");
const COUNT = "(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|fifty|hundred)";

const RULES: Rule[] = [
  // --------------------------------------------------------- undo / redo
  { re: /^(?:undo|undo (?:that|it|the last (?:change|step|action)|last (?:change|step))|take (?:that|it) back|go back(?: one step)?|revert (?:that|the last change))$/i, run: () => ({ command: "undo", explanation: "Undo the last change." }) },
  { re: /^(?:redo|redo (?:that|it|the last (?:change|step))|do (?:that|it) again)$/i, run: () => ({ command: "redo", explanation: "Redo the change you just undid." }) },

  // ------------------------------------------------------------- filters
  {
    re: /^(?:clear|remove|reset|turn off|delete|drop|undo)\s+(?:all\s+)?(?:the\s+)?(?:filters?|filtering)(?:\s+(?:on|from|in|for)\s+(.+))?$|^unfilter(?:\s+(.+))?$|^(?:show all rows|show all|show everything|show all data)$/i,
    run: (m, env) => {
      const colText = m[1] ?? m[2];
      if (colText) {
        const col = column(env, colText.replace(/^(?:column\s+)?/i, ""));
        return { actions: [act(env, "filter.set", { col, condition: null })], explanation: `Remove the filter on ${columnLabel(env.sheet, col)}. Filters on other columns stay.` };
      }
      return { actions: [act(env, "filter.clear", {})], explanation: "Remove the filter and show every row again." };
    },
  },
  {
    re: /^(?:show|filter|keep|find|list|display)\s+(?:me\s+)?(?:only\s+)?(?:the\s+)?(?:rows\s+with\s+)?(?:blanks?|blank\s+(?:rows|cells|values)|empty(?:\s+(?:rows|cells|values))?|missing(?:\s+values)?)\s+(?:in|for|of|under)\s+(.+)$/i,
    run: (m, env) => filterRule(env, m[1], "is", "blank"),
  },
  {
    re: /^(?:hide|remove|filter out|exclude|skip|drop)\s+(?:the\s+)?(?:blanks?|blank\s+(?:rows|cells|values)|empty(?:\s+(?:rows|cells|values))?)\s+(?:in|for|of|under)\s+(.+)$|^(?:show|keep)\s+(?:only\s+)?(?:the\s+)?(?:non-?blanks?|non-?empty|not blank)(?:\s+(?:rows|cells|values))?\s+(?:in|for|of)\s+(.+)$/i,
    run: (m, env) => filterRule(env, m[1] ?? m[2], "is not", "blank"),
  },
  {
    re: new RegExp(
      `^(?:filter(?:\\s+(?:the\\s+)?(?:rows|data|table|sheet|list))?(?:\\s+(?:by|on|where|to|for|so))?|(?:show|keep|display|list|find|get)\\s+(?:me\\s+)?(?:only\\s+)?(?:the\\s+)?(?:rows|records|lines|entries|items|ones)?\\s*(?:where|with|whose|that have|having)|only\\s+show(?:\\s+(?:rows|records))?(?:\\s+(?:where|with|whose))?|where)\\s+(.+?)\\s+(${OPS})\\s+(.+)$`,
      "i",
    ),
    run: (m, env) => filterRule(env, m[1], m[2], m[3]),
  },
  {
    re: /^filter\s+(?:by\s+|on\s+)?(.+)$/i,
    run: (m, env) => {
      const col = column(env, m[1]);
      throw new Ask(`Which rows of ${columnLabel(env.sheet, col)} should stay? For example "filter ${env.sheet.columns[col] || columnLetter(col)} is North" or "... over 1000".`);
    },
  },

  // ---------------------------------------------------------------- sort
  {
    re: /^sort(?:\s+(?:the\s+)?(?:rows|data|table|sheet|list))?\s+(asc|ascending|desc|descending|a\s*to\s*z|z\s*to\s*a|largest first|smallest first|newest first|oldest first|alphabetically)(?:\s+order)?\s+(?:by|on)\s+(.+)$/i,
    run: (m, env) => sortOut(env, sortKeys(env, m[2], /^(?:desc|descending|z|largest|newest)/i.test(m[1]))),
  },
  {
    re: /^(?:sort|order|arrange|rank)(?:\s+(?:the\s+)?(?:rows|data|table|sheet|list))?\s+(?:by|on|using)\s+(.+)$/i,
    run: (m, env) => sortOut(env, sortKeys(env, m[1], undefined)),
  },
  {
    re: /^sort(?:\s+(?:the\s+)?(?:rows|data|table|sheet|list))?(?:\s+by)?(?:\s+(asc|ascending|desc|descending|a\s*to\s*z|z\s*to\s*a))?$/i,
    run: () => {
      throw new Ask(`Sort by which column? For example "sort by amount descending".`);
    },
  },
  {
    re: /^sort\s+(.+?)\s+(asc|ascending|desc|descending|a\s*to\s*z|z\s*to\s*a|largest first|smallest first|newest first|oldest first|high to low|low to high|alphabetically)(?:\s+order)?$/i,
    run: (m, env) => sortOut(env, sortKeys(env, m[1], /^(?:desc|descending|z|largest|newest|high)/i.test(m[2]))),
  },

  // -------------------------------------------------------------- pivot
  {
    re: /^(?:show\s+(?:me\s+)?|what(?:'s| is| are)\s+(?:the\s+)?|get\s+(?:the\s+)?|calculate\s+(?:the\s+)?|give me\s+(?:the\s+)?)?(sum|total|totals|average|avg|mean|count|number|min|minimum|max|maximum|lowest|highest|smallest|largest|biggest)(?:\s+of)?\s+(?:the\s+)?(.+?)\s+(?:by|per|for each|for every|grouped by|broken down by|split by|across)\s+(.+)$/i,
    run: (m, env) => {
      const agg = AGG[m[1].toLowerCase()];
      const by = column(env, m[3]);
      const isRows = /^(?:rows|records|entries|lines|items|transactions)$/i.test(m[2].trim());
      const val = agg === "Count" && isRows ? by : column(env, m[2]);
      const what = agg === "Count" && isRows ? "the number of rows" : `${agg} of ${columnLabel(env.sheet, val)}`;
      return {
        command: "pivot",
        explanation: `That's a pivot table: open the pivot tool, put ${columnLabel(env.sheet, by)} in Rows and ${what} in Values.`,
        confidence: 0.7,
      };
    },
  },
  {
    re: /^(?:count|how many)(?:\s+(?:rows|records|entries|items|transactions))?\s+(?:are there\s+)?(?:by|per|for each|in each)\s+(.+)$/i,
    run: (m, env) => {
      const by = column(env, m[1]);
      return { command: "pivot", explanation: `That's a pivot table: open the pivot tool, put ${columnLabel(env.sheet, by)} in Rows and Count in Values.`, confidence: 0.7 };
    },
  },

  // ------------------------------------------------- a single figure
  {
    re: /^(?:show\s+(?:me\s+)?|what(?:'s| is| are)\s+(?:the\s+)?|get\s+(?:me\s+)?(?:the\s+)?|calculate\s+(?:the\s+)?|work out\s+(?:the\s+)?|give me\s+(?:the\s+)?|find\s+(?:the\s+)?|how much is\s+(?:the\s+)?)?(sum|total|grand total|average|avg|mean|count|number of|min|minimum|max|maximum|lowest|highest|smallest|largest|biggest|add up)(?:\s+(?:of|for|in|on))?\s+(?:the\s+|all\s+(?:the\s+)?)?(.+?)$/i,
    run: (m, env) => figureOut(env, m[1], m[2]),
  },
  {
    re: /^(?:what(?:'s| is)\s+)?(?:the\s+)?(?:total|sum|grand total|average)$/i,
    run: () => {
      throw new Ask('Of which column? For example "total of amount".');
    },
  },

  // ------------------------------------------------------- number formats
  {
    re: new RegExp(`^(?:format|show|display|set|make|change|turn|convert)\\s+(.+?)\\s+(?:as|to|in|into|a|an)\\s+(?:an?\\s+)?(?:the\\s+)?(${FORMAT_WORDS})(?:\\s+format)?$`, "i"),
    run: (m, env) => {
      const word = m[2].toLowerCase();
      const entry = NUMBER_FORMATS.find(([re]) => re.test(word))!;
      const t = target(env, m[1], false);
      return styleOut(env, t, { numFmt: entry[1] }, `Show the numbers as ${entry[2]} in`);
    },
  },

  // ------------------------------------------- journal flags (JE tests)
  {
    re: new RegExp(`^${FLAG_VERB}(.*\\bweekends?\\b.*?)(?:\\s+in\\s+${COLOR_RE})?$`, "i"),
    run: (m, env) => weekendOut(env, m[1], m[2]),
  },
  {
    re: new RegExp(`^${FLAG_VERB}(?:round(?:[- ]number)?|round-sum)\\s+(?:amounts?|numbers?|figures?|values?|postings?|entries|journals?|transactions|payments)(.*?)(?:\\s+in\\s+${COLOR_RE})?$`, "i"),
    run: (m, env) => roundOut(env, m[1], m[2]),
  },

  // ---------------------------------------------------- duplicates, CF
  {
    re: new RegExp(
      `^(?:find|highlight|show|mark|flag|spot|check(?:\\s+for)?|look\\s+for|colou?r)\\s+(?:me\\s+)?(?:the\\s+|any\\s+|all\\s+)?(?:duplicates?|duplicated\\s+values|duplicate\\s+values|dupes|repeated\\s+values|repeats)\\s+(?:in|on|of|for|among|across)\\s+(?:the\\s+)?(.+?)(?:\\s+(?:column|field))?(?:\\s+in\\s+${COLOR_RE})?$`,
      "i",
    ),
    run: (m, env) => cfOut(env, target(env, m[1], false), { kind: "duplicates" }, "that appear more than once", m[2]),
  },
  {
    re: new RegExp(`^(?:find|highlight|show|mark|flag|spot)\\s+(?:the\\s+|any\\s+|all\\s+)?(?:duplicate|duplicated|repeated)\\s+(.+?)(?:\\s+in\\s+${COLOR_RE})?$`, "i"),
    run: (m, env) => cfOut(env, target(env, m[1], false), { kind: "duplicates" }, "that appear more than once", m[2]),
  },
  {
    re: new RegExp(`^(?:highlight|mark|flag|colou?r|show)\\s+(?:the\\s+|all\\s+)?(?:negative|minus)\\s+(?:values\\s+in\\s+|numbers\\s+in\\s+)?(.+?)(?:\\s+in\\s+${COLOR_RE})?$`, "i"),
    run: (m, env) => cfOut(env, target(env, m[1], false), { kind: "cell", op: "<", a: 0 }, "below zero", m[2]),
  },
  {
    re: new RegExp(`^(?:highlight|mark|flag|colou?r|show)\\s+(?:the\\s+)?(top|bottom)\\s+(\\d+)\\s*(%|percent)?\\s+(?:of\\s+)?(?:the\\s+)?(?:values\\s+in\\s+)?(.+?)(?:\\s+in\\s+${COLOR_RE})?$`, "i"),
    run: (m, env) => {
      const bottom = m[1].toLowerCase() === "bottom";
      const n = Number(m[2]);
      const percent = !!m[3];
      return cfOut(env, target(env, m[4], false), { kind: "top", n, percent, bottom }, `in the ${m[1].toLowerCase()} ${n}${percent ? "%" : ""}`, m[5]);
    },
  },
  {
    re: new RegExp(
      `^(?:highlight|mark|flag|colou?r|shade)\\s+(?:the\\s+|all\\s+|any\\s+)?(?:cells\\s+in\\s+|values\\s+in\\s+|rows\\s+where\\s+|where\\s+)?(.+?)\\s+(?:that\\s+are\\s+|which\\s+are\\s+|that\\s+|which\\s+)?(${OPS})\\s+(.+?)(?:\\s+(?:(?:in|as|with)\\s+)?${COLOR_RE})?$`,
      "i",
    ),
    run: (m, env) => {
      const op = opOf(m[2]);
      const t = target(env, m[1], false);
      const value = unquote(m[3]);
      if (op === "contains" || op === "notContains" || op === "begins" || op === "ends") {
        return cfOut(env, t, { kind: "text", op, value }, `that ${OP_TEXT[op].replace(/^is /, "are ")} "${value}"`, m[4]);
      }
      if (op === "between" || op === "notBetween") {
        const pair = twoValues(value);
        const a = pair ? parseNumber(pair[0]) : NaN;
        const b = pair ? parseNumber(pair[1]) : NaN;
        if (Number.isNaN(a) || Number.isNaN(b)) throw new Ask(`Between which two numbers? Say something like "between 100 and 500".`);
        return cfOut(env, t, { kind: "cell", op, a: Math.min(a, b), b: Math.max(a, b) }, `${op === "between" ? "between" : "outside"} ${fmtNum(Math.min(a, b))} and ${fmtNum(Math.max(a, b))}`, m[4]);
      }
      const n = parseNumber(value);
      if (Number.isNaN(n)) {
        if (op === "=" || op === "!=") return cfOut(env, t, { kind: "cell", op, a: value }, `${op === "=" ? "equal to" : "not equal to"} "${value}"`, m[4]);
        throw new Ask(`What number should ${t.label} be compared with? I read "${value}".`);
      }
      const words: Record<string, string> = { ">": "over", ">=": "at least", "<": "under", "<=": "at most", "=": "equal to", "!=": "not equal to" };
      return cfOut(env, t, { kind: "cell", op, a: n }, `${words[op] ?? op} ${fmtNum(n)}`, m[4]);
    },
  },

  // --------------------------------------------------------- text styles
  {
    re: /^(?:make|set|turn|format)\s+(.+?)\s+(not bold|unbold|non-bold|bold|italics?|italicized|underlined?|not underlined|strikethrough|struck through|crossed out|wrapped|wrap|centered|centred|center|centre|left aligned|right aligned|plain|normal)$/i,
    run: (m, env) => {
      const w = m[2].toLowerCase();
      const t = target(env, m[1], true);
      if (/^(?:not bold|unbold|non-bold)$/.test(w)) return styleOut(env, t, { bold: false }, "Turn off bold in");
      if (w === "bold") return styleOut(env, t, { bold: true }, "Make bold:");
      if (w.startsWith("italic")) return styleOut(env, t, { italic: true }, "Make italic:");
      if (w === "not underlined") return styleOut(env, t, { underline: false }, "Remove the underline from");
      if (w.startsWith("underline")) return styleOut(env, t, { underline: true }, "Underline");
      if (/strike|struck|crossed/.test(w)) return styleOut(env, t, { strike: true }, "Strike through");
      if (w.startsWith("wrap")) return styleOut(env, t, { wrap: true }, "Wrap text in");
      if (/^cent/.test(w)) return styleOut(env, t, { align: "center" }, "Centre the text in");
      if (w === "left aligned") return styleOut(env, t, { align: "left" }, "Align left:");
      if (w === "right aligned") return styleOut(env, t, { align: "right" }, "Align right:");
      return styleOut(env, t, { bold: false, italic: false, underline: false, strike: false }, "Remove bold, italic, underline and strikethrough from");
    },
  },
  {
    re: /^(bold|unbold|italicize|italicise|italic|underline|strike through|strikethrough|wrap(?: text in)?|center|centre|clear (?:the )?(?:formatting|formats?) (?:in|on|from|of))\s+(.+)$/i,
    run: (m, env) => {
      const w = m[1].toLowerCase();
      const t = target(env, m[2], true);
      if (w.startsWith("clear")) return { actions: [act(env, "format.clear", { range: t.range })], explanation: `Remove all formatting from ${t.label}. The values stay.` };
      if (w === "bold") return styleOut(env, t, { bold: true }, "Make bold:");
      if (w === "unbold") return styleOut(env, t, { bold: false }, "Turn off bold in");
      if (w.startsWith("ital")) return styleOut(env, t, { italic: true }, "Make italic:");
      if (w === "underline") return styleOut(env, t, { underline: true }, "Underline");
      if (w.startsWith("wrap")) return styleOut(env, t, { wrap: true }, "Wrap text in");
      if (/^cent/.test(w)) return styleOut(env, t, { align: "center" }, "Centre the text in");
      return styleOut(env, t, { strike: true }, "Strike through");
    },
  },
  {
    re: /^align\s+(.+?)\s+(?:to\s+the\s+)?(left|right|center|centre)$/i,
    run: (m, env) => {
      const t = target(env, m[1], true);
      const align = m[2].toLowerCase().startsWith("cent") ? "center" : m[2].toLowerCase();
      return styleOut(env, t, { align }, `Align ${align}:`);
    },
  },
  {
    re: new RegExp(`^(?:fill|shade|highlight|colou?r\\s+(?:the\\s+)?(?:background|fill)\\s+of)\\s+(.+?)\\s+(?:in\\s+|with\\s+)?${COLOR_RE}$`, "i"),
    run: (m, env) => {
      const t = target(env, m[1], true);
      const c = COLORS[m[2].toLowerCase()];
      return styleOut(env, t, { fill: c.fill }, `Fill with ${m[2].toLowerCase()}:`);
    },
  },
  {
    re: new RegExp(`^(?:make|colou?r|turn|set)\\s+(?:the\\s+)?(?:text\\s+(?:in|of)\\s+|font\\s+(?:in|of)\\s+)?(.+?)\\s+(?:text\\s+|font\\s+)?(?:to\\s+)?${COLOR_RE}(?:\\s+text)?$`, "i"),
    run: (m, env) => {
      const t = target(env, m[1], true);
      return styleOut(env, t, { color: COLORS[m[2].toLowerCase()].text }, `Colour the text ${m[2].toLowerCase()} in`);
    },
  },
  {
    re: /^(?:clear|remove|reset)\s+(?:all\s+)?(?:the\s+)?(?:formatting|formats?|styles?)(?:\s+(?:in|on|from|of)\s+(.+))?$/i,
    run: (m, env) => {
      const t = m[1] ? target(env, m[1], true) : target(env, "the selection", true);
      return { actions: [act(env, "format.clear", { range: t.range })], explanation: `Remove all formatting from ${t.label}. The values stay.` };
    },
  },

  // -------------------------------------------------------------- freeze
  {
    re: /^(?:unfreeze|un-freeze|thaw)(?:\s+(?:all|everything|the\s+panes|panes|rows|columns))?$|^(?:remove|clear|turn off)\s+(?:the\s+)?(?:freeze|frozen panes|freeze panes)$/i,
    run: (_m, env) => ({ actions: [act(env, "view.freeze", { rows: 0, cols: 0 })], explanation: "Unfreeze: nothing stays fixed while scrolling." }),
  },
  {
    re: /^(?:freeze|lock|pin)\s+(?:the\s+)?(?:top|first|header|heading)\s+row(?:\s+and\s+(?:the\s+)?first\s+column)?$|^(?:freeze|lock|pin)\s+(?:the\s+)?(?:headers?|headings?)$/i,
    run: (m, env) => {
      const both = /column/i.test(m[0]);
      return {
        actions: [act(env, "view.freeze", { rows: 1, cols: both ? 1 : 0 })],
        explanation: both ? "Keep the top row and the first column on screen while you scroll." : "Keep the top row on screen while you scroll down.",
      };
    },
  },
  {
    re: new RegExp(`^(?:freeze|lock|pin)\\s+(?:the\\s+)?(?:top|first)\\s+${COUNT}\\s+(rows?|columns?|cols?)$`, "i"),
    run: (m, env) => {
      const n = parseCount(m[1]);
      if (!Number.isFinite(n) || n < 1) throw new Ask("How many?");
      const rows = kindOf(m[2]) === "rows";
      return {
        actions: [act(env, "view.freeze", rows ? { rows: n, cols: 0 } : { rows: 0, cols: n })],
        explanation: `Keep the first ${n} ${rows ? (n === 1 ? "row" : "rows") : n === 1 ? "column" : "columns"} on screen while you scroll.`,
      };
    },
  },
  {
    re: /^(?:freeze|lock|pin)\s+(?:the\s+)?(?:first|left(?:most)?)\s+column$/i,
    run: (_m, env) => ({ actions: [act(env, "view.freeze", { rows: 0, cols: 1 })], explanation: "Keep the first column on screen while you scroll right." }),
  },
  {
    re: /^freeze(?:\s+panes)?(?:\s+(?:at|above and left of|from)\s+(.+))?$/i,
    run: (m, env) => {
      let row: number;
      let col: number;
      if (m[1]) {
        const a1 = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(m[1].trim());
        if (!a1) throw new Ask(`Freeze at which cell? For example "freeze panes at B2".`);
        col = columnIndex(a1[1]);
        row = Number(a1[2]) - 1;
      } else {
        env.usedSelection = true;
        row = env.ctx.selection.top;
        col = env.ctx.selection.left;
        if (row === 0 && col === 0) throw new Ask(`What should stay on screen? Say "freeze top row", "freeze first column", or select the cell below and right of what to keep and say "freeze panes".`);
      }
      return {
        actions: [act(env, "view.freeze", { rows: row, cols: col })],
        explanation: `Keep the ${row} row${row === 1 ? "" : "s"} above and the ${col} column${col === 1 ? "" : "s"} left of ${columnLetter(col)}${row + 1} on screen while you scroll.`,
      };
    },
  },

  // --------------------------------------------------------- hide / show
  {
    re: new RegExp(`^(hide|unhide|show)\\s+(?:all\\s+)?(?:the\\s+)?(?:hidden\\s+)?${TYPE_ROWS}(?:\\s+(.+))?$`, "i"),
    run: (m, env) => {
      const hidden = m[1].toLowerCase() === "hide";
      const spec = m[3] ?? (/\ball\b|\bhidden\b/i.test(m[0]) ? "all" : "");
      if (!spec) {
        if (hidden) return hideOut(env, true, kindOf(m[2]), "the selection");
        return hideOut(env, false, kindOf(m[2]), "all");
      }
      return hideOut(env, hidden, kindOf(m[2]), spec);
    },
  },
  {
    re: /^(hide|unhide)\s+(.+?)(?:\s+(rows?|columns?|cols?))?$/i,
    run: (m, env) => hideOut(env, m[1].toLowerCase() === "hide", m[3] ? kindOf(m[3]) : /^(?:the\s+)?(?:selected\s+)?rows?\b|^\d/i.test(m[2]) ? "rows" : "cols", m[2]),
  },

  // ------------------------------------------------------ insert / delete
  {
    re: new RegExp(
      `^(?:insert|add|put\\s+in|create)\\s+(?:${COUNT}\\s+)?(?:new\\s+|blank\\s+|empty\\s+|more\\s+)*${TYPE_ROWS}(?:\\s+(above|below|before|after|under|at|to\\s+the\\s+left\\s+of|to\\s+the\\s+right\\s+of|left\\s+of|right\\s+of|in)\\s+(?:row\\s+|column\\s+)?(.+))?$`,
      "i",
    ),
    run: (m, env) => insertOut(env, kindOf(m[2]), m[1], m[3], m[4]),
  },
  {
    re: new RegExp(`^(?:delete|remove)\\s+(?:the\\s+)?(?:selected\\s+)?${TYPE_ROWS}(?:\\s+(.+))?$`, "i"),
    run: (m, env) => {
      const spec = m[2] ?? (/selected/i.test(m[0]) ? "the selection" : "");
      if (!spec) throw new Ask(`Which ${kindOf(m[1]) === "rows" ? "rows" : "columns"}? For example "delete rows 5 to 8".`);
      return deleteOut(env, kindOf(m[1]), spec);
    },
  },
  {
    re: /^(?:delete|remove)\s+(?:the\s+)?(.+?)\s+(rows?|columns?|cols?)$/i,
    run: (m, env) => deleteOut(env, kindOf(m[2]), m[1]),
  },

  // -------------------------------------------------------------- sheets
  {
    re: /^(?:rename|call|name)\s+(?:the\s+)?(?:this\s+|current\s+|active\s+)?(?:sheet|tab|worksheet)(?:\s+(.+?))?\s+(?:to|as)\s+(.+)$|^(?:rename|call|name)\s+(?:the\s+)?(?:this|current|active)\s+(?:sheet|tab|worksheet)\s+(.+)$/i,
    run: (m, env) => {
      const fromText = m[1];
      const name = unquote(m[2] ?? m[3] ?? "");
      let sheet = env.sheet;
      if (fromText) {
        const want = unquote(fromText).toLowerCase();
        const found = env.ctx.sheets.find((s) => s.name.toLowerCase() === want);
        if (!found) throw new Ask(`There's no sheet called "${unquote(fromText)}". Sheets: ${env.ctx.sheets.map((s) => s.name).join(", ")}.`);
        sheet = found;
      }
      if (!name) throw new Ask("What should the new name be?");
      if (name.length > 31) throw new Ask("Sheet names can be at most 31 characters.");
      if (/[[\]:*?/\\]/.test(name)) throw new Ask("Sheet names can't contain [ ] : * ? / or \\.");
      if (env.ctx.sheets.some((s) => s !== sheet && s.name.toLowerCase() === name.toLowerCase())) throw new Ask(`There's already a sheet called "${name}".`);
      return { actions: [{ type: "sheet.rename", params: { sheet: sheet.id, name } }], explanation: `Rename the sheet "${sheet.name}" to "${name}". Formulas that refer to it are updated.` };
    },
  },

  {
    re: /^(?:rename|call|name)\s+(?:the\s+)?(?:this\s+|current\s+|active\s+)?(?:sheet|tab|worksheet)(?:\s+(?:to|as))?$/i,
    run: () => {
      throw new Ask(`What should the new name be? For example "rename sheet to Bank".`);
    },
  },

  // ----------------------------------------------------------- dropdown
  {
    re: /^(?:add|create|make|put|insert|set\s+up)\s+(?:a\s+|an\s+)?(?:drop-?\s?down|pick\s?list|choice\s+list|selection\s+list|list\s+validation|validation\s+list|list)(?:\s+(?:list|menu|box))?\s+(?:in|to|on|for|into|at)\s+(.+?)(?:\s+(?:with|of|containing|offering|showing|listing)(?:\s+(?:the\s+)?(?:options|choices|values|items))?\s*:?\s+(.+))?$/i,
    run: (m, env) => {
      const t = target(env, m[1], false);
      const items = m[2] ? splitList(m[2]) : [];
      if (!items.length) throw new Ask(`Which choices should the dropdown in ${t.label} offer? For example "with Open, Closed".`);
      return {
        actions: [act(env, "validation.add", { rule: { kind: "list", ranges: [t.range], list: items, allowBlank: true } })],
        explanation: `Add a dropdown to ${t.label} with the choices ${items.map((x) => `"${x}"`).join(", ")}. Other entries are refused. It replaces any older rule on those cells.`,
      };
    },
  },

  // ----------------------------------------------------------- fill down
  {
    re: /^(?:fill|copy)\s+(?:it\s+|this\s+|that\s+|them\s+|the\s+selection\s+|(.+?)\s+)?down(?:\s+(?:to\s+row\s+(\d+)|(?:in|over|for|through|across)\s+(.+)))?$/i,
    run: (m, env) => {
      const sel = env.ctx.selection;
      let range: CellRange;
      if (m[2]) {
        env.usedSelection = true;
        const bottom = Number(m[2]) - 1;
        if (bottom <= sel.top) throw new Ask(`Row ${m[2]} is not below the selection.`);
        if (bottom >= env.sheet.rowCount) throw new Ask(`Row ${m[2]} is past the end of ${env.sheet.name}.`);
        range = { top: sel.top, left: sel.left, bottom, right: sel.right };
      } else if (m[1] || m[3]) {
        range = target(env, (m[1] ?? m[3])!, false).range;
      } else {
        env.usedSelection = true;
        range = { ...sel };
      }
      if (range.bottom <= range.top) {
        throw new Ask(`Select the cells to fill first: the top row is copied into the rows below it. Or say "fill down to row 100".`);
      }
      return {
        actions: [act(env, "fill.down", { range })],
        explanation: `Copy row ${range.top + 1} of ${rangeRef(range)} into the ${range.bottom - range.top} row${range.bottom - range.top === 1 ? "" : "s"} below it. Formulas adjust as they go, like Ctrl+D.`,
      };
    },
  },
];

// ------------------------------------------------------------- entry --

/** Strip politeness and punctuation: "Please sort by amount." → "sort by amount" */
export function normalizeRequest(text: string): string {
  let t = text.trim().replace(/[\s.!?;]+$/, "").replace(/\s+/g, " ");
  for (let i = 0; i < 3; i++) {
    t = t
      .replace(/^(?:please|pls|plz|kindly|ok|okay|now|then|and|also|just|hey)\s*,?\s+/i, "")
      .replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, "")
      .replace(/^(?:i\s+(?:want|need|would like)\s+(?:you\s+)?to|i'd\s+like\s+(?:you\s+)?to|let's|lets|help\s+me|go\s+ahead\s+and)\s+/i, "")
      .replace(/\s*,?\s+(?:please|for me|thanks|thank you)$/i, "");
  }
  return t.trim();
}

/** A trailing "on sheet Bank" / "in the Bank sheet": the sheet it names, and the rest. */
function splitSheet(ctx: AskContext, text: string): { text: string; sheet?: SheetInfo; unknown?: string } {
  const m =
    /^(.*\S)\s+(?:on|in)\s+(?:the\s+)?(?:sheet|tab|worksheet)\s+["'“]?(.+?)["'”]?$/i.exec(text) ??
    /^(.*\S)\s+(?:on|in)\s+(?:the\s+)?["'“]?(.+?)["'”]?\s+(?:sheet|tab|worksheet)$/i.exec(text);
  if (!m || /^(?:rename|call|name)\b/i.test(text)) return { text };
  const want = m[2].toLowerCase();
  if (/^(?:this|current|active)$/.test(want)) return { text: m[1] };
  const sheet = ctx.sheets.find((s) => s.name.toLowerCase() === want);
  return sheet ? { text: m[1], sheet } : { text: m[1], unknown: m[2] };
}

/**
 * Turn a request into actions, or null when no pattern fits. A result with
 * `missing` questions has no actions: ask, then try again.
 */
export function parse(request: string, ctx: AskContext): ParseResult | null {
  const cleaned = normalizeRequest(request);
  if (!cleaned || !ctx.sheets.length) return null;
  const split = splitSheet(ctx, cleaned);
  const sheet = split.sheet ?? activeSheet(ctx);
  const env: Env = { ctx, sheet, sheetParam: split.sheet && split.sheet.id !== ctx.activeSheet ? split.sheet.id : undefined, fuzzy: false, usedSelection: false };
  for (const rule of RULES) {
    const m = rule.re.exec(split.text);
    if (!m) continue;
    if (split.unknown) {
      return { confidence: 0.3, explanation: "", missing: [`There's no sheet called "${split.unknown}". Sheets: ${ctx.sheets.map((s) => s.name).join(", ")}.`] };
    }
    try {
      const out = rule.run(m, env);
      if (env.usedSelection && env.sheetParam) {
        return { confidence: 0.3, explanation: "", missing: [`The selection is on ${activeSheet(ctx).name}, not ${env.sheet.name}. Name the cells instead, like "B2:B20".`] };
      }
      let confidence = out.confidence ?? 0.95;
      if (env.fuzzy) confidence -= 0.15;
      if (env.usedSelection) confidence -= 0.15;
      const result: ParseResult = { confidence: Math.round(confidence * 100) / 100, explanation: out.explanation, missing: [] };
      if (out.command) result.command = out.command;
      if (out.figure) result.figure = out.figure;
      const actions = out.actions ?? [];
      if (actions.length === 1) result.action = actions[0];
      else if (actions.length > 1) result.actions = actions;
      return result;
    } catch (e) {
      if (e instanceof Ask) return { confidence: 0.4, explanation: "", missing: [e.question] };
      throw e;
    }
  }
  return null;
}

/** Example requests, for help text ("here's what you can type"). */
export const EXAMPLES: readonly string[] = [
  "sort by amount descending",
  "sort by region then date",
  "filter region is North",
  "filter amount > 1000",
  "show blanks in category",
  "clear filter",
  "sum of amount by region",
  "total of amount",
  "flag weekend postings over 10,000",
  "make column B bold",
  "format C as currency",
  "freeze top row",
  "hide column D",
  "insert 3 rows above row 10",
  "delete rows 5 to 8",
  "rename sheet to Bank",
  "find duplicates in invoice number",
  "highlight amounts over 10000 in red",
  "add a dropdown in E2:E100 with Open, Closed",
  "fill down",
  "undo",
];
