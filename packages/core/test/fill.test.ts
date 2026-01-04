import { describe, expect, it } from "vitest";
import { evaluate, formatFormula, parseFormula, type EvalContext } from "../src/formula";

describe("formatFormula", () => {
  const roundTrip = (f: string) => formatFormula(parseFormula(f));

  it("round-trips formulas, keeping only needed parentheses", () => {
    expect(roundTrip("=A1+B1*2")).toBe("=A1+B1*2");
    expect(roundTrip("=(A1+B1)*2")).toBe("=(A1+B1)*2");
    expect(roundTrip("=((A1))")).toBe("=A1");
    expect(roundTrip("=2^3^2")).toBe("=2^3^2");
    expect(roundTrip("=(2^3)^2")).toBe("=(2^3)^2");
    expect(roundTrip("=A1-(B1-C1)")).toBe("=A1-(B1-C1)");
    expect(roundTrip("=-(A1+1)")).toBe("=-(A1+1)");
    expect(roundTrip('=IF(A1>5,"a ""q""",B$2)')).toBe('=IF(A1>5, "a ""q""", B$2)');
    expect(roundTrip("=SUM($A$1:B10, C:C)")).toBe("=SUM($A$1:B10, C:C)");
    expect(roundTrip("=50%")).toBe("=50%");
  });

  it("shifts relative rows when filled down, leaves anchored ones", () => {
    const ast = parseFormula("=B1*$C$1+D$1+SUM(E1:E3)+SUM($F$1:F1)");
    expect(formatFormula(ast, 4)).toBe("=B5*$C$1+D$1+SUM(E5:E7)+SUM($F$1:F5)");
  });

  it("marks refs pushed above row 1 as #REF!", () => {
    expect(formatFormula(parseFormula("=A2"), -2)).toBe("=#REF!");
  });
});

describe("evaluate with a row shift", () => {
  // column A holds 10, 20, 30...; column B holds 1, 2, 3...
  const ctx: EvalContext = {
    cell: (r, c) => (c === 0 ? (r + 1) * 10 : r + 1),
    eachInRange: (range, visit) => {
      for (let r = range.top; r <= Math.min(range.bottom, 9); r++) {
        for (let c = range.left; c <= range.right; c++) visit(c === 0 ? (r + 1) * 10 : r + 1);
      }
    },
  };

  it("evaluates a template as if it were on another row", () => {
    const ast = parseFormula("=A1*B1+$A$1");
    expect(evaluate(ast, ctx, 0)).toBe(10 * 1 + 10);
    expect(evaluate(ast, ctx, 2)).toBe(30 * 3 + 10);
  });

  it("shifts ranges too (running total)", () => {
    const ast = parseFormula("=SUM($B$1:B1)");
    expect([0, 1, 2, 3].map((s) => evaluate(ast, ctx, s))).toEqual([1, 3, 6, 10]);
  });
});
