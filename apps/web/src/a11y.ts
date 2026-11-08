/**
 * Accessibility for the app's dialogs and buttons.
 *
 * modal(back) makes a dialog behave the way screen reader and keyboard users
 * expect: role="dialog" with aria-modal and a name from its heading, Tab and
 * Shift+Tab kept inside it, Escape to close, and focus put back where it was
 * when it closes. Call it on the backdrop element as soon as it's created
 * (before or after it's in the page; it's safe to call twice).
 *
 * installA11y() does the same for every ".palette-backdrop" the app adds,
 * and gives icon-only buttons (×, ↑, ↓ ...) a spoken name. Call it once at
 * startup.
 */
import "./a11y.css";
import { selectWantsEscape, trackSelectPickers } from "./ui/selectpicker";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable=true]",
].join(",");

/**
 * Where Tab should go inside a dialog of `count` focusable elements when
 * focus is on `index` (-1: not on any of them). null means "let the browser
 * move it" (it's not at either end).
 */
export function nextFocus(index: number, count: number, backwards: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return backwards ? count - 1 : 0;
  if (backwards && index === 0) return count - 1;
  if (!backwards && index === count - 1) return 0;
  return null;
}

/** True when a button's text has no letters or digits (an icon such as × or ↑). */
export function isIconOnly(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !/[\p{L}\p{N}]/u.test(t);
}

const ICON_NAMES: Record<string, string> = {
  "×": "Close",
  "✕": "Close",
  "✖": "Close",
  "✗": "Close",
  "↑": "Move up",
  "↓": "Move down",
  "▲": "Move up",
  "▼": "Move down",
  "←": "Back",
  "→": "Next",
  "+": "Add",
  "＋": "Add",
  "−": "Remove",
  "≡": "More",
  "⋯": "More",
  "…": "More",
};

/** A spoken name for an icon-only button: its tooltip if it has one, else a name for the symbol. */
export function iconLabel(text: string, title?: string | null): string | null {
  if (title && title.trim()) return title.trim();
  return ICON_NAMES[text.trim()] ?? null;
}

/** Give every icon-only button under `root` an aria-label (from its title, or the symbol). */
export function labelIconButtons(root: ParentNode): void {
  const buttons = root instanceof HTMLButtonElement ? [root] : Array.from(root.querySelectorAll("button"));
  for (const b of buttons) {
    if (b.hasAttribute("aria-label") || b.hasAttribute("aria-labelledby")) continue;
    if (!isIconOnly(b.textContent ?? "")) continue;
    const name = iconLabel(b.textContent ?? "", b.title);
    if (name) b.setAttribute("aria-label", name);
  }
}

let headingIds = 0;
// the last thing focused outside any dialog, to go back to when one closes
let lastOutsideFocus: HTMLElement | null = null;
const BACKDROP = ".palette-backdrop";

function dialogOf(back: HTMLElement): HTMLElement {
  return back.querySelector<HTMLElement>("[role=dialog],[role=alertdialog]") ?? back.querySelector<HTMLElement>(".palette") ?? (back.firstElementChild as HTMLElement | null) ?? back;
}

/** role, aria-modal and a name from the heading; safe to run again as content arrives. */
function label(back: HTMLElement, fallback?: string, isModal = true): void {
  // nothing inside yet (modal() called before the content went in): wait for it
  if (!back.firstElementChild) return;
  const dialog = dialogOf(back);
  if (!dialog.getAttribute("role")) dialog.setAttribute("role", "dialog");
  if (isModal) dialog.setAttribute("aria-modal", "true");
  const heading = dialog.querySelector<HTMLElement>("h1, h2, h3, h4");
  if (heading) {
    if (!heading.id) heading.id = `cf-dialog-title-${++headingIds}`;
    dialog.setAttribute("aria-labelledby", heading.id);
  } else if (fallback && !dialog.hasAttribute("aria-label")) dialog.setAttribute("aria-label", fallback);
  labelIconButtons(dialog);
}

function focusables(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[hidden]") && el.getClientRects().length > 0);
}

/** The dialog's own way out: its Cancel / Close button, if it has one. */
function closeButton(dialog: HTMLElement): HTMLElement | null {
  const marked = dialog.querySelector<HTMLElement>("[data-act=cancel],[data-act=close],[data-a=c]");
  if (marked) return marked;
  return (
    Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find((b) => /^(cancel|close)$/i.test((b.textContent ?? "").trim()) || /^close$/i.test(b.getAttribute("aria-label") ?? "")) ?? null
  );
}

export interface ModalOptions {
  /** a name for a dialog with no heading */
  label?: string;
  /**
   * false for a dialog that leaves the page usable behind it (Find): no
   * aria-modal and no Tab trap, but still named, Escape and focus restore.
   */
  modal?: boolean;
}

/** Make a backdrop + dialog modal: name, focus trap, Escape, focus restored on close. */
export function modal(back: HTMLElement, opts: ModalOptions = {}): void {
  if (back.dataset.cfModal) return;
  back.dataset.cfModal = "1";
  trackSelectPickers();
  const active = document.activeElement as HTMLElement | null;
  const previous = active && active !== document.body && !back.contains(active) ? active : lastOutsideFocus;

  const isModal = opts.modal !== false;
  label(back, opts.label, isModal);
  queueMicrotask(() => {
    label(back, opts.label, isModal);
    // start inside the dialog if its own code didn't put focus there
    const dialog = dialogOf(back);
    if (back.isConnected && back.firstElementChild && !dialog.contains(document.activeElement)) focusables(dialog)[0]?.focus();
  });
  // content that arrives later (after an await) gets named too
  back.addEventListener("focusin", () => label(back, opts.label, isModal));

  back.addEventListener("keydown", (e) => {
    const dialog = dialogOf(back);
    if (e.key === "Tab" && isModal) {
      const list = focusables(dialog);
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const n = nextFocus(list.indexOf(document.activeElement as HTMLElement), list.length, e.shiftKey);
      if (n !== null) {
        e.preventDefault();
        list[n].focus();
      }
    } else if (e.key === "Escape") {
      // most dialogs close themselves on Escape; for the rest, press Cancel.
      // Not when something inside used the key (a suggestion list, a select).
      // An open dropdown takes its own Esc; a closed one with focus doesn't block closing.
      if (selectWantsEscape(e.target)) return;
      queueMicrotask(() => {
        if (!back.isConnected || e.defaultPrevented) return;
        const cancel = closeButton(dialog);
        if (cancel) cancel.click();
        else back.remove();
      });
    }
  });

  // when it goes, put focus back (unless its own code already moved it somewhere)
  let seen = back.isConnected;
  const watch = new MutationObserver(() => {
    if (back.isConnected) {
      seen = true;
      return;
    }
    if (!seen) return;
    watch.disconnect();
    const now = document.activeElement;
    const lost = !now || now === document.body || !now.isConnected;
    if (lost && previous?.isConnected) previous.focus();
  });
  watch.observe(document.documentElement, { childList: true, subtree: true });
}

// --- button hierarchy for the existing dialogs' footers -----------------------
//
// The older dialogs build their footer (".numfmt-actions") with plain
// buttons in no fixed order. Until they move to ui/dialog.ts, this gives
// them the house style: the main action filled (.btn-primary, far right),
// Cancel / Close as a plain button to its left (.cf-dismiss), and nothing
// else changed. A row with data-cf-plain, or a row where a button already
// has a btn-* or "primary" class, keeps its own styling.

export type ActionRole = "primary" | "danger" | "dismiss" | "plain";

const DISMISS = /^(cancel|close|not now|no|back)$/i;
const DANGER = /^(delete|remove|discard|erase)\b/i;

/** What each footer button should look like, given its text and whether it already has a style or is hidden. */
export function planActions(buttons: readonly { text: string; styled?: boolean; hidden?: boolean; disabled?: boolean }[]): ActionRole[] {
  const roles: ActionRole[] = buttons.map((b) => (DISMISS.test(b.text.trim()) ? "dismiss" : "plain"));
  if (buttons.some((b) => b.styled)) return roles.map((r, i) => (buttons[i].styled ? "plain" : r));
  // the main action is the last one you can press now (a later step, still
  // disabled, waits its turn); if none can be pressed, the last one shown
  const candidates = buttons.map((_, i) => i).filter((i) => roles[i] !== "dismiss" && !buttons[i].hidden);
  const pick = [...candidates].reverse().find((i) => !buttons[i].disabled) ?? candidates[candidates.length - 1];
  if (pick !== undefined) roles[pick] = DANGER.test(buttons[pick].text.trim()) ? "danger" : "primary";
  return roles;
}

const ROLE_CLASS: Record<ActionRole, string> = { primary: "btn-primary", danger: "btn-danger", dismiss: "cf-dismiss", plain: "" };
const AUTO_CLASSES = ["btn-primary", "btn-danger", "cf-dismiss"];

/** Apply planActions() to one footer row (safe to call again when its buttons change). */
export function styleActionRow(row: HTMLElement): void {
  if (row.hasAttribute("data-cf-plain")) return;
  const buttons = Array.from(row.children).filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement);
  if (!buttons.length) return;
  const roles = planActions(
    buttons.map((b) => ({
      text: b.textContent ?? "",
      hidden: b.hidden !== false,
      disabled: b.disabled,
      styled: !b.dataset.cfAuto && (b.classList.contains("primary") || Array.from(b.classList).some((c) => c.startsWith("btn-"))),
    })),
  );
  buttons.forEach((b, i) => {
    if (b.dataset.cfAuto) b.classList.remove(...AUTO_CLASSES);
    const cls = ROLE_CLASS[roles[i]];
    if (cls) {
      b.classList.add(cls);
      b.dataset.cfAuto = "1";
    } else delete b.dataset.cfAuto;
  });
}

const ACTION_ROW = ".palette-backdrop .numfmt-actions";

let installed = false;

/** Apply modal() to every dialog backdrop the app adds, and label icon-only buttons. Call once. */
export function installA11y(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== document.body && !t.closest(BACKDROP)) lastOutsideFocus = t;
    },
    true,
  );
  const visit = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(BACKDROP)) modal(node);
    else node.querySelectorAll<HTMLElement>(BACKDROP).forEach((b) => modal(b));
    labelIconButtons(node);
    // footer buttons: a row, rows inside what was added, or a button added to a row
    const row = node.closest<HTMLElement>(ACTION_ROW);
    if (row) styleActionRow(row);
    node.querySelectorAll<HTMLElement>(".numfmt-actions").forEach((r) => {
      if (r.closest(BACKDROP)) styleActionRow(r);
    });
  };
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") {
        // a footer button was enabled, disabled, shown or hidden: the main action may move
        const row = (r.target as HTMLElement).parentElement;
        if (row?.matches(ACTION_ROW)) styleActionRow(row);
      } else r.addedNodes.forEach(visit);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
  labelIconButtons(document.body);
}
