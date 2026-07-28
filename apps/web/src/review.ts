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

/** Has the sheet changed since this sign-off? (Any logged change on it, or an undo / redo, after.) */
export function changedSince(sign: SignOff, log: readonly { kind: string; sheet?: string }[], sheetName: string): number {
  let n = 0;
  for (const e of log.slice(sign.logLength)) {
    if (e.kind === "open" || e.kind === "import") continue;
    if (e.sheet === sheetName || e.kind === "undo" || e.kind === "redo" || e.kind === "recipe") n++;
  }
  return n;
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
