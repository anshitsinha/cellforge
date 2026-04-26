import { describe, expect, it } from "vitest";
import { CellError, evaluate, parseFormula, type EvalContext, type Scalar } from "../src/formula";

const cells: Record<string, Scalar> = { A1: 1, A2: "1", A3: true, A4: null, A5: "apple", B1: "North", B2: "Nest", B3: "south", B4: "N*rth", B5: 5 };
const at = (r: number, c: number) => cells[`${String.fromCharCode(65 + c)}${r + 1}`] ?? null;
const ctx: EvalContext = {
  cell: at,
  eachInRange: (range, visit) => {
    for (let r = range.top; r <= Math.min(range.bottom, 9); r++) for (let c = range.left; c <= range.right; c++) visit(at(r, c));
  },
};
const ev = (f: string) => {
  const v = evaluate(parseFormula(f), ctx, 0);
  return v instanceof CellError ? v.code : v;
};

describe("Excel's type rules", () => {
  it("compares across types the way Excel does", () => {
    expect(ev("=A1=A2")).toBe(false); // 1 = "1"
    expect(ev("=A1<A2")).toBe(true); // numbers sort before text
    expect(ev("=A2<A3")).toBe(true); // text before booleans
    expect(ev('="a"="A"')).toBe(true); // text ignores case
    expect(ev("=TRUE>FALSE")).toBe(true);
    expect(ev("=A4=0")).toBe(true); // empty is 0 next to a number
    expect(ev('=A4=""')).toBe(true); // and "" next to text
    expect(ev("=A4=FALSE")).toBe(true);
  });

  it("does arithmetic on text that looks like a number", () => {
    expect(ev("=A2+1")).toBe(2);
    expect(ev('="10%"*2')).toBe(0.2);
    expect(ev('="$1,200"+1')).toBe(1201);
    expect(ev('="2024-01-15"+1')).toBe(45307);
    expect(ev("=A5+1")).toBe("#VALUE!");
    expect(ev("=TRUE+TRUE")).toBe(2);
  });

  it("SUM skips text and booleans in ranges but counts them as arguments", () => {
    expect(ev("=SUM(A1:A5)")).toBe(1);
    expect(ev("=SUM(TRUE, 2)")).toBe(3);
  });

  it("COUNTIF understands wildcards", () => {
    expect(ev('=COUNTIF(B1:B5, "N*")')).toBe(3);
    expect(ev('=COUNTIF(B1:B5, "N?st")')).toBe(1);
    expect(ev('=COUNTIF(B1:B5, "N~*rth")')).toBe(1);
    expect(ev('=COUNTIF(B1:B5, "<>N*")')).toBe(2);
    expect(ev('=COUNTIF(B1:B5, "SOUTH")')).toBe(1);
  });
});
