import { describe, expect, it } from "vitest";
import { CellError, EXAMPLE_CELLS, FUNCTION_INFO, FUNCTIONS, evaluate, parseFormula, signature, type EvalContext, type Scalar } from "../src/formula";

const cellAt = (row: number, col: number): Scalar => {
  const ref = `${String.fromCharCode(65 + col)}${row + 1}`;
  return (EXAMPLE_CELLS[ref] as Scalar) ?? null;
};
const ctx: EvalContext = {
  cell: cellAt,
  eachInRange: (range, visit) => {
    for (let r = range.top; r <= Math.min(range.bottom, 20); r++) for (let c = range.left; c <= range.right; c++) visit(cellAt(r, c));
  },
};

const shown = (v: Scalar) => (v instanceof CellError ? v.code : v);

describe("the function reference", () => {
  it("documents every function, and only real ones", () => {
    expect(Object.keys(FUNCTION_INFO).sort()).toEqual(Object.keys(FUNCTIONS).sort());
  });

  for (const f of Object.values(FUNCTION_INFO)) {
    it(`${f.name}: every example gives what it says`, () => {
      expect(f.examples.length).toBeGreaterThan(0);
      for (const [formula, want] of f.examples) {
        expect(shown(evaluate(parseFormula(formula), ctx, 0)), formula).toEqual(want);
      }
    });
  }

  it("writes signatures the way Excel shows them", () => {
    expect(signature(FUNCTION_INFO.SUMIF)).toBe("SUMIF(range, criteria, [sum_range])");
    expect(signature(FUNCTION_INFO.SUM)).toBe("SUM(number1, [number2, …])");
  });
});
