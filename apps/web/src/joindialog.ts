/**
 * Joins and compares across sheets: join two sheets on a key (the join
 * doctor checks the keys first), compare two versions of a file by key,
 * compare two trial balances, tie a GL out to a TB, and apply (or build) a
 * mapping table.
 */
import "./joindialog.css";
import type { Action } from "@cellforge/actions";
import { buildTb, formatValue, parseNumberLoose, readTb, type ColumnData } from "@cellforge/core";
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
import { needTwoSheets, pickSides, sheetHeader, sidePreview } from "./recondialog";
import { addResultSheets, MONEY_FMT, type ResultSheetSpec } from "./resultsheet";
import { button, count, el, field, headline, notice, plural, section, tiles, toolDialog, type ToolDialog } from "./toolkit";
import { formatCell, renderTable } from "./ui/table";
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

/** A results sheet (laid out by addResultSheets: title, summary, totals, header). */
export interface ResultSheet extends ResultSheetSpec {
  numFmts: string[];
}

const MONEY = MONEY_FMT;
const PCT = "0.0%";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** The kind of join in a few words, for the results sheet's summary. */
const KIND_SHORT: Record<JoinKind, (a: string, b: string) => string> = {
  inner: () => "rows with a match on both sides",
  left: (a) => `every ${a} row`,
  right: (_, b) => `every ${b} row`,
  full: () => "every row from both sides",
  anti: (a) => `${a} rows with no match`,
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
    let t = result.left[i] < 0 ? `Only in ${nameB}` : result.right[i] < 0 ? `Only in ${nameA}` : s >= 1 ? "Match" : `Fuzzy match ${Math.round(s * 100)}%`;
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
  const keys = spec.keysA.filter((k) => k >= 0).map((k) => ha.names[k]).join(" + ");
  const summary = `${plural(result.rows, "row")}: ${KIND_SHORT[spec.kind](nameA, nameB)}, on ${keys}. ${result.matchedLeft.toLocaleString()} ${nameA} rows found a partner in ${nameB}.`;
  return { sheet: { name: `Join · ${nameA} + ${nameB}`, title: `${nameA} joined with ${nameB}`, summary, columns, numFmts, totals: false }, result };
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
export function compareResultSheets(oldSrc: EditableSource, newSrc: EditableSource, spec: CompareSpec, r: CompareResult, names: { old: string; new: string } = { old: "the old version", new: "the new version" }): ResultSheet[] {
  const ho = sheetHeader(oldSrc);
  const hn = sheetHeader(newSrc);
  const whole = (src: EditableSource, h: { names: string[]; first: number }, rows: number[], label: string, name: string): ResultSheet => {
    const columns: ColumnData[] = [{ kind: "number", name: label, values: Float64Array.from(rows, (x) => x + h.first + 1) }];
    const numFmts = [""];
    h.names.forEach((n, c) => {
      columns.push(toColumn(n, rows.map((x) => src.getCell(x + h.first, c))));
      numFmts.push(colFormat(src, c, h.first));
    });
    return { name, columns, numFmts, totals: false };
  };
  const added = { ...whole(newSrc, hn, r.added, "New row", "Compare · Added"), title: `Rows added in ${names.new}`, summary: r.added.length ? `${plural(r.added.length, "row")} in ${names.new} with a key that isn't in ${names.old}.` : `No rows were added.` };
  const removed = { ...whole(oldSrc, ho, r.removed, "Old row", "Compare · Removed"), title: `Rows removed from ${names.old}`, summary: r.removed.length ? `${plural(r.removed.length, "row")} in ${names.old} with a key that isn't in ${names.new}.` : `No rows were removed.` };
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
    name: "Compare · Changed",
    title: `Values changed between ${names.old} and ${names.new}`,
    summary: `${plural(col.length, "changed value")} on ${plural(r.changed.length, "row")}, one line per value. ${r.unchanged.toLocaleString()} rows are the same.`,
    totals: false,
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
    title: `Trial balances: ${nameA} against ${nameB}`,
    summary: `${plural(r.lines.length, "account")}: ${r.onlyA.length.toLocaleString()} only in ${nameA}, ${r.onlyB.length.toLocaleString()} only in ${nameB}, ${r.lines.filter((l) => l.status === "both" && l.movement !== 0).length.toLocaleString()} moved.`,
    columns: [
      toColumn("Account", r.lines.map((l) => l.account)),
      toColumn("Name", r.lines.map((l) => l.name)),
      toColumn(nameA, r.lines.map((l) => l.a)),
      toColumn(nameB, r.lines.map((l) => l.b)),
      toColumn("Movement", r.lines.map((l) => l.movement)),
      toColumn("Movement %", r.lines.map((l) => l.pct)),
      toColumn("Status", r.lines.map((l) => (l.status === "both" ? "" : l.status === "only A" ? `Only in ${nameA}` : `Only in ${nameB}`))),
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
    title: "General ledger tied out to the trial balance",
    summary: `${plural(r.lines.length, "account")}: ${r.agree.toLocaleString()} agree, ${r.differ.toLocaleString()} differ, ${r.onlyGl.toLocaleString()} only in the GL, ${r.onlyTb.toLocaleString()} only in the TB. Difference ${formatValue(r.totalDifference, MONEY).text}.`,
    columns: [
      toColumn("Account", r.lines.map((l) => l.account)),
      toColumn("Name", r.lines.map((l) => l.name)),
      toColumn("GL total", r.lines.map((l) => l.gl)),
      toColumn("GL lines", r.lines.map((l) => l.glLines)),
      toColumn("TB", r.lines.map((l) => l.tb)),
      toColumn("Difference", r.lines.map((l) => l.difference)),
      toColumn("Status", r.lines.map((l) => cap(l.status))),
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
    title: "Suggested mapping table",
    summary: "Check each pair and delete the wrong ones, then use this sheet in Apply a mapping table.",
    totals: false,
    columns: [toColumn("From", pairs.map((p) => p.from)), toColumn("To", pairs.map((p) => p.to)), toColumn("How alike", pairs.map((p) => Math.round(p.score * 1000) / 1000))],
    numFmts: ["", "", PCT],
  };
}

// ---------------------------------------------------------------- UI --
//
// Every dialog here follows Reconcile two sheets: a card per side (sheet,
// the columns that matter, a preview with them highlighted), the settings
// in titled sections, the result as figures and a table that update as you
// change things, and one primary button in the footer that adds the sheet.

const money = (n: number) => formatCell(n, "amount");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Run straight away when both sheets are this small; bigger ones wait for a button. */
const LIVE_ROWS = 400_000;

interface Shell {
  dlg: ToolDialog;
  body: HTMLElement;
  primary: HTMLButtonElement;
  close: () => void;
}

/** A tool dialog: Cancel and one primary button (disabled until there's something to add). */
function shell(d: JoinDeps, title: string, subtitle: string, primaryLabel: string, act: () => unknown, size: "lg" | "xl" = "lg"): Shell {
  const dlg = toolDialog({ title, subtitle, size, closeLabel: "Cancel", onClose: () => d.focusGrid(), className: "join-dialog rc-dialog" });
  const primary = dlg.button(primaryLabel, act, { kind: "primary", disabled: true });
  return { dlg, body: dlg.body, primary, close: () => dlg.close() };
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

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLLabelElement {
  const box = el("input", { type: "checkbox", checked });
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { className: "rc-pass join-check" }, box, el("span", {}, el("span", { className: "rc-pass__name", textContent: label }), hint ? el("small", { className: "tk-field__hint", textContent: hint }) : null));
}

function textInput(label: string, value: string, hint: string, onChange: (v: string) => void): HTMLLabelElement {
  const input = el("input", { type: "text", value, inputMode: "decimal" });
  input.addEventListener("change", () => onChange(input.value.trim()));
  return field(label, input, hint || undefined);
}

function normaliseBoxes(o: KeyNormalise, onChange: () => void): HTMLElement {
  return el(
    "div",
    { className: "join-checks" },
    ...NORMALISE_OPTIONS.map((opt) =>
      checkbox(NORMALISE_LABEL[opt], !!o[opt], (v) => {
        o[opt] = v;
        onChange();
      }),
    ),
  );
}

interface CardOpts {
  badge: string;
  tone?: "a" | "b";
  title: string;
  wb: Workbook;
  ids: readonly string[];
  id: string;
  onSheet: (id: string) => void;
  /** extra choice in the sheet list, e.g. "A's prior period" */
  extra?: [string, string];
  /** the column pickers */
  fields?: readonly HTMLElement[];
  /** columns to highlight in the preview: column → label */
  highlight?: ReadonlyMap<number, string>;
  preview?: boolean;
}

/** A side card: badge, title, row count, the sheet, its column pickers and a preview. */
function sideCard(o: CardOpts): HTMLElement {
  const src = o.wb.has(o.id) ? o.wb.get(o.id).source : null;
  const rows = src ? Math.max(0, src.usedRange().rows - sheetHeader(src).first) : 0;
  const sel = sheetSelect(o.wb, o.ids, o.id, `${o.title}: sheet`, o.onSheet, o.extra);
  const card = el(
    "section",
    { className: "rc-side" },
    el(
      "header",
      { className: "rc-side__head" },
      el("span", { className: `rc-side__badge rc-side__badge--${o.tone ?? "a"}`, textContent: o.badge }),
      el("div", { className: "rc-side__titles" }, el("strong", { textContent: o.title }), el("span", { className: "tk-muted", textContent: src ? plural(rows, "row") : "" })),
      sel,
    ),
  );
  if (o.fields?.length) card.append(el("div", { className: "rc-roles" }, ...o.fields));
  if (src && o.preview !== false) card.append(el("div", { className: "table-wrap rc-preview-wrap" }, sidePreview(src, o.highlight ?? new Map(), 4)));
  return card;
}

function sides(a: HTMLElement, b: HTMLElement, mark = "⇄"): HTMLElement {
  const vs = el("div", { className: "rc-vs", textContent: mark });
  vs.setAttribute("aria-hidden", "true");
  return el("div", { className: "rc-sides" }, a, vs, b);
}

/** A small "label · A · B" table (the key check). */
function abTable(head: [string, string, string], rows: ReadonlyArray<{ label: string; a: string; b: string; warn?: boolean }>): HTMLElement {
  const t = el("table", { className: "data-table data-table--dense join-ab" });
  const h = t.createTHead().insertRow();
  head.forEach((x, i) => {
    const th = el("th", { className: i ? "num" : "", textContent: x });
    th.scope = "col";
    h.append(th);
  });
  const body = t.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    const label = el("td", {}, r.label);
    if (r.warn) label.append(" ", el("span", { className: "cf-badge cf-badge--warning", textContent: "Check" }));
    tr.append(label, el("td", { className: "num", textContent: r.a }), el("td", { className: "num", textContent: r.b }));
  }
  return el("div", { className: "table-wrap" }, t);
}

const fuzzyValue = (v: string): number | null => (v === "" || Number.isNaN(Number(v)) ? null : Math.min(100, Math.max(1, Number(v))) / 100);

const writer = (d: JoinDeps) => ({ run: d.run, putBlob: d.putBlob, workbook: d.workbook });

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
  const live = () => src(idA).usedRange().rows + src(idB).usedRange().rows <= LIVE_ROWS;
  const pairs = () => spec.keysA.map((a, i) => [a, spec.keysB[i]] as const).filter(([a, b]) => a >= 0 && b >= 0);

  const doJoin = async () => {
    if (!doctor) return;
    const p = pairs();
    const full: JoinSpec = { ...spec, keysA: p.map((x) => x[0]), keysB: p.map((x) => x[1]) };
    if (!full.bringA.length && !full.bringB.length) throw new Error("Pick at least one column to bring over.");
    const t0 = performance.now();
    const { sheet, result } = joinSheet(src(idA), src(idB), wb.get(idA).name, wb.get(idB).name, full);
    await addResultSheets(writer(d), [sheet], { replace: true });
    s.close();
    const extra = [result.fuzzyMatched ? `${result.fuzzyMatched.toLocaleString()} fuzzy` : "", result.capped ? "stopped at the row limit" : "", result.fuzzyCapped ? "fuzzy search stopped early" : ""].filter(Boolean).join(", ");
    d.status(`Joined: ${plural(result.rows, "row")}, ${result.matchedLeft.toLocaleString()} rows of ${wb.get(idA).name} matched${extra ? ` (${extra})` : ""} in ${Math.round(performance.now() - t0).toLocaleString()} ms`);
    d.focusGrid();
  };
  const s = shell(d, "Join two sheets", "Bring columns from one sheet into another, matched on a key", "Add joined sheet", doJoin, "xl");

  const sidesBox = el("div");
  const checks = el("div");
  const doctorOut = el("div", { className: "join-result" });
  doctorOut.setAttribute("aria-live", "polite");
  const whyOut = el("div", { className: "join-why" });
  const options = el("div", { className: "tk-grid join-options" });
  const bring = el("div", { className: "join-bring" });

  let timer = 0;
  const stale = () => {
    doctor = null;
    s.primary.disabled = true;
    whyOut.replaceChildren();
    if (live()) {
      clearTimeout(timer);
      timer = window.setTimeout(runDoctor, 120);
      return;
    }
    doctorOut.replaceChildren(el("p", { className: "tk-muted" }, "These sheets are large, so the key check waits for you. ", button("Check keys", runDoctor, "secondary")));
  };

  const renderSides = () => {
    const na = sheetHeader(src(idA)).names;
    const nb = sheetHeader(src(idB)).names;
    const keyFields = (sheet: string, names: string[], keys: number[]) =>
      [0, 1, 2].map((i) =>
        field(
          i ? `Key ${i + 1} (optional)` : "Key column",
          colSelect(names, keys[i], `Key column ${i + 1} in ${sheet}`, (c) => {
            keys[i] = c;
            renderSides();
            stale();
          }, i > 0),
        ),
      );
    const marks = (keys: number[]) => new Map(keys.filter((k) => k >= 0).map((k, i) => [k, i ? `Key ${i + 1}` : "Key"] as const));
    sidesBox.replaceChildren(
      sides(
        sideCard({ badge: "A", title: "Add columns to", wb, ids, id: idA, onSheet: (id) => ((idA = id), reset(), renderAll()), fields: keyFields(wb.get(idA).name, na, spec.keysA), highlight: marks(spec.keysA) }),
        sideCard({ badge: "B", tone: "b", title: "Bring them from", wb, ids, id: idB, onSheet: (id) => ((idB = id), reset(), renderAll()), fields: keyFields(wb.get(idB).name, nb, spec.keysB), highlight: marks(spec.keysB) }),
        "←",
      ),
    );
  };
  const renderChecks = () => checks.replaceChildren(normaliseBoxes(spec.normalise, stale));

  const renderOptions = () => {
    const kind = el("select");
    kind.setAttribute("aria-label", "Rows to keep");
    for (const k of Object.keys(KIND_LABEL) as JoinKind[]) kind.append(new Option(KIND_LABEL[k], k, false, spec.kind === k));
    kind.addEventListener("change", () => {
      spec.kind = kind.value as JoinKind;
      renderBring();
      if (doctor) runDoctor();
    });
    const many = el("select");
    many.setAttribute("aria-label", "When a key matches several rows");
    for (const k of Object.keys(MANY_LABEL) as ManyPolicy[]) many.append(new Option(MANY_LABEL[k], k, false, spec.many === k));
    many.addEventListener("change", () => (spec.many = many.value as ManyPolicy));
    options.replaceChildren(
      field("Rows to keep", kind),
      field("When a key matches several rows", many),
      textInput("Fuzzy match %", spec.fuzzy === null ? "" : String(Math.round(spec.fuzzy * 100)), "Blank for exact matches only", (v) => (spec.fuzzy = fuzzyValue(v))),
      checkbox("Keys are person or company names", spec.names, (v) => (spec.names = v), "Ignores word order, titles and Ltd/Inc"),
    );
  };

  const renderBring = () => {
    const side = (names: string[], chosen: number[], label: string, set: (c: number[]) => void) => {
      const box = el("fieldset", { className: "join-checks join-checks--cols" }, el("legend", { textContent: label }));
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
    renderSides();
    renderBring();
    stale();
  };

  function runDoctor() {
    if (idA === idB) return void doctorOut.replaceChildren(notice("Pick two different sheets.", "warning"));
    const p = pairs();
    if (!p.length || spec.keysA[0] < 0 || spec.keysB[0] < 0) return void doctorOut.replaceChildren(notice("Pick a key column on both sides.", "warning"));
    const la = keyColumns(src(idA), p.map((x) => x[0]));
    const lb = keyColumns(src(idB), p.map((x) => x[1]));
    doctor = joinDoctor(la, lb, { normalise: spec.normalise });
    renderDoctor(doctor, la, lb);
    s.primary.disabled = false;
  }

  const renderDoctor = (r: DoctorResult, la: KeyValue[][], lb: KeyValue[][]) => {
    const nameA = wb.get(idA).name;
    const nameB = wb.get(idB).name;
    const tone = (x: number) => (x >= 0.95 ? ("match" as const) : x >= 0.5 ? ("unmatched" as const) : ("mismatch" as const));
    const figures = tiles([
      { label: `${nameA} rows with a partner`, value: pct(r.left.matchRate), sub: `${count(r.left.matchedRows)} of ${count(r.left.rows)}`, tone: tone(r.left.matchRate) },
      { label: `${nameB} rows with a partner`, value: pct(r.right.matchRate), sub: `${count(r.right.matchedRows)} of ${count(r.right.rows)}`, tone: tone(r.right.matchRate) },
      { label: "Rows in the joined sheet", value: count(spec.kind === "inner" ? r.innerRows : r.leftRows), sub: `${cap(r.relationship.replace(/-/g, " "))} keys`, tone: "neutral" },
    ]);
    const table = abTable(["", nameA, nameB], [
      { label: "No partner (keys / rows)", a: `${count(r.left.orphanKeys)} / ${count(r.left.orphanRows)}`, b: `${count(r.right.orphanKeys)} / ${count(r.right.orphanRows)}`, warn: !!(r.left.orphanRows || r.right.orphanRows) },
      { label: "Repeated keys (keys / rows)", a: `${count(r.left.duplicateKeys)} / ${count(r.left.duplicateRows)}`, b: `${count(r.right.duplicateKeys)} / ${count(r.right.duplicateRows)}`, warn: !!(r.left.duplicateKeys || r.right.duplicateKeys) },
      { label: "Blank keys", a: count(r.left.blank), b: count(r.right.blank), warn: !!(r.left.blank || r.right.blank) },
      { label: "Numbers / text like numbers / text", a: `${count(r.left.numbers)} / ${count(r.left.numericText)} / ${count(r.left.text)}`, b: `${count(r.right.numbers)} / ${count(r.right.numericText)} / ${count(r.right.text)}`, warn: r.typeMismatch },
      { label: "Spaces at the ends or doubled", a: count(r.left.padded), b: count(r.right.padded), warn: !!(r.left.padded || r.right.padded) },
    ]);
    const kids: Node[] = [figures, table];
    const issues = r.issues.slice(1);
    if (issues.length) kids.push(el("ul", { className: "rc-reasons" }, ...issues.map((t) => el("li", { textContent: cap(t) }))));
    if (r.fixes.length) {
      const list = el("div", { className: "join-fixes" });
      for (const f of r.fixes.slice(0, 4)) {
        list.append(
          el(
            "div",
            { className: "join-fix" },
            el("span", {}, el("strong", { textContent: f.label }), ` would match ${pct(f.matchRateLeft)} / ${pct(f.matchRateRight)} (+${count(f.gainLeft)} / +${count(f.gainRight)} rows${f.estimated ? ", estimated" : ""})`),
            button("Use", () => {
              if (f.option === "all") for (const o of NORMALISE_OPTIONS) if (o !== "ref") spec.normalise[o] = true;
              if (f.option !== "all") spec.normalise[f.option] = true;
              renderChecks();
              runDoctor();
            }, "secondary"),
          ),
        );
      }
      kids.push(el("p", { className: "tk-muted join-fixes__lead", textContent: "Tidying the keys would match more:" }), list);
    }
    doctorOut.replaceChildren(...kids);
    renderWhy(r, la, lb);
  };

  // "Why don't these match?" on two keys with no partner
  const renderWhy = (r: DoctorResult, la: KeyValue[][], lb: KeyValue[][]) => {
    if (!r.left.topOrphans.length || !r.right.topOrphans.length) return void whyOut.replaceChildren();
    const nameA = wb.get(idA).name;
    const nameB = wb.get(idB).name;
    const pick = (name: string, list: typeof r.left.topOrphans) => {
      const sel = el("select");
      sel.setAttribute("aria-label", `Key with no partner in ${name}`);
      list.forEach((o, i) => sel.append(new Option(`${o.key}${o.count > 1 ? ` (${o.count} rows)` : ""}`, String(i))));
      return sel;
    };
    const selA = pick(nameA, r.left.topOrphans);
    const selB = pick(nameB, r.right.topOrphans);
    const out = el("div");
    out.setAttribute("aria-live", "polite");
    const go = () => {
      const ra = r.left.topOrphans[Number(selA.value)].row;
      const rb = r.right.topOrphans[Number(selB.value)].row;
      const w = whyKeys(la.map((c) => c[ra]), lb.map((c) => c[rb]), spec.normalise);
      const kids: Node[] = [el("ul", { className: "rc-reasons" }, ...w.reasons.map((t) => el("li", { textContent: cap(t) })))];
      if (w.fix && w.fix.length) {
        kids.push(
          button("Turn it on and check again", () => {
            for (const f of w.fix!) spec.normalise[f] = true;
            renderChecks();
            runDoctor();
          }, "secondary"),
        );
      } else if (!w.fix && Math.max(w.similarity, w.nameSimilarity) >= 0.8 && spec.fuzzy === null) {
        kids.push(
          button("Use fuzzy matching at 85%", () => {
            spec.fuzzy = 0.85;
            spec.names = w.nameSimilarity > w.similarity;
            renderOptions();
          }, "secondary"),
        );
      }
      out.replaceChildren(...kids);
    };
    whyOut.replaceChildren(
      section(
        "Why don't these match?",
        el("p", { className: "tk-muted", textContent: "Pick a key from each side that has no partner." }),
        el("div", { className: "rc-why" }, field(nameA, selA), field(nameB, selB), button("Explain", go, "secondary")),
        out,
      ),
    );
  };

  s.body.append(sidesBox, section("Tidy the keys before matching", checks), section("Key check", doctorOut), whyOut, section("The joined sheet", options, bring));
  renderSides();
  renderChecks();
  renderOptions();
  renderBring();
  if (live()) runDoctor();
  else stale();
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
  const live = () => src(idOld).usedRange().rows + src(idNew).usedRange().rows <= LIVE_ROWS;

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

  const add = async () => {
    if (!last) return;
    const sheets = compareResultSheets(src(idOld), src(idNew), last.spec, last.r, { old: wb.get(idOld).name, new: wb.get(idNew).name });
    await addResultSheets(writer(d), sheets, { replace: true });
    s.close();
    d.status(`Compared: ${last.r.added.length.toLocaleString()} added, ${last.r.removed.length.toLocaleString()} removed, ${last.r.changed.length.toLocaleString()} changed`);
    d.focusGrid();
  };
  const s = shell(d, "Compare two versions by key", "Rows are paired on the key; you get what was added, removed and changed", "Add result sheets", add, "xl");
  const sidesBox = el("div");
  const keys = el("div", { className: "rc-roles" });
  const cols = el("div");
  const out = el("div", { className: "join-result" });
  out.setAttribute("aria-live", "polite");
  let timer = 0;
  const stale = () => {
    last = null;
    s.primary.disabled = true;
    if (live()) {
      clearTimeout(timer);
      timer = window.setTimeout(runCompare, 120);
    } else out.replaceChildren(button("Compare", runCompare, "secondary"));
  };

  const render = () => {
    const ho = sheetHeader(src(idOld));
    const names = common.map(([o]) => ho.names[o]);
    const mark = (side: 0 | 1) => new Map(keyIdx.filter((i) => i >= 0).map((i, n) => [common[i][side], n ? `Key ${n + 1}` : "Key"] as const));
    sidesBox.replaceChildren(
      sides(
        sideCard({ badge: "Old", title: "Old version", wb, ids, id: idOld, onSheet: (id) => ((idOld = id), reset(), render(), stale()), highlight: mark(0) }),
        sideCard({ badge: "New", tone: "b", title: "New version", wb, ids, id: idNew, onSheet: (id) => ((idNew = id), reset(), render(), stale()), highlight: mark(1) }),
        "→",
      ),
    );
    keys.replaceChildren(
      ...[0, 1, 2].map((i) =>
        field(
          i ? `Key ${i + 1} (optional)` : "Key column",
          colSelect(names, keyIdx[i], `Key column ${i + 1}`, (c) => {
            keyIdx[i] = c;
            if (c >= 0) compareSet.delete(c);
            render();
            stale();
          }, i > 0),
        ),
      ),
    );
    if (!common.length) return void cols.replaceChildren(notice("These sheets have no column names in common, so there is nothing to pair.", "warning"));
    const box = el("div", { className: "join-checks join-checks--cols" });
    names.forEach((n, i) => {
      if (keyIdx.includes(i)) return;
      box.append(checkbox(n, compareSet.has(i), (v) => (v ? compareSet.add(i) : compareSet.delete(i), stale())));
    });
    cols.replaceChildren(box);
  };
  const opts = el(
    "div",
    { className: "tk-grid join-options" },
    textInput("Number tolerance", "0", "Differences up to this count as the same, e.g. 0.01", (v) => ((spec.tolerance = Math.max(0, Number(v) || 0)), stale())),
    checkbox("Ignore case", spec.ignoreCase, (v) => ((spec.ignoreCase = v), stale())),
    checkbox("Ignore extra spaces", spec.trim, (v) => ((spec.trim = v), (spec.normalise.trim = v), stale())),
  );

  function runCompare() {
    const k = keyIdx.filter((i) => i >= 0).map((i) => common[i]);
    if (idOld === idNew) return void out.replaceChildren(notice("Pick two different sheets.", "warning"));
    if (!k.length) return void out.replaceChildren(notice("Pick a key column.", "warning"));
    const full: CompareSpec = { keys: k, compare: [...compareSet].sort((a, b) => a - b).map((i) => common[i]), tolerance: spec.tolerance, ignoreCase: spec.ignoreCase, trim: spec.trim, normalise: { ...spec.normalise } };
    const r = compareSheets(src(idOld), src(idNew), full);
    last = { r, spec: full };
    const cells = r.changed.reduce((t, c) => t + c.cells.length, 0);
    const kids: Node[] = [
      tiles([
        { label: "Added", value: count(r.added.length), sub: plural(r.added.length, "row"), tone: r.added.length ? "unmatched" : "neutral" },
        { label: "Removed", value: count(r.removed.length), sub: plural(r.removed.length, "row"), tone: r.removed.length ? "unmatched" : "neutral" },
        { label: "Changed", value: count(r.changed.length), sub: plural(cells, "value"), tone: r.changed.length ? "mismatch" : "neutral" },
        { label: "The same", value: count(r.unchanged), sub: plural(r.unchanged, "row"), tone: "match" },
      ]),
    ];
    if (r.duplicates.length) {
      const sample = r.duplicates.slice(0, 5).map((x) => `${x.key} (${x.side}, ${x.count} rows)`).join(", ");
      kids.push(notice(`${plural(r.duplicates.length, "key")} appear on more than one row, e.g. ${sample}. Repeats are paired in order (the 2nd old row with the 2nd new one); add a key column to tell them apart.`, "warning"));
    }
    if (r.blankOld || r.blankNew) kids.push(notice(`Rows with a blank key were left out: ${count(r.blankOld)} old, ${count(r.blankNew)} new.`, "warning"));
    out.replaceChildren(...kids);
    s.primary.disabled = false;
  }

  s.body.append(sidesBox, section("Pair rows on", keys), section("Columns to compare", el("p", { className: "tk-muted", textContent: "Columns are paired by their header names." }), cols), section("Options", opts), section("Result", out));
  render();
  if (live()) runCompare();
  else stale();
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
  const add = async () => {
    if (!last) return;
    await addResultSheets(writer(d), [tbCompareSheet(last.r, last.nameA, last.nameB)], { replace: true });
    s.close();
    d.status(`TB compare: ${plural(last.r.lines.length, "account")}, ${last.r.onlyA.length + last.r.onlyB.length} only on one side`);
    d.focusGrid();
  };
  const s = shell(d, "Compare trial balances", "Account by account, against the prior period or another trial balance", "Add TB compare sheet", add, "xl");
  const sidesBox = el("div");
  const out = el("div", { className: "join-result" });
  out.setAttribute("aria-live", "polite");
  const render = () =>
    sidesBox.replaceChildren(
      sides(
        sideCard({ badge: "A", title: "This trial balance", wb, ids, id: idA, onSheet: (id) => ((idA = id), render(), runIt()) }),
        sideCard({ badge: "B", tone: "b", title: "Compare with", wb, ids, id: idB, onSheet: (id) => ((idB = id), render(), runIt()), extra: [PRIOR, "(A's prior period)"], preview: idB !== PRIOR }),
      ),
    );
  const fail = (text: string) => {
    last = null;
    s.primary.disabled = true;
    out.replaceChildren(notice(text, "warning"));
  };
  const runIt = () => {
    const a = readTbSheet(wb.get(idA).source);
    if (!a.lines.length) return fail(`${wb.get(idA).name} doesn't read as a trial balance (no account and balance columns found). Map it with Map as a trial balance first.`);
    let r: TbCompareResult;
    let nameB: string;
    const nameA = idB === PRIOR ? "Current" : wb.get(idA).name;
    if (idB === PRIOR) {
      if (!a.hasPrior) return fail(`${wb.get(idA).name} has no prior period column; pick a second trial balance to compare with.`);
      r = tbCompare(a.lines);
      nameB = "Prior";
    } else {
      if (idB === idA) return fail("Pick two different sheets, or A's prior period.");
      const b = readTbSheet(wb.get(idB).source);
      if (!b.lines.length) return fail(`${wb.get(idB).name} doesn't read as a trial balance.`);
      r = tbCompare(a.lines, b.lines);
      nameB = wb.get(idB).name;
    }
    last = { r, nameA, nameB };
    const moved = r.lines.filter((l) => l.status === "both" && l.movement !== 0).length;
    const balance = r.balancesA && r.balancesB
      ? notice(`Both trial balances balance (${nameA} ${money(r.totalA)}, ${nameB} ${money(r.totalB)}).`, "success")
      : notice(`${!r.balancesA ? `${nameA} doesn't balance: it totals ${money(r.totalA)}.` : ""} ${!r.balancesB ? `${nameB} doesn't balance: it totals ${money(r.totalB)}.` : ""}`.trim(), "warning");
    const kids: Node[] = [
      tiles([
        { label: "Accounts", value: count(r.lines.length), tone: "neutral" },
        { label: `Only in ${nameA}`, value: count(r.onlyA.length), tone: r.onlyA.length ? "unmatched" : "neutral" },
        { label: `Only in ${nameB}`, value: count(r.onlyB.length), tone: r.onlyB.length ? "unmatched" : "neutral" },
        { label: "Moved", value: count(moved), tone: "accent" },
      ]),
      balance,
    ];
    const moves = r.lines.filter((l) => l.status !== "both" || l.movement !== 0).sort((x, y) => Math.abs(y.movement) - Math.abs(x.movement)).slice(0, 8);
    if (moves.length)
      kids.push(
        section(
          "Largest movements",
          renderTable({
            columns: [
              { key: "account", label: "Account" },
              { key: "name", label: "Name" },
              { key: "a", label: nameA, format: "amount" },
              { key: "b", label: nameB, format: "amount" },
              { key: "movement", label: "Movement", format: "amount" },
            ],
            rows: moves,
          }).element,
        ),
      );
    const dups = [...r.duplicatesA, ...r.duplicatesB];
    if (dups.length) kids.push(notice(`Accounts on more than one line were added together: ${dups.slice(0, 10).join(", ")}.`, "info"));
    out.replaceChildren(...kids);
    s.primary.disabled = false;
  };
  s.body.append(el("p", { className: "tk-muted", textContent: "Columns are guessed as in Map as a trial balance; if a guess is wrong, map the sheet there first and compare the sheet it makes." }), sidesBox, section("Result", out));
  render();
  runIt();
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
  const add = async () => {
    if (!last) return;
    await addResultSheets(writer(d), [tieSheet(last)], { replace: true });
    s.close();
    d.status(`GL to TB: ${last.agree} agree, ${last.differ} differ, ${last.onlyGl + last.onlyTb} on one side only`);
    d.focusGrid();
  };
  const s = shell(d, "Tie the GL out to the TB", "Total the general ledger by account and compare each total with the trial balance", "Add GL to TB sheet", add, "xl");
  const sidesBox = el("div");
  const out = el("div", { className: "join-result" });
  out.setAttribute("aria-live", "polite");
  const ROLE: Array<[GlRole, string, string]> = [
    ["account", "Account", "Account"],
    ["amount", "Amount (signed)", "Amount"],
    ["debit", "Debit", "Debit"],
    ["credit", "Credit", "Credit"],
  ];
  const render = () => {
    const names = sheetHeader(wb.get(idGl).source).names;
    const fields = ROLE.map(([r, label]) => field(label, colSelect(names, map[r], label, (c) => ((map[r] = c), render(), runIt()))));
    const marks = new Map<number, string>();
    for (const [r, , short] of ROLE) if (map[r] >= 0) marks.set(map[r], short);
    sidesBox.replaceChildren(
      sides(
        sideCard({ badge: "GL", title: "General ledger", wb, ids, id: idGl, onSheet: (id) => ((idGl = id), (map = guessGlMap(sheetHeader(wb.get(idGl).source).names)), render(), runIt()), fields, highlight: marks }),
        sideCard({ badge: "TB", tone: "b", title: "Trial balance", wb, ids, id: idTb, onSheet: (id) => ((idTb = id), render(), runIt()) }),
      ),
    );
  };
  const against = el("select");
  against.setAttribute("aria-label", "Compare the GL with");
  against.append(new Option("TB closing balance", "balance"), new Option("TB movement (current − prior)", "movement"));
  against.addEventListener("change", () => ((opt.against = against.value as "balance" | "movement"), runIt()));
  const opts = el("div", { className: "tk-grid join-options" }, field("Compare with", against), textInput("Tolerance", "0.005", "Differences up to this agree", (v) => ((opt.tolerance = Math.max(0, Number(v) || 0)), runIt())));

  const fail = (text: string) => {
    last = null;
    s.primary.disabled = true;
    out.replaceChildren(notice(text, "warning"));
  };
  function runIt() {
    if (idGl === idTb) return fail("Pick two different sheets.");
    if (map.account < 0 || (map.amount < 0 && map.debit < 0 && map.credit < 0)) return fail("Pick the account column and an amount, or debit and credit.");
    const gl = readGl(wb.get(idGl).source, map);
    const tb = readTbSheet(wb.get(idTb).source);
    if (!tb.lines.length) return fail(`${wb.get(idTb).name} doesn't read as a trial balance.`);
    if (opt.against === "movement" && !tb.hasPrior) return fail("The trial balance has no prior column, so there's no movement to compare with.");
    const r = glToTb(gl.lines, tb.lines, { against: opt.against, tolerance: opt.tolerance });
    last = r;
    const kids: Node[] = [
      headline({
        value: money(r.totalDifference),
        unit: "difference",
        tone: Math.abs(r.totalDifference) > opt.tolerance ? "mismatch" : "match",
        caption: `GL ${money(r.totalGl)} against TB ${money(r.totalTb)}.`,
        lines: [
          { label: "Accounts that agree", value: `${count(r.agree)} of ${count(r.lines.length)}`, tone: "match" },
          { label: "Accounts that differ", value: r.differ ? count(r.differ) : "None", tone: r.differ ? "mismatch" : undefined },
          { label: "Only in the GL", value: r.onlyGl ? count(r.onlyGl) : "None", tone: r.onlyGl ? "unmatched" : undefined },
          { label: "Only in the TB", value: r.onlyTb ? count(r.onlyTb) : "None", tone: r.onlyTb ? "unmatched" : undefined },
        ],
      }),
    ];
    const worst = r.lines.filter((l) => l.status !== "agrees").sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 8);
    if (worst.length)
      kids.push(
        section(
          "Largest differences",
          renderTable({
            columns: [
              { key: "account", label: "Account" },
              { key: "name", label: "Name" },
              { key: "gl", label: "GL", format: "amount" },
              { key: "tb", label: "TB", format: "amount" },
              { key: "difference", label: "Difference", format: "amount" },
              { key: "status", label: "Status", format: (v) => cap(String(v)) },
            ],
            rows: worst,
          }).element,
        ),
      );
    if (gl.bad) kids.push(notice(`${plural(gl.bad, "GL amount")} couldn't be read as numbers and counted as 0.`, "warning"));
    if (r.blankAccounts) kids.push(notice(`${plural(r.blankAccounts, "GL line")} had no account and were left out.`, "warning"));
    out.replaceChildren(...kids);
    s.primary.disabled = false;
  }
  s.body.append(sidesBox, section("Options", opts), section("Result", out));
  render();
  runIt();
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
    await d.run(setCells(cells, "Apply mapping table", idData));
    s.close();
    const un = res.unmapped.slice(0, 5).map((u) => u.value).join(", ");
    d.status(`Mapped ${res.mapped.toLocaleString()} of ${values.filter((v) => v !== null && v !== "").length.toLocaleString()} values${res.fuzzy ? ` (${res.fuzzy.toLocaleString()} fuzzy)` : ""}${res.unmapped.length ? `; no mapping for ${plural(res.unmapped.length, "value")}: ${un}${res.unmapped.length > 5 ? ", …" : ""}` : ""}${res.conflicts ? `; ${plural(res.conflicts, "conflicting entry", "conflicting entries")} in the table (first one used)` : ""}`);
    d.focusGrid();
  };
  const s = shell(d, "Apply a mapping table", `Replace the values in a column of ${wb.get(idData).name} using a from → to table on another sheet. One undo puts it back.`, "Apply", apply, "xl");
  s.primary.disabled = false;
  const sidesBox = el("div");
  const out = el("div", { className: "join-result" });
  const render = () => {
    const mn = sheetHeader(wb.get(idMap).source).names;
    sidesBox.replaceChildren(
      sides(
        sideCard({ badge: "A", title: "Change values in", wb, ids: [idData], id: idData, onSheet: () => {}, fields: [field("Column", colSelect(hd.names, col, "Column to map", (c) => ((col = c), render()), false))], highlight: new Map([[col, "Map"]]) }),
        sideCard({
          badge: "B",
          tone: "b",
          title: "Mapping table",
          wb,
          ids: ids.filter((x) => x !== idData),
          id: idMap,
          onSheet: (id) => ((idMap = id), ([from, to] = guessMappingCols(sheetHeader(wb.get(idMap).source).names)), render()),
          fields: [field("From column", colSelect(mn, from, "From column", (c) => ((from = c), render()), false)), field("To column", colSelect(mn, to, "To column", (c) => ((to = c), render()), false))],
          highlight: new Map([
            [from, "From"],
            [to, "To"],
          ]),
        }),
        "←",
      ),
    );
  };
  const match = el("select");
  match.setAttribute("aria-label", "How values must match");
  match.append(new Option("Ignoring case and spaces", "trim+case", true, true), new Option("Exactly", "exact"), new Option("As names (order, titles, Ltd/Inc ignored)", "name"));
  match.addEventListener("change", () => (opt.match = match.value as MappingMatch));
  const opts = el(
    "div",
    { className: "tk-grid join-options" },
    field("Match", match),
    textInput("Fuzzy match %", "", "Blank to turn it off", (v) => (opt.fuzzy = fuzzyValue(v))),
    checkbox("Keep values with no mapping", opt.keep, (v) => (opt.keep = v)),
    checkbox("Replace the original values", opt.inPlace, (v) => (opt.inPlace = v), "Otherwise the result goes in a new column next to the data"),
  );

  // build a table: suggested pairs between the column and a master list
  const suggest = async () => {
    const m = wb.get(idMap).source;
    const hm = sheetHeader(m);
    const sheet = suggestionSheet(readColumn(data, col, hd.first), readColumn(m, to, hm.first), opt.suggest);
    const n = sheet.columns[0]?.kind === "string" ? sheet.columns[0].codes.length : 0;
    if (!n) return void out.replaceChildren(notice("No similar names found.", "info"));
    await addResultSheets(writer(d), [sheet]);
    s.close();
    d.status(`Suggested ${plural(n, "pair")}: check them, delete the wrong ones, then apply this sheet as the mapping table.`);
    d.focusGrid();
  };
  s.body.append(
    sidesBox,
    section("Options", opts),
    section(
      "No table yet?",
      el("p", { className: "tk-muted", textContent: "Suggest pairs builds one: each distinct value in the column, paired with the most similar name in the To column of the other sheet (your master list)." }),
      el("div", { className: "rc-why" }, textInput("How alike names must be (%)", "85", "", (v) => (opt.suggest = fuzzyValue(v) ?? 0.85)), button("Suggest pairs", suggest, "secondary")),
      out,
    ),
  );
  render();
}
