import { describe, expect, it } from "vitest";
import {
  CellError,
  compileFill,
  evaluate,
  formatFormula,
  parseFormula,
  type CompiledFill,
  type EvalContext,
  type Node,
  type Scalar,
} from "../src/formula";

// --- a small random sheet ------------------------------------------------------

const ROWS = 60;
const COLS = 5;

function rng(seed: number) {
  // mulberry32 - deterministic so failures are reproducible
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSheet(rand: () => number): Scalar[][] {
  const pick = (): Scalar => {
    const r = rand();
    if (r < 0.08) return null; // blank
    if (r < 0.14) return 0;
    if (r < 0.18) return "text";
    if (r < 0.2) return "12"; // numeric-looking text
    if (r < 0.22) return true;
    if (r < 0.23) return new CellError("#N/A");
    if (r < 0.26) return 1e308; // overflow bait
    return Math.round((rand() - 0.4) * 2000) / 8;
  };
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, pick));
}

function contextFor(sheet: Scalar[][]): EvalContext {
  const cell = (r: number, c: number): Scalar => (r < ROWS && c < COLS ? sheet[r][c] : new CellError("#REF!"));
  return {
    cell,
    eachInRange: (range, visit) => {
      for (let r = range.top; r <= Math.min(range.bottom, ROWS - 1); r++)
        for (let c = range.left; c <= range.right; c++) visit(cell(r, c));
    },
  };
}

/** Materialise kernel inputs the way the app does: number, blank -> 0, else NaN. */
function asInput(v: Scalar): number {
  if (typeof v === "number") return v;
  if (v === null) return 0;
  return NaN;
}

function runKernel(k: CompiledFill, sheet: Scalar[][], start: number, end: number): Float64Array {
  const cols = k.columns.map(({ col }) =>
    Float64Array.from({ length: ROWS }, (_, r) => (col < COLS ? asInput(sheet[r][col]) : NaN)),
  );
  const scalars = Float64Array.from(k.scalars, ({ col, row }) =>
    row < ROWS && col < COLS ? asInput(sheet[row][col]) : NaN,
  );
  const out = new Float64Array(end - start);
  k.run(cols, scalars, out, start, end, ROWS, 0);
  return out;
}

// --- random formulas from the compilable subset (plus things that aren't) ---

function randomFormula(rand: () => number, depth = 0): string {
  const leaf = () => {
    const r = rand();
    if (r < 0.55) {
      const col = "ABCDE"[Math.floor(rand() * COLS)];
      const row = 1 + Math.floor(rand() * 4); // refs near the origin row
      const absRow = rand() < 0.15 ? "$" : "";
      return `${col}${absRow}${row}`;
    }
    if (r < 0.9) return String(Math.round((rand() - 0.3) * 100) / 4);
    return "0";
  };
  if (depth > 3 || rand() < 0.3) return leaf();
  const sub = () => randomFormula(rand, depth + 1);
  const r = rand();
  if (r < 0.45) return `(${sub()}${["+", "-", "*", "/", "^"][Math.floor(rand() * 5)]}${sub()})`;
  if (r < 0.55) return `-${sub()}`;
  if (r < 0.6) return `${sub()}%`;
  const cmp = ["=", "<>", "<", ">", "<=", ">="][Math.floor(rand() * 6)];
  const fns = [
    () => `IF(${sub()}${cmp}${sub()}, ${sub()}, ${sub()})`,
    () => `IF(${sub()}, ${sub()}, ${sub()})`,
    () => `ABS(${sub()})`,
    () => `SQRT(${sub()})`,
    () => `INT(${sub()})`,
    () => `ROUND(${sub()}, ${Math.floor(rand() * 4)})`,
    () => `MOD(${sub()}, ${sub()})`,
    () => `POWER(${sub()}, ${sub()})`,
    () => `SUM(${sub()}, ${sub()}, ${sub()})`,
    () => `AVERAGE(${sub()}, ${sub()})`,
    () => `MIN(${sub()}, ${sub()})`,
    () => `MAX(${sub()}, ${sub()}, ${sub()})`,
  ];
  return fns[Math.floor(rand() * fns.length)]();
}

describe("compileFill", () => {
  it("compiles the common case and computes the right values", () => {
    const ast = parseFormula("=A1*B1+$C$1");
    const k = compileFill(ast, 0)!;
    expect(k).not.toBeNull();
    const sheet: Scalar[][] = Array.from({ length: ROWS }, (_, r) => [r, 2, 100, null, null]);
    const out = runKernel(k, sheet, 0, 5);
    expect(Array.from(out)).toEqual([100, 102, 104, 106, 108]);
  });

  it("refuses what it can't model", () => {
    for (const f of ['="a"&B1', "=A1>B1", "=SUM(A1:A9)", "=IF(A1, 1)", "=LEN(A1)", "=TRUE"]) {
      expect(compileFill(parseFormula(f), 0), f).toBeNull();
    }
  });

  it("never launders a non-finite intermediate into a finite result", () => {
    const k = compileFill(parseFormula("=1/(1/A1)"), 0)!;
    const out = runKernel(k, [[0, 0, 0, 0, 0], ...Array(ROWS - 1).fill([1, 1, 1, 1, 1])], 0, 1);
    expect(out[0]).toBeNaN(); // interpreter says #DIV/0!, so must fall back
  });

  it("reads out-of-range rows as NaN (interpreter gives #REF!)", () => {
    const k = compileFill(parseFormula("=A2-A1"), 1)!; // A1 is one row above the origin
    const sheet: Scalar[][] = Array.from({ length: ROWS }, (_, r) => [r * r, 0, 0, 0, 0]);
    const out = runKernel(k, sheet, 0, 3);
    expect(out[0]).toBeNaN(); // row 0 would read row -1
    expect(out[1]).toBe(1 - 0);
    expect(out[2]).toBe(4 - 1);
  });

  it("matches the interpreter bit-for-bit on random formulas (fuzz)", { timeout: 600_000 }, () => {
    // FUZZ_TRIALS=50000 FUZZ_SEED=... for a longer soak run
    const trials = Number(process.env.FUZZ_TRIALS ?? 3000);
    const rand = rng(Number(process.env.FUZZ_SEED ?? 12345));
    let compiled = 0;
    let finiteRows = 0;

    for (let trial = 0; trial < trials; trial++) {
      const sheet = randomSheet(rand);
      const text = "=" + randomFormula(rand);
      const ast: Node = parseFormula(text);
      const origin = 1 + Math.floor(rand() * 3);
      const k = compileFill(ast, origin);
      if (!k) continue;
      compiled++;

      const out = runKernel(k, sheet, 0, ROWS);
      const ctx = contextFor(sheet);
      for (let v = 0; v < ROWS; v++) {
        const x = out[v];
        if (!Number.isFinite(x)) continue; // fallback row: interpreter decides
        finiteRows++;
        const expected = evaluate(ast, ctx, v - origin);
        if (!Object.is(x, expected)) {
          throw new Error(
            `mismatch for ${formatFormula(ast, v - origin)} (template ${text}, row ${v}): kernel ${x}, interpreter ${String(expected)}\n${k.source}`,
          );
        }
      }
    }
    // make sure the fuzzer actually exercised something
    expect(compiled).toBeGreaterThan(trials / 2);
    expect(finiteRows).toBeGreaterThan(trials * 7);
  });
});
