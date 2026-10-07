/**
 * Joins and compares across sheets: join two sheets on a key (the join
 * doctor checks the keys first), compare two versions of a file by key,
 * compare two trial balances, tie a GL out to a TB, and apply (or build) a
 * mapping table.
 */
import "./joindialog.css";
import type { Action } from "@cellforge/actions";
import { buildTb, formatValue, parseNumberLoose, readTb, Table, type ColumnData } from "@cellforge/core";
import {
  applyMapping,
  buildMapping,
  compareByKey,
  glToTb,
  join,
  joinDoctor,
  NORMALISE_LABEL,
  NORMALISE_OPTIONS,
  suggestMapping,
  tbCompare,
  textNumber,
  whyKeys,
  type CompareResult,
  type DoctorResult,
  type GlLine,
  type JoinKind,
  type JoinResult,
  type KeyNormalise,
  type KeyValue,
  type ManyPolicy,
  type MappingMatch,
  type TbAccount,
  type TbCompareResult,
  type TieResult,
} from "@cellforge/core";
import { setCells } from "./actions";
import { sheetText } from "./cleanup";
import { EditableSource } from "./editable";
import { needTwoSheets, pickSides, sheetHeader } from "./recondialog";
import { toolDialog } from "./toolkit";
import type { Workbook } from "./workbook";

export interface JoinDeps {
  workbook: () => Workbook;
  /** id of the sheet on screen */
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

// ------------------------------------------------------------ helpers --

export interface ResultSheet {
  name: string;
  columns: ColumnData[];
  numFmts: string[];
}

const MONEY = "#,##0.00;(#,##0.00)";
const PCT = "0.0%";

/** A column of values: numbers when every value is a number or blank, text otherwise. */
export function toColumn(name: string, values: ReadonlyArray<KeyValue>): ColumnData {
  let numeric = true;
  for (const v of values) {
    if (v !== null && v !== undefined && v !== "" && typeof v !== "number") {
      numeric = false;
      break;
    }
  }
  if (numeric) return { kind: "number", name, values: Float64Array.from(values, (v) => (typeof v === "number" ? v : NaN)) };
  const dict: string[] = [];
  const lookup = new Map<string, number>();
  const codes = Uint32Array.from(values, (v) => {
    if (v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) return 0;
    const s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
    let c = lookup.get(s);
    if (c === undefined) {
      c = dict.push(s);
      lookup.set(s, c);
    }
    return c;
  });
  return { kind: "string", name, codes, dict };
}

/** Values of one column, from the first data row down. */
export function readColumn(src: EditableSource, c: number, first = sheetHeader(src).first): KeyValue[] {
  const { rows } = src.usedRange();
  const out: KeyValue[] = new Array(Math.max(0, rows - first));
  for (let r = first; r < rows; r++) out[r - first] = src.getCell(r, c);
  return out;
}

/** The number format a column shows in its first data row ("" for none). */
function colFormat(src: EditableSource, c: number, first: number): string {
  return src.getStyle(first, c)?.numFmt ?? "";
}

const KEYISH = /\b(id|code|key|ref|reference|no|number|num|account|acct|invoice|customer|supplier|vendor|employee|sku|item)\b|#|_id$|id$/i;

/**
 * The most likely key columns for joining A to B: the pair whose values
 * overlap most (on a sample, ignoring case, spaces and numbers stored as
 * text), with a nudge for the same header name or an ID-like one.
 */
// dates and amounts overlap between any two ledgers but are not keys
const DATEY = /date|posted|period|\bday\b|amount|\bamt\b|debit|credit|balance|\btotal\b|\bvalue\b/i;

export function guessKeyPair(a: EditableSource, b: EditableSource): [number, number] {
  const ha = sheetHeader(a);
  const hb = sheetHeader(b);
  const sample = (src: EditableSource, first: number, c: number) => {
    const rows = Math.min(src.usedRange().rows, first + 2000);
    const set = new Set<string>();
    let filled = 0;
    for (let r = first; r < rows; r++) {
      const v = src.getCell(r, c);
      if (v === null || v === "") continue;
      filled++;
      set.add(typeof v === "number" ? String(v) : String(v).trim().toUpperCase().replace(/^0+(?=\d)/, ""));
    }
    return { set, filled };
  };
  const colsA = ha.names.slice(0, 40).map((_, c) => sample(a, ha.first, c));
  const colsB = hb.names.slice(0, 40).map((_, c) => sample(b, hb.first, c));
  let best: [number, number] = [0, 0];
  let bestScore = -1;
  colsA.forEach((sa, i) => {
    if (!sa.filled) return;
    colsB.forEach((sb, j) => {
      if (!sb.filled) return;
      let hits = 0;
      for (const v of sa.set) if (sb.set.has(v)) hits++;
      const overlap = hits / Math.min(sa.set.size, sb.set.size);
      // distinct values make better keys than repeated ones ("Yes"/"No")
      const uniq = Math.min(sa.set.size / sa.filled, sb.set.size / sb.filled);
      const sameName = ha.names[i].trim().toLowerCase() === hb.names[j].trim().toLowerCase() ? 0.3 : 0;
      const keyish = KEYISH.test(ha.names[i]) && KEYISH.test(hb.names[j]) ? 0.1 : 0;
      // dates overlap between any two ledgers but are not keys
      const datey = DATEY.test(ha.names[i]) || DATEY.test(hb.names[j]) ? 0.5 : 0;
      const score = overlap * (0.5 + 0.5 * uniq) + sameName + keyish - datey;
      if (score > bestScore) {
        bestScore = score;
        best = [i, j];
      }
    });
  });
  return best;
}

export const KIND_LABEL: Record<JoinKind, string> = {
  inner: "Inner: only rows with a match on both sides",
  left: "Left: every A row, with B's columns where they match",
  right: "Right: every B row, with A's columns where they match",
  full: "Full: every row from both sides",
  anti: "Anti: A rows with no match in B",
};

export const MANY_LABEL: Record<ManyPolicy, string> = {
  all: "Keep every match (rows repeat)",
  first: "Keep the first match only",
  flag: "Keep every match and flag the repeats",
};

export interface JoinSpec {
  keysA: number[];
  keysB: number[];
  kind: JoinKind;
  normalise: KeyNormalise;
  many: ManyPolicy;
  /** 0..1, or null for no fuzzy matching */
  fuzzy: number | null;
  names: boolean;
  /** columns to bring over from each side */
  bringA: number[];
  bringB: number[];
}

/** Key columns of a sheet as arrays. */
export function keyColumns(src: EditableSource, cols: readonly number[]): KeyValue[][] {
  const first = sheetHeader(src).first;
  return cols.map((c) => readColumn(src, c, first));
}

/** Run the join and lay it out as a sheet: A's columns, B's columns, then how each row matched. */
export function joinSheet(a: EditableSource, b: EditableSource, nameA: string, nameB: string, spec: JoinSpec): { sheet: ResultSheet; result: JoinResult } {
  const result = join(keyColumns(a, spec.keysA), keyColumns(b, spec.keysB), spec.kind, {
    normalise: spec.normalise,
    many: spec.many,
    fuzzy: spec.fuzzy ?? undefined,
    fuzzyNames: spec.names,
  });
  const ha = sheetHeader(a);
  const hb = sheetHeader(b);
  const columns: ColumnData[] = [];
  const numFmts: string[] = [];
  const used = new Set<string>();
  const uniqueName = (n: string, side: string) => {
    let name = n;
    if (used.has(name.toLowerCase())) name = `${n} (${side})`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${n} (${side} ${i})`;
    used.add(name.toLowerCase());
    return name;
  };
  const pick = (src: EditableSource, first: number, c: number, idx: Int32Array) => {
    const out: KeyValue[] = new Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = idx[i] < 0 ? null : src.getCell(idx[i] + first, c);
    return out;
  };
  for (const c of spec.bringA) {
    columns.push(toColumn(uniqueName(ha.names[c], nameA), pick(a, ha.first, c, result.left)));
    numFmts.push(colFormat(a, c, ha.first));
  }
  if (spec.kind !== "anti") {
    for (const c of spec.bringB) {
      columns.push(toColumn(uniqueName(hb.names[c], nameB), pick(b, hb.first, c, result.right)));
      numFmts.push(colFormat(b, c, hb.first));
    }
  }
  const how: string[] = new Array(result.rows);
  for (let i = 0; i < result.rows; i++) {
    const s = result.score[i];
    let t = result.left[i] < 0 ? `only in ${nameB}` : result.right[i] < 0 ? `only in ${nameA}` : s >= 1 ? "match" : `fuzzy ${Math.round(s * 100)}%`;
    if (result.flag[i]) t += spec.many === "first" ? "; more matches left out" : "; one of several matches";
    how[i] = t;
  }
  columns.push(toColumn(uniqueName("Match", "join"), how));
  numFmts.push("");
  const rowsA = new Float64Array(result.rows);
  const rowsB = new Float64Array(result.rows);
  for (let i = 0; i < result.rows; i++) {
    rowsA[i] = result.left[i] < 0 ? NaN : result.left[i] + ha.first + 1;
    rowsB[i] = result.right[i] < 0 ? NaN : result.right[i] + hb.first + 1;
  }
  columns.push({ kind: "number", name: uniqueName(`${nameA} row`, "join"), values: rowsA });
  numFmts.push("");
  if (spec.kind !== "anti") {
    columns.push({ kind: "number", name: uniqueName(`${nameB} row`, "join"), values: rowsB });
    numFmts.push("");
  }
  return { sheet: { name: `Join ${nameA} + ${nameB}`, columns, numFmts }, result };
}

/** Columns of two versions paired by header name (case and spaces ignored), in the old file's order. */
export function pairColumns(oldNames: readonly string[], newNames: readonly string[]): Array<[number, number]> {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const byName = new Map<string, number>();
  newNames.forEach((n, i) => {
    if (!byName.has(norm(n))) byName.set(norm(n), i);
  });
  const out: Array<[number, number]> = [];
  oldNames.forEach((n, i) => {
    const j = byName.get(norm(n));
    if (j !== undefined) out.push([i, j]);
  });
  return out;
}

export interface CompareSpec {
  /** pairs of [old column, new column] used as the key */
  keys: Array<[number, number]>;
  /** pairs compared for changes */
  compare: Array<[number, number]>;
  tolerance: number;
  ignoreCase: boolean;
  trim: boolean;
  normalise: KeyNormalise;
}

/** Compare two sheets by key; each row is reduced to [keys..., compared...] first. */
export function compareSheets(oldSrc: EditableSource, newSrc: EditableSource, spec: CompareSpec): CompareResult {
  const ho = sheetHeader(oldSrc);
  const hn = sheetHeader(newSrc);
  const rowsOf = (src: EditableSource, first: number, side: 0 | 1) => {
    const cols = [...spec.keys, ...spec.compare].map((p) => p[side]);
    const n = Math.max(0, src.usedRange().rows - first);
    const rows: KeyValue[][] = new Array(n);
    for (let r = 0; r < n; r++) rows[r] = cols.map((c) => src.getCell(r + first, c));
    return rows;
  };
  const k = spec.keys.length;
  return compareByKey(
    rowsOf(oldSrc, ho.first, 0),
    rowsOf(newSrc, hn.first, 1),
    spec.keys.map((_, i) => i),
    spec.compare.map((_, i) => k + i),
    { tolerance: spec.tolerance, ignoreCase: spec.ignoreCase, trim: spec.trim, normalise: spec.normalise },
  );
}

/** The compare result as three sheets: added rows, removed rows, and changes (one row per changed cell). */
export function compareResultSheets(oldSrc: EditableSource, newSrc: EditableSource, spec: CompareSpec, r: CompareResult): ResultSheet[] {
  const ho = sheetHeader(oldSrc);
  const hn = sheetHeader(newSrc);
  const whole = (src: EditableSource, h: { names: string[]; first: number }, rows: number[], label: string, name: string): ResultSheet => {
    const columns: ColumnData[] = [{ kind: "number", name: label, values: Float64Array.from(rows, (x) => x + h.first + 1) }];
    const numFmts = [""];
    h.names.forEach((n, c) => {
      columns.push(toColumn(n, rows.map((x) => src.getCell(x + h.first, c))));
      numFmts.push(colFormat(src, c, h.first));
    });
    return { name, columns, numFmts };
  };
  const added = whole(newSrc, hn, r.added, "New row", "Compare added");
  const removed = whole(oldSrc, ho, r.removed, "Old row", "Compare removed");
  // changed: key columns, which column, old, new, difference, rows
  const keyVals: KeyValue[][] = spec.keys.map(() => []);
  const col: string[] = [];
  const oldV: KeyValue[] = [];
  const newV: KeyValue[] = [];
  const diff: Array<number | null> = [];
  const oldRow: number[] = [];
  const newRow: number[] = [];
  const k = spec.keys.length;
  for (const ch of r.changed) {
    for (const cell of ch.cells) {
      spec.keys.forEach(([oc], i) => keyVals[i].push(oldSrc.getCell(ch.old + ho.first, oc)));
      col.push(ho.names[spec.compare[cell.col - k][0]]);
      oldV.push(cell.old);
      newV.push(cell.new);
      diff.push(cell.diff);
      oldRow.push(ch.old + ho.first + 1);
      newRow.push(ch.new + hn.first + 1);
    }
  }
  // old and new values side by side: text when either side has text
  const mixed = [...oldV, ...newV].some((v) => typeof v === "string" && v !== "");
  const asText = (vs: KeyValue[]) => (mixed ? vs.map((v) => (v === null || v === undefined ? null : String(v))) : vs);
  const changed: ResultSheet = {
    name: "Compare changed",
    columns: [
      ...spec.keys.map(([oc], i) => toColumn(ho.names[oc], keyVals[i])),
      toColumn("Column", col),
      toColumn("Old", asText(oldV)),
      toColumn("New", asText(newV)),
      { kind: "number", name: "Difference", values: Float64Array.from(diff, (x) => (x === null ? NaN : x)) },
      { kind: "number", name: "Old row", values: Float64Array.from(oldRow) },
      { kind: "number", name: "New row", values: Float64Array.from(newRow) },
    ],
    numFmts: [...spec.keys.map(([oc]) => colFormat(oldSrc, oc, ho.first)), "", "", "", "", "", ""],
  };
  return [added, removed, changed];
}

/** A sheet read as a trial balance (header row found, roles guessed, lines built). */
export function readTbSheet(src: EditableSource): { lines: TbAccount[]; hasPrior: boolean; bad: number; balances: boolean } {
  const t = readTb(sheetText(src));
  const tb = buildTb(t.rows, t.roles);
  return { lines: tb.lines, hasPrior: tb.totalPrior !== null, bad: tb.bad.length, balances: tb.balances };
}

export function tbCompareSheet(r: TbCompareResult, nameA: string, nameB: string): ResultSheet {
  return {
    name: "TB compare",
    columns: [
      toColumn("Account", r.lines.map((l) => l.account)),
      toColumn("Name", r.lines.map((l) => l.name)),
      toColumn(nameA, r.lines.map((l) => l.a)),
      toColumn(nameB, r.lines.map((l) => l.b)),
      toColumn("Movement", r.lines.map((l) => l.movement)),
      toColumn("Movement %", r.lines.map((l) => l.pct)),
      toColumn("Status", r.lines.map((l) => (l.status === "both" ? "" : l.status === "only A" ? `only in ${nameA}` : `only in ${nameB}`))),
      toColumn(`Name in ${nameB}`, r.lines.map((l) => l.renamed ?? "")),
    ],
    numFmts: ["", "", MONEY, MONEY, MONEY, PCT, "", ""],
  };
}

export type GlRole = "account" | "amount" | "debit" | "credit";
export type GlMap = Record<GlRole, number>;

/** Which GL columns hold the account, a signed amount, or debit and credit. */
export function guessGlMap(names: readonly string[]): GlMap {
  const find = (re: RegExp, not = -1) => names.findIndex((n, i) => i !== not && re.test(n));
  const account = find(/account|acct|\bgl\b|nominal|ledger code|\bcode\b/i);
  const debit = find(/^\s*(dr|debit)s?\b|debit/i);
  const credit = find(/^\s*(cr|credit)s?\b|credit/i);
  const amount = debit >= 0 && credit >= 0 ? -1 : find(/amount|amt|value|net|balance/i, account);
  return { account, amount, debit, credit };
}

/** GL lines from a sheet with the columns mapped. */
export function readGl(src: EditableSource, map: GlMap): { lines: GlLine[]; bad: number } {
  const { first } = sheetHeader(src);
  const { rows } = src.usedRange();
  let bad = 0;
  const num = (r: number, c: number): number | null => {
    if (c < 0) return null;
    const v = src.getCell(r, c);
    if (typeof v === "number") return v;
    if (typeof v !== "string" || !v.trim()) return null;
    const n = parseNumberLoose(v);
    if (n === null) bad++;
    return n;
  };
  const lines: GlLine[] = [];
  for (let r = first; r < rows; r++) {
    const acc = src.getCell(r, map.account);
    if (acc === null || acc === "") continue;
    lines.push({ account: String(acc), amount: num(r, map.amount), debit: num(r, map.debit), credit: num(r, map.credit) });
  }
  return { lines, bad };
}

export function tieSheet(r: TieResult): ResultSheet {
  return {
    name: "GL to TB",
    columns: [
      toColumn("Account", r.lines.map((l) => l.account)),
      toColumn("Name", r.lines.map((l) => l.name)),
      toColumn("GL total", r.lines.map((l) => l.gl)),
      toColumn("GL lines", r.lines.map((l) => l.glLines)),
      toColumn("TB", r.lines.map((l) => l.tb)),
      toColumn("Difference", r.lines.map((l) => l.difference)),
      toColumn("Status", r.lines.map((l) => l.status)),
    ],
    numFmts: ["", "", MONEY, "", MONEY, MONEY, ""],
  };
}

/** Which mapping-sheet columns are "from" and "to". */
export function guessMappingCols(names: readonly string[]): [number, number] {
  const from = names.findIndex((n) => /\b(from|old|source|original|raw|alias|as written|name in)\b/i.test(n));
  const to = names.findIndex((n, i) => i !== from && /\b(to|new|target|mapped|standard|master|canonical|map to|use)\b/i.test(n));
  if (from >= 0 && to >= 0) return [from, to];
  if (from >= 0) return [from, from === 0 ? 1 : 0];
  if (to >= 0) return [to === 0 ? 1 : 0, to];
  return [0, Math.min(1, names.length - 1)];
}

/** Text for a cell as typed: numbers as they are, text kept as text (a leading ' stops "00123" turning into 123). */
export function cellInput(v: KeyValue): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return v.startsWith("=") || textNumber(v) !== null || /^[\d\s/.:-]+$/.test(v) || /^'/.test(v) ? `'${v}` : v;
}

/** Map a column through a mapping table: the cells to write and the result. */
export function mappingCells(
  values: ReadonlyArray<KeyValue>,
  pairs: ReadonlyArray<readonly [KeyValue, KeyValue]>,
  opts: { match: MappingMatch; fuzzy: number | null; keepUnmapped: boolean },
): { inputs: Array<string | null>; mapped: number; fuzzy: number; unmapped: Array<{ value: string; count: number }>; conflicts: number } {
  // "to" values keep their type: a number maps to a number
  const toOriginal = new Map<string, KeyValue>();
  const strPairs = pairs.map(([f, t]) => {
    const ts = t === null || t === undefined ? "" : String(t);
    if (!toOriginal.has(ts)) toOriginal.set(ts, t);
    return [f === null || f === undefined ? "" : String(f), ts] as const;
  });
  const table = buildMapping(strPairs, opts.match);
  const res = applyMapping(values.map((v) => (v === null || v === undefined ? null : String(v))), table, { keepUnmapped: opts.keepUnmapped, fuzzy: opts.fuzzy ?? undefined });
  const inputs = res.values.map((v, i) => {
    if (v === null) return null;
    const orig = toOriginal.has(v) ? toOriginal.get(v)! : values[i];
    return cellInput(orig);
  });
  return { inputs, mapped: res.mapped, fuzzy: res.fuzzy, unmapped: res.unmapped, conflicts: table.conflicts.length };
}

export function suggestionSheet(from: ReadonlyArray<KeyValue>, to: ReadonlyArray<KeyValue>, threshold: number): ResultSheet {
  const s = (xs: ReadonlyArray<KeyValue>) => xs.map((x) => (x === null || x === undefined ? null : String(x)));
  const pairs = suggestMapping(s(from), s(to), threshold);
  return {
    name: "Mapping table",
    columns: [toColumn("From", pairs.map((p) => p.from)), toColumn("To", pairs.map((p) => p.to)), toColumn("Score", pairs.map((p) => Math.round(p.score * 1000) / 1000))],
    numFmts: ["", "", PCT],
  };
}

// ---------------------------------------------------------------- UI --

const money = (n: number) => formatValue(n, "#,##0.00;-#,##0.00").text;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

type Props = { textContent?: string; className?: string; type?: string; value?: string; checked?: boolean; inputMode?: string; placeholder?: string; disabled?: boolean; title?: string };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const e: HTMLElementTagNameMap[K] = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
};

interface Shell {
  back: { remove(): void };
  body: HTMLElement;
  button: (label: string, act: () => void, disabled?: boolean) => HTMLButtonElement;
  close: () => void;
  show: (focus?: HTMLElement) => void;
}

/**
 * A tool dialog on the shared dialog: fixed header and footer, the body
 * scrolls. The last enabled button in the footer is the primary one (so
 * "Compare" leads until there's a result, then "Add result sheets").
 */
function shell(d: JoinDeps, title: string, intro: string): Shell {
  const dlg = toolDialog({ title, size: "lg", onClose: () => d.focusGrid(), className: "join-dialog tk-legacy" });
  dlg.body.append(el("p", { className: "tk-muted", textContent: intro }));
  const mine: HTMLButtonElement[] = [];
  const restyle = () => {
    const lead = [...mine].reverse().find((b) => !b.disabled) ?? mine[mine.length - 1];
    for (const b of mine) b.className = b === lead ? "btn-primary" : "btn-secondary";
  };
  const watch = new MutationObserver(restyle);
  const button = (label: string, act: () => void, disabled = false) => {
    const b = dlg.button(label, act, { kind: "secondary", disabled });
    dlg.handle.footer.append(b);
    mine.push(b);
    watch.observe(b, { attributes: true, attributeFilter: ["disabled"] });
    restyle();
    return b;
  };
  const close = () => {
    watch.disconnect();
    dlg.close();
  };
  return { back: { remove: close }, body: dlg.body, button, close, show: (focus) => (focus ?? mine[0])?.focus() };
}

function visibleSheets(d: JoinDeps, need: number, what: string): { wb: Workbook; ids: string[]; first: string; second: string } | null {
  const wb = d.workbook();
  const visible = wb.sheets.filter((s) => !s.hidden);
  if (visible.length < need) {
    needTwoSheets(need === 2 ? "Two sheets needed" : "A sheet is needed", what);
    return null;
  }
  const active = d.activeSheet();
  // sheets with a table on them (not a notes or "start here" sheet)
  const [first, second] =
    visible.length >= 2
      ? pickSides(visible.map((s) => ({ id: s.id, name: s.name, amounts: s.source.usedRange().rows > 2 && sheetHeader(s.source).names.length > 1 })), active)
      : [visible[0].id, visible[0].id];
  return { wb, ids: visible.map((s) => s.id), first, second };
}

function sheetSelect(wb: Workbook, ids: readonly string[], selected: string, label: string, onChange: (id: string) => void, extra?: [string, string]): HTMLSelectElement {
  const sel = el("select");
  sel.setAttribute("aria-label", label);
  if (extra) sel.append(new Option(extra[1], extra[0], false, selected === extra[0]));
  for (const id of ids) sel.append(new Option(wb.get(id).name, id, false, id === selected));
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function colSelect(names: readonly string[], selected: number, label: string, onChange: (c: number) => void, none = true): HTMLSelectElement {
  const sel = el("select");
  sel.setAttribute("aria-label", label);
  if (none) sel.append(new Option("(none)", "-1", false, selected < 0));
  names.forEach((n, c) => sel.append(new Option(n, String(c), false, selected === c)));
  sel.addEventListener("change", () => onChange(Number(sel.value)));
  return sel;
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const box = el("input", { type: "checkbox", checked });
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { className: "opt-check" }, box, label);
}

function textInput(label: string, value: string, hint: string, onChange: (v: string) => void, mode = "decimal"): HTMLLabelElement {
  const input = el("input", { type: "text", value, inputMode: mode });
  input.addEventListener("change", () => onChange(input.value.trim()));
  return el("label", {}, label, input, el("small", { textContent: hint }));
}

function normaliseBoxes(o: KeyNormalise, onChange: () => void): HTMLFieldSetElement {
  return el(
    "fieldset",
    { className: "join-checks" },
    el("legend", { textContent: "Compare keys" }),
    ...NORMALISE_OPTIONS.map((opt) =>
      checkbox(NORMALISE_LABEL[opt], !!o[opt], (v) => {
        o[opt] = v;
        onChange();
      }),
    ),
  );
}

async function addSheets(d: JoinDeps, sheets: ResultSheet[]): Promise<void> {
  for (const s of sheets) {
    const source = new EditableSource(new Table(s.columns), 5);
    await d.run({ type: "sheet.insert", params: { name: s.name, source: d.putBlob(source), numFmts: s.numFmts } });
  }
}

const fuzzyValue = (v: string): number | null => (v === "" || Number.isNaN(Number(v)) ? null : Math.min(100, Math.max(1, Number(v))) / 100);

// ------------------------------------------------------- join dialog --

export function openJoin(d: JoinDeps): void {
  const vs = visibleSheets(d, 2, "Joining");
  if (!vs) return;
  const { wb, ids } = vs;
  let idA = vs.first;
  let idB = vs.second;
  const spec: JoinSpec = { keysA: [], keysB: [], kind: "left", normalise: {}, many: "all", fuzzy: null, names: false, bringA: [], bringB: [] };
  const src = (id: string) => wb.get(id).source;
  // a different sheet: guess the keys again and bring every column (B's key is already in A's)
  const reset = () => {
    const [ka, kb] = guessKeyPair(src(idA), src(idB));
    spec.keysA = [ka, -1, -1];
    spec.keysB = [kb, -1, -1];
    spec.bringA = sheetHeader(src(idA)).names.map((_, c) => c);
    spec.bringB = sheetHeader(src(idB)).names.map((_, c) => c).filter((c) => c !== kb);
  };
  reset();
  let doctor: DoctorResult | null = null;

  const s = shell(d, "Join two sheets", "Pick the two sheets and the key columns (guessed for you). Check the keys first: the join doctor shows how many rows find a partner, repeated keys, keys with no partner, and which fix would match more.");
  const mapTable = el("table", { className: "cleanup-cols join-map" });
  const checks = el("div");
  const doctorOut = el("div", { className: "join-result" });
  const whyOut = el("div", { className: "join-why" });
  const options = el("div", { className: "import-options" });
  const bring = el("div", { className: "join-bring" });

  const pairs = () => spec.keysA.map((a, i) => [a, spec.keysB[i]] as const).filter(([a, b]) => a >= 0 && b >= 0);
  const stale = () => {
    doctor = null;
    addBtn.disabled = true;
    doctorOut.replaceChildren(el("p", { className: "hp-muted", textContent: "Press Check keys to see how well these keys match." }));
    whyOut.replaceChildren();
  };

  const renderMap = () => {
    const na = sheetHeader(src(idA)).names;
    const nb = sheetHeader(src(idB)).names;
    mapTable.replaceChildren(
      el(
        "tr",
        {},
        el("th"),
        el("th", {}, "A ", sheetSelect(wb, ids, idA, "Sheet A", (id) => ((idA = id), reset(), renderAll()))),
        el("th", {}, "B ", sheetSelect(wb, ids, idB, "Sheet B", (id) => ((idB = id), reset(), renderAll()))),
      ),
    );
    for (let i = 0; i < 3; i++) {
      mapTable.append(
        el(
          "tr",
          {},
          el("td", { textContent: i ? `Key column ${i + 1} (optional)` : "Key column" }),
          el("td", {}, colSelect(na, spec.keysA[i], `Key column ${i + 1} in A`, (c) => ((spec.keysA[i] = c), stale()), i > 0)),
          el("td", {}, colSelect(nb, spec.keysB[i], `Key column ${i + 1} in B`, (c) => ((spec.keysB[i] = c), stale()), i > 0)),
        ),
      );
    }
  };
  const renderChecks = () => checks.replaceChildren(normaliseBoxes(spec.normalise, stale));

  const renderOptions = () => {
    const kind = el("select");
    kind.setAttribute("aria-label", "Kind of join");
    for (const k of Object.keys(KIND_LABEL) as JoinKind[]) kind.append(new Option(KIND_LABEL[k], k, false, spec.kind === k));
    kind.addEventListener("change", () => {
      spec.kind = kind.value as JoinKind;
      renderBring();
    });
    const many = el("select");
    many.setAttribute("aria-label", "When a key matches several rows");
    for (const k of Object.keys(MANY_LABEL) as ManyPolicy[]) many.append(new Option(MANY_LABEL[k], k, false, spec.many === k));
    many.addEventListener("change", () => (spec.many = many.value as ManyPolicy));
    options.replaceChildren(
      el("label", {}, "Join", kind),
      el("label", {}, "Several matches", many),
      textInput("Fuzzy match %", spec.fuzzy === null ? "" : String(Math.round(spec.fuzzy * 100)), "blank = exact only", (v) => (spec.fuzzy = fuzzyValue(v))),
      checkbox("Keys are person or company names", spec.names, (v) => (spec.names = v)),
    );
  };

  const renderBring = () => {
    const side = (names: string[], chosen: number[], label: string, set: (c: number[]) => void) => {
      const box = el("fieldset", { className: "join-checks" }, el("legend", { textContent: label }));
      names.forEach((n, c) =>
        box.append(
          checkbox(n, chosen.includes(c), (v) => {
            const next = v ? [...chosen, c].sort((x, y) => x - y) : chosen.filter((x) => x !== c);
            set(next);
            chosen = next;
          }),
        ),
      );
      return box;
    };
    const kids: Node[] = [side(sheetHeader(src(idA)).names, spec.bringA, `Columns from ${wb.get(idA).name}`, (c) => (spec.bringA = c))];
    if (spec.kind !== "anti") kids.push(side(sheetHeader(src(idB)).names, spec.bringB, `Columns from ${wb.get(idB).name}`, (c) => (spec.bringB = c)));
    bring.replaceChildren(...kids);
  };

  const renderAll = () => {
    renderMap();
    renderBring();
    stale();
  };

  const runDoctor = () => {
    if (idA === idB) {
      doctorOut.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick two different sheets." }));
      return;
    }
    const p = pairs();
    if (!p.length || spec.keysA[0] < 0 || spec.keysB[0] < 0) {
      doctorOut.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick a key column on both sides." }));
      return;
    }
    d.status("Checking keys…");
    const t0 = performance.now();
    const la = keyColumns(src(idA), p.map((x) => x[0]));
    const lb = keyColumns(src(idB), p.map((x) => x[1]));
    doctor = joinDoctor(la, lb, { normalise: spec.normalise });
    const ms = performance.now() - t0;
    d.status("Ready");
    renderDoctor(doctor, la, lb, ms);
    addBtn.disabled = false;
  };

  const renderDoctor = (r: DoctorResult, la: KeyValue[][], lb: KeyValue[][], ms: number) => {
    const nameA = wb.get(idA).name;
    const nameB = wb.get(idB).name;
    const table = el("table", { className: "cleanup-cols" });
    table.append(el("tr", {}, el("th", { textContent: "Keys" }), el("th", { textContent: `A (${nameA})` }), el("th", { textContent: `B (${nameB})` })));
    const row = (label: string, a: string, b: string, warn = false) => table.append(el("tr", { className: warn ? "join-warn-row" : "" }, el("td", { textContent: label }), el("td", { textContent: a }), el("td", { textContent: b })));
    row("Rows", r.left.rows.toLocaleString(), r.right.rows.toLocaleString());
    row("Find a partner", `${r.left.matchedRows.toLocaleString()} (${pct(r.left.matchRate)})`, `${r.right.matchedRows.toLocaleString()} (${pct(r.right.matchRate)})`);
    row("No partner (keys / rows)", `${r.left.orphanKeys.toLocaleString()} / ${r.left.orphanRows.toLocaleString()}`, `${r.right.orphanKeys.toLocaleString()} / ${r.right.orphanRows.toLocaleString()}`, !!(r.left.orphanRows || r.right.orphanRows));
    row("Repeated keys (keys / rows)", `${r.left.duplicateKeys.toLocaleString()} / ${r.left.duplicateRows.toLocaleString()}`, `${r.right.duplicateKeys.toLocaleString()} / ${r.right.duplicateRows.toLocaleString()}`, !!(r.left.duplicateKeys || r.right.duplicateKeys));
    row("Blank keys", r.left.blank.toLocaleString(), r.right.blank.toLocaleString(), !!(r.left.blank || r.right.blank));
    row("Numbers / text like numbers / text", `${r.left.numbers} / ${r.left.numericText} / ${r.left.text}`, `${r.right.numbers} / ${r.right.numericText} / ${r.right.text}`, r.typeMismatch);
    row("Spaces at the ends or doubled", r.left.padded.toLocaleString(), r.right.padded.toLocaleString(), !!(r.left.padded || r.right.padded));
    const kids: Node[] = [
      el("p", { textContent: `${r.relationship.replace(/-/g, " ")}: an inner join makes ${count(r.innerRows, "row")}, a left join ${count(r.leftRows, "row")} (${Math.round(ms).toLocaleString()} ms).` }),
      el("div", { className: "import-preview" }, table),
      el("ul", {}, ...r.issues.slice(1).map((t) => el("li", { textContent: t }))),
    ];
    if (r.fixes.length) {
      const list = el("div", { className: "join-fixes" });
      for (const f of r.fixes.slice(0, 4)) {
        const use = el("button", { type: "button", textContent: "Use" });
        use.addEventListener("click", () => {
          if (f.option === "all") for (const o of NORMALISE_OPTIONS) if (o !== "ref") spec.normalise[o] = true;
          if (f.option !== "all") spec.normalise[f.option] = true;
          renderChecks();
          runDoctor();
        });
        list.append(el("p", { className: "join-suggest" }, `${f.label}: ${pct(f.matchRateLeft)} / ${pct(f.matchRateRight)} would match (+${f.gainLeft.toLocaleString()} / +${f.gainRight.toLocaleString()} rows${f.estimated ? ", estimated" : ""}) `, use));
      }
      kids.push(list);
    }
    doctorOut.replaceChildren(...kids);
    renderWhy(r, la, lb);
  };

  // "Why don't these match?" on two keys with no partner
  const renderWhy = (r: DoctorResult, la: KeyValue[][], lb: KeyValue[][]) => {
    if (!r.left.topOrphans.length || !r.right.topOrphans.length) {
      whyOut.replaceChildren();
      return;
    }
    const pick = (side: "A" | "B", list: typeof r.left.topOrphans) => {
      const sel = el("select");
      sel.setAttribute("aria-label", `Key with no partner in ${side}`);
      list.forEach((o, i) => sel.append(new Option(`${o.key}${o.count > 1 ? ` (${o.count} rows)` : ""}`, String(i))));
      return sel;
    };
    const selA = pick("A", r.left.topOrphans);
    const selB = pick("B", r.right.topOrphans);
    const out = el("div");
    const go = el("button", { type: "button", textContent: "Explain" });
    go.addEventListener("click", () => {
      const ra = r.left.topOrphans[Number(selA.value)].row;
      const rb = r.right.topOrphans[Number(selB.value)].row;
      const w = whyKeys(la.map((c) => c[ra]), lb.map((c) => c[rb]), spec.normalise);
      const kids: Node[] = [el("ul", {}, ...w.reasons.map((t) => el("li", { textContent: t })))];
      if (w.fix && w.fix.length) {
        const apply = el("button", { type: "button", textContent: "Turn it on and check again" });
        apply.addEventListener("click", () => {
          for (const f of w.fix!) spec.normalise[f] = true;
          renderChecks();
          runDoctor();
        });
        kids.push(el("p", { className: "join-suggest" }, apply));
      } else if (!w.fix && Math.max(w.similarity, w.nameSimilarity) >= 0.8 && spec.fuzzy === null) {
        const apply = el("button", { type: "button", textContent: "Use fuzzy matching at 85%" });
        apply.addEventListener("click", () => {
          spec.fuzzy = 0.85;
          spec.names = w.nameSimilarity > w.similarity;
          renderOptions();
        });
        kids.push(el("p", { className: "join-suggest" }, apply));
      }
      out.replaceChildren(...kids);
    });
    whyOut.replaceChildren(
      el("h3", { textContent: "Why don't these match?" }),
      el("p", { className: "hp-muted", textContent: "Pick a key from each side that has no partner." }),
      el("div", { className: "import-options" }, el("label", {}, "A", selA), el("label", {}, "B", selB), go),
      out,
    );
  };

  const doJoin = async () => {
    if (!doctor) return;
    const p = pairs();
    const full: JoinSpec = { ...spec, keysA: p.map((x) => x[0]), keysB: p.map((x) => x[1]) };
    if (!full.bringA.length && !full.bringB.length) {
      doctorOut.prepend(el("p", { className: "cleanup-warn", textContent: "Pick at least one column to bring over." }));
      return;
    }
    d.status("Joining…");
    const t0 = performance.now();
    const { sheet, result } = joinSheet(src(idA), src(idB), wb.get(idA).name, wb.get(idB).name, full);
    s.back.remove();
    await addSheets(d, [sheet]);
    const extra = [result.fuzzyMatched ? `${result.fuzzyMatched.toLocaleString()} fuzzy` : "", result.capped ? "stopped at the row limit" : "", result.fuzzyCapped ? "fuzzy search stopped early" : ""].filter(Boolean).join(", ");
    d.status(`Joined: ${count(result.rows, "row")}, ${result.matchedLeft.toLocaleString()} A rows matched${extra ? ` (${extra})` : ""} in ${Math.round(performance.now() - t0).toLocaleString()} ms`);
    d.focusGrid();
  };

  s.body.append(mapTable, checks, doctorOut, whyOut, el("h3", { textContent: "Join" }), options, bring);
  const checkBtn = s.button("Check keys", runDoctor);
  const addBtn = s.button("Add joined sheet", () => void doJoin(), true);
  renderMap();
  renderChecks();
  renderOptions();
  renderBring();
  // check straight away unless the sheets are big enough to make opening slow
  if (src(idA).usedRange().rows + src(idB).usedRange().rows <= 400_000) runDoctor();
  else stale();
  s.show(checkBtn);
}

// ---------------------------------------------------- compare dialog --

export function openCompare(d: JoinDeps): void {
  const vs = visibleSheets(d, 2, "Comparing");
  if (!vs) return;
  const { wb, ids } = vs;
  let idOld = vs.first;
  let idNew = vs.second;
  const src = (id: string) => wb.get(id).source;
  let common: Array<[number, number]> = [];
  let keyIdx: number[] = []; // indices into common, up to 3 (-1 none)
  let compareSet = new Set<number>();
  const spec = { tolerance: 0, ignoreCase: false, trim: true, normalise: { trim: true } as KeyNormalise };
  let last: { r: CompareResult; spec: CompareSpec } | null = null;

  const reset = () => {
    const ho = sheetHeader(src(idOld));
    common = pairColumns(ho.names, sheetHeader(src(idNew)).names);
    let k = 0;
    if (common.length) {
      const [ka] = guessKeyPair(src(idOld), src(idNew));
      const at = common.findIndex(([o]) => o === ka);
      k = at >= 0 ? at : 0;
    }
    keyIdx = common.length ? [k, -1, -1] : [-1, -1, -1];
    compareSet = new Set(common.map((_, i) => i).filter((i) => i !== k));
  };
  reset();

  const s = shell(d, "Compare two versions by key", "Rows are paired on the key columns. You get the rows added, the rows removed, and every changed value with its old and new value. Columns are paired by their header names.");
  const mapTable = el("table", { className: "cleanup-cols join-map" });
  const opts = el("div", { className: "import-options" });
  const cols = el("div", { className: "join-bring" });
  const out = el("div", { className: "join-result" });
  const stale = () => {
    last = null;
    addBtn.disabled = true;
    out.replaceChildren();
  };

  const render = () => {
    const ho = sheetHeader(src(idOld));
    const names = common.map(([o]) => ho.names[o]);
    mapTable.replaceChildren(
      el("tr", {}, el("td", { textContent: "Old version" }), el("td", {}, sheetSelect(wb, ids, idOld, "Old version", (id) => ((idOld = id), reset(), render(), stale())))),
      el("tr", {}, el("td", { textContent: "New version" }), el("td", {}, sheetSelect(wb, ids, idNew, "New version", (id) => ((idNew = id), reset(), render(), stale())))),
    );
    for (let i = 0; i < 3; i++) {
      mapTable.append(
        el(
          "tr",
          {},
          el("td", { textContent: i ? `Key column ${i + 1} (optional)` : "Key column" }),
          el(
            "td",
            {},
            colSelect(names, keyIdx[i], `Key column ${i + 1}`, (c) => {
              keyIdx[i] = c;
              if (c >= 0) compareSet.delete(c);
              render();
              stale();
            }, i > 0),
          ),
        ),
      );
    }
    if (!common.length) {
      cols.replaceChildren(el("p", { className: "cleanup-warn", textContent: "These sheets have no column names in common." }));
      return;
    }
    const box = el("fieldset", { className: "join-checks" }, el("legend", { textContent: "Columns to compare" }));
    names.forEach((n, i) => {
      if (keyIdx.includes(i)) return;
      box.append(checkbox(n, compareSet.has(i), (v) => (v ? compareSet.add(i) : compareSet.delete(i), stale())));
    });
    cols.replaceChildren(box);
  };
  opts.append(
    textInput("Number tolerance", "0", "e.g. 0.01", (v) => ((spec.tolerance = Math.max(0, Number(v) || 0)), stale())),
    checkbox("Ignore case", spec.ignoreCase, (v) => ((spec.ignoreCase = v), stale())),
    checkbox("Ignore extra spaces", spec.trim, (v) => ((spec.trim = v), (spec.normalise.trim = v), stale())),
  );

  const runCompare = () => {
    const keys = keyIdx.filter((i) => i >= 0).map((i) => common[i]);
    if (idOld === idNew) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick two different sheets." }));
    if (!keys.length) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick a key column." }));
    const full: CompareSpec = { keys, compare: [...compareSet].sort((a, b) => a - b).map((i) => common[i]), tolerance: spec.tolerance, ignoreCase: spec.ignoreCase, trim: spec.trim, normalise: { ...spec.normalise } };
    d.status("Comparing…");
    const t0 = performance.now();
    const r = compareSheets(src(idOld), src(idNew), full);
    const ms = performance.now() - t0;
    d.status("Ready");
    last = { r, spec: full };
    const cells = r.changed.reduce((t, c) => t + c.cells.length, 0);
    const kids: Node[] = [
      el("p", { textContent: `${count(r.added.length, "row")} added, ${count(r.removed.length, "row")} removed, ${count(r.changed.length, "row")} changed (${count(cells, "value")}), ${r.unchanged.toLocaleString()} the same (${Math.round(ms).toLocaleString()} ms).` }),
    ];
    if (r.duplicates.length) {
      const sample = r.duplicates.slice(0, 5).map((x) => `${x.key} (${x.side}, ${x.count} rows)`).join(", ");
      kids.push(el("p", { className: "cleanup-warn", textContent: `${count(r.duplicates.length, "key")} appear on more than one row, e.g. ${sample}. Repeats are paired in order (the 2nd old row with the 2nd new one); add a key column to tell them apart.` }));
    }
    if (r.blankOld || r.blankNew) kids.push(el("p", { className: "cleanup-warn", textContent: `Rows with a blank key were left out: ${r.blankOld.toLocaleString()} old, ${r.blankNew.toLocaleString()} new.` }));
    out.replaceChildren(...kids);
    addBtn.disabled = false;
  };

  const add = async () => {
    if (!last) return;
    const sheets = compareResultSheets(src(idOld), src(idNew), last.spec, last.r);
    s.back.remove();
    await addSheets(d, sheets);
    d.status(`Compared: ${last.r.added.length.toLocaleString()} added, ${last.r.removed.length.toLocaleString()} removed, ${last.r.changed.length.toLocaleString()} changed`);
    d.focusGrid();
  };

  s.body.append(mapTable, opts, cols, out);
  const goBtn = s.button("Compare", runCompare);
  const addBtn = s.button("Add result sheets", () => void add(), true);
  render();
  s.show(goBtn);
}

// --------------------------------------------------------- TB compare --

const PRIOR = "__prior__";

export function openTbCompare(d: JoinDeps): void {
  const vs = visibleSheets(d, 1, "Comparing trial balances");
  if (!vs) return;
  const { wb, ids } = vs;
  let idA = vs.first;
  let idB = ids.length > 1 ? vs.second : PRIOR;
  let last: { r: TbCompareResult; nameA: string; nameB: string } | null = null;
  const s = shell(
    d,
    "Compare trial balances",
    "Compare a trial balance with the prior period (its own prior column) or with another trial balance, account by account. Columns are guessed as in Map as trial balance; if a guess is wrong, map the sheet there first and compare the sheet it makes.",
  );
  const pick = el("div", { className: "import-options" });
  const out = el("div", { className: "join-result" });
  const stale = () => {
    last = null;
    addBtn.disabled = true;
    out.replaceChildren();
  };
  const render = () =>
    pick.replaceChildren(
      el("label", {}, "Trial balance A ", sheetSelect(wb, ids, idA, "Trial balance A", (id) => ((idA = id), stale()))),
      el("label", {}, "B ", sheetSelect(wb, ids, idB, "Trial balance B", (id) => ((idB = id), stale()), [PRIOR, "(A's prior period)"])),
    );
  const runIt = () => {
    const a = readTbSheet(wb.get(idA).source);
    if (!a.lines.length) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: `${wb.get(idA).name} doesn't read as a trial balance (no account and balance columns found).` }));
    let r: TbCompareResult;
    let nameB: string;
    const nameA = idB === PRIOR ? "Current" : wb.get(idA).name;
    if (idB === PRIOR) {
      if (!a.hasPrior) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: `${wb.get(idA).name} has no prior period column; pick a second trial balance as B.` }));
      r = tbCompare(a.lines);
      nameB = "Prior";
    } else {
      if (idB === idA) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick two different sheets, or A's prior period." }));
      const b = readTbSheet(wb.get(idB).source);
      if (!b.lines.length) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: `${wb.get(idB).name} doesn't read as a trial balance.` }));
      r = tbCompare(a.lines, b.lines);
      nameB = wb.get(idB).name;
    }
    last = { r, nameA, nameB };
    const kids: Node[] = [
      el("p", { textContent: `${count(r.lines.length, "account")}: ${r.onlyA.length.toLocaleString()} only in ${nameA}, ${r.onlyB.length.toLocaleString()} only in ${nameB}, ${r.lines.filter((l) => l.status === "both" && l.movement !== 0).length.toLocaleString()} moved.` }),
      el("p", { textContent: `Totals: ${nameA} ${money(r.totalA)}${r.balancesA ? " (balances)" : ""}, ${nameB} ${money(r.totalB)}${r.balancesB ? " (balances)" : ""}.`, className: r.balancesA && r.balancesB ? "" : "cleanup-warn" }),
    ];
    if (r.onlyA.length) kids.push(el("p", { className: "hp-muted", textContent: `Only in ${nameA}: ${r.onlyA.slice(0, 10).join(", ")}${r.onlyA.length > 10 ? ", …" : ""}` }));
    if (r.onlyB.length) kids.push(el("p", { className: "hp-muted", textContent: `Only in ${nameB}: ${r.onlyB.slice(0, 10).join(", ")}${r.onlyB.length > 10 ? ", …" : ""}` }));
    const dups = [...r.duplicatesA, ...r.duplicatesB];
    if (dups.length) kids.push(el("p", { className: "cleanup-warn", textContent: `Accounts on more than one line were added together: ${dups.slice(0, 10).join(", ")}.` }));
    out.replaceChildren(...kids);
    addBtn.disabled = false;
  };
  const add = async () => {
    if (!last) return;
    s.back.remove();
    await addSheets(d, [tbCompareSheet(last.r, last.nameA, last.nameB)]);
    d.status(`TB compare: ${last.r.lines.length.toLocaleString()} accounts, ${last.r.onlyA.length + last.r.onlyB.length} only on one side`);
    d.focusGrid();
  };
  s.body.append(pick, out);
  const goBtn = s.button("Compare", runIt);
  const addBtn = s.button("Add TB compare sheet", () => void add(), true);
  render();
  s.show(goBtn);
}

// ------------------------------------------------------- GL to TB tie --

export function openGlTie(d: JoinDeps): void {
  const vs = visibleSheets(d, 2, "Tying out the GL");
  if (!vs) return;
  const { wb, ids } = vs;
  let idGl = vs.first;
  let idTb = vs.second;
  let map = guessGlMap(sheetHeader(wb.get(idGl).source).names);
  const opt = { against: "balance" as "balance" | "movement", tolerance: 0.005 };
  let last: TieResult | null = null;
  const s = shell(d, "Tie the GL out to the TB", "Totals the general ledger by account and compares each total with the trial balance. Say which GL columns hold the account and the amount (or debit and credit).");
  const mapTable = el("table", { className: "cleanup-cols join-map" });
  const opts = el("div", { className: "import-options" });
  const out = el("div", { className: "join-result" });
  const stale = () => {
    last = null;
    addBtn.disabled = true;
    out.replaceChildren();
  };
  const render = () => {
    const names = sheetHeader(wb.get(idGl).source).names;
    const role = (label: string, r: GlRole) => el("tr", {}, el("td", { textContent: label }), el("td", {}, colSelect(names, map[r], label, (c) => ((map[r] = c), stale()))));
    mapTable.replaceChildren(
      el("tr", {}, el("td", { textContent: "General ledger" }), el("td", {}, sheetSelect(wb, ids, idGl, "General ledger sheet", (id) => ((idGl = id), (map = guessGlMap(sheetHeader(wb.get(idGl).source).names)), render(), stale())))),
      role("Account", "account"),
      role("Amount (signed)", "amount"),
      role("Debit", "debit"),
      role("Credit", "credit"),
      el("tr", {}, el("td", { textContent: "Trial balance" }), el("td", {}, sheetSelect(wb, ids, idTb, "Trial balance sheet", (id) => ((idTb = id), stale())))),
    );
  };
  const against = el("select");
  against.setAttribute("aria-label", "Compare the GL with");
  against.append(new Option("TB closing balance", "balance"), new Option("TB movement (current − prior)", "movement"));
  against.addEventListener("change", () => ((opt.against = against.value as "balance" | "movement"), stale()));
  opts.append(el("label", {}, "Compare with", against), textInput("Tolerance", "0.005", "differences up to this agree", (v) => ((opt.tolerance = Math.max(0, Number(v) || 0)), stale())));

  const runIt = () => {
    if (idGl === idTb) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick two different sheets." }));
    if (map.account < 0 || (map.amount < 0 && map.debit < 0 && map.credit < 0)) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "Pick the account column and an amount, or debit and credit." }));
    const gl = readGl(wb.get(idGl).source, map);
    const tb = readTbSheet(wb.get(idTb).source);
    if (!tb.lines.length) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: `${wb.get(idTb).name} doesn't read as a trial balance.` }));
    if (opt.against === "movement" && !tb.hasPrior) return void out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "The trial balance has no prior column, so there's no movement to compare with." }));
    const r = glToTb(gl.lines, tb.lines, { against: opt.against, tolerance: opt.tolerance });
    last = r;
    const kids: Node[] = [
      el("p", { textContent: `${count(r.lines.length, "account")}: ${r.agree.toLocaleString()} agree, ${r.differ.toLocaleString()} differ, ${r.onlyGl.toLocaleString()} only in the GL, ${r.onlyTb.toLocaleString()} only in the TB.` }),
      el("p", { className: r.totalDifference ? "cleanup-warn" : "", textContent: `GL ${money(r.totalGl)}, TB ${money(r.totalTb)}, difference ${money(r.totalDifference)}.` }),
    ];
    const worst = r.lines.filter((l) => l.status !== "agrees").sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 8);
    if (worst.length) kids.push(el("ul", {}, ...worst.map((l) => el("li", { textContent: `${l.account}${l.name ? ` ${l.name}` : ""}: ${l.status}, difference ${money(l.difference)}` }))));
    if (gl.bad) kids.push(el("p", { className: "cleanup-warn", textContent: `${count(gl.bad, "GL amount")} couldn't be read as numbers and counted as 0.` }));
    if (r.blankAccounts) kids.push(el("p", { className: "cleanup-warn", textContent: `${count(r.blankAccounts, "GL line")} had no account and were left out.` }));
    out.replaceChildren(...kids);
    addBtn.disabled = false;
  };
  const add = async () => {
    if (!last) return;
    s.back.remove();
    await addSheets(d, [tieSheet(last)]);
    d.status(`GL to TB: ${last.agree} agree, ${last.differ} differ, ${last.onlyGl + last.onlyTb} on one side only`);
    d.focusGrid();
  };
  s.body.append(mapTable, opts, out);
  const goBtn = s.button("Tie out", runIt);
  const addBtn = s.button("Add GL to TB sheet", () => void add(), true);
  render();
  s.show(goBtn);
}

// ---------------------------------------------------- mapping tables --

export function openMapping(d: JoinDeps): void {
  const vs = visibleSheets(d, 2, "A mapping table");
  if (!vs) return;
  const { wb, ids } = vs;
  const idData = vs.first;
  let idMap = vs.second;
  const data = wb.get(idData).source;
  const hd = sheetHeader(data);
  let col = 0;
  let [from, to] = guessMappingCols(sheetHeader(wb.get(idMap).source).names);
  const opt = { match: "trim+case" as MappingMatch, fuzzy: null as number | null, keep: true, inPlace: false, suggest: 0.85 };
  const s = shell(
    d,
    "Apply a mapping table",
    `Replace the values in a column of ${wb.get(idData).name} using a two-column table (from → to) on another sheet. The result goes in a new column next to the data, or over the original values. One undo puts it back.`,
  );
  const mapTable = el("table", { className: "cleanup-cols join-map" });
  const opts = el("div", { className: "import-options" });
  const out = el("div", { className: "join-result" });
  const render = () => {
    const mn = sheetHeader(wb.get(idMap).source).names;
    mapTable.replaceChildren(
      el("tr", {}, el("td", { textContent: `Column in ${wb.get(idData).name}` }), el("td", {}, colSelect(hd.names, col, "Column to map", (c) => (col = c), false))),
      el("tr", {}, el("td", { textContent: "Mapping table sheet" }), el("td", {}, sheetSelect(wb, ids.filter((x) => x !== idData), idMap, "Mapping table sheet", (id) => ((idMap = id), ([from, to] = guessMappingCols(sheetHeader(wb.get(idMap).source).names)), render())))),
      el("tr", {}, el("td", { textContent: "From column" }), el("td", {}, colSelect(mn, from, "From column", (c) => (from = c), false))),
      el("tr", {}, el("td", { textContent: "To column" }), el("td", {}, colSelect(mn, to, "To column", (c) => (to = c), false))),
    );
  };
  const match = el("select");
  match.setAttribute("aria-label", "How values must match");
  match.append(new Option("Ignoring case and spaces", "trim+case", true, true), new Option("Exactly", "exact"), new Option("As names (order, titles, Ltd/Inc ignored)", "name"));
  match.addEventListener("change", () => (opt.match = match.value as MappingMatch));
  opts.append(
    el("label", {}, "Match", match),
    textInput("Fuzzy match %", "", "blank = off", (v) => (opt.fuzzy = fuzzyValue(v))),
    checkbox("Keep values with no mapping", opt.keep, (v) => (opt.keep = v)),
    checkbox("Replace the original values", opt.inPlace, (v) => (opt.inPlace = v)),
  );

  const apply = async () => {
    const m = wb.get(idMap).source;
    const hm = sheetHeader(m);
    const fromV = readColumn(m, from, hm.first);
    const toV = readColumn(m, to, hm.first);
    const values = readColumn(data, col, hd.first);
    const res = mappingCells(values, fromV.map((f, i) => [f, toV[i]] as const), { match: opt.match, fuzzy: opt.fuzzy, keepUnmapped: opt.keep });
    const target = opt.inPlace ? col : data.usedRange().cols;
    const cells = res.inputs.map((input, i) => ({ row: i + hd.first, col: target, input }));
    if (!opt.inPlace && hd.first > 0) cells.push({ row: hd.first - 1, col: target, input: `${hd.names[col]} (mapped)` });
    s.back.remove();
    await d.run(setCells(cells, "Apply mapping table", idData));
    const un = res.unmapped.slice(0, 5).map((u) => u.value).join(", ");
    d.status(`Mapped ${res.mapped.toLocaleString()} of ${values.filter((v) => v !== null && v !== "").length.toLocaleString()} values${res.fuzzy ? ` (${res.fuzzy.toLocaleString()} fuzzy)` : ""}${res.unmapped.length ? `; no mapping for ${count(res.unmapped.length, "value")}: ${un}${res.unmapped.length > 5 ? ", …" : ""}` : ""}${res.conflicts ? `; ${count(res.conflicts, "conflicting entry", "conflicting entries")} in the table (first one used)` : ""}`);
    d.focusGrid();
  };

  // build a table: suggested pairs between the column and a master list
  const suggest = () => {
    const m = wb.get(idMap).source;
    const hm = sheetHeader(m);
    const sheet = suggestionSheet(readColumn(data, col, hd.first), readColumn(m, to, hm.first), opt.suggest);
    if (!sheet.columns[0] || (sheet.columns[0].kind === "string" && !sheet.columns[0].codes.length)) {
      out.replaceChildren(el("p", { className: "cleanup-warn", textContent: "No similar names found." }));
      return;
    }
    s.back.remove();
    void addSheets(d, [sheet]).then(() => {
      d.status(`Suggested ${count(sheet.columns[0].kind === "string" ? sheet.columns[0].codes.length : 0, "pair")}: check them, delete the wrong ones, then apply this sheet as the mapping table.`);
      d.focusGrid();
    });
  };
  s.body.append(
    mapTable,
    opts,
    el("p", { className: "hp-muted", textContent: "No table yet? Suggest pairs builds one: each distinct value in the column, paired with the most similar name in the To column of the other sheet (your master list)." }),
    el("div", { className: "import-options" }, textInput("Suggest at %", "85", "how alike names must be", (v) => (opt.suggest = fuzzyValue(v) ?? 0.85))),
    out,
  );
  s.button("Suggest pairs", suggest);
  const goBtn = s.button("Apply", () => void apply());
  render();
  s.show(goBtn);
}
