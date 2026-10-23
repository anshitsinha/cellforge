/**
 * After (or instead of) a plain reconciliation: the bank rec statement with
 * proposed adjusting entries, rolling last period's outstanding items
 * forward, open-item matching inside one account, and supplier / customer
 * statement recs. Each dialog picks the sheet(s), maps the columns (guessed),
 * asks for the balances and dates it needs, shows a summary and adds the
 * result sheets.
 */
import "./openitems.css";
import type { Action } from "@cellforge/actions";
import { formatValue, parseDateLoose, parseNumberLoose, reconcile, Table, type ColumnData, type RecRecord, type RecRule } from "@cellforge/core";
import { proposeAdjustments, recStatement, type AdjEntry, type RecItem, type RecLine, type RecStatement } from "@cellforge/core";
import {
  guessStatementSigns,
  matchOpenItems,
  rollOutstanding,
  statementRec,
  type OpenItemRecord,
  type OpenItemResult,
  type OpenItemRule,
  type OutstandingRoll,
  type StatementRecRecord,
  type StatementRecResult,
} from "@cellforge/core";
import { EditableSource } from "./editable";
import { guessMap, needTwoSheets, pickSides, readSide, reconSheets, RECON_ROLES, RULE_LABEL, sheetHeader, sidePreview, type ReconMap, type ReconRole, type ReconSheet } from "./recondialog";
import type { Sheet, Workbook } from "./workbook";
import { setCells } from "./actions";
import type { OutstandingKind } from "./templates";
import { dataRows } from "./usedrange";
import { el, field, headline, notice, plural, report, section, toolDialog } from "./toolkit";
import { formatCell, renderTable } from "./ui/table";

export interface OpenItemsDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

export type OpenItemsKind = "bankstatement" | "rollforward" | "openitems" | "statementrec";

// ------------------------------------------------------------ helpers --

const DATE = "yyyy-mm-dd";
const MONEY = "#,##0.00;-#,##0.00";

const textCol = (name: string, values: string[]): ColumnData => {
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
};
const numCol = (name: string, values: Array<number | undefined | null>): ColumnData => ({
  kind: "number",
  name,
  values: Float64Array.from(values, (v) => (v === undefined || v === null || !Number.isFinite(v) ? NaN : v)),
});

/** A typed-in amount (1,234.50, (12.00), -5), or null when blank or unreadable. */
export function parseAmountInput(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  return parseNumberLoose(t);
}

/** A typed-in date (2024-01-31, 31/01/2024...) as a serial, or null. */
export function parseDateInput(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const d = parseDateLoose(t, "dmy");
  return d === null ? null : Math.floor(d);
}

/** Ageing bucket ends from "30, 60, 90". */
export function parseLimits(s: string): number[] {
  const out = s
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x >= 0)
    .map(Math.floor);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : [30, 60, 90];
}

export const dateText = (serial: number | null | undefined): string => (serial === null || serial === undefined || !Number.isFinite(serial) ? "" : formatValue(serial, DATE).text);

/** The latest date among records, or null. */
export function latestDate(...lists: RecRecord[][]): number | null {
  let best: number | null = null;
  for (const l of lists) for (const r of l) if (r.date !== undefined && Number.isFinite(r.date)) best = Math.max(best ?? r.date, r.date);
  return best;
}

/** Records added up (amounts only). */
export const totalOf = (l: RecRecord[]): number => Math.round(l.reduce((t, r) => t + (r.amount !== undefined && Number.isFinite(r.amount) ? r.amount : 0), 0) * 100) / 100;

const KEY_RE = /\b(ref|reference|invoice|inv|doc(ument)? ?(no|number|#)|voucher|cheque|chq|number|no|num)\b|#/i;

/**
 * The column for an extra role (party, document type): the first header
 * that fits, preferring one not already mapped. A column the guess had
 * taken as the reference ("Doc type") is handed over, and the reference
 * re-guessed from the other headers; one taken as the description can be
 * shared. Changes `map` in place.
 */
export function guessExtra(names: string[], re: RegExp, map: ReconMap): number {
  const taken = new Set(RECON_ROLES.map((r) => map[r]).filter((c) => c >= 0));
  let c = names.findIndex((n, i) => !taken.has(i) && re.test(n));
  if (c < 0) c = names.findIndex((n) => re.test(n));
  if (c < 0) return -1;
  for (const role of RECON_ROLES) {
    if (role === "text" || map[role] !== c) continue;
    if (role !== "key") return -1;
    map.key = names.findIndex((n, i) => i !== c && !taken.has(i) && KEY_RE.test(n));
  }
  return c;
}
export const PARTY_RE = /customer|supplier|vendor|party|account name|acct name|payee|client|employee|counterparty|partner|\bname\b/i;
export const TYPE_RE = /\b(type|doc(ument)? ?type|trans(action)? ?type|tx type|kind|category)\b/i;

/** A text value per record from another column (records carry their 1-based sheet row). */
export function readExtra(src: EditableSource, records: RecRecord[], col: number): string[] {
  return records.map((r) => {
    if (col < 0) return "";
    const v = src.getCell(r.row - 1, col);
    return v === null || v === undefined ? "" : String(v).trim();
  });
}

const rowsOf = (recs: RecRecord[], ids: number[]) => ids.map((i) => recs[i]?.row).filter((x) => x !== undefined).join(", ");

/**
 * A reconciling statement as a sheet: each section opens with a balance,
 * lists its lines (total on the line, items under it) and closes with a
 * balance; `tail` rows come at the end (the difference and so on).
 */
export function linesSheet(
  name: string,
  sections: Array<{ opening: { label: string; total: number }; lines: RecLine[]; closing: { label: string; total: number } }>,
  tail: Array<{ label: string; total: number }>,
  a: RecRecord[],
  b: RecRecord[],
  sideNames: [string, string],
): ReconSheet {
  const c = { line: [] as string[], ra: [] as string[], rb: [] as string[], key: [] as string[], date: [] as Array<number | undefined>, text: [] as string[], item: [] as Array<number | null>, total: [] as Array<number | null>, note: [] as string[] };
  const head = (label: string, total: number | null) => {
    c.line.push(label);
    c.ra.push("");
    c.rb.push("");
    c.key.push("");
    c.date.push(undefined);
    c.text.push("");
    c.item.push(null);
    c.total.push(total);
    c.note.push("");
  };
  sections.forEach((s, k) => {
    if (k) head("", null);
    head(s.opening.label, s.opening.total);
    for (const l of s.lines) {
      if (!l.items.length) continue;
      head(l.label, l.total);
      for (const it of l.items) {
        const first = it.a.length ? a[it.a[0]] : b[it.b[0]];
        c.line.push("");
        c.ra.push(rowsOf(a, it.a));
        c.rb.push(rowsOf(b, it.b));
        c.key.push(first?.key ?? "");
        c.date.push(first?.date);
        c.text.push(first?.text ?? "");
        c.item.push(it.value);
        c.total.push(null);
        c.note.push(it.note);
      }
    }
    head(s.closing.label, s.closing.total);
  });
  if (tail.length) head("", null);
  for (const t of tail) head(t.label, t.total);
  return {
    name,
    columns: [
      textCol("Line", c.line),
      textCol(`${sideNames[0]} row`, c.ra),
      textCol(`${sideNames[1]} row`, c.rb),
      textCol("Reference", c.key),
      numCol("Date", c.date),
      textCol("Description", c.text),
      numCol("Item", c.item),
      numCol("Total", c.total),
      textCol("Note", c.note),
    ],
    numFmts: ["", "", "", "", DATE, "", MONEY, MONEY, ""],
  };
}

/** The bank rec statement as a sheet. */
export function bankStatementSheet(st: RecStatement, a: RecRecord[], b: RecRecord[]): ReconSheet {
  return linesSheet(
    "Bank rec statement",
    [
      { opening: { label: st.bankLines[0].label, total: st.bankLines[0].total }, lines: st.bankLines.slice(1), closing: { label: "Adjusted bank balance", total: st.adjustedBank } },
      { opening: { label: st.ledgerLines[0].label, total: st.ledgerLines[0].total }, lines: st.ledgerLines.slice(1), closing: { label: "Adjusted ledger balance", total: st.adjustedLedger } },
    ],
    [{ label: "Difference (should be nil)", total: st.difference }],
    a,
    b,
    ["Ledger", "Bank"],
  );
}

/** Proposed adjusting entries: one row per journal line. */
export function adjustmentsSheet(entries: AdjEntry[], a: RecRecord[], b: RecRecord[]): ReconSheet {
  const c = { n: [] as number[], date: [] as Array<number | undefined>, account: [] as string[], dr: [] as Array<number | null>, cr: [] as Array<number | null>, narr: [] as string[], rule: [] as string[], src: [] as string[] };
  for (const e of entries) {
    e.lines.forEach((l, k) => {
      c.n.push(e.n);
      c.date.push(e.date);
      c.account.push(l.account);
      c.dr.push(l.debit || null);
      c.cr.push(l.credit || null);
      c.narr.push(k ? "" : e.narrative);
      c.rule.push(k ? "" : (e.rule ?? "no rule: suspense"));
      c.src.push(k ? "" : [e.item.a.length ? `ledger row ${rowsOf(a, e.item.a)}` : "", e.item.b.length ? `bank row ${rowsOf(b, e.item.b)}` : ""].filter(Boolean).join("; "));
    });
  }
  return {
    name: "Adjusting entries",
    columns: [numCol("Entry", c.n), numCol("Date", c.date), textCol("Account", c.account), numCol("Debit", c.dr), numCol("Credit", c.cr), textCol("Narrative", c.narr), textCol("Rule", c.rule), textCol("Source", c.src)],
    numFmts: ["", DATE, "", MONEY, MONEY, "", "", ""],
  };
}

const STATUS_LABEL = { cleared: "Cleared", differs: "Cleared, amount differs", open: "Still open" } as const;

/** Last period's outstanding items with what happened to each. */
export function rollSheet(roll: OutstandingRoll, prior: RecRecord[], current: RecRecord[]): ReconSheet {
  const it = roll.items;
  return {
    name: "Outstanding roll-forward",
    columns: [
      numCol("Sheet row", it.map((x) => prior[x.index].row)),
      textCol("Reference", it.map((x) => prior[x.index].key ?? "")),
      numCol("Date", it.map((x) => prior[x.index].date)),
      numCol("Amount", it.map((x) => prior[x.index].amount)),
      textCol("Description", it.map((x) => prior[x.index].text ?? "")),
      textCol("Status", it.map((x) => STATUS_LABEL[x.status])),
      numCol("Cleared on", it.map((x) => x.clearedDate)),
      numCol("Days to clear", it.map((x) => x.daysToClear)),
      textCol("Cleared by rows", it.map((x) => rowsOf(current, x.clearedBy))),
      numCol("Age (days)", it.map((x) => x.age)),
      textCol("Ageing bucket", it.map((x) => x.bucket)),
      textCol("Note", it.map((x) => x.note)),
    ],
    numFmts: ["", "", DATE, MONEY, "", "", DATE, "", "", "", "", ""],
  };
}

export const OPEN_RULE_LABEL: Record<OpenItemRule, string> = { ...(RULE_LABEL as Record<RecRule, string>), "one-to-many": "One debit = sum of several credits", "many-to-one": "Several debits = one credit", "reference group": "One reference nets to zero", zero: "Zero amount" };

/** Open items and cleared groups as two sheets. */
export function openItemSheets(res: OpenItemResult, recs: OpenItemRecord[]): ReconSheet[] {
  const o = res.open;
  const open: ReconSheet = {
    name: "Open items",
    columns: [
      textCol("Party", o.map((x) => x.party)),
      numCol("Sheet row", o.map((x) => recs[x.index].row)),
      textCol("Reference", o.map((x) => recs[x.index].key ?? "")),
      numCol("Date", o.map((x) => recs[x.index].date)),
      numCol("Amount", o.map((x) => recs[x.index].amount)),
      textCol("Description", o.map((x) => recs[x.index].text ?? "")),
      numCol("Age (days)", o.map((x) => x.age)),
      textCol("Ageing bucket", o.map((x) => x.bucket)),
      textCol("Note", o.map((x) => x.note)),
    ],
    numFmts: ["", "", "", DATE, MONEY, "", "", "", ""],
  };
  const c = { g: [] as number[], rule: [] as string[], party: [] as string[], row: [] as number[], key: [] as string[], date: [] as Array<number | undefined>, amt: [] as Array<number | undefined>, text: [] as string[], on: [] as Array<number | null>, net: [] as Array<number | null> };
  for (const g of res.groups) {
    g.items.forEach((i, k) => {
      c.g.push(g.n);
      c.rule.push(k ? "" : OPEN_RULE_LABEL[g.rule]);
      c.party.push(g.party);
      c.row.push(recs[i].row);
      c.key.push(recs[i].key ?? "");
      c.date.push(recs[i].date);
      c.amt.push(recs[i].amount);
      c.text.push(recs[i].text ?? "");
      c.on.push(k ? null : g.date);
      c.net.push(k ? null : g.net);
    });
  }
  const cleared: ReconSheet = {
    name: "Cleared items",
    columns: [numCol("Group", c.g), textCol("Rule", c.rule), textCol("Party", c.party), numCol("Sheet row", c.row), textCol("Reference", c.key), numCol("Date", c.date), numCol("Amount", c.amt), textCol("Description", c.text), numCol("Cleared on", c.on), numCol("Group net", c.net)],
    numFmts: ["", "", "", "", "", DATE, MONEY, "", DATE, MONEY],
  };
  return [open, cleared];
}

/** The supplier / customer statement rec and the matched items. */
export function statementRecSheets(res: StatementRecResult, ours: StatementRecRecord[], theirs: StatementRecRecord[]): ReconSheet[] {
  const st = linesSheet(
    "Statement rec",
    [{ opening: { label: "Balance per their statement", total: res.theirBalance }, lines: res.lines, closing: { label: "Balance per our ledger (calculated)", total: res.computedOurs } }],
    [
      { label: "Balance per our ledger (stated)", total: res.ourBalance },
      { label: "Unexplained difference", total: res.difference },
    ],
    ours,
    theirs,
    ["Our", "Their"],
  );
  const matched = { ...reconSheets(res.rec, ours, theirs)[0], name: "Statement rec matched" };
  return [st, matched];
}

// ------------------------------------------- the bank rec in the workbook --

/** One line for the bank rec template's Outstanding sheet. */
export interface OutstandingRow {
  kind: OutstandingKind;
  /** date serial, or undefined */
  date?: number;
  description: string;
  /** as the Rec sheet wants it: deposits in transit and outstanding payments positive, the rest signed as they change their side */
  amount: number;
}

/** An error's note, short enough for a cell: "posted twice", "ledger 4,725.00, bank 4,752.00". */
const shortNote = (it: RecItem): string => (it.duplicate ? "posted twice" : (/ledger [^,]+, bank [^:]+/.exec(it.note)?.[0] ?? it.note));

const describeItem = (it: RecItem, a: RecRecord[], b: RecRecord[], withNote: boolean): string => {
  const first = it.a.length ? a[it.a[0]] : b[it.b[0]];
  const base = [first?.key ?? "", first?.text ?? ""].filter(Boolean).join(" ");
  return withNote && it.note ? `${base}${base ? ": " : ""}${shortNote(it)}` : base || it.note;
};

/**
 * Every reconciling item of a bank rec statement as a line for the
 * Outstanding sheet, with its kind. Listing these makes the Rec sheet's
 * difference the statement's difference (nil when it reconciles). Pure.
 */
export function outstandingRows(st: RecStatement, a: RecRecord[], b: RecRecord[]): OutstandingRow[] {
  const out: OutstandingRow[] = [];
  const add = (kind: OutstandingKind, items: RecItem[], sign: 1 | -1, withNote = false) => {
    for (const it of items) {
      const first = it.a.length ? a[it.a[0]] : b[it.b[0]];
      out.push({ kind, date: first?.date, description: describeItem(it, a, b, withNote), amount: Math.round(sign * it.value * 100) / 100 });
    }
  };
  const line = (lines: RecLine[], id: string) => lines.find((l) => l.id === id)?.items ?? [];
  add("Deposit in transit", line(st.bankLines, "dit"), 1);
  add("Outstanding payment", line(st.bankLines, "outstanding"), -1);
  add("Bank error", line(st.bankLines, "bankErrors"), 1, true);
  add("Bank only (fee, interest)", [...line(st.ledgerLines, "bankReceipts"), ...line(st.ledgerLines, "bankPayments")], 1);
  add("Ledger error", line(st.ledgerLines, "ledgerErrors"), 1, true);
  return out;
}

/** The template's Rec sheet (labels in A, figures in B) and its Outstanding sheet, when the workbook has them. */
export interface RecTargets {
  rec: Sheet | null;
  outstanding: Sheet | null;
  /** the closing balances already on the Rec sheet */
  bankBalance: number | null;
  ledgerBalance: number | null;
  /** 0-based row of "Balance per bank statement" on the Rec sheet */
  bankRow: number;
}

const BANK_LABEL = /^balance per (the )?bank( statement)?\b/i;
const LEDGER_LABEL = /^balance per (the )?(cash ?book|ledger|books|gl)\b/i;

/** Find the Rec and Outstanding sheets and the balances on Rec (by their labels, so a renamed or hand-built sheet works too). */
export function recTargets(wb: Workbook): RecTargets {
  let rec: Sheet | null = null;
  let bankBalance: number | null = null;
  let ledgerBalance: number | null = null;
  let bankRow = -1;
  for (const s of wb.sheets) {
    const src = s.source;
    const rows = Math.min(src.rowCount, 60);
    let bank = -1;
    let ledger = -1;
    for (let r = 0; r < rows; r++) {
      const label = src.getCell(r, 0);
      if (typeof label !== "string") continue;
      if (bank < 0 && BANK_LABEL.test(label.trim())) bank = r;
      else if (ledger < 0 && LEDGER_LABEL.test(label.trim())) ledger = r;
    }
    if (bank < 0 || ledger < 0) continue;
    rec = s;
    bankRow = bank;
    const num = (r: number) => {
      const v = src.getCell(r, 1);
      return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
    };
    bankBalance = num(bank);
    ledgerBalance = num(ledger);
    break;
  }
  const outstanding =
    wb.sheets.find((s) => {
      const src = s.source;
      const h = [0, 1, 2, 3].map((c) => String(src.getCell(0, c) ?? "").trim().toLowerCase());
      return h[0] === "kind" && h[3] === "amount";
    }) ?? null;
  return { rec, outstanding, bankBalance, ledgerBalance, bankRow };
}

/**
 * The cells that put these lines on the Outstanding sheet in place of what's
 * there (rows below the header; old rows past the new ones are emptied).
 * Throws when the sheet is too short. Pure.
 */
export function outstandingCells(rows: OutstandingRow[], sheet: Pick<EditableSource, "rowCount" | "getCell">): { row: number; col: number; input: string | null }[] {
  if (rows.length + 1 > sheet.rowCount) throw new Error(`Outstanding has room for ${sheet.rowCount - 1} items; this rec has ${rows.length}. Insert rows on it first.`);
  let used = 1;
  for (let r = 1; r < sheet.rowCount; r++) if ([0, 1, 2, 3].some((c) => sheet.getCell(r, c) !== null && sheet.getCell(r, c) !== "")) used = r + 1;
  const cells: { row: number; col: number; input: string | null }[] = [];
  rows.forEach((x, i) => {
    const row = i + 1;
    cells.push(
      { row, col: 0, input: x.kind },
      { row, col: 1, input: x.date !== undefined && Number.isFinite(x.date) ? dateText(x.date) : null },
      { row, col: 2, input: x.description.startsWith("=") ? `'${x.description}` : x.description || null },
      { row, col: 3, input: x.amount.toFixed(2) },
    );
  });
  for (let row = rows.length + 1; row < used; row++) for (let col = 0; col < 4; col++) cells.push({ row, col, input: null });
  return cells;
}

/** What the bank rec statement needs to run, as the dialog sets it up. */
export interface BankRecInput {
  ledger: EditableSource;
  bank: EditableSource;
  ledgerMap: ReconMap;
  bankMap: ReconMap;
  bankBalance: number;
  ledgerBalance: number;
  amountTolerance?: number;
  dateWindow?: number | null;
  flipB?: boolean;
  errorsOn?: "ledger" | "bank";
  bankAccount?: string;
}

/** Reconcile, set out the statement and propose the entries. Pure apart from reading the sheets. */
export function prepareBankRec(x: BankRecInput): { st: RecStatement; entries: AdjEntry[]; a: RecRecord[]; b: RecRecord[]; bad: number; rows: OutstandingRow[] } {
  const A = readSide(x.ledger, x.ledgerMap);
  const B = readSide(x.bank, x.bankMap);
  const settings = { amountTolerance: x.amountTolerance ?? 0, dateWindow: x.dateWindow === undefined ? 3 : x.dateWindow, flipB: !!x.flipB };
  const r = reconcile(A.records, B.records, settings);
  const st = recStatement(r, A.records, B.records, { bankBalance: x.bankBalance, ledgerBalance: x.ledgerBalance, flipB: settings.flipB, errorsOn: x.errorsOn ?? "ledger" });
  const entries = proposeAdjustments(st, A.records, B.records, { bankAccount: x.bankAccount?.trim() || "Bank" });
  return { st, entries, a: A.records, b: B.records, bad: A.bad + B.bad, rows: outstandingRows(st, A.records, B.records) };
}

// ------------------------------------------------------------- dialog --

interface KindInfo {
  title: string;
  subtitle: string;
  sides: [string] | [string, string];
  /** what each side card calls itself */
  sideTitles: [string] | [string, string];
  extra?: { role: "party" | "type"; label: string; re: RegExp };
}

const KINDS: Record<OpenItemsKind, KindInfo> = {
  bankstatement: {
    title: "Bank rec statement",
    subtitle: "Balance per bank and per ledger, taken to the same figure through the reconciling items, with the entries the ledger needs",
    sides: ["Ledger (cash book)", "Bank statement"],
    sideTitles: ["Your cash book", "The bank statement"],
  },
  rollforward: {
    title: "Roll forward outstanding items",
    subtitle: "Which of last period's outstanding items cleared this period, when, and which are still open",
    sides: ["Last period's outstanding items", "This period's data"],
    sideTitles: ["Last period's outstanding items", "This period's data"],
  },
  openitems: {
    title: "Open-item matching (one account)",
    subtitle: "Clear the debits and credits of one account (suspense, clearing, AR / AP control) against each other within each party",
    sides: ["Account"],
    sideTitles: ["The account"],
    extra: { role: "party", label: "Party (match within)", re: PARTY_RE },
  },
  statementrec: {
    title: "Supplier / customer statement rec",
    subtitle: "Your ledger for one supplier or customer against their statement: missing invoices, credit notes, payments in transit",
    sides: ["Our ledger", "Their statement"],
    sideTitles: ["Your ledger", "Their statement"],
    extra: { role: "type", label: "Document type", re: TYPE_RE },
  },
};

const ROLE_LABEL: Record<ReconRole, string> = { key: "Reference", amount: "Amount", minus: "Credit column", date: "Date", text: "Description" };
const ROLE_SHORT: Record<ReconRole, string> = { key: "Ref", amount: "Amount", minus: "Credit", date: "Date", text: "Text" };
const money = (n: number) => formatCell(n, "amount", "en-US");

type StatementRow = { label: string; n?: number; total: number; strong?: boolean };

export function openOpenItems(kind: OpenItemsKind, d: OpenItemsDeps): void {
  const info = KINDS[kind];
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  const two = info.sides.length === 2;
  if (two && visible.length < 2) {
    needTwoSheets(info.title, info.title);
    return;
  }
  const active = d.activeSheet();
  const withAmounts = visible.map((s) => ({ id: s.id, name: s.name, amounts: guessMap(s.source).amount >= 0 && dataRows(s.source) > 1 }));
  const ids: string[] = two ? pickSides(withAmounts, active) : [withAmounts.find((s) => s.id === active && s.amounts)?.id ?? withAmounts.find((s) => s.amounts)?.id ?? active];
  const maps: ReconMap[] = ids.map((id) => guessMap(wb.get(id).source));
  const extraCol: number[] = ids.map((id, k) => (info.extra ? guessExtra(sheetHeader(wb.get(id).source).names, info.extra.re, maps[k]) : -1));
  const targets = kind === "bankstatement" ? recTargets(wb) : null;

  const dlg = toolDialog({ title: info.title, subtitle: info.subtitle, size: two ? "xl" : "lg", closeLabel: "Cancel", className: "oi-dialog", onClose: () => d.focusGrid() });
  const body = dlg.body;
  let timer = 0;
  const changed = () => {
    clearTimeout(timer);
    timer = window.setTimeout(runIt, 250);
  };

  // ---- the sides: a card per sheet, with its columns and first rows
  const sideCard = (k: number) => {
    const card = el("section", { className: "rc-side" });
    const draw = () => {
      const id = ids[k];
      const src = wb.get(id).source;
      const { names, first } = sheetHeader(src);
      const rows = Math.max(0, dataRows(src) - first);
      const sheetSel = el("select");
      sheetSel.setAttribute("aria-label", `Sheet for ${info.sides[k]}`);
      for (const s of visible) sheetSel.append(new Option(s.name, s.id, false, s.id === id));
      sheetSel.addEventListener("change", () => {
        ids[k] = sheetSel.value;
        maps[k] = guessMap(wb.get(ids[k]).source);
        extraCol[k] = info.extra ? guessExtra(sheetHeader(wb.get(ids[k]).source).names, info.extra.re, maps[k]) : -1;
        draw();
        changed();
      });
      const roles = el("div", { className: "rc-roles" });
      const makePreview = () => {
        const m = new Map<number, string>();
        for (const role of RECON_ROLES) if (maps[k][role] >= 0) m.set(maps[k][role], m.has(maps[k][role]) ? `${m.get(maps[k][role])} · ${ROLE_SHORT[role]}` : ROLE_SHORT[role]);
        if (extraCol[k] >= 0) m.set(extraCol[k], info.extra!.role === "party" ? "Party" : "Type");
        return sidePreview(src, m, 4);
      };
      let preview = makePreview();
      const colSelect = (label: string, get: () => number, set: (c: number) => void, none = "(none)") => {
        const sel = el("select");
        sel.setAttribute("aria-label", `${label} column in ${wb.get(id).name}`);
        sel.append(new Option(none, "-1", false, get() < 0));
        names.forEach((n, c) => sel.append(new Option(n, String(c), false, get() === c)));
        sel.addEventListener("change", () => {
          set(Number(sel.value));
          preview.replaceWith((preview = makePreview()));
          changed();
        });
        roles.append(field(label, sel));
      };
      for (const role of RECON_ROLES) colSelect(ROLE_LABEL[role], () => maps[k][role], (c) => (maps[k][role] = c), role === "minus" ? "(not separate)" : "(none)");
      if (info.extra) colSelect(info.extra.label, () => extraCol[k], (c) => (extraCol[k] = c));
      card.replaceChildren(
        el(
          "header",
          { className: "rc-side__head" },
          el("span", { className: `rc-side__badge rc-side__badge--${k ? "b" : "a"}`, textContent: k ? "B" : "A" }),
          el("div", { className: "rc-side__titles" }, el("strong", { textContent: info.sideTitles[k] }), el("span", { className: "tk-muted", textContent: plural(rows, "row") })),
          sheetSel,
        ),
        roles,
        preview,
      );
    };
    draw();
    return card;
  };
  const sides = two ? el("div", { className: "rc-sides" }, sideCard(0), el("div", { className: "rc-vs", textContent: "⇄" }), sideCard(1)) : sideCard(0);

  // ---- balances and settings
  const input = (value: string, label: string, mode = "decimal", placeholder = "") => {
    const i = el("input", { type: "text", value, inputMode: mode, placeholder });
    i.setAttribute("aria-label", label);
    i.addEventListener("input", changed);
    return i;
  };
  const check = (label: string, value: boolean) => {
    const box = el("input", { type: "checkbox", checked: value });
    box.addEventListener("change", changed);
    return { label: el("label", { className: "tk-check" }, box, label), box };
  };
  const read = (k: number) => {
    const src = wb.get(ids[k]).source;
    const side = readSide(src, maps[k]);
    return { ...side, extra: readExtra(src, side.records, extraCol[k]) };
  };
  const amountText = (n: number | null | undefined) => (n === null || n === undefined ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const tol = input("0", "Amount tolerance");
  const win = input(kind === "statementrec" ? "7" : kind === "bankstatement" ? "3" : "", "Date window in days", "numeric", "any date");
  const settings = el("div", { className: "oi-fields" });
  let bankBal: HTMLInputElement | null = null;
  let ledgerBal: HTMLInputElement | null = null;
  let bankAcct: HTMLInputElement | null = null;
  let errorsOn: HTMLSelectElement | null = null;
  let asOf: HTMLInputElement | null = null;
  let limits: HTMLInputElement | null = null;
  let staleDays: HTMLInputElement | null = null;
  let stmtDate: HTMLInputElement | null = null;
  let flip: ReturnType<typeof check> | null = null;
  let invPos: ReturnType<typeof check> | null = null;
  const guessDates = () => dateText(latestDate(...ids.map((_, k) => read(k).records)));
  const checks = el("div", { className: "oi-checks" });
  if (kind === "bankstatement") {
    const fromRec = targets?.rec ? `From ${targets.rec.name}` : undefined;
    bankBal = input(amountText(targets?.bankBalance), "Bank statement closing balance");
    ledgerBal = input(amountText(targets?.ledgerBalance), "Ledger closing balance");
    bankAcct = input("Bank", "Bank account name", "text");
    errorsOn = el("select");
    errorsOn.append(new Option("The ledger's", "ledger", true, true), new Option("The bank's", "bank"));
    errorsOn.setAttribute("aria-label", "Who made the errors");
    errorsOn.addEventListener("change", changed);
    settings.append(
      field("Bank statement closing balance", bankBal, targets?.bankBalance !== null && targets?.bankBalance !== undefined ? fromRec : "From the last page of the statement; overdrawn is negative"),
      field("Ledger closing balance", ledgerBal, targets?.ledgerBalance !== null && targets?.ledgerBalance !== undefined ? fromRec : "The bank account's balance in the GL"),
      field("Errors are", errorsOn, "Keying errors and duplicate postings"),
      field("Bank account (for the entries)", bankAcct),
      field("Date window (± days)", win, "Blank ignores dates"),
      field("Amount tolerance", tol),
    );
    flip = check("Bank amounts have the opposite sign to the ledger", false);
    checks.append(flip.label);
  } else if (kind === "rollforward" || kind === "openitems") {
    asOf = input(guessDates(), "Age to (as-of date)", "text", "yyyy-mm-dd");
    limits = input("30, 60, 90", "Ageing buckets", "text");
    settings.append(field("Age to (as-of date)", asOf, "yyyy-mm-dd"), field("Ageing buckets (days)", limits, "Comma separated"), field("Date window (± days)", win, "Blank ignores dates"), field("Amount tolerance", tol));
    if (kind === "rollforward") {
      staleDays = input("180", "Stale after days", "numeric");
      settings.append(field("Stale after (days)", staleDays, "Flagged to write back"));
      flip = check("This period's amounts have the opposite sign", false);
      checks.append(flip.label);
    }
  } else {
    const g = guessStatementSigns(read(0).records, read(1).records);
    ledgerBal = input("", "Our ledger balance", "decimal", "added up");
    bankBal = input("", "Their statement balance", "decimal", "added up");
    stmtDate = input("", "Their statement date", "text", "optional");
    settings.append(field("Our ledger balance", ledgerBal, "Blank: our items added up"), field("Their statement balance", bankBal, "Blank: added up"), field("Their statement date", stmtDate, "For cut-off notes"), field("Date window (± days)", win), field("Amount tolerance", tol));
    flip = check("Their amounts have the opposite sign to ours", g.flipTheirs);
    invPos = check("Invoices are positive in our ledger", g.invoicesPositive);
    checks.append(flip.label, invPos.label);
  }

  const result = el("div", { className: "oi-result" });
  result.setAttribute("aria-live", "polite");
  // settings on the left, the result beside them, so the figure that matters is in view
  body.append(section("Sheets and columns", sides), el("div", { className: "oi-lower" }, section(kind === "bankstatement" ? "Balances and settings" : "Settings", settings, checks.childElementCount ? checks : null), section("Result", result)));

  // ---- footer: one primary action
  const fill = targets?.outstanding ? dlg.button(`Fill ${targets.outstanding.name}${targets.rec ? ` and ${targets.rec.name}` : ""}`, () => fillTemplate(), { kind: "primary", disabled: true, title: "Put each reconciling item on the Outstanding sheet with its kind, so the Rec sheet ties" }) : null;
  const addBtn = dlg.button("Create results sheets", () => addSheets(), { kind: fill ? "secondary" : "primary", disabled: true });

  let sheets: ReconSheet[] | null = null;
  let rec: ReturnType<typeof prepareBankRec> | null = null;
  let doneText = "";
  const waiting = (t: string) => {
    sheets = null;
    rec = null;
    addBtn.disabled = true;
    if (fill) fill.disabled = true;
    result.replaceChildren(notice(t, "info"));
  };

  const statementTable = (rows: StatementRow[]) => {
    const t = renderTable<StatementRow>({
      columns: [
        { key: "label", label: "Line" },
        { key: "n", label: "Items", format: (v) => (v ? String(v) : ""), align: "right", width: "5em" },
        { key: "total", label: "Amount", format: "amount", width: "10em" },
      ],
      rows,
      dense: true,
    });
    t.table.querySelectorAll("tbody tr").forEach((tr, i) => rows[i]?.strong && tr.classList.add("oi-strong"));
    return t.element;
  };

  function runIt() {
    if (two && ids[0] === ids[1]) return waiting("Pick two different sheets.");
    for (let k = 0; k < ids.length; k++) if (maps[k].amount < 0) return waiting(`Pick the amount column for ${wb.get(ids[k]).name}.`);
    const tolV = Math.max(0, parseAmountInput(tol.value) ?? 0);
    const winV = win.value.trim() === "" ? null : Math.max(0, Math.floor(Number(win.value) || 0));
    const kids: Node[] = [];
    let bad = 0;
    if (kind === "bankstatement") {
      const bb = parseAmountInput(bankBal!.value);
      const lb = parseAmountInput(ledgerBal!.value);
      if (bb === null || lb === null) return waiting(bb === null && lb === null ? "Type both closing balances to set out the statement." : `Type the ${bb === null ? "bank statement's" : "ledger's"} closing balance.`);
      const x = prepareBankRec({ ledger: wb.get(ids[0]).source, bank: wb.get(ids[1]).source, ledgerMap: maps[0], bankMap: maps[1], bankBalance: bb, ledgerBalance: lb, amountTolerance: tolV, dateWindow: winV, flipB: flip?.box.checked, errorsOn: errorsOn!.value as "ledger" | "bank", bankAccount: bankAcct!.value });
      rec = x;
      bad = x.bad;
      const { st, entries, a, b } = x;
      sheets = [bankStatementSheet(st, a, b), adjustmentsSheet(entries, a, b)];
      kids.push(
        headline({
          value: money(st.difference),
          unit: "unexplained difference",
          tone: st.difference ? "mismatch" : "match",
          caption: st.difference ? "Bank and ledger don't agree yet after the reconciling items: check the closing balances, and that both sheets cover the same period." : `Bank and ledger agree at ${money(st.adjustedBank)} after ${plural(x.rows.length, "reconciling item")}.`,
          lines: [
            { label: "Adjusted bank balance", value: money(st.adjustedBank) },
            { label: "Adjusted ledger balance", value: money(st.adjustedLedger) },
            { label: "Adjusting entries proposed", value: String(entries.length) },
          ],
        }),
      );
      const rows: StatementRow[] = [];
      for (const l of st.bankLines) rows.push({ label: l.label, n: l.items.length, total: l.total });
      rows.push({ label: "Adjusted bank balance", total: st.adjustedBank, strong: true });
      for (const l of st.ledgerLines) rows.push({ label: l.label, n: l.items.length, total: l.total });
      rows.push({ label: "Adjusted ledger balance", total: st.adjustedLedger, strong: true }, { label: "Difference", total: st.difference, strong: true });
      kids.push(section("Statement", statementTable(rows)));
      if (x.rows.length) {
        const t = renderTable<OutstandingRow>({
          columns: [
            { key: "kind", label: "Kind" },
            { key: "date", label: "Date", format: "date", width: "6.5em" },
            { key: "description", label: "Description" },
            { key: "amount", label: "Amount", format: "amount", width: "8em" },
          ],
          rows: x.rows,
          dense: true,
          maxHeight: "32vh",
        });
        t.table.classList.add("oi-items");
        kids.push(section(targets?.outstanding ? `Reconciling items (for ${targets.outstanding.name})` : "Reconciling items", t.element));
      }
      if (targets?.outstanding && fill) {
        const has = dataRows(targets.outstanding.source) > 1;
        kids.push(notice(`"${fill.textContent}" puts these ${plural(x.rows.length, "item")} on ${targets.outstanding.name} with their kinds${has ? ", in place of what's there now" : ""}${targets.rec ? `. ${targets.rec.name} then shows this difference: ${money(st.difference)}` : ""}.`, "info"));
      }
      doneText = `Bank rec: difference ${money(st.difference)}, ${plural(entries.length, "adjusting entry", "adjusting entries")}`;
    } else {
      const sidesData = ids.map((_, k) => read(k));
      bad = sidesData.reduce((t, s) => t + s.bad, 0);
      const settingsV = { amountTolerance: tolV, dateWindow: winV, flipB: flip?.box.checked ?? false };
      if (kind === "rollforward") {
        const at = parseDateInput(asOf!.value);
        if (at === null) return waiting("Type the as-of date (yyyy-mm-dd).");
        const [a, b] = [sidesData[0].records, sidesData[1].records];
        const roll = rollOutstanding(a, b, { asOf: at, settings: settingsV, limits: parseLimits(limits!.value), staleDays: Math.max(0, Number(staleDays!.value) || 180) });
        sheets = [rollSheet(roll, a, b)];
        const s = roll.summary;
        kids.push(headline({ value: String(s.open), unit: s.open === 1 ? "item still open" : "items still open", tone: s.open ? "unmatched" : "match", caption: `${s.cleared} of ${s.broughtForward} brought forward cleared this period; still open: ${money(s.openTotal)}${s.stale ? `, of which ${s.stale} stale` : ""}.` }));
        kids.push(
          statementTable([
            { label: "Brought forward", n: s.broughtForward, total: s.broughtForwardTotal },
            { label: "Cleared", n: s.cleared, total: s.clearedTotal },
            { label: "Cleared, amount differs", n: s.differs, total: s.differsTotal },
            { label: "Still open", n: s.open, total: s.openTotal },
            { label: "Of which stale", n: s.stale, total: s.staleTotal },
          ]),
        );
        if (roll.buckets.length) kids.push(section("Ageing", statementTable(roll.buckets.filter((x) => x.count).map((x) => ({ label: `${x.label} days`, n: x.count, total: x.total })))));
        if (roll.usedCurrent.length) kids.push(el("p", { className: "tk-muted", textContent: `${plural(roll.usedCurrent.length, "item")} in this period's data cleared last period's; leave them out of this period's rec.` }));
        doneText = `Roll-forward: ${s.cleared} cleared, ${s.open} still open (${money(s.openTotal)})`;
      } else if (kind === "openitems") {
        const at = parseDateInput(asOf!.value) ?? undefined;
        const recs: OpenItemRecord[] = sidesData[0].records.map((r, i) => (sidesData[0].extra[i] ? { ...r, party: sidesData[0].extra[i] } : r));
        const res = matchOpenItems(recs, { asOf: at, limits: parseLimits(limits!.value), settings: { amountTolerance: tolV, dateWindow: winV } });
        sheets = openItemSheets(res, recs);
        const s = res.summary;
        kids.push(headline({ value: money(s.openTotal), unit: "open", tone: s.openCount ? "unmatched" : "match", caption: `${plural(s.openCount, "open item")} across ${plural(s.openParties, "party", "parties")}; ${s.clearedCount} cleared in ${plural(res.groups.length, "group")}.` }));
        kids.push(
          statementTable([
            { label: "Account balance", n: s.count, total: s.balance },
            { label: `Cleared (in ${plural(res.groups.length, "group")})`, n: s.clearedCount, total: s.clearedNet },
            { label: `Open (${s.openParties} of ${plural(s.parties, "party", "parties")})`, n: s.openCount, total: s.openTotal },
          ]),
        );
        if (res.buckets.length) kids.push(section("Ageing", statementTable(res.buckets.filter((x) => x.count).map((x) => ({ label: `${x.label} days`, n: x.count, total: x.total })))));
        doneText = `Open items: ${s.openCount} open (${money(s.openTotal)}), ${s.clearedCount} cleared`;
      } else {
        const ours: StatementRecRecord[] = sidesData[0].records.map((r, i) => (sidesData[0].extra[i] ? { ...r, type: sidesData[0].extra[i] } : r));
        const theirs: StatementRecRecord[] = sidesData[1].records.map((r, i) => (sidesData[1].extra[i] ? { ...r, type: sidesData[1].extra[i] } : r));
        const res = statementRec(ours, theirs, {
          flipTheirs: flip!.box.checked,
          invoicesPositive: invPos!.box.checked,
          ourBalance: parseAmountInput(ledgerBal!.value) ?? undefined,
          theirBalance: parseAmountInput(bankBal!.value) ?? undefined,
          statementDate: parseDateInput(stmtDate!.value) ?? undefined,
          settings: { amountTolerance: tolV, dateWindow: winV },
        });
        sheets = statementRecSheets(res, ours, theirs);
        const rows: StatementRow[] = [{ label: "Balance per their statement", total: res.theirBalance }];
        for (const l of res.lines) if (l.items.length) rows.push({ label: l.label, n: l.items.length, total: l.total });
        rows.push({ label: "Balance per our ledger (calculated)", total: res.computedOurs }, { label: "Balance per our ledger (stated)", total: res.ourBalance }, { label: "Unexplained difference", total: res.difference, strong: true });
        kids.push(headline({ value: money(res.difference), unit: "unexplained difference", tone: res.difference ? "mismatch" : "match", caption: res.difference ? "Their statement and our ledger don't agree after the explained items below." : "Their statement agrees with our ledger once the items below are explained." }));
        kids.push(section("Statement", statementTable(rows)), el("p", { className: "tk-muted", textContent: `${plural(res.rec.matches.length, "matched group")}. Amounts are shown with invoices positive.` }));
        doneText = `Statement rec: unexplained difference ${money(res.difference)}`;
      }
    }
    if (bad) kids.push(notice(`${plural(bad, "value")} couldn't be read as an amount or a date and ${bad === 1 ? "was" : "were"} left blank.`, "warning"));
    result.replaceChildren(...kids);
    addBtn.disabled = false;
    if (fill) fill.disabled = !rec;
  }

  const addSheets = async () => {
    if (!sheets) return;
    const out = sheets;
    dlg.close();
    for (const s of out) {
      const source = new EditableSource(new Table(s.columns), 10);
      await d.run({ type: "sheet.insert", params: { name: s.name, source: d.putBlob(source), numFmts: s.numFmts } });
    }
    report(d.status, doneText);
  };

  const fillTemplate = async () => {
    if (!rec || !targets?.outstanding) return;
    const cells = outstandingCells(rec.rows, targets.outstanding.source);
    const bb = parseAmountInput(bankBal!.value);
    const diff = rec.st.difference;
    const n = rec.rows.length;
    dlg.close();
    await d.run(setCells(cells, `fill ${targets.outstanding.name} from the bank rec`, targets.outstanding.id));
    if (targets.rec && bb !== null && targets.bankRow >= 0 && targets.bankBalance !== bb) await d.run(setCells([{ row: targets.bankRow, col: 1, input: bb.toFixed(2) }], `bank balance on ${targets.rec.name}`, targets.rec.id));
    report(d.status, `${targets.outstanding.name}: ${plural(n, "reconciling item")} filled in. ${targets.rec ? `${targets.rec.name} difference: ${money(diff)}` : `Difference: ${money(diff)}`}`, diff ? "warning" : "success");
  };

  runIt();
  const focus = fill && !fill.disabled ? fill : !addBtn.disabled ? addBtn : (bankBal ?? (body.querySelector("select") as HTMLElement | null));
  focus?.focus();
}
