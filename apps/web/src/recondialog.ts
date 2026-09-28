/**
 * Reconcile two sheets: pick them, say which columns hold the reference,
 * amount, date and description (guessed for you), set the tolerances and
 * passes, see the summary, ask "why don't these match?" about any pair,
 * and add the matched / unmatched / mismatched sheets.
 */
import "./recon.css";
import type { Action } from "@cellforge/actions";
import { dateParts, formatValue, isDateFormat, parseDateLoose, parseNumberLoose, Table, type ColumnData, type DateOrder } from "@cellforge/core";
import { DEFAULT_REC_SETTINGS, explain, KEYING_LABEL, reconcile, type RecRecord, type RecResult, type RecRule, type RecSettings } from "@cellforge/core";
import { EditableSource } from "./editable";
import type { Workbook } from "./workbook";
import { openDialog } from "./ui/dialog";
import { openSidePanel } from "./ui/sidepanel";
import { formatCell, renderTable } from "./ui/table";
import { button, count, el, emptyState, field, headline, navigator, notice, plural, report, section, steps, tabs, toolDialog } from "./toolkit";

export interface ReconDeps {
  workbook: () => Workbook;
  /** id of the sheet on screen */
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
  /** show a sheet row (makes result lines links); optional */
  goTo?: (sheetId: string, row: number, col: number) => void;
}

/** What a mapped column is used for. */
export type ReconRole = "key" | "amount" | "minus" | "date" | "text";
export const RECON_ROLES: readonly ReconRole[] = ["key", "amount", "minus", "date", "text"];
const ROLE_LABEL: Record<ReconRole, string> = {
  key: "Reference",
  amount: "Amount",
  minus: "Credit column",
  date: "Date",
  text: "Description",
};

/** Column index for each role, or -1 for none. */
export type ReconMap = Record<ReconRole, number>;

export const RULE_LABEL: Record<RecRule, string> = {
  exact: "Same reference and amount",
  tolerance: "Same reference, amount within tolerance",
  reference: "Same reference after normalising",
  fuzzy: "Similar description",
  "amount+date": "Amount and date only",
  "one-to-many": "One A = sum of several B",
  "many-to-one": "Several A = one B",
};

/** The sheet's header names and where the data starts. */
export function sheetHeader(src: EditableSource): { names: string[]; first: number } {
  const { cols } = src.usedRange();
  const named = Array.from({ length: cols }, (_, c) => src.getColumnName?.(c) ?? "");
  if (named.some(Boolean)) return { names: named.map((n, c) => n || colLetter(c)), first: 0 };
  const top = Array.from({ length: cols }, (_, c) => src.getCell(0, c));
  const looksLikeHeader = top.some((v) => typeof v === "string" && v.trim()) && top.every((v) => v === null || (typeof v === "string" && !/^[-\d.,()\s]+$/.test(v)));
  return looksLikeHeader ? { names: top.map((v, c) => (typeof v === "string" && v.trim() ? v.trim() : colLetter(c))), first: 1 } : { names: named.map((_, c) => colLetter(c)), first: 0 };
}

function colLetter(c: number): string {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `Column ${s}`;
}

const GUESS: Array<[ReconRole, RegExp]> = [
  ["date", /date|posted|value d/i],
  ["key", /\b(ref|reference|refs|invoice|inv|doc|document|voucher|cheque|check|chq|txn|transaction id|id|no|number|num)\b|ref\.?$|#/i],
  ["amount", /amount|amt|\bvalue\b|\bnet\b|\bgross\b|\btotal\b|\bsum\b|debit|\bdr\b|paid out|money out|withdraw/i],
  ["minus", /credit|\bcr\b|paid in|money in|deposit/i],
  ["text", /desc|narrat|detail|memo|payee|particular|\bname\b|text|comment|supplier|customer|vendor/i],
];

/** Guess which column is which, from the header and the first values. */
export function guessMap(src: EditableSource): ReconMap {
  const { names, first } = sheetHeader(src);
  const map: ReconMap = { key: -1, amount: -1, minus: -1, date: -1, text: -1 };
  const taken = new Set<number>();
  for (const [role, re] of GUESS) {
    const c = names.findIndex((n, i) => !taken.has(i) && re.test(n));
    if (c >= 0) {
      map[role] = c;
      taken.add(c);
    }
  }
  // "Debit" and "Credit" together: amount = debit - credit; a lone credit column isn't a minus column
  if (map.minus >= 0 && map.amount < 0) {
    map.amount = map.minus;
    map.minus = -1;
  }
  if (map.minus >= 0 && !/debit|\bdr\b|paid out|money out|withdraw/i.test(names[map.amount])) {
    taken.delete(map.minus);
    map.minus = -1;
  }
  // fall back on what the values look like
  const rows = Math.min(src.usedRange().rows, first + 50);
  const kind = (c: number) => {
    let num = 0;
    let date = 0;
    let text = 0;
    for (let r = first; r < rows; r++) {
      const v = src.getCell(r, c);
      if (typeof v === "number") {
        const f = src.getStyle(r, c)?.numFmt;
        if (f && isDateFormat(f)) date++;
        else num++;
      } else if (typeof v === "string" && v.trim()) {
        if (parseDateLoose(v) !== null) date++;
        else if (parseNumberLoose(v) !== null) num++;
        else text++;
      }
    }
    return num >= date && num >= text && num ? "number" : date >= text && date ? "date" : text ? "text" : "empty";
  };
  for (let c = 0; c < names.length; c++) {
    if (taken.has(c)) continue;
    const k = kind(c);
    const role: ReconRole | null = k === "number" ? "amount" : k === "date" ? "date" : k === "text" ? "text" : null;
    if (role && map[role] < 0) {
      map[role] = c;
      taken.add(c);
    }
  }
  return map;
}

export interface ReadSide {
  records: RecRecord[];
  /** values that couldn't be read as amounts or dates */
  bad: number;
  dateOrder: DateOrder;
}

/** Read one side of the reconciliation; `row` on each record is the sheet row number as shown (1-based). */
export function readSide(src: EditableSource, map: ReconMap): ReadSide {
  const { first } = sheetHeader(src);
  const { rows } = src.usedRange();
  // day or month first, from the dates written as text
  let dayFirst = 0;
  let monthFirst = 0;
  if (map.date >= 0) {
    for (let r = first; r < rows && r < first + 5000; r++) {
      const v = src.getCell(r, map.date);
      if (typeof v !== "string") continue;
      const p = dateParts(v);
      if (!p || p[0] > 31) continue;
      if (p[0] > 12) dayFirst++;
      else if (p[1] > 12) monthFirst++;
    }
  }
  const dateOrder: DateOrder = monthFirst > dayFirst ? "mdy" : "dmy";
  const records: RecRecord[] = [];
  let bad = 0;
  const num = (r: number, c: number): number | undefined => {
    if (c < 0) return undefined;
    const v = src.getCell(r, c);
    if (typeof v === "number") return v;
    if (typeof v !== "string" || !v.trim()) return undefined;
    const n = parseNumberLoose(v);
    if (n === null) bad++;
    return n ?? undefined;
  };
  for (let r = first; r < rows; r++) {
    const rec: RecRecord = { row: r + 1 };
    let any = false;
    if (map.key >= 0) {
      const v = src.getCell(r, map.key);
      if (v !== null && String(v).trim()) {
        rec.key = String(v).trim();
        any = true;
      }
    }
    const amt = num(r, map.amount);
    const minus = num(r, map.minus);
    if (amt !== undefined || minus !== undefined) {
      rec.amount = (amt ?? 0) - (minus ?? 0);
      any = true;
    }
    if (map.date >= 0) {
      const v = src.getCell(r, map.date);
      if (typeof v === "number") rec.date = Math.floor(v);
      else if (typeof v === "string" && v.trim()) {
        const d = parseDateLoose(v, dateOrder);
        if (d === null) bad++;
        else rec.date = Math.floor(d);
      }
      if (rec.date !== undefined) any = true;
    }
    if (map.text >= 0) {
      const v = src.getCell(r, map.text);
      if (v !== null && String(v).trim()) {
        rec.text = String(v).trim();
        any = true;
      }
    }
    if (any) records.push(rec);
  }
  return { records, bad, dateOrder };
}

const text = (name: string, values: string[]): ColumnData => {
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
const nums = (name: string, values: Array<number | undefined | null>): ColumnData => ({
  kind: "number",
  name,
  values: Float64Array.from(values, (v) => (v === undefined || v === null ? NaN : v)),
});

const DATE = "yyyy-mm-dd";
const MONEY = "#,##0.00";

export interface ReconSheet {
  name: string;
  columns: ColumnData[];
  numFmts: string[];
}

/** Notes for each unmatched or mismatched item: possible keying errors, duplicates, sums not fully searched. */
function notes(r: RecResult, a: RecRecord[], b: RecRecord[]): { A: Map<number, string[]>; B: Map<number, string[]> } {
  const A = new Map<number, string[]>();
  const B = new Map<number, string[]>();
  const add = (m: Map<number, string[]>, i: number, t: string) => {
    const l = m.get(i);
    if (l) l.push(t);
    else m.set(i, [t]);
  };
  for (const f of r.flags) {
    const what = f.field === "key" ? `reference ${f.kind === "transposition" ? "has two characters swapped" : "differs in one character"}` : `amount ${KEYING_LABEL[f.kind]}`;
    add(A, f.a, `possible keying error: ${what} (B row ${b[f.b].row})`);
    add(B, f.b, `possible keying error: ${what} (A row ${a[f.a].row})`);
  }
  for (const d of r.duplicates) {
    const recs = d.side === "A" ? a : b;
    for (const i of d.items) {
      const others = d.items.filter((x) => x !== i).map((x) => recs[x].row);
      add(d.side === "A" ? A : B, i, `looks like a duplicate of row${others.length === 1 ? "" : "s"} ${others.join(", ")}`);
    }
  }
  for (const c of r.sumCapped) add(c.side === "A" ? A : B, c.item, "sum search stopped at the limit");
  return { A, B };
}

/** The result as four sheets. */
export function reconSheets(r: RecResult, a: RecRecord[], b: RecRecord[]): ReconSheet[] {
  const note = notes(r, a, b);

  // matched: one row per record, groups numbered
  const m = { group: [] as number[], rule: [] as string[], side: [] as string[], row: [] as number[], key: [] as string[], date: [] as Array<number | undefined>, amount: [] as Array<number | undefined>, text: [] as string[], diff: [] as Array<number | null>, days: [] as Array<number | null> };
  r.matches.forEach((g, n) => {
    let firstRow = true;
    const push = (side: "A" | "B", rec: RecRecord) => {
      m.group.push(n + 1);
      m.rule.push(RULE_LABEL[g.rule] + (g.score !== undefined && firstRow ? ` (${Math.round(g.score * 100)}%)` : ""));
      m.side.push(side);
      m.row.push(rec.row);
      m.key.push(rec.key ?? "");
      m.date.push(rec.date);
      m.amount.push(rec.amount);
      m.text.push(rec.text ?? "");
      m.diff.push(firstRow ? g.amountDiff : null);
      m.days.push(firstRow ? g.days : null);
      firstRow = false;
    };
    for (const i of g.a) push("A", a[i]);
    for (const j of g.b) push("B", b[j]);
  });
  const matched: ReconSheet = {
    name: "Rec matched",
    columns: [
      nums("Group", m.group),
      text("Rule", m.rule),
      text("Side", m.side),
      nums("Sheet row", m.row),
      text("Reference", m.key),
      nums("Date", m.date),
      nums("Amount", m.amount),
      text("Description", m.text),
      nums("Difference", m.diff),
      nums("Days apart", m.days),
    ],
    numFmts: ["", "", "", "", "", DATE, MONEY, "", MONEY, ""],
  };

  const unmatched = (name: string, ids: number[], recs: RecRecord[], notesOf: Map<number, string[]>): ReconSheet => ({
    name,
    columns: [
      nums("Sheet row", ids.map((i) => recs[i].row)),
      text("Reference", ids.map((i) => recs[i].key ?? "")),
      nums("Date", ids.map((i) => recs[i].date)),
      nums("Amount", ids.map((i) => recs[i].amount)),
      text("Description", ids.map((i) => recs[i].text ?? "")),
      text("Note", ids.map((i) => (notesOf.get(i) ?? []).join("; "))),
    ],
    numFmts: ["", "", DATE, MONEY, "", ""],
  });

  const mm = r.mismatched;
  const mmNote = (p: { a: number; b: number }) => {
    const f = r.flags.find((x) => x.mismatched && x.a === p.a && x.b === p.b);
    return f ? `possible keying error: amount ${KEYING_LABEL[f.kind]}` : "";
  };
  const mismatched: ReconSheet = {
    name: "Rec mismatched",
    columns: [
      nums("A row", mm.map((p) => a[p.a].row)),
      nums("B row", mm.map((p) => b[p.b].row)),
      text("A reference", mm.map((p) => a[p.a].key ?? "")),
      text("B reference", mm.map((p) => b[p.b].key ?? "")),
      nums("A date", mm.map((p) => a[p.a].date)),
      nums("B date", mm.map((p) => b[p.b].date)),
      nums("Days apart", mm.map((p) => p.days)),
      nums("A amount", mm.map((p) => a[p.a].amount)),
      nums("B amount", mm.map((p) => b[p.b].amount)),
      nums("Difference", mm.map((p) => (Number.isFinite(p.amountDiff) ? p.amountDiff : null))),
      text("Note", mm.map(mmNote)),
    ],
    numFmts: ["", "", "", "", DATE, DATE, "", MONEY, MONEY, MONEY, ""],
  };
  return [matched, unmatched("Rec unmatched A", r.unmatchedA, a, note.A), unmatched("Rec unmatched B", r.unmatchedB, b, note.B), mismatched];
}


// ------------------------------------------------------------------ UI --
//
// 1. Choose the two sides (a dialog: sheet, which column is which, a
//    preview of the first rows with the compared columns highlighted).
// 2. Matching rules (same dialog: tolerances, the passes; the finer
//    settings under Advanced).
// 3. Results (the side panel, beside the grid: the headline figure, what's
//    left on each side with totals, differences, duplicates, matched pairs;
//    rows link back to the sheet; "Why don't these match?"; create the
//    results sheets).

const money = (n: number) => formatCell(n, "amount");

const ROLE_HINT: Record<ReconRole, string> = {
  key: "Invoice, cheque or transaction number",
  amount: "Signed amount, or debits when credits are separate",
  minus: "Only when debits and credits are in two columns",
  date: "Used by the date window",
  text: "Payee or narrative, for the similar-description pass",
};

/** The first rows of a sheet as shown, with the columns in use highlighted and labelled. */
export function sidePreview(src: EditableSource, roles: ReadonlyMap<number, string>, rows = 5): HTMLElement {
  const { names, first } = sheetHeader(src);
  const total = src.usedRange().rows;
  const table = el("table", { className: "data-table data-table--dense rc-preview" });
  const head = table.createTHead().insertRow();
  names.forEach((n, c) => {
    const th = el("th", { scope: "col" }, el("span", { className: "rc-colname", textContent: n }));
    const role = roles.get(c);
    if (role) {
      th.classList.add("rc-mapped");
      th.append(el("span", { className: "rc-role", textContent: role }));
    }
    head.append(th);
  });
  const body = table.createTBody();
  for (let r = first; r < Math.min(total, first + rows); r++) {
    const tr = body.insertRow();
    names.forEach((_, c) => {
      const v = src.getCell(r, c);
      const td = tr.insertCell();
      if (typeof v === "number") {
        const f = src.getStyle(r, c)?.numFmt;
        td.textContent = f && f !== "General" ? formatValue(v, f).text : formatCell(v, "number");
        td.className = "num";
      } else td.textContent = v === null || v === undefined ? "" : String(v);
      if (roles.has(c)) td.classList.add("rc-mapped");
    });
  }
  if (total <= first) {
    const td = body.insertRow().insertCell();
    td.colSpan = Math.max(1, names.length);
    td.className = "data-table__empty";
    td.textContent = "This sheet is empty.";
  }
  const wrap = el("div", { className: "table-wrap rc-preview-wrap" });
  wrap.append(table);
  return wrap;
}

interface ReconState {
  idA: string;
  idB: string;
  mapA: ReconMap;
  mapB: ReconMap;
  settings: RecSettings;
  last: { r: RecResult; a: RecRecord[]; b: RecRecord[]; bad: number; ms: number } | null;
  why: { a: string; b: string };
  added: boolean;
}

// the setup is remembered per workbook, so "Edit setup" and reopening keep the choices
const states = new WeakMap<Workbook, ReconState>();

const OTHER_SIDE = /bank|statement|stmt|supplier|customer|vendor|creditor|debtor|counterparty/i;
const OUR_SIDE = /cash ?book|ledger|\bgl\b|books|nominal|\bap\b|\bar\b|payables|receivables|ours/i;

/**
 * Which two sheets to reconcile: sheets with an amount column only; side B
 * looks like the other party (bank, statement), side A like our books (or
 * is the sheet on screen). Pure; ids in the order given.
 */
export function pickSides(sheets: readonly { id: string; name: string; amounts: boolean }[], active: string): [string, string] {
  const usable = sheets.filter((s) => s.amounts);
  const pool = usable.length >= 2 ? usable : sheets;
  const b = pool.find((s) => OTHER_SIDE.test(s.name) && s.id !== active) ?? pool.find((s) => OTHER_SIDE.test(s.name));
  const notB = pool.filter((s) => s.id !== b?.id);
  const a = notB.find((s) => s.id === active && (s.amounts || !usable.length)) ?? notB.find((s) => OUR_SIDE.test(s.name)) ?? notB[0];
  const second = b ?? pool.find((s) => s.id !== a.id)!;
  return [a.id, second.id];
}

function freshState(wb: Workbook, active: string): ReconState {
  const visible = wb.sheets.filter((s) => !s.hidden);
  const [idA, idB] = pickSides(
    visible.map((s) => ({ id: s.id, name: s.name, amounts: guessMap(s.source).amount >= 0 && s.source.usedRange().rows > 1 })),
    active,
  );
  return {
    idA,
    idB,
    mapA: guessMap(wb.get(idA).source),
    mapB: guessMap(wb.get(idB).source),
    settings: { ...DEFAULT_REC_SETTINGS, passes: { ...DEFAULT_REC_SETTINGS.passes } },
    last: null,
    why: { a: "", b: "" },
    added: false,
  };
}

function needTwoSheets(title: string, what: string): void {
  openDialog({
    title,
    size: "sm",
    body: emptyState({
      icon: "reconcile",
      title: "Two sheets are needed",
      text: `${what} compares two sheets, for example your cash book and the bank statement. Paste or open the other side into a second sheet (the + next to the sheet tabs), then try again.`,
    }),
    actions: [{ label: "Got it", kind: "primary", dismiss: true }],
  });
}

export function openRecon(d: ReconDeps): void {
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  if (visible.length < 2) {
    needTwoSheets("Reconcile two sheets", "Reconciling");
    return;
  }
  let st = states.get(wb);
  const ok = (id: string) => wb.has(id) && !wb.get(id).hidden;
  if (!st || !ok(st.idA) || !ok(st.idB)) {
    st = freshState(wb, d.activeSheet());
    states.set(wb, st);
  }
  openSetup(d, st, 0);
}

function openSetup(d: ReconDeps, st: ReconState, startStep: number): void {
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  const settings = st.settings;
  let step = startStep;
  const dlg = toolDialog({ title: "Reconcile two sheets", subtitle: "Match your records against the bank or the other party, line by line", size: "xl", closeLabel: "Cancel", className: "rc-dialog" });
  const backBtn = dlg.button("Back", () => go(0), { start: true });
  const nextBtn = dlg.button("Next: matching rules", () => go(1), { kind: "primary" });
  const matchBtn = dlg.button("Match", () => runMatch(), { kind: "primary" });

  const sideProblem = (): string | null => {
    if (st.idA === st.idB) return "Pick two different sheets.";
    for (const [map, side] of [
      [st.mapA, wb.get(st.idA).name],
      [st.mapB, wb.get(st.idB).name],
    ] as const) {
      if (map.key < 0 && map.amount < 0 && map.text < 0) return `Pick at least a reference, an amount or a description column for ${side}.`;
    }
    return null;
  };

  const go = (to: number) => {
    if (to === 1) {
      const p = sideProblem();
      if (p) throw new Error(p);
    }
    step = to;
    render();
  };

  // ---- step 1: the two sides
  const sideCard = (side: "A" | "B") => {
    const card = el("section", { className: "rc-side" });
    const draw = () => {
      const id = side === "A" ? st.idA : st.idB;
      const map = side === "A" ? st.mapA : st.mapB;
      const src = wb.get(id).source;
      const { names, first } = sheetHeader(src);
      const rows = Math.max(0, src.usedRange().rows - first);
      const sheetSel = el("select");
      sheetSel.setAttribute("aria-label", `Sheet for side ${side}`);
      for (const s of visible) sheetSel.append(new Option(s.name, s.id, false, s.id === id));
      sheetSel.addEventListener("change", () => {
        if (side === "A") {
          st.idA = sheetSel.value;
          st.mapA = guessMap(wb.get(st.idA).source);
        } else {
          st.idB = sheetSel.value;
          st.mapB = guessMap(wb.get(st.idB).source);
        }
        st.last = null;
        draw();
        dlg.handle.setError(null);
      });
      const roles = el("div", { className: "rc-roles" });
      for (const role of RECON_ROLES) {
        const sel = el("select");
        sel.setAttribute("aria-label", `${ROLE_LABEL[role]} column in ${wb.get(id).name}`);
        sel.append(new Option(role === "minus" ? "(not separate)" : "(none)", "-1", false, map[role] < 0));
        names.forEach((n, c) => sel.append(new Option(n, String(c), false, map[role] === c)));
        sel.addEventListener("change", () => {
          map[role] = Number(sel.value);
          st.last = null;
          preview.replaceWith((preview = makePreview()));
        });
        const f = field(ROLE_LABEL[role], sel);
        f.title = ROLE_HINT[role];
        roles.append(f);
      }
      const makePreview = () => {
        const m = new Map<number, string>();
        for (const role of RECON_ROLES) if (map[role] >= 0) m.set(map[role], m.has(map[role]) ? `${m.get(map[role])} · ${ROLE_SHORT[role]}` : ROLE_SHORT[role]);
        return sidePreview(src, m);
      };
      let preview = makePreview();
      card.replaceChildren(
        el(
          "header",
          { className: "rc-side__head" },
          el("span", { className: `rc-side__badge rc-side__badge--${side.toLowerCase()}`, textContent: side }),
          el("div", { className: "rc-side__titles" }, el("strong", { textContent: side === "A" ? "Your records" : "The other side" }), el("span", { className: "tk-muted", textContent: `${count(rows)} row${rows === 1 ? "" : "s"}` })),
          sheetSel,
        ),
        roles,
        el("div", { className: "rc-side__preview-label tk-muted", textContent: "First rows: the highlighted columns are compared" }),
        preview,
      );
    };
    draw();
    return card;
  };

  // ---- step 2: matching rules
  const numInput = (value: string, onChange: (v: string) => void, label: string) => {
    const input = el("input", { type: "text", value, inputMode: "decimal" });
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => {
      onChange(input.value.trim());
      st.last = null;
    });
    return input;
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void, hint?: string) => {
    const box = el("input", { type: "checkbox", checked: get() });
    box.addEventListener("change", () => {
      set(box.checked);
      st.last = null;
    });
    const l = el("label", { className: "rc-pass" }, box, el("span", {}, el("span", { className: "rc-pass__name", textContent: label }), hint ? el("small", { className: "tk-field__hint", textContent: hint }) : null));
    return l;
  };
  const rulesStep = () => {
    const tol = field("Amount tolerance", numInput(String(settings.amountTolerance), (v) => (settings.amountTolerance = Math.max(0, Number(v) || 0)), "Amount tolerance"), "Amounts this close still match, e.g. 0.01 for rounding");
    const win = field(
      "Date window (± days)",
      numInput(settings.dateWindow === null ? "" : String(settings.dateWindow), (v) => (settings.dateWindow = v === "" || Number.isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v)))), "Date window in days"),
      "Bank dates usually lag by a few days. Leave blank to ignore dates",
    );
    const flip = check(`${wb.get(st.idB).name} shows amounts with the opposite sign`, () => settings.flipB, (v) => (settings.flipB = v), "Tick when the bank shows your payments as positive and receipts as negative");
    const passes = el("div", { className: "rc-passes" });
    const PASSES: Array<[keyof RecSettings["passes"], string, string]> = [
      ["exact", "Same reference and amount", "The strictest test, run first"],
      ["tolerance", "Same reference, amount within tolerance", "Catches rounding and small fees"],
      ["reference", "Same reference after tidying it", "Ignores case, spaces, punctuation, leading zeros and prefixes like INV or REF"],
      ["fuzzy", "Similar description", `Descriptions at least ${Math.round(settings.fuzzyThreshold * 100)}% alike`],
      ["amountDate", "Same amount and date", "For lines without a usable reference"],
      ["sum", "Split payments", `One line equals the sum of up to ${settings.sumMaxItems} lines on the other side`],
    ];
    PASSES.forEach(([k, label, hint], i) => passes.append(el("div", { className: "rc-pass-row" }, el("span", { className: "rc-pass__n", textContent: String(i + 1) }), check(label, () => settings.passes[k], (v) => (settings.passes[k] = v), hint))));
    const adv = el(
      "details",
      { className: "tk-details" },
      el("summary", { textContent: "Advanced" }),
      el(
        "div",
        { className: "tk-grid" },
        field("Or a percentage of the amount", numInput(String(settings.amountTolerancePct), (v) => (settings.amountTolerancePct = Math.max(0, Number(v) || 0)), "Percent tolerance"), "The larger tolerance applies"),
        field("Description match (%)", numInput(String(Math.round(settings.fuzzyThreshold * 100)), (v) => (settings.fuzzyThreshold = Math.min(100, Math.max(1, Number(v) || 85)) / 100), "Description match percent"), "For the similar-description pass"),
        field("Split payment: up to N lines", numInput(String(settings.sumMaxItems), (v) => (settings.sumMaxItems = Math.min(6, Math.max(2, Math.floor(Number(v)) || 3))), "Most lines in a split payment"), "2 to 6; more is slower"),
      ),
    );
    return el(
      "div",
      { className: "rc-rules" },
      el("p", { className: "tk-lead", textContent: `Matching runs in passes, strictest first. Each pass only looks at the lines the earlier passes left, so a strict match always wins over a loose one.` }),
      el("div", { className: "tk-grid rc-tols" }, tol, win),
      flip,
      section("Passes, in order", passes),
      adv,
    );
  };

  const render = () => {
    const stepper = steps(["Choose the two sides", "Matching rules", "Results"], step, (i) => go(i));
    const content = step === 0 ? el("div", { className: "rc-sides" }, sideCard("A"), el("div", { className: "rc-vs", textContent: "⇄" }), sideCard("B")) : rulesStep();
    dlg.body.replaceChildren(stepper, content);
    backBtn.style.display = step === 0 ? "none" : "";
    nextBtn.style.display = step !== 0 ? "none" : "";
    matchBtn.style.display = step !== 1 ? "none" : "";
    (step === 0 ? nextBtn : matchBtn).focus({ preventScroll: true });
  };

  const runMatch = () => {
    const p = sideProblem();
    if (p) throw new Error(p);
    const t0 = performance.now();
    const sa = readSide(wb.get(st.idA).source, st.mapA);
    const sb = readSide(wb.get(st.idB).source, st.mapB);
    if (!sa.records.length || !sb.records.length) throw new Error(`${!sa.records.length ? wb.get(st.idA).name : wb.get(st.idB).name} has no rows to match in the chosen columns.`);
    const r = reconcile(sa.records, sb.records, settings);
    st.last = { r, a: sa.records, b: sb.records, bad: sa.bad + sb.bad, ms: performance.now() - t0 };
    st.added = false;
    dlg.close();
    showResults(d, st);
  };

  render();
}

const ROLE_SHORT: Record<ReconRole, string> = { key: "Reference", amount: "Amount", minus: "Credit", date: "Date", text: "Description" };

const TABLE_CAP = 1000;

interface ItemRow {
  i: number;
  row: number;
  date?: number;
  key: string;
  text: string;
  amount?: number;
  note: string;
}

function showResults(d: ReconDeps, st: ReconState): void {
  const wb = d.workbook();
  if (!st.last || !wb.has(st.idA) || !wb.has(st.idB)) return;
  const { r, a, b } = st.last;
  const nameA = wb.get(st.idA).name;
  const nameB = wb.get(st.idB).name;
  const goTo = navigator(d.goTo);
  const notesOf = notes(r, a, b);
  const s = r.summary;

  openSidePanel({
    id: "recon",
    title: "Reconciliation",
    subtitle: `${nameA} ⇄ ${nameB}`,
    render: (p) => {
      const whyA = el("input", { type: "text", inputMode: "numeric", placeholder: "Row", value: st.why.a });
      const whyB = el("input", { type: "text", inputMode: "numeric", placeholder: "Row", value: st.why.b });
      const show = (sheetId: string, map: ReconMap, row: number) => goTo?.(sheetId, row - 1, Math.max(0, map.amount >= 0 ? map.amount : map.key));

      const itemRows = (ids: number[], recs: RecRecord[], n: Map<number, string[]>): ItemRow[] =>
        ids.slice(0, TABLE_CAP).map((i) => ({ i, row: recs[i].row, date: recs[i].date, key: recs[i].key ?? "", text: recs[i].text ?? "", amount: recs[i].amount, note: (n.get(i) ?? []).join("; ") }));
      const capNote = (n: number) => (n > TABLE_CAP ? el("p", { className: "tk-muted", textContent: `Showing the first ${count(TABLE_CAP)} of ${count(n)}. Create the results sheets to see them all.` }) : null);
      const itemTable = (side: "A" | "B", ids: number[]) => {
        const recs = side === "A" ? a : b;
        const sheetId = side === "A" ? st.idA : st.idB;
        const map = side === "A" ? st.mapA : st.mapB;
        const rows = itemRows(ids, recs, side === "A" ? notesOf.A : notesOf.B);
        const total = ids.reduce((t, i) => t + (recs[i].amount ?? 0), 0);
        const t = renderTable<ItemRow>({
          columns: [
            { key: "row", label: "Row", format: "integer", width: "4em" },
            { key: "date", label: "Date", format: "date" },
            { key: "amount", label: "Amount", format: "amount" },
            { key: "key", label: "Reference" },
            { key: "text", label: "Description" },
            { key: "note", label: "Note" },
          ],
          rows,
          onRowClick: (x) => {
            (side === "A" ? whyA : whyB).value = String(x.row);
            st.why[side === "A" ? "a" : "b"] = String(x.row);
            show(sheetId, map, x.row);
          },
          empty: `Every line on ${side === "A" ? nameA : nameB} found a partner.`,
          maxHeight: "46vh",
          caption: `Unmatched on ${side === "A" ? nameA : nameB}`,
        });
        return el(
          "div",
          { className: "rc-tab" },
          ids.length ? el("p", { className: "tk-muted", textContent: `${plural(ids.length, "line")} totalling ${money(total)} with no partner on ${side === "A" ? nameB : nameA}. Click a line to see it in the sheet.` }) : null,
          t.element,
          capNote(ids.length),
        );
      };

      const diffTable = () => {
        type Row = { aRow: number; bRow: number; key: string; aAmt?: number; bAmt?: number; diff: number | null; days: number | null; note: string };
        const rows: Row[] = r.mismatched.slice(0, TABLE_CAP).map((m) => {
          const f = r.flags.find((x) => x.mismatched && x.a === m.a && x.b === m.b);
          return { aRow: a[m.a].row, bRow: b[m.b].row, key: a[m.a].key ?? b[m.b].key ?? "", aAmt: a[m.a].amount, bAmt: b[m.b].amount, diff: Number.isFinite(m.amountDiff) ? m.amountDiff : null, days: m.days ?? null, note: f ? `possible keying error: amount ${KEYING_LABEL[f.kind]}` : "" };
        });
        const t = renderTable<Row>({
          columns: [
            { key: "key", label: "Reference" },
            { key: "aRow", label: `${nameA} row`, format: "integer" },
            { key: "aAmt", label: nameA, format: "amount" },
            { key: "bRow", label: `${nameB} row`, format: "integer" },
            { key: "bAmt", label: nameB, format: "amount" },
            { key: "diff", label: "Difference", format: "amount" },
            { key: "days", label: "Days apart", format: "integer" },
            { key: "note", label: "Note" },
          ],
          rows,
          onRowClick: (x) => {
            whyA.value = st.why.a = String(x.aRow);
            whyB.value = st.why.b = String(x.bRow);
            show(st.idA, st.mapA, x.aRow);
          },
          empty: "No pairs with the same reference and a different amount or date.",
          maxHeight: "46vh",
        });
        return el("div", { className: "rc-tab" }, r.mismatched.length ? el("p", { className: "tk-muted", textContent: "Same reference on both sides, but the amount or the date is off. Usually a keying error, a fee or a part payment." }) : null, t.element, capNote(r.mismatched.length));
      };

      const dupTable = () => {
        type Row = { side: string; rows: string; key: string; amount?: number; date?: number; first: number; sideId: "A" | "B" };
        const rows: Row[] = r.duplicates.slice(0, TABLE_CAP).map((g) => {
          const recs = g.side === "A" ? a : b;
          const one = recs[g.items[0]];
          return { side: g.side === "A" ? nameA : nameB, rows: g.items.map((i) => recs[i].row).join(", "), key: one.key ?? one.text ?? "", amount: one.amount, date: one.date, first: one.row, sideId: g.side };
        });
        const t = renderTable<Row>({
          columns: [
            { key: "side", label: "Sheet" },
            { key: "rows", label: "Rows" },
            { key: "date", label: "Date", format: "date" },
            { key: "key", label: "Reference" },
            { key: "amount", label: "Amount", format: "amount" },
          ],
          rows,
          onRowClick: (x) => show(x.sideId === "A" ? st.idA : st.idB, x.sideId === "A" ? st.mapA : st.mapB, x.first),
          empty: "No line appears twice on either side.",
          maxHeight: "46vh",
        });
        return el("div", { className: "rc-tab" }, r.duplicates.length ? el("p", { className: "tk-muted", textContent: "Lines that appear more than once on the same side: a double posting or a payment made twice. Check them before clearing anything." }) : null, t.element);
      };

      const matchedTable = () => {
        type Row = { group: number; rule: string; aRows: string; bRows: string; amount?: number; diff: number; first: number };
        const rows: Row[] = r.matches.slice(0, TABLE_CAP).map((g, n) => ({
          group: n + 1,
          rule: RULE_LABEL[g.rule] + (g.score !== undefined ? ` (${Math.round(g.score * 100)}%)` : ""),
          aRows: g.a.map((i) => a[i].row).join(", "),
          bRows: g.b.map((j) => b[j].row).join(", "),
          amount: g.a.reduce((t, i) => t + (a[i].amount ?? 0), 0),
          diff: g.amountDiff,
          first: a[g.a[0]]?.row ?? 1,
        }));
        const t = renderTable<Row>({
          columns: [
            { key: "aRows", label: `${nameA} rows` },
            { key: "bRows", label: `${nameB} rows` },
            { key: "amount", label: "Amount", format: "amount" },
            { key: "diff", label: "Difference", format: (v) => (v ? money(v as number) : "") , align: "right" },
            { key: "rule", label: "Matched by" },
          ],
          rows,
          onRowClick: (x) => show(st.idA, st.mapA, x.first),
          empty: "Nothing matched. Check the columns in step 1, or loosen the rules in step 2.",
          maxHeight: "46vh",
        });
        const byRule = (Object.keys(RULE_LABEL) as RecRule[]).filter((k) => s.byRule[k]).map((k) => `${RULE_LABEL[k]}: ${count(s.byRule[k])}`);
        return el("div", { className: "rc-tab" }, byRule.length ? el("p", { className: "tk-muted", textContent: byRule.join(" · ") }) : null, t.element, capNote(r.matches.length));
      };

      const dupCount = s.duplicatesA + s.duplicatesB;
      const tabList = [
        { id: "a", label: `Only in ${nameA}`, count: s.unmatchedA, tone: "unmatched" as const, render: () => itemTable("A", r.unmatchedA) },
        { id: "b", label: `Only in ${nameB}`, count: s.unmatchedB, tone: "unmatched" as const, render: () => itemTable("B", r.unmatchedB) },
        { id: "diff", label: "Differences", count: s.mismatched, tone: "mismatch" as const, render: diffTable },
        { id: "dup", label: "Duplicates", count: dupCount, tone: "mismatch" as const, render: dupTable },
        { id: "matched", label: "Matched", count: r.matches.length, tone: "match" as const, render: matchedTable },
      ];
      const firstIssue = tabList.find((t) => t.id !== "matched" && t.count)?.id ?? "matched";
      const tb = tabs(tabList, firstIssue);

      // the headline: share matched, then what's left on each side
      const matchedLines = s.matchedA + s.matchedB;
      const allLines = s.countA + s.countB;
      const exceptions = s.unmatchedA + s.unmatchedB + s.mismatched;
      const caption = !exceptions
        ? `Everything matched. ${nameA} and ${nameB} agree line for line.`
        : `${plural(s.unmatchedA, "line")} left in ${nameA} and ${plural(s.unmatchedB, "line")} in ${nameB}${s.mismatched ? `; ${plural(s.mismatched, "pair")} with the same reference but a different amount or date` : ""}.`;
      const head = headline({
        value: (Math.floor(s.matchRate * 1000) / 10).toFixed(1),
        unit: "% matched",
        progress: s.matchRate,
        tone: exceptions ? "accent" : "match",
        caption,
        lines: [
          { label: "Matched lines", value: `${count(matchedLines)} of ${count(allLines)}`, tone: "match", onClick: () => tb.select("matched") },
          { label: `Only in ${nameA}`, value: s.unmatchedA ? `${count(s.unmatchedA)} · ${money(s.unmatchedTotalA)}` : "None", tone: s.unmatchedA ? "unmatched" : undefined, onClick: () => tb.select("a") },
          { label: `Only in ${nameB}`, value: s.unmatchedB ? `${count(s.unmatchedB)} · ${money(s.unmatchedTotalB)}` : "None", tone: s.unmatchedB ? "unmatched" : undefined, onClick: () => tb.select("b") },
          { label: "Amount or date differs", value: s.mismatched ? count(s.mismatched) : "None", tone: s.mismatched ? "mismatch" : undefined, onClick: () => tb.select("diff") },
          { label: "Possible duplicates", value: dupCount ? `${count(dupCount)} group${dupCount === 1 ? "" : "s"}` : "None", tone: dupCount ? "mismatch" : undefined, onClick: () => tb.select("dup") },
        ],
      });

      const warnings: HTMLElement[] = [];
      if (r.flags.length) warnings.push(notice(`${plural(r.flags.length, "possible keying error")} (swapped digits, a slipped digit, a misplaced decimal point or a flipped sign). See the Note column.`, "warning"));
      if (r.sumCapped.length || r.sumBudgetExhausted)
        warnings.push(notice(`The split-payment search stopped early${r.sumCapped.length ? ` for ${plural(r.sumCapped.length, "line")}` : ""}${r.sumBudgetExhausted ? " and ran out of time for the rest" : ""}, so a split match may still exist. Fewer lines per split or a narrower date window helps.`, "warning"));
      if (st.last!.bad) warnings.push(notice(`${plural(st.last!.bad, "value")} couldn't be read as an amount or a date and ${st.last!.bad === 1 ? "was" : "were"} left blank. Check the columns in step 1.`, "warning"));

      // why don't these match?
      whyA.setAttribute("aria-label", `Row in ${nameA}`);
      whyB.setAttribute("aria-label", `Row in ${nameB}`);
      whyA.addEventListener("input", () => (st.why.a = whyA.value.trim()));
      whyB.addEventListener("input", () => (st.why.b = whyB.value.trim()));
      const out = el("div", { className: "rc-why-out" });
      out.setAttribute("aria-live", "polite");
      const explainPair = () => {
        const ra = a.find((x) => x.row === Number(whyA.value));
        const rb = b.find((x) => x.row === Number(whyB.value));
        if (!ra || !rb) {
          out.replaceChildren(notice(`There's no data in ${!ra ? `${nameA} row ${whyA.value || "?"}` : `${nameB} row ${whyB.value || "?"}`}.`, "warning"));
          return;
        }
        const e = explain(ra, rb, st.settings);
        const kids: Node[] = [notice(e.rule ? `These match by: ${RULE_LABEL[e.rule]}.` : "These don't match with the current rules.", e.rule ? "success" : "info")];
        if (e.reasons.length) kids.push(el("ul", { className: "rc-reasons" }, ...e.reasons.map((x) => el("li", { textContent: x.text }))));
        if (e.normalised && e.normalised[0] !== e.normalised[1]) kids.push(el("p", { className: "tk-muted", textContent: `Tidied references: ${e.normalised[0] || "(empty)"} / ${e.normalised[1] || "(empty)"}` }));
        if (e.suggestion) {
          const sg = e.suggestion;
          kids.push(
            el(
              "div",
              { className: "rc-suggest" },
              el("span", { textContent: `Suggestion: ${sg.text}` }),
              button("Apply and match again", () => {
                Object.assign(st.settings, { ...sg.settings, passes: { ...st.settings.passes, ...sg.settings.passes } });
                const ra2 = readSide(wb.get(st.idA).source, st.mapA);
                const rb2 = readSide(wb.get(st.idB).source, st.mapB);
                const t0 = performance.now();
                st.last = { r: reconcile(ra2.records, rb2.records, st.settings), a: ra2.records, b: rb2.records, bad: ra2.bad + rb2.bad, ms: performance.now() - t0 };
                st.added = false;
                showResults(d, st);
              }, "secondary"),
            ),
          );
        }
        out.replaceChildren(...kids);
      };
      const whyBox = section(
        "Why don't these match?",
        el("p", { className: "tk-muted", textContent: "Click a line in each list (or type the row numbers) to see which rule stops them matching." }),
        el("div", { className: "rc-why" }, field(nameA, whyA), field(nameB, whyB), button("Explain", explainPair, "secondary")),
        out,
      );
      if (st.why.a && st.why.b) explainPair();

      p.body.append(head, ...warnings, tb.element, whyBox);

      const edit = button("Edit setup", () => openSetup(d, st, 0), "secondary");
      edit.classList.add("tk-spacer");
      const create = button(st.added ? "Results sheets added" : "Create results sheets", async () => {
        if (!st.last) return;
        create.disabled = true;
        const sheets = reconSheets(st.last.r, st.last.a, st.last.b);
        for (const sh of sheets) {
          const source = new EditableSource(new Table(sh.columns), 10);
          await d.run({ type: "sheet.insert", params: { name: sh.name, source: d.putBlob(source), numFmts: sh.numFmts } });
        }
        st.added = true;
        create.textContent = "Results sheets added";
        report(d.status, `Added ${sheets.length} results sheets: ${sheets.map((x) => x.name).join(", ")}`);
      }, "primary");
      create.disabled = st.added;
      p.footer.append(el("div", { className: "tk-panel-actions" }, edit, create));
    },
  });
}
