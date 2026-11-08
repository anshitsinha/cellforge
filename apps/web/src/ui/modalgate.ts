/**
 * One modal at a time.
 *
 * The rule: while a modal (a ui/dialog.ts dialog, the palette, the ask bar
 * or an older `.palette-backdrop` dialog with aria-modal) is open, it owns
 * the keyboard. Its own keys (typing, Tab, Enter, Esc, Ctrl+C/V/X/A/Z/Y in
 * a field) work as usual; the app's global shortcuts (Ctrl+K, Ctrl+/, F1,
 * F10, Ctrl+F, Ctrl+S, …) do nothing until it closes, so nothing opens on
 * top of it. Esc always closes the topmost modal, also when a closed
 * dropdown has focus (an open native picker handles its own Esc).
 *
 * The palette and the ask bar refuse to open over another modal; a command
 * chosen in the palette runs after the palette has closed.
 */

export interface KeyInfo {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** the target is a text field (input, textarea, contenteditable) */
  editable: boolean;
  /** the target is inside the topmost modal */
  inside: boolean;
}

/**
 * pass: let the event carry on to the app as usual.
 * stop: keep it away from the app's document-level shortcuts but let the
 *   browser do its default (typing, copy/paste in a field).
 * block: stop it and cancel the browser default too.
 */
export type KeyGate = "pass" | "stop" | "block";

const NATIVE_EDIT = new Set(["a", "c", "v", "x", "z", "y"]);

export function gateKey(modalOpen: boolean, k: KeyInfo): KeyGate {
  if (!modalOpen) return "pass";
  // the modal's own handlers (and the dialog's capture listener) deal with Esc
  if (k.key === "Escape") return "pass";
  if (k.key === "Tab") return k.inside ? "stop" : "pass";
  const fkey = /^F\d{1,2}$/.test(k.key);
  const mod = k.ctrl || k.meta || k.alt;
  if (!mod && !fkey) return "stop";
  if ((k.ctrl || k.meta) && !k.alt && k.editable && NATIVE_EDIT.has(k.key.toLowerCase())) return "stop";
  // Alt alone (menu bar), Shift, Control: nothing to cancel
  if (k.key === "Alt" || k.key === "Control" || k.key === "Shift" || k.key === "Meta") return "stop";
  return "block";
}

/** Whether a new palette / ask bar / command dialog may open now. */
export function canOpenOver(openModals: number): boolean {
  return openModals === 0;
}

const MODAL_SELECTOR = ".cf-backdrop:not(.is-closing), .palette-backdrop:not(.is-closing)";

function isModalBackdrop(el: Element): boolean {
  if (el.classList.contains("cf-backdrop")) return true;
  // the older dialogs: modal unless a11y.ts marked them non-modal (Find)
  return !!el.querySelector("[aria-modal=true]") || el.classList.contains("cf-palette-backdrop") || el.classList.contains("askbar-backdrop");
}

/** The open modal backdrops, bottom first. */
export function openModals(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).filter(isModalBackdrop);
}

export function topModal(): HTMLElement | null {
  const all = openModals();
  return all[all.length - 1] ?? null;
}

export function isModalOpen(): boolean {
  return openModals().length > 0;
}

function editable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLInputElement) return !/^(checkbox|radio|button|submit|reset|range|color|file)$/.test(t.type);
  return t.isContentEditable;
}

let installed = false;

/**
 * Install the gate. It listens on <html> in the bubble phase, so a modal's
 * own handlers (on the dialog, below) have already run and the app's
 * document-level shortcuts (above) never see a blocked key.
 */
export function installModalGate(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.documentElement.addEventListener("keydown", (e) => {
    const top = topModal();
    if (!top) return;
    const verdict = gateKey(true, {
      key: e.key,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      editable: editable(e.target),
      inside: top.contains(e.target as Node),
    });
    if (verdict === "pass") return;
    e.stopPropagation();
    if (verdict === "block") e.preventDefault();
  });
}
