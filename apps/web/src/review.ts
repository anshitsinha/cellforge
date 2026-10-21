/**
 * Review mode: tick marks on cells (with a legend), review notes that stay
 * open until cleared, sign-off by preparer and reviewer, and workpaper
 * references. Marks and notes live on cells (with notes and links, so they
 * follow sorts); sign-offs and references live on the workbook.
 */

export interface MarkDef {
  id: string;
  glyph: string;
  label: string;
  color: string;
}

export const BUILTIN_MARKS: MarkDef[] = [
  { id: "agreed", glyph: "✓", label: "Agreed to source document", color: "#1a73e8" },
  { id: "footed", glyph: "F", label: "Footed (column added up)", color: "#188038" },
  { id: "crossfooted", glyph: "CF", label: "Cross-footed (row added across)", color: "#188038" },
  { id: "recalc", glyph: "R", label: "Recalculated", color: "#8430ce" },
  { id: "traced", glyph: "T", label: "Traced to the ledger", color: "#e8710a" },
  { id: "vouched", glyph: "V", label: "Vouched to supporting evidence", color: "#e8710a" },
  { id: "pbc", glyph: "PBC", label: "Provided by client", color: "#5f6368" },
  { id: "exception", glyph: "✗", label: "Exception: see review note", color: "#d93025" },
];

export interface ReviewNote {
  text: string;
  by: string;
  at: number;
  cleared?: { by: string; at: number };
}

export interface SignOff {
  by: string;
  at: number;
  /** the evidence log's last hash when signed */
  logHash: string;
  /** the log's length when signed (entries after it on this sheet mean "changed since") */
  logLength: number;
}

export interface SheetReview {
  prepared?: SignOff;
  reviewed?: SignOff;
  /** workpaper reference, e.g. "B-3" */
  ref?: string;
}

export interface WorkbookReview {
  /** custom marks, added to the built-in ones */
  marks: MarkDef[];
  /** by sheet id */
  sheets: Record<string, SheetReview>;
}

export const emptyReview = (): WorkbookReview => ({ marks: [], sheets: {} });

export function allMarks(review: WorkbookReview): MarkDef[] {
  return [...BUILTIN_MARKS, ...review.marks.filter((m) => !BUILTIN_MARKS.some((b) => b.id === m.id))];
}

/**
 * What review actions are called in the log (registry.describe): tick marks,
 * review notes, sign-offs, workpaper references and the custom marks. They
 * record the review; they don't change the numbers.
 */
const REVIEW_LABEL = /^(tick|untick) |^(clear |reopen |delete )?review note$|^remove (prepared|reviewed) sign-off$|^sign off as (prepared|reviewed)$|^(remove )?workpaper ref\b|^custom tick marks$/;

/** Is this log entry review work (a tick, a note, a sign-off, a reference), not a change to the sheet's contents? */
export function isReviewEntry(e: { kind: string; label?: string; action?: { type: string } }): boolean {
  if (e.action) return e.action.type.startsWith("review.");
  return (e.kind === "run" || e.kind === "undo" || e.kind === "redo") && !!e.label && REVIEW_LABEL.test(e.label);
}

/**
 * How many changes the sheet has had since this sign-off: logged changes on
 * it, and undo / redo / recipe runs (which can touch any sheet), after the
 * entry the sign-off was given at. Review work itself (the sign-off's own log
 * entry, tick marks, review notes, references) doesn't count.
 */
export function changedSince(sign: SignOff, log: readonly { kind: string; sheet?: string; label?: string; hash?: string; action?: { type: string } }[], sheetName: string): number {
  // the log is written a moment after each action, so find the last entry the sign-off saw by its hash
  const at = sign.logHash && !/^0+$/.test(sign.logHash) ? log.findIndex((e) => e.hash === sign.logHash) : -1;
  const from = at >= 0 ? at + 1 : sign.logLength;
  let n = 0;
  for (const e of log.slice(from)) {
    if (e.kind === "open" || e.kind === "import" || isReviewEntry(e)) continue;
    if (e.sheet === sheetName || e.kind === "undo" || e.kind === "redo" || e.kind === "recipe") n++;
  }
  return n;
}

/** A sign-off that undo or redo took away or put back. */
export interface SignOffUndo {
  sheet: string;
  role: "prepared" | "reviewed";
  by: string;
  /** true: undo took it away; false: redo put it back */
  removed: boolean;
}

const signOffUndoListeners = new Set<(e: SignOffUndo) => void>();

/**
 * Hear about sign-offs that undo / redo took away or put back, so the app can
 * say so: an attestation shouldn't vanish without a word. Returns a function
 * that stops listening.
 */
export function onSignOffUndo(fn: (e: SignOffUndo) => void): () => void {
  signOffUndoListeners.add(fn);
  return () => signOffUndoListeners.delete(fn);
}

/** Called by the review.putSheet action (which only ever runs as an undo or a redo) with the sheet's state before and after. */
export function noteSignOffUndo(sheet: string, before: SheetReview, after: SheetReview): void {
  for (const role of ["prepared", "reviewed"] as const) {
    const was = before[role];
    const now = after[role];
    if (!!was === !!now) continue;
    const e: SignOffUndo = { sheet, role, by: (was ?? now)!.by, removed: !!was };
    for (const fn of signOffUndoListeners) fn(e);
  }
}

const NAME_KEY = "cellforge.reviewerName";

/** The reviewer's name or initials (kept in this browser only). */
export function reviewerName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

export function setReviewerName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // private mode: asked again next time
  }
}
