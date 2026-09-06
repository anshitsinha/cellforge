/**
 * The one right-hand side panel. It sits beside the grid and the grid
 * shrinks to make room (it never covers the sheet, except on a phone).
 * Only one panel shows at a time: opening another replaces it, and a Back
 * button returns to the one before. Esc or × closes it.
 *
 * The shell mounts the host once, around the grid's container:
 *
 *   mountSidePanelHost(document.getElementById("sheet")!, () => grid.resize?.());
 *
 * (If nobody mounts it, the first openSidePanel() mounts it around #sheet.)
 * Tools then open panels:
 *
 *   openSidePanel({
 *     id: "history",
 *     title: "History",
 *     subtitle: "Every change in this session",
 *     render: (p) => {
 *       p.body.append(list);                       // fill the scrolling body
 *       p.footer.append(saveButton);               // optional fixed footer
 *       return () => stopListening();              // optional clean-up
 *     },
 *     tools: [iconButton("more", "More")],         // optional header buttons
 *   });
 *
 * render() runs again when the user comes Back to a panel, so build from
 * state rather than keeping the old nodes. The clean-up it returns runs
 * whenever the panel leaves (closed, replaced, or left by Back).
 */
import "./ui.css";
import { iconButton } from "./icons";

export interface SidePanelContext {
  readonly id: string;
  /** the scrolling content area */
  readonly body: HTMLElement;
  /** a fixed footer under the body (hidden while empty) */
  readonly footer: HTMLElement;
  setTitle(title: string, subtitle?: string): void;
  close(): void;
}

export interface SidePanelOptions {
  id: string;
  title: string;
  subtitle?: string;
  /** fill the panel; may return a clean-up function */
  render: (panel: SidePanelContext) => void | (() => void);
  /** extra buttons in the header, left of × */
  tools?: readonly HTMLElement[] | (() => readonly HTMLElement[]);
  /** called when the panel is closed (not when replaced) */
  onClose?: () => void;
}

// ------------------------------------------------------------- pure parts --

export const PANEL_MIN = 300;
export const PANEL_MAX = 640;
export const PANEL_DEFAULT = 380;
/** the grid keeps at least this much width */
export const GRID_MIN = 320;

/** The panel width to use, given what's asked and the width of the whole split area. */
export function clampPanelWidth(width: number, available: number): number {
  const most = Math.min(PANEL_MAX, Math.max(PANEL_MIN, available - GRID_MIN));
  return Math.round(Math.min(most, Math.max(PANEL_MIN, Number.isFinite(width) ? width : PANEL_DEFAULT)));
}

/**
 * Which panel is showing and which ones Back returns to. Opening the panel
 * that's already showing refreshes it in place; opening one that's in the
 * history takes it out of the history first (no loops).
 */
export class PanelStack<T extends { id: string }> {
  current: T | null = null;
  history: T[] = [];

  constructor(readonly depth = 8) {}

  open(item: T): { left: T | null } {
    const left = this.current;
    if (left && left.id !== item.id) {
      this.history = this.history.filter((h) => h.id !== item.id && h.id !== left.id);
      this.history.push(left);
      if (this.history.length > this.depth) this.history.shift();
    }
    this.current = item;
    return { left: left && left.id !== item.id ? left : null };
  }

  /** Go back one; returns the panel to show, or null when there is none (close). */
  back(): T | null {
    const prev = this.history.pop() ?? null;
    this.current = prev;
    return prev;
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  close(): T | null {
    const was = this.current;
    this.current = null;
    this.history = [];
    return was;
  }
}

// -------------------------------------------------------------------- DOM --

const WIDTH_KEY = "cellforge.sidepanel.width";
const stack = new PanelStack<SidePanelOptions>();
const listeners = new Set<(id: string | null) => void>();

let host: {
  split: HTMLElement;
  aside: HTMLElement;
  inner: HTMLElement;
  onResize?: () => void;
} | null = null;
let cleanup: (() => void) | void;
let returnFocus: HTMLElement | null = null;
let width = PANEL_DEFAULT;

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v > 0 ? v : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* private mode: just don't remember */
  }
}

function applyWidth(w: number): void {
  if (!host) return;
  width = clampPanelWidth(w, host.split.clientWidth || window.innerWidth);
  host.aside.style.setProperty("--cf-sidepanel-width", `${width}px`);
  const handle = host.aside.querySelector<HTMLElement>(".cf-sidepanel__resize");
  handle?.setAttribute("aria-valuenow", String(width));
}

function resized(): void {
  const cb = host?.onResize;
  if (cb) requestAnimationFrame(() => cb());
}

/**
 * Put the side panel host beside the grid. `gridContainer` is the element
 * the grid draws into (#sheet); it is wrapped, in place, in a flex row with
 * the panel. `onResize` runs after the grid's width changes (open, close,
 * drag), for grids that don't watch their own size. Safe to call twice.
 */
export function mountSidePanelHost(gridContainer: HTMLElement, onResize?: () => void): void {
  if (host) {
    host.onResize = onResize ?? host.onResize;
    return;
  }
  const split = document.createElement("div");
  split.className = "cf-split";
  gridContainer.replaceWith(split);
  split.append(gridContainer);

  const aside = document.createElement("aside");
  aside.className = "cf-sidepanel";
  aside.hidden = true;
  const inner = document.createElement("div");
  inner.className = "cf-sidepanel__inner";

  // left-edge drag handle, also a keyboard separator
  const grip = document.createElement("div");
  grip.className = "cf-sidepanel__resize";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "vertical");
  grip.setAttribute("aria-label", "Resize panel");
  grip.setAttribute("aria-valuemin", String(PANEL_MIN));
  grip.setAttribute("aria-valuemax", String(PANEL_MAX));
  grip.tabIndex = 0;
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    aside.classList.add("is-resizing");
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) => {
      applyWidth(startW + (startX - ev.clientX));
      resized();
    };
    const up = () => {
      aside.classList.remove("is-resizing");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      saveWidth(width);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === "ArrowLeft") applyWidth(width + step);
    else if (e.key === "ArrowRight") applyWidth(width - step);
    else return;
    e.preventDefault();
    saveWidth(width);
    resized();
  });

  aside.append(grip, inner);
  aside.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (e.target instanceof HTMLSelectElement) return;
    e.preventDefault();
    closeSidePanel();
  });
  split.append(aside);
  host = { split, aside, inner, onResize };
  width = readWidth();
  applyWidth(width);
  window.addEventListener("resize", () => {
    if (host && !host.aside.hidden) applyWidth(width);
  });
}

function ensureHost(): NonNullable<typeof host> {
  if (!host) {
    const sheet = document.getElementById("sheet");
    if (!sheet) throw new Error("mountSidePanelHost() first: no #sheet to put the side panel beside");
    mountSidePanelHost(sheet);
  }
  return host!;
}

function show(opts: SidePanelOptions): SidePanelContext {
  const h = ensureHost();
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  h.inner.replaceChildren();
  // restart the slide-in
  h.inner.style.animation = "none";
  void h.inner.offsetWidth;
  h.inner.style.animation = "";

  const header = document.createElement("header");
  header.className = "cf-sidepanel__header";
  if (stack.canGoBack) {
    const prev = stack.history[stack.history.length - 1];
    const back = iconButton("arrow-left", `Back to ${prev.title}`, { onClick: () => sidePanelBack() });
    back.classList.add("cf-sidepanel__back");
    header.append(back);
  }
  const titles = document.createElement("div");
  titles.className = "cf-sidepanel__titles";
  const title = document.createElement("h2");
  title.className = "cf-sidepanel__title";
  title.id = `cf-panel-title-${opts.id}`;
  title.tabIndex = -1;
  const sub = document.createElement("p");
  sub.className = "cf-sidepanel__subtitle";
  titles.append(title, sub);
  const tools = document.createElement("div");
  tools.className = "cf-sidepanel__tools";
  const extra = typeof opts.tools === "function" ? opts.tools() : opts.tools;
  if (extra) tools.append(...extra);
  tools.append(iconButton("close", "Close panel (Esc)", { onClick: () => closeSidePanel() }));
  header.append(titles, tools);

  const body = document.createElement("div");
  body.className = "cf-sidepanel__body";
  const footer = document.createElement("footer");
  footer.className = "cf-sidepanel__footer";
  h.inner.append(header, body, footer);

  const setTitle = (t: string, s?: string) => {
    title.textContent = t;
    title.title = t;
    sub.textContent = s ?? "";
    sub.hidden = !s;
  };
  setTitle(opts.title, opts.subtitle);
  h.aside.setAttribute("aria-labelledby", title.id);
  h.aside.dataset.panel = opts.id;

  const wasHidden = h.aside.hidden;
  h.aside.hidden = false;
  if (wasHidden) {
    applyWidth(width);
    resized();
  }

  const ctx: SidePanelContext = { id: opts.id, body, footer, setTitle, close: () => closeSidePanel() };
  cleanup = opts.render(ctx);
  title.focus({ preventScroll: true });
  for (const fn of listeners) fn(opts.id);
  return ctx;
}

/** Show a panel, replacing the one showing (which Back returns to). */
export function openSidePanel(opts: SidePanelOptions): SidePanelContext {
  const active = document.activeElement;
  if (!host?.aside.contains(active) && active instanceof HTMLElement && active !== document.body) returnFocus = active;
  stack.open(opts);
  return show(opts);
}

/** Go back to the previous panel; closes when there is none. Returns whether a panel is still open. */
export function sidePanelBack(): boolean {
  const prev = stack.back();
  if (!prev) {
    closeSidePanel();
    return false;
  }
  show(prev);
  return true;
}

/** Close the panel (and forget the Back history). */
export function closeSidePanel(): void {
  const was = stack.close();
  if (!host || host.aside.hidden) return;
  if (typeof cleanup === "function") cleanup();
  cleanup = undefined;
  const hadFocus = host.aside.contains(document.activeElement);
  host.aside.hidden = true;
  host.inner.replaceChildren();
  delete host.aside.dataset.panel;
  resized();
  was?.onClose?.();
  if (hadFocus || document.activeElement === document.body) {
    const target = returnFocus?.isConnected ? returnFocus : host.split.querySelector<HTMLElement>("canvas, [tabindex]");
    target?.focus();
  }
  returnFocus = null;
  for (const fn of listeners) fn(null);
}

/** The id of the panel showing, or null. */
export function currentSidePanel(): string | null {
  return stack.current?.id ?? null;
}

/** Hear about panels opening and closing (e.g. to highlight a rail button). Returns an unsubscribe. */
export function onSidePanelChange(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Open the panel, or close it if it's the one showing (for toggle buttons). */
export function toggleSidePanel(opts: SidePanelOptions): void {
  if (currentSidePanel() === opts.id) closeSidePanel();
  else openSidePanel(opts);
}
