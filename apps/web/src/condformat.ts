/**
 * Conditional formatting: rules that change how cells look depending on
 * their values. Rules are plain data (saved with the file, carried by
 * actions); applying them to a cell gives a style overlay, a data bar or an
 * icon. Statistics a rule needs over its whole range (top 10, average,
 * duplicates, min/max for colour scales) are worked out once and kept until
 * the sheet changes.
 */
import { moveFormula, parseFormula, type Node } from "@cellforge/core";
import type { CellRange, CellStyle, CellValue } from "@cellforge/grid";
import { valueKey } from "./filter";
import { spliceRanged } from "./validation";

export interface CfFormat {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

export type CfCellOp = ">" | ">=" | "<" | "<=" | "=" | "!=" | "between" | "notBetween";
export type CfDateWhen = "yesterday" | "today" | "tomorrow" | "last7" | "lastWeek" | "thisWeek" | "nextWeek" | "lastMonth" | "thisMonth" | "nextMonth" | "past" | "future";

/** Where a colour scale / data bar point sits. */
export interface CfPoint {
  type: "min" | "max" | "number" | "percent" | "percentile";
  value?: number;
}

export type CfIconSet = "arrows3" | "traffic3" | "signs3" | "flags3" | "arrows5" | "ratings5";

export type CfRuleBody =
  | { kind: "cell"; op: CfCellOp; a: number | string; b?: number }
  | { kind: "text"; op: "contains" | "notContains" | "begins" | "ends"; value: string }
  | { kind: "date"; when: CfDateWhen }
  | { kind: "blanks" }
  | { kind: "noBlanks" }
  | { kind: "errors" }
  | { kind: "noErrors" }
  | { kind: "duplicates" }
  | { kind: "unique" }
  | { kind: "top"; n: number; percent?: boolean; bottom?: boolean }
  | { kind: "average"; below?: boolean; orEqual?: boolean }
  /** a formula written for the range's top-left cell, moved for each cell as Excel does */
  | { kind: "formula"; formula: string }
  | { kind: "scale"; min: CfPoint; mid?: CfPoint; max: CfPoint; colors: string[] }
  | { kind: "bar"; color: string; min?: CfPoint; max?: CfPoint; showValue?: boolean }
  | { kind: "icons"; set: CfIconSet; reverse?: boolean; showValue?: boolean };

export type CfRule = CfRuleBody & {
  id: string;
  ranges: CellRange[];
  format?: CfFormat;
  stopIfTrue?: boolean;
};

export interface CfSheet {
  getCell(row: number, col: number): CellValue;
  usedRange(): { rows: number; cols: number };
  /** evaluate a formula (already moved to the cell) at row, col */
  evalAt(ast: Node, row: number, col: number): unknown;
}

export interface CfResult {
  style: CellStyle;
  /** data bar: fractions of the cell width it covers */
  bar?: { from: number; to: number; color: string };
  icon?: { glyph: string; color: string };
  /** hide the value (data bar / icon set "show bar only") */
  hideValue?: boolean;
}

const ICONS: Record<CfIconSet, { glyph: string; color: string }[]> = {
  arrows3: [
    { glyph: "▼", color: "#d93025" },
    { glyph: "▶", color: "#f29900" },
    { glyph: "▲", color: "#188038" },
  ],
  traffic3: [
    { glyph: "●", color: "#d93025" },
    { glyph: "●", color: "#f9ab00" },
    { glyph: "●", color: "#188038" },
  ],
  signs3: [
    { glyph: "◆", color: "#d93025" },
    { glyph: "▲", color: "#f9ab00" },
    { glyph: "●", color: "#188038" },
  ],
  flags3: [
    { glyph: "⚑", color: "#d93025" },
    { glyph: "⚑", color: "#f9ab00" },
    { glyph: "⚑", color: "#188038" },
  ],
  arrows5: [
    { glyph: "▼", color: "#d93025" },
    { glyph: "◢", color: "#f29900" },
    { glyph: "▶", color: "#f9ab00" },
    { glyph: "◥", color: "#7cb342" },
    { glyph: "▲", color: "#188038" },
  ],
  ratings5: [
    { glyph: "▁", color: "#1a73e8" },
    { glyph: "▃", color: "#1a73e8" },
    { glyph: "▅", color: "#1a73e8" },
    { glyph: "▆", color: "#1a73e8" },
    { glyph: "█", color: "#1a73e8" },
  ],
};

export const ICON_SETS = Object.keys(ICONS) as CfIconSet[];

const inRange = (r: CellRange, row: number, col: number) => row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;

interface Stats {
  numbers: number[]; // sorted
  counts: Map<string, number>;
  sum: number;
}

/** Day number (Excel serial) of today in local time. */
function todaySerial(now: Date): number {
  return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function dateMatches(serial: number, when: CfDateWhen, now: Date): boolean {
  const d = Math.floor(serial);
  const t = todaySerial(now);
  const weekday = (t + 6) % 7; // 0 = Sunday, as Excel's weeks start on Sunday
  const weekStart = t - weekday;
  const ym = (s: number) => {
    const dt = new Date(Date.UTC(1899, 11, 30) + s * 86_400_000);
    return dt.getUTCFullYear() * 12 + dt.getUTCMonth();
  };
  switch (when) {
    case "yesterday":
      return d === t - 1;
    case "today":
      return d === t;
    case "tomorrow":
      return d === t + 1;
    case "last7":
      return d > t - 7 && d <= t;
    case "lastWeek":
      return d >= weekStart - 7 && d < weekStart;
    case "thisWeek":
      return d >= weekStart && d < weekStart + 7;
    case "nextWeek":
      return d >= weekStart + 7 && d < weekStart + 14;
    case "lastMonth":
      return ym(d) === ym(t) - 1;
    case "thisMonth":
      return ym(d) === ym(t);
    case "nextMonth":
      return ym(d) === ym(t) + 1;
    case "past":
      return d < t;
    case "future":
      return d > t;
  }
}

/** Cells show errors as their code, e.g. #N/A. */
const isError = (v: CellValue) => typeof v === "string" && /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|ERROR!|CYCLE!)$/.test(v);

/** Mix two #rrggbb colours. */
function mix(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/**
 * The rules of one sheet, ready to apply. Make a new one (or call
 * invalidate) when the sheet's values change.
 */
export class CondFormatter {
  private stats = new Map<string, Stats>();
  private moved = new Map<string, Node | null>();
  private readonly parsed = new Map<string, Node | null>();

  constructor(
    private readonly sheet: CfSheet,
    private rules: readonly CfRule[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  setRules(rules: readonly CfRule[]): void {
    this.rules = rules;
    this.invalidate();
  }

  invalidate(): void {
    this.stats.clear();
    this.moved.clear();
  }

  get hasRules(): boolean {
    return this.rules.length > 0;
  }

  private statsFor(rule: CfRule): Stats {
    let s = this.stats.get(rule.id);
    if (s) return s;
    const { rows, cols } = this.sheet.usedRange();
    const numbers: number[] = [];
    const counts = new Map<string, number>();
    let sum = 0;
    for (const r of rule.ranges) {
      for (let row = r.top; row <= Math.min(r.bottom, rows - 1); row++) {
        for (let col = r.left; col <= Math.min(r.right, cols - 1); col++) {
          const v = this.sheet.getCell(row, col);
          if (typeof v === "number") {
            numbers.push(v);
            sum += v;
          }
          if (v !== null && v !== "") counts.set(valueKey(v), (counts.get(valueKey(v)) ?? 0) + 1);
        }
      }
    }
    numbers.sort((a, b) => a - b);
    s = { numbers, counts, sum };
    this.stats.set(rule.id, s);
    return s;
  }

  /** The number a scale / bar point stands for. */
  private pointValue(p: CfPoint, s: Stats, fallback: "min" | "max"): number {
    const lo = s.numbers[0] ?? 0;
    const hi = s.numbers[s.numbers.length - 1] ?? 0;
    switch (p.type) {
      case "min":
        return lo;
      case "max":
        return hi;
      case "number":
        return p.value ?? (fallback === "min" ? lo : hi);
      case "percent":
        return lo + ((hi - lo) * (p.value ?? 50)) / 100;
      case "percentile": {
        if (!s.numbers.length) return 0;
        const pos = ((p.value ?? 50) / 100) * (s.numbers.length - 1);
        const i = Math.floor(pos);
        const f = pos - i;
        return s.numbers[i] + ((s.numbers[Math.min(i + 1, s.numbers.length - 1)] ?? s.numbers[i]) - s.numbers[i]) * f;
      }
    }
  }

  private formulaAt(rule: CfRule & { kind: "formula" }, row: number, col: number): unknown {
    const top = Math.min(...rule.ranges.map((r) => r.top));
    const left = Math.min(...rule.ranges.map((r) => r.left));
    let base = this.parsed.get(rule.formula);
    if (base === undefined) {
      try {
        const text = rule.formula.startsWith("=") ? rule.formula : `=${rule.formula}`;
        base = parseFormula(text);
      } catch {
        base = null;
      }
      this.parsed.set(rule.formula, base);
    }
    if (!base) return null;
    const k = `${rule.id}:${row - top}:${col - left}`;
    let ast = this.moved.get(k);
    if (ast === undefined) {
      ast = moveFormula(base, row - top, col - left);
      if (this.moved.size > 50_000) this.moved.clear();
      this.moved.set(k, ast);
    }
    return ast ? this.sheet.evalAt(ast, row, col) : null;
  }

  /** Does a highlight rule hold for this value? */
  private holds(rule: CfRule, v: CellValue, row: number, col: number): boolean {
    switch (rule.kind) {
      case "cell": {
        if (typeof rule.a === "string") {
          const t = typeof v === "string" ? v.toLowerCase() : String(v ?? "").toLowerCase();
          const a = rule.a.toLowerCase();
          return rule.op === "=" ? t === a : rule.op === "!=" ? t !== a : false;
        }
        if (typeof v !== "number") return false;
        const a = rule.a;
        const b = rule.b ?? a;
        switch (rule.op) {
          case ">":
            return v > a;
          case ">=":
            return v >= a;
          case "<":
            return v < a;
          case "<=":
            return v <= a;
          case "=":
            return v === a;
          case "!=":
            return v !== a;
          case "between":
            return v >= Math.min(a, b) && v <= Math.max(a, b);
          case "notBetween":
            return v < Math.min(a, b) || v > Math.max(a, b);
        }
        return false;
      }
      case "text": {
        const t = (v === null ? "" : String(v)).toLowerCase();
        const w = rule.value.toLowerCase();
        return rule.op === "contains" ? t.includes(w) : rule.op === "notContains" ? !t.includes(w) : rule.op === "begins" ? t.startsWith(w) : t.endsWith(w);
      }
      case "date":
        return typeof v === "number" && dateMatches(v, rule.when, this.now());
      case "blanks":
        return v === null || v === "";
      case "noBlanks":
        return !(v === null || v === "");
      case "errors":
        return isError(v);
      case "noErrors":
        return !isError(v);
      case "duplicates":
      case "unique": {
        if (v === null || v === "") return false;
        const n = this.statsFor(rule).counts.get(valueKey(v)) ?? 0;
        return rule.kind === "duplicates" ? n > 1 : n === 1;
      }
      case "top": {
        if (typeof v !== "number") return false;
        const nums = this.statsFor(rule).numbers;
        if (!nums.length) return false;
        const n = Math.max(1, rule.percent ? Math.floor((nums.length * rule.n) / 100) : Math.floor(rule.n));
        return rule.bottom ? v <= nums[Math.min(n, nums.length) - 1] : v >= nums[Math.max(0, nums.length - n)];
      }
      case "average": {
        if (typeof v !== "number") return false;
        const s = this.statsFor(rule);
        if (!s.numbers.length) return false;
        const avg = s.sum / s.numbers.length;
        return rule.below ? (rule.orEqual ? v <= avg : v < avg) : rule.orEqual ? v >= avg : v > avg;
      }
      case "formula": {
        const r = this.formulaAt(rule, row, col);
        return r === true || (typeof r === "number" && r !== 0);
      }
      default:
        return false;
    }
  }

  /** What the rules do to one cell, or null when none apply. */
  apply(row: number, col: number): CfResult | null {
    if (!this.rules.length) return null;
    let out: CfResult | null = null;
    let v: CellValue | undefined;
    for (const rule of this.rules) {
      if (!rule.ranges.some((r) => inRange(r, row, col))) continue;
      if (v === undefined) v = this.sheet.getCell(row, col);
      out ??= { style: {} };
      if (rule.kind === "scale") {
        if (typeof v !== "number") continue;
        const s = this.statsFor(rule);
        const lo = this.pointValue(rule.min, s, "min");
        const hi = this.pointValue(rule.max, s, "max");
        let color: string;
        if (rule.mid && rule.colors.length >= 3) {
          const mid = this.pointValue(rule.mid, s, "min");
          color = v <= mid ? mix(rule.colors[0], rule.colors[1], mid > lo ? Math.max(0, (v - lo) / (mid - lo)) : 1) : mix(rule.colors[1], rule.colors[2], hi > mid ? Math.min(1, (v - mid) / (hi - mid)) : 1);
        } else {
          const t = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
          color = mix(rule.colors[0], rule.colors[rule.colors.length - 1], t);
        }
        if (out.style.fill === undefined) out.style.fill = color;
      } else if (rule.kind === "bar") {
        if (typeof v !== "number" || out.bar) continue;
        const s = this.statsFor(rule);
        let lo = this.pointValue(rule.min ?? { type: "min" }, s, "min");
        const hi = this.pointValue(rule.max ?? { type: "max" }, s, "max");
        // bars grow from zero when the range has negative numbers
        if (lo > 0 && (rule.min?.type ?? "min") === "min") lo = 0;
        const span = hi - lo || 1;
        const zero = Math.min(1, Math.max(0, (0 - lo) / span));
        const at = Math.min(1, Math.max(0, (v - lo) / span));
        out.bar = { from: Math.min(zero, at), to: Math.max(zero, at), color: v < 0 ? "#d93025" : rule.color };
        if (rule.showValue === false) out.hideValue = true;
      } else if (rule.kind === "icons") {
        if (typeof v !== "number" || out.icon) continue;
        const s = this.statsFor(rule);
        const set = ICONS[rule.set];
        const lo = s.numbers[0] ?? 0;
        const hi = s.numbers[s.numbers.length - 1] ?? 0;
        // equal percent bands of the range, as Excel's defaults
        let i = hi > lo ? Math.min(set.length - 1, Math.floor(((v - lo) / (hi - lo)) * set.length)) : set.length - 1;
        if (rule.reverse) i = set.length - 1 - i;
        out.icon = set[i];
        if (rule.showValue === false) out.hideValue = true;
      } else if (this.holds(rule, v, row, col)) {
        const f = rule.format ?? {};
        for (const k of ["fill", "color", "bold", "italic", "strike"] as const) {
          if (f[k] !== undefined && out.style[k] === undefined) (out.style as Record<string, unknown>)[k] = f[k];
        }
        if (rule.stopIfTrue) break;
      }
    }
    return out && (Object.keys(out.style).length || out.bar || out.icon) ? out : null;
  }
}

/** A fresh rule id for a sheet. */
export function newRuleId(rules: readonly CfRule[]): string {
  let n = rules.length + 1;
  while (rules.some((r) => r.id === `cf${n}`)) n++;
  return `cf${n}`;
}

const COLOR = /^#[0-9a-f]{6}$/i;

/** Check a rule has what its kind needs; throws a plain message if not. Returns the rule. */
export function checkRule(rule: CfRule): CfRule {
  const r = rule as CfRule & Record<string, unknown>;
  const need = (ok: boolean, msg: string) => {
    if (!ok) throw new Error(msg);
  };
  need(rule.ranges.length > 0 && rule.ranges.every((x) => x.top <= x.bottom && x.left <= x.right), "The rule needs a range of cells.");
  switch (rule.kind) {
    case "cell":
      need(typeof r.op === "string" && [">", ">=", "<", "<=", "=", "!=", "between", "notBetween"].includes(r.op as string), "Pick a comparison.");
      need(typeof r.a === "number" || (typeof r.a === "string" && (r.op === "=" || r.op === "!=")), "Type a number to compare with.");
      if (r.op === "between" || r.op === "notBetween") need(typeof r.b === "number", "Type both ends of the range.");
      break;
    case "text":
      need(typeof r.value === "string" && ["contains", "notContains", "begins", "ends"].includes(r.op as string), "Type the text to look for.");
      break;
    case "date":
      need(typeof r.when === "string", "Pick when.");
      break;
    case "top":
      need(typeof r.n === "number" && r.n > 0, "Type how many.");
      break;
    case "formula":
      need(typeof r.formula === "string" && r.formula.replace(/^=/, "").trim() !== "", "Type a formula.");
      try {
        const f = String(r.formula);
        parseFormula(f.startsWith("=") ? f : `=${f}`);
      } catch (e) {
        throw new Error(`The formula has a problem: ${(e as Error).message}`);
      }
      break;
    case "scale":
      need(Array.isArray(r.colors) && (r.colors as string[]).length >= 2 && (r.colors as string[]).every((c) => COLOR.test(c)), "A colour scale needs 2 or 3 colours like #63be7b.");
      need(!!r.min && !!r.max, "A colour scale needs a low and a high point.");
      break;
    case "bar":
      need(typeof r.color === "string" && COLOR.test(r.color), "Pick a bar colour like #638ec6.");
      break;
    case "icons":
      need(ICON_SETS.includes(r.set as CfIconSet), "Pick an icon set.");
      break;
  }
  const highlight = !["scale", "bar", "icons"].includes(rule.kind);
  if (highlight) need(!!rule.format && Object.values(rule.format).some((v) => v !== undefined), "Pick how matching cells look.");
  return rule;
}

/** Ranges after rows or columns are inserted / deleted (a range that loses all its cells goes). */
export function spliceRules(rules: readonly CfRule[], axis: "row" | "col", at: number, remove: number, insert: number): CfRule[] {
  return spliceRanged(rules, axis, at, remove, insert);
}

/** A short description for the rules manager. */
export function describeRule(rule: CfRule): string {
  switch (rule.kind) {
    case "cell":
      return rule.op === "between" || rule.op === "notBetween" ? `Value ${rule.op === "between" ? "between" : "not between"} ${rule.a} and ${rule.b}` : `Value ${rule.op} ${typeof rule.a === "string" ? `"${rule.a}"` : rule.a}`;
    case "text":
      return `Text ${{ contains: "contains", notContains: "doesn't contain", begins: "begins with", ends: "ends with" }[rule.op]} "${rule.value}"`;
    case "date":
      return `Date is ${{ yesterday: "yesterday", today: "today", tomorrow: "tomorrow", last7: "in the last 7 days", lastWeek: "last week", thisWeek: "this week", nextWeek: "next week", lastMonth: "last month", thisMonth: "this month", nextMonth: "next month", past: "in the past", future: "in the future" }[rule.when]}`;
    case "blanks":
      return "Blank";
    case "noBlanks":
      return "Not blank";
    case "errors":
      return "Errors";
    case "noErrors":
      return "No errors";
    case "duplicates":
      return "Duplicate values";
    case "unique":
      return "Unique values";
    case "top":
      return `${rule.bottom ? "Bottom" : "Top"} ${rule.n}${rule.percent ? "%" : ""}`;
    case "average":
      return `${rule.below ? "Below" : "Above"}${rule.orEqual ? " or equal to" : ""} average`;
    case "formula":
      return `Formula: ${rule.formula.startsWith("=") ? rule.formula : "=" + rule.formula}`;
    case "scale":
      return `Colour scale (${rule.colors.length} colours)`;
    case "bar":
      return "Data bar";
    case "icons":
      return `Icon set (${rule.set})`;
  }
}
