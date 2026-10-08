/**
 * Data checks and categorisation.
 *
 * Data checks: a list of rules about the workbook's sheets (not blank,
 * unique, type, range, pattern, master list, totals agree, row count, no
 * duplicate keys, a formula TRUE on every row), run on demand into a green /
 * red checklist with links to the failing cells. The checks are saved with
 * the workbook (through the store below) and changed by an undoable action,
 * "checks.set". gateExport asks before exporting while any check fails.
 *
 * Categorise: rules (contains / starts with / regex / equals / amount range,
 * or a text rule and an amount range together) that write a category into a
 * column; rules learned from rows already tagged by hand; bulk tagging of the
 * selected rows; and the uncategorised queue as a filter on blank categories.
 * Categories already in the column are kept unless asked otherwise.
 */
import { type Action, type ActionRegistry, s } from "@cellforge/actions";
import { suggestCategories, type Model } from "@cellforge/ai";
import { moveFormula, parseFormula, parseTyped, type Node } from "@cellforge/core";
import { columnLetter, type CellRange } from "@cellforge/grid";
import {
  categorise,
  categoryRuleProblem,
  CHECK_KIND_LABEL,
  checkProblem,
  checksAllPass,
  describeCatCondition,
  describeCheck,
  learnRules,
  runChecks,
  type CatCondition,
  type CatRule,
  type CategoriseResult,
  type CheckDef,
  type CheckKind,
  type CheckNormalise,
  type CheckResult,
  type CheckSource,
  type CheckTable,
  type CheckValue,
  type LearnedRule,
} from "@cellforge/core";
import { setCells, type SheetCtx } from "./actions";
import { readSheet, sheetSamples, type SheetData } from "./audittools";
import type { EditableSource } from "./editable";
import type { Sheet, Workbook } from "./workbook";
import "./checks.css";
import { guessRoles, profileColumns, type ColumnSample } from "./colguess";
import { emptyState, headline, report } from "./toolkit";
import { openDialog } from "./ui/dialog";
import { closeSidePanel, openSidePanel } from "./ui/sidepanel";

// ------------------------------------------------------------------ store --

/**
 * Where the checks and category rules live. By default a module-level list;
 * once the workbook keeps them, bind the store to it with bindChecksStore so
 * they're saved and opened with the file.
 */
export interface ChecksStore {
  getChecks(): CheckDef[];
  setChecks(checks: CheckDef[]): void;
  getRules(): CatRule[];
  setRules(rules: CatRule[]): void;
}

let localChecks: CheckDef[] = [];
let localRules: CatRule[] = [];
let store: ChecksStore = {
  getChecks: () => localChecks,
  setChecks: (c) => (localChecks = c),
  getRules: () => localRules,
  setRules: (r) => (localRules = r),
};
let boundWorkbook: (() => Workbook) | null = null;
const listeners = new Set<() => void>();
/** the last results, by check id (cleared when the check changes) */
let lastResults = new Map<string, CheckResult>();

/** Point the store somewhere else (the workbook) and say which workbook checksPass() / gateExport() look at. */
export function bindChecksStore(b: Partial<ChecksStore> & { workbook?: () => Workbook }): void {
  store = { ...store, ...b };
  if (b.workbook) boundWorkbook = b.workbook;
  lastResults = new Map();
  notify();
}

export const getChecks = (): CheckDef[] => store.getChecks();
export function setChecks(checks: CheckDef[]): void {
  store.setChecks(checks);
  notify();
}
export const getCategoryRules = (): CatRule[] => store.getRules();
export function setCategoryRules(rules: CatRule[]): void {
  store.setRules(rules);
  notify();
}

/** Called after the checks or rules change (also on undo / redo). Returns a function that stops it. */
export function onChecksChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

const anyObject = { type: "object", properties: {}, additionalProperties: true } as const;

/**
 * checks.set {checks} and categories.setRules {rules}: replace the saved
 * checks / category rules; each undoes to the list as it was.
 */
export function registerCheckActions(registry: ActionRegistry<SheetCtx>): void {
  registry
    .register<{ checks: CheckDef[]; label?: string }>({
      type: "checks.set",
      title: "Replace the workbook's data checks (column rules, master lists, totals that must agree)",
      schema: s.object({ checks: s.array(anyObject, "the checks, as JSON"), label: s.string("what changed, for the undo menu") }, ["checks"]),
      describe: (p) => p.label ?? `data checks (${p.checks.length})`,
      recordable: false,
      apply(_ctx, p) {
        if (!Array.isArray(p.checks) || p.checks.some((c) => !c || typeof c.id !== "string" || typeof c.kind !== "string")) throw new Error("Each check needs an id and a kind.");
        const before = structuredClone(store.getChecks());
        const ids = new Set(p.checks.map((c) => JSON.stringify(c)));
        // results of checks that changed are out of date
        for (const c of before) if (!ids.has(JSON.stringify(c))) lastResults.delete(c.id);
        setChecks(structuredClone(p.checks));
        return { type: "checks.set", params: { checks: before, ...(p.label ? { label: p.label } : {}) } };
      },
    })
    .register<{ rules: CatRule[]; label?: string }>({
      type: "categories.setRules",
      title: "Replace the workbook's categorisation rules",
      schema: s.object({ rules: s.array(anyObject, "the rules, as JSON"), label: s.string("what changed, for the undo menu") }, ["rules"]),
      describe: (p) => p.label ?? `category rules (${p.rules.length})`,
      recordable: false,
      apply(_ctx, p) {
        if (!Array.isArray(p.rules) || p.rules.some((r) => !r || typeof r.id !== "string" || typeof r.category !== "string" || !r.condition)) throw new Error("Each rule needs an id, a condition and a category.");
        const before = structuredClone(store.getRules());
        setCategoryRules(structuredClone(p.rules));
        return { type: "categories.setRules", params: { rules: before, ...(p.label ? { label: p.label } : {}) } };
      },
    });
}

// ---------------------------------------------------------- running checks --

/** A sheet by id, or else by name (checks copied from another workbook find sheets by name). */
export function findSheet(wb: Workbook, ref: string): Sheet | null {
  if (wb.has(ref)) return wb.get(ref);
  return wb.byName(ref) ?? null;
}

const bareName = (n: string) => n.replace(/^[A-Z]+: /, "");

/** The workbook's sheets as check tables, read once per run. */
export function workbookSource(wb: Workbook): CheckSource & { data(ref: string): { sheet: Sheet; data: SheetData } | null } {
  const cache = new Map<string, { sheet: Sheet; data: SheetData } | null>();
  const data = (ref: string) => {
    if (!cache.has(ref)) {
      const sheet = findSheet(wb, ref);
      cache.set(ref, sheet ? { sheet, data: readSheet(sheet.source) } : null);
    }
    return cache.get(ref)!;
  };
  return {
    data,
    table(ref): CheckTable | null {
      const d = data(ref);
      if (!d) return null;
      const t = d.data;
      return { rows: t.rows, cols: t.names.length, names: t.names.map(bareName), get: (r, c) => (t.col(c)[r] ?? null) as CheckValue, numFmt: (c) => t.numFmt(c) };
    },
  };
}

const asts = new Map<string, Node | null>();
function formulaAst(formula: string): Node | null {
  let ast = asts.get(formula);
  if (ast === undefined) {
    try {
      ast = parseFormula(formula.startsWith("=") ? formula : `=${formula}`);
    } catch {
      ast = null;
    }
    asts.set(formula, ast);
  }
  return ast;
}

/** Run checks on the workbook. A formula check is written for the first data row and moved down, like a filled formula. */
export function runWorkbookChecks(wb: Workbook, defs: readonly CheckDef[] = getChecks(), maxFailures = 20): CheckResult[] {
  const src = workbookSource(wb);
  const results = runChecks(defs, src, {
    maxFailures,
    evalFormula(formula, ref, row) {
      const d = src.data(ref);
      const ast = formulaAst(formula);
      if (!d || !ast) throw new Error("The formula has a problem; check its brackets and names.");
      const sheetRow = d.data.first + row;
      return (d.sheet.source as EditableSource).evalAt(moveFormula(ast, row, 0), sheetRow, 0);
    },
  });
  for (const r of results) lastResults.set(r.id, r);
  return results;
}

/** The checks that fail (warnings don't). */
export const failingChecks = (results: readonly CheckResult[]) => results.filter((r) => r.status === "fail");

/** True when every check passes (or warns), or there are no checks. Runs them on the bound workbook (or the one given). */
export function checksPass(wb: Workbook | undefined = boundWorkbook?.()): boolean {
  if (!wb || !getChecks().some((c) => c.enabled !== false)) return true;
  return checksAllPass(runWorkbookChecks(wb));
}

/** The cell a failure points at, for the link: sheet id and 0-based sheet row and column. Null for whole-table results without a column. */
export function failureCell(wb: Workbook, result: Pick<CheckResult, "sheet">, f: { row: number; col: number }): { sheetId: string; row: number; col: number } | null {
  const sheet = findSheet(wb, result.sheet);
  if (!sheet) return null;
  const data = readSheet(sheet.source);
  if (f.row < 0) {
    if (f.col < 0) return null;
    // totals: the cell just below the column's last row
    return { sheetId: sheet.id, row: data.first + data.rows, col: f.col };
  }
  return { sheetId: sheet.id, row: data.first + f.row, col: Math.max(0, f.col) };
}

/**
 * Before an export: when any check fails, ask "Checks are failing — export
 * anyway?" and only continue on yes. Resolves true when the export went ahead.
 */
export async function gateExport(continueFn: () => unknown, wb: Workbook | undefined = boundWorkbook?.()): Promise<boolean> {
  if (!wb || !getChecks().some((c) => c.enabled !== false)) {
    await continueFn();
    return true;
  }
  const failing = failingChecks(runWorkbookChecks(wb));
  if (!failing.length) {
    await continueFn();
    return true;
  }
  const ok = await confirmExport(failing);
  if (ok) await continueFn();
  return ok;
}

function confirmExport(failing: readonly CheckResult[]): Promise<boolean> {
  const list = el("ul", "ck-confirm-list");
  for (const r of failing.slice(0, 8)) list.append(el("li", "", `${r.name}: ${r.message}`));
  if (failing.length > 8) list.append(el("li", "", `and ${failing.length - 8} more`));
  const dlg = openDialog({
    title: "Checks are failing: export anyway?",
    size: "md",
    role: "alertdialog",
    initialFocus: "[data-act=cancel]",
    body: [`${failing.length === 1 ? "1 check fails" : `${failing.length} checks fail`}. The exported file will carry the problems below.`, list],
    actions: [
      { label: "Don't export", dismiss: true },
      { label: "Export anyway", id: "go", kind: "danger" },
    ],
  });
  return dlg.closed.then((r) => r === "go");
}

/** One-click checks for a sheet, from what its columns look like. Pure. */
export function starterChecks(sheet: string, samples: readonly ColumnSample[]): { label: string; def: CheckDef }[] {
  const roles = guessRoles(samples);
  const profiles = profileColumns(samples);
  const name = (c: number) => samples[c].name || `column ${c + 1}`;
  const out: { label: string; def: CheckDef }[] = [];
  const id = () => newId("chk");
  const debit = samples.findIndex((x) => /debit|\bdr\b/i.test(x.name));
  const credit = samples.findIndex((x) => /credit|\bcr\b/i.test(x.name));
  if (debit >= 0 && credit >= 0) out.push({ label: "Debits equal credits", def: { id: id(), sheet, kind: "totalsEqual", col: debit, otherCol: credit, tolerance: 0.005, name: "Debits equal credits" } });
  else if (roles.amount >= 0 && samples.some((x) => /entry|journal|\bje\b/i.test(x.name))) out.push({ label: `${name(roles.amount)} nets to zero`, def: { id: id(), sheet, kind: "totalsEqual", col: roles.amount, tolerance: 0.005, name: `${name(roles.amount)} nets to zero (debits = credits)` } });
  if (roles.reference >= 0) {
    out.push({ label: `No blank ${name(roles.reference)}`, def: { id: id(), sheet, kind: "notBlank", col: roles.reference } });
    if (profiles[roles.reference].distinctShare > 0.95) out.push({ label: `${name(roles.reference)} is unique`, def: { id: id(), sheet, kind: "unique", col: roles.reference } });
  }
  if (roles.account >= 0) out.push({ label: `No blank ${name(roles.account)}`, def: { id: id(), sheet, kind: "notBlank", col: roles.account } });
  if (roles.amount >= 0) out.push({ label: `${name(roles.amount)} holds numbers`, def: { id: id(), sheet, kind: "type", col: roles.amount, type: "number", allowBlank: true } });
  if (roles.date >= 0) out.push({ label: `${name(roles.date)} holds dates`, def: { id: id(), sheet, kind: "type", col: roles.date, type: "date", allowBlank: false } });
  const dupKey = [roles.party, roles.reference, roles.amount].filter((c) => c >= 0);
  if (dupKey.length >= 2) out.push({ label: `No duplicate ${dupKey.map(name).join(" + ")}`, def: { id: id(), sheet, kind: "noDuplicateKeys", cols: dupKey } });
  return out.slice(0, 6);
}

// ------------------------------------------------------------ list editing --

/** The list with item i moved up (-1) or down (+1); unchanged at the ends. */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  const out = [...list];
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

let idCounter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** A fresh check of a kind, with sensible defaults. */
export function blankCheck(kind: CheckKind, sheet: string, cols: number): CheckDef {
  const base = { id: newId("chk"), sheet };
  const c = 0;
  switch (kind) {
    case "notBlank":
      return { ...base, kind, col: c };
    case "unique":
      return { ...base, kind, col: c };
    case "type":
      return { ...base, kind, col: c, type: "number" };
    case "range":
      return { ...base, kind, col: c, min: 0 };
    case "pattern":
      return { ...base, kind, col: c, pattern: "" };
    case "inList":
      return { ...base, kind, col: c, listSheet: "", listCol: 0, normalise: { ignoreCase: true, spaces: true } };
    case "totalsEqual":
      return { ...base, kind, col: c, otherCol: Math.min(1, Math.max(0, cols - 1)), tolerance: 0 };
    case "rowCount":
      return { ...base, kind, min: 1 };
    case "noDuplicateKeys":
      return { ...base, kind, cols: [c] };
    case "formula":
      return { ...base, kind, formula: "" };
  }
}

// ---------------------------------------------------------- categorisation --

/** What a category rule looks like in the rules table: one text test and an optional amount range. */
export interface RuleRow {
  match: "contains" | "word" | "startsWith" | "equals" | "regex" | "none";
  text: string;
  min: string;
  max: string;
  category: string;
  priority: string;
}

const num = (t: string): number | undefined => {
  const x = t.trim() === "" ? NaN : Number(t.replace(/,/g, ""));
  return Number.isFinite(x) ? x : undefined;
};

/** A table row as a rule (a text test and an amount range together become an "all" rule). */
export function rowToRule(r: RuleRow, id: string, source?: CatRule["source"]): CatRule {
  const parts: CatCondition[] = [];
  if (r.match !== "none") {
    if (r.match === "regex") parts.push({ kind: "regex", pattern: r.text });
    else if (r.match === "word") parts.push({ kind: "contains", text: r.text, word: true });
    else parts.push({ kind: r.match, text: r.text });
  }
  const min = num(r.min);
  const max = num(r.max);
  if (min !== undefined || max !== undefined) parts.push({ kind: "amount", ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
  const condition: CatCondition = parts.length === 1 ? parts[0] : { kind: "all", conditions: parts };
  const priority = num(r.priority);
  return { id, condition, category: r.category.trim(), ...(priority !== undefined ? { priority } : {}), ...(source ? { source } : {}) };
}

/** A rule as a table row; null when it's more than one text test and an amount range (shown read-only). */
export function ruleToRow(rule: CatRule): RuleRow | null {
  const row: RuleRow = { match: "none", text: "", min: "", max: "", category: rule.category, priority: rule.priority !== undefined ? String(rule.priority) : "" };
  const parts = rule.condition.kind === "all" ? rule.condition.conditions : [rule.condition];
  let texts = 0;
  let amounts = 0;
  for (const p of parts) {
    if (p.kind === "all") return null;
    if (p.kind === "amount") {
      amounts++;
      row.min = p.min !== undefined ? String(p.min) : "";
      row.max = p.max !== undefined ? String(p.max) : "";
    } else {
      texts++;
      if (p.kind === "regex") [row.match, row.text] = ["regex", p.pattern];
      else if (p.kind === "contains") [row.match, row.text] = [p.word ? "word" : "contains", p.text];
      else [row.match, row.text] = [p.kind, p.text];
    }
  }
  return texts > 1 || amounts > 1 ? null : row;
}

export interface CatColumns {
  text: number;
  /** -1: none */
  amount: number;
  category: number;
}

/** The rows as categorisation sees them: text, amount and the category they have now. */
export function readCatRows(data: SheetData, cols: CatColumns): { text: string; amount: number | null; category: string | null }[] {
  const text = data.col(cols.text);
  const amount = cols.amount >= 0 ? data.col(cols.amount) : null;
  const cat = cols.category < data.names.length ? data.col(cols.category) : null;
  return Array.from({ length: data.rows }, (_, i) => {
    const a = amount?.[i];
    const c = cat?.[i];
    return {
      text: text[i] === null || text[i] === undefined ? "" : String(text[i]),
      amount: typeof a === "number" ? a : typeof a === "string" && num(a) !== undefined ? num(a)! : null,
      category: c === null || c === undefined || String(c).trim() === "" ? null : String(c).trim(),
    };
  });
}

/** What to type so a category stays text ("2024", "=x" and "1/2" would otherwise change). */
export function categoryInput(category: string): string {
  const c = category.trim();
  if (/^[=+\-@']/.test(c) || /^\d/.test(c) || /^(true|false)$/i.test(c) || parseTyped(c)) return "'" + c;
  return c;
}

/** The cells to write for a categorisation result (only rows whose category changes). Header added for a new column. */
export function categoryCells(data: SheetData, col: number, result: Pick<CategoriseResult, "categories" | "changed">, header = "Category"): { row: number; col: number; input: string | null }[] {
  const cells: { row: number; col: number; input: string | null }[] = result.changed.map((i) => {
    const c = result.categories[i];
    return { row: data.first + i, col, input: c === null ? null : categoryInput(c) };
  });
  if (cells.length && col >= data.names.length && data.first > 0) cells.unshift({ row: data.first - 1, col, input: header });
  return cells;
}

/** The cells to write to tag the rows of a range with one category (header rows and rows past the data left out). */
export function bulkTagCells(data: SheetData, range: Pick<CellRange, "top" | "bottom">, col: number, category: string): { row: number; col: number; input: string | null }[] {
  const top = Math.max(range.top, data.first);
  const bottom = Math.min(range.bottom, data.first + data.rows - 1);
  const input = category.trim() ? categoryInput(category) : null;
  const cells: { row: number; col: number; input: string | null }[] = [];
  for (let r = top; r <= bottom; r++) cells.push({ row: r, col, input });
  return cells;
}

/** The action that shows only rows with no category. */
export function uncategorisedFilter(sheetId: string, data: SheetData, col: number): Action {
  return { type: "filter.set", params: { sheet: sheetId, col, condition: { kind: "blanks", blank: true }, headerRow: data.first > 0 ? data.first - 1 : -1 } };
}

/** Guess the text, amount and category columns from the names. */
export function guessCatColumns(names: readonly string[]): CatColumns {
  const find = (re: RegExp) => names.findIndex((n) => re.test(bareName(n)));
  const text = find(/desc|narrat|memo|payee|merchant|details?|particular|reference|text|name/i);
  const amount = find(/amount|amt|value|debit|net|total|sum/i);
  const category = find(/categor|class|tag|bucket|type|group|code/i);
  return { text: text >= 0 ? text : 0, amount, category: category >= 0 && category !== text && category !== amount ? category : names.length };
}

// ----------------------------------------------------------- DOM helpers --

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, title?: string): HTMLButtonElement {
  const b = el("button", "", text);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  return b;
}

function row(cls: string, ...children: (HTMLElement | string)[]): HTMLDivElement {
  const d = el("div", cls);
  d.append(...children);
  return d;
}

function field(text: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const l = el("label");
  l.append(text, control);
  if (hint) l.append(el("small", "", hint));
  return l;
}

function select(options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const s = el("select");
  for (const [v, t] of options) s.append(new Option(t, v));
  s.value = value;
  return s;
}

function input(value: string, type = "text", placeholder = ""): HTMLInputElement {
  const i = el("input");
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  if (type === "number") i.step = "any";
  return i;
}

function tick(text: string, checked: boolean): { el: HTMLLabelElement; input: HTMLInputElement } {
  const l = el("label", "audit-check");
  const i = el("input");
  i.type = "checkbox";
  i.checked = checked;
  l.append(i, text);
  return { el: l, input: i };
}

function dialog(title: string, cls: string, onClose: () => void): { back: { remove(): void }; body: HTMLElement; close: () => void } {
  const dlg = openDialog({ title, size: "lg", className: `ck-dialog tk-legacy ${cls}`, onClose: () => onClose() });
  // the tool adds its own button row and title to the body: move the row into the fixed footer, drop the repeated title
  dlg.footer.hidden = true;
  const tidy = new MutationObserver(() => {
    for (const r of dlg.body.querySelectorAll<HTMLElement>(":scope > .numfmt-actions")) {
      dlg.footer.hidden = false;
      dlg.footer.append(...r.children);
      r.remove();
      const buttons = [...dlg.footer.querySelectorAll<HTMLButtonElement>(":scope > button")];
      const main = buttons[buttons.length - 1];
      for (const b of buttons) b.className = b === main ? "btn-primary" : b.textContent === "Close" ? "" : "btn-secondary";
    }
    const h = dlg.body.querySelector(":scope > h3");
    if (h?.textContent === title) h.remove();
  });
  tidy.observe(dlg.body, { childList: true });
  const close = () => {
    tidy.disconnect();
    dlg.close();
  };
  return { back: { remove: close }, body: dlg.body, close };
}

const colOptions = (names: readonly string[]) => names.map((n, c) => [String(c), n] as const);

// ---------------------------------------------------------- checks panel --

export interface ChecksDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (text: string) => void;
  focusGrid: () => void;
}

const STATUS_MARK: Record<CheckResult["status"] | "none", string> = { pass: "✓", fail: "✗", warn: "!", none: "–" };

/** The "Data checks" panel: the list of checks, add / edit / delete / reorder, Run checks. */
export function openChecks(d: ChecksDeps): void {
  let panelBody: HTMLElement | null = null;
  let panelFooter: HTMLElement | null = null;
  let stop: () => void = () => undefined;
  openSidePanel({
    id: "data-checks",
    title: "Data checks",
    subtitle: "Rules the data must pass before export",
    onClose: () => d.focusGrid(),
    render: (p) => {
      panelBody = p.body;
      panelFooter = p.footer;
      stop = onChecksChange(() => render());
      return () => stop();
    },
  });
  const body = panelBody! as HTMLElement;
  const close = () => closeSidePanel();
  const intro = el("p", "tk-muted", "Rules the data must keep, saved with the workbook. Run them before you export: while any check fails, exporting asks first.");
  const summary = el("div", "ck-summary");
  summary.setAttribute("aria-live", "polite");
  const list = el("ol", "ck-list");
  const editor = el("div", "ck-editor");
  const add = button("Add check…");
  add.className = "btn-secondary";
  const runBtn = button("Run checks");
  runBtn.className = "btn-primary";
  const starters = el("div", "ck-starters");
  body.append(intro, summary, starters, list, editor);
  (panelFooter! as HTMLElement).append(add, runBtn);
  const expanded = new Set<string>();

  const save = (checks: CheckDef[], label: string) => void d.run({ type: "checks.set", params: { checks, label } }).catch((e: Error) => d.status(e.message));

  function render() {
    const wb = d.workbook();
    const checks = getChecks();
    list.replaceChildren();
    starters.replaceChildren();
    if (!checks.length) {
      const sheetId = d.activeSheet();
      const src = wb.get(sheetId).source;
      const data = readSheet(src);
      const offers = data.names.length ? starterChecks(sheetId, sheetSamples(data)) : [];
      const box = el("div", "ck-starter-list");
      for (const o of offers) {
        const b = button(`+ ${o.label}`, "Add this check");
        b.className = "btn-secondary btn-sm";
        b.addEventListener("click", () => save([...getChecks(), o.def], "add a check"));
        box.append(b);
      }
      starters.append(
        emptyState({
          icon: "check",
          title: "No checks yet",
          text: offers.length ? `Start with a few for ${wb.get(sheetId).name}, picked from its columns. Click to add; you can edit them later.` : "Add rules such as: the account is in the chart of accounts, debits equal credits, invoice numbers are unique.",
          action: offers.length ? box : undefined,
        }),
      );
    }
    checks.forEach((c, i) => {
      const r = lastResults.get(c.id);
      const off = c.enabled === false;
      const st = off ? "none" : (r?.status ?? "none");
      const li = el("li", `ck-item ck-${st}${off ? " ck-off" : ""}`);
      const mark = el("span", "ck-mark", STATUS_MARK[st]);
      mark.setAttribute("aria-label", off ? "off" : r ? r.status : "not run");
      const sheet = findSheet(wb, c.sheet);
      const names = sheet ? readSheet(sheet.source).names.map(bareName) : undefined;
      const title = el("span", "ck-name", c.name?.trim() || describeCheck(c, names));
      const where = el("span", "ck-where", `${sheet?.name ?? `(missing sheet ${c.sheet})`} · ${CHECK_KIND_LABEL[c.kind]}${c.severity === "warn" ? " · warning only" : ""}`);
      const msg = el("span", "ck-msg", off ? "Off" : r ? `${r.message}${r.failed && r.checked ? ` (${r.failed.toLocaleString("en-US")} of ${r.checked.toLocaleString("en-US")})` : ""}` : "Not run yet");
      const on = el("input");
      on.type = "checkbox";
      on.checked = !off;
      on.title = "Run this check";
      on.setAttribute("aria-label", "Run this check");
      on.addEventListener("change", () => {
        const next = structuredClone(checks);
        next[i].enabled = on.checked ? undefined : false;
        if (on.checked) delete next[i].enabled;
        save(next, on.checked ? "turn a check on" : "turn a check off");
      });
      const edit = button("Edit", "Edit this check");
      edit.addEventListener("click", () => openEditor(c, i));
      const up = button("↑", "Move up");
      up.disabled = i === 0;
      up.addEventListener("click", () => save(moveItem(checks, i, -1), "reorder checks"));
      const down = button("↓", "Move down");
      down.disabled = i === checks.length - 1;
      down.addEventListener("click", () => save(moveItem(checks, i, 1), "reorder checks"));
      const del = button("✕", "Delete this check");
      del.addEventListener("click", () => save(checks.filter((_, k) => k !== i), "delete a check"));
      const head = row("ck-head", mark, row("ck-text", title, where, msg), row("ck-buttons", on, edit, up, down, del));
      li.append(head);
      if (r && r.failures.length && !off) {
        const more = button(expanded.has(c.id) ? "Hide failing rows" : `Show failing rows${r.failed > r.failures.length ? ` (first ${r.failures.length})` : ""}`);
        more.className = "ck-more";
        more.addEventListener("click", () => {
          if (expanded.has(c.id)) expanded.delete(c.id);
          else expanded.add(c.id);
          render();
        });
        li.append(more);
        if (expanded.has(c.id)) li.append(failureList(wb, r));
      }
      list.append(li);
    });
    const results = checks.filter((c) => c.enabled !== false).map((c) => lastResults.get(c.id));
    summary.replaceChildren();
    if (results.length && results.every(Boolean)) {
      const fails = results.filter((r) => r!.status === "fail").length;
      const warns = results.filter((r) => r!.status === "warn").length;
      summary.append(
        headline({
          value: `${results.length - fails} of ${results.length}`,
          unit: "checks pass",
          progress: (results.length - fails) / results.length,
          tone: fails ? "mismatch" : "match",
          caption: fails ? `${fails} fail${warns ? `, ${warns} warn` : ""}. Open a failing check to see its rows.` : `Everything passes${warns ? ` (${warns} with warnings)` : ""}. Exports go ahead without asking.`,
        }),
      );
    }
  }

  function failureList(wb: Workbook, r: CheckResult): HTMLElement {
    const ul = el("ul", "ck-failures");
    for (const f of r.failures) {
      const cell = failureCell(wb, r, f);
      const ref = cell ? `${columnLetter(cell.col)}${cell.row + 1}` : "";
      const value = f.value === null ? "(blank)" : String(f.value);
      const text = f.row < 0 ? `${f.note ?? "result"}: ${value}` : `Row ${cell ? cell.row + 1 : f.row + 1}${ref ? ` (${ref})` : ""}: ${value}${f.note ? ` · ${f.note}` : ""}`;
      const li = el("li");
      if (cell) {
        const a = button(text, `Go to ${ref}`);
        a.className = "ck-link";
        a.addEventListener("click", () => {
          close();
          d.goTo(cell.sheetId, cell.row, cell.col);
        });
        li.append(a);
      } else li.textContent = text;
      ul.append(li);
    }
    return ul;
  }

  function openEditor(existing: CheckDef | null, index: number) {
    const wb = d.workbook();
    const sheets = wb.sheets.filter((x) => !x.hidden);
    const sheetOpts = sheets.map((x) => [x.id, x.name] as const);
    let draft: CheckDef = existing ? structuredClone(existing) : blankCheck("notBlank", d.activeSheet(), 1);
    const namesOf = (ref: string) => {
      const sh = findSheet(wb, ref);
      return sh ? readSheet(sh.source).names : [];
    };
    const draw = () => {
      editor.replaceChildren();
      const sheetRef = findSheet(wb, draft.sheet)?.id ?? sheets[0]?.id ?? "";
      draft.sheet = sheetRef;
      const names = namesOf(sheetRef);
      const kind = select(
        (Object.keys(CHECK_KIND_LABEL) as CheckKind[]).map((k) => [k, CHECK_KIND_LABEL[k]] as const),
        draft.kind,
      );
      kind.addEventListener("change", () => {
        const fresh = blankCheck(kind.value as CheckKind, draft.sheet, names.length);
        if ("col" in draft && "col" in fresh) fresh.col = draft.col;
        draft = { ...fresh, id: draft.id, ...(draft.name ? { name: draft.name } : {}), ...(draft.severity ? { severity: draft.severity } : {}) } as CheckDef;
        draw();
      });
      const sheet = select(sheetOpts, sheetRef);
      sheet.addEventListener("change", () => {
        draft.sheet = sheet.value;
        draw();
      });
      const name = input(draft.name ?? "", "text", describeCheck(draft, names.map(bareName)));
      name.addEventListener("input", () => (draft.name = name.value.trim() || undefined));
      const severity = select(
        [
          ["fail", "Fail (blocks export until you say so)"],
          ["warn", "Warning only"],
        ],
        draft.severity ?? "fail",
      );
      severity.addEventListener("change", () => (draft.severity = severity.value === "warn" ? "warn" : undefined));
      const fields: HTMLElement[] = [field("Check", kind), field("Sheet", sheet)];
      const colField = (label: string, get: () => number, set: (c: number) => void, hint?: string) => {
        const sel = select(colOptions(names), String(get()));
        sel.addEventListener("change", () => set(Number(sel.value)));
        return field(label, sel, hint);
      };
      const numField = (label: string, get: () => number | undefined, set: (n: number | undefined) => void, hint?: string) => {
        const i = input(get() === undefined ? "" : String(get()), "number");
        i.addEventListener("input", () => set(num(i.value)));
        return field(label, i, hint);
      };
      const boolField = (label: string, get: () => boolean, set: (b: boolean) => void) => {
        const t = tick(label, get());
        t.input.addEventListener("change", () => set(t.input.checked));
        return t.el;
      };
      const normFields = (n: () => CheckNormalise, set: (x: CheckNormalise) => void) =>
        row(
          "ck-ticks",
          boolField("Ignore case", () => n().ignoreCase !== false, (b) => set({ ...n(), ignoreCase: b })),
          boolField("Ignore extra spaces", () => n().spaces !== false, (b) => set({ ...n(), spaces: b })),
          boolField("Ignore leading zeros", () => !!n().leadingZeros, (b) => set({ ...n(), leadingZeros: b })),
          boolField("Ignore punctuation", () => !!n().punctuation, (b) => set({ ...n(), punctuation: b })),
        );
      const blankField = (dd: { allowBlank?: boolean }) => boolField("Blank cells are fine", () => dd.allowBlank !== false, (b) => (dd.allowBlank = b ? undefined : false));
      const dr = draft;
      switch (dr.kind) {
        case "notBlank":
          fields.push(colField("Column", () => dr.col, (c) => (dr.col = c)));
          break;
        case "unique":
          fields.push(
            colField("Column", () => dr.col, (c) => (dr.col = c)),
            normFields(
              () => dr.normalise ?? {},
              (x) => (dr.normalise = x),
            ),
          );
          break;
        case "type": {
          const t = select(
            [
              ["number", "Numbers"],
              ["date", "Dates"],
              ["text", "Text"],
            ],
            dr.type,
          );
          t.addEventListener("change", () => (dr.type = t.value as "number" | "date" | "text"));
          fields.push(colField("Column", () => dr.col, (c) => (dr.col = c)), field("Every value is", t, "Numbers typed as text fail a numbers check."), blankField(dr));
          break;
        }
        case "range":
          fields.push(
            colField("Column", () => dr.col, (c) => (dr.col = c)),
            numField("Lowest allowed", () => dr.min, (n) => (dr.min = n)),
            numField("Highest allowed", () => dr.max, (n) => (dr.max = n)),
            blankField(dr),
          );
          break;
        case "pattern": {
          const p = input(dr.pattern, "text", "e.g. ^INV-\\d{6}$");
          p.addEventListener("input", () => (dr.pattern = p.value));
          fields.push(colField("Column", () => dr.col, (c) => (dr.col = c)), field("Pattern (regular expression)", p, "^ is the start, $ the end, \\d a digit, [A-Z] a capital letter."), boolField("Ignore case", () => !!dr.ignoreCase, (b) => (dr.ignoreCase = b || undefined)), blankField(dr));
          break;
        }
        case "inList": {
          if (!dr.listSheet || !findSheet(wb, dr.listSheet)) dr.listSheet = (sheets.find((x) => x.id !== dr.sheet) ?? sheets[0])?.id ?? "";
          const ls = select(sheetOpts, findSheet(wb, dr.listSheet)?.id ?? "");
          ls.addEventListener("change", () => {
            dr.listSheet = ls.value;
            dr.listCol = 0;
            draw();
          });
          const listNames = namesOf(dr.listSheet);
          const lc = select(colOptions(listNames), String(dr.listCol));
          lc.addEventListener("change", () => (dr.listCol = Number(lc.value)));
          fields.push(
            colField("Column to check", () => dr.col, (c) => (dr.col = c)),
            field("Master list sheet", ls),
            field("Master list column", lc),
            normFields(
              () => dr.normalise ?? {},
              (x) => (dr.normalise = x),
            ),
            blankField(dr),
          );
          break;
        }
        case "totalsEqual": {
          const against = select(
            [
              ["col", "the total of another column"],
              ["control", "a control total"],
            ],
            dr.otherCol !== undefined && dr.otherCol >= 0 ? "col" : "control",
          );
          against.addEventListener("change", () => {
            if (against.value === "col") {
              dr.otherCol = 0;
              delete dr.control;
            } else {
              delete dr.otherCol;
              delete dr.otherSheet;
              dr.control = dr.control ?? 0;
            }
            draw();
          });
          fields.push(colField("Add up", () => dr.col, (c) => (dr.col = c), "For debits = credits, add up the debits here."), field("It must equal", against));
          if (dr.otherCol !== undefined && dr.otherCol >= 0) {
            const os = select(sheetOpts, findSheet(wb, dr.otherSheet ?? dr.sheet)?.id ?? dr.sheet);
            os.addEventListener("change", () => {
              dr.otherSheet = os.value === dr.sheet ? undefined : os.value;
              dr.otherCol = 0;
              draw();
            });
            const otherNames = namesOf(dr.otherSheet ?? dr.sheet);
            const oc = select(colOptions(otherNames), String(dr.otherCol));
            oc.addEventListener("change", () => (dr.otherCol = Number(oc.value)));
            fields.push(field("Sheet of the other column", os), field("Other column", oc, "The credits, for debits = credits."));
          } else fields.push(numField("Control total", () => dr.control, (n) => (dr.control = n), "0 for a signed amount column whose debits and credits cancel."));
          fields.push(numField("Tolerance", () => dr.tolerance, (n) => (dr.tolerance = n), "How far apart they may be, e.g. 0.01 for rounding."));
          break;
        }
        case "rowCount":
          fields.push(numField("At least (rows)", () => dr.min, (n) => (dr.min = n)), numField("At most (rows)", () => dr.max, (n) => (dr.max = n)));
          break;
        case "noDuplicateKeys": {
          const box = row("ck-ticks ck-cols");
          names.forEach((n, c) => {
            const t = tick(n, dr.cols.includes(c));
            t.input.addEventListener("change", () => {
              dr.cols = t.input.checked ? [...dr.cols, c].sort((a, b) => a - b) : dr.cols.filter((x) => x !== c);
            });
            box.append(t.el);
          });
          fields.push(
            field("Key columns (together)", box),
            normFields(
              () => dr.normalise ?? {},
              (x) => (dr.normalise = x),
            ),
          );
          break;
        }
        case "formula": {
          const data = findSheet(wb, dr.sheet) ? readSheet(findSheet(wb, dr.sheet)!.source) : null;
          const f = input(dr.formula, "text", `e.g. =C${(data?.first ?? 1) + 1}+D${(data?.first ?? 1) + 1}>0`);
          f.addEventListener("input", () => (dr.formula = f.value));
          fields.push(field("Formula", f, `Written for the first data row (row ${(data?.first ?? 1) + 1}); it moves down for each row, like a filled formula. Must be TRUE.`));
          break;
        }
      }
      fields.push(field("Name (optional)", name), field("When it fails", severity));
      const warn = el("p", "cleanup-warn");
      const cancel = button("Cancel");
      cancel.addEventListener("click", () => editor.replaceChildren());
      const ok = button(existing ? "Save check" : "Add check");
      ok.addEventListener("click", () => {
        const problem = checkProblem(draft);
        if (problem) {
          warn.textContent = problem;
          return;
        }
        const checks = getChecks();
        const next = existing && index >= 0 ? checks.map((c, k) => (k === index ? draft : c)) : [...checks, draft];
        lastResults.delete(draft.id);
        save(structuredClone(next), existing ? "edit a check" : "add a check");
        editor.replaceChildren();
      });
      const box = el("fieldset", "ck-form");
      box.append(el("legend", "", existing ? "Edit check" : "New check"), row("ck-fields", ...fields), warn, row("numfmt-actions", cancel, ok));
      editor.append(box);
      (kind as HTMLElement).focus();
    };
    draw();
  }

  add.addEventListener("click", () => openEditor(null, -1));
  runBtn.addEventListener("click", () => {
    const results = runWorkbookChecks(d.workbook());
    const fails = results.filter((r) => r.status === "fail");
    for (const r of fails) expanded.add(r.id);
    render();
    report(d.status, results.length ? (fails.length ? `${fails.length} of ${results.length} checks fail` : `All ${results.length} checks pass`) : "No checks to run", fails.length ? "warning" : "success");
  });
  void close;
  render();
  (getChecks().length ? runBtn : add).focus();
}

// ------------------------------------------------------------- categorise --

export interface CategoriseDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  source: () => EditableSource;
  /** the selected range */
  range: () => CellRange;
  run: (a: Action) => Promise<unknown>;
  status: (text: string) => void;
  focusGrid: () => void;
  /** the local model, if one is loaded: it can suggest categories for rows no rule covers */
  model?: () => Model | null;
}

/** most rows the model is asked about in one go (each is one short answer) */
export const MODEL_CATEGORY_ROWS = 50;

const MATCH_OPTIONS = [
  ["contains", "contains"],
  ["word", "contains the word"],
  ["startsWith", "starts with"],
  ["equals", "is exactly"],
  ["regex", "matches pattern"],
  ["none", "(amount only)"],
] as const;

/** The "Categorise" dialog for the active sheet. */
export function openCategorise(d: CategoriseDeps): void {
  const sheetId = d.activeSheet();
  let data = readSheet(d.source());
  const { body, close } = dialog("Categorise", "ck-cat", () => d.focusGrid());
  const h = el("h3", "", "Categorise");
  body.append(h);
  if (!data.names.length || !data.rows) {
    body.append(el("p", "", "This sheet has no data. Open or paste the transactions first; the first row should name the columns."));
    const ok = button("Close");
    ok.addEventListener("click", close);
    body.append(row("numfmt-actions", ok));
    ok.focus();
    return;
  }
  const intro = el("p", "hp-muted", "Rules give each row a category, written into the category column. Categories already there are kept unless you tick Overwrite. Rules run in priority order (lower first); the first that matches wins.");
  const guess = guessCatColumns(data.names);
  const textSel = select(colOptions(data.names), String(guess.text));
  const amountSel = select([["-1", "(none)"], ...colOptions(data.names)], String(guess.amount));
  const catOptions = (): (readonly [string, string])[] => [...colOptions(data.names), ...(data.first > 0 ? [[String(data.names.length), `${columnLetter(data.names.length)}: (new column "Category")`] as const] : [])];
  const catSel = select(catOptions(), String(guess.category < data.names.length || data.first > 0 ? guess.category : 0));
  const cols = (): CatColumns => ({ text: Number(textSel.value), amount: Number(amountSel.value), category: Number(catSel.value) });

  let rules: CatRule[] = structuredClone(getCategoryRules());
  const saved = () => JSON.stringify(rules) === JSON.stringify(getCategoryRules());
  const rulesBox = el("div", "ck-rules");
  const learnBox = el("div", "ck-learn");
  const preview = el("div", "audit-result ck-preview");
  preview.setAttribute("aria-live", "polite");
  const overwrite = tick("Overwrite categories rows already have", false);

  const drawRules = () => {
    rulesBox.replaceChildren();
    const table = el("table", "ck-rule-table");
    const head = el("tr");
    for (const t of ["", "Text", "", "Amount from", "to", "Category", "Priority", ""]) head.append(el("th", "", t));
    table.append(head);
    rules.forEach((rule, i) => {
      const tr = el("tr");
      const r = ruleToRow(rule);
      const upd = (patch: Partial<RuleRow>) => {
        if (!r) return;
        Object.assign(r, patch);
        rules[i] = { ...rowToRule(r, rule.id, rule.source), ...(rule.enabled === false ? { enabled: false } : {}) };
        later();
      };
      const on = el("input");
      on.type = "checkbox";
      on.checked = rule.enabled !== false;
      on.setAttribute("aria-label", "Use this rule");
      on.addEventListener("change", () => {
        rules[i] = { ...rules[i] };
        if (on.checked) delete rules[i].enabled;
        else rules[i].enabled = false;
        later();
      });
      tr.append(td(on));
      if (r) {
        const m = select(MATCH_OPTIONS, r.match);
        m.addEventListener("change", () => upd({ match: m.value as RuleRow["match"] }));
        const t = input(r.text);
        t.setAttribute("aria-label", "Text");
        t.addEventListener("input", () => upd({ text: t.value }));
        const mn = input(r.min, "number");
        mn.setAttribute("aria-label", "Amount from");
        mn.addEventListener("input", () => upd({ min: mn.value }));
        const mx = input(r.max, "number");
        mx.setAttribute("aria-label", "Amount to");
        mx.addEventListener("input", () => upd({ max: mx.value }));
        tr.append(td(m), td(t), td(mn), td(mx));
      } else {
        const c = el("td", "", describeCatCondition(rule.condition));
        c.colSpan = 4;
        tr.append(c);
      }
      const cat = input(rule.category);
      cat.setAttribute("aria-label", "Category");
      cat.addEventListener("input", () => {
        if (r) upd({ category: cat.value });
        else {
          rules[i] = { ...rules[i], category: cat.value.trim() };
          later();
        }
      });
      const pr = input(rule.priority !== undefined ? String(rule.priority) : "", "number", "100");
      pr.setAttribute("aria-label", "Priority");
      pr.className = "ck-priority";
      pr.addEventListener("input", () => {
        if (r) upd({ priority: pr.value });
        else {
          const n = num(pr.value);
          rules[i] = { ...rules[i] };
          if (n === undefined) delete rules[i].priority;
          else rules[i].priority = n;
          later();
        }
      });
      const del = button("✕", "Remove this rule");
      del.addEventListener("click", () => {
        rules = rules.filter((_, k) => k !== i);
        drawRules();
        later();
      });
      const problem = categoryRuleProblem(rules[i]);
      if (problem) tr.title = problem;
      tr.append(td(cat), td(pr), td(del));
      if (rule.source === "learned") tr.className = "ck-learned";
      table.append(tr);
    });
    if (!rules.length) {
      const tr = el("tr");
      const c = el("td", "hp-muted", "No rules yet. Add one, or tag some rows by hand and let it learn.");
      c.colSpan = 8;
      tr.append(c);
      table.append(tr);
    }
    const addRule = button("Add rule");
    addRule.addEventListener("click", () => {
      rules = [...rules, { id: newId("cat"), condition: { kind: "contains", text: "" }, category: "", source: "manual" }];
      drawRules();
      (rulesBox.querySelector("tr:last-child input[aria-label=Text]") as HTMLInputElement | null)?.focus();
    });
    const saveRules = button("Save rules");
    saveRules.disabled = saved();
    saveRules.addEventListener("click", () => void commitRules().then(drawRules));
    const learn = button("Learn from what's tagged");
    learn.addEventListener("click", showLearned);
    const model = d.model?.() ?? null;
    const ask = button("Suggest the rest with the local model", model ? "For rows no rule covers: the model picks one of the categories already in use, from examples of each" : "Set up the local AI first (command palette: AI: set up and manage the local model)");
    ask.disabled = !model;
    ask.addEventListener("click", () => void suggestWithModel(model!));
    const wrap = el("div", "import-preview");
    wrap.append(table);
    rulesBox.append(wrap, row("ck-row", addRule, learn, ask, saveRules));
  };
  const td = (child: HTMLElement) => {
    const c = el("td");
    c.append(child);
    return c;
  };

  async function commitRules(): Promise<void> {
    if (saved()) return;
    const usable = rules.filter((r) => !categoryRuleProblem(r) || r.enabled === false);
    await d.run({ type: "categories.setRules", params: { rules: usable, label: "category rules" } });
    rules = structuredClone(getCategoryRules());
  }

  function showLearned() {
    learnBox.replaceChildren();
    const rows = readCatRows(data, cols());
    const tagged = rows.filter((r) => r.category).length;
    if (tagged < 2) {
      learnBox.append(el("p", "cleanup-warn", "Tag a few rows by hand first (type the category in the category column, or use Tag the selected rows), then learn."));
      return;
    }
    const proposals: LearnedRule[] = learnRules(rows, { existing: rules, minConfidence: 0.75 });
    if (!proposals.length) {
      learnBox.append(el("p", "", `Nothing to propose from ${tagged.toLocaleString("en-US")} tagged rows: no word turns up mostly in one category at least twice.`));
      return;
    }
    const table = el("table", "ck-rule-table");
    const head = el("tr");
    for (const t of ["", "Word", "Category", "Rows", "Right", "Elsewhere", "e.g."]) head.append(el("th", "", t));
    table.append(head);
    const picks: HTMLInputElement[] = [];
    for (const p of proposals) {
      const tr = el("tr");
      const t = el("input");
      t.type = "checkbox";
      t.checked = p.confidence >= 0.9;
      t.setAttribute("aria-label", "Accept this rule");
      picks.push(t);
      const term = p.rule.condition.kind === "contains" ? p.rule.condition.text : describeCatCondition(p.rule.condition);
      tr.append(td(t), el("td", "", term), el("td", "", p.rule.category), el("td", "num", String(p.support)), el("td", "num", `${Math.round(p.confidence * 100)}%`), el("td", "num", String(p.against)), el("td", "ck-ex", p.examples.join(" · ")));
      table.append(tr);
    }
    const accept = button("Add the ticked rules");
    accept.addEventListener("click", () => {
      const chosen = proposals.filter((_, i) => picks[i].checked).map((p) => ({ ...p.rule, id: newId("cat") }));
      rules = [...rules, ...chosen];
      learnBox.replaceChildren(el("p", "", `Added ${chosen.length} rule${chosen.length === 1 ? "" : "s"}. Check them, then Apply.`));
      drawRules();
      later();
    });
    const wrap = el("div", "import-preview");
    wrap.append(table);
    learnBox.append(el("p", "", `From ${tagged.toLocaleString("en-US")} tagged rows. Rows: tagged rows with the word in that category; Right: how often the word means that category; Elsewhere: tagged rows with the word in other categories.`), wrap, row("ck-row", accept));
  }

  async function suggestWithModel(model: Model) {
    learnBox.replaceChildren();
    const rows = readCatRows(data, cols());
    const examples = rows.filter((r) => r.category).map((r) => ({ text: r.text, amount: r.amount, category: r.category! }));
    if (new Set(examples.map((e) => e.category)).size < 2) {
      learnBox.append(el("p", "cleanup-warn", "Tag rows with at least two different categories first; the model only picks from categories already in use."));
      return;
    }
    const left = categorise(rows, rules, { overwrite: false }).uncategorised.filter((i) => !rows[i].category && rows[i].text.trim());
    if (!left.length) {
      learnBox.append(el("p", "", "Every row with text already has a category, or a rule gives it one."));
      return;
    }
    const batch = left.slice(0, MODEL_CATEGORY_ROWS);
    const note = el("p", "", `Asking the local model about ${batch.length} row${batch.length === 1 ? "" : "s"}…`);
    note.setAttribute("aria-live", "polite");
    learnBox.append(note);
    const r = await suggestCategories(model, batch.map((i) => rows[i]), examples);
    if (!r.suggestions.length) {
      note.textContent = `The model wasn't sure about any of these ${batch.length} rows${r.failed ? ` (${r.failed} answers didn't fit)` : ""}. Tag a few more by hand, or add rules.`;
      return;
    }
    const table = el("table", "ck-rule-table");
    const head = el("tr");
    for (const t of ["", "Row", "Text", "Category"]) head.append(el("th", "", t));
    table.append(head);
    const picks: HTMLInputElement[] = [];
    for (const sug of r.suggestions) {
      const i = batch[sug.row];
      const tr = el("tr");
      const t = el("input");
      t.type = "checkbox";
      t.checked = true;
      t.setAttribute("aria-label", "Use this category");
      picks.push(t);
      tr.append(td(t), el("td", "num", String(i + data.first + 1)), el("td", "ck-ex", rows[i].text), el("td", "", sug.category));
      table.append(tr);
    }
    const write = button("Write the ticked categories");
    write.addEventListener("click", () => {
      const c = cols().category;
      const cells = r.suggestions.filter((_, k) => picks[k].checked).map((sug) => ({ row: batch[sug.row] + data.first, col: c, input: categoryInput(sug.category) }));
      if (!cells.length) return;
      if (c >= data.names.length && data.first > 0) cells.unshift({ row: data.first - 1, col: c, input: "Category" });
      write.disabled = true;
      void d.run(setCells(cells, `categorise ${cells.length} rows (local model)`, sheetId)).then(() => {
        d.status(`Wrote ${cells.length.toLocaleString("en-US")} categories suggested by the local model`);
        learnBox.replaceChildren(el("p", "", `Wrote ${cells.length} categories. They're ordinary values: undo (Ctrl+Z) takes them back.`));
        refresh();
      });
    });
    const wrap = el("div", "import-preview");
    wrap.append(table);
    const more = left.length > batch.length ? ` ${left.length - batch.length} more rows are left; ask again after writing these.` : "";
    note.textContent = `The local model suggests categories for ${r.suggestions.length} of ${batch.length} rows (${r.unsure} not sure${r.failed ? `, ${r.failed} answers didn't fit` : ""}). It only picks categories already in use; check them before writing.${more}`;
    learnBox.append(wrap, row("ck-row", write));
  }

  let result: CategoriseResult | null = null;
  const applyBtn = button("Apply");
  const update = () => {
    preview.replaceChildren();
    const c = cols();
    if (c.category === c.text || c.category === c.amount) {
      result = null;
      preview.append(el("p", "cleanup-warn", "Pick a category column that isn't the text or amount column."));
      applyBtn.disabled = true;
      return;
    }
    const rows = readCatRows(data, c);
    result = categorise(rows, rules, { overwrite: overwrite.input.checked });
    const n = (x: number) => x.toLocaleString("en-US");
    const lines = [
      `${n(result.changed.length)} row${result.changed.length === 1 ? "" : "s"} would get a category${overwrite.input.checked ? " (or a new one)" : ""}.`,
      `${n(result.uncategorised.length)} would still have none.`,
    ];
    if (result.keptManual.length) lines.push(`${n(result.keptManual.length)} keep the category they have although a rule says otherwise.`);
    for (const l of lines) preview.append(el("p", "", l));
    if (result.conflicts.length) {
      const p = el("p", "cleanup-warn", `${n(result.conflicts.length)} row${result.conflicts.length === 1 ? "" : "s"} match rules with different categories; the higher-priority rule wins. First: ${result.conflicts
        .slice(0, 5)
        .map((x) => `row ${x.row + data.first + 1} (${x.categories.join(" / ")})`)
        .join(", ")}.`);
      preview.append(p);
    }
    if (result.counts.length) preview.append(el("p", "hp-muted", result.counts.slice(0, 12).map((x) => `${x.category}: ${n(x.rows)}`).join(" · ")));
    applyBtn.disabled = !result.changed.length;
  };
  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      update();
      const sr = rulesBox.querySelector<HTMLButtonElement>(".ck-row button:last-child");
      if (sr) sr.disabled = saved();
    }, 200);
  };

  // bulk tagging of the selected rows
  const range = d.range();
  const tagCat = input("", "text", "Category");
  tagCat.setAttribute("aria-label", "Category for the selected rows");
  const tagBtn = button("Tag the selected rows");
  const selRows = bulkTagCells(data, range, 0, "x").length;
  const tagHint = el("small", "hp-muted", selRows ? `Rows ${Math.max(range.top, data.first) + 1}–${Math.min(range.bottom, data.first + data.rows - 1) + 1} are selected (${selRows.toLocaleString("en-US")}).` : "Select the rows in the sheet first, then open Categorise.");
  tagBtn.disabled = !selRows;
  tagBtn.addEventListener("click", () => {
    const cells = bulkTagCells(data, range, cols().category, tagCat.value);
    if (!cells.length) return;
    if (cols().category >= data.names.length && data.first > 0) cells.unshift({ row: data.first - 1, col: cols().category, input: "Category" });
    void d
      .run(setCells(cells, `tag ${selRows} rows "${tagCat.value.trim()}"`, sheetId))
      .then(() => {
        refresh();
        d.status(`Tagged ${selRows.toLocaleString("en-US")} rows as ${tagCat.value.trim() || "(blank)"}`);
      })
      .catch((e: Error) => preview.append(el("p", "cleanup-warn", e.message)));
  });

  const refresh = () => {
    const keep = cols();
    data = readSheet(d.source());
    const opts = catOptions();
    catSel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
    catSel.value = String(keep.category);
    if (!catSel.value) catSel.selectedIndex = 0;
    update();
  };

  const queue = button("Show uncategorised rows", "Filter the sheet to rows with a blank category");
  queue.addEventListener("click", () => {
    const c = cols().category;
    if (c >= data.names.length) {
      preview.append(el("p", "cleanup-warn", "The category column doesn't exist yet. Apply or tag first."));
      return;
    }
    void d.run(uncategorisedFilter(sheetId, data, c)).then(() => {
      d.status("Showing rows with no category");
      close();
    });
  });

  const cancel = button("Close");
  cancel.addEventListener("click", close);
  applyBtn.addEventListener("click", () => {
    clearTimeout(timer);
    update();
    const r = result;
    if (!r?.changed.length) return;
    applyBtn.disabled = true;
    void (async () => {
      try {
        await commitRules();
        const cells = categoryCells(data, cols().category, r);
        await d.run(setCells(cells, `categorise ${r.changed.length} rows`, sheetId));
        d.status(`Categorised ${r.changed.length.toLocaleString("en-US")} rows; ${r.uncategorised.length.toLocaleString("en-US")} have no category`);
        refresh();
        drawRules();
      } catch (e) {
        preview.append(el("p", "cleanup-warn", (e as Error).message));
        applyBtn.disabled = false;
      }
    })();
  });

  const colsBox = row("ck-cols3", field("Text to match", textSel), field("Amount", amountSel), field("Write the category to", catSel));
  colsBox.addEventListener("change", later);
  overwrite.input.addEventListener("change", later);
  body.append(
    intro,
    colsBox,
    el("h4", "", "Rules"),
    rulesBox,
    learnBox,
    el("h4", "", "Tag by hand"),
    row("ck-row", tagCat, tagBtn),
    tagHint,
    overwrite.el,
    preview,
    row("numfmt-actions", queue, cancel, applyBtn),
  );
  drawRules();
  update();
  textSel.focus();
}
