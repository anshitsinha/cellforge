/**
 * Data validation to and from Excel files. Excel keeps a list's choices as
 * one quoted, comma-separated string or a range; limits as formulas (plain
 * numbers here; dates are serial numbers). Tick boxes have no validation
 * equivalent in Excel, so they go out as a TRUE / FALSE list.
 */
import type { XValidation } from "@cellforge/core";
import type { DvOp, DvRule } from "./validation";

const OPS: Record<string, DvOp> = {
  between: "between",
  notBetween: "notBetween",
  equal: "=",
  notEqual: "!=",
  greaterThan: ">",
  lessThan: "<",
  greaterThanOrEqual: ">=",
  lessThanOrEqual: "<=",
};
const OPS_BACK = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k])) as Record<DvOp, string>;

const num = (f: string | undefined): number | undefined => {
  if (f === undefined) return undefined;
  const t = f.trim();
  return /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : undefined;
};

export function dvFromXlsx(list: readonly XValidation[] | undefined): { rules: DvRule[]; skipped: number } {
  const rules: DvRule[] = [];
  let skipped = 0;
  let n = 1;
  for (const x of list ?? []) {
    const base: DvRule = {
      id: `dv${n++}`,
      ranges: x.ranges.map((r) => ({ ...r })),
      kind: "list",
      ...(x.allowBlank === false ? { allowBlank: false } : {}),
      ...(x.dropdown === false ? { dropdown: false } : {}),
      ...(x.promptTitle ? { inputTitle: x.promptTitle } : {}),
      ...(x.prompt ? { inputMessage: x.prompt } : {}),
      ...(x.errorStyle && x.errorStyle !== "stop" ? { errorStyle: x.errorStyle as "warning" | "info" } : {}),
      ...(x.errorTitle ? { errorTitle: x.errorTitle } : {}),
      ...(x.error ? { errorMessage: x.error } : {}),
    };
    let rule: DvRule | null = null;
    if (x.type === "list" && x.formula1) {
      const f = x.formula1.trim();
      const q = /^"((?:[^"]|"")*)"$/.exec(f);
      rule = q ? { ...base, list: q[1].replace(/""/g, '"').split(",").map((s) => s.trim()).filter(Boolean) } : { ...base, source: f.replace(/^=/, "") };
    } else if (["whole", "decimal", "date", "textLength"].includes(x.type)) {
      const op = OPS[x.operator ?? "between"] ?? "between";
      const a = num(x.formula1);
      const b = num(x.formula2);
      if (a !== undefined && (op !== "between" && op !== "notBetween" ? true : b !== undefined)) rule = { ...base, kind: x.type as DvRule["kind"], op, a, ...(b !== undefined ? { b } : {}) };
    } else if (x.type === "custom" && x.formula1) rule = { ...base, kind: "custom", formula: `=${x.formula1}` };
    if (rule) rules.push(rule);
    else skipped++;
  }
  return { rules, skipped };
}

export function dvToXlsx(rules: readonly DvRule[]): XValidation[] {
  return rules.map((r) => {
    const v: XValidation = {
      ranges: r.ranges.map((x) => ({ ...x })),
      type: r.kind === "checkbox" ? "list" : r.kind,
      ...(r.allowBlank === false ? { allowBlank: false } : {}),
      ...(r.dropdown === false ? { dropdown: false } : {}),
      ...(r.inputTitle ? { promptTitle: r.inputTitle } : {}),
      ...(r.inputMessage ? { prompt: r.inputMessage } : {}),
      ...(r.errorStyle && r.errorStyle !== "stop" ? { errorStyle: r.errorStyle } : {}),
      ...(r.errorTitle ? { errorTitle: r.errorTitle } : {}),
      ...(r.errorMessage ? { error: r.errorMessage } : {}),
    };
    if (r.kind === "checkbox") v.formula1 = '"TRUE,FALSE"';
    else if (r.kind === "list") v.formula1 = r.source ?? `"${(r.list ?? []).join(",").replace(/"/g, '""')}"`;
    else if (r.kind === "custom") v.formula1 = (r.formula ?? "").replace(/^=/, "");
    else {
      v.operator = OPS_BACK[r.op ?? "between"];
      v.formula1 = String(r.a ?? 0);
      if (r.b !== undefined && (r.op === "between" || r.op === "notBetween" || r.op === undefined)) v.formula2 = String(r.b);
    }
    return v;
  });
}
