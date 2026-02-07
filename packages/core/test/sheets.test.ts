import { describe, expect, it } from "vitest";
import {
  CellError,
  compileFill,
  evaluate,
  formatFormula,
  parseFormula,
  readsOtherSheets,
  sheetPrefix,
  type EvalContext,
  type RangeRef,
  type Scalar,
} from "../src/formula";

/** A small workbook: sheet name -> { A1: value } */
function workbook(sheets: Record<string, Record<string, Scalar>>): (name: string) => EvalContext {
  const contexts = new Map<string, EvalContext>();
  const lookup = (name: string) => contexts.get(name.toLowerCase()) ?? null;
  for (const [name, cells] of Object.entries(sheets)) {
    const grid = new Map<string, Scalar>();
    for (const [ref, v] of Object.entries(cells)) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
      grid.set(`${Number(m[2]) - 1},${m[1].charCodeAt(0) - 65}`, v);
    }
    contexts.set(name.toLowerCase(), {
      cell: (r, c) => grid.get(`${r},${c}`) ?? null,
      eachInRange: (range: RangeRef, visit) => {
        for (let r = range.top; r <= Math.min(range.bottom, 50); r++) {
          for (let c = range.left; c <= range.right; c++) visit(grid.get(`${r},${c}`) ?? null);
        }
      },
      sheet: lookup,
    });
  }
  return (name) => lookup(name)!;
}

const value = (v: Scalar) => (v instanceof CellError ? v.code : v);

describe("cross-sheet references", () => {
  const wb = workbook({
    Sheet1: { A1: 1 },
    Data: { A1: 10, A2: 20, A3: 30, B1: "x" },
    "Bank Jan": { C2: 5 },
    "It's": { A1: 7 },
  });
  const on1 = wb("Sheet1");
  const run = (f: string, rowShift = 0) => value(evaluate(parseFormula(f), on1, rowShift));

  it("reads a cell on another sheet", () => {
    expect(run("=Data!A2")).toBe(20);
    expect(run("=Data!A2+A1")).toBe(21);
    expect(run("=data!a2")).toBe(20); // sheet names ignore case
  });

  it("supports quoted names, ranges and whole columns", () => {
    expect(run("='Bank Jan'!C2*2")).toBe(10);
    expect(run("=SUM(Data!A1:A3)")).toBe(60);
    expect(run("=SUM(Data!A:A)")).toBe(60);
    expect(run("=COUNTIF(Data!A1:A3,\">15\")")).toBe(2);
    expect(run("='It''s'!A1")).toBe(7);
  });

  it("an unknown sheet is #REF!", () => {
    expect(run("=Nope!A1")).toBe("#REF!");
    expect(run("=SUM(Nope!A1:A3)")).toBe("#REF!");
  });

  it("filled down, the row moves and the sheet stays", () => {
    expect(run("=Data!A1", 2)).toBe(30);
    expect(formatFormula(parseFormula("=Data!A1+Data!$A$1"), 1)).toBe("=Data!A2+Data!$A$1");
  });

  it("prints names the way Excel writes them", () => {
    for (const f of ["=Data!A1", "='Bank Jan'!C2", "=SUM(Data!A1:A3)", "=SUM(Data!A:A)", "='It''s'!A1", "='AB12'!A1"]) {
      expect(formatFormula(parseFormula(f))).toBe(f);
    }
    expect(sheetPrefix("Sheet1")).toBe("Sheet1!");
    expect(sheetPrefix("AB12")).toBe("'AB12'!"); // looks like a cell, so quoted
    expect(sheetPrefix("Q1 2026")).toBe("'Q1 2026'!");
  });

  it("rejects malformed sheet references", () => {
    expect(() => parseFormula("='Bank Jan")).toThrow();
    expect(() => parseFormula("='Bank Jan'A1")).toThrow();
    expect(() => parseFormula("=Data!SUM(A1)")).toThrow();
  });

  it("formulas reading other sheets are not compiled", () => {
    expect(readsOtherSheets(parseFormula("=A1*Data!B1"))).toBe(true);
    expect(readsOtherSheets(parseFormula("=A1*B1"))).toBe(false);
    expect(compileFill(parseFormula("=A1*Data!B1"), 0)).toBeNull();
  });
});

describe("#REF! inside formulas", () => {
  it("parses, prints and evaluates like Excel", () => {
    const ast = parseFormula("=A1+#REF!");
    expect(formatFormula(ast)).toBe("=A1+#REF!");
    const ctx: EvalContext = { cell: () => 1, eachInRange: () => {} };
    expect(value(evaluate(ast, ctx))).toBe("#REF!");
    expect(value(evaluate(parseFormula("=IFERROR(#REF!,0)"), ctx))).toBe(0);
    expect(formatFormula(parseFormula("=SUM(#REF!)"))).toBe("=SUM(#REF!)");
    expect(compileFill(parseFormula("=A1+#REF!"), 0)).toBeNull();
    expect(() => parseFormula("=#FOO")).toThrow();
  });
});
