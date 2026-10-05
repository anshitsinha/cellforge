/**
 * Journal entry testing, red-flag overlaps, footing / roll-forward checks
 * and the personal data scan with a safe copy, as dialogs. Like the other
 * audit tools they read the sheet, show a live summary, and add result
 * sheets; the original sheet is never changed. Result rows keep the
 * original sheet row number so every item can be traced back.
 */
import type { Action } from "@cellforge/actions";
import { formatValue, parseDateLoose, Table, type ColumnData, type DateOrder } from "@cellforge/core";
import { columnLetter, type CellRange } from "@cellforge/grid";
import {
  DEFAULT_JE_KEYWORDS,
  footRange,
  guessFootLayout,
  JE_TEST_LABEL,
  JE_TESTS,
  JE_WEIGHTS,
  jeLines,
  newSalt,
  OVERLAP_FIELDS,
  OVERLAP_LABEL,
  PII_LABEL,
  PROTECT_LABEL,
  protectColumns,
  Pseudonymiser,
  pseudonymPrefix,
  redFlagOverlaps,
  rollForward,
  runJeTests,
  saltedHasher,
  scanPii,
  type FootResult,
  type Hasher,
  type JeLine,
  type JeOptions,
  type JeResult,
  type JeTestId,
  type OverlapField,
  type OverlapResult,
  type Party,
  type PiiColumnScan,
  type ProtectMethod,
  type RollResult,
} from "@cellforge/core";
import { readSheet, stringGrid, type SheetData } from "./audittools";
import { EditableSource } from "./editable";
import type { Workbook } from "./workbook";
import "./jetools.css";
import { button, el, emptyState, field as tkField, headline, navigator, notice, report, section as tkSection, type HeadlineOptions } from "./toolkit";
import { openSidePanel } from "./ui/sidepanel";
import { renderTable, type TableColumn } from "./ui/table";

type Cell = number | string | null;

export type JeToolKind = "journal" | "overlaps" | "footing" | "rollforward" | "pii";

export interface JeToolDeps {
  workbook: () => Workbook;
  source: () => EditableSource;
  /** id of the sheet on screen */
  activeSheet: () => string;
  /** the selected range */
  range: () => CellRange;
  sheetName: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
  /** show a sheet row (makes result rows links); optional */
  goTo?: (sheetId: string, row: number, col: number) => void;
}

const MONEY = "#,##0.00;(#,##0.00)";
const PCT = "0.0%";
const money = (n: number) => formatValue(n, MONEY).text;
const pct = (n: number) => formatValue(n, PCT).text;
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s") => `${count(n)} ${n === 1 ? one : many}`;
/** Column name without the "A: " the pickers show. */
export const bare = (name: string) => name.replace(/^[A-Z]+: /, "");

// --------------------------------------------------------- result sheets --

/** A result sheet being built: columns, their number formats, and numbers inside text columns. */
export class Out {
  columns: ColumnData[] = [];
  numFmts: string[] = [];
  /** [row, col, value]: numbers that sit in a column that is mostly text, set after the sheet is made. */
  fixes: [number, number, number][] = [];

  text(name: string, values: readonly string[]): this {
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
    this.columns.push({ kind: "string", name, codes, dict });
    this.numFmts.push("");
    return this;
  }

  num(name: string, values: ArrayLike<number | null>, fmt = ""): this {
    this.columns.push({ kind: "number", name, values: Float64Array.from({ length: values.length }, (_, i) => values[i] ?? NaN) });
    this.numFmts.push(fmt);
    return this;
  }

  /** Any mix of values: numbers stay numbers, even in a column that also has text. */
  cells(name: string, values: readonly Cell[], fmt = ""): this {
    if (values.every((v) => v === null || typeof v === "number")) return this.num(name, values as (number | null)[], fmt);
    const col = this.columns.length;
    values.forEach((v, r) => {
      if (typeof v === "number") this.fixes.push([r, col, v]);
    });
    this.text(
      name,
      values.map((v) => (typeof v === "string" ? v : "")),
    );
    this.numFmts[col] = fmt;
    return this;
  }

  /** Every column of the sheet, for these data rows (null = an empty row). */
  copy(data: SheetData, rows: readonly (number | null)[]): this {
    data.names.forEach((name, c) => {
      const all = data.col(c);
      this.cells(
        bare(name),
        rows.map((r) => (r === null ? null : all[r])),
        data.numFmt(c),
      );
    });
    return this;
  }
}

export interface ResultSheet {
  name: string;
  out: Out;
}

/** The EditableSource for a result sheet (numbers in text columns put back). */
export function sheetSource(out: Out): EditableSource {
  const src = new EditableSource(new Table(out.columns), 5);
  for (const [r, c, v] of out.fixes) src.setCell(r, c, v);
  return src;
}

// ---------------------------------------------------------- guessing --

/** Pick a column for each role from the header names, in the order the rules are given; a column is used once. */
export function guessRoles<R extends string>(names: readonly string[], rules: readonly (readonly [R, RegExp])[]): Record<R, number> {
  const map = {} as Record<R, number>;
  const taken = new Set<number>();
  for (const [role, re] of rules) {
    if (map[role] !== undefined && map[role] >= 0) continue;
    const c = names.findIndex((n, i) => !taken.has(i) && re.test(bare(n)));
    map[role] = c;
    if (c >= 0) taken.add(c);
  }
  return map;
}

export type JeRole = "entry" | "date" | "posted" | "time" | "user" | "account" | "amount" | "debit" | "credit" | "description";
export const JE_ROLES: readonly JeRole[] = ["entry", "date", "posted", "time", "user", "account", "amount", "debit", "credit", "description"];
export const JE_ROLE_LABEL: Record<JeRole, string> = {
  entry: "Entry id",
  date: "Date (effective)",
  posted: "Posted date / time",
  time: "Posted time (if separate)",
  user: "User",
  account: "Account",
  amount: "Amount (signed)",
  debit: "Debit",
  credit: "Credit",
  description: "Description",
};
export type JeMap = Record<JeRole, number>;

const JE_RULES: [JeRole, RegExp][] = [
  ["user", /\b(user|user ?id|preparer|prepared by|posted by|entered by|created by|author|approver)\b/i],
  ["entry", /^(je|jnl|journal|entry|voucher|document|doc|batch|txn|transaction)\b.*\b(id|no|num|number|ref)\b|^(je|jnl|journal|entry|voucher|document|doc)( ?(id|no|#|number))?$|^je ?#|journal ?id|entry ?id|^id$/i],
  ["posted", /posted|posting|entered|created|entry date|input date|system date|timestamp/i],
  ["time", /\btime\b/i],
  ["date", /date|effective|gl date|period/i],
  ["account", /^(?!.*\b(name|desc|description|type)\b).*(account|acct|a\/c|gl code|nominal|ledger)/i],
  ["debit", /\b(debit|dr)\b/i],
  ["credit", /\b(credit|cr)\b/i],
  ["amount", /amount|amt|\bvalue\b|\bnet\b|\bsum\b/i],
  ["description", /desc|narrat|memo|text|comment|detail|particular|explanation/i],
];

/** Guess the journal columns from the header names. */
export function guessJeMap(names: readonly string[]): JeMap {
  const m = guessRoles(names, JE_RULES);
  // a signed amount wins over debit and credit; both debit and credit, or neither
  if (m.amount >= 0) m.debit = m.credit = -1;
  else if ((m.debit >= 0) !== (m.credit >= 0)) {
    m.amount = Math.max(m.debit, m.credit);
    m.debit = m.credit = -1;
  }
  return m;
}

/** Day-first unless some text date can only be month-first. */
export function guessDateOrder(values: readonly Cell[]): DateOrder {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[2]) > 12) mdy++;
    if (dmy + mdy > 50) break;
  }
  return mdy > dmy ? "mdy" : "dmy";
}

/** The journal lines, one per data row of the sheet. */
export function readJournal(data: SheetData, map: JeMap): JeLine[] {
  const col = (r: JeRole) => (map[r] >= 0 ? data.col(map[r]) : undefined);
  const dated = [col("date"), col("posted")].filter((x): x is Cell[] => !!x).flat();
  return jeLines({
    entry: col("entry"),
    date: col("date"),
    posted: col("posted"),
    time: col("time"),
    user: col("user"),
    account: col("account"),
    amount: col("amount"),
    debit: map.amount >= 0 ? undefined : col("debit"),
    credit: map.amount >= 0 ? undefined : col("credit"),
    description: col("description"),
    dateOrder: guessDateOrder(dated.slice(0, 5000)),
  });
}

/** Dates typed as a list (2024-12-25, 2024-12-26; 01/01/2025) as serials. Unreadable ones come back in `bad`. */
export function parseDateList(text: string): { dates: number[]; bad: string[] } {
  const dates: number[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[,;\n]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const d = /^\d{4}-/.test(s) ? parseDateLoose(s, "ymd") : parseDateLoose(s, "dmy");
    if (d === null) bad.push(s);
    else dates.push(Math.floor(d));
  }
  return { dates, bad };
}

/** "5000, 10000; 50000" as numbers (commas and spaces split the list; no thousands separators). */
export function numberList(text: string): number[] {
  return text
    .split(/[;,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** The flagged lines as a result sheet, highest score first, plus the summary per test. */
export function journalSheets(data: SheetData, lines: readonly JeLine[], r: JeResult, sheet: string, withSummary = true): ResultSheet[] {
  const rank: number[] = [];
  const score: number[] = [];
  const entry: string[] = [];
  const rowNo: number[] = [];
  const tests: string[] = [];
  const reasons: string[] = [];
  const rows: number[] = [];
  r.ranked.forEach((e, k) => {
    const t = [...new Set(e.flags.map((f) => JE_TEST_LABEL[f.test]))].join(", ");
    const why = e.flags.map((f) => f.reason).join(" | ");
    for (const i of e.lines) {
      rank.push(k + 1);
      score.push(e.score);
      entry.push(e.id || lines[i].entry || "(no id)");
      rowNo.push(data.sheetRow(i));
      tests.push(t);
      reasons.push(why);
      rows.push(i);
    }
  });
  const out = new Out().num("Rank", rank).num("Score", score).text("Entry", entry).num("Row", rowNo).text("Tests", tests).text("Reasons", reasons).copy(data, rows);
  const sheets: ResultSheet[] = [{ name: `${sheet} JE flags`, out }];
  if (withSummary) {
    const S = r.summary;
    sheets.push({
      name: `${sheet} JE summary`,
      out: new Out()
        .text(
          "Test",
          S.map((s) => s.label),
        )
        .num(
          "Weight",
          S.map((s) => JE_WEIGHTS[s.test]),
        )
        .num(
          "Entries flagged",
          S.map((s) => (s.skipped ? null : s.entries)),
          "#,##0",
        )
        .num(
          "Lines flagged",
          S.map((s) => (s.skipped ? null : s.lines)),
          "#,##0",
        )
        .text(
          "Note",
          S.map((s) => (s.skipped ? `not run: ${s.skipped}` : "")),
        ),
    });
  }
  return sheets;
}

export type PartyRole = "name" | "bank" | "address" | "phone" | "taxId";
const PARTY_RULES: [PartyRole, RegExp][] = [
  ["bank", /iban|bank ?(account|acct|a\/c|details|no|number)|account ?(no|number)|acct ?no|sort ?code|routing|bsb/i],
  ["taxId", /tax|\btin\b|\bvat\b|\bein\b|\bssn\b|national ?(id|insurance)|\bni\b|\babn\b|gst|pan\b|company ?(no|number|reg)/i],
  ["phone", /phone|mobile|\btel\b|telephone|cell/i],
  ["address", /address|street|addr\b|line ?1/i],
  ["name", /name|vendor|supplier|employee|payee|customer|staff/i],
];

export function guessPartyMap(names: readonly string[]): Record<PartyRole, number> {
  return guessRoles(names, PARTY_RULES);
}

/** A list of people or companies from a sheet; an address spread over several columns can be given as several columns. */
export function readParties(data: SheetData, map: Record<PartyRole, number>, extraAddress: readonly number[] = []): Party[] {
  const get = (c: number) => (c >= 0 ? data.col(c) : null);
  const cols = { name: get(map.name), bank: get(map.bank), address: get(map.address), phone: get(map.phone), taxId: get(map.taxId) };
  const more = extraAddress.filter((c) => c >= 0 && c !== map.address).map((c) => data.col(c));
  const s = (v: Cell | undefined) => (v === null || v === undefined ? undefined : String(v).trim() || undefined);
  return Array.from({ length: data.rows }, (_, i) => {
    const addr = [cols.address?.[i], ...more.map((m) => m[i])].map(s).filter(Boolean).join(", ");
    return { name: s(cols.name?.[i]), bank: s(cols.bank?.[i]), address: addr || undefined, phone: s(cols.phone?.[i]), taxId: s(cols.taxId?.[i]) };
  });
}

export function overlapSheet(a: SheetData, b: SheetData, pa: readonly Party[], pb: readonly Party[], r: OverlapResult, nameA: string, nameB: string): ResultSheet {
  const P = r.pairs;
  const out = new Out()
    .num(
      "Pair",
      P.map((_, i) => i + 1),
    )
    .num(
      "Score",
      P.map((p) => p.score),
    )
    .text(
      "Matched on",
      P.map((p) => p.matches.map((m) => OVERLAP_LABEL[m.field]).join(", ")),
    )
    .num(
      `Row in ${nameA}`,
      P.map((p) => a.sheetRow(p.a)),
    )
    .text(
      `Name in ${nameA}`,
      P.map((p) => pa[p.a].name ?? ""),
    )
    .num(
      `Row in ${nameB}`,
      P.map((p) => b.sheetRow(p.b)),
    )
    .text(
      `Name in ${nameB}`,
      P.map((p) => pb[p.b].name ?? ""),
    )
    .text(
      "Details",
      P.map((p) => p.matches.map((m) => `${OVERLAP_LABEL[m.field]}: ${m.a} / ${m.b}${m.similarity !== undefined ? ` (${Math.round(m.similarity * 100)}% alike)` : ""}`).join(" | ")),
    );
  return { name: `Overlaps ${nameA.slice(0, 10)} v ${nameB.slice(0, 10)}`, out };
}

/** The selected block of cells (the whole used range when a single cell is selected). */
export function readBlock(src: EditableSource, range: CellRange): { cells: Cell[][]; top: number; left: number } {
  let { top, left, bottom, right } = range;
  if (top === bottom && left === right) {
    const used = src.usedRange();
    top = 0;
    left = 0;
    bottom = used.rows - 1;
    right = used.cols - 1;
  }
  const cells: Cell[][] = [];
  for (let r = top; r <= bottom; r++) {
    const row: Cell[] = [];
    for (let c = left; c <= right; c++) {
      const v = src.getCell(r, c);
      row.push(typeof v === "number" || typeof v === "string" ? v : null);
    }
    cells.push(row);
  }
  return { cells, top, left };
}

const ref = (r: number, c: number) => `${columnLetter(c)}${r + 1}`;

export function footSheet(r: FootResult, top: number, left: number, lastRow: number, lastCol: number, sheet: string): ResultSheet {
  const check: string[] = [];
  const cell: string[] = [];
  const label: string[] = [];
  const computed: (number | null)[] = [];
  const stated: (number | null)[] = [];
  const diff: (number | null)[] = [];
  const result: string[] = [];
  for (const x of r.columns) {
    check.push("Column total (footing)");
    cell.push(ref(top + lastRow, left + x.index));
    label.push(x.label || columnLetter(left + x.index));
    computed.push(x.computed);
    stated.push(x.stated);
    diff.push(x.difference);
    result.push(x.ok ? "agrees" : "DIFFERENCE");
  }
  for (const x of r.rows) {
    check.push("Row total (cross-footing)");
    cell.push(ref(top + x.index, left + lastCol));
    label.push(x.label || `Row ${top + x.index + 1}`);
    computed.push(x.computed);
    stated.push(x.stated);
    diff.push(x.difference);
    result.push(x.ok ? "agrees" : "DIFFERENCE");
  }
  if (r.grand) {
    for (const [what, v] of [
      ["Grand total vs the total row", r.grand.byColumns],
      ["Grand total vs the total column", r.grand.byRows],
    ] as const) {
      check.push(what);
      cell.push(ref(top + lastRow, left + lastCol));
      label.push("Grand total");
      computed.push(v);
      stated.push(r.grand.stated);
      const d = Math.round(((r.grand.stated ?? 0) - v) * 100) / 100;
      diff.push(d);
      result.push(Math.abs(d) <= 0.005 && r.grand.stated !== null ? "agrees" : "DIFFERENCE");
    }
  }
  const out = new Out().text("Check", check).text("Cell", cell).text("Line", label).num("Added up", computed, MONEY).num("Stated", stated, MONEY).num("Difference", diff, MONEY).text("Result", result);
  return { name: `${sheet} footing`, out };
}

export function rollSheet(data: SheetData, r: RollResult, labelCol: number, moveNames: readonly string[], sheet: string): ResultSheet {
  const L = r.lines;
  const labels = labelCol >= 0 ? data.col(labelCol) : null;
  const out = new Out()
    .num("Row", [...L.map((l) => data.sheetRow(l.index)), null])
    .text("Line", [...L.map((l) => (labels && labels[l.index] !== null ? String(labels[l.index]) : "")), "Total"])
    .num("Opening", [...L.map((l) => l.opening), r.totals.opening], MONEY);
  moveNames.forEach((n, k) => out.num(n, [...L.map((l) => l.movements[k]), r.totals.movements[k]], MONEY));
  out
    .num("Expected closing", [...L.map((l) => l.expected), r.totals.expected], MONEY)
    .num("Closing", [...L.map((l) => l.closing), r.totals.closing], MONEY)
    .num("Difference", [...L.map((l) => l.difference), Math.round((r.totals.closing - r.totals.expected) * 100) / 100], MONEY)
    .text("Result", [...L.map((l) => (l.ok ? "agrees" : "DIFFERENCE")), r.issues ? `${r.issues} lines differ` : "all agree"]);
  return { name: `${sheet} roll-forward`, out };
}

const NEGATIVE_MOVE = /dispos|depreciat|amorti[sz]|impair|write|decrease|payment|paid|reduc|less|outflow|withdraw|utili[sz]|release|transfer out|sold|sale/i;

/** Movements named like reductions (disposals, depreciation…) are taken away, unless their values are already negative. */
export function guessSign(name: string, values: readonly Cell[]): 1 | -1 {
  if (!NEGATIVE_MOVE.test(name)) return 1;
  let pos = 0;
  let neg = 0;
  for (const v of values) {
    if (typeof v !== "number") continue;
    if (v > 0) pos++;
    else if (v < 0) neg++;
  }
  return pos >= neg ? -1 : 1;
}

export function guessRollMap(names: readonly string[]): { label: number; opening: number; closing: number; movements: number[] } {
  const m = guessRoles(names, [
    ["opening", /open|b\/f|brought forward|beginning|start|^bf$/i],
    ["closing", /clos|c\/f|carried forward|ending|^cf$|\bend\b/i],
    ["label", /^(?!.*(open|clos|balance)).*(name|desc|account|asset|category|line|item|class)/i],
  ] as const);
  const movements: number[] = [];
  if (m.opening >= 0 && m.closing > m.opening) for (let c = m.opening + 1; c < m.closing && movements.length < 6; c++) if (c !== m.label) movements.push(c);
  return { ...m, movements };
}

export interface SafeChoice {
  col: number;
  method: ProtectMethod;
  prefix: string;
}

/** The safe copy (and the pseudonym mapping, when asked for and there is any). The sheet data is only read. */
export async function buildSafeCopy(data: SheetData, choices: readonly SafeChoice[], hasher: Hasher, opts: { hashLength?: number; mapping?: boolean; sheet: string }): Promise<ResultSheet[]> {
  const method = new Map(choices.map((c) => [c.col, c]));
  const cols = data.names.map((n, c) => ({ name: bare(n), values: data.col(c), method: method.get(c)?.method ?? "keep", prefix: method.get(c)?.prefix }));
  const r = await protectColumns(cols, { hasher, hashLength: opts.hashLength, pseudonymiser: new Pseudonymiser() });
  const out = new Out();
  cols.forEach((c, i) => out.cells(c.name, r.columns[i], c.method === "keep" ? data.numFmt(i) : ""));
  const sheets: ResultSheet[] = [{ name: `${opts.sheet} safe copy`, out }];
  if (opts.mapping && r.mapping.length)
    sheets.push({
      name: `${opts.sheet} pseudonym map`,
      out: new Out()
        .text(
          "Column",
          r.mapping.map((m) => m.column),
        )
        .text(
          "Token",
          r.mapping.map((m) => m.token),
        )
        .text(
          "Original value",
          r.mapping.map((m) => m.original),
        ),
    });
  return sheets;
}

// ------------------------------------------------------------- controls --

const field = (text: string, control: HTMLElement, hint?: string): HTMLLabelElement => tkField(text, control, hint);

const LIMIT_LADDER = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 5000000];

/**
 * Approval limits to start "just below an approval limit" with when none are
 * typed: the three round limits nearest the top of the amounts (10,000 when
 * there are no amounts). Pure.
 */
export function defaultLimits(amounts: Iterable<number | null | undefined>): number[] {
  let max = 0;
  for (const a of amounts) if (typeof a === "number" && Number.isFinite(a)) max = Math.max(max, Math.abs(a));
  const fit = LIMIT_LADDER.filter((L) => L <= max);
  return fit.length ? fit.slice(-3) : [10000];
}

function columnSelect(names: readonly string[], value: number, none?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  if (none) sel.append(new Option(none, "-1"));
  names.forEach((n, c) => sel.append(new Option(n, String(c))));
  sel.value = String(value >= 0 ? value : none ? -1 : 0);
  return sel;
}

function numberInput(value: number | string, min?: number, step = "any"): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "number";
  i.value = String(value);
  if (min !== undefined) i.min = String(min);
  i.step = step;
  return i;
}

function textInput(value: string, placeholder = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value;
  i.placeholder = placeholder;
  return i;
}

function choice(options: readonly (readonly [string, string])[], value?: string): HTMLSelectElement {
  const sel = document.createElement("select");
  for (const [v, t] of options) sel.append(new Option(t, v));
  if (value !== undefined) sel.value = value;
  return sel;
}

function checkbox(text: string, checked = false): { el: HTMLLabelElement; input: HTMLInputElement } {
  const el = document.createElement("label");
  el.className = "audit-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  el.append(input, text);
  return { el, input };
}

function grid(cls: string, ...children: HTMLElement[]): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.append(...children);
  return d;
}

function section(title: string, open: boolean, ...children: HTMLElement[]): HTMLDetailsElement {
  const d = document.createElement("details");
  d.className = "je-section";
  d.open = open;
  const s = document.createElement("summary");
  s.textContent = title;
  d.append(s, ...children);
  return d;
}

const val = (i: HTMLInputElement | HTMLSelectElement, fallback: number) => {
  const n = Number(i.value);
  return i.value.trim() !== "" && Number.isFinite(n) ? n : fallback;
};

// ----------------------------------------------------------------- tools --

interface Preview {
  lines: { text: string; warn?: boolean }[];
  headline?: HeadlineOptions;
  /** a formatted table whose rows link to a sheet row (1-based) */
  grid?: { title?: string; columns: TableColumn<Record<string, unknown>>[]; rows: Record<string, unknown>[]; sheetRow?: (r: Record<string, unknown>) => number };
  table?: string[][];
  /** Builds the sheets to add, or null when there's nothing to add. */
  make: (() => Promise<ResultSheet[]> | ResultSheet[]) | null;
  done: string;
  ok?: string;
}

interface Tool {
  title: string;
  intro: string;
  fields: HTMLElement[];
  compute(): Preview;
}

function journalTool(data: SheetData, sheet: string): Tool {
  const guess = guessJeMap(data.names);
  const sel = {} as Record<JeRole, HTMLSelectElement>;
  const mapBox = grid("je-map");
  for (const r of JE_ROLES) {
    sel[r] = columnSelect(data.names, guess[r], "(none)");
    mapBox.append(field(JE_ROLE_LABEL[r], sel[r]));
  }
  const checks = {} as Record<JeTestId, HTMLInputElement>;
  const testBox = grid("je-tests");
  for (const t of JE_TESTS) {
    const c = checkbox(JE_TEST_LABEL[t], true);
    checks[t] = c.input;
    testBox.append(c.el);
  }
  const holidays = textInput("", "e.g. 2024-12-25, 2024-12-26");
  const hStart = numberInput(8, 0);
  const hEnd = numberInput(18, 0);
  const roundMul = numberInput(1000, 0);
  const roundZeros = numberInput(0, 0, "1");
  const amountCol = guess.amount >= 0 ? guess.amount : guess.debit;
  const startLimits = defaultLimits(amountCol >= 0 ? (data.col(amountCol).map((v) => (typeof v === "number" ? v : null))) : []);
  const limits = textInput(startLimits.join(", "), "e.g. 5000, 10000, 50000");
  const margin = numberInput(5, 0);
  const backDays = numberInput(30, 0, "1");
  const seldom = numberInput(3, 1, "1");
  const rareLines = numberInput(2, 1, "1");
  const rareAccount = numberInput(10, 1, "1");
  const rareUser = numberInput(2, 0, "1");
  const keywords = textInput(DEFAULT_JE_KEYWORDS.join(", "));
  const peDays = numberInput(3, 1, "1");
  const pePeriod = choice(
    [
      ["month", "month end"],
      ["quarter", "quarter end"],
      ["year", "year end"],
    ],
    "month",
  );
  const dupDays = numberInput(0, -1, "1");
  const summarySheet = checkbox("Also add a summary sheet per test", true);
  const params = section(
    "Test settings (holidays, hours, limits, keywords…)",
    false,
    grid(
      "je-params",
      field("Holidays", holidays, "Dates separated by commas."),
      field("Working hours from", hStart, "Hours, 8.5 = 08:30."),
      field("Working hours to", hEnd),
      field("Round: multiple of", roundMul),
      field("Round: trailing zeros at least", roundZeros, "0 = off."),
      field("Approval limits", limits, `Started at ${startLimits.map((x) => x.toLocaleString("en-US")).join(", ")} from the size of the amounts. Type your own.`),
      field("Just below: within %", margin),
      field("Backdated: posted more than (days)", backDays),
      field("Seldom-used: account in at most (entries)", seldom),
      field("Unusual user: at most (lines) for the account", rareLines),
      field("… on accounts with at least (lines)", rareAccount),
      field("Users with at most (entries)", rareUser, "0 = off."),
      field("Keywords", keywords, "Matched at the start of a word: adjust finds adjustment."),
      field("Near the period end: last (days)", peDays),
      field("Period", pePeriod),
      field("Duplicates: dates at most (days) apart", dupDays, "0 = same date, -1 = any date."),
    ),
  );
  return {
    title: "Journal entry tests",
    intro: "The standard journal entry tests on a journal (one row per line), run as soon as it opens: columns are guessed from the headers and every test is on. Adjust either under Settings. The results sheet lists every line of every flagged entry, highest score first.",
    fields: [section("Columns (guessed from the headers)", false, mapBox), section("Tests to run", false, testBox), params, summarySheet.el],
    compute() {
      const map = {} as JeMap;
      for (const r of JE_ROLES) map[r] = Number(sel[r].value);
      if (map.amount < 0 && map.debit < 0 && map.credit < 0) return { lines: [{ text: "Pick the amount column, or the debit and credit columns.", warn: true }], make: null, done: "" };
      const lines = readJournal(data, map);
      const hol = parseDateList(holidays.value);
      const opts: JeOptions = {
        tests: JE_TESTS.filter((t) => checks[t].checked),
        holidays: hol.dates,
        hours: { start: val(hStart, 8), end: val(hEnd, 18) },
        round: { multiple: val(roundMul, 1000), zeros: val(roundZeros, 0) },
        limits: numberList(limits.value),
        margin: val(margin, 5) / 100,
        backdatedDays: val(backDays, 30),
        seldomEntries: val(seldom, 3),
        rare: { maxLines: val(rareLines, 2), minAccountLines: val(rareAccount, 10), userEntries: val(rareUser, 2) },
        keywords: keywords.value.split(/[,;]+/).map((s) => s.trim()).filter(Boolean),
        periodEnd: { days: val(peDays, 3), period: pePeriod.value as "month" | "quarter" | "year" },
        duplicates: { days: val(dupDays, 0) },
      };
      const r = runJeTests(lines, opts);
      const out: Preview["lines"] = [];
      out.push({ text: `${plural(r.lines, "line")} in ${plural(r.entries.length, "entry", "entries")}. ${plural(r.ranked.length, "entry", "entries")} flagged by at least one test.`, warn: r.ranked.length > 0 });
      if (r.noId && map.entry >= 0) out.push({ text: `${plural(r.noId, "line")} without an entry id; each is treated as an entry of its own.`, warn: true });
      if (map.entry < 0) out.push({ text: "No entry id column: each line is its own entry, and the balance and duplicate tests can't run." });
      if (hol.bad.length) out.push({ text: `Couldn't read these holidays as dates: ${hol.bad.join(", ")}.`, warn: true });
      if (r.periodEnd) out.push({ text: `${pct(r.periodEnd.share)} of dated entries fall in the last ${plural(opts.periodEnd!.days!, "day")} of the ${opts.periodEnd!.period}; about ${pct(r.periodEnd.expected)} would if dates were spread evenly.`, warn: r.periodEnd.share > 2 * r.periodEnd.expected });
      const table = [["Test", "Entries", "Lines", "Note"], ...r.summary.map((s) => [s.label, s.skipped ? "" : count(s.entries), s.skipped ? "" : count(s.lines), s.skipped ? `not run: ${s.skipped}` : ""])];
      const ranked = r.ranked.slice(0, 200).map((e) => ({ entry: e.id || `Row ${data.sheetRow(e.lines[0])}`, score: e.score, date: e.date, amount: e.debits, tests: [...new Set(e.flags.map((f) => JE_TEST_LABEL[f.test]))].join(", "), first: data.sheetRow(e.lines[0]) }));
      out.shift();
      return {
        lines: out,
        headline: {
          value: count(r.ranked.length),
          unit: r.ranked.length === 1 ? "entry flagged" : "entries flagged",
          tone: r.ranked.length ? "mismatch" : "match",
          progress: r.entries.length ? r.ranked.length / r.entries.length : 0,
          caption: `Out of ${plural(r.entries.length, "entry", "entries")} (${plural(r.lines, "line")}). Each flagged entry scores the weights of the tests it fails; the riskiest come first.`,
        },
        grid: r.ranked.length
          ? {
              title: "Highest scores",
              columns: [
                { key: "entry", label: "Entry" },
                { key: "score", label: "Score", format: "integer" },
                { key: "date", label: "Date", format: "date" },
                { key: "amount", label: "Debits", format: "amount" },
                { key: "tests", label: "Tests failed" },
              ],
              rows: ranked,
              sheetRow: (x) => x.first as number,
            }
          : undefined,
        table,
        make: r.ranked.length ? () => journalSheets(data, lines, r, sheet, summarySheet.input.checked) : null,
        done: `Journal entry tests: ${plural(r.ranked.length, "entry", "entries")} flagged`,
      };
    },
  };
}

function overlapsTool(wb: Workbook, activeId: string): Tool {
  const visible = wb.sheets.filter((s) => !s.hidden);
  const opts = visible.map((s) => [s.id, s.name] as const);
  const other = visible.find((s) => s.id !== activeId) ?? visible[0];
  const sheetA = choice(opts, activeId);
  const sheetB = choice(opts, other.id);
  const sides = [
    { sheet: sheetA, box: grid("je-map"), sel: {} as Record<PartyRole, HTMLSelectElement>, extra: null as HTMLSelectElement | null, data: null as SheetData | null },
    { sheet: sheetB, box: grid("je-map"), sel: {} as Record<PartyRole, HTMLSelectElement>, extra: null as HTMLSelectElement | null, data: null as SheetData | null },
  ];
  const ROLE: Record<PartyRole, string> = { name: "Name", bank: "Bank account / IBAN", address: "Address", phone: "Phone", taxId: "Tax id" };
  const build = (side: (typeof sides)[number]) => {
    side.data = readSheet(wb.get(side.sheet.value).source);
    const g = guessPartyMap(side.data.names);
    side.box.replaceChildren();
    for (const r of ["name", "bank", "address", "phone", "taxId"] as const) {
      side.sel[r] = columnSelect(side.data.names, g[r], "(none)");
      side.box.append(field(ROLE[r], side.sel[r]));
    }
    // a second address column (city, postcode) joined to the first
    const city = side.data.names.findIndex((n, c) => c !== g.address && /city|town|post ?code|zip/i.test(bare(n)));
    side.extra = columnSelect(side.data.names, city, "(none)");
    side.box.append(field("More of the address", side.extra));
  };
  sides.forEach((s) => {
    build(s);
    s.sheet.addEventListener("change", () => build(s));
  });
  const sim = numberInput(92, 50);
  const fieldChecks = {} as Record<OverlapField, HTMLInputElement>;
  const fieldBox = grid("je-tests");
  for (const f of OVERLAP_FIELDS) {
    const c = checkbox(OVERLAP_LABEL[f], true);
    fieldChecks[f] = c.input;
    fieldBox.append(c.el);
  }
  return {
    title: "Red-flag overlaps",
    intro: "Compares two lists, such as the vendor master and the employee master, and lists the pairs that share a bank account, tax id, phone number or address, or have names spelled alike. Values are compared after tidying: case, spaces and punctuation are ignored, Street reads as St, phone numbers by their last 9 digits.",
    fields: [field("First list", sheetA), sides[0].box, field("Second list", sheetB), sides[1].box, field("Compare", fieldBox), field("Names alike: at least %", sim, "Jaro-Winkler, after dropping Ltd, Inc, Mr and the like. 92% catches typos; lower finds more.")],
    compute() {
      const [A, B] = sides;
      const mapOf = (s: (typeof sides)[number]) => Object.fromEntries((["name", "bank", "address", "phone", "taxId"] as const).map((r) => [r, Number(s.sel[r].value)])) as Record<PartyRole, number>;
      const pa = readParties(A.data!, mapOf(A), [Number(A.extra!.value)]);
      const pb = readParties(B.data!, mapOf(B), [Number(B.extra!.value)]);
      const fields = OVERLAP_FIELDS.filter((f) => fieldChecks[f].checked && mapOf(A)[f] >= 0 && mapOf(B)[f] >= 0);
      if (!fields.length) return { lines: [{ text: "Pick at least one column that both lists have.", warn: true }], make: null, done: "" };
      const r = redFlagOverlaps(pa, pb, { fields, nameSimilarity: Math.min(1, Math.max(0.5, val(sim, 92) / 100)) });
      const na = wb.get(A.sheet.value).name;
      const nb = wb.get(B.sheet.value).name;
      const lines: Preview["lines"] = [
        { text: `${plural(pa.length, "row")} in ${na} against ${plural(pb.length, "row")} in ${nb}, on ${fields.map((f) => OVERLAP_LABEL[f].toLowerCase()).join(", ")}.` },
        { text: r.pairs.length ? `${plural(r.pairs.length, "pair")} found: ${fields.map((f) => `${OVERLAP_LABEL[f].toLowerCase()} ${count(r.byField[f])}`).join(", ")}.` : "No overlaps found.", warn: r.pairs.length > 0 },
      ];
      if (A.sheet.value === B.sheet.value) lines.push({ text: "Both lists are the same sheet: every row matches itself.", warn: true });
      const table = [["Score", `${na} row`, "Name", `${nb} row`, "Name", "Matched on"], ...r.pairs.slice(0, 12).map((p) => [String(p.score), String(A.data!.sheetRow(p.a)), pa[p.a].name ?? "", String(B.data!.sheetRow(p.b)), pb[p.b].name ?? "", p.matches.map((m) => OVERLAP_LABEL[m.field]).join(", ")])];
      return { lines, table: r.pairs.length ? table : undefined, make: r.pairs.length ? () => [overlapSheet(A.data!, B.data!, pa, pb, r, na, nb)] : null, done: `Overlaps: ${plural(r.pairs.length, "pair")}` };
    },
  };
}

function footingTool(src: EditableSource, range: CellRange, sheet: string): Tool {
  const { cells, top, left } = readBlock(src, range);
  const g = guessFootLayout(cells);
  const head = numberInput(g.headerRows, 0, "1");
  const labels = numberInput(g.labelCols, 0, "1");
  const totalRow = checkbox("The last row holds the column totals", true);
  const totalCol = checkbox("The last column holds the row totals", cells[0] ? cells[0].length - g.labelCols > 2 : false);
  const tol = numberInput(0.01, 0);
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  const where = `${ref(top, left)}:${ref(top + rows - 1, left + cols - 1)}`;
  return {
    title: "Foot and cross-foot this range",
    intro: `Adds up each column of ${where} and compares it with the total row, and adds across each row and compares it with the total column. Text and blank cells count as nothing. Select the schedule including its totals before opening this.`,
    fields: [field("Heading rows at the top", head), field("Label columns on the left", labels), totalRow.el, totalCol.el, field("Differences up to this are fine", tol)],
    compute() {
      if (rows < 2 && cols < 2) return { lines: [{ text: "Select the block of numbers with its totals first.", warn: true }], make: null, done: "" };
      if (!totalRow.input.checked && !totalCol.input.checked) return { lines: [{ text: "Tick at least one of the totals.", warn: true }], make: null, done: "" };
      const r = footRange(cells, { headerRows: val(head, 0), labelCols: val(labels, 0), totalRow: totalRow.input.checked, totalCol: totalCol.input.checked, tolerance: Math.max(0, val(tol, 0.01)) });
      const lines: Preview["lines"] = [];
      const checked = r.columns.length + r.rows.length + (r.grand ? 1 : 0);
      lines.push({ text: r.issues ? `${plural(r.issues, "total")} of ${count(checked)} don't agree.` : `All ${plural(checked, "total")} agree.`, warn: r.issues > 0 });
      const bad = [...r.columns.filter((x) => !x.ok).map((x) => ["Column", x.label || columnLetter(left + x.index), money(x.computed), x.stated === null ? "(blank)" : money(x.stated), money(x.difference)]), ...r.rows.filter((x) => !x.ok).map((x) => ["Row", x.label || String(top + x.index + 1), money(x.computed), x.stated === null ? "(blank)" : money(x.stated), money(x.difference)])];
      if (r.grand && !r.grand.ok) bad.push(["Grand total", "", `${money(r.grand.byColumns)} / ${money(r.grand.byRows)}`, r.grand.stated === null ? "(blank)" : money(r.grand.stated), ""]);
      return {
        lines,
        table: bad.length ? [["Check", "Line", "Added up", "Stated", "Difference"], ...bad.slice(0, 20)] : undefined,
        make: checked ? () => [footSheet(r, top, left, rows - 1, cols - 1, sheet)] : null,
        done: `Footing ${where}: ${r.issues ? plural(r.issues, "difference") : "all totals agree"}`,
      };
    },
  };
}

function rollTool(data: SheetData, sheet: string): Tool {
  const g = guessRollMap(data.names);
  const label = columnSelect(data.names, g.label, "(none)");
  const opening = columnSelect(data.names, g.opening);
  const closing = columnSelect(data.names, g.closing);
  const moves = [0, 1, 2, 3, 4, 5].map((k) => {
    const c = g.movements[k] ?? -1;
    const col = columnSelect(data.names, c, "(not used)");
    const sign = choice(
      [
        ["1", "add"],
        ["-1", "take away"],
      ],
      c >= 0 ? String(guessSign(bare(data.names[c]), data.col(c))) : "1",
    );
    const row = grid("je-move", col, sign);
    return { col, sign, row };
  });
  const tol = numberInput(0.01, 0);
  return {
    title: "Roll-forward check",
    intro: "For each row: opening balance plus the movements should equal the closing balance. Movements that reduce the balance (disposals, depreciation) are taken away unless they are already negative numbers.",
    fields: [field("Line name", label), field("Opening balance", opening), field("Movements", grid("je-moves", ...moves.map((m) => m.row))), field("Closing balance", closing), field("Differences up to this are fine", tol)],
    compute() {
      const used = moves.filter((m) => Number(m.col.value) >= 0);
      const r = rollForward(
        data.col(Number(opening.value)),
        used.map((m) => ({ values: data.col(Number(m.col.value)), sign: Number(m.sign.value) as 1 | -1 })),
        data.col(Number(closing.value)),
        Math.max(0, val(tol, 0.01)),
      );
      const names = used.map((m) => bare(data.names[Number(m.col.value)]));
      const lab = Number(label.value);
      const lines: Preview["lines"] = [{ text: r.issues ? `${plural(r.issues, "line")} of ${count(r.lines.length)} don't roll forward.` : `All ${plural(r.lines.length, "line")} roll forward.`, warn: r.issues > 0 }];
      lines.push({ text: `Totals: opening ${money(r.totals.opening)}${r.totals.movements.map((m, k) => `, ${names[k]} ${money(m)}`).join("")}, expected closing ${money(r.totals.expected)}, closing ${money(r.totals.closing)}.` });
      const bad = r.lines.filter((l) => !l.ok);
      const table = bad.length ? [["Row", "Line", "Expected", "Closing", "Difference"], ...bad.slice(0, 15).map((l) => [String(data.sheetRow(l.index)), lab >= 0 ? String(data.col(lab)[l.index] ?? "") : "", money(l.expected), l.closing === null ? "(blank)" : money(l.closing), money(l.difference)])] : undefined;
      return { lines, table, make: r.lines.length ? () => [rollSheet(data, r, lab, names, sheet)] : null, done: `Roll-forward: ${r.issues ? plural(r.issues, "difference") : "all lines agree"}` };
    },
  };
}

const METHODS: ProtectMethod[] = ["keep", "mask", "hash", "pseudonymise", "redact"];

function piiTool(data: SheetData, sheet: string): Tool {
  const scans: PiiColumnScan[] = scanPii(data.names.map((n, c) => ({ name: bare(n), values: data.col(c) })));
  const table = document.createElement("table");
  table.className = "je-pii";
  const head = document.createElement("tr");
  for (const t of ["Column", "Looks like", "Examples", "In the copy"]) {
    const th = document.createElement("th");
    th.textContent = t;
    head.append(th);
  }
  table.append(head);
  const pickers = scans.map((s) => {
    const tr = document.createElement("tr");
    const found = s.kinds.map((k) => `${PII_LABEL[k.kind]} (${count(k.count)})`);
    if (s.byHeader && !s.kinds.some((k) => k.kind === s.byHeader)) found.push(`${PII_LABEL[s.byHeader]} (by its name)`);
    const examples = s.kinds.flatMap((k) => k.examples).slice(0, 2);
    const cells = [data.names[s.col], found.join(", ") || "nothing found", examples.join("; ")];
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    const sel = choice(
      METHODS.map((m) => [m, PROTECT_LABEL[m]] as const),
      s.suggested,
    );
    sel.setAttribute("aria-label", `In the copy: ${data.names[s.col]}`);
    const td = document.createElement("td");
    td.append(sel);
    tr.append(td);
    if (s.kind) tr.className = "je-pii-hit";
    table.append(tr);
    return sel;
  });
  const wrap = document.createElement("div");
  wrap.className = "import-preview";
  wrap.append(table);
  const salt = textInput(newSalt());
  const hashLen = numberInput(16, 8, "1");
  const mapping = checkbox("Also add the pseudonym mapping as a separate sheet (keep it private)", true);
  return {
    title: "PII scan and safe copy",
    intro: "Looks for personal data in every column, then makes a new sheet that is a safe copy: each column kept, masked, hashed, replaced by tokens, or blanked. The original sheet is never changed. The copy holds values only, not formulas.",
    fields: [wrap, field("Salt for hashing", salt, "Kept out of the copy. Use the same salt on another file to get the same hashes, so the files still join."), field("Hash length (hex characters)", hashLen), mapping.el],
    compute() {
      const found = scans.filter((s) => s.kind);
      const choices: SafeChoice[] = scans.map((s, i) => ({ col: s.col, method: pickers[i].value as ProtectMethod, prefix: pseudonymPrefix(s.kind ?? s.byHeader) }));
      const changed = choices.filter((c) => c.method !== "keep");
      const lines: Preview["lines"] = [{ text: found.length ? `${plural(found.length, "column")} look${found.length === 1 ? "s" : ""} like personal data: ${found.map((s) => `${s.name} (${PII_LABEL[s.kind!].toLowerCase()})`).join(", ")}.` : "No personal data found. Check the columns yourself before sharing; names and free text are hard to spot.", warn: found.length > 0 }];
      const missed = found.filter((s) => pickers[scans.indexOf(s)].value === "keep");
      if (missed.length) lines.push({ text: `Kept as is: ${missed.map((s) => s.name).join(", ")}.`, warn: true });
      lines.push({ text: changed.length ? `${plural(changed.length, "column")} will be protected in the copy.` : "Every column is kept as is." });
      if (choices.some((c) => c.method === "hash") && salt.value.trim().length < 8) lines.push({ text: "Use a longer salt (8 characters or more); short ones make hashes easy to reverse.", warn: true });
      if (mapping.input.checked && choices.some((c) => c.method === "pseudonymise")) lines.push({ text: "The mapping sheet undoes the pseudonyms. Delete it or move it to another file before you share." });
      return {
        lines,
        make: () => buildSafeCopy(data, choices, saltedHasher(salt.value), { hashLength: val(hashLen, 16), mapping: mapping.input.checked, sheet }),
        done: `Safe copy made: ${plural(changed.length, "column")} protected`,
        ok: "Make the safe copy",
      };
    },
  };
}

// ---------------------------------------------------------------- panel --

const JE_TITLE: Record<JeToolKind, string> = { journal: "Journal entry tests", overlaps: "Red-flag overlaps", footing: "Foot and cross-foot", rollforward: "Roll-forward check", pii: "PII scan and safe copy" };

export function openJeTool(kind: JeToolKind, d: JeToolDeps): void {
  const sheetName = d.sheetName();
  const sheet = sheetName.slice(0, 16);
  const goTo = navigator(d.goTo);
  const sheetId = d.activeSheet();
  const goRow = goTo ? (row: number, col = 0) => goTo(sheetId, row - 1, col) : null;
  const empty = (title: string, text: string): void =>
    void
    openSidePanel({ id: `je-${kind}`, title: JE_TITLE[kind], subtitle: sheetName, onClose: () => d.focusGrid(), render: (p) => void p.body.append(emptyState({ icon: "audit", title, text })) });
  let tool: Tool;
  if (kind === "overlaps") {
    const wb = d.workbook();
    if (wb.sheets.filter((s) => !s.hidden).length < 2) return empty("Two lists are needed", "Open the two lists (for example the vendor master and the employee master) as two sheets, then run this again. It finds shared bank accounts, addresses, phone numbers, tax ids and similar names.");
    tool = overlapsTool(wb, d.activeSheet());
  } else if (kind === "footing") {
    tool = footingTool(d.source(), d.range(), sheet);
  } else {
    const data = readSheet(d.source());
    if (!data.names.length || !data.rows)
      return empty("This sheet has no data", kind === "journal" ? "Open or paste the journal first: one row per line, with columns such as Entry, Date, Account, Debit, Credit, User and Description." : "Open or paste the data first, with the column names in the first row.");
    tool = kind === "journal" ? journalTool(data, sheet) : kind === "rollforward" ? rollTool(data, sheet) : piiTool(data, sheet);
  }

  let preview: Preview | null = null;
  openSidePanel({
    id: `je-${kind}`,
    title: tool.title,
    subtitle: kind === "overlaps" ? "Two lists side by side" : `On ${sheetName}`,
    onClose: () => d.focusGrid(),
    render: (p) => {
      const fields = el("div", { className: "audit-fields je-fields" }, ...tool.fields);
      const result = el("div", { className: "audit-result" });
      result.setAttribute("aria-live", "polite");
      p.body.append(el("p", { className: "tk-muted audit-intro", textContent: tool.intro }), ...(kind === "journal" ? [tkSection("Result", result), tkSection("Settings", fields)] : [tkSection("Settings", fields), tkSection("Result", result)]));
      const ok = button("Create results sheet", () => {
        clearTimeout(timer);
        update();
        const pv = preview;
        if (!pv?.make) return;
        ok.disabled = true;
        void (async () => {
          try {
            const sheets = await pv.make!();
            for (const s of sheets) await d.run({ type: "sheet.insert", params: { name: s.name.slice(0, 31), source: d.putBlob(sheetSource(s.out)), numFmts: s.out.numFmts } });
            report(d.status, pv.done);
          } catch (e) {
            result.prepend(notice((e as Error).message, "danger"));
          } finally {
            ok.disabled = false;
          }
        })();
      }, "primary");
      p.footer.append(ok);

      const update = () => {
        result.replaceChildren();
        try {
          preview = tool.compute();
        } catch (e) {
          preview = null;
          result.append(notice((e as Error).message, "danger"));
          ok.disabled = true;
          return;
        }
        const pv = preview;
        const lines = [...pv.lines];
        if (pv.headline) result.append(headline(pv.headline));
        else if (lines.length && !lines[0].warn) result.append(el("p", { className: "tk-lead", textContent: lines.shift()!.text }));
        for (const l of lines) result.append(l.warn ? notice(l.text, "warning") : el("p", { className: "tk-muted", textContent: l.text }));
        if (pv.grid) {
          const g = pv.grid;
          if (g.title) result.append(el("h4", { className: "je-subtitle", textContent: g.title }));
          result.append(renderTable<Record<string, unknown>>({ columns: g.columns, rows: g.rows, onRowClick: goRow && g.sheetRow ? (r) => goRow(g.sheetRow!(r)) : undefined, maxHeight: "40vh" }).element);
        }
        if (pv.table) result.append(stringGrid(pv.table, goRow));
        ok.disabled = !pv.make;
        ok.textContent = pv.ok ?? "Create results sheet";
        ok.title = pv.make ? "" : "Nothing to put on a sheet yet";
      };
      let timer = 0;
      const later = () => {
        clearTimeout(timer);
        timer = window.setTimeout(update, 250);
      };
      fields.addEventListener("input", later);
      fields.addEventListener("change", later);
      update();
      (fields.querySelector("select, input") as HTMLElement | null)?.focus();
      return () => clearTimeout(timer);
    },
  });
}
