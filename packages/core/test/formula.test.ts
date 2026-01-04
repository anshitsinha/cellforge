import { describe, expect, it } from "vitest";
import { CellError, evaluate, parseFormula, type EvalContext, type RangeRef, type Scalar } from "../src/formula";

/** Tiny in-memory sheet for tests: { A1: 1, B2: "x", ... } */
function sheet(cells: Record<string, Scalar>): EvalContext {
  const grid = new Map<string, Scalar>();
  for (const [ref, v] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    grid.set(`${Number(m[2]) - 1},${m[1].charCodeAt(0) - 65}`, v);
  }
  return {
    cell: (r, c) => grid.get(`${r},${c}`) ?? null,
    eachInRange: (range: RangeRef, visit) => {
      const bottom = Math.min(range.bottom, 99);
      for (let r = range.top; r <= bottom; r++) {
        for (let c = range.left; c <= range.right; c++) visit(grid.get(`${r},${c}`) ?? null);
      }
    },
  };
}

const run = (f: string, cells: Record<string, Scalar> = {}) => {
  const v = evaluate(parseFormula(f), sheet(cells));
  return v instanceof CellError ? v.code : v;
};

describe("arithmetic", () => {
  it("respects precedence and parentheses", () => {
    expect(run("=1+2*3")).toBe(7);
    expect(run("=(1+2)*3")).toBe(9);
    expect(run("=2^3^2")).toBe(512); // right associative
    expect(run("=-2^2")).toBe(4); // unary minus binds tighter than ^, like Excel
    expect(run("=50%")).toBe(0.5);
  });

  it("uses plain IEEE doubles (display formatting hides the noise)", () => {
    expect(run("=0.1+0.2")).toBe(0.1 + 0.2);
    expect(run("=1/0*0")).toBe("#DIV/0!");
    expect(run("=10^400")).toBe("#NUM!");
  });

  it("returns errors instead of throwing", () => {
    expect(run("=1/0")).toBe("#DIV/0!");
    expect(run('="a"*2')).toBe("#VALUE!");
    expect(run("=NOPE(1)")).toBe("#NAME?");
  });

  it("treats blank cells as 0 and numeric text as numbers", () => {
    expect(run("=A1+1")).toBe(1);
    expect(run("=A1*2", { A1: "21" })).toBe(42);
  });
});

describe("references", () => {
  it("reads cells, with or without $ anchors", () => {
    expect(run("=A1+B1", { A1: 2, B1: 3 })).toBe(5);
    expect(run("=$A$1*2", { A1: 4 })).toBe(8);
  });

  it("propagates errors from referenced cells", () => {
    expect(run("=A1+1", { A1: new CellError("#DIV/0!") })).toBe("#DIV/0!");
  });
});

describe("functions", () => {
  const data = { A1: 10, A2: 20, A3: "text", A4: 30, B1: "North", B2: "South", B3: "North" };

  it("aggregates over ranges, skipping text", () => {
    expect(run("=SUM(A1:A4)", data)).toBe(60);
    expect(run("=AVERAGE(A1:A4)", data)).toBe(20);
    expect(run("=MIN(A1:A4)", data)).toBe(10);
    expect(run("=MAX(A1:A4)", data)).toBe(30);
    expect(run("=COUNT(A1:A4)", data)).toBe(3);
    expect(run("=COUNTA(A1:A4)", data)).toBe(4);
  });

  it("supports whole-column ranges", () => {
    expect(run("=SUM(A:A)", data)).toBe(60);
  });

  it("mixes ranges and scalars", () => {
    expect(run("=SUM(A1:A2, 5, A4)", data)).toBe(65);
  });

  it("does conditional counting and summing", () => {
    expect(run('=COUNTIF(B1:B3, "North")', data)).toBe(2);
    expect(run('=COUNTIF(A1:A4, ">15")', data)).toBe(2);
    expect(run('=SUMIF(A1:A4, ">=20")', data)).toBe(50);
  });

  it("has working IF / AND / OR / IFERROR", () => {
    expect(run('=IF(A1>5, "big", "small")', data)).toBe("big");
    expect(run("=IF(FALSE, 1)")).toBe(false);
    expect(run("=AND(TRUE, 1, A1>5)", data)).toBe(true);
    expect(run("=OR(FALSE, 0)")).toBe(false);
    expect(run('=IFERROR(1/0, "oops")')).toBe("oops");
  });

  it("does text things", () => {
    expect(run('="a"&"b"&1')).toBe("ab1");
    expect(run('=UPPER(B1)', data)).toBe("NORTH");
    expect(run('=LEN("hello")')).toBe(5);
    expect(run('=CONCAT(B1:B2, "!")', data)).toBe("NorthSouth!");
  });

  it("rounds half away from zero", () => {
    expect(run("=ROUND(2.5)")).toBe(3);
    expect(run("=ROUND(-2.5)")).toBe(-3);
    expect(run("=ROUND(3.14159, 2)")).toBe(3.14);
    expect(run("=MOD(-3, 2)")).toBe(1);
  });
});

describe("parser", () => {
  it("is case insensitive for functions and refs", () => {
    expect(run("=sum(a1:a2)", { A1: 1, A2: 2 })).toBe(3);
  });

  it("throws on bad syntax", () => {
    expect(() => parseFormula("=1+")).toThrow();
    expect(() => parseFormula("=SUM(1,2")).toThrow();
    expect(() => parseFormula('="unterminated')).toThrow();
  });
});
