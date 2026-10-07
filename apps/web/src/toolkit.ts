/**
 * Shared pieces for the reconciliation, audit, evidence and review tools,
 * built on the UI kit (ui/): a small element helper, steps, tabs, summary
 * tiles, empty states, inline notices, a dialog whose footer buttons can be
 * added as the tool goes, sheet samples for column guessing, and the
 * "go to this row" link back to the grid.
 */
import "./toolkit.css";
import { openDialog, type ButtonKind, type DialogHandle, type DialogSize } from "./ui/dialog";
import { icon, type IconName } from "./ui/icons";
import { toast, type ToastKind } from "./ui/toast";
import type { ColumnSample } from "./colguess";
import type { EditableSource } from "./editable";

// ------------------------------------------------------------- elements --

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style">>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}

export function button(label: string, onClick: () => unknown, kind: ButtonKind | "plain" = "secondary", iconName?: IconName): HTMLButtonElement {
  const b = el("button", { type: "button", className: kind === "plain" ? "" : `btn-${kind}` });
  if (iconName) b.append(icon(iconName));
  b.append(label);
  b.addEventListener("click", () => void onClick());
  return b;
}

/** A labelled control with an optional hint under it. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const l = el("label", { className: "tk-field" }, el("span", { className: "tk-field__label", textContent: label }), control);
  if (hint) l.append(el("small", { className: "tk-field__hint", textContent: hint }));
  return l;
}

export function section(title: string | null, ...kids: Array<Node | string | null | false>): HTMLElement {
  const s = el("section", { className: "cf-section" });
  if (title) s.append(el("h3", { className: "cf-section__title", textContent: title }));
  for (const k of kids) if (k) s.append(k);
  return s;
}

/** A coloured inline message (errors and warnings stay next to what caused them). */
export function notice(text: string | Node, tone: "info" | "warning" | "danger" | "success" = "info"): HTMLElement {
  const n = el("div", { className: `tk-notice tk-notice--${tone}` });
  n.setAttribute("role", tone === "danger" ? "alert" : "status");
  n.append(icon(tone === "danger" ? "error" : tone === "warning" ? "warning" : tone === "success" ? "success" : "info"), el("div", {}, text));
  return n;
}

/** An empty state: what the tool does and the first thing to do. */
export function emptyState(opts: { icon?: IconName; title: string; text: string; action?: HTMLElement }): HTMLElement {
  const e = el("div", { className: "cf-empty tk-empty" });
  e.append(icon(opts.icon ?? "info", { size: 28 }), el("strong", { className: "tk-empty__title", textContent: opts.title }), el("p", { textContent: opts.text }));
  if (opts.action) e.append(opts.action);
  return e;
}

export interface Tile {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "match" | "unmatched" | "mismatch" | "accent";
  onClick?: () => void;
}

/** A row of summary figures ("Matched 1,184 · 99.5%"). */
export function tiles(list: readonly Tile[]): HTMLElement {
  const row = el("div", { className: "tk-tiles" });
  for (const t of list) {
    const box = el(t.onClick ? "button" : "div", { className: `tk-tile tk-tile--${t.tone ?? "neutral"}` });
    if (box instanceof HTMLButtonElement) {
      box.type = "button";
      box.addEventListener("click", t.onClick!);
    }
    box.append(el("span", { className: "tk-tile__label", textContent: t.label }), el("span", { className: "tk-tile__value", textContent: t.value }));
    if (t.sub) box.append(el("span", { className: "tk-tile__sub", textContent: t.sub }));
    row.append(box);
  }
  return row;
}

/** Numbered steps across the top of a multi-step tool. */
export function steps(labels: readonly string[], current: number, onPick?: (i: number) => void): HTMLElement {
  const ol = el("ol", { className: "tk-steps" });
  ol.setAttribute("aria-label", "Steps");
  labels.forEach((label, i) => {
    const state = i < current ? "done" : i === current ? "current" : "todo";
    const li = el("li", { className: `tk-step tk-step--${state}` });
    const inner = onPick && i < current ? el("button", { type: "button", className: "tk-step__btn" }) : el("span", { className: "tk-step__btn" });
    if (inner instanceof HTMLButtonElement) inner.addEventListener("click", () => onPick!(i));
    inner.append(el("span", { className: "tk-step__num", textContent: i < current ? "✓" : String(i + 1) }), el("span", { textContent: label }));
    if (i === current) li.setAttribute("aria-current", "step");
    li.append(inner);
    ol.append(li);
  });
  return ol;
}

export interface TabSpec {
  id: string;
  label: string;
  count?: number;
  tone?: Tile["tone"];
  render: () => Node;
}

/** Tabs (arrow keys move between them). */
export function tabs(list: readonly TabSpec[], initial?: string, onChange?: (id: string) => void): { element: HTMLElement; select(id: string): void } {
  const wrap = el("div", { className: "tk-tabs" });
  const bar = el("div", { className: "tk-tabs__bar" });
  bar.setAttribute("role", "tablist");
  const panel = el("div", { className: "tk-tabs__panel" });
  panel.setAttribute("role", "tabpanel");
  const btns = list.map((t) => {
    const b = el("button", { type: "button", className: "tk-tab", id: `tk-tab-${t.id}-${Math.random().toString(36).slice(2, 7)}` });
    b.setAttribute("role", "tab");
    b.append(t.label);
    if (t.count !== undefined) b.append(el("span", { className: `cf-badge tk-tab__count${t.tone && t.count ? ` tk-tab__count--${t.tone}` : ""}`, textContent: t.count.toLocaleString() }));
    b.addEventListener("click", () => select(t.id));
    bar.append(b);
    return b;
  });
  bar.addEventListener("keydown", (e) => {
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" ? (i + 1) % btns.length : e.key === "ArrowLeft" ? (i - 1 + btns.length) % btns.length : -1;
    if (next < 0) return;
    e.preventDefault();
    btns[next].focus();
    select(list[next].id);
  });
  const select = (id: string) => {
    const i = Math.max(0, list.findIndex((t) => t.id === id));
    btns.forEach((b, j) => {
      b.setAttribute("aria-selected", String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", btns[i].id);
    panel.replaceChildren(list[i].render());
    onChange?.(list[i].id);
  };
  wrap.append(bar, panel);
  if (list.length) select(initial ?? list[0].id);
  return { element: wrap, select };
}

// --------------------------------------------------------------- dialog --

export interface ToolDialog {
  handle: DialogHandle;
  body: HTMLElement;
  /** add a footer button; the primary one goes far right */
  button(label: string, act: () => unknown, opts?: { kind?: ButtonKind; disabled?: boolean; start?: boolean; title?: string }): HTMLButtonElement;
  close(): void;
}

/**
 * A dialog for a tool whose buttons are added as it builds (openDialog wants
 * them up front). Cancel/Close is added first; primary buttons stay last.
 */
export function toolDialog(opts: { title: string; subtitle?: string; size?: DialogSize; closeLabel?: string; onClose?: () => void; className?: string }): ToolDialog {
  const handle = openDialog({
    title: opts.title,
    subtitle: opts.subtitle,
    size: opts.size ?? "lg",
    className: opts.className,
    actions: [{ label: opts.closeLabel ?? "Close", dismiss: true }],
    onClose: () => opts.onClose?.(),
  });
  const footer = handle.footer;
  const start = footer.querySelector<HTMLElement>(".cf-dialog__footer-start")!;
  return {
    handle,
    body: handle.body,
    button(label, act, o = {}) {
      const b = el("button", { type: "button", className: `btn-${o.kind ?? "secondary"}`, textContent: label, disabled: !!o.disabled });
      if (o.title) b.title = o.title;
      b.addEventListener("click", async () => {
        handle.setError(null);
        try {
          await act();
        } catch (e) {
          handle.setError(e instanceof Error ? e.message : String(e));
        }
      });
      if (o.start) start.append(b);
      else if (o.kind === "primary" || o.kind === "danger") footer.append(b);
      else {
        const loud = footer.querySelector(":scope > .btn-primary, :scope > .btn-danger");
        footer.insertBefore(b, loud);
      }
      return b;
    },
    close: () => handle.close(),
  };
}

// --------------------------------------------------------------- report --

/**
 * Tell the user. The shell's status callback already turns messages into
 * toasts (messages.ts), so it is used when given; a toast is shown directly
 * only without one, or when the message has an action.
 */
export function report(status: ((t: string) => void) | undefined, text: string, kind: ToastKind = "success", action?: { label: string; run: () => void }): void {
  if (status && !action) status(text);
  else toast({ kind, text, ...(action ? { action } : {}) });
}

// ------------------------------------------------------------ the sheet --

/** Samples of a sheet's columns for colguess (names without "A: " prefixes). */
export function sheetSamples(src: EditableSource, names: readonly string[], first: number, max = 300): ColumnSample[] {
  const { rows } = src.usedRange();
  const last = Math.min(rows, first + max);
  return names.map((name, c) => {
    const values: unknown[] = [];
    for (let r = first; r < last; r++) values.push(src.getCell(r, c));
    return { name: name.replace(/^[A-Z]+: /, "").replace(/^Column [A-Z]+$/, ""), values, numFmt: src.getStyle(first, c)?.numFmt ?? "" };
  });
}

// ------------------------------------------------------------ go to row --

export interface Navigator {
  goTo: (sheetId: string, row: number, col: number) => void;
  activeSheet?: () => string;
}

let nav: Navigator | null = null;

/**
 * The shell registers how to show a cell (switch sheet, select, focus the
 * grid) once; result rows in the tools then become links to the sheet.
 */
export function registerNavigator(n: Navigator | null): void {
  nav = n;
}

/** A goTo for a tool: the one it was given, else the registered one, else null. */
export function navigator(given?: Navigator["goTo"]): Navigator["goTo"] | null {
  return given ?? nav?.goTo ?? null;
}

/** The registered active-sheet reader (for tools that only know "this sheet"). */
export function activeSheetId(given?: () => string): string | null {
  return (given ?? nav?.activeSheet)?.() ?? null;
}

// ------------------------------------------------------------- headline --

export interface HeadlineOptions {
  /** the big figure, e.g. "95.7" */
  value: string;
  /** small text after it, e.g. "% matched" */
  unit?: string;
  /** 0..1: a bar under the title */
  progress?: number;
  tone?: "match" | "unmatched" | "mismatch" | "accent";
  /** one plain-English sentence under the figure */
  caption?: string;
  /** label / value lines under it ("Matched lines  121 of 128") */
  lines?: readonly { label: string; value: string; tone?: "match" | "unmatched" | "mismatch"; onClick?: () => void }[];
}

/** The results card: a headline figure, a bar, a sentence, then the key lines. */
export function headline(o: HeadlineOptions): HTMLElement {
  const card = el("div", { className: `tk-headline tk-headline--${o.tone ?? "accent"}` });
  if (o.progress !== undefined) {
    const bar = el("div", { className: "tk-headline__bar" });
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.round(o.progress * 100)));
    const fill = el("span");
    fill.style.width = `${Math.max(0, Math.min(1, o.progress)) * 100}%`;
    bar.append(fill);
    card.append(bar);
  }
  card.append(el("div", { className: "tk-headline__figure" }, el("span", { className: "tk-headline__value", textContent: o.value }), o.unit ? el("span", { className: "tk-headline__unit", textContent: o.unit }) : null));
  if (o.caption) card.append(el("p", { className: "tk-headline__caption", textContent: o.caption }));
  if (o.lines?.length) {
    const dl = el("dl", { className: "tk-kv" });
    for (const l of o.lines) {
      const dt = el("dt", { textContent: l.label });
      const dd = el("dd", { className: l.tone ? `tk-kv--${l.tone}` : "" });
      if (l.onClick) dd.append(el("button", { type: "button", className: "tk-kv__link", textContent: l.value, onclick: l.onClick }));
      else dd.textContent = l.value;
      dl.append(el("div", { className: "tk-kv__row" }, dt, dd));
    }
    card.append(dl);
  }
  return card;
}

/** "1,234" */
export const count = (n: number): string => n.toLocaleString("en-US");
/** "3 rows" / "1 row" */
export const plural = (n: number, one: string, many = `${one}s`): string => `${count(n)} ${n === 1 ? one : many}`;
/** "95.7%" */
export const percent = (x: number, digits = 1): string => `${(Math.round(x * 100 * 10 ** digits) / 10 ** digits).toFixed(digits)}%`;
