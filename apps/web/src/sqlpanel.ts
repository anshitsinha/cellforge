/**
 * "SQL query…": write a query over the workbook's sheets (each sheet is a
 * table, by name; its first row or column names are the columns), run it
 * with Ctrl+Enter, see the first 200 rows, and put the result on a new sheet.
 * Queries can be saved with the workbook (through the store below, changed
 * by an undoable action, "sql.setSaved").
 *
 * The engine is in packages/core/src/sql. Sheets are read with
 * readSheetColumns, which uses untouched imported columns as they are.
 */
import { type Action, type ActionRegistry, s } from "@cellforge/actions";
import { formatValue, Table, type ColumnData } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import { runSql, sqlTableNames, SqlError, type SqlResult, type SqlTable } from "@cellforge/core";
import type { SheetCtx } from "./actions";
import { EditableSource } from "./editable";
import { readSheetColumns } from "./pivotpanel";
import type { Sheet, Workbook } from "./workbook";
import "./sql.css";
import "./analysis.css";
import { isIdLike, measureColumns, type ColumnInfo } from "./charts/defaults";
import { quickInfos } from "./pivotpanel";
import { openSidePanel, type SidePanelContext } from "./ui/sidepanel";
import { makeButton } from "./ui/dialog";
import { icon, iconButton } from "./ui/icons";
import { renderTable } from "./ui/table";
import { toast } from "./ui/toast";

export interface SqlDeps {
  workbook: () => Workbook;
  /** id of the sheet on screen */
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

/** A saved query. */
export interface SavedQuery {
  name: string;
  sql: string;
}

// ------------------------------------------------------------------ store --

/**
 * Where saved queries live. By default a module-level list; bind it to the
 * workbook with bindSqlStore so they're saved and opened with the file.
 */
export interface SqlStore {
  getQueries(): SavedQuery[];
  setQueries(queries: SavedQuery[]): void;
}

let localQueries: SavedQuery[] = [];
let store: SqlStore = {
  getQueries: () => localQueries,
  setQueries: (q) => (localQueries = q),
};
const listeners = new Set<() => void>();

export function bindSqlStore(b: Partial<SqlStore>): void {
  store = { ...store, ...b };
  notify();
}
export const getSavedQueries = (): SavedQuery[] => store.getQueries();
export function setSavedQueries(q: SavedQuery[]): void {
  store.setQueries(q);
  notify();
}
/** Called after the saved queries change (also on undo / redo). Returns a function that stops it. */
export function onSavedQueriesChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

/** sql.setSaved {queries}: replace the saved queries; undoes to the list as it was. */
export function registerSqlActions(registry: ActionRegistry<SheetCtx>): void {
  registry.register<{ queries: SavedQuery[]; label?: string }>({
    type: "sql.setSaved",
    title: "Replace the workbook's saved SQL queries",
    schema: s.object({ queries: s.array(s.object({ name: s.string(), sql: s.string() }, ["name", "sql"]), "the saved queries"), label: s.string("what changed, for the undo menu") }, ["queries"]),
    describe: (p) => p.label ?? `saved queries (${p.queries.length})`,
    recordable: false,
    apply(_ctx, p) {
      if (!Array.isArray(p.queries) || p.queries.some((q) => !q || typeof q.name !== "string" || typeof q.sql !== "string")) throw new Error("Each saved query needs a name and the SQL.");
      const before = structuredClone(store.getQueries());
      setSavedQueries(structuredClone(p.queries));
      return { type: "sql.setSaved", params: { queries: before, ...(p.label ? { label: p.label } : {}) } };
    },
  });
}

// ----------------------------------------------------------- the tables --

/** How to write a sheet or column name in SQL: bare when it's a plain word, else in double quotes. */
export function sqlName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !KEYWORDS.has(name.toUpperCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}
const KEYWORDS = new Set(
  "SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION EXCEPT INTERSECT JOIN LEFT RIGHT FULL INNER OUTER CROSS ON USING AS AND OR NOT IN IS NULL LIKE ILIKE BETWEEN CASE WHEN THEN ELSE END WITH DISTINCT ALL ASC DESC NULLS OVER PARTITION TRUE FALSE EXISTS FETCH DATE".split(" "),
);

/** A sheet's column names as the query sees them (cheap: no data read). */
export function sheetColumnNames(sheet: Sheet): string[] {
  const src = sheet.source;
  const { cols } = src.usedRange();
  const named = Array.from({ length: cols }, (_, c) => src.getColumnName?.(c) ?? "");
  const useNamed = named.some(Boolean);
  return named.map((n, c) => {
    const raw = useNamed ? n : src.getCell(0, c);
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    return text || `Column ${columnLetter(c)}`;
  });
}

/** A sheet as a SQL table (data rows only; dates keep their formats). */
export function sheetTable(sheet: Sheet): SqlTable {
  const data = readSheetColumns(sheet.source);
  return { name: sheet.name, columns: data.columns, numFmts: data.numFmts };
}

/** Run a query against the workbook's sheets, reading only the sheets it uses. */
export function runOnWorkbook(sql: string, wb: Workbook): SqlResult {
  const cache = new Map<string, SqlTable>();
  return runSql(sql, (name) => {
    const lower = name.toLowerCase();
    const hit = cache.get(lower);
    if (hit) return hit;
    const sheet = wb.sheets.find((s) => s.name.toLowerCase() === lower);
    if (!sheet) return null;
    const t = sheetTable(sheet);
    cache.set(lower, t);
    return t;
  });
}

/** Explain an unknown table with the sheets that do exist. */
function missingTables(sql: string, wb: Workbook): string | null {
  try {
    const missing = sqlTableNames(sql).filter((n) => !wb.sheets.some((s) => s.name.toLowerCase() === n.toLowerCase()));
    if (!missing.length) return null;
    return `There's no sheet called "${missing[0]}". Sheets: ${wb.sheets.map((s) => sqlName(s.name)).join(", ")}`;
  } catch {
    return null;
  }
}

/** A name for the result sheet: "Query" or the saved query's name, made unique. */
function resultName(wb: Workbook, base: string): string {
  return wb.freeName(base.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Query");
}

/** Add the result as a new sheet. */
export async function putResultOnSheet(d: SqlDeps, result: SqlResult, sql: string, name: string): Promise<void> {
  const columns: ColumnData[] = result.columns;
  const source = new EditableSource(new Table(columns), 5);
  const oneLine = sql.replace(/\s+/g, " ").trim();
  await d.run({
    type: "sheet.insert",
    params: { name: resultName(d.workbook(), name), source: d.putBlob(source), numFmts: result.numFmts, origin: `SQL: ${oneLine.length > 2000 ? `${oneLine.slice(0, 2000)}…` : oneLine}` },
  });
}

// --------------------------------------------------------------- examples --

export interface SqlExample {
  title: string;
  description: string;
  sql: string;
}

/** What the examples need to know about a sheet. */
export interface ExampleSheet {
  name: string;
  columns: ColumnInfo[];
}

/** Profile a sheet's columns from its first rows, for the examples (cheap). */
export function exampleSheet(sheet: Sheet): ExampleSheet {
  return { name: sheet.name, columns: quickInfos(readSheetColumns(sheet.source)) };
}

/**
 * Finance examples written for the sheets at hand: the totals by the main
 * category, possible duplicates, the largest items, totals by month and,
 * with two sheets, the rows of one that the other doesn't have.
 */
export function sqlExamples(sheets: readonly ExampleSheet[], active = 0): SqlExample[] {
  const main = sheets[active] ?? sheets[0];
  if (!main) return [];
  const t = sqlName(main.name);
  const cols = main.columns;
  const amount = measureColumns(cols, 1)[0];
  const amountName = amount === undefined ? null : sqlName(cols[amount].name);
  const cat = cols.find((c) => c.kind === "text" && !isIdLike(c) && c.distinct < c.count && c.distinct <= 200);
  const ref = cols.find((c) => isIdLike(c) && c.kind === "text") ?? cols.find((c) => isIdLike(c));
  const date = cols.find((c) => c.kind === "date");
  const out: SqlExample[] = [{ title: "First 100 rows", description: `Every column of ${main.name}`, sql: `SELECT *\nFROM ${t}\nLIMIT 100` }];
  if (cat && amountName) {
    const c = sqlName(cat.name);
    out.push({ title: `Total by ${cat.name}`, description: `${cols[amount!].name} added up per ${cat.name}, biggest first`, sql: `SELECT ${c}, SUM(${amountName}) AS total, COUNT(*) AS lines\nFROM ${t}\nGROUP BY ${c}\nORDER BY total DESC` });
  }
  if (amountName) {
    const keys = (cat ? [sqlName(cat.name), amountName] : [amountName]).join(", ");
    out.push({ title: "Possible duplicates", description: `The same ${[cat?.name, cols[amount!].name].filter(Boolean).join(" and ")} more than once`, sql: `SELECT ${keys}, COUNT(*) AS times\nFROM ${t}\nGROUP BY ${keys}\nHAVING COUNT(*) > 1\nORDER BY times DESC` });
    out.push({ title: "Largest 20", description: `The biggest ${cols[amount!].name} values`, sql: `SELECT *\nFROM ${t}\nORDER BY ${amountName} DESC\nLIMIT 20` });
  }
  if (date && amountName) {
    const d = sqlName(date.name);
    out.push({ title: "Totals by month", description: `${cols[amount!].name} per month of ${date.name}`, sql: `SELECT YEAR(${d}) AS year, MONTH(${d}) AS month, SUM(${amountName}) AS total, COUNT(*) AS lines\nFROM ${t}\nGROUP BY YEAR(${d}), MONTH(${d})\nORDER BY year, month` });
  }
  const other = sheets.find((s) => s !== main && s.columns.length);
  if (other) {
    const names = new Map(other.columns.map((c) => [c.name.toLowerCase(), c.name]));
    const shared = (ref && names.has(ref.name.toLowerCase()) ? ref : null) ?? cols.find((c) => names.has(c.name.toLowerCase()) && c.kind === "text") ?? cols.find((c) => names.has(c.name.toLowerCase()));
    if (shared) {
      const k = sqlName(shared.name);
      const ko = sqlName(names.get(shared.name.toLowerCase())!);
      out.push({ title: `Not in ${other.name}`, description: `Rows of ${main.name} with no matching ${shared.name} in ${other.name}`, sql: `SELECT a.*\nFROM ${t} AS a\nLEFT JOIN ${sqlName(other.name)} AS b ON a.${k} = b.${ko}\nWHERE b.${ko} IS NULL` });
    }
  }
  return out;
}

// ------------------------------------------------------------------ panel --

const PREVIEW_ROWS = 200;
let lastSql = "";

function starter(wb: Workbook, active: string): string {
  const sheet = wb.has(active) ? wb.get(active) : wb.sheets[0];
  if (!sheet) return "SELECT 1";
  const cols = sheetColumnNames(sheet);
  return `SELECT ${cols.slice(0, 4).map(sqlName).join(", ") || "*"}\nFROM ${sqlName(sheet.name)}\nLIMIT 100`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function section(title: string, ...extra: HTMLElement[]): HTMLElement {
  const s = h("section", "an-section");
  const head = h("div", "an-section__head");
  head.append(h("h3", "an-section__title", title), ...extra);
  s.append(head);
  return s;
}

/**
 * The SQL workbench in the side panel: examples written for this sheet,
 * the sheets and columns (click to insert), the editor with Run, the result
 * as a formatted table, and saved queries. Ctrl+Enter runs.
 */
export function openSql(d: SqlDeps): void {
  openSidePanel({
    id: "sql",
    title: "SQL query",
    // results are tables: start wide enough to read a few columns
    minWidth: 480,
    subtitle: "Every sheet is a table; its first row names the columns",
    onClose: () => d.focusGrid(),
    render: (p) => renderSql(p, d),
  });
}

function renderSql(p: SidePanelContext, d: SqlDeps): () => void {
  const wb = d.workbook();
  const root = h("div", "an-stack an-stack--loose sql-panel");
  p.body.append(root);
  let last: { result: SqlResult; sql: string } | null = null;

  // ---- editor
  const editorSec = section("Query");
  const editor = h("textarea", "sql-editor");
  editor.spellcheck = false;
  editor.rows = 7;
  editor.value = lastSql || starter(wb, d.activeSheet());
  editor.setAttribute("aria-label", "SQL query");
  editor.setAttribute("aria-describedby", "sql-run-hint");
  const insert = (text: string) => {
    const { selectionStart: a, selectionEnd: b } = editor;
    const before = editor.value.slice(0, a);
    const pad = before && !/[\s(,.]$/.test(before) ? " " : "";
    editor.setRangeText(pad + text, a, b, "end");
    editor.focus();
  };
  const runRow = h("div", "sql-run-row");
  const hint = h("span", "an-hint", "");
  hint.id = "sql-run-hint";
  hint.append(h("kbd", "an-kbd", "Ctrl"), " + ", h("kbd", "an-kbd", "Enter"), " runs it");
  const runBtn = makeButton("Run", "primary", "play");
  runBtn.title = "Run the query (Ctrl+Enter)";
  runRow.append(hint, runBtn);
  editorSec.append(editor, runRow);

  // ---- result
  const resultSec = section("Result");
  const status = h("p", "an-hint sql-status");
  status.setAttribute("role", "status");
  const errorBox = h("div", "an-note an-note--error");
  errorBox.setAttribute("role", "alert");
  errorBox.hidden = true;
  const preview = h("div", "sql-preview");
  resultSec.append(errorBox, status, preview);
  resultSec.hidden = true;

  // ---- examples
  const exSec = section("Examples for this workbook");
  const exList = h("div", "sql-examples");
  exSec.append(exList);
  let examples: SqlExample[] = [];
  try {
    const sheets = wb.sheets.map(exampleSheet);
    examples = sqlExamples(sheets, Math.max(0, wb.sheets.findIndex((s) => s.id === d.activeSheet())));
  } catch {
    examples = [];
  }
  for (const ex of examples) {
    const b = h("button", "sql-example");
    b.type = "button";
    b.append(h("span", "sql-example__title", ex.title), h("span", "sql-example__text", ex.description));
    b.title = ex.sql;
    b.addEventListener("click", () => {
      editor.value = ex.sql;
      run();
    });
    exList.append(b);
  }
  if (!examples.length) exSec.hidden = true;

  // ---- tables
  const tablesSec = section("Sheets and columns");
  const tables = h("div", "sql-tables");
  tablesSec.append(tables, h("p", "an-hint", 'Click a name to put it in the query. Names with spaces go in double quotes, like "Bank Feb".'));
  for (const sheet of wb.sheets) {
    const det = h("details", "sql-table");
    if (sheet.id === d.activeSheet()) det.open = true;
    const sum = h("summary");
    const nameBtn = h("button", "sql-name sql-name--table", sqlName(sheet.name));
    nameBtn.type = "button";
    nameBtn.title = `Insert ${sqlName(sheet.name)}`;
    nameBtn.addEventListener("click", (e) => {
      e.preventDefault();
      insert(sqlName(sheet.name));
    });
    const tIcon = icon("table", { size: 14 });
    sum.append(tIcon, nameBtn);
    det.append(sum);
    const list = h("div", "an-chips sql-columns");
    let cols: string[] = [];
    try {
      cols = sheetColumnNames(sheet);
    } catch {
      /* an odd sheet: list nothing */
    }
    sum.append(h("span", "sql-count", `${cols.length}`));
    for (const c of cols) {
      const b = h("button", "an-chip sql-name", sqlName(c));
      b.type = "button";
      b.title = `Insert ${sqlName(c)}`;
      b.addEventListener("click", () => insert(sqlName(c)));
      list.append(b);
    }
    if (!cols.length) list.append(h("span", "an-hint", "Empty sheet"));
    det.append(list);
    tables.append(det);
  }

  // ---- saved queries
  const savedSec = section("Saved queries");
  const savedList = h("ul", "an-list sql-saved");
  const saveRow = h("div", "an-row");
  const nameInput = h("input");
  nameInput.type = "text";
  nameInput.placeholder = "Name, e.g. Unmatched invoices";
  nameInput.setAttribute("aria-label", "Name for the saved query");
  const saveBtn = makeButton("Save", "secondary");
  saveBtn.classList.add("an-fit");
  saveBtn.title = "Save this query with the workbook";
  saveRow.append(nameInput, saveBtn);
  savedSec.append(savedList, saveRow);
  const renderSaved = () => {
    const saved = getSavedQueries();
    savedList.replaceChildren();
    if (!saved.length) savedList.append(h("li", "an-hint sql-saved-empty", "None yet. Queries you save go with the workbook."));
    saved.forEach((q, k) => {
      const li = h("li");
      const load = h("button", "sql-saved-name");
      load.type = "button";
      load.append(icon("database", { size: 14 }), h("span", undefined, q.name));
      load.title = q.sql;
      load.addEventListener("click", () => {
        editor.value = q.sql;
        nameInput.value = q.name;
        editor.focus();
      });
      const del = iconButton("trash", `Delete saved query ${q.name}`, {
        size: "sm",
        onClick: () => {
          const next = saved.filter((_, j) => j !== k);
          void d.run({ type: "sql.setSaved", params: { queries: next, label: `delete query "${q.name}"` } });
          toast({ text: `Deleted the query "${q.name}"`, action: { label: "Undo", run: () => void d.run({ type: "sql.setSaved", params: { queries: saved, label: `restore query "${q.name}"` } }) } });
        },
      });
      li.append(load, del);
      savedList.append(li);
    });
  };
  renderSaved();
  const stopListening = onSavedQueriesChange(renderSaved);

  root.append(editorSec, resultSec, exSec, tablesSec, savedSec);

  // ---- footer
  const foot = h("div", "an-footer");
  const toSheet = makeButton("Add as sheet", "primary");
  toSheet.disabled = true;
  toSheet.title = "Run a query first";
  foot.append(h("span", "an-spacer"), toSheet);
  p.footer.append(foot);

  const showError = (text: string | null) => {
    errorBox.replaceChildren();
    errorBox.hidden = !text;
    if (text) errorBox.append(icon("error"), h("span", undefined, text));
  };

  function run() {
    const sql = editor.value;
    lastSql = sql;
    last = null;
    toSheet.disabled = true;
    toSheet.title = "Run a query first";
    resultSec.hidden = false;
    showError(null);
    status.textContent = "Running…";
    preview.replaceChildren();
    runBtn.disabled = true;
    // let the status paint before a long query
    setTimeout(() => {
      const t0 = performance.now();
      try {
        const result = runOnWorkbook(sql, d.workbook());
        const ms = performance.now() - t0;
        last = { result, sql };
        toSheet.disabled = false;
        toSheet.title = "Put the whole result on a new sheet";
        status.textContent = `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? "" : "s"} · ${result.columns.length} column${result.columns.length === 1 ? "" : "s"} · ${ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`}${result.rowCount > PREVIEW_ROWS ? ` · showing the first ${PREVIEW_ROWS}` : ""}`;
        preview.replaceChildren(resultTable(result));
      } catch (e) {
        status.textContent = "";
        if (e instanceof SqlError) {
          const hint = /no table/.test(e.reason) ? missingTables(sql, d.workbook()) : null;
          showError(hint ? `${hint}. (Line ${e.line}, column ${e.column}.)` : e.message);
          editor.focus();
          editor.setSelectionRange(e.pos, Math.min(sql.length, e.pos + Math.max(1, /\w/.test(sql[e.pos] ?? "") ? (/^\w+/.exec(sql.slice(e.pos))?.[0].length ?? 1) : 1)));
        } else showError(`The query failed: ${(e as Error).message}`);
      } finally {
        runBtn.disabled = false;
      }
    }, 0);
  }
  runBtn.addEventListener("click", run);

  toSheet.addEventListener("click", () => {
    if (!last) return;
    const { result, sql } = last;
    const name = nameInput.value.trim() || "Query";
    void putResultOnSheet(d, result, sql, name)
      .then(() => toast({ kind: "success", text: `Query result added as a new sheet (${result.rowCount.toLocaleString()} rows)` }))
      .catch((e: Error) => toast({ kind: "error", title: "Couldn't add the result sheet", text: e.message }));
    p.close();
  });

  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      nameInput.setAttribute("aria-invalid", "true");
      nameInput.placeholder = "Give the query a name first";
      return;
    }
    nameInput.removeAttribute("aria-invalid");
    const saved = getSavedQueries();
    const at = saved.findIndex((q) => q.name.toLowerCase() === name.toLowerCase());
    const next = at >= 0 ? saved.map((q, k) => (k === at ? { name, sql: editor.value } : q)) : [...saved, { name, sql: editor.value }];
    void d.run({ type: "sql.setSaved", params: { queries: next, label: `${at >= 0 ? "update" : "save"} query "${name}"` } });
    toast({ kind: "success", text: `${at >= 0 ? "Updated" : "Saved"} the query "${name}" with the workbook` });
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveBtn.click();
    }
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && editor.value.slice(0, editor.selectionStart).split("\n").pop()!.trim() === "") {
      // Tab indents at the start of a line; elsewhere it moves focus as usual
      e.preventDefault();
      insert("  ");
    }
    // keep the grid's shortcuts out of the editor
    e.stopPropagation();
  });
  requestAnimationFrame(() => {
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });
  return () => stopListening();
}

/** The column formats for renderTable: numbers in the result's formats, right-aligned. */
function resultTable(result: SqlResult): HTMLElement {
  const n = Math.min(PREVIEW_ROWS, result.rowCount);
  const rows = Array.from({ length: n }, (_, i) => i);
  const t = renderTable<number>({
    columns: result.columns.map((c, k) => ({
      key: String(k),
      label: c.name,
      value: (i: number) => i,
      format: (i: unknown) => cellText(c, i as number, autoFormat(result, k)),
      align: c.kind === "number" ? "right" : "left",
    })),
    rows,
    dense: true,
    zebra: false,
    maxHeight: "min(52vh, 520px)",
    empty: "The query returned no rows.",
    caption: "Query result",
  });
  t.element.classList.add("sql-result");
  return t.element;
}

/** A result column's format: its own, else #,##0.00 for amounts with decimals. */
export function autoFormat(result: SqlResult, k: number): string {
  const fmt = result.numFmts[k];
  if (fmt && fmt.toLowerCase() !== "general") return fmt;
  const c = result.columns[k];
  if (c.kind !== "number") return "";
  const n = Math.min(c.values.length, 500);
  let fraction = false;
  let big = false;
  for (let i = 0; i < n; i++) {
    const x = c.values[i];
    if (x !== x) continue;
    if (!Number.isInteger(x)) fraction = true;
    if (Math.abs(x) >= 10000) big = true;
  }
  return fraction ? "#,##0.00" : big ? "#,##0" : "";
}

/** The first rows of a result as an HTML table, numbers in their formats. */
export function previewTable(result: SqlResult, limit = PREVIEW_ROWS): HTMLTableElement {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const c of result.columns) {
    const th = document.createElement("th");
    th.textContent = c.name;
    head.append(th);
  }
  table.append(head);
  const n = Math.min(limit, result.rowCount);
  for (let i = 0; i < n; i++) {
    const tr = document.createElement("tr");
    result.columns.forEach((c, k) => {
      const td = document.createElement("td");
      td.textContent = cellText(c, i, result.numFmts[k]);
      if (c.kind === "number") td.className = "num";
      tr.append(td);
    });
    table.append(tr);
  }
  return table;
}

export function cellText(c: ColumnData, i: number, fmt: string): string {
  if (c.kind === "number") {
    const x = c.values[i];
    // float dust like 1e-12 (amounts that net to nothing) shows as 0
    return x !== x ? "" : formatValue(Math.abs(x) < 1e-6 ? 0 : x, fmt || "General").text;
  }
  const code = c.codes[i];
  return code ? c.dict[code - 1] : "";
}
