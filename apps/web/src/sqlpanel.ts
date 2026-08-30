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

// ----------------------------------------------------------------- dialog --

const PREVIEW_ROWS = 200;
let lastSql = "";

function starter(wb: Workbook, active: string): string {
  const sheet = wb.has(active) ? wb.get(active) : wb.sheets[0];
  if (!sheet) return "SELECT 1";
  const cols = sheetColumnNames(sheet);
  return `SELECT ${cols.slice(0, 4).map(sqlName).join(", ") || "*"}\nFROM ${sqlName(sheet.name)}\nLIMIT 100`;
}

export function openSql(d: SqlDeps): void {
  const wb = d.workbook();
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog sql-dialog" role="dialog" aria-label="SQL query"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  type Props = { textContent?: string; className?: string; type?: string; value?: string; title?: string; placeholder?: string; spellcheck?: boolean; rows?: number };
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] => {
    const e: HTMLElementTagNameMap[K] = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  };
  const button = (text: string, onClick: () => void, title = "") => {
    const b = el("button", { type: "button", textContent: text, title });
    b.addEventListener("click", onClick);
    return b;
  };

  // editor
  const editor = el("textarea", { className: "sql-editor", spellcheck: false, rows: 9 });
  editor.value = lastSql || starter(wb, d.activeSheet());
  editor.setAttribute("aria-label", "SQL query");
  const insert = (text: string) => {
    const { selectionStart: a, selectionEnd: b } = editor;
    editor.setRangeText(text, a, b, "end");
    editor.focus();
  };

  // the tables, for reference (click a name to insert it)
  const tables = el("div", { className: "sql-tables" });
  tables.setAttribute("aria-label", "Sheets and columns");
  for (const sheet of wb.sheets) {
    const det = el("details");
    if (sheet.id === d.activeSheet()) det.open = true;
    const sum = el("summary", {}, el("code", { textContent: sqlName(sheet.name), title: "Click to insert" }));
    sum.querySelector("code")!.addEventListener("click", (e) => {
      e.preventDefault();
      insert(sqlName(sheet.name));
    });
    det.append(sum);
    const list = el("ul");
    let cols: string[] = [];
    try {
      cols = sheetColumnNames(sheet);
    } catch {
      /* an odd sheet: list nothing */
    }
    for (const c of cols) {
      const li = el("li", {}, el("code", { textContent: sqlName(c), title: "Click to insert" }));
      li.addEventListener("click", () => insert(sqlName(c)));
      list.append(li);
    }
    if (!cols.length) list.append(el("li", { className: "hp-muted", textContent: "(empty)" }));
    det.append(list);
    tables.append(det);
  }

  // saved queries
  const savedBox = el("div", { className: "sql-saved" });
  const nameInput = el("input", { type: "text", placeholder: "Name to save as", value: "" });
  nameInput.setAttribute("aria-label", "Name for the saved query");
  const renderSaved = () => {
    const saved = getSavedQueries();
    savedBox.replaceChildren(el("strong", { textContent: "Saved queries" }));
    if (!saved.length) savedBox.append(el("p", { className: "hp-muted", textContent: "None yet. Name a query below and press Save." }));
    const ul = el("ul");
    saved.forEach((q, k) => {
      const load = button(q.name, () => {
        editor.value = q.sql;
        nameInput.value = q.name;
        editor.focus();
      }, "Open this query in the editor");
      load.className = "sql-saved-name";
      const del = button("✕", () => {
        const next = saved.filter((_, j) => j !== k);
        void d.run({ type: "sql.setSaved", params: { queries: next, label: `delete query "${q.name}"` } });
      }, `Delete "${q.name}"`);
      del.className = "sql-saved-del";
      del.setAttribute("aria-label", `Delete saved query ${q.name}`);
      ul.append(el("li", {}, load, del));
    });
    if (saved.length) savedBox.append(ul);
  };
  renderSaved();
  const stopListening = onSavedQueriesChange(renderSaved);

  // results
  const status = el("p", { className: "sql-status hp-muted", textContent: "Ctrl+Enter runs the query." });
  status.setAttribute("role", "status");
  const preview = el("div", { className: "import-preview sql-preview" });
  let last: { result: SqlResult; sql: string } | null = null;

  const toSheet = button("Put the result on a new sheet", () => void putOnSheet());
  toSheet.disabled = true;
  const putOnSheet = async () => {
    if (!last) return;
    const { result, sql } = last;
    close();
    await putResultOnSheet(d, result, sql, nameInput.value.trim() || "Query");
    d.status(`Query result: ${result.rowCount.toLocaleString()} rows on a new sheet`);
  };

  const run = () => {
    const sql = editor.value;
    lastSql = sql;
    last = null;
    toSheet.disabled = true;
    status.className = "sql-status hp-muted";
    status.textContent = "Running…";
    preview.replaceChildren();
    // let the status paint before a long query
    setTimeout(() => {
      const t0 = performance.now();
      try {
        const result = runOnWorkbook(sql, d.workbook());
        const ms = performance.now() - t0;
        last = { result, sql };
        toSheet.disabled = false;
        status.textContent = `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? "" : "s"}, ${result.columns.length} column${result.columns.length === 1 ? "" : "s"} in ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}${result.rowCount > PREVIEW_ROWS ? ` (showing the first ${PREVIEW_ROWS})` : ""}`;
        preview.replaceChildren(previewTable(result));
      } catch (e) {
        status.className = "sql-status cleanup-warn";
        if (e instanceof SqlError) {
          const hint = /no table/.test(e.reason) ? missingTables(sql, d.workbook()) : null;
          status.textContent = hint ? `${hint} (line ${e.line}, column ${e.column})` : e.message;
          editor.focus();
          editor.setSelectionRange(e.pos, Math.min(sql.length, e.pos + Math.max(1, /\w/.test(sql[e.pos] ?? "") ? (/^\w+/.exec(sql.slice(e.pos))?.[0].length ?? 1) : 1)));
        } else status.textContent = `The query failed: ${(e as Error).message}`;
      }
    }, 0);
  };

  const save = () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      status.className = "sql-status cleanup-warn";
      status.textContent = "Give the query a name to save it.";
      return;
    }
    const saved = getSavedQueries();
    const at = saved.findIndex((q) => q.name.toLowerCase() === name.toLowerCase());
    const next = at >= 0 ? saved.map((q, k) => (k === at ? { name, sql: editor.value } : q)) : [...saved, { name, sql: editor.value }];
    void d.run({ type: "sql.setSaved", params: { queries: next, label: `${at >= 0 ? "update" : "save"} query "${name}"` } });
    status.className = "sql-status hp-muted";
    status.textContent = `Saved "${name}" with the workbook.`;
  };

  const close = () => {
    stopListening();
    back.remove();
    d.focusGrid();
  };

  const runBtn = button("Run", run, "Run the query (Ctrl+Enter)");
  runBtn.className = "primary";
  const closeBtn = button("Close", close);
  const saveRow = el("div", { className: "sql-save-row" }, nameInput, button("Save", save, "Save this query with the workbook"));
  const side = el("div", { className: "sql-side" }, el("strong", { textContent: "Tables (sheets)" }), tables, savedBox);
  const main = el("div", { className: "sql-main" }, editor, saveRow, el("div", { className: "numfmt-actions sql-actions" }, closeBtn, toSheet, runBtn), status, preview);

  body.append(
    el("h3", { textContent: "SQL query" }),
    el("p", { textContent: "Each sheet is a table and its first row names the columns. Put names with spaces in double quotes: \"Sales 2024\". Click a name on the left to insert it." }),
    el("div", { className: "sql-layout" }, side, main),
  );

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insert("  ");
    }
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  document.body.append(back);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
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
    return x !== x ? "" : formatValue(x, fmt || "General").text;
  }
  const code = c.codes[i];
  return code ? c.dict[code - 1] : "";
}
