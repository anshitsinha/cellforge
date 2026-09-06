/**
 * Modal dialog: a fixed header (title, optional subtitle, close ×), a body
 * that scrolls and never makes the dialog taller than the window, and a
 * fixed footer with the actions.
 *
 *   const d = openDialog({
 *     title: "Find duplicates",
 *     subtitle: "Rows that match on every key column",
 *     size: "lg",
 *     body: form,                       // a Node, a list of Nodes or plain text
 *     actions: [
 *       { label: "Cancel", dismiss: true },
 *       { label: "Add result sheet", kind: "primary", onClick: async () => { await run(); } },
 *     ],
 *   });
 *   const how = await d.closed;          // the action's id (or label), or "dismiss"
 *
 * - Esc, the × and a click on the dim backdrop close it with "dismiss"
 *   (set dismissible: false for a dialog that must be answered).
 * - An action's onClick may return false (or a promise of false) to keep the
 *   dialog open; while a promise runs the footer is disabled; a thrown error
 *   is shown in the footer and the dialog stays open.
 * - Tab stays inside; focus starts on `initialFocus`, else the first field,
 *   else the primary button; focus goes back where it was on close.
 * - role="dialog" (or "alertdialog"), aria-modal, aria-labelledby the title,
 *   aria-describedby the subtitle.
 */
import "./ui.css";
import { labelIconButtons, nextFocus } from "../a11y";
import { icon, iconButton, type IconName } from "./icons";

export type DialogSize = "sm" | "md" | "lg" | "xl";
export type ButtonKind = "primary" | "secondary" | "ghost" | "danger";

export interface DialogAction {
  label: string;
  /** default "secondary" */
  kind?: ButtonKind;
  /** result passed to `closed` (defaults to the label) */
  id?: string;
  /** a Cancel-style button: closes with "dismiss" and runs nothing */
  dismiss?: boolean;
  /** put it at the left end of the footer (e.g. "Reset", "Help") */
  start?: boolean;
  /** return false, or a promise of false, to keep the dialog open */
  onClick?: (dialog: DialogHandle) => unknown;
  disabled?: boolean;
  title?: string;
  icon?: IconName;
}

export interface DialogOptions {
  title: string;
  subtitle?: string;
  /** sm 420 · md 560 (default) · lg 840 · xl 1080 px, never wider than the window */
  size?: DialogSize;
  body?: Node | string | readonly (Node | string)[];
  actions?: readonly DialogAction[];
  /** Esc, × and backdrop click close it (default true) */
  dismissible?: boolean;
  /** an element, a selector inside the dialog, or "primary" */
  initialFocus?: HTMLElement | string;
  /** "alertdialog" for confirmations and warnings */
  role?: "dialog" | "alertdialog";
  className?: string;
  /** called once when it closes, with the same result as `closed` */
  onClose?: (result: string) => void;
}

export interface DialogHandle {
  /** the dialog box (role=dialog) */
  readonly element: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  /** resolves with the action id / label, or "dismiss" */
  readonly closed: Promise<string>;
  /** a footer button by action id or label */
  button(idOrLabel: string): HTMLButtonElement | undefined;
  setTitle(title: string): void;
  /** an error message at the left of the footer; null clears it */
  setError(message: string | null): void;
  /** disable the footer while work runs */
  setBusy(busy: boolean): void;
  close(result?: string): void;
}

const SIZES: readonly DialogSize[] = ["sm", "md", "lg", "xl"];

/** The class for a size (unknown sizes fall back to md). */
export function dialogSizeClass(size: string | undefined): string {
  return `cf-dialog--${SIZES.includes(size as DialogSize) ? size : "md"}`;
}

/** The result an action closes with. */
export function actionResult(a: Pick<DialogAction, "id" | "label" | "dismiss">): string {
  return a.dismiss ? "dismiss" : (a.id ?? a.label);
}

/**
 * Footer order: `start` actions on the left as given; on the right, the
 * quiet ones (dismiss, secondary, ghost) first and the main one
 * (primary / danger) last, so it is always at the far right.
 */
export function orderActions<T extends Pick<DialogAction, "kind" | "start">>(actions: readonly T[]): { start: T[]; end: T[] } {
  const start = actions.filter((a) => a.start);
  const rest = actions.filter((a) => !a.start);
  const loud = (a: T) => a.kind === "primary" || a.kind === "danger";
  return { start, end: [...rest.filter((a) => !loud(a)), ...rest.filter(loud)] };
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[hidden]") && el.getClientRects().length > 0);
}

let ids = 0;

export function makeButton(label: string, kind: ButtonKind = "secondary", iconName?: IconName): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn-${kind}`;
  if (iconName) b.append(icon(iconName));
  b.append(label);
  return b;
}

function append(parent: HTMLElement, content: DialogOptions["body"]): void {
  if (content === undefined) return;
  const list = Array.isArray(content) ? content : [content];
  for (const c of list as (Node | string)[]) {
    if (typeof c === "string") {
      const p = document.createElement("p");
      p.textContent = c;
      parent.append(p);
    } else parent.append(c);
  }
}

/** Open a modal dialog. See the top of this file. */
export function openDialog(opts: DialogOptions): DialogHandle {
  const n = ++ids;
  const dismissible = opts.dismissible !== false;
  const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

  const back = document.createElement("div");
  back.className = "cf-backdrop";

  const box = document.createElement("div");
  box.className = `cf-dialog ${dialogSizeClass(opts.size)}${opts.role === "alertdialog" ? " cf-dialog--alert" : ""}${opts.className ? ` ${opts.className}` : ""}`;
  box.setAttribute("role", opts.role ?? "dialog");
  box.setAttribute("aria-modal", "true");
  box.tabIndex = -1;

  // header
  const header = document.createElement("header");
  header.className = "cf-dialog__header";
  const titles = document.createElement("div");
  titles.className = "cf-dialog__titles";
  const title = document.createElement("h2");
  title.className = "cf-dialog__title";
  title.id = `cf-dlg-title-${n}`;
  title.textContent = opts.title;
  titles.append(title);
  box.setAttribute("aria-labelledby", title.id);
  if (opts.subtitle) {
    const sub = document.createElement("p");
    sub.className = "cf-dialog__subtitle";
    sub.id = `cf-dlg-sub-${n}`;
    sub.textContent = opts.subtitle;
    titles.append(sub);
    box.setAttribute("aria-describedby", sub.id);
  }
  header.append(titles);
  if (dismissible) {
    const x = iconButton("close", "Close", { onClick: () => handle.close("dismiss") });
    x.classList.add("cf-dialog__close");
    header.append(x);
  }

  // body
  const body = document.createElement("div");
  body.className = "cf-dialog__body";
  append(body, opts.body);
  // an alert dialog is described by its message
  if (opts.role === "alertdialog" && !opts.subtitle) {
    body.id = `cf-dlg-body-${n}`;
    box.setAttribute("aria-describedby", body.id);
  }

  // footer
  const footer = document.createElement("footer");
  footer.className = "cf-dialog__footer";
  const startSlot = document.createElement("div");
  startSlot.className = "cf-dialog__footer-start";
  const error = document.createElement("span");
  error.className = "cf-dialog__error";
  error.setAttribute("role", "alert");
  startSlot.append(error);
  footer.append(startSlot);

  const buttons = new Map<string, HTMLButtonElement>();
  const { start, end } = orderActions(opts.actions ?? []);
  let busy = false;
  const addAction = (a: DialogAction, slot: HTMLElement) => {
    const b = makeButton(a.label, a.kind ?? "secondary", a.icon);
    if (a.disabled) b.disabled = true;
    if (a.title) b.title = a.title;
    if (a.dismiss) b.dataset.act = "cancel";
    buttons.set(a.id ?? a.label, b);
    if (a.id) buttons.set(a.label, b);
    b.addEventListener("click", async () => {
      if (busy) return;
      if (a.dismiss || !a.onClick) return handle.close(actionResult(a));
      handle.setError(null);
      let keep: unknown;
      try {
        const r = a.onClick(handle);
        if (r instanceof Promise) {
          handle.setBusy(true);
          try {
            keep = await r;
          } finally {
            handle.setBusy(false);
          }
        } else keep = r;
      } catch (e) {
        handle.setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (keep !== false) handle.close(actionResult(a));
    });
    slot.append(b);
  };
  start.forEach((a) => addAction(a, startSlot));
  end.forEach((a) => addAction(a, footer));

  box.append(header, body);
  if (opts.actions?.length) box.append(footer);
  else box.append(Object.assign(footer, { hidden: true }));
  back.append(box);

  let resolve!: (r: string) => void;
  const closed = new Promise<string>((r) => (resolve = r));
  let open = true;

  const handle: DialogHandle = {
    element: box,
    body,
    footer,
    closed,
    button: (k) => buttons.get(k),
    setTitle(t) {
      title.textContent = t;
    },
    setError(message) {
      error.textContent = message ?? "";
    },
    setBusy(b) {
      busy = b;
      box.classList.toggle("is-busy", b);
      box.setAttribute("aria-busy", String(b));
    },
    close(result = "dismiss") {
      if (!open) return;
      open = false;
      document.removeEventListener("keydown", onDocKey, true);
      back.classList.add("is-closing");
      const done = () => back.remove();
      // the fade is short; don't depend on animationend (reduced motion, hidden tabs)
      setTimeout(done, 110);
      const now = document.activeElement;
      if ((!now || now === document.body || box.contains(now)) && previous?.isConnected) previous.focus();
      opts.onClose?.(result);
      resolve(result);
    },
  };

  // keyboard: Tab trap and Escape. Listen on the document in the capture
  // phase only for Escape when focus has escaped the dialog (e.g. body).
  box.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      const list = focusables(box);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const next = nextFocus(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey);
      if (next !== null) {
        e.preventDefault();
        list[next].focus();
      }
    } else if (e.key === "Escape" && dismissible && !e.defaultPrevented) {
      if (e.target instanceof HTMLSelectElement) return;
      e.stopPropagation();
      handle.close("dismiss");
    }
  });
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dismissible || box.contains(e.target as Node)) return;
    // only the topmost dialog answers
    const tops = document.querySelectorAll(".cf-backdrop:not(.is-closing)");
    if (tops[tops.length - 1] !== back) return;
    e.stopPropagation();
    handle.close("dismiss");
  };
  document.addEventListener("keydown", onDocKey, true);

  // backdrop: close only when the press started and ended on it (not a drag out of a field)
  let downOnBack = false;
  back.addEventListener("pointerdown", (e) => (downOnBack = e.target === back));
  back.addEventListener("click", (e) => {
    if (dismissible && downOnBack && e.target === back) handle.close("dismiss");
    downOnBack = false;
  });

  document.body.append(back);
  labelIconButtons(box);

  // first focus
  let target: HTMLElement | null = null;
  if (opts.initialFocus instanceof HTMLElement) target = opts.initialFocus;
  else if (opts.initialFocus === "primary") target = footer.querySelector(".btn-primary, .btn-danger");
  else if (typeof opts.initialFocus === "string") target = box.querySelector(opts.initialFocus);
  target ??= focusables(body)[0] ?? footer.querySelector<HTMLElement>(".btn-primary:not(:disabled), .btn-danger:not(:disabled)") ?? box;
  target.focus();

  return handle;
}
