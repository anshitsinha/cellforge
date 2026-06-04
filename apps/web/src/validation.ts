/**
 * Data validation: rules about what may be typed into cells (a list of
 * choices, numbers or dates in a range, text length, a custom formula), with
 * a message to show when the cell is selected and what happens when a value
 * breaks the rule (stop, warn, or just tell). A "checkbox" rule makes cells
 * TRUE / FALSE tick boxes.
 *
 * Rules are plain data, saved with the file and carried by actions, and
 * stored per sheet like conditional formats.
 */
import { moveFormula, parseFormula, parseTyped, type Node } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";

export type DvOp = "between" | "notBetween" | "=" | "!=" | ">" | "<" | ">=" | "<=";

export type DvKind = "list" | "whole" | "decimal" | "date" | "textLength" | "custom" | "checkbox";

export interface DvRule {
  id: string;
  ranges: CellRange[];
  kind: DvKind;
  /** number / date / length comparisons */
  op?: DvOp;
  a?: number;
  b?: number;
  /** list: the choices typed in */
  list?: string[];
  /** list: or the choices in a range, e.g. Lists!$A$2:$A$20 */
  source?: string;
  /** custom: a formula for the range's top-left cell; the value is allowed when it's TRUE */
  formula?: string;
  /** blank cells are always allowed (default true) */
  allowBlank?: boolean;
  /** show the dropdown on list cells (default true) */
  dropdown?: boolean;
  inputTitle?: string;
  inputMessage?: string;
  errorStyle?: "stop" | "warning" | "info";
  errorTitle?: string;
  errorMessage?: string;
}

/** What a typed value becomes, for checking: number (dates are numbers), text, boolean or empty. */
export type DvValue = number | string | boolean | null;

export interface DvContext {
  /** values of a list's source range */
  listValues(source: string): string[];
  /** a custom formula (already moved to the cell) worked out at row, col, as if the cell held `value` */
  evalAt(ast: Node, row: number, col: number): unknown;
}

const inRange = (r: CellRange, row: number, col: number) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;

/** The rule for a cell (the last one added wins, as only one applies in Excel). */
export function ruleAt(rules: readonly DvRule[], row: number, col: number): DvRule | null {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i].ranges.some((r) => inRange(r, row, col))) return rules[i];
  return null;
}

/** The value a typed input would store (numbers, dates and percentages as numbers; TRUE / FALSE as booleans). */
export function typedValue(input: string | null): DvValue {
  if (input === null) return null;
  const t = input.trim();
  if (t === "") return null;
  if (input.startsWith("'")) return input.slice(1);
  if (/^(true|false)$/i.test(t)) return t.toUpperCase() === "TRUE";
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  const typed = parseTyped(t);
  return typed ? typed.value : input;
}

function compare(op: DvOp, v: number, a: number, b: number | undefined): boolean {
  const hi = b ?? a;
  switch (op) {
    case "between":
      return v >= Math.min(a, hi) && v <= Math.max(a, hi);
    case "notBetween":
      return v < Math.min(a, hi) || v > Math.max(a, hi);
    case "=":
      return v === a;
    case "!=":
      return v !== a;
    case ">":
      return v > a;
    case "<":
      return v < a;
    case ">=":
      return v >= a;
    case "<=":
      return v <= a;
  }
}

/** The choices of a list rule. */
export function listChoices(rule: DvRule, ctx: Pick<DvContext, "listValues">): string[] {
  const raw = rule.source ? ctx.listValues(rule.source) : (rule.list ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const t = v.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

const parsed = new Map<string, Node | null>();
function formulaAst(formula: string): Node | null {
  let ast = parsed.get(formula);
  if (ast === undefined) {
    try {
      ast = parseFormula(formula.startsWith("=") ? formula : `=${formula}`);
    } catch {
      ast = null;
    }
    parsed.set(formula, ast);
  }
  return ast;
}

/** Does this value keep the rule? */
export function allowed(rule: DvRule, value: DvValue, row: number, col: number, ctx: DvContext): boolean {
  if (value === null || value === "") return rule.allowBlank !== false;
  const op = rule.op ?? "between";
  switch (rule.kind) {
    case "list": {
      const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
      return listChoices(rule, ctx).some((c) => c.toLowerCase() === text.toLowerCase() || (typeof value === "number" && Number(c) === value));
    }
    case "checkbox":
      return typeof value === "boolean";
    case "whole":
      return typeof value === "number" && Number.isInteger(value) && compare(op, value, rule.a ?? 0, rule.b);
    case "decimal":
    case "date":
      return typeof value === "number" && compare(op, value, rule.a ?? 0, rule.b);
    case "textLength": {
      const n = (typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value)).length;
      return compare(op, n, rule.a ?? 0, rule.b);
    }
    case "custom": {
      if (!rule.formula) return true;
      const base = formulaAst(rule.formula);
      if (!base) return false;
      const top = Math.min(...rule.ranges.map((r) => r.top));
      const left = Math.min(...rule.ranges.map((r) => r.left));
      const ast = moveFormula(base, row - top, col - left);
      if (!ast) return false;
      const r = ctx.evalAt(ast, row, col);
      return r === true || (typeof r === "number" && r !== 0);
    }
  }
}

/** A plain description of what the rule allows, for the default error message. */
export function describeDv(rule: DvRule, fmt: (n: number) => string = String): string {
  const op = rule.op ?? "between";
  const span = (unit: (n: number) => string) => {
    const a = unit(rule.a ?? 0);
    const b = unit(rule.b ?? rule.a ?? 0);
    return {
      between: `between ${a} and ${b}`,
      notBetween: `not between ${a} and ${b}`,
      "=": `equal to ${a}`,
      "!=": `not equal to ${a}`,
      ">": `greater than ${a}`,
      "<": `less than ${a}`,
      ">=": `${a} or more`,
      "<=": `${a} or less`,
    }[op];
  };
  switch (rule.kind) {
    case "list":
      return rule.source ? `one of the values in ${rule.source}` : `one of: ${(rule.list ?? []).slice(0, 8).join(", ")}${(rule.list ?? []).length > 8 ? ", …" : ""}`;
    case "checkbox":
      return "TRUE or FALSE (a tick box)";
    case "whole":
      return `a whole number ${span(String)}`;
    case "decimal":
      return `a number ${span(String)}`;
    case "date":
      return `a date ${span(fmt)}`;
    case "textLength":
      return `text with a length ${span(String)}`;
    case "custom":
      return `a value for which ${rule.formula} is TRUE`;
  }
}

/** The message shown when a value breaks the rule. */
export function errorText(rule: DvRule, fmt?: (n: number) => string): { title: string; message: string } {
  return {
    title: rule.errorTitle || (rule.errorStyle === "warning" ? "Check this value" : rule.errorStyle === "info" ? "Note" : "This value isn't allowed"),
    message: rule.errorMessage || `This cell takes ${describeDv(rule, fmt)}.`,
  };
}

/** Check a rule has what its kind needs; throws a plain message if not. */
export function checkDv(rule: DvRule): DvRule {
  const need = (ok: boolean, msg: string) => {
    if (!ok) throw new Error(msg);
  };
  need(rule.ranges.length > 0 && rule.ranges.every((x) => x.top <= x.bottom && x.left <= x.right), "Say which cells the rule is for.");
  if (rule.kind === "list") need(!!rule.source || (rule.list ?? []).some((v) => v.trim()), "Type the choices, or give a range that holds them.");
  if (["whole", "decimal", "date", "textLength"].includes(rule.kind)) {
    need(typeof rule.a === "number" && Number.isFinite(rule.a), "Type the value to compare with.");
    if (rule.op === "between" || rule.op === "notBetween" || rule.op === undefined) need(typeof rule.b === "number" && Number.isFinite(rule.b), "Type both ends of the range.");
  }
  if (rule.kind === "custom") {
    need(!!rule.formula && rule.formula.replace(/^=/, "").trim() !== "", "Type a formula.");
    if (!formulaAst(rule.formula!)) throw new Error("The formula has a problem; check its brackets and names.");
  }
  return rule;
}

/** Ranges after rows or columns are inserted / deleted. */
export function spliceRanged<T extends { ranges: CellRange[] }>(rules: readonly T[], axis: "row" | "col", at: number, remove: number, insert: number): T[] {
  const lo = axis === "row" ? "top" : "left";
  const hi = axis === "row" ? "bottom" : "right";
  const out: T[] = [];
  for (const rule of rules) {
    const ranges: CellRange[] = [];
    for (const r0 of rule.ranges) {
      const r = { ...r0 };
      if (remove) {
        const end = at + remove - 1;
        if (r[lo] > end) {
          r[lo] -= remove;
          r[hi] -= remove;
        } else if (r[hi] >= at) {
          const keep = Math.max(0, at - r[lo]) + Math.max(0, r[hi] - end);
          if (!keep) continue;
          r[lo] = Math.min(r[lo], at);
          r[hi] = r[lo] + keep - 1;
        }
      }
      if (insert) {
        if (r[lo] >= at) {
          r[lo] += insert;
          r[hi] += insert;
        } else if (r[hi] >= at) r[hi] += insert;
      }
      ranges.push(r);
    }
    if (ranges.length) out.push({ ...rule, ranges });
  }
  return out;
}

/** The parts of range a not covered by range b (up to four rectangles). */
export function subtractRange(a: CellRange, b: CellRange): CellRange[] {
  if (b.right < a.left || b.left > a.right || b.bottom < a.top || b.top > a.bottom) return [{ ...a }];
  const out: CellRange[] = [];
  if (a.top < b.top) out.push({ top: a.top, left: a.left, bottom: b.top - 1, right: a.right });
  if (a.bottom > b.bottom) out.push({ top: b.bottom + 1, left: a.left, bottom: a.bottom, right: a.right });
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (a.left < b.left) out.push({ top, left: a.left, bottom, right: b.left - 1 });
  if (a.right > b.right) out.push({ top, left: b.right + 1, bottom, right: a.right });
  return out;
}
