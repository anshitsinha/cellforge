/**
 * Conditional formatting to and from Excel files. Excel wants a formula on
 * text, blank, error and date rules (written for the range's top-left
 * cell), so those are generated on the way out; on the way in, the rule
 * type and its attributes are enough.
 */
import { columnLetter } from "@cellforge/grid";
import type { XCfvo, XCondFormat } from "@cellforge/core";
import type { CfCellOp, CfDateWhen, CfIconSet, CfPoint, CfRule } from "./condformat";

const OPS: Record<string, CfCellOp> = {
  greaterThan: ">",
  greaterThanOrEqual: ">=",
  lessThan: "<",
  lessThanOrEqual: "<=",
  equal: "=",
  notEqual: "!=",
  between: "between",
  notBetween: "notBetween",
};
const OPS_BACK = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k])) as Record<CfCellOp, string>;

const PERIODS: Record<string, CfDateWhen> = {
  yesterday: "yesterday",
  today: "today",
  tomorrow: "tomorrow",
  last7Days: "last7",
  lastWeek: "lastWeek",
  thisWeek: "thisWeek",
  nextWeek: "nextWeek",
  lastMonth: "lastMonth",
  thisMonth: "thisMonth",
  nextMonth: "nextMonth",
};
const PERIODS_BACK = Object.fromEntries(Object.entries(PERIODS).map(([k, v]) => [v, k])) as Record<string, string>;

const ICONS: Record<string, CfIconSet> = {
  "3Arrows": "arrows3",
  "3ArrowsGray": "arrows3",
  "3TrafficLights1": "traffic3",
  "3TrafficLights2": "traffic3",
  "3Signs": "signs3",
  "3Flags": "flags3",
  "5Arrows": "arrows5",
  "5ArrowsGray": "arrows5",
  "5Rating": "ratings5",
  "4Rating": "ratings5",
};
const ICONS_BACK: Record<CfIconSet, string> = { arrows3: "3Arrows", traffic3: "3TrafficLights1", signs3: "3Signs", flags3: "3Flags", arrows5: "5Arrows", ratings5: "5Rating" };

let nextId = 1;
const id = () => `x${nextId++}`;

/** A cellIs operand: a number, a quoted string, or (unsupported) a formula. */
function operand(f: string | undefined): number | string | null {
  if (f === undefined) return null;
  const t = f.trim();
  if (/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return Number(t);
  const q = /^"((?:[^"]|"")*)"$/.exec(t);
  return q ? q[1].replace(/""/g, '"') : null;
}

function point(v: XCfvo | undefined, fallback: CfPoint["type"]): CfPoint {
  if (!v) return { type: fallback };
  const type = v.type === "num" ? "number" : v.type === "percent" || v.type === "percentile" || v.type === "min" || v.type === "max" ? v.type : v.type === "lowValue" ? "min" : v.type === "highValue" ? "max" : fallback;
  const value = v.val !== undefined && !Number.isNaN(Number(v.val)) ? Number(v.val) : undefined;
  return value !== undefined && type !== "min" && type !== "max" ? { type, value } : { type };
}

/** Excel rules as ours; ones we can't show are left out (counted in `skipped`). */
export function cfFromXlsx(list: readonly XCondFormat[] | undefined): { rules: CfRule[]; skipped: number } {
  const rules: CfRule[] = [];
  let skipped = 0;
  for (const x of list ?? []) {
    const base = { id: id(), ranges: x.ranges.map((r) => ({ ...r })), ...(x.stopIfTrue ? { stopIfTrue: true } : {}) };
    const format = x.dxf ? { ...x.dxf } : undefined;
    const hl = (body: object): CfRule | null => (format && Object.keys(format).length ? ({ ...base, ...body, format } as CfRule) : null);
    let rule: CfRule | null = null;
    switch (x.type) {
      case "cellIs": {
        const op = OPS[x.operator ?? ""];
        const a = operand(x.formulas[0]);
        const b = operand(x.formulas[1]);
        if (op && a !== null && (op !== "between" && op !== "notBetween" ? true : typeof b === "number")) rule = hl({ kind: "cell", op, a, ...(typeof b === "number" ? { b } : {}) });
        break;
      }
      case "containsText":
      case "notContainsText":
      case "beginsWith":
      case "endsWith":
        if (x.text !== undefined) rule = hl({ kind: "text", op: { containsText: "contains", notContainsText: "notContains", beginsWith: "begins", endsWith: "ends" }[x.type], value: x.text });
        break;
      case "timePeriod":
        if (PERIODS[x.timePeriod ?? ""]) rule = hl({ kind: "date", when: PERIODS[x.timePeriod!] });
        break;
      case "containsBlanks":
        rule = hl({ kind: "blanks" });
        break;
      case "notContainsBlanks":
        rule = hl({ kind: "noBlanks" });
        break;
      case "containsErrors":
        rule = hl({ kind: "errors" });
        break;
      case "notContainsErrors":
        rule = hl({ kind: "noErrors" });
        break;
      case "duplicateValues":
        rule = hl({ kind: "duplicates" });
        break;
      case "uniqueValues":
        rule = hl({ kind: "unique" });
        break;
      case "top10":
        rule = hl({ kind: "top", n: x.rank ?? 10, ...(x.percent ? { percent: true } : {}), ...(x.bottom ? { bottom: true } : {}) });
        break;
      case "aboveAverage":
        rule = hl({ kind: "average", ...(x.aboveAverage === false ? { below: true } : {}), ...(x.equalAverage ? { orEqual: true } : {}) });
        break;
      case "expression":
        if (x.formulas[0]) rule = hl({ kind: "formula", formula: `=${x.formulas[0]}` });
        break;
      case "colorScale": {
        const colors = x.colors ?? [];
        if (colors.length >= 2) {
          const pts = x.cfvos ?? [];
          rule = {
            ...base,
            kind: "scale",
            min: point(pts[0], "min"),
            max: point(pts[pts.length - 1], "max"),
            ...(colors.length >= 3 ? { mid: point(pts[1], "percentile") } : {}),
            colors: colors.slice(0, 3),
          } as CfRule;
        }
        break;
      }
      case "dataBar":
        rule = {
          ...base,
          kind: "bar",
          color: x.colors?.[0] ?? "#638ec6",
          min: point(x.cfvos?.[0], "min"),
          max: point(x.cfvos?.[1], "max"),
          ...(x.showValue === false ? { showValue: false } : {}),
        } as CfRule;
        break;
      case "iconSet":
        if (ICONS[x.iconSet ?? ""]) rule = { ...base, kind: "icons", set: ICONS[x.iconSet!], ...(x.reverse ? { reverse: true } : {}), ...(x.showValue === false ? { showValue: false } : {}) } as CfRule;
        break;
    }
    if (rule) rules.push(rule);
    else skipped++;
  }
  return { rules, skipped };
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function cfvo(p: CfPoint | undefined, fallback: "min" | "max"): XCfvo {
  const q = p ?? { type: fallback };
  if (q.type === "min" || q.type === "max") return { type: q.type };
  return { type: q.type === "number" ? "num" : q.type, val: String(q.value ?? 50) };
}

/** Our rules as Excel's. */
export function cfToXlsx(rules: readonly CfRule[]): XCondFormat[] {
  return rules.map((r) => {
    const tl = r.ranges.reduce((a, x) => ({ row: Math.min(a.row, x.top), col: Math.min(a.col, x.left) }), { row: Infinity, col: Infinity });
    const A = `${columnLetter(tl.col)}${tl.row + 1}`;
    const base = { ranges: r.ranges.map((x) => ({ ...x })), formulas: [] as string[], ...(r.stopIfTrue ? { stopIfTrue: true } : {}), ...(r.format ? { dxf: { ...r.format } } : {}) };
    switch (r.kind) {
      case "cell":
        return {
          ...base,
          type: "cellIs",
          operator: OPS_BACK[r.op],
          formulas: [typeof r.a === "number" ? String(r.a) : quote(r.a), ...(r.b !== undefined && (r.op === "between" || r.op === "notBetween") ? [String(r.b)] : [])],
        };
      case "text": {
        const t = quote(r.value);
        const [type, f] = {
          contains: ["containsText", `NOT(ISERROR(SEARCH(${t},${A})))`],
          notContains: ["notContainsText", `ISERROR(SEARCH(${t},${A}))`],
          begins: ["beginsWith", `LEFT(${A},LEN(${t}))=${t}`],
          ends: ["endsWith", `RIGHT(${A},LEN(${t}))=${t}`],
        }[r.op];
        return { ...base, type, operator: type, text: r.value, formulas: [f] };
      }
      case "date": {
        if (r.when === "past" || r.when === "future") return { ...base, type: "expression", formulas: [`AND(ISNUMBER(${A}),${A}${r.when === "past" ? "<" : ">="}TODAY()${r.when === "future" ? "+1" : ""})`] };
        const d = `FLOOR(${A},1)`;
        const f: Record<string, string> = {
          yesterday: `${d}=TODAY()-1`,
          today: `${d}=TODAY()`,
          tomorrow: `${d}=TODAY()+1`,
          last7: `AND(TODAY()-${d}<=6,${d}<=TODAY())`,
          lastWeek: `AND(TODAY()-ROUNDDOWN(${A},0)>=(WEEKDAY(TODAY())),TODAY()-ROUNDDOWN(${A},0)<(WEEKDAY(TODAY())+7))`,
          thisWeek: `AND(TODAY()-ROUNDDOWN(${A},0)<=WEEKDAY(TODAY())-1,ROUNDDOWN(${A},0)-TODAY()<=7-WEEKDAY(TODAY()))`,
          nextWeek: `AND(ROUNDDOWN(${A},0)-TODAY()>(7-WEEKDAY(TODAY())),ROUNDDOWN(${A},0)-TODAY()<(15-WEEKDAY(TODAY())))`,
          lastMonth: `AND(MONTH(${A})=MONTH(EDATE(TODAY(),0-1)),YEAR(${A})=YEAR(EDATE(TODAY(),0-1)))`,
          thisMonth: `AND(MONTH(${A})=MONTH(TODAY()),YEAR(${A})=YEAR(TODAY()))`,
          nextMonth: `AND(MONTH(${A})=MONTH(EDATE(TODAY(),0+1)),YEAR(${A})=YEAR(EDATE(TODAY(),0+1)))`,
        };
        return { ...base, type: "timePeriod", timePeriod: PERIODS_BACK[r.when], formulas: [f[r.when]] };
      }
      case "blanks":
        return { ...base, type: "containsBlanks", formulas: [`LEN(TRIM(${A}))=0`] };
      case "noBlanks":
        return { ...base, type: "notContainsBlanks", formulas: [`LEN(TRIM(${A}))>0`] };
      case "errors":
        return { ...base, type: "containsErrors", formulas: [`ISERROR(${A})`] };
      case "noErrors":
        return { ...base, type: "notContainsErrors", formulas: [`NOT(ISERROR(${A}))`] };
      case "duplicates":
        return { ...base, type: "duplicateValues" };
      case "unique":
        return { ...base, type: "uniqueValues" };
      case "top":
        return { ...base, type: "top10", rank: r.n, ...(r.percent ? { percent: true } : {}), ...(r.bottom ? { bottom: true } : {}) };
      case "average":
        return { ...base, type: "aboveAverage", ...(r.below ? { aboveAverage: false } : {}), ...(r.orEqual ? { equalAverage: true } : {}) };
      case "formula":
        return { ...base, type: "expression", formulas: [r.formula.replace(/^=/, "")] };
      case "scale":
        return {
          ...base,
          type: "colorScale",
          cfvos: [cfvo(r.min, "min"), ...(r.mid && r.colors.length >= 3 ? [cfvo(r.mid, "min")] : []), cfvo(r.max, "max")],
          colors: r.colors.slice(0, r.mid ? 3 : 2),
        };
      case "bar":
        return { ...base, type: "dataBar", cfvos: [cfvo(r.min, "min"), cfvo(r.max, "max")], colors: [r.color], ...(r.showValue === false ? { showValue: false } : {}) };
      case "icons": {
        const n = r.set.endsWith("5") ? 5 : 3;
        return {
          ...base,
          type: "iconSet",
          iconSet: ICONS_BACK[r.set],
          cfvos: Array.from({ length: n }, (_, i) => ({ type: "percent", val: String(Math.round((i * 100) / n)) })),
          ...(r.reverse ? { reverse: true } : {}),
          ...(r.showValue === false ? { showValue: false } : {}),
        };
      }
    }
  });
}
