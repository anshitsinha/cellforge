import { describe, expect, it } from "vitest";
import { readXlsx, writeXlsx } from "@cellforge/core";
import type { CfRule } from "./condformat";
import { cfFromXlsx, cfToXlsx } from "./cfxlsx";
import { BlankSource, EditableSource } from "./editable";
import { workbookFromXlsx, workbookToXlsx } from "./xlsxio";
import { Workbook } from "./workbook";

const range = { top: 1, left: 1, bottom: 9, right: 2 };
const red = { fill: "#ffc7ce", color: "#9c0006" };
type NoId = CfRule extends infer R ? (R extends CfRule ? Omit<R, "id"> : never) : never;
const RULES: NoId[] = [
  { kind: "cell", op: "between", a: 10, b: 20, ranges: [range], format: red, stopIfTrue: true },
  { kind: "cell", op: "=", a: 'say "hi"', ranges: [range], format: { bold: true } },
  { kind: "text", op: "begins", value: "INV", ranges: [range], format: { italic: true } },
  { kind: "date", when: "last7", ranges: [range], format: red },
  { kind: "blanks", ranges: [range], format: { fill: "#eeeeee" } },
  { kind: "duplicates", ranges: [range], format: red },
  { kind: "top", n: 10, percent: true, bottom: true, ranges: [range], format: red },
  { kind: "average", below: true, ranges: [range], format: red },
  { kind: "formula", formula: "=$C2>100", ranges: [range], format: { strike: true } },
  { kind: "scale", min: { type: "min" }, mid: { type: "percentile", value: 50 }, max: { type: "max" }, colors: ["#f8696b", "#ffeb84", "#63be7b"], ranges: [range] },
  { kind: "bar", color: "#638ec6", min: { type: "min" }, max: { type: "number", value: 500 }, showValue: false, ranges: [range] },
  { kind: "icons", set: "traffic3", reverse: true, ranges: [range] },
];

const strip = (r: CfRule) => {
  const { id: _id, ...rest } = r;
  return rest;
};

describe("conditional formatting in Excel files", () => {
  it("survives a round trip through .xlsx, in priority order", async () => {
    const src = new EditableSource(new BlankSource(20, 4));
    src.setCondFormats(RULES.map((r, i) => ({ ...r, id: `r${i}` }) as CfRule));
    const wb = new Workbook({ name: "Sheet1", source: src });
    const bytes = await writeXlsx(workbookToXlsx(wb));
    const back = workbookFromXlsx(await readXlsx(bytes));
    const rules = back.sheets[0].source.condFormats.map(strip);
    expect(rules).toEqual(RULES);
  });

  it("writes the formulas Excel needs for text and date rules", () => {
    const [text, date] = cfToXlsx([RULES[2], RULES[3]].map((r, i) => ({ ...r, id: String(i) }) as CfRule));
    expect(text.formulas).toEqual(['LEFT(B2,LEN("INV"))="INV"']);
    expect(date.timePeriod).toBe("last7Days");
    expect(date.formulas[0]).toContain("TODAY()");
  });

  it("leaves out rules it can't show, and counts them", () => {
    const { rules, skipped } = cfFromXlsx([
      { type: "cellIs", operator: "greaterThan", formulas: ["$Z$1"], ranges: [range], dxf: red },
      { type: "dataBar", formulas: [], ranges: [range], colors: ["#638ec6"] },
    ]);
    expect(rules.map((r) => r.kind)).toEqual(["bar"]);
    expect(skipped).toBe(1);
  });
});
