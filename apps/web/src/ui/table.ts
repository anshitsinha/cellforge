/**
 * A data table for dialogs and panels: sticky header, hairline rows,
 * right-aligned tabular numbers, optional checkbox column and clickable rows.
 *
 *   const t = renderTable({
 *     columns: [
 *       { key: "vendor", label: "Vendor" },
 *       { key: "date", label: "Date", format: "date" },
 *       { key: "amount", label: "Amount", format: "amount" },     // 1,234.50 · (1,234.50)
 *       { key: "rows", label: "Rows", format: "integer" },
 *     ],
 *     rows: groups,
 *     select: { initial: (r) => r.flagged, onChange: (picked) => apply.disabled = !picked.length },
 *     onRowClick: (r) => goTo(r.sheetRow),
 *     maxHeight: "40vh",
 *   });
 *   body.append(t.element);
 *
 * Formats: "text" (default), "number" (up to 2 dp), "integer", "amount"
 * (2 dp, negatives in brackets), "percent" (0.125 → 12.5%), "date" (Date,
 * ISO text or a spreadsheet serial such as 46023 → 2026-01-01), or a
 * function. Numeric formats align right unless `align` says otherwise.
 */
import "./ui.css";

export type CellFormat = "text" | "number" | "integer" | "amount" | "percent" | "date";

export interface TableColumn<R> {
  key: string;
  label: string;
  format?: CellFormat | ((value: unknown, row: R) => string);
  align?: "left" | "right" | "center";
  /** where the value comes from (default row[key]) */
  value?: (row: R) => unknown;
  /** CSS width, e.g. "8em" */
  width?: string;
  /** tooltip for the cell */
  title?: (row: R) => string | undefined;
}

export interface TableOptions<R> {
  columns: readonly TableColumn<R>[];
  rows: readonly R[];
  /** a checkbox per row, plus select-all in the header */
  select?: {
    initial?: (row: R, index: number) => boolean;
    onChange?: (selected: number[]) => void;
    /** spoken name of a row's checkbox (default: the first column's text) */
    label?: (row: R, index: number) => string;
  };
  onRowClick?: (row: R, index: number) => void;
  /** shown when there are no rows */
  empty?: string;
  caption?: string;
  /** scroll inside this height (e.g. "40vh"); the header stays put */
  maxHeight?: string;
  zebra?: boolean;
  dense?: boolean;
  /** BCP 47 locale for numbers (default: the browser's) */
  locale?: string;
}

export interface TableHandle {
  /** the scrolling wrapper; append this */
  readonly element: HTMLElement;
  readonly table: HTMLTableElement;
  /** indexes of the ticked rows */
  selected(): number[];
  setRows<R>(rows: readonly R[]): void;
}

const NUMERIC: ReadonlySet<string> = new Set(["number", "integer", "amount", "percent"]);

/** Default alignment for a format: numbers right, the rest left. */
export function defaultAlign(format: CellFormat | ((value: unknown, row: never) => string) | undefined): "left" | "right" {
  return typeof format === "string" && NUMERIC.has(format) ? "right" : "left";
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(locale: string | undefined, min: number, max: number, style: "decimal" | "percent" = "decimal"): Intl.NumberFormat {
  const key = `${locale ?? ""}|${min}|${max}|${style}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max, style });
    numberFormats.set(key, f);
  }
  return f;
}

/** Days from 1899-12-30 (the spreadsheet epoch) to a yyyy-mm-dd string. */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** A cell's text for a format (pure). Blank for null / undefined / NaN. */
export function formatCell(value: unknown, format: CellFormat = "text", locale?: string): string {
  if (value === null || value === undefined) return "";
  if (format === "text") return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (format === "date") {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
    const n = toNumber(value);
    if (n !== null && n > 0 && n < 2958466) return serialToIso(n);
    return String(value);
  }
  const n = toNumber(value);
  if (n === null) return String(value);
  switch (format) {
    case "integer":
      return nf(locale, 0, 0).format(n);
    case "amount": {
      const s = nf(locale, 2, 2).format(Math.abs(n));
      return n < 0 ? `(${s})` : s;
    }
    case "percent":
      return nf(locale, 0, 1, "percent").format(n);
    default:
      return nf(locale, 0, 2).format(n);
  }
}

/** The text of one cell, using the column's format (pure). */
export function cellText<R>(col: TableColumn<R>, row: R, locale?: string): string {
  const v = col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
  return typeof col.format === "function" ? col.format(v, row) : formatCell(v, col.format, locale);
}

export function renderTable<R>(opts: TableOptions<R>): TableHandle {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  if (opts.maxHeight) wrap.style.maxHeight = opts.maxHeight;
  const table = document.createElement("table");
  table.className = `data-table${opts.zebra ? " data-table--zebra" : ""}${opts.dense ? " data-table--dense" : ""}`;
  wrap.append(table);

  let rows: readonly R[] = opts.rows;
  let ticked: boolean[] = [];
  const all = document.createElement("input");

  const notify = () => opts.select?.onChange?.(selected());
  const selected = () => ticked.flatMap((t, i) => (t ? [i] : []));
  const syncAll = () => {
    const n = selected().length;
    all.checked = n > 0 && n === rows.length;
    all.indeterminate = n > 0 && n < rows.length;
  };

  const build = () => {
    table.replaceChildren();
    if (opts.caption) {
      const c = document.createElement("caption");
      c.className = "cf-sr-only";
      c.textContent = opts.caption;
      table.append(c);
    }
    const thead = table.createTHead();
    const hr = thead.insertRow();
    if (opts.select) {
      const th = document.createElement("th");
      th.className = "data-table__check";
      all.type = "checkbox";
      all.setAttribute("aria-label", "Select all rows");
      all.onchange = () => {
        ticked = rows.map(() => all.checked);
        table.querySelectorAll<HTMLInputElement>("tbody input[type=checkbox]").forEach((c) => (c.checked = all.checked));
        table.querySelectorAll("tbody tr").forEach((tr) => tr.classList.toggle("is-selected", all.checked));
        notify();
      };
      th.append(all);
      hr.append(th);
    }
    for (const col of opts.columns) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.label;
      const align = col.align ?? defaultAlign(col.format);
      if (align === "right") th.classList.add("num");
      else if (align === "center") th.style.textAlign = "center";
      if (col.width) th.style.width = col.width;
      hr.append(th);
    }
    const tbody = table.createTBody();
    if (!rows.length) {
      const tr = tbody.insertRow();
      const td = tr.insertCell();
      td.colSpan = opts.columns.length + (opts.select ? 1 : 0);
      td.className = "data-table__empty";
      td.textContent = opts.empty ?? "Nothing to show.";
      return;
    }
    ticked = rows.map((r, i) => opts.select?.initial?.(r, i) ?? false);
    rows.forEach((row, i) => {
      const tr = tbody.insertRow();
      if (opts.select) {
        const td = tr.insertCell();
        td.className = "data-table__check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = ticked[i];
        tr.classList.toggle("is-selected", ticked[i]);
        box.setAttribute("aria-label", opts.select.label?.(row, i) ?? `Select ${cellText(opts.columns[0], row, opts.locale) || `row ${i + 1}`}`);
        box.addEventListener("click", (e) => e.stopPropagation());
        box.addEventListener("change", () => {
          ticked[i] = box.checked;
          tr.classList.toggle("is-selected", box.checked);
          syncAll();
          notify();
        });
        td.append(box);
      }
      for (const col of opts.columns) {
        const td = tr.insertCell();
        td.textContent = cellText(col, row, opts.locale);
        const align = col.align ?? defaultAlign(col.format);
        if (align === "right") td.classList.add("num");
        else if (align === "center") td.style.textAlign = "center";
        const tip = col.title?.(row);
        if (tip) td.title = tip;
      }
      if (opts.onRowClick) {
        tr.classList.add("is-clickable");
        tr.tabIndex = 0;
        tr.addEventListener("click", () => opts.onRowClick!(row, i));
        tr.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            opts.onRowClick!(row, i);
          }
        });
      }
    });
    syncAll();
  };
  build();

  return {
    element: wrap,
    table,
    selected,
    setRows<T>(next: readonly T[]) {
      rows = next as unknown as readonly R[];
      build();
    },
  };
}
