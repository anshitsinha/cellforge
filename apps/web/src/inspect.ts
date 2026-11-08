/**
 * Inspect a cell: its formula step by step, what it reads (precedents),
 * what reads it (dependents, on every sheet), and audit checks.
 */
import { formatFormula, formatValue, hardCodedNumbers, hasRefError, references, shape, steps, type Finding, type Step } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";
import { columnLetter } from "@cellforge/grid";
import type { Workbook } from "./workbook";

export interface Place {
  sheetId: string;
  sheetName: string;
  range: CellRange;
  /** "Data!B2:B9" */
  label: string;
}

export interface Inspection {
  formula: string | null;
  steps: Step | null;
  precedents: Place[];
  dependents: Place[];
  findings: Finding[];
}

const a1 = (r: CellRange) =>
  r.top === r.bottom && r.left === r.right
    ? `${columnLetter(r.left)}${r.top + 1}`
    : r.bottom === Infinity
      ? `${columnLetter(r.left)}:${columnLetter(r.right)}`
      : `${columnLetter(r.left)}${r.top + 1}:${columnLetter(r.right)}${r.bottom + 1}`;

const contains = (r: CellRange, row: number, col: number) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;

export function inspectCell(wb: Workbook, sheetId: string, row: number, col: number, maxDependents = 500): Inspection {
  const sheet = wb.get(sheetId);
  const src = sheet.source;
  const f = src.formulaAt(row, col);
  const findings: Finding[] = [];
  const precedents: Place[] = [];

  if (f) {
    for (const ref of references(f.ast, f.shift, src.evalContext)) {
      const target = ref.sheet ? wb.byName(ref.sheet) : sheet;
      if (!target) {
        findings.push({ kind: "ref-error", message: `Reads a sheet called "${ref.sheet}" that doesn't exist.` });
        continue;
      }
      const label = `${ref.sheet ? `${target.name}!` : ""}${a1(ref.range)}`;
      precedents.push({ sheetId: target.id, sheetName: target.name, range: ref.range, label });
      // a single cell that's empty: often a broken link or a forgotten input
      const r = ref.range;
      if (r.top === r.bottom && r.left === r.right && r.top < target.source.rowCount && r.left < target.source.colCount && target.source.getCell(r.top, r.left) === null) {
        findings.push({ kind: "empty-input", message: `Reads ${label}, which is empty.` });
      }
    }
    if (hasRefError(f.ast)) findings.push({ kind: "ref-error", message: "Contains #REF!: it pointed at cells that were deleted. Find the original source and point it there again." });
    const typed = hardCodedNumbers(f.ast);
    if (typed.length) findings.push({ kind: "hard-coded", message: `Has ${typed.length === 1 ? "a number" : "numbers"} typed in (${typed.join(", ")}). Assumptions are easier to check and change in their own labelled cell.` });
    // a formula unlike the ones directly above and below
    const here = shape(f.ast, row, col, f.shift);
    const above = row > 0 ? src.formulaAt(row - 1, col) : null;
    const below = row + 1 < src.rowCount ? src.formulaAt(row + 1, col) : null;
    if (above && below) {
      const sa = shape(above.ast, row - 1, col, above.shift);
      const sb = shape(below.ast, row + 1, col, below.shift);
      if (sa === sb && sa !== here) findings.push({ kind: "inconsistent", message: "Differs from the formulas above and below it, which match each other. An overwritten or mis-copied formula?" });
    }
  }

  // dependents: every formula on every sheet that reads this cell
  const dependents: Place[] = [];
  for (const s of wb.sheets) {
    const { cells, fills } = s.source.formulaCells();
    const reads = (refSheet: string | undefined) => (refSheet ? refSheet.toLowerCase() === sheet.name.toLowerCase() : s.id === sheetId);
    for (const c of cells) {
      if (dependents.length >= maxDependents) break;
      if (references(c.ast, c.shift, s.source.evalContext).some((r) => reads(r.sheet) && contains(r.range, row, col))) {
        const range = { top: c.row, bottom: c.row, left: c.col, right: c.col };
        dependents.push({ sheetId: s.id, sheetName: s.name, range, label: `${s.id === sheetId ? "" : `${s.name}!`}${a1(range)}` });
      }
    }
    for (const fl of fills) {
      if (dependents.length >= maxDependents) break;
      // the rows of the fill whose formula reads this cell. Both ends reading it
      // means an absolute reference or a wide range: the whole block depends.
      const moved = (d: number) => references(fl.ast, d - fl.origin).some((r) => reads(r.sheet) && contains(r.range, row, col));
      let lo = Infinity;
      let hi = -Infinity;
      if (moved(fl.top) && moved(fl.bottom)) {
        lo = fl.top;
        hi = fl.bottom;
      } else {
        // relative references reach this cell only from nearby rows
        for (let d = Math.max(fl.top, row - 2000); d <= Math.min(fl.bottom, row + 2000); d++) {
          if (moved(d)) {
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
        }
      }
      if (lo <= hi) {
        const range = { top: lo, bottom: hi, left: fl.col, right: fl.col };
        dependents.push({ sheetId: s.id, sheetName: s.name, range, label: `${s.id === sheetId ? "" : `${s.name}!`}${a1(range)}` });
      }
    }
  }

  return {
    formula: f ? formatFormula(f.ast, f.shift) : null,
    steps: f ? steps(f.ast, src.evalContext, f.shift) : null,
    precedents,
    dependents,
    findings,
  };
}

/**
 * A number as Inspect, Lineage and History show it: in the cell's number
 * format when it has one, else rounded to 12 significant digits (so sums
 * like -4824.429999999935 read -4,824.43) with thousands separators.
 * Text that is a plain number (a formula step's value) is read as one.
 */
export function displayValue(v: unknown, numFmt?: string | null): string {
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim())) n = Number(v);
  if (n === null || !Number.isFinite(n)) return v === null || v === undefined ? "" : String(v);
  if (numFmt && numFmt.toLowerCase() !== "general") return formatValue(Math.abs(n) < 1e-9 ? 0 : n, numFmt).text;
  const clean = Math.abs(n) < 1e-9 ? 0 : Number(n.toPrecision(12));
  if (Math.abs(clean) >= 1e15 || (clean !== 0 && Math.abs(clean) < 1e-6)) return String(clean);
  return clean.toLocaleString("en-US", { maximumFractionDigits: 10 });
}

/** A formula step worth showing: not a bare number or text that "works out" to itself. */
export const meaningfulStep = (s: Step) => s.children.length > 0 || s.text.trim().replace(/^"|"$/g, "") !== s.value.trim();
