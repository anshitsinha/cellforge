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
import { proposeAdjustments, recStatement, type AdjEntry, type RecLine, type RecStatement } from "../../../packages/core/src/recon/statement";
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
} from "../../../packages/core/src/recon/openitems";
import { EditableSource } from "./editable";
import { guessMap, readSide, reconSheets, RECON_ROLES, RULE_LABEL, sheetHeader, type ReconMap, type ReconRole, type ReconSheet } from "./recondialog";
import type { Workbook } from "./workbook";

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

// ------------------------------------------------------------- dialog --

interface KindInfo {
  title: string;
  intro: string;
  sides: [string] | [string, string];
  extra?: { role: "party" | "type"; label: string; re: RegExp };
}

const KINDS: Record<OpenItemsKind, KindInfo> = {
  bankstatement: {
    title: "Bank rec statement",
    intro: "Matches the ledger against the bank statement, then sets out balance per bank ± deposits in transit, outstanding payments and errors against balance per ledger ± items only on the bank, and proposes the adjusting entries. Amounts are in the ledger's sign: money in positive.",
    sides: ["Ledger (cash book)", "Bank statement"],
  },
  rollforward: {
    title: "Roll forward outstanding items",
    intro: "Takes last period's outstanding items (deposits in transit, unpresented cheques...) and finds which cleared in this period's data, when, and which are still open, with their age.",
    sides: ["Last period's outstanding items", "This period's data"],
  },
  openitems: {
    title: "Open-item matching (one account)",
    intro: "Clears the debits and credits of one account (suspense, clearing, AR / AP control) against each other within each party: reference groups that net to zero, then same reference, amount, and one against a sum of several. What's left is open, aged.",
    sides: ["Account"],
    extra: { role: "party", label: "Party (match within)", re: PARTY_RE },
  },
  statementrec: {
    title: "Supplier / customer statement rec",
    intro: "Our ledger for one supplier or customer against their statement: matched by document number first, then by amount and date. The differences are sorted into missing invoices, credit notes not booked, payments in transit and amount differences.",
    sides: ["Our ledger", "Their statement"],
    extra: { role: "type", label: "Document type", re: TYPE_RE },
  },
};

const ROLE_LABEL: Record<ReconRole, string> = { key: "Reference", amount: "Amount", minus: "Minus column (credits)", date: "Date", text: "Description" };
const money = (n: number) => formatValue(n, MONEY).text;

export function openOpenItems(kind: OpenItemsKind, d: OpenItemsDeps): void {
  const info = KINDS[kind];
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  const two = info.sides.length === 2;
  if (two && visible.length < 2) {
    d.status(`${info.title} needs two sheets: put the other side in a second sheet first.`);
    return;
  }
  const active = d.activeSheet();
  const ids: string[] = [visible.some((s) => s.id === active) ? active : visible[0].id];
  if (two) ids.push(visible.find((s) => s.id !== ids[0])!.id);
  const maps: ReconMap[] = ids.map((id) => guessMap(wb.get(id).source));
  const extraCol: number[] = ids.map((id, k) => (info.extra ? guessExtra(sheetHeader(wb.get(id).source).names, info.extra.re, maps[k]) : -1));

  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog recon-dialog openitems-dialog" role="dialog"><div class="palette-form"></div></div>`;
  back.querySelector(".palette")!.setAttribute("aria-label", info.title);
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  type Props = { textContent?: string; className?: string; type?: string; value?: string; checked?: boolean; inputMode?: string; placeholder?: string };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
    const e: HTMLElementTagNameMap[K] = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  };

  // sheets and columns
  const mapTable = el("table", { className: "cleanup-cols recon-map" });
  const renderMap = () => {
    mapTable.replaceChildren();
    const head = el("tr", {}, el("th"));
    ids.forEach((id, k) => {
      const sel = el("select");
      sel.setAttribute("aria-label", `Sheet for ${info.sides[k]}`);
      for (const s of visible) sel.append(new Option(s.name, s.id, false, s.id === id));
      sel.addEventListener("change", () => {
        ids[k] = sel.value;
        maps[k] = guessMap(wb.get(ids[k]).source);
        extraCol[k] = info.extra ? guessExtra(sheetHeader(wb.get(ids[k]).source).names, info.extra.re, maps[k]) : -1;
        stale();
        renderMap();
      });
      head.append(el("th", {}, `${info.sides[k]} `, sel));
    });
    mapTable.append(head);
    const names = ids.map((id) => sheetHeader(wb.get(id).source).names);
    const colSelect = (k: number, label: string, get: () => number, set: (c: number) => void) => {
      const sel = el("select");
      sel.setAttribute("aria-label", `${label} column for ${info.sides[k]}`);
      sel.append(new Option("(none)", "-1", false, get() < 0));
      names[k].forEach((n, c) => sel.append(new Option(n, String(c), false, get() === c)));
      sel.addEventListener("change", () => {
        set(Number(sel.value));
        stale();
      });
      return el("td", {}, sel);
    };
    const rows: Array<[string, (k: number) => number, (k: number, c: number) => void]> = RECON_ROLES.map((role) => [ROLE_LABEL[role], (k: number) => maps[k][role], (k: number, c: number) => (maps[k][role] = c)]);
    if (info.extra) rows.push([info.extra.label, (k) => extraCol[k], (k, c) => (extraCol[k] = c)]);
    for (const [label, get, set] of rows) {
      const tr = el("tr", {}, el("td", { textContent: label }));
      ids.forEach((_, k) => tr.append(colSelect(k, label, () => get(k), (c) => set(k, c))));
      mapTable.append(tr);
    }
  };

  // options
  const field = (label: string, value: string, hint: string, mode = "decimal") => {
    const input = el("input", { type: "text", value, inputMode: mode });
    input.addEventListener("change", stale);
    return { label: el("label", {}, label, input, el("small", { textContent: hint })), input };
  };
  const check = (label: string, value: boolean) => {
    const box = el("input", { type: "checkbox", checked: value });
    box.addEventListener("change", stale);
    return { label: el("label", { className: "opt-check" }, box, label), box };
  };
  const read = (k: number) => {
    const src = wb.get(ids[k]).source;
    const side = readSide(src, maps[k]);
    return { ...side, extra: readExtra(src, side.records, extraCol[k]) };
  };
  const tol = field("Amount tolerance", "0", "e.g. 0.01");
  const win = field("Date window ± days", kind === "statementrec" ? "7" : kind === "bankstatement" ? "3" : "", "blank ignores dates", "numeric");
  const opts = el("div", { className: "import-options" }, tol.label, win.label);
  const extraOpts = el("div", { className: "import-options" });
  const signs = el("div", { className: "import-options" });
  let bankBal: ReturnType<typeof field> | null = null;
  let ledgerBal: ReturnType<typeof field> | null = null;
  let bankAcct: ReturnType<typeof field> | null = null;
  let errorsOn: HTMLSelectElement | null = null;
  let asOf: ReturnType<typeof field> | null = null;
  let limits: ReturnType<typeof field> | null = null;
  let staleDays: ReturnType<typeof field> | null = null;
  let stmtDate: ReturnType<typeof field> | null = null;
  let flip: ReturnType<typeof check> | null = null;
  let invPos: ReturnType<typeof check> | null = null;
  const guessDates = () => {
    const recs = ids.map((_, k) => read(k).records);
    return dateText(latestDate(...recs));
  };
  if (kind === "bankstatement") {
    bankBal = field("Bank statement closing balance", "", "overdrawn: negative");
    ledgerBal = field("Ledger closing balance", "", "the bank account in the ledger");
    bankAcct = field("Bank account name", "Bank", "for the entries", "text");
    errorsOn = el("select");
    errorsOn.append(new Option("Errors are the ledger's", "ledger", true, true), new Option("Errors are the bank's", "bank"));
    errorsOn.setAttribute("aria-label", "Who made the errors");
    errorsOn.addEventListener("change", stale);
    extraOpts.append(bankBal.label, ledgerBal.label, bankAcct.label, el("label", {}, "Errors", errorsOn));
    flip = check("Bank amounts have the opposite sign to the ledger", false);
    signs.append(flip.label);
  } else if (kind === "rollforward" || kind === "openitems") {
    asOf = field("Age to (as-of date)", guessDates(), "yyyy-mm-dd", "text");
    limits = field("Ageing buckets", "30, 60, 90", "days, comma separated", "text");
    extraOpts.append(asOf.label, limits.label);
    if (kind === "rollforward") {
      staleDays = field("Stale after days", "180", "flagged to write back", "numeric");
      extraOpts.append(staleDays.label);
      flip = check("This period's amounts have the opposite sign", false);
      signs.append(flip.label);
    }
  } else {
    const g = guessStatementSigns(read(0).records, read(1).records);
    ledgerBal = field("Our ledger balance", "", "blank: our items added up");
    bankBal = field("Their statement balance", "", "as on their statement; blank: added up");
    stmtDate = field("Their statement date", "", "optional, for cut-off notes", "text");
    extraOpts.append(ledgerBal.label, bankBal.label, stmtDate.label);
    flip = check("Their amounts have the opposite sign to ours", g.flipTheirs);
    invPos = check("Invoices are positive in our ledger", g.invoicesPositive);
    signs.append(flip.label, invPos.label);
  }

  const result = el("div", { className: "recon-result" });
  const actions = el("div", { className: "numfmt-actions" });
  actions.innerHTML = `<button type="button" data-act="cancel">Close</button><button type="button" data-act="run">Run</button><button type="button" data-act="add" disabled>Add result sheets</button>`;
  const addBtn = actions.querySelector<HTMLButtonElement>("[data-act=add]")!;
  body.append(el("h3", { textContent: info.title }), el("p", { className: "hp-muted", textContent: info.intro }), mapTable, opts, extraOpts, signs, result, actions);

  let sheets: ReconSheet[] | null = null;
  let doneText = "";
  function stale() {
    if (!sheets) return;
    sheets = null;
    addBtn.disabled = true;
    result.replaceChildren(el("p", { className: "hp-muted", textContent: "Settings changed: press Run again." }));
  }
  const warn = (t: string) => result.replaceChildren(el("p", { className: "cleanup-warn", textContent: t }));
  const p = (t: string, cls = "") => el("p", { textContent: t, className: cls });
  const table = (rows: Array<[string, string]>, warnLast = false) => {
    const t = el("table", { className: "cleanup-cols openitems-summary" });
    rows.forEach(([label, v], k) => {
      const tr = el("tr", { className: warnLast && k === rows.length - 1 ? "recon-warn-row" : "" }, el("td", { textContent: label }), el("td", { textContent: v, className: "openitems-num" }));
      t.append(tr);
    });
    return el("div", { className: "import-preview" }, t);
  };

  const runIt = () => {
    if (two && ids[0] === ids[1]) return warn("Pick two different sheets.");
    for (let k = 0; k < ids.length; k++) if (maps[k].amount < 0) return warn(`${info.sides[k]} needs an amount column.`);
    const tolV = Math.max(0, parseAmountInput(tol.input.value) ?? 0);
    const winV = win.input.value.trim() === "" ? null : Math.max(0, Math.floor(Number(win.input.value) || 0));
    const settings = { amountTolerance: tolV, dateWindow: winV, flipB: flip?.box.checked ?? false };
    const sides = ids.map((_, k) => read(k));
    const bad = sides.reduce((t, s) => t + s.bad, 0);
    const kids: Node[] = [];
    if (kind === "bankstatement") {
      const bb = parseAmountInput(bankBal!.input.value);
      const lb = parseAmountInput(ledgerBal!.input.value);
      if (bb === null || lb === null) return warn("Fill in both closing balances.");
      const [a, b] = [sides[0].records, sides[1].records];
      const r = reconcile(a, b, settings);
      const st = recStatement(r, a, b, { bankBalance: bb, ledgerBalance: lb, flipB: settings.flipB, errorsOn: errorsOn!.value as "ledger" | "bank" });
      const entries = proposeAdjustments(st, a, b, { bankAccount: bankAcct!.input.value.trim() || "Bank" });
      sheets = [bankStatementSheet(st, a, b), adjustmentsSheet(entries, a, b)];
      const rows: Array<[string, string]> = [];
      for (const l of st.bankLines) rows.push([`${l.label}${l.items.length ? ` (${l.items.length})` : ""}`, money(l.total)]);
      rows.push(["Adjusted bank balance", money(st.adjustedBank)]);
      for (const l of st.ledgerLines) rows.push([`${l.label}${l.items.length ? ` (${l.items.length})` : ""}`, money(l.total)]);
      rows.push(["Adjusted ledger balance", money(st.adjustedLedger)], ["Difference", money(st.difference)]);
      kids.push(table(rows, !!st.difference), p(`${entries.length} adjusting entr${entries.length === 1 ? "y" : "ies"} proposed.`));
      if (st.difference) kids.push(p("The statement doesn't balance: check the closing balances, and that both sheets cover the same period (last period's outstanding items roll forward separately).", "cleanup-warn"));
      doneText = `Bank rec: difference ${money(st.difference)}, ${entries.length} adjusting entries`;
    } else if (kind === "rollforward") {
      const at = parseDateInput(asOf!.input.value);
      if (at === null) return warn("Fill in the as-of date.");
      const [a, b] = [sides[0].records, sides[1].records];
      const roll = rollOutstanding(a, b, { asOf: at, settings, limits: parseLimits(limits!.input.value), staleDays: Math.max(0, Number(staleDays!.input.value) || 180) });
      sheets = [rollSheet(roll, a, b)];
      const s = roll.summary;
      kids.push(
        table([
          [`Brought forward (${s.broughtForward})`, money(s.broughtForwardTotal)],
          [`Cleared (${s.cleared})`, money(s.clearedTotal)],
          [`Cleared, amount differs (${s.differs})`, money(s.differsTotal)],
          [`Still open (${s.open})`, money(s.openTotal)],
          [`Of which stale (${s.stale})`, money(s.staleTotal)],
        ]),
      );
      if (roll.buckets.length) kids.push(table(roll.buckets.filter((x) => x.count).map((x) => [`${x.label} days (${x.count})`, money(x.total)])));
      kids.push(p(`${roll.usedCurrent.length} item${roll.usedCurrent.length === 1 ? "" : "s"} in this period's data cleared last period's; leave them out of this period's rec.`, "hp-muted"));
      doneText = `Roll-forward: ${s.cleared} cleared, ${s.open} still open (${money(s.openTotal)})`;
    } else if (kind === "openitems") {
      const at = parseDateInput(asOf!.input.value) ?? undefined;
      const recs: OpenItemRecord[] = sides[0].records.map((r, i) => (sides[0].extra[i] ? { ...r, party: sides[0].extra[i] } : r));
      const res = matchOpenItems(recs, { asOf: at, limits: parseLimits(limits!.input.value), settings: { amountTolerance: tolV, dateWindow: winV } });
      sheets = openItemSheets(res, recs);
      const s = res.summary;
      kids.push(
        table([
          [`Account balance (${s.count} items)`, money(s.balance)],
          [`Cleared (${s.clearedCount} items in ${res.groups.length} groups)`, money(s.clearedNet)],
          [`Open (${s.openCount} items, ${s.openParties} of ${s.parties} part${s.parties === 1 ? "y" : "ies"})`, money(s.openTotal)],
        ]),
      );
      if (res.buckets.length) kids.push(table(res.buckets.filter((x) => x.count).map((x) => [`${x.label} days (${x.count})`, money(x.total)])));
      doneText = `Open items: ${s.openCount} open (${money(s.openTotal)}), ${s.clearedCount} cleared`;
    } else {
      const ours: StatementRecRecord[] = sides[0].records.map((r, i) => (sides[0].extra[i] ? { ...r, type: sides[0].extra[i] } : r));
      const theirs: StatementRecRecord[] = sides[1].records.map((r, i) => (sides[1].extra[i] ? { ...r, type: sides[1].extra[i] } : r));
      const res = statementRec(ours, theirs, {
        flipTheirs: flip!.box.checked,
        invoicesPositive: invPos!.box.checked,
        ourBalance: parseAmountInput(ledgerBal!.input.value) ?? undefined,
        theirBalance: parseAmountInput(bankBal!.input.value) ?? undefined,
        statementDate: parseDateInput(stmtDate!.input.value) ?? undefined,
        settings: { amountTolerance: tolV, dateWindow: winV },
      });
      sheets = statementRecSheets(res, ours, theirs);
      const rows: Array<[string, string]> = [["Balance per their statement", money(res.theirBalance)]];
      for (const l of res.lines) if (l.items.length) rows.push([`${l.label} (${l.items.length})`, money(l.total)]);
      rows.push(["Balance per our ledger (calculated)", money(res.computedOurs)], ["Balance per our ledger (stated)", money(res.ourBalance)], ["Unexplained difference", money(res.difference)]);
      kids.push(table(rows, !!res.difference), p(`${res.rec.matches.length} matched group${res.rec.matches.length === 1 ? "" : "s"}. Amounts are shown with invoices positive.`, "hp-muted"));
      doneText = `Statement rec: unexplained difference ${money(res.difference)}`;
    }
    if (bad) kids.push(p(`${bad.toLocaleString()} value${bad === 1 ? "" : "s"} couldn't be read as an amount or a date and were left blank.`, "cleanup-warn"));
    result.replaceChildren(...kids);
    addBtn.disabled = false;
  };

  const addSheets = async () => {
    if (!sheets) return;
    const out = sheets;
    back.remove();
    for (const s of out) {
      const source = new EditableSource(new Table(s.columns), 10);
      await d.run({ type: "sheet.insert", params: { name: s.name, source: d.putBlob(source), numFmts: s.numFmts } });
    }
    d.status(doneText);
    d.focusGrid();
  };
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  actions.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "cancel") close();
    else if (act === "run") runIt();
    else if (act === "add") void addSheets();
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  renderMap();
  document.body.append(back);
  actions.querySelector<HTMLButtonElement>("[data-act=run]")!.focus();
}
