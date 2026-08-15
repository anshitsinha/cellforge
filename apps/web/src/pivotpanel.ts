/**
 * The pivot table builder: the active sheet's columns as fields, dropped
 * (or clicked) into Rows, Columns, Values and Filters, with a live preview.
 * A result cell drills down to the rows behind it on a new sheet, and the
 * whole pivot can be put on a new sheet.
 *
 * The engine is in packages/core/src/pivot; this file reads the sheet into
 * columns (straight from the imported arrays when it can), lays the result
 * out as a sheet, and runs the dialog.
 */
import type { Action } from "@cellforge/actions";
import { formatValue, isDateFormat, parseDateLoose, Table, type ColumnData } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import { AGG_LABEL, fieldMembers, pivot, type DateGroup, type PivotAgg, type PivotItem, type PivotKey, type PivotResult, type PivotSpec, type ShowAs } from "@cellforge/core";
import type { ChartSpec, ChartType } from "./charts/model";
import { PIVOT_CHART_TYPES, pivotChartSpec, savePivot } from "./charts/pivotspec";
import { namedHeader } from "./cleanup";
import { EditableSource } from "./editable";
import "./pivot.css";

export interface PivotDeps {
  source: () => EditableSource;
  sheetName: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
  /** id of the sheet being pivoted; with addChart, shows "Chart this pivot" */
  sheetId?: () => string;
  /** save a new chart (a pivot chart) with the workbook */
  addChart?: (spec: ChartSpec) => void;
}

// ------------------------------------------------------------ the sheet --

/** The active sheet as typed columns, data rows only. */
export interface SheetColumns {
  /** field names: the column names, or the text in row 1 */
  names: string[];
  columns: ColumnData[];
  numFmts: string[];
  /** numbers shown as dates */
  isDate: boolean[];
  /** view row of the first data row (1 when row 1 holds the names) */
  first: number;
  rows: number;
}

/** What readSheetColumns needs from a sheet. EditableSource fits. */
export type ColumnSource = Pick<EditableSource, "usedRange" | "getCell" | "getColumnName" | "getStyle" | "baseColumn" | "rowOrder" | "toBase">;

function textColumn(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const at = new Map<string, number>();
  const codes = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === "") continue;
    let c = at.get(v);
    if (c === undefined) {
      c = dict.push(v);
      at.set(v, c);
    }
    codes[i] = c;
  }
  return { kind: "string", name, codes, dict };
}

/**
 * Read the sheet. Untouched imported columns are used as they are (no copy
 * when the sheet isn't sorted); edited columns are read cell by cell.
 */
export function readSheetColumns(src: ColumnSource): SheetColumns {
  const { rows: used, cols } = src.usedRange();
  const named = namedHeader(src as EditableSource);
  const first = named ? 0 : 1;
  const rows = Math.max(0, used - first);
  const names: string[] = [];
  const columns: ColumnData[] = [];
  const numFmts: string[] = [];
  const isDate: boolean[] = [];
  const order = src.rowOrder;
  for (let c = 0; c < cols; c++) {
    const raw = named ? named[c] : src.getCell(0, c);
    const text = raw === null || raw === undefined ? "" : String(raw).trim();
    const name = text || `Column ${columnLetter(c)}`;
    const fmt = (rows ? src.getStyle(first, c)?.numFmt : undefined) ?? "";
    names.push(name);
    numFmts.push(fmt);
    isDate.push(isDateFormat(fmt));
    columns.push(readColumn(src, c, name, first, rows, order !== null, fmt));
  }
  return { names, columns, numFmts, isDate, first, rows };
}

function readColumn(src: ColumnSource, c: number, name: string, first: number, rows: number, sorted: boolean, fmt: string): ColumnData {
  const base = src.baseColumn(c);
  if (base && (sorted || (base.kind === "number" ? base.values.length : base.codes.length) >= first + rows)) {
    if (!sorted) {
      return base.kind === "number" ? { kind: "number", name, values: base.values.subarray(first, first + rows) } : { kind: "string", name, codes: base.codes.subarray(first, first + rows), dict: base.dict };
    }
    // sorted: gather in view order
    if (base.kind === "number") {
      const values = new Float64Array(rows);
      for (let i = 0; i < rows; i++) values[i] = base.values[src.toBase(i + first)];
      return { kind: "number", name, values };
    }
    const codes = new Uint32Array(rows);
    for (let i = 0; i < rows; i++) codes[i] = base.codes[src.toBase(i + first)];
    return { kind: "string", name, codes, dict: base.dict };
  }
  // edited or not imported: cell by cell
  const vals: (string | number | null)[] = new Array(rows);
  let numbers = true;
  for (let i = 0; i < rows; i++) {
    let v: unknown = src.getCell(i + first, c);
    if (typeof v === "string" && !v.trim()) v = null;
    if (typeof v === "boolean") v = v ? "TRUE" : "FALSE";
    if (v !== null && typeof v !== "number") numbers = false;
    vals[i] = v as string | number | null;
  }
  if (numbers) return { kind: "number", name, values: Float64Array.from(vals, (v) => (v === null ? NaN : (v as number))) };
  return textColumn(
    name,
    vals.map((v) => (v === null ? null : typeof v === "number" ? formatValue(v, fmt).text : v)),
  );
}

// --------------------------------------------------------------- layout --

export interface PlacedField {
  field: number;
  group?: DateGroup;
}
export interface PlacedValue {
  field: number;
  agg: PivotAgg;
  showAs: ShowAs;
}
export interface PlacedFilter {
  field: number;
  group?: DateGroup;
  /** members to keep; null keeps everything */
  keep: Set<PivotKey> | null;
}
export interface PivotLayout {
  rows: PlacedField[];
  cols: PlacedField[];
  values: PlacedValue[];
  filters: PlacedFilter[];
  subtotals: boolean;
  grandTotals: boolean;
}

export type Zone = "rows" | "cols" | "values" | "filters";

export const emptyLayout = (): PivotLayout => ({ rows: [], cols: [], values: [], filters: [], subtotals: true, grandTotals: true });

/** Where a clicked field goes: numbers to Values, text and dates to Rows. */
export function defaultZone(data: SheetColumns, field: number): Zone {
  return data.columns[field]?.kind === "number" && !data.isDate[field] ? "values" : "rows";
}

/** A sensible starting aggregation: sum for numbers, count otherwise. */
export function defaultAgg(data: SheetColumns, field: number): PivotAgg {
  return data.columns[field]?.kind === "number" && !data.isDate[field] ? "sum" : "count";
}

/** Put a field in a zone (at the end, or at `at`). A field (with its date grouping) is in Rows or Columns once. */
export function placeField(layout: PivotLayout, data: SheetColumns, field: number, zone: Zone, at?: number): PivotLayout {
  const next: PivotLayout = { ...layout, rows: [...layout.rows], cols: [...layout.cols], values: [...layout.values], filters: [...layout.filters] };
  // dates on rows or columns start grouped by month
  const group: DateGroup | undefined = data.isDate[field] ? "month" : undefined;
  const insert = <T>(list: T[], item: T) => list.splice(at === undefined ? list.length : Math.max(0, Math.min(at, list.length)), 0, item);
  if (zone === "rows" || zone === "cols") {
    // once per grouping: a date can be on Rows by year and by month
    const same = (f: PlacedField) => f.field === field && f.group === group;
    next.rows = next.rows.filter((f) => !same(f));
    next.cols = next.cols.filter((f) => !same(f));
    insert(next[zone], { field, ...(group ? { group } : {}) });
  } else if (zone === "values") insert(next.values, { field, agg: defaultAgg(data, field), showAs: "value" });
  else {
    next.filters = next.filters.filter((f) => f.field !== field);
    insert(next.filters, { field, ...(data.isDate[field] ? { group: "year" as DateGroup } : {}), keep: null });
  }
  return next;
}

/** A text column whose values (the first 50 distinct ones) are mostly dates. */
export function looksLikeDates(col: ColumnData): boolean {
  if (col.kind !== "string" || !col.dict.length) return false;
  const sample = col.dict.slice(0, 50);
  return sample.filter((s) => parseDateLoose(s) !== null).length >= sample.length * 0.8;
}

/** The engine spec for a layout. */
export function toSpec(layout: PivotLayout): PivotSpec {
  return {
    rows: layout.rows.map((f) => ({ ...f })),
    cols: layout.cols.map((f) => ({ ...f })),
    values: layout.values.map((v) => ({ field: v.field, agg: v.agg, showAs: v.showAs })),
    filters: layout.filters.filter((f) => f.keep).map((f) => ({ field: f.field, ...(f.group ? { group: f.group } : {}), keep: f.keep! })),
    subtotals: layout.subtotals,
    grandTotals: layout.grandTotals,
  };
}

/**
 * A pivot chart of a layout, or null when the layout has nothing to chart
 * (it needs a value and a field on Rows or Columns). The title says what
 * is charted: "Sum of Amount by Region".
 */
export function pivotChartForLayout(layout: PivotLayout, data: SheetColumns, sheetId: string, type: ChartType = "column"): ChartSpec | null {
  if (!layout.values.length || (!layout.rows.length && !layout.cols.length)) return null;
  const what = layout.values.map((v) => `${AGG_LABEL[v.agg]} of ${data.names[v.field]}`).join(", ");
  const by = [...layout.rows, ...layout.cols].map((f) => data.names[f.field]).join(" and ");
  const id = `pchart${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  return pivotChartSpec(id, sheetId, savePivot(toSpec(layout), data.names), type, `${what} by ${by}`);
}

/** Number format for a value column. */
export function valueFormat(v: { field: number; agg: PivotAgg; showAs?: ShowAs }, data: SheetColumns): string {
  if (v.showAs && v.showAs !== "value" && v.showAs !== "running") return "0.0%";
  if (v.agg === "count" || v.agg === "countDistinct") return "#,##0";
  const fmt = data.numFmts[v.field] ?? "";
  if (data.isDate[v.field]) return v.agg === "min" || v.agg === "max" || v.agg === "median" ? fmt : "#,##0.00";
  if (fmt) return fmt;
  return v.agg === "avg" || v.agg === "stdev" ? "#,##0.00" : "";
}

/** The pivot laid out as a table: label columns, then one column per column item and value. */
export interface PivotTable {
  headers: string[];
  labelCols: number;
  /** one per result row: labels (text) then values (null when empty) */
  rows: { kind: PivotItem["kind"]; cells: (string | number | null)[] }[];
  numFmts: string[];
  /** value column j -> column item c and value v */
  valueAt: { c: number; v: number }[];
}

function memberText(r: PivotResult, axis: "row" | "col", f: number, it: PivotItem, data: SheetColumns): string {
  const fld = (axis === "row" ? r.rowFields : r.colFields)[f];
  const key = fld.keys[it.path[f]];
  if (typeof key === "number" && !fld.group) return formatValue(key, data.numFmts[fld.field] ?? "").text;
  return it.labels[f];
}

export function pivotTable(r: PivotResult, data: SheetColumns): PivotTable {
  const nRowF = r.rowFields.length;
  const labelCols = Math.max(1, nRowF);
  const headers = nRowF ? r.rowFields.map((f) => f.name) : [""];
  const valueAt: { c: number; v: number }[] = [];
  const numFmts: string[] = new Array(labelCols).fill("");
  const V = r.values.length;
  const colLabel = (it: PivotItem) => {
    if (it.kind === "grand") return r.colFields.length ? "Grand total" : "";
    const parts = it.labels.map((_, f) => memberText(r, "col", f, it, data));
    return parts.join(" / ") + (it.kind === "subtotal" ? " Total" : "");
  };
  r.colItems.forEach((it, c) => {
    for (let v = 0; v < V; v++) {
      const cl = colLabel(it);
      headers.push(cl ? (V > 1 ? `${cl} · ${r.valueNames[v]}` : cl) : r.valueNames[v]);
      valueAt.push({ c, v });
      numFmts.push(valueFormat(r.values[v], data));
    }
  });
  const rows = r.rowItems.map((it, ri) => {
    const cells: (string | number | null)[] = [];
    for (let f = 0; f < labelCols; f++) {
      if (!nRowF) cells.push("Total");
      else if (it.kind === "grand") cells.push(f === 0 ? "Grand total" : null);
      else if (f < it.depth) cells.push(memberText(r, "row", f, it, data) + (it.kind === "subtotal" && f === it.depth - 1 ? " Total" : ""));
      else cells.push(null);
    }
    for (const { c, v } of valueAt) {
      const x = r.value(ri, c, v);
      cells.push(x === x ? x : null);
    }
    return { kind: it.kind, cells };
  });
  return { headers, labelCols, rows, numFmts, valueAt };
}

/** The pivot as sheet columns for sheet.insert. */
export function pivotSheetColumns(t: PivotTable): { columns: ColumnData[]; numFmts: string[] } {
  const columns = t.headers.map((name, j): ColumnData => {
    const vals = t.rows.map((row) => row.cells[j]);
    if (j >= t.labelCols) return { kind: "number", name, values: Float64Array.from(vals, (v) => (typeof v === "number" ? v : NaN)) };
    return textColumn(
      name,
      vals.map((v) => (v === null ? null : String(v))),
    );
  });
  return { columns, numFmts: t.numFmts };
}

/** The rows behind a cell, every column of the sheet, with their sheet row numbers first. */
export function drillColumns(data: SheetColumns, members: Uint32Array): { columns: ColumnData[]; numFmts: string[] } {
  const n = members.length;
  const row = new Float64Array(n);
  for (let i = 0; i < n; i++) row[i] = members[i] + data.first + 1;
  const columns: ColumnData[] = [{ kind: "number", name: "Row", values: row }];
  const numFmts = ["0"];
  data.columns.forEach((col, j) => {
    if (col.kind === "number") {
      const values = new Float64Array(n);
      for (let i = 0; i < n; i++) values[i] = col.values[members[i]];
      columns.push({ kind: "number", name: data.names[j], values });
    } else {
      const codes = new Uint32Array(n);
      for (let i = 0; i < n; i++) codes[i] = col.codes[members[i]];
      columns.push({ kind: "string", name: data.names[j], codes, dict: col.dict });
    }
    numFmts.push(data.numFmts[j]);
  });
  return { columns, numFmts };
}

/** "East / B, Sum of Amount" style description of a cell, for status lines. */
export function describeCell(t: PivotTable, ri: number, j: number): string {
  const row = t.rows[ri];
  const labels = row.cells.slice(0, t.labelCols).filter((x): x is string => typeof x === "string" && x !== "");
  const col = j >= t.labelCols ? t.headers[j] : "";
  return [labels.join(" / "), col].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------- dialog --

const GROUPS: [string, string][] = [
  ["", "No date grouping"],
  ["year", "Years"],
  ["quarter", "Quarters"],
  ["month", "Months"],
  ["day", "Days"],
];
const AGGS = Object.entries(AGG_LABEL) as [PivotAgg, string][];
const SHOW_AS: [ShowAs, string][] = [
  ["value", "Plain value"],
  ["pctGrand", "% of grand total"],
  ["pctRow", "% of row total"],
  ["pctCol", "% of column total"],
  ["running", "Running total"],
];
const ZONES: [Zone, string, string][] = [
  ["filters", "Filters", "Pick which items to include"],
  ["cols", "Columns", "Items across the top"],
  ["rows", "Rows", "Items down the side"],
  ["values", "Values", "What to add up or count"],
];
const PREVIEW_ROWS = 300;
const PREVIEW_COLS = 60;
const CHECKLIST_MAX = 300;

/** Layouts from earlier in the session, by sheet name. */
const remembered = new Map<string, PivotLayout>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function select(options: [string, string][], value: string, label: string): HTMLSelectElement {
  const s = document.createElement("select");
  for (const [v, t] of options) s.append(new Option(t, v));
  s.value = value;
  s.setAttribute("aria-label", label);
  return s;
}

function iconButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "pivot-icon", text);
  b.type = "button";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", onClick);
  return b;
}

const kindLabel = (data: SheetColumns, f: number) => (data.isDate[f] ? "date" : data.columns[f].kind === "number" ? "number" : "text");

export function openPivot(d: PivotDeps): void {
  const data = readSheetColumns(d.source());
  const sheet = d.sheetName();
  const back = el("div", "palette-backdrop");
  const dialog = el("div", "palette import-dialog pivot-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Pivot table");
  const body = el("div", "palette-form pivot-form");
  dialog.append(body);
  back.append(dialog);
  const close = () => {
    clearTimeout(timer);
    back.remove();
    d.focusGrid();
  };
  let timer = 0;
  body.append(el("h3", undefined, "Pivot table"));

  if (!data.rows || !data.columns.length) {
    body.append(el("p", undefined, "This sheet has no data to pivot. Open or paste the data first; the first row (or the column names) should name the columns."));
    const actions = el("div", "numfmt-actions");
    const ok = el("button", undefined, "Close");
    ok.type = "button";
    ok.addEventListener("click", close);
    actions.append(ok);
    body.append(actions);
    back.addEventListener("keydown", (e) => e.key === "Escape" && close());
    document.body.append(back);
    ok.focus();
    return;
  }

  let layout: PivotLayout = remembered.get(sheet) ?? emptyLayout();
  // drop fields that no longer exist (columns deleted since)
  const ok = (f: { field: number }) => f.field < data.columns.length;
  layout = { ...layout, rows: layout.rows.filter(ok), cols: layout.cols.filter(ok), values: layout.values.filter(ok), filters: layout.filters.filter(ok) };

  const intro = el("p", "hp-muted", `${data.rows.toLocaleString("en-US")} rows of ${sheet}. Drag fields into the boxes, or click a field to add it (numbers go to Values, text and dates to Rows). Click a result cell, then "Show these rows" to see the rows behind it.`);
  const builder = el("div", "pivot-builder");
  const fieldBox = el("section", "pivot-fields");
  fieldBox.setAttribute("aria-label", "Fields");
  const fieldHead = el("h4", undefined, "Fields");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Find a field";
  search.setAttribute("aria-label", "Find a field");
  const fieldList = el("ul", "pivot-field-list");
  fieldBox.append(fieldHead, search, fieldList);
  const zonesBox = el("div", "pivot-zones");
  const zoneEls = new Map<Zone, HTMLElement>();
  for (const [zone, title, hint] of ZONES) {
    const sec = el("section", "pivot-zone");
    sec.dataset.zone = zone;
    sec.setAttribute("aria-label", title);
    const h = el("h4", undefined, title);
    const drop = el("div", "pivot-drop");
    drop.dataset.hint = hint;
    sec.append(h, drop);
    zonesBox.append(sec);
    zoneEls.set(zone, drop);
  }
  builder.append(fieldBox, zonesBox);

  const options = el("div", "pivot-options");
  const subBox = checkbox("Subtotals", layout.subtotals, (v) => update({ ...layout, subtotals: v }));
  const grandBox = checkbox("Grand totals", layout.grandTotals, (v) => update({ ...layout, grandTotals: v }));
  options.append(subBox, grandBox);

  const statusLine = el("p", "pivot-status");
  statusLine.setAttribute("aria-live", "polite");
  const preview = el("div", "import-preview pivot-preview");
  const actions = el("div", "numfmt-actions");
  const closeBtn = el("button", undefined, "Close");
  closeBtn.type = "button";
  const drillBtn = el("button", undefined, "Show these rows");
  drillBtn.type = "button";
  drillBtn.disabled = true;
  const sheetBtn = el("button", undefined, "Put the pivot on a new sheet");
  sheetBtn.type = "button";
  actions.append(closeBtn, drillBtn, sheetBtn);
  // a pivot chart: saved with the workbook, worked out again when the data changes
  const chartType = select(
    PIVOT_CHART_TYPES.map((t) => [t, t[0].toUpperCase() + t.slice(1)] as [string, string]),
    "column",
    "Pivot chart type",
  );
  const chartBtn = el("button", undefined, "Chart this pivot");
  chartBtn.type = "button";
  chartBtn.title = "A chart of this pivot that updates when the data changes";
  if (d.addChart && d.sheetId) actions.append(chartType, chartBtn);
  body.append(intro, builder, options, statusLine, preview, actions);

  let result: PivotResult | null = null;
  let table: PivotTable | null = null;
  let picked: { r: number; j: number } | null = null;

  function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
    const l = el("label", "pivot-check");
    const i = el("input");
    i.type = "checkbox";
    i.checked = checked;
    i.addEventListener("change", () => onChange(i.checked));
    l.append(i, label);
    return l;
  }

  // ---- drag and drop
  type Drag = { field: number; from: Zone | "list"; index: number };
  let dragging: Drag | null = null;
  const draggable = (node: HTMLElement, drag: Drag) => {
    node.draggable = true;
    node.addEventListener("dragstart", (e) => {
      dragging = drag;
      e.dataTransfer?.setData("text/plain", data.names[drag.field]);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    node.addEventListener("dragend", () => {
      dragging = null;
      for (const z of zoneEls.values()) z.classList.remove("pivot-over");
    });
  };
  /** Remove the item at `index` of zone `z`. */
  const without = (l: PivotLayout, z: Zone, index: number): PivotLayout => {
    const next = { ...l, rows: [...l.rows], cols: [...l.cols], values: [...l.values], filters: [...l.filters] };
    (next[z] as unknown[]).splice(index, 1);
    return next;
  };
  const move = (drag: Drag, to: Zone, at?: number) => {
    if (drag.from === "list") {
      update(placeField(layout, data, drag.field, to, at));
      return;
    }
    const item = (layout[drag.from] as { field: number; group?: DateGroup }[])[drag.index];
    if (drag.from === to && at !== undefined && at > drag.index) at--;
    let l = without(layout, drag.from, drag.index);
    if (drag.from === to) {
      // reordering: keep the item as it is (aggregation, grouping, picked items)
      (l[to] as unknown[]).splice(at ?? (l[to] as unknown[]).length, 0, item);
      update(l);
      return;
    }
    l = placeField(l, data, drag.field, to, at);
    // keep the date grouping when moving between rows, columns and filters
    if (to !== "values" && drag.from !== "values" && item.group) {
      const list = l[to] as { field: number; group?: DateGroup }[];
      const i = list.findIndex((x) => x.field === drag.field);
      if (i >= 0) list[i] = { ...list[i], group: item.group };
    }
    update(l);
  };
  for (const [zone, drop] of zoneEls) {
    drop.addEventListener("dragover", (e) => {
      if (!dragging) return;
      e.preventDefault();
      drop.classList.add("pivot-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("pivot-over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("pivot-over");
      if (!dragging) return;
      // drop position: before the chip under the pointer
      const chips = [...drop.querySelectorAll<HTMLElement>(".pivot-chip")];
      let at: number | undefined;
      for (let i = 0; i < chips.length; i++) {
        const r = chips[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          at = i;
          break;
        }
      }
      const drag = dragging;
      dragging = null;
      move(drag, zone, at);
    });
  }
  // dropping back on the field list removes it
  fieldBox.addEventListener("dragover", (e) => {
    if (dragging && dragging.from !== "list") e.preventDefault();
  });
  fieldBox.addEventListener("drop", (e) => {
    e.preventDefault();
    if (dragging && dragging.from !== "list") update(without(layout, dragging.from, dragging.index));
    dragging = null;
  });

  // ---- field list
  const renderFields = () => {
    const q = search.value.trim().toLowerCase();
    fieldList.replaceChildren();
    const inUse = new Set([...layout.rows, ...layout.cols, ...layout.values, ...layout.filters].map((f) => f.field));
    data.names.forEach((name, f) => {
      if (q && !name.toLowerCase().includes(q)) return;
      const li = el("li");
      const b = el("button", "pivot-field" + (inUse.has(f) ? " pivot-used" : ""));
      b.type = "button";
      b.append(el("span", undefined, name), el("small", undefined, kindLabel(data, f)));
      b.title = `Add ${name} to ${defaultZone(data, f) === "values" ? "Values" : "Rows"}. Drag it to put it somewhere else.`;
      b.addEventListener("click", () => update(placeField(layout, data, f, defaultZone(data, f))));
      draggable(b, { field: f, from: "list", index: -1 });
      li.append(b);
      fieldList.append(li);
    });
  };
  search.addEventListener("input", renderFields);

  // ---- zones
  const moveSelect = (zone: Zone, index: number, field: number) => {
    const s = select(
      [["", "Move to…"], ...ZONES.filter(([z]) => z !== zone).map(([z, t]) => [z, t] as [string, string])],
      "",
      `Move ${data.names[field]} to another box`,
    );
    s.addEventListener("change", () => s.value && move({ field, from: zone, index }, s.value as Zone));
    return s;
  };
  const chip = (zone: Zone, index: number, field: number, label: string): { chip: HTMLElement; controls: HTMLElement } => {
    const c = el("div", "pivot-chip");
    const head = el("div", "pivot-chip-head");
    const name = el("span", "pivot-chip-name", label);
    const controls = el("div", "pivot-chip-controls");
    const list = layout[zone] as unknown[];
    if (index > 0) head.append(iconButton("↑", `Move ${data.names[field]} up`, () => update(reorder(zone, index, index - 1))));
    if (index < list.length - 1) head.append(iconButton("↓", `Move ${data.names[field]} down`, () => update(reorder(zone, index, index + 1))));
    head.prepend(name);
    head.append(iconButton("✕", `Remove ${data.names[field]}`, () => update(without(layout, zone, index))));
    c.append(head, controls);
    controls.append(moveSelect(zone, index, field));
    // only the head drags, so the selects and the slicer search box work normally
    draggable(head, { field, from: zone, index });
    return { chip: c, controls };
  };
  const reorder = (zone: Zone, from: number, to: number): PivotLayout => {
    const next = { ...layout, [zone]: [...(layout[zone] as unknown[])] } as PivotLayout;
    const list = next[zone] as unknown[];
    const [x] = list.splice(from, 1);
    list.splice(to, 0, x);
    return next;
  };
  const groupSelect = (zone: "rows" | "cols" | "filters", index: number, f: { field: number; group?: DateGroup }) => {
    const s = select(GROUPS, f.group ?? "", `Group ${data.names[f.field]} by`);
    s.addEventListener("change", () => {
      const next = { ...layout, [zone]: [...layout[zone]] } as PivotLayout;
      const list = next[zone] as { field: number; group?: DateGroup; keep?: Set<PivotKey> | null }[];
      const item = { ...list[index], group: (s.value || undefined) as DateGroup | undefined };
      if (!item.group) delete item.group;
      if (zone === "filters") item.keep = null; // members change with the grouping
      list[index] = item;
      update(next);
    });
    return s;
  };
  const groupable = new Map<number, boolean>();
  const canGroup = (field: number) => {
    let g = groupable.get(field);
    if (g === undefined) {
      g = data.isDate[field] || looksLikeDates(data.columns[field]);
      groupable.set(field, g);
    }
    return g;
  };
  const membersCache = new Map<string, ReturnType<typeof fieldMembers>>();
  const membersOf = (field: number, group?: DateGroup) => {
    const k = `${field}:${group ?? ""}`;
    let m = membersCache.get(k);
    if (!m) {
      m = fieldMembers(data.columns[field], group);
      membersCache.set(k, m);
    }
    return m;
  };
  const memberLabel = (field: number, group: DateGroup | undefined, key: PivotKey, label: string) =>
    typeof key === "number" && !group ? formatValue(key, data.numFmts[field]).text : label;
  const checklist = (index: number, flt: PlacedFilter): HTMLElement => {
    const box = el("div", "pivot-slicer");
    const members = membersOf(flt.field, flt.group);
    const find = el("input");
    find.type = "search";
    find.placeholder = `Find in ${members.length.toLocaleString("en-US")} items`;
    find.setAttribute("aria-label", `Find items of ${data.names[flt.field]}`);
    const list = el("div", "pivot-slicer-list");
    // read the filter fresh each time: ticking boxes doesn't re-render the zones
    const current = () => layout.filters[index].keep;
    const shown = el("small", "hp-muted");
    const count = () => {
      const keep = current();
      shown.textContent = keep ? `${keep.size.toLocaleString("en-US")} of ${members.length.toLocaleString("en-US")} picked` : "All items";
    };
    const setKeep = (keep: Set<PivotKey> | null) => {
      const next = { ...layout, filters: [...layout.filters] };
      next.filters[index] = { ...layout.filters[index], keep };
      update(next, false);
      count();
    };
    const all = el("div", "pivot-slicer-all");
    const selAll = el("button", undefined, "All");
    selAll.type = "button";
    selAll.addEventListener("click", () => {
      setKeep(null);
      render();
    });
    const selNone = el("button", undefined, "None");
    selNone.type = "button";
    selNone.addEventListener("click", () => {
      setKeep(new Set());
      render();
    });
    count();
    all.append(selAll, selNone, shown);
    const render = () => {
      const keepNow = current();
      const q = find.value.trim().toLowerCase();
      list.replaceChildren();
      let n = 0;
      for (const m of members) {
        const text = memberLabel(flt.field, flt.group, m.key, m.label);
        if (q && !text.toLowerCase().includes(q)) continue;
        if (n++ >= CHECKLIST_MAX) {
          list.append(el("small", "hp-muted", "More items: type to find them."));
          break;
        }
        const l = el("label", "pivot-check");
        const i = el("input");
        i.type = "checkbox";
        i.checked = !keepNow || keepNow.has(m.key);
        i.addEventListener("change", () => {
          const keep = new Set(current() ?? members.map((x) => x.key));
          if (i.checked) keep.add(m.key);
          else keep.delete(m.key);
          setKeep(keep.size === members.length ? null : keep);
        });
        l.append(i, `${text} `, el("small", "hp-muted", `(${m.count.toLocaleString("en-US")})`));
        list.append(l);
      }
    };
    find.addEventListener("input", render);
    render();
    box.append(all, find, list);
    return box;
  };
  const renderZones = () => {
    for (const [zone, drop] of zoneEls) {
      drop.replaceChildren();
      if (zone === "rows" || zone === "cols") {
        layout[zone].forEach((f, i) => {
          const { chip: c, controls } = chip(zone, i, f.field, data.names[f.field]);
          if (canGroup(f.field)) controls.prepend(groupSelect(zone, i, f));
          drop.append(c);
        });
      } else if (zone === "values") {
        layout.values.forEach((v, i) => {
          const { chip: c, controls } = chip(zone, i, v.field, `${AGG_LABEL[v.agg]} of ${data.names[v.field]}`);
          const agg = select(AGGS, v.agg, `How to summarise ${data.names[v.field]}`);
          const show = select(SHOW_AS, v.showAs, `Show ${data.names[v.field]} as`);
          const change = () => {
            const values = [...layout.values];
            values[i] = { ...v, agg: agg.value as PivotAgg, showAs: show.value as ShowAs };
            update({ ...layout, values });
          };
          agg.addEventListener("change", change);
          show.addEventListener("change", change);
          controls.prepend(agg, show);
          drop.append(c);
        });
      } else {
        layout.filters.forEach((flt, i) => {
          const { chip: c, controls } = chip(zone, i, flt.field, data.names[flt.field]);
          if (canGroup(flt.field)) controls.prepend(groupSelect("filters", i, flt));
          c.append(checklist(i, flt));
          drop.append(c);
        });
      }
      if (!drop.childElementCount) drop.append(el("p", "pivot-empty", drop.dataset.hint));
    }
  };

  // ---- preview
  const fmtCell = (v: string | number | null, fmt: string) => (v === null ? "" : typeof v === "number" ? formatValue(v, fmt).text : v);
  const renderPreview = () => {
    preview.replaceChildren();
    drillBtn.disabled = true;
    picked = null;
    if (!table) return;
    const t = table;
    const cols = Math.min(t.headers.length, t.labelCols + PREVIEW_COLS);
    const tbl = el("table", "pivot-table");
    const thead = el("thead");
    const htr = el("tr");
    for (let j = 0; j < cols; j++) htr.append(el("th", j < t.labelCols ? "pivot-label" : "pivot-num", t.headers[j]));
    thead.append(htr);
    const tbody = el("tbody");
    t.rows.slice(0, PREVIEW_ROWS).forEach((row, ri) => {
      const tr = el("tr", `pivot-${row.kind}`);
      for (let j = 0; j < cols; j++) {
        const td = el(j < t.labelCols ? "th" : "td", j < t.labelCols ? "pivot-label" : "pivot-num", fmtCell(row.cells[j], t.numFmts[j]));
        if (j < t.labelCols) td.setAttribute("scope", "row");
        else {
          td.tabIndex = -1;
          td.dataset.r = String(ri);
          td.dataset.j = String(j);
        }
        tr.append(td);
      }
      tbody.append(tr);
    });
    tbl.append(thead, tbody);
    preview.append(tbl);
    if (t.rows.length > PREVIEW_ROWS || t.headers.length > cols)
      preview.append(el("p", "hp-muted pivot-more", `Showing ${Math.min(PREVIEW_ROWS, t.rows.length)} of ${t.rows.length.toLocaleString("en-US")} rows and ${cols - t.labelCols} of ${t.headers.length - t.labelCols} value columns. Put the pivot on a new sheet to see it all.`));
    const firstCell = tbl.querySelector<HTMLElement>("td");
    if (firstCell) firstCell.tabIndex = 0;
  };
  const pick = (td: HTMLElement) => {
    preview.querySelectorAll(".pivot-picked").forEach((x) => {
      x.classList.remove("pivot-picked");
      (x as HTMLElement).tabIndex = -1;
    });
    td.classList.add("pivot-picked");
    td.tabIndex = 0;
    picked = { r: Number(td.dataset.r), j: Number(td.dataset.j) };
    drillBtn.disabled = false;
    if (table && result) {
      const { c } = table.valueAt[picked.j - table.labelCols];
      const n = result.members(picked.r, c).length;
      statusLine.textContent = `${describeCell(table, picked.r, picked.j)}: ${n.toLocaleString("en-US")} row${n === 1 ? "" : "s"}. Press Enter or "Show these rows" to see them.`;
    }
  };
  preview.addEventListener("click", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-r]");
    if (td) pick(td);
  });
  preview.addEventListener("dblclick", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-r]");
    if (td) {
      pick(td);
      drill();
    }
  });
  preview.addEventListener("keydown", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-r]");
    if (!td) return;
    const r = Number(td.dataset.r);
    const j = Number(td.dataset.j);
    const go = (r2: number, j2: number) => {
      const next = preview.querySelector<HTMLElement>(`td[data-r="${r2}"][data-j="${j2}"]`);
      if (next) {
        e.preventDefault();
        pick(next);
        next.focus();
      }
    };
    if (e.key === "ArrowDown") go(r + 1, j);
    else if (e.key === "ArrowUp") go(r - 1, j);
    else if (e.key === "ArrowRight") go(r, j + 1);
    else if (e.key === "ArrowLeft") go(r, j - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(td);
      drill();
    }
  });
  preview.addEventListener("focusin", (e) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("td[data-r]");
    if (td && !td.classList.contains("pivot-picked")) pick(td);
  });

  const compute = () => {
    result = null;
    table = null;
    if (!layout.rows.length && !layout.cols.length && !layout.values.length) {
      statusLine.textContent = "Add a field to start.";
      sheetBtn.disabled = true;
      chartBtn.disabled = true;
      renderPreview();
      return;
    }
    try {
      result = pivot(data.columns, toSpec(layout));
      table = pivotTable(result, data);
      const f = result.rowsUsed === result.rowCount ? "" : ` (${result.rowsUsed.toLocaleString("en-US")} after filters)`;
      statusLine.textContent = `${result.rowItems.length.toLocaleString("en-US")} result rows from ${result.rowCount.toLocaleString("en-US")} data rows${f}, in ${Math.round(result.ms)} ms.`;
      statusLine.classList.remove("cleanup-warn");
      sheetBtn.disabled = false;
      chartBtn.disabled = !layout.values.length || (!layout.rows.length && !layout.cols.length);
    } catch (e) {
      statusLine.textContent = (e as Error).message;
      statusLine.classList.add("cleanup-warn");
      sheetBtn.disabled = true;
      chartBtn.disabled = true;
    }
    renderPreview();
  };

  /** Change the layout. Re-renders the zones (unless a checklist is being ticked) and recomputes soon. */
  function update(next: PivotLayout, rerenderZones = true) {
    layout = next;
    remembered.set(sheet, layout);
    // focus survives a re-render by its aria-label
    const focused = document.activeElement as HTMLElement | null;
    const focusLabel = focused && zonesBox.contains(focused) ? focused.getAttribute("aria-label") : null;
    // ticking a slicer box leaves the zones alone so the list keeps its place
    if (rerenderZones) {
      renderFields();
      renderZones();
    }
    if (rerenderZones && focusLabel) {
      const find = (label: string) => zonesBox.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`);
      // an up / down button that is gone at the end of the list: fall back to the item's remove button
      (find(focusLabel) ?? find(focusLabel.replace(/^Move (.+) (up|down)$/, "Remove $1")))?.focus();
    }
    statusLine.textContent = "Working…";
    clearTimeout(timer);
    timer = window.setTimeout(compute, 120);
  }

  // ---- actions
  const addSheet = async (name: string, cols: { columns: ColumnData[]; numFmts: string[] }) => {
    const source = new EditableSource(new Table(cols.columns), 5);
    await d.run({ type: "sheet.insert", params: { name: name.slice(0, 31), source: d.putBlob(source), numFmts: cols.numFmts } });
  };
  function drill() {
    if (!picked || !result || !table) return;
    const { c } = table.valueAt[picked.j - table.labelCols];
    const members = result.members(picked.r, c);
    if (!members.length) {
      statusLine.textContent = "No rows behind this cell.";
      return;
    }
    const what = describeCell(table, picked.r, picked.j);
    const cols = drillColumns(data, members);
    close();
    void addSheet(`${sheet.slice(0, 20)} rows`, cols).then(() => d.status(`${members.length.toLocaleString("en-US")} rows behind ${what}`));
  }
  drillBtn.addEventListener("click", drill);
  sheetBtn.addEventListener("click", () => {
    clearTimeout(timer);
    compute();
    if (!table) return;
    const cols = pivotSheetColumns(table);
    const n = table.rows.length;
    close();
    void addSheet(`${sheet.slice(0, 24)} pivot`, cols).then(() => d.status(`Pivot table: ${n.toLocaleString("en-US")} rows`));
  });
  chartBtn.addEventListener("click", () => {
    if (!d.addChart || !d.sheetId) return;
    const spec = pivotChartForLayout(layout, data, d.sheetId(), chartType.value as ChartType);
    if (!spec) return;
    close();
    d.addChart(spec);
    d.status(`Pivot chart of ${sheet}: it updates when the data changes`);
  });
  closeBtn.addEventListener("click", close);
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });

  renderFields();
  renderZones();
  compute();
  document.body.append(back);
  (fieldList.querySelector("button") as HTMLElement | null)?.focus();
}
