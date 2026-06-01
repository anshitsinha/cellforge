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

export interface ReconDeps {
  workbook: () => Workbook;
  /** id of the sheet on screen */
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

/** What a mapped column is used for. */
export type ReconRole = "key" | "amount" | "minus" | "date" | "text";
export const RECON_ROLES: readonly ReconRole[] = ["key", "amount", "minus", "date", "text"];
const ROLE_LABEL: Record<ReconRole, string> = {
  key: "Reference",
  amount: "Amount",
  minus: "Minus column (credits)",
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

const money = (n: number) => formatValue(n, "#,##0.00;-#,##0.00").text;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function openRecon(d: ReconDeps): void {
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  if (visible.length < 2) {
    d.status("Reconciling needs two sheets: open or paste the other side into a second sheet first.");
    return;
  }
  const active = d.activeSheet();
  let idA = visible.some((s) => s.id === active) ? active : visible[0].id;
  let idB = visible.find((s) => s.id !== idA)!.id;
  let mapA = guessMap(wb.get(idA).source);
  let mapB = guessMap(wb.get(idB).source);
  const settings: RecSettings = { ...DEFAULT_REC_SETTINGS, passes: { ...DEFAULT_REC_SETTINGS.passes } };
  let last: { r: RecResult; a: RecRecord[]; b: RecRecord[] } | null = null;
  const whyRows = { a: "", b: "" };

  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog recon-dialog" role="dialog" aria-label="Reconcile two sheets"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  type Props = { textContent?: string; className?: string; type?: string; value?: string; checked?: boolean; inputMode?: string; placeholder?: string };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
    const e: HTMLElementTagNameMap[K] = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  };
  const h = el("h3", { textContent: "Reconcile two sheets" });
  const intro = el("p", {
    className: "hp-muted",
    textContent: "Pick the two sides and say which column is which (guesses are filled in). Matching runs in passes, strictest first; each pass only sees what the earlier ones left.",
  });

  // sheets and column mapping
  const mapTable = el("table", { className: "cleanup-cols recon-map" });
  const sheetSelect = (side: "A" | "B") => {
    const sel = el("select");
    sel.setAttribute("aria-label", `Sheet for side ${side}`);
    for (const s of visible) sel.append(new Option(s.name, s.id, false, s.id === (side === "A" ? idA : idB)));
    sel.addEventListener("change", () => {
      if (side === "A") {
        idA = sel.value;
        mapA = guessMap(wb.get(idA).source);
      } else {
        idB = sel.value;
        mapB = guessMap(wb.get(idB).source);
      }
      stale();
      renderMap();
    });
    return sel;
  };
  const renderMap = () => {
    mapTable.replaceChildren();
    const head = el("tr", {}, el("th"), el("th", {}, "Side A ", sheetSelect("A")), el("th", {}, "Side B ", sheetSelect("B")));
    mapTable.append(head);
    const namesA = sheetHeader(wb.get(idA).source).names;
    const namesB = sheetHeader(wb.get(idB).source).names;
    for (const role of RECON_ROLES) {
      const tr = el("tr", {}, el("td", { textContent: ROLE_LABEL[role] }));
      for (const [map, names, side] of [
        [mapA, namesA, "A"],
        [mapB, namesB, "B"],
      ] as const) {
        const sel = el("select");
        sel.setAttribute("aria-label", `${ROLE_LABEL[role]} column for side ${side}`);
        sel.append(new Option("(none)", "-1", false, map[role] < 0));
        names.forEach((n, c) => sel.append(new Option(n, String(c), false, map[role] === c)));
        sel.addEventListener("change", () => {
          map[role] = Number(sel.value);
          stale();
        });
        tr.append(el("td", {}, sel));
      }
      mapTable.append(tr);
    }
  };

  // tolerances and passes
  const numInput = (label: string, value: string, hint: string, onChange: (v: string) => void) => {
    const input = el("input", { type: "text", value, inputMode: "decimal" });
    input.addEventListener("change", () => {
      onChange(input.value.trim());
      stale();
    });
    return { label: el("label", {}, label, input, el("small", { textContent: hint })), input };
  };
  const tolAbs = numInput("Amount tolerance", String(settings.amountTolerance), "e.g. 0.01", (v) => (settings.amountTolerance = Math.max(0, Number(v) || 0)));
  const tolPct = numInput("Or percent", String(settings.amountTolerancePct), "the larger applies", (v) => (settings.amountTolerancePct = Math.max(0, Number(v) || 0)));
  const win = numInput("Date window ± days", String(settings.dateWindow ?? ""), "blank ignores dates", (v) => (settings.dateWindow = v === "" || Number.isNaN(Number(v)) ? null : Math.max(0, Math.floor(Number(v)))));
  const fuzzy = numInput("Description match %", String(Math.round(settings.fuzzyThreshold * 100)), "for the fuzzy pass", (v) => (settings.fuzzyThreshold = Math.min(100, Math.max(1, Number(v) || 85)) / 100));
  const sumMax = numInput("Sum up to items", String(settings.sumMaxItems), "2 to 6", (v) => (settings.sumMaxItems = Math.min(6, Math.max(2, Math.floor(Number(v)) || 3))));
  const opts = el("div", { className: "import-options" }, tolAbs.label, tolPct.label, win.label, fuzzy.label, sumMax.label);

  const check = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const box = el("input", { type: "checkbox", checked: get() });
    box.addEventListener("change", () => {
      set(box.checked);
      stale();
    });
    return { label: el("label", { className: "opt-check" }, box, label), box };
  };
  const flip = check("B amounts have the opposite sign", () => settings.flipB, (v) => (settings.flipB = v));
  const passBoxes: Array<[keyof RecSettings["passes"], string]> = [
    ["exact", "Same reference and amount"],
    ["tolerance", "Same reference, within tolerance"],
    ["reference", "Normalised reference (case, spaces, punctuation, leading zeros, INV/REF)"],
    ["fuzzy", "Similar description"],
    ["amountDate", "Amount and date only"],
    ["sum", "Sums (one to many, many to one)"],
  ];
  const passChecks = passBoxes.map(([k, label]) => ({ k, ...check(label, () => settings.passes[k], (v) => (settings.passes[k] = v)) }));
  const passes = el("fieldset", { className: "recon-passes" }, el("legend", { textContent: "Passes, in order" }), ...passChecks.map((p) => p.label));
  const signRow = el("div", { className: "import-options" }, flip.label);

  // results and explain
  const result = el("div", { className: "recon-result" });
  const why = el("div", { className: "recon-why" });
  body.append(h, intro, mapTable, opts, signRow, passes, result, why);

  const syncInputs = () => {
    tolAbs.input.value = String(settings.amountTolerance);
    tolPct.input.value = String(settings.amountTolerancePct);
    win.input.value = settings.dateWindow === null ? "" : String(settings.dateWindow);
    flip.box.checked = settings.flipB;
    for (const p of passChecks) p.box.checked = settings.passes[p.k];
  };

  const actions = el("div", { className: "numfmt-actions" });
  actions.innerHTML = `<button type="button" data-act="cancel">Close</button><button type="button" data-act="match">Match</button><button type="button" data-act="add" disabled>Add result sheets</button>`;
  body.append(actions);
  const addBtn = actions.querySelector<HTMLButtonElement>("[data-act=add]")!;

  function stale() {
    if (!last) return;
    last = null;
    addBtn.disabled = true;
    result.replaceChildren(el("p", { className: "hp-muted", textContent: "Settings changed: press Match again." }));
    why.replaceChildren();
  }

  const runMatch = () => {
    if (idA === idB) {
      result.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick two different sheets." }));
      return;
    }
    for (const [map, side] of [
      [mapA, "A"],
      [mapB, "B"],
    ] as const) {
      if (map.key < 0 && map.amount < 0 && map.text < 0) {
        result.replaceChildren(el("p", { className: "cleanup-warn", textContent: `Side ${side} needs at least a reference, an amount or a description column.` }));
        return;
      }
    }
    d.status("Reconciling…");
    const t0 = performance.now();
    const sa = readSide(wb.get(idA).source, mapA);
    const sb = readSide(wb.get(idB).source, mapB);
    const r = reconcile(sa.records, sb.records, settings);
    const ms = performance.now() - t0;
    last = { r, a: sa.records, b: sb.records };
    d.status("Ready");
    renderSummary(r, sa.bad + sb.bad, ms);
    renderWhy();
    addBtn.disabled = false;
  };

  const renderSummary = (r: RecResult, bad: number, ms: number) => {
    const s = r.summary;
    const nameA = wb.get(idA).name;
    const nameB = wb.get(idB).name;
    const p = (t: string, cls?: string) => el("p", { textContent: t, className: cls ?? "" });
    const table = el("table", { className: "cleanup-cols" });
    table.append(el("tr", {}, el("th", { textContent: "Result" }), el("th", { textContent: `A (${nameA})` }), el("th", { textContent: `B (${nameB})` }), el("th", { textContent: "Groups" })));
    const row = (label: string, a: string, b: string, n: string, cls = "") => {
      const tr = el("tr", { className: cls }, el("td", { textContent: label }), el("td", { textContent: a }), el("td", { textContent: b }), el("td", { textContent: n }));
      table.append(tr);
    };
    for (const rule of Object.keys(RULE_LABEL) as RecRule[]) {
      const groups = r.matches.filter((m) => m.rule === rule);
      if (!groups.length) continue;
      row(RULE_LABEL[rule], groups.reduce((t, g) => t + g.a.length, 0).toLocaleString(), groups.reduce((t, g) => t + g.b.length, 0).toLocaleString(), groups.length.toLocaleString());
    }
    row("Mismatched (same reference, amount or date off)", s.mismatched.toLocaleString(), s.mismatched.toLocaleString(), "", s.mismatched ? "recon-warn-row" : "");
    row("Unmatched", s.unmatchedA.toLocaleString(), s.unmatchedB.toLocaleString(), "", s.unmatchedA || s.unmatchedB ? "recon-warn-row" : "");
    row("Unmatched total", money(s.unmatchedTotalA), money(s.unmatchedTotalB), "");
    row("Duplicates within the side (groups)", s.duplicatesA.toLocaleString(), s.duplicatesB.toLocaleString(), "");
    const wrap = el("div", { className: "import-preview" }, table);
    const kids: Node[] = [
      p(`${pct(s.matchRate)} matched: ${s.matchedA.toLocaleString()} of ${s.countA.toLocaleString()} in A, ${s.matchedB.toLocaleString()} of ${s.countB.toLocaleString()} in B (${Math.round(ms).toLocaleString()} ms).`),
      wrap,
    ];
    if (r.flags.length) kids.push(p(`${r.flags.length.toLocaleString()} possible keying error${r.flags.length === 1 ? "" : "s"} (swapped digits, a slipped digit, a misplaced decimal point, a flipped sign); see the Note columns.`, "cleanup-warn"));
    if (r.sumCapped.length || r.sumBudgetExhausted)
      kids.push(p(`The sum search stopped early${r.sumCapped.length ? ` for ${r.sumCapped.length.toLocaleString()} item${r.sumCapped.length === 1 ? "" : "s"}` : ""}${r.sumBudgetExhausted ? " and ran out of time for the rest" : ""}: a sum match may still exist. Fewer items per sum or a narrower date window helps.`, "cleanup-warn"));
    if (bad) kids.push(p(`${bad.toLocaleString()} value${bad === 1 ? "" : "s"} couldn't be read as an amount or a date and were left blank.`, "cleanup-warn"));
    result.replaceChildren(...kids);
  };

  // "Why don't these match?"
  const renderWhy = () => {
    const rowA = el("input", { type: "text", inputMode: "numeric", placeholder: "row" });
    const rowB = el("input", { type: "text", inputMode: "numeric", placeholder: "row" });
    rowA.setAttribute("aria-label", "Row in side A");
    rowB.setAttribute("aria-label", "Row in side B");
    rowA.value = whyRows.a;
    rowB.value = whyRows.b;
    rowA.addEventListener("input", () => (whyRows.a = rowA.value.trim()));
    rowB.addEventListener("input", () => (whyRows.b = rowB.value.trim()));
    const go = el("button", { type: "button", textContent: "Explain" });
    const out = el("div", { className: "recon-why-out" });
    const find = (recs: RecRecord[], v: string) => recs.find((x) => x.row === Number(v));
    go.addEventListener("click", () => {
      if (!last) return;
      const a = find(last.a, rowA.value);
      const b = find(last.b, rowB.value);
      if (!a || !b) {
        out.replaceChildren(el("p", { className: "cleanup-warn", textContent: `There's no data in ${!a ? `A row ${rowA.value || "?"}` : `B row ${rowB.value || "?"}`}.` }));
        return;
      }
      const e = explain(a, b, settings);
      const kids: Node[] = [];
      kids.push(el("p", { textContent: e.rule ? `These match by: ${RULE_LABEL[e.rule]}.` : "These don't match with the current settings." }));
      if (e.reasons.length) kids.push(el("ul", {}, ...e.reasons.map((r) => el("li", { textContent: r.text }))));
      if (e.normalised && e.normalised[0] !== e.normalised[1]) kids.push(el("p", { className: "hp-muted", textContent: `Normalised references: ${e.normalised[0] || "(empty)"} / ${e.normalised[1] || "(empty)"}` }));
      if (e.suggestion) {
        const apply = el("button", { type: "button", textContent: "Apply and match again" });
        apply.addEventListener("click", () => {
          const sg = e.suggestion!.settings;
          Object.assign(settings, { ...sg, passes: { ...settings.passes, ...sg.passes } });
          syncInputs();
          runMatch();
        });
        kids.push(el("p", { className: "recon-suggest" }, `Suggestion: ${e.suggestion.text} `, apply));
      }
      out.replaceChildren(...kids);
    });
    why.replaceChildren(
      el("h3", { textContent: "Why don't these match?" }),
      el("div", { className: "import-options" }, el("label", {}, "A row", rowA), el("label", {}, "B row", rowB), go),
      out,
    );
    if (whyRows.a && whyRows.b) go.click();
  };

  const addSheets = async () => {
    if (!last) return;
    const sheets = reconSheets(last.r, last.a, last.b);
    back.remove();
    for (const s of sheets) {
      const source = new EditableSource(new Table(s.columns), 10);
      await d.run({ type: "sheet.insert", params: { name: s.name, source: d.putBlob(source), numFmts: s.numFmts } });
    }
    const sm = last.r.summary;
    d.status(`Reconciled: ${pct(sm.matchRate)} matched, ${sm.mismatched} mismatched, ${sm.unmatchedA} unmatched in A, ${sm.unmatchedB} in B`);
    d.focusGrid();
  };

  const close = () => {
    back.remove();
    d.focusGrid();
  };
  actions.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "cancel") close();
    else if (act === "match") runMatch();
    else if (act === "add") void addSheets();
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  renderMap();
  document.body.append(back);
  actions.querySelector<HTMLButtonElement>("[data-act=match]")!.focus();
}
