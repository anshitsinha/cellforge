/**
 * Data validation in the app: checking what's typed, the dropdown list on
 * list cells, tick boxes, the input message under the selected cell,
 * circling invalid cells, and the dialog to set a rule.
 */
import type { Action } from "@cellforge/actions";
import { formatValue, parseDateLoose } from "@cellforge/core";
import { columnLetter, type CellRange, type CellRef } from "@cellforge/grid";
import { parseRanges, rangesToText } from "./cfmanager";
import type { EditableSource } from "./editable";
import { allowed, describeDv, errorText, listChoices, typedValue, type DvContext, type DvKind, type DvOp, type DvRule } from "./validation";
import type { Workbook } from "./workbook";
import "./analysis.css";
import { openDialog } from "./ui/dialog";
import { toast } from "./ui/toast";

export interface DvDeps {
  workbook: () => Workbook;
  source: () => EditableSource;
  range: () => CellRange;
  selection: () => CellRef;
  run: (a: Action) => Promise<unknown>;
  focusGrid: () => void;
}

/** The context rules need: list ranges (maybe on other sheets) and formulas. */
export function dvContext(workbook: Workbook, source: EditableSource): DvContext {
  return {
    listValues(ref) {
      const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(.+)$/.exec(ref.trim());
      if (!m) return [];
      const sheetName = (m[1] ?? m[2])?.replace(/''/g, "'");
      const sheet = sheetName ? workbook.byName(sheetName)?.source : source;
      if (!sheet) return [];
      let ranges: CellRange[];
      try {
        ranges = parseRanges(m[3], sheet.rowCount, sheet.colCount);
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const r of ranges) {
        const bottom = Math.min(r.bottom, sheet.usedRange().rows - 1, r.top + 9_999);
        for (let row = r.top; row <= bottom; row++) {
          for (let col = r.left; col <= r.right; col++) {
            const v = sheet.getCell(row, col);
            if (v !== null && v !== "") out.push(typeof v === "number" ? sheet.formatValue(v, sheet.getStyle(row, col)).text : String(v));
          }
        }
      }
      return out;
    },
    evalAt: (ast, row, col) => source.evalAt(ast, row, col),
  };
}

const dateText = (n: number) => formatValue(n, "yyyy-mm-dd").text;

/** Cells whose typed input breaks their rule, with the rule. */
export function invalidInputs(source: EditableSource, ctx: DvContext, cells: { row: number; col: number; input: string | null }[]): { row: number; col: number; rule: DvRule }[] {
  if (!source.validations.length) return [];
  const out: { row: number; col: number; rule: DvRule }[] = [];
  for (const c of cells) {
    const rule = source.validationAt(c.row, c.col);
    if (!rule) continue;
    // formulas are checked by their result after they're in, as Excel does: skip here
    if (c.input?.trim().startsWith("=")) continue;
    if (!allowed(rule, typedValue(c.input), c.row, c.col, ctx)) out.push({ row: c.row, col: c.col, rule });
  }
  return out;
}

/** Cells in the used range whose current value breaks their rule. */
export function invalidCells(source: EditableSource, ctx: DvContext, limit = 10_000): CellRange[] {
  const out: CellRange[] = [];
  const { rows, cols } = source.usedRange();
  for (const rule of source.validations) {
    for (const r of rule.ranges) {
      for (let row = r.top; row <= Math.min(r.bottom, rows - 1); row++) {
        for (let col = r.left; col <= Math.min(r.right, cols - 1); col++) {
          if (source.validationAt(row, col) !== rule) continue;
          const v = source.getCell(row, col);
          const value = v === "TRUE" ? true : v === "FALSE" ? false : v;
          if (!allowed(rule, value, row, col, ctx)) {
            out.push({ top: row, left: col, bottom: row, right: col });
            if (out.length >= limit) return out;
          }
        }
      }
    }
  }
  return out;
}

/** Ask what to do about a value that breaks a rule: true = keep it. */
export function askAboutInvalid(rule: DvRule): Promise<boolean> {
  const { title, message } = errorText(rule, dateText);
  const style = rule.errorStyle ?? "stop";
  const actions =
    style === "stop"
      ? [{ label: "Change it", id: "no", kind: "primary" as const }]
      : style === "warning"
        ? [
            { label: "No, change it", id: "no" },
            { label: "Yes, keep it", id: "keep", kind: "primary" as const },
          ]
        : [
            { label: "Cancel", id: "no" },
            { label: "OK", id: "keep", kind: "primary" as const },
          ];
  const dlg = openDialog({
    title,
    size: "sm",
    role: "alertdialog",
    body: [message + (style === "warning" ? " Keep it anyway?" : "")],
    actions,
    initialFocus: "primary",
  });
  return dlg.closed.then((r) => r === "keep");
}

let openList: HTMLElement | null = null;

export function closeDropdown(): void {
  openList?.remove();
  openList = null;
}

/** A month calendar under a date cell; picks a date as yyyy-mm-dd. */
function openCalendar(current: unknown, rule: DvRule, x: number, y: number, choose: (value: string) => void, focusGrid: () => void): void {
  const today = new Date();
  const start = typeof current === "number" ? new Date(Date.UTC(1899, 11, 30) + Math.floor(current) * 86_400_000) : new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  let picked = Date.UTC(year, month, start.getUTCDate());
  const serial = (t: number) => Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const box = document.createElement("div");
  box.className = "dv-list dv-cal";
  box.tabIndex = -1;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Pick a date");
  const render = () => {
    box.replaceChildren();
    const head = document.createElement("div");
    head.className = "dv-cal-head";
    const prev = Object.assign(document.createElement("button"), { type: "button", textContent: "‹", title: "Previous month" });
    const next = Object.assign(document.createElement("button"), { type: "button", textContent: "›", title: "Next month" });
    const label = Object.assign(document.createElement("span"), { textContent: new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" }) });
    prev.addEventListener("mousedown", (e) => { e.preventDefault(); month--; if (month < 0) { month = 11; year--; } render(); });
    next.addEventListener("mousedown", (e) => { e.preventDefault(); month++; if (month > 11) { month = 0; year++; } render(); });
    head.append(prev, label, next);
    const grid = document.createElement("div");
    grid.className = "dv-cal-grid";
    for (const d of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) grid.append(Object.assign(document.createElement("span"), { className: "dv-cal-dow", textContent: d }));
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    for (let i = 0; i < (first + 6) % 7; i++) grid.append(document.createElement("span"));
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      const t = Date.UTC(year, month, day);
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: String(day) });
      const ok = allowed(rule, serial(t), 0, 0, { listValues: () => [], evalAt: () => true });
      if (!ok) b.disabled = true;
      if (t === picked) b.setAttribute("aria-selected", "true");
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        closeDropdown();
        choose(iso(t));
      });
      grid.append(b);
    }
    box.append(head, grid);
  };
  box.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step) {
      picked += step * 86_400_000;
      const d = new Date(picked);
      year = d.getUTCFullYear();
      month = d.getUTCMonth();
      render();
    } else if (e.key === "Enter") {
      closeDropdown();
      choose(iso(picked));
    } else if (e.key === "Escape") {
      closeDropdown();
      focusGrid();
    } else return;
    e.preventDefault();
  });
  box.addEventListener("blur", () => setTimeout(() => { if (!box.contains(document.activeElement)) closeDropdown(); }, 100));
  render();
  document.body.append(box);
  box.style.left = `${Math.max(4, Math.min(x, innerWidth - box.offsetWidth - 4))}px`;
  box.style.top = `${Math.min(y, innerHeight - box.offsetHeight - 4)}px`;
  openList = box;
  box.focus();
}

/** The list of choices under a list cell (or a calendar under a date cell). */
export function openDropdown(source: EditableSource, ctx: DvContext, cell: CellRef, x: number, y: number, choose: (value: string) => void, focusGrid: () => void): void {
  closeDropdown();
  const rule = source.validationAt(cell.row, cell.col);
  if (rule?.kind === "date") return openCalendar(source.getCell(cell.row, cell.col), rule, x, y, choose, focusGrid);
  if (!rule || rule.kind !== "list") return;
  const choices = listChoices(rule, ctx);
  const list = document.createElement("div");
  list.className = "dv-list";
  list.setAttribute("role", "listbox");
  const current = String(source.getCell(cell.row, cell.col) ?? "");
  let at = Math.max(0, choices.findIndex((c) => c.toLowerCase() === current.toLowerCase()));
  const items = choices.map((c, i) => {
    const item = document.createElement("div");
    item.className = "dv-item";
    item.setAttribute("role", "option");
    item.textContent = c;
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeDropdown();
      choose(c);
    });
    item.addEventListener("mousemove", () => mark(i));
    list.append(item);
    return item;
  });
  if (!choices.length) list.append(Object.assign(document.createElement("div"), { className: "hp-muted", textContent: "No choices (the list or its range is empty)." }));
  const mark = (i: number) => {
    items[at]?.removeAttribute("aria-selected");
    at = i;
    items[at]?.setAttribute("aria-selected", "true");
    items[at]?.scrollIntoView({ block: "nearest" });
  };
  list.tabIndex = -1;
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") mark(Math.min(items.length - 1, at + 1));
    else if (e.key === "ArrowUp") mark(Math.max(0, at - 1));
    else if (e.key === "Enter" && items[at]) {
      closeDropdown();
      choose(choices[at]);
    } else if (e.key === "Escape") {
      closeDropdown();
      focusGrid();
    } else return;
    e.preventDefault();
  });
  list.addEventListener("blur", () => setTimeout(closeDropdown, 100));
  document.body.append(list);
  list.style.left = `${Math.max(4, Math.min(x, innerWidth - list.offsetWidth - 4))}px`;
  list.style.top = `${Math.min(y, innerHeight - list.offsetHeight - 4)}px`;
  openList = list;
  mark(at);
  list.focus();
}

let tip: HTMLElement | null = null;

/** The input message for the selected cell, shown under it (or hidden). */
export function showInputMessage(rule: DvRule | null, x: number, y: number): void {
  if (!rule || (!rule.inputMessage && !rule.inputTitle)) {
    tip?.remove();
    tip = null;
    return;
  }
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "dv-tip";
    tip.setAttribute("role", "note");
    document.body.append(tip);
  }
  tip.replaceChildren();
  if (rule.inputTitle) tip.append(Object.assign(document.createElement("strong"), { textContent: rule.inputTitle }));
  if (rule.inputMessage) tip.append(Object.assign(document.createElement("div"), { textContent: rule.inputMessage }));
  tip.style.left = `${Math.min(x, innerWidth - 260)}px`;
  tip.style.top = `${Math.min(y + 4, innerHeight - 80)}px`;
}

const KINDS: [DvKind, string][] = [
  ["list", "List of choices (dropdown)"],
  ["whole", "Whole number"],
  ["decimal", "Number"],
  ["date", "Date"],
  ["textLength", "Text length"],
  ["custom", "Custom formula"],
  ["checkbox", "Tick boxes (TRUE / FALSE)"],
];
const OPS: [DvOp, string][] = [
  ["between", "between"],
  ["notBetween", "not between"],
  ["=", "equal to"],
  ["!=", "not equal to"],
  [">", "greater than"],
  ["<", "less than"],
  [">=", "greater than or equal to"],
  ["<=", "less than or equal to"],
];

/** The dialog to set validation on the selection. */
export function openValidationDialog(d: DvDeps): void {
  const src = d.source();
  const sel = d.range();
  const existing = src.validationAt(sel.top, sel.left);
  const body = document.createElement("div");
  body.className = "an-stack an-stack--loose dv-dialog";
  const field = (label: string, el: HTMLElement, hint?: string) => {
    const l = document.createElement("label");
    l.className = "an-field";
    const cap = document.createElement("span");
    cap.textContent = label;
    l.append(cap, el);
    if (hint) l.append(Object.assign(document.createElement("small"), { className: "an-hint", textContent: hint }));
    return l;
  };
  const row = (...kids: HTMLElement[]) => {
    const r = document.createElement("div");
    r.className = "an-row";
    r.append(...kids);
    return r;
  };
  const section = (title: string, ...kids: HTMLElement[]) => {
    const s = document.createElement("section");
    s.className = "an-section";
    const head = document.createElement("div");
    head.className = "an-section__head";
    head.append(Object.assign(document.createElement("h3"), { className: "an-section__title", textContent: title }));
    s.append(head, ...kids);
    body.append(s);
    return s;
  };
  const input = (value: string, label: string) => Object.assign(document.createElement("input"), { value, ariaLabel: label });
  const select = (opts: [string, string][], value: string, label: string) => {
    const s = document.createElement("select");
    s.setAttribute("aria-label", label);
    for (const [v, t] of opts) s.append(new Option(t, v, false, v === value));
    return s;
  };
  const applies = input(rangesToText([sel]), "Applies to");
  const kind = select(KINDS, existing?.kind ?? "list", "Allow");
  const op = select(OPS, existing?.op ?? "between", "Comparison");
  const fmtIn = (n: number | undefined) => (n === undefined ? "" : kind.value === "date" ? dateText(n) : String(n));
  const a = input(fmtIn(existing?.a), "Minimum or value");
  const b = input(fmtIn(existing?.b), "Maximum");
  const list = input(existing?.source ? `=${existing.source}` : (existing?.list ?? []).join(", "), "Choices");
  list.placeholder = "Approved, Rejected, On hold";
  const formula = input(existing?.formula ?? "=", "Formula");
  formula.className = "an-mono";
  const blank = Object.assign(document.createElement("input"), { type: "checkbox", checked: existing?.allowBlank !== false });
  const title = input(existing?.inputTitle ?? "", "Input title");
  title.placeholder = "e.g. Approval status";
  const msg = input(existing?.inputMessage ?? "", "Input message");
  msg.placeholder = "e.g. Pick one from the list";
  const style = select([["stop", "Stop: don't allow it"], ["warning", "Warning: ask first"], ["info", "Note: allow it and say so"]], existing?.errorStyle ?? "stop", "When a value breaks the rule");
  const errMsg = input(existing?.errorMessage ?? "", "Error message");
  errMsg.placeholder = "Shown instead of the standard message";

  section("The rule", row(field("Cells", applies), field("Allow", kind)));
  const opRow = field("Value is", op);
  const aRow = field("Value", a);
  const bRow = field("and", b);
  const cmpRow = row(opRow, aRow, bRow);
  const listRow = field("Choices", list, "Separate them with commas, or point at a range like =Lists!$A$2:$A$20.");
  const fRow = field("Formula that must be TRUE", formula, "Written for the first cell; it moves for the others like a copied formula.");
  const bl = document.createElement("label");
  bl.className = "an-check";
  bl.append(blank, Object.assign(document.createElement("span"), { textContent: "Blank cells are allowed" }));
  body.lastElementChild!.append(cmpRow, listRow, fRow, bl);
  section("When the cell is selected", row(field("Title", title), field("Message", msg)));
  section("When a value breaks the rule", row(field("Then", style), field("Message (optional)", errMsg)));

  const sync = () => {
    const k = kind.value as DvKind;
    const cmp = ["whole", "decimal", "date", "textLength"].includes(k);
    cmpRow.hidden = !cmp;
    bRow.hidden = !cmp || !(op.value === "between" || op.value === "notBetween");
    aRow.querySelector("span")!.textContent = bRow.hidden ? "Value" : "From";
    listRow.hidden = k !== "list";
    fRow.hidden = k !== "custom";
    a.placeholder = k === "date" ? "2026-01-31" : "0";
    b.placeholder = k === "date" ? "2026-12-31" : "100";
  };
  kind.addEventListener("change", sync);
  op.addEventListener("change", sync);
  sync();

  openDialog({
    title: "Data validation",
    subtitle: "Limit what can be typed into the selected cells: a dropdown list, a range of numbers or dates",
    size: "md",
    body,
    initialFocus: kind,
    actions: [
      {
        label: "Clear validation",
        start: true,
        kind: "ghost",
        title: "Remove the rules from these cells",
        onClick: async () => {
          const ranges = parseRanges(applies.value, src.rowCount, src.colCount);
          for (const range of ranges) await d.run({ type: "validation.clear", params: { range } });
          toast({ text: "Validation cleared. Ctrl+Z brings it back." });
        },
      },
      { label: "Cancel", dismiss: true },
      {
        label: "Save rule",
        kind: "primary",
        onClick: () => {
          const k = kind.value as DvKind;
          const ranges = parseRanges(applies.value, src.rowCount, src.colCount);
          const num = (t: string) => {
            if (t.trim() === "") return undefined;
            const n = k === "date" ? parseDateLoose(t) : Number(t);
            if (n === null || Number.isNaN(n)) throw new Error(k === "date" ? `"${t}" isn't a date.` : `"${t}" isn't a number.`);
            return n;
          };
          const rule: Omit<DvRule, "id"> = { kind: k, ranges, ...(blank.checked ? {} : { allowBlank: false }) };
          if (["whole", "decimal", "date", "textLength"].includes(k)) Object.assign(rule, { op: op.value, a: num(a.value), ...(bRow.hidden ? {} : { b: num(b.value) }) });
          if (k === "list") {
            const t = list.value.trim();
            if (!t) throw new Error("Type the choices, or point at a range.");
            if (t.startsWith("=")) rule.source = t.slice(1);
            else rule.list = t.split(",").map((x) => x.trim()).filter(Boolean);
          }
          if (k === "custom") rule.formula = formula.value;
          if (title.value.trim()) rule.inputTitle = title.value.trim();
          if (msg.value.trim()) rule.inputMessage = msg.value.trim();
          if (style.value !== "stop") rule.errorStyle = style.value as "warning";
          if (errMsg.value.trim()) rule.errorMessage = errMsg.value.trim();
          void d.run({ type: "validation.add", params: { rule } });
        },
      },
    ],
    onClose: () => d.focusGrid(),
  });
}

/** A one-line description for the status bar ("B2:B20 takes a whole number between 1 and 10"). */
export function describeCellRule(rule: DvRule): string {
  const where = rule.ranges.map((r) => `${columnLetter(r.left)}${r.top + 1}${r.top !== r.bottom || r.left !== r.right ? `:${columnLetter(r.right)}${r.bottom + 1}` : ""}`).join(", ");
  return `${where} takes ${describeDv(rule, dateText)}`;
}
