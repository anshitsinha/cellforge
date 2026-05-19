/**
 * The filter dropdown for one column: sort buttons, a condition (text,
 * number or date rule), and the list of values with counts, (Blanks)
 * first, a search box, select all and invert.
 */
import type { Action } from "@cellforge/actions";
import { parseDateLoose } from "@cellforge/core";
import type { EditableSource } from "./editable";
import { distinctValues, filteredOutRows, type FilterCondition, type FilterSpec } from "./filter";

export interface FilterMenuDeps {
  source: () => EditableSource;
  run: (a: Action) => Promise<unknown>;
  focusGrid: () => void;
}

const RULES: { value: string; label: string; kind: "text" | "number" | "date"; two?: boolean; none?: boolean }[] = [
  { value: "text:contains", label: "Text contains", kind: "text" },
  { value: "text:notContains", label: "Text doesn't contain", kind: "text" },
  { value: "text:begins", label: "Text begins with", kind: "text" },
  { value: "text:ends", label: "Text ends with", kind: "text" },
  { value: "text:equals", label: "Text is exactly", kind: "text" },
  { value: "number:>", label: "Greater than", kind: "number" },
  { value: "number:>=", label: "Greater than or equal to", kind: "number" },
  { value: "number:<", label: "Less than", kind: "number" },
  { value: "number:<=", label: "Less than or equal to", kind: "number" },
  { value: "number:=", label: "Equal to", kind: "number" },
  { value: "number:!=", label: "Not equal to", kind: "number" },
  { value: "number:between", label: "Between", kind: "number", two: true },
  { value: "number:top", label: "Top N", kind: "number" },
  { value: "number:bottom", label: "Bottom N", kind: "number" },
  { value: "number:aboveAverage", label: "Above average", kind: "number", none: true },
  { value: "number:belowAverage", label: "Below average", kind: "number", none: true },
  { value: "date:before", label: "Date is before", kind: "date" },
  { value: "date:after", label: "Date is after", kind: "date" },
  { value: "date:on", label: "Date is on", kind: "date" },
  { value: "date:between", label: "Date is between", kind: "date", two: true },
];

let open: HTMLElement | null = null;

export function closeFilterMenu(): void {
  open?.remove();
  open = null;
}

export function openFilterMenu(d: FilterMenuDeps, col: number, x: number, y: number): void {
  closeFilterMenu();
  const src = d.source();
  const spec = src.filter;
  const headerRow = spec?.headerRow ?? (src.getColumnName(0) !== undefined ? -1 : 0);
  const current = spec?.conditions.find((c) => c.col === col)?.cond ?? null;

  // the values the other columns' filters leave showing
  const others: FilterSpec = { headerRow, conditions: (spec?.conditions ?? []).filter((c) => c.col !== col) };
  const hiddenByOthers = new Set(filteredOutRows(src, others));
  const style = src.getStyle(headerRow + 1, col);
  const { values, truncated } = distinctValues(src, col, headerRow, (v) => src.formatValue(v, style).text || String(v), (r) => !hiddenByOthers.has(r));
  const checked = new Set(current?.kind === "values" ? current.keys : values.map((v) => v.key));

  const menu = document.createElement("div");
  menu.className = "filter-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Filter");
  const run = (a: Action) => {
    closeFilterMenu();
    void d.run(a).then(() => d.focusGrid());
  };

  // sort
  const sortRow = document.createElement("div");
  sortRow.className = "filter-sort";
  for (const [label, descending] of [
    ["Sort A → Z", false],
    ["Sort Z → A", true],
  ] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => run({ type: "rows.sortBy", params: { keys: [{ col, descending }], hasHeader: headerRow === 0 } }));
    sortRow.append(b);
  }
  menu.append(sortRow);

  // condition
  const condWrap = document.createElement("div");
  condWrap.className = "filter-cond";
  const rule = document.createElement("select");
  rule.setAttribute("aria-label", "Filter by condition");
  rule.append(new Option("Filter by condition: none", ""));
  for (const r of RULES) rule.append(new Option(r.label, r.value));
  const a = document.createElement("input");
  const b = document.createElement("input");
  a.placeholder = "value";
  b.placeholder = "and";
  a.setAttribute("aria-label", "Value");
  b.setAttribute("aria-label", "Second value");
  condWrap.append(rule, a, b);
  menu.append(condWrap);
  const showInputs = () => {
    const r = RULES.find((x) => x.value === rule.value);
    a.hidden = !r || !!r.none;
    b.hidden = !r?.two;
    list.classList.toggle("filter-disabled", !!r);
  };
  if (current && current.kind !== "values" && current.kind !== "blanks") {
    rule.value = `${current.kind}:${current.op}`;
    if (current.kind === "text") a.value = current.value;
    else {
      a.value = current.a !== undefined ? String(current.a) : "";
      b.value = current.b !== undefined ? String(current.b) : "";
    }
  }

  // values
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search values";
  search.setAttribute("aria-label", "Search values");
  const tools = document.createElement("div");
  tools.className = "filter-tools";
  const all = document.createElement("button");
  all.type = "button";
  all.textContent = "Select all";
  const none = document.createElement("button");
  none.type = "button";
  none.textContent = "Clear";
  const invert = document.createElement("button");
  invert.type = "button";
  invert.textContent = "Invert";
  tools.append(all, none, invert);
  const list = document.createElement("div");
  list.className = "filter-list";
  menu.append(search, tools, list);

  const render = () => {
    const q = search.value.trim().toLowerCase();
    list.replaceChildren();
    for (const v of values) {
      if (q && !v.label.toLowerCase().includes(q)) continue;
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = checked.has(v.key);
      box.addEventListener("change", () => {
        if (box.checked) checked.add(v.key);
        else checked.delete(v.key);
      });
      const text = document.createElement("span");
      text.textContent = v.label;
      const count = document.createElement("span");
      count.className = "filter-count";
      count.textContent = v.count.toLocaleString();
      label.append(box, text, count);
      list.append(label);
    }
    if (truncated) {
      const note = document.createElement("p");
      note.className = "hp-muted";
      note.textContent = "Showing the first 10,000 different values; search to find others.";
      list.append(note);
    }
  };
  const shown = () => {
    const q = search.value.trim().toLowerCase();
    return values.filter((v) => !q || v.label.toLowerCase().includes(q));
  };
  all.addEventListener("click", () => {
    for (const v of shown()) checked.add(v.key);
    render();
  });
  none.addEventListener("click", () => {
    for (const v of shown()) checked.delete(v.key);
    render();
  });
  invert.addEventListener("click", () => {
    for (const v of shown()) {
      if (checked.has(v.key)) checked.delete(v.key);
      else checked.add(v.key);
    }
    render();
  });
  search.addEventListener("input", render);
  rule.addEventListener("change", showInputs);

  // buttons
  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear filter";
  clear.disabled = !current;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.textContent = "OK";
  actions.append(clear, cancel, ok);
  menu.append(actions);
  const error = document.createElement("p");
  error.className = "cleanup-warn";
  error.hidden = true;
  menu.append(error);

  clear.addEventListener("click", () => run({ type: "filter.set", params: { col, condition: null, headerRow } }));
  cancel.addEventListener("click", () => {
    closeFilterMenu();
    d.focusGrid();
  });
  ok.addEventListener("click", () => {
    let condition: FilterCondition | null = null;
    const r = RULES.find((x) => x.value === rule.value);
    if (r) {
      const op = r.value.split(":")[1];
      if (r.kind === "text") condition = { kind: "text", op: op as "contains", value: a.value };
      else if (r.kind === "number") {
        const na = Number(a.value);
        const nb = Number(b.value);
        if (!r.none && (a.value.trim() === "" || Number.isNaN(na) || (r.two && Number.isNaN(nb)))) {
          error.textContent = "Type a number.";
          error.hidden = false;
          return;
        }
        condition = { kind: "number", op: op as ">", ...(r.none ? {} : { a: na }), ...(r.two ? { b: nb } : {}) };
      } else {
        const da = parseDateLoose(a.value);
        const db = r.two ? parseDateLoose(b.value) : null;
        if (da === null || (r.two && db === null)) {
          error.textContent = "Type a date, like 2024-03-31.";
          error.hidden = false;
          return;
        }
        condition = { kind: "date", op: op as "before", a: da, ...(db !== null ? { b: db } : {}) };
      }
    } else if (checked.size < values.length || values.some((v) => !checked.has(v.key))) {
      condition = { kind: "values", keys: values.filter((v) => checked.has(v.key)).map((v) => v.key) };
    }
    if (!condition && !current) {
      closeFilterMenu();
      d.focusGrid();
      return;
    }
    run({ type: "filter.set", params: { col, condition, headerRow } });
  });
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeFilterMenu();
      d.focusGrid();
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") ok.click();
  });

  render();
  showInputs();
  document.body.append(menu);
  // keep it on screen
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - h - 4))}px`;
  open = menu;
  setTimeout(() => {
    const away = (e: PointerEvent) => {
      if (!open || open !== menu) return document.removeEventListener("pointerdown", away, true);
      if (!menu.contains(e.target as Node)) {
        closeFilterMenu();
        document.removeEventListener("pointerdown", away, true);
      }
    };
    document.addEventListener("pointerdown", away, true);
  });
  search.focus();
}
