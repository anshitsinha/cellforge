import { describe, expect, it } from "vitest";
import { hardCodedNumbers, hasRefError, parseFormula, references, shape, steps, type EvalContext } from "../src/formula";

const ctx: EvalContext = {
  cell: (r, c) => (c === 0 ? (r + 1) * 10 : null),
  eachInRange: (range, visit) => {
    for (let r = range.top; r <= range.bottom; r++) for (let c = range.left; c <= range.right; c++) visit(c === 0 ? (r + 1) * 10 : null);
  },
};

describe("formula auditing", () => {
  it("lists what a formula reads, shifted for fills", () => {
    expect(references(parseFormula("=A1+SUM(B1:B3)+Data!C2+$D$1"), 2)).toEqual([
      { range: { top: 2, bottom: 2, left: 0, right: 0 } },
      { range: { top: 2, bottom: 4, left: 1, right: 1 } },
      { sheet: "Data", range: { top: 3, bottom: 3, left: 2, right: 2 } },
      { range: { top: 0, bottom: 0, left: 3, right: 3 } },
    ]);
  });

  it("breaks a formula into steps with values", () => {
    const s = steps(parseFormula("=ROUND(A1*1.2, 0)+A2"), ctx);
    expect(s.value).toBe("32");
    expect(s.children.map((c) => [c.text, c.value])).toEqual([
      ["ROUND(A1*1.2, 0)", "12"],
      ["A2", "20"],
    ]);
    expect(s.children[0].children[0].children.map((c) => c.value)).toEqual(["10", "1.2"]);
  });

  it("gives filled formulas the same shape and spots one that differs", () => {
    const a = shape(parseFormula("=A1*$B$1"), 0, 2);
    const b = shape(parseFormula("=A2*$B$1"), 1, 2);
    const odd = shape(parseFormula("=A2*1.1"), 2, 2);
    expect(a).toBe(b);
    expect(odd).not.toBe(a);
  });

  it("finds typed-in assumptions but not column numbers or rounding digits", () => {
    expect(hardCodedNumbers(parseFormula("=B2*1.2+VLOOKUP(A1, D:F, 3, FALSE)+ROUND(C1, 2)-0.05"))).toEqual([1.2, 0.05]);
    expect(hardCodedNumbers(parseFormula("=A1/12*100"))).toEqual([]);
    expect(hasRefError(parseFormula("=SUM(#REF!, A1)"))).toBe(true);
  });
});
