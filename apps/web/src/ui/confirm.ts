/**
 * An in-app replacement for window.confirm(): same question, styled, and it
 * doesn't block the page.
 *
 *   if (!(await confirmDialog({ title: "Delete “Bank”?", text: "You can undo this.", confirm: "Delete", danger: true }))) return;
 *
 * Resolves true for the confirm button, false for Cancel, Esc, × or a click
 * outside. A danger confirmation starts with focus on Cancel, so a stray
 * Enter doesn't destroy anything; otherwise focus starts on the confirm
 * button, so Enter accepts.
 */
import { openDialog } from "./dialog";

export interface ConfirmOptions {
  title: string;
  /** one or more paragraphs */
  text?: string | readonly string[];
  /** the confirm button's label (default "OK"); use a verb: "Delete", "Discard changes" */
  confirm?: string;
  /** default "Cancel" */
  cancel?: string;
  /** a red confirm button, and focus starts on Cancel */
  danger?: boolean;
}

/** The dialog's actions for a confirmation (pure; used by confirmDialog). */
export function confirmActions(opts: Pick<ConfirmOptions, "confirm" | "cancel" | "danger">) {
  return [
    { label: opts.cancel ?? "Cancel", id: "cancel", dismiss: true },
    { label: opts.confirm ?? "OK", id: "confirm", kind: opts.danger ? ("danger" as const) : ("primary" as const) },
  ];
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const d = openDialog({
    title: opts.title,
    size: "sm",
    role: "alertdialog",
    body: opts.text === undefined ? undefined : typeof opts.text === "string" ? [opts.text] : opts.text,
    actions: confirmActions(opts),
  });
  (opts.danger ? d.button("cancel") : d.button("confirm"))?.focus();
  return d.closed.then((r) => r === "confirm");
}
