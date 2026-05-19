/**
 * Find & replace. Searches the used range of the selection, the sheet or
 * every visible sheet, in what cells show (values) or what was typed
 * (formulas), with match case, whole cell and regular expressions.
 * Replacing works on what was typed, so a formula stays a formula and only
 * its text changes; every cell that changes goes into one undoable action.
 */
import { type Action, type ActionRegistry, s } from "@cellforge/actions";
import { parseTyped } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";
import { setCells, type SheetCtx } from "./actions";
import { type EditableSource, isFormula, parseInput } from "./editable";
import type { Workbook } from "./workbook";

export interface FindOptions {
  matchCase?: boolean;
  /** the whole cell has to match, not just part of it */
  wholeCell?: boolean;
  /** the query is a JavaScript regular expression */
  regex?: boolean;
  /** "values": what the cell shows; "formulas": what was typed (formula text for formulas) */
  lookIn?: "values" | "formulas";
  /** "selection" needs `range` */
  scope?: "selection" | "sheet" | "all";
  /** search down each column before moving right (default: along each row) */
  byColumns?: boolean;
  /** the sheet to search for "selection" and "sheet", and where "all" starts its order */
  sheetId: string;
  range?: CellRange;
  /** most matches find() returns (default 10,000) */
  limit?: number;
}

export interface Match {
  sheetId: string;
  row: number;
  col: number;
  /** the text that matched: the shown value or the typed text */
  text: string;
}

/** A query that can't be used, e.g. a broken regular expression. */
export class FindError extends Error {}

export interface Compiled {
  test(text: string): boolean;
  /** `text` with every match replaced; `$1`, `$&` work for regular expressions */
  replace(text: string, replacement: string): string;
}

const escapeRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Turn the query and options into a matcher. Throws FindError for an empty query or a bad regex. */
export function compileQuery(query: string, opts: Pick<FindOptions, "matchCase" | "wholeCell" | "regex">): Compiled {
  if (query === "") throw new FindError("Type something to find.");
  let source = opts.regex ? query : escapeRegex(query);
  if (opts.wholeCell) source = `^(?:${source})$`;
  const flags = opts.matchCase ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(source, flags);
  } catch (e) {
    throw new FindError(`That isn't a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}`);
  }
  const global = new RegExp(source, flags + "g");
  return {
    test: (text) => re.test(text),
    // a plain-text search puts the replacement in literally ($ means $)
    replace: (text, replacement) => (opts.regex ? text.replace(global, replacement) : text.replace(global, () => replacement)),
  };
}

/** The text a cell is searched by. Empty cells are never matched. */
function cellText(src: EditableSource, row: number, col: number, lookIn: "values" | "formulas"): string {
  if (lookIn === "formulas") return src.getEditText(row, col);
  const v = src.getCell(row, col);
  if (v === null || v === "") return "";
  return typeof v === "string" ? v : src.formatValue(v, src.getStyle(row, col)).text;
}

/** One sheet's part of the search: a rectangle inside its used range. */
interface Area {
  sheetId: string;
  src: EditableSource;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** The sheets and rectangles to search, in order (the given sheet first for "all"). */
function areas(wb: Workbook, opts: FindOptions): Area[] {
  const scope = opts.scope ?? "sheet";
  const sheets = scope === "all" ? wb.visible : [wb.get(opts.sheetId)];
  const out: Area[] = [];
  for (const sheet of sheets) {
    const used = sheet.source.usedRange();
    let r = { top: 0, left: 0, bottom: used.rows - 1, right: used.cols - 1 };
    if (scope === "selection") {
      if (!opts.range) throw new FindError("There's no selection to search in.");
      r = { top: Math.max(r.top, opts.range.top), left: Math.max(r.left, opts.range.left), bottom: Math.min(r.bottom, opts.range.bottom), right: Math.min(r.right, opts.range.right) };
    }
    if (r.top > r.bottom || r.left > r.right) continue;
    out.push({ sheetId: sheet.id, src: sheet.source, ...r });
  }
  return out;
}

/** Cells of an area by index, along rows or down columns. */
function cellAt(a: Area, i: number, byColumns: boolean): [number, number] {
  const h = a.bottom - a.top + 1;
  const w = a.right - a.left + 1;
  return byColumns ? [a.top + (i % h), a.left + Math.floor(i / h)] : [a.top + Math.floor(i / w), a.left + (i % w)];
}

const size = (a: Area) => (a.bottom - a.top + 1) * (a.right - a.left + 1);

/** Index of the first cell of the area at or after (row, col) in search order, and whether it is that cell. */
function position(a: Area, row: number, col: number, byColumns: boolean): { index: number; exact: boolean } {
  const [major, minor, lo, hi, minLo, minHi] = byColumns ? [col, row, a.left, a.right, a.top, a.bottom] : [row, col, a.top, a.bottom, a.left, a.right];
  const width = minHi - minLo + 1;
  if (major < lo) return { index: 0, exact: false };
  if (major > hi) return { index: size(a), exact: false };
  const base = (major - lo) * width;
  if (minor < minLo) return { index: base, exact: false };
  if (minor > minHi) return { index: base + width, exact: false };
  return { index: base + minor - minLo, exact: true };
}

/** Every matching cell, in search order, up to `opts.limit`. */
export function find(wb: Workbook, query: string, opts: FindOptions): Match[] {
  const m = compileQuery(query, opts);
  const lookIn = opts.lookIn ?? "values";
  const limit = opts.limit ?? 10_000;
  const by = !!opts.byColumns;
  const out: Match[] = [];
  for (const a of areas(wb, opts)) {
    const n = size(a);
    for (let i = 0; i < n; i++) {
      const [row, col] = cellAt(a, i, by);
      const text = cellText(a.src, row, col, lookIn);
      if (text !== "" && m.test(text)) {
        out.push({ sheetId: a.sheetId, row, col, text });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * The next match after (or, going back, before) a cell, wrapping around the
 * end of the search. The cell itself is found last, so with one match
 * "next" stays on it. Null when nothing matches.
 */
export function findNext(wb: Workbook, query: string, opts: FindOptions, from: { sheetId: string; row: number; col: number }, backwards = false): Match | null {
  const m = compileQuery(query, opts);
  const lookIn = opts.lookIn ?? "values";
  const by = !!opts.byColumns;
  const list = areas(wb, opts);
  if (!list.length) return null;
  let k = list.findIndex((a) => a.sheetId === from.sheetId);
  // starting on a sheet outside the search: begin at the first (or last) area
  const pos = k >= 0 ? position(list[k], from.row, from.col, by) : { index: backwards ? size(list[0]) : 0, exact: false };
  if (k < 0) k = 0;
  // ranges of indexes [from, to) to scan, per area, in order
  const steps: { a: Area; lo: number; hi: number }[] = [];
  const after = pos.index + (pos.exact ? 1 : 0);
  if (!backwards) {
    steps.push({ a: list[k], lo: after, hi: size(list[k]) });
    for (let j = 1; j < list.length; j++) {
      const a = list[(k + j) % list.length];
      steps.push({ a, lo: 0, hi: size(a) });
    }
    steps.push({ a: list[k], lo: 0, hi: after });
  } else {
    steps.push({ a: list[k], lo: 0, hi: pos.index });
    for (let j = 1; j < list.length; j++) {
      const a = list[(k - j + list.length) % list.length];
      steps.push({ a, lo: 0, hi: size(a) });
    }
    steps.push({ a: list[k], lo: pos.index, hi: size(list[k]) });
  }
  for (const { a, lo, hi } of steps) {
    for (let t = 0; t < hi - lo; t++) {
      const i = backwards ? hi - 1 - t : lo + t;
      const [row, col] = cellAt(a, i, by);
      const text = cellText(a.src, row, col, lookIn);
      if (text !== "" && m.test(text)) return { sheetId: a.sheetId, row, col, text };
    }
  }
  return null;
}

/**
 * What to type into a cell to replace the matches in it, or null if it
 * doesn't match or wouldn't change. Works on what was typed: a formula stays
 * a formula, and text that would turn into a number or formula stays text.
 */
export function replacementInput(src: EditableSource, row: number, col: number, m: Compiled, replacement: string): string | null {
  const before = src.getEditText(row, col);
  if (before === "" || !m.test(before)) return null;
  let after = m.replace(before, replacement);
  if (after === before) return null;
  const stored = src.getStored(row, col);
  const formula = isFormula(stored !== undefined ? stored : src.getTemplate(row, col).template);
  if (formula) {
    if (after.trim() === "") return "";
    return after.trimStart().startsWith("=") ? after : "=" + after;
  }
  const textFormat = src.getStyle(row, col)?.numFmt === "@";
  if (typeof src.getCell(row, col) === "string" && !textFormat && after !== "") {
    // "007" or "=x" that was text stays text, as it was before
    const becomes = parseInput(after);
    if (after.startsWith("'") || typeof becomes !== "string" || (becomes === after && parseTyped(after))) after = "'" + after;
  }
  return after;
}

export interface ReplacePlan {
  /** per sheet, in search order */
  sheets: { sheetId: string; cells: { row: number; col: number; input: string }[] }[];
  count: number;
}

/** Every change Replace all would make. Only cells that match and change are in it. */
export function planReplace(wb: Workbook, query: string, replacement: string, opts: FindOptions): ReplacePlan {
  const m = compileQuery(query, opts);
  const by = !!opts.byColumns;
  const sheets: ReplacePlan["sheets"] = [];
  let count = 0;
  for (const a of areas(wb, opts)) {
    const cells: { row: number; col: number; input: string }[] = [];
    const n = size(a);
    for (let i = 0; i < n; i++) {
      const [row, col] = cellAt(a, i, by);
      const input = replacementInput(a.src, row, col, m, replacement);
      if (input !== null) cells.push({ row, col, input });
    }
    if (cells.length) {
      sheets.push({ sheetId: a.sheetId, cells });
      count += cells.length;
    }
  }
  return { sheets, count };
}

/**
 * The action for a plan: a plain cells.set on one sheet, or cells.setMany
 * (registered by registerFindActions) across sheets, so it's always a
 * single undo step. Null if there's nothing to change.
 */
export function replaceAction(plan: ReplacePlan, label: string): Action | null {
  if (!plan.sheets.length) return null;
  if (plan.sheets.length === 1) return setCells(plan.sheets[0].cells, label, plan.sheets[0].sheetId);
  return { type: "cells.setMany", params: { edits: plan.sheets.map((p) => ({ sheet: p.sheetId, cells: p.cells })), label } };
}

const cellsSchema = s.array(
  s.object({
    row: s.int("row, 0-based", 0),
    col: s.int("column, 0-based (A = 0)", 0),
    input: s.anyOf(s.string("text as typed"), s.null()),
  }),
  undefined,
  1,
);

/**
 * cells.setMany: cells.set on several sheets as one step, and its inverse.
 * Each part is applied with cells.set's own logic; if one fails, the parts
 * already done are undone before the error is passed on.
 */
export function registerFindActions(registry: ActionRegistry<SheetCtx>): void {
  const applyAll = async (ctx: SheetCtx, steps: Action[]): Promise<Action[]> => {
    const inverses: Action[] = [];
    try {
      for (const step of steps) {
        const def = registry.get(step.type);
        if (!def || !step.type.startsWith("cells.")) throw new Error(`can't apply "${step.type}" here`);
        const problems = registry.check(step);
        if (problems.length) throw new Error(problems.join("; "));
        const inv = await def.apply(ctx, step.params);
        if (inv) inverses.push(inv);
      }
    } catch (e) {
      for (const inv of inverses.reverse()) await registry.get(inv.type)!.apply(ctx, inv.params);
      throw e;
    }
    return inverses.reverse();
  };
  registry
    .register<{ edits: { sheet: string; cells: { row: number; col: number; input: string | null }[] }[]; label?: string }>({
      type: "cells.setMany",
      title: "Write values or formulas into cells on several sheets at once, as one step",
      schema: s.object({ edits: s.array(s.object({ sheet: s.string("sheet id"), cells: cellsSchema }), undefined, 1), label: s.string("what this edit was, for the undo menu") }, ["edits"]),
      describe: (p) => p.label ?? `edit ${p.edits.reduce((n, e) => n + e.cells.length, 0).toLocaleString()} cells on ${p.edits.length} sheets`,
      recordable: true,
      async apply(ctx, p) {
        for (const e of p.edits) if (!ctx.workbook.has(e.sheet)) throw new Error(`No sheet with id ${e.sheet}`);
        const inverses = await applyAll(
          ctx,
          p.edits.map((e) => setCells(e.cells, p.label, e.sheet)),
        );
        return inverses.length ? { type: "cells.steps", params: { steps: inverses, ...(p.label ? { label: p.label } : {}) } } : null;
      },
    })
    .register<{ steps: Action[]; label?: string }>({
      type: "cells.steps",
      title: "Apply several saved cell changes as one step (undo of cells.setMany)",
      schema: s.object({ steps: s.array({ type: "object", properties: {}, additionalProperties: true }, undefined, 1), label: s.string() }, ["steps"]),
      describe: (p) => p.label ?? `${p.steps.length} cell changes`,
      internal: true,
      async apply(ctx, p) {
        const inverses = await applyAll(ctx, p.steps);
        return inverses.length ? { type: "cells.steps", params: { steps: inverses, ...(p.label ? { label: p.label } : {}) } } : null;
      },
    });
}
