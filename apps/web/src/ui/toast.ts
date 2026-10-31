/**
 * Toasts: short messages at the bottom centre of the window, stacked,
 * newest at the bottom.
 *
 *   toast("Saved on this computer");                                  // info
 *   toast({ kind: "success", text: "Matched 1,184 of 1,190 rows" });
 *   toast({ kind: "info", text: "Sheet deleted", action: { label: "Undo", run: undo } });
 *   toast({ kind: "error", title: "Couldn't open the file", text: err.message });
 *
 * - info and success go after 4 s, warnings after 6 s; a toast with an
 *   action stays at least 6 s; errors stay until closed (duration: 0 means
 *   "until closed" for any kind).
 * - The timer pauses while the pointer or keyboard focus is on the toast.
 * - The same text and kind again bumps a counter instead of stacking.
 * - At most 4 show at once; the oldest non-error goes first.
 * - Read out by screen readers (errors assertively).
 */
import "./ui.css";
import { icon, iconButton } from "./icons";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  kind?: ToastKind;
  text: string;
  /** a bold first line */
  title?: string;
  action?: ToastAction;
  /** ms before it goes; 0 = until closed. Defaults by kind. */
  duration?: number;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  title?: string;
  action?: ToastAction;
  duration: number;
  /** how many times this same message was raised */
  count: number;
}

export interface ToastHandle {
  readonly id: number;
  close(): void;
  /** change the text (e.g. progress) */
  update(text: string): void;
}

export const MAX_TOASTS = 4;

/** How long a toast stays, in ms (0 = until closed). */
export function defaultDuration(kind: ToastKind, hasAction = false): number {
  if (kind === "error") return 0;
  const base = kind === "warning" ? 6000 : 4000;
  return hasAction ? Math.max(base, 6000) : base;
}

/**
 * The list of toasts on screen, without any DOM: what to add, what a repeat
 * bumps, and what gets pushed out when there are too many.
 */
export class ToastQueue {
  private next = 1;
  items: ToastItem[] = [];

  constructor(readonly max = MAX_TOASTS) {}

  /** Add a toast; a repeat of a visible one bumps its count instead. */
  push(opts: ToastOptions): { item: ToastItem; repeat: boolean; evicted: ToastItem[] } {
    const kind = opts.kind ?? "info";
    const same = this.items.find((t) => t.kind === kind && t.text === opts.text && t.title === opts.title);
    if (same) {
      same.count++;
      if (opts.action) same.action = opts.action;
      return { item: same, repeat: true, evicted: [] };
    }
    const item: ToastItem = {
      id: this.next++,
      kind,
      text: opts.text,
      title: opts.title,
      action: opts.action,
      duration: opts.duration ?? defaultDuration(kind, !!opts.action),
      count: 1,
    };
    this.items.push(item);
    const evicted: ToastItem[] = [];
    while (this.items.length > this.max) {
      const i = this.items.findIndex((t) => t.kind !== "error" && t !== item);
      const [gone] = this.items.splice(i >= 0 ? i : 0, 1);
      evicted.push(gone);
    }
    return { item, repeat: false, evicted };
  }

  remove(id: number): ToastItem | undefined {
    const i = this.items.findIndex((t) => t.id === id);
    return i >= 0 ? this.items.splice(i, 1)[0] : undefined;
  }

  clear(): ToastItem[] {
    const all = this.items;
    this.items = [];
    return all;
  }
}

/**
 * Where the stack sits. Centred under the grid, not the window: with a side
 * panel open it centres on the area left of the panel (so it never covers
 * the panel's footer); with a modal dialog open it moves to the top (so it
 * never covers the dialog's buttons). On a phone a panel covers the sheet,
 * so the stack stays centred.
 */
export function toastAnchor(viewW: number, panelLeft: number | null, dialogOpen: boolean): { centre: number; top: boolean } {
  const usable = panelLeft !== null && panelLeft > 320 && panelLeft < viewW ? panelLeft : viewW;
  return { centre: Math.round(usable / 2), top: dialogOpen };
}

function place(root: HTMLElement): void {
  const panel = document.querySelector<HTMLElement>(".cf-sidepanel");
  const r = panel && panel.offsetParent ? panel.getBoundingClientRect() : null;
  const dialog = !!document.querySelector(".cf-backdrop:not(.is-closing), .palette-backdrop [aria-modal=true]");
  const a = toastAnchor(innerWidth, r && r.width ? r.left : null, dialog);
  root.style.left = `${a.centre}px`;
  root.classList.toggle("cf-toasts--top", a.top);
}

// ------------------------------------------------------------------ DOM ----

const queue = new ToastQueue();
const views = new Map<number, { el: HTMLElement; text: HTMLElement; count: HTMLElement; timer?: ReturnType<typeof setTimeout>; left: number; started: number }>();
let stack: HTMLElement | null = null;
let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

const ICON = { info: "info", success: "success", warning: "warning", error: "error" } as const;

function ensureRoot(): HTMLElement {
  if (stack?.isConnected) return stack;
  stack = document.createElement("div");
  stack.className = "cf-toasts";
  stack.setAttribute("aria-label", "Notifications");
  const live = (level: "polite" | "assertive") => {
    const r = document.createElement("div");
    r.className = "cf-sr-only";
    r.setAttribute("aria-live", level);
    r.setAttribute("role", level === "polite" ? "status" : "alert");
    r.setAttribute("aria-atomic", "true");
    document.body.append(r);
    return r;
  };
  politeRegion = live("polite");
  assertiveRegion = live("assertive");
  document.body.append(stack);
  return stack;
}

function announce(item: ToastItem): void {
  const region = item.kind === "error" ? assertiveRegion : politeRegion;
  if (!region) return;
  region.textContent = "";
  // a fresh text node after a tick so repeats are read again
  setTimeout(() => (region.textContent = [item.title, item.text].filter(Boolean).join(". ")), 30);
}

function startTimer(id: number): void {
  const v = views.get(id);
  const item = queue.items.find((t) => t.id === id);
  if (!v || !item || !item.duration) return;
  clearTimeout(v.timer);
  v.started = Date.now();
  v.timer = setTimeout(() => dismiss(id), v.left);
}

function pauseTimer(id: number): void {
  const v = views.get(id);
  if (!v?.timer) return;
  clearTimeout(v.timer);
  v.timer = undefined;
  v.left = Math.max(1000, v.left - (Date.now() - v.started));
}

function dismiss(id: number): void {
  queue.remove(id);
  const v = views.get(id);
  if (!v) return;
  clearTimeout(v.timer);
  views.delete(id);
  v.el.classList.add("is-leaving");
  setTimeout(() => v.el.remove(), 180);
}

function render(item: ToastItem): HTMLElement {
  const el = document.createElement("div");
  el.className = `cf-toast cf-toast--${item.kind}`;
  const ic = icon(ICON[item.kind], { size: 16 });
  ic.classList.add("cf-toast__icon");
  const content = document.createElement("div");
  content.className = "cf-toast__content";
  if (item.title) {
    const t = document.createElement("strong");
    t.className = "cf-toast__title";
    t.textContent = item.title;
    content.append(t);
  }
  const text = document.createElement("span");
  text.textContent = item.text;
  const count = document.createElement("span");
  count.className = "cf-toast__count";
  count.hidden = true;
  content.append(text, count);
  el.append(ic, content);
  if (item.action) {
    const a = document.createElement("button");
    a.type = "button";
    a.className = "btn-ghost btn-sm cf-toast__action";
    a.textContent = item.action.label;
    a.addEventListener("click", () => {
      dismiss(item.id);
      item.action?.run();
    });
    el.append(a);
  }
  const x = iconButton("close", "Dismiss", { size: "sm", onClick: () => dismiss(item.id) });
  x.classList.add("cf-toast__close");
  el.append(x);
  el.addEventListener("pointerenter", () => pauseTimer(item.id));
  el.addEventListener("pointerleave", () => startTimer(item.id));
  el.addEventListener("focusin", () => pauseTimer(item.id));
  el.addEventListener("focusout", (e) => {
    if (!el.contains(e.relatedTarget as Node)) startTimer(item.id);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss(item.id);
  });
  views.set(item.id, { el, text, count, left: item.duration, started: Date.now() });
  return el;
}

/** Show a toast. A plain string is an info toast. */
export function toast(opts: ToastOptions | string): ToastHandle {
  const o: ToastOptions = typeof opts === "string" ? { text: opts } : opts;
  const root = ensureRoot();
  place(root);
  const { item, repeat, evicted } = queue.push(o);
  for (const gone of evicted) {
    const v = views.get(gone.id);
    if (v) {
      clearTimeout(v.timer);
      views.delete(gone.id);
      v.el.remove();
    }
  }
  if (repeat) {
    const v = views.get(item.id);
    if (v) {
      v.count.hidden = false;
      v.count.textContent = `×${item.count}`;
      v.left = item.duration;
      startTimer(item.id);
    }
  } else {
    root.append(render(item));
    startTimer(item.id);
  }
  announce(item);
  return {
    id: item.id,
    close: () => dismiss(item.id),
    update(text: string) {
      item.text = text;
      const v = views.get(item.id);
      if (v) v.text.textContent = text;
    },
  };
}

/** Remove every toast (e.g. when a new workbook opens). */
export function clearToasts(): void {
  for (const t of queue.clear()) {
    const v = views.get(t.id);
    clearTimeout(v?.timer);
    v?.el.remove();
    views.delete(t.id);
  }
}
