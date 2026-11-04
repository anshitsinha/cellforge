/**
 * Is a native <select>'s picker open? Browsers don't say, so follow the
 * events that open and close it. Dialogs use this to let Esc close the
 * picker when it is open and the dialog when it isn't: a closed select that
 * merely has focus must never stop Esc from closing the dialog.
 */

export type PickerEvent =
  | "pointerdown" // a click on the select toggles its picker
  | "open-key" // Alt+Down, Alt+Up, F4, or Space/Enter on some platforms
  | "escape"
  | "change"
  | "blur";

/** The next "picker open" state after an event on the select. */
export function pickerAfter(open: boolean, ev: PickerEvent): boolean {
  switch (ev) {
    case "pointerdown":
      return !open;
    case "open-key":
      return true;
    default:
      return false;
  }
}

/** Whether Esc on a select should be left to the select (true) or close the dialog (false). */
export function escBelongsToSelect(pickerOpen: boolean): boolean {
  return pickerOpen;
}

let openSelect: HTMLSelectElement | null = null;
let installed = false;

function on(el: EventTarget | null, ev: PickerEvent): void {
  if (!(el instanceof HTMLSelectElement)) return;
  const now = pickerAfter(openSelect === el, ev);
  openSelect = now ? el : openSelect === el ? null : openSelect;
}

function install(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerdown", (e) => {
    if (openSelect && e.target !== openSelect) openSelect = null;
    on(e.target, "pointerdown");
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!(e.target instanceof HTMLSelectElement)) return;
    if ((e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) || e.key === "F4") on(e.target, "open-key");
  }, true);
  document.addEventListener("change", (e) => on(e.target, "change"), true);
  document.addEventListener("focusout", (e) => on(e.target, "blur"), true);
}

/**
 * Call from a dialog's Esc handler. True when the Esc should be left to an
 * open select picker; it also marks the picker closed, so the next Esc
 * closes the dialog.
 */
export function selectWantsEscape(target: EventTarget | null): boolean {
  install();
  if (!(target instanceof HTMLSelectElement)) return false;
  const wants = escBelongsToSelect(openSelect === target);
  on(target, "escape");
  return wants;
}

/** Start following select pickers (dialogs call it on open). */
export function trackSelectPickers(): void {
  install();
}
