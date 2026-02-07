import { describe, expect, it } from "vitest";
import { adjustForRowChange, breakpoints, formatFormula, mapRow, parseFormula, type RowChange } from "../src/formula";

const all = () => true;
/** Adjust a formula sitting on (0-based) row `at`, as Excel would when rows change. */
function adjust(f: string, change: RowChange, formulaRow = 0, applies: (s: string | undefined) => boolean = all) {
  const moved = mapRow(change, formulaRow);
  if (moved === null) throw new Error("the formula's own row was deleted");
  // a cell written at its own row: shift 0 before, (moved - row) after
  return formatFormula(adjustForRowChange(parseFormula(f), change, 0, moved - formulaRow, applies), moved - formulaRow);
}

const insert = (at: number, count = 1): RowChange => ({ at, count, insert: true });
const del = (at: number, count = 1): RowChange => ({ at, count, insert: false });

describe("inserting rows (Excel's behaviour)", () => {
  it("references at or below the insertion move down; above stay", () => {
    // insert 2 rows before row 5 (0-based 4); formula in A1
    expect(adjust("=B4+B5+B9", insert(4, 2))).toBe("=B4+B7+B11");
    expect(adjust("=$B$5", insert(4))).toBe("=$B$6");
  });

  it("the formula's own row moving keeps same-row references on its row", () => {
    // formula in row 10 (0-based 9) reading its own row; insert above it
    expect(adjust("=A10*2", insert(2), 9)).toBe("=A11*2");
    // reading a row above the insertion from below it
    expect(adjust("=A1", insert(2), 9)).toBe("=A1");
  });

  it("ranges grow when rows are inserted inside, move when inserted above", () => {
    expect(adjust("=SUM(A2:A10)", insert(4, 3))).toBe("=SUM(A2:A13)");
    expect(adjust("=SUM(A5:A10)", insert(4))).toBe("=SUM(A6:A11)"); // at the top edge: moves
    expect(adjust("=SUM(A2:A4)", insert(4))).toBe("=SUM(A2:A4)"); // just after: unchanged
    expect(adjust("=SUM(A:A)", insert(0, 5))).toBe("=SUM(A:A)");
  });
});

describe("deleting rows (Excel's behaviour)", () => {
  it("references to deleted rows become #REF!, others move up", () => {
    expect(adjust("=B4+B6", del(4, 2))).toBe("=B4+#REF!");
    expect(adjust("=B9", del(4, 2))).toBe("=B7");
    expect(adjust("=$B$9", del(4, 2))).toBe("=$B$7");
  });

  it("ranges shrink, and become #REF! only when entirely deleted", () => {
    expect(adjust("=SUM(A2:A10)", del(4, 3))).toBe("=SUM(A2:A7)");
    expect(adjust("=SUM(A5:A10)", del(2, 4))).toBe("=SUM(A3:A6)"); // top edge deleted
    expect(adjust("=SUM(A2:A6)", del(4, 4))).toBe("=SUM(A2:A4)"); // bottom edge deleted
    expect(adjust("=SUM(A5:A6)", del(4, 2))).toBe("=SUM(#REF!)");
  });
});

describe("other sheets", () => {
  it("only references to the changed sheet are adjusted", () => {
    const onlyData = (s: string | undefined) => s?.toLowerCase() === "data";
    // formula on another sheet: its own row doesn't move
    const f = parseFormula("=Data!B5+B5+Other!B5");
    const out = adjustForRowChange(f, insert(2), 0, 0, onlyData);
    expect(formatFormula(out)).toBe("=Data!B6+B5+Other!B5");
  });
});

describe("breakpoints for filled blocks", () => {
  it("are where a row or its target crosses an edge", () => {
    // fill of =A1 written at row 0 (origin 0), insert at 10: own row crosses at 10,
    // target (same row) crosses at 10 too
    expect(breakpoints(parseFormula("=A1"), insert(10), 0, true, all)).toEqual([10]);
    // =A1 written at row 3 reads 3 rows up: target crosses at 13
    expect(breakpoints(parseFormula("=A1"), insert(10), 3, true, all)).toEqual([10, 13]);
    // absolute references never split a block
    expect(breakpoints(parseFormula("=$A$1"), insert(10), 0, false, all)).toEqual([]);
  });
});
