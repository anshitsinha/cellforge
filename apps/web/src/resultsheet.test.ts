import { describe, expect, it } from "vitest";
import type { ColumnData } from "@cellforge/core";
import { buildResultSheet, fitWidth, headerRowOf, MONEY_FMT, DATE_FMT, sheetName, totalColumns } from "./resultsheet";
import { sheetHeader } from "./recondialog";

const str = (name: string, values: string[]): ColumnData => {
  const dict = [...new Set(values.filter(Boolean))];
  return { kind: "string", name, codes: Uint32Array.from(values, (v) => (v ? dict.indexOf(v) + 1 : 0)), dict };
};
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });

describe("results sheets", () => {
  const spec = {
    name: "Rec · Only in Cash book",
    title: "Only in Cash book",
    summary: "2 lines totalling 150.00 with no partner in Bank statement.",
    columns: [num("Cash book row", [4, 9]), str("Reference", ["INV-1", "INV-2"]), num("Date", [46296, 46297]), num("Amount", [100, 50]), str("Why", ["", ""])],
    numFmts: ["", "", DATE_FMT, MONEY_FMT, ""],
  };

  it("lays out a title, a summary, totals, a frozen header and the data", () => {
    const { source, headerRow, firstRow, kept } = buildResultSheet(spec);
    expect(source.getCell(0, 0)).toBe("Only in Cash book");
    expect(source.getCell(1, 0)).toMatch(/^2 lines/);
    // totals row: label left of the first total, live SUM under Amount
    expect(source.getCell(2, 0)).toBe("Total");
    expect(source.getEditText(2, 3)).toBe("=SUM(D5:D6)");
    expect(source.getCell(2, 3)).toBe(150);
    expect(headerRow).toBe(3);
    expect(firstRow).toBe(4);
    expect([0, 1, 2, 3].map((c) => source.getCell(3, c))).toEqual(["Cash book row", "Reference", "Date", "Amount"]);
    // the empty "Why" column is left out
    expect(kept).toEqual([0, 1, 2, 3]);
    expect(source.frozen).toEqual({ rows: 4, cols: 0 });
    expect(source.getStyle(3, 0)?.bold).toBe(true);
    expect(source.getStyle(3, 3)?.align).toBe("right");
    expect(source.getStyle(4, 2)?.numFmt).toBe(DATE_FMT);
    expect(source.getStyle(5, 3)?.numFmt).toBe(MONEY_FMT);
    // no hard-coded fills or text colours (they break dark mode)
    for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) expect(source.getStyle(r, c)?.fill ?? null).toBeNull();
    expect(source.usedRange().rows).toBe(6);
  });

  it("is read back by the tools: the header is the last frozen row", () => {
    const { source } = buildResultSheet(spec);
    expect(headerRowOf(source)).toBe(3);
    expect(sheetHeader(source)).toEqual({ names: ["Cash book row", "Reference", "Date", "Amount"], first: 4 });
  });

  it("totals money columns only, and only when there's more than one line", () => {
    expect(totalColumns({ columns: [num("Row", [1, 2]), num("Amount", [1, 2]), num("Days apart", [1, 2])], numFmts: ["", MONEY_FMT, MONEY_FMT] }, 2)).toEqual([1]);
    expect(totalColumns({ columns: [num("Amount", [1])], numFmts: [MONEY_FMT] }, 1)).toEqual([]);
    expect(totalColumns({ columns: [num("Amount", [1, 2])], numFmts: [MONEY_FMT], totals: false }, 2)).toEqual([]);
    const { source } = buildResultSheet({ name: "x", columns: [num("Amount", [1])], numFmts: [MONEY_FMT] });
    expect(source.getCell(1, 0)).toBe("Amount");
  });

  it("fits widths to the content, within limits", () => {
    expect(fitWidth(["a"], "")).toBe(56);
    expect(fitWidth(["x".repeat(500)])).toBe(360);
    const { source } = buildResultSheet(spec);
    const w = (c: number) => (source.toState().state.colWidths as [number, number][]).find(([k]) => k === c)?.[1] ?? 0;
    expect(w(1)).toBeGreaterThanOrEqual(fitWidth(["INV-1"], "Reference"));
    expect(w(0)).toBeGreaterThan(w(3) - 100);
  });

  it("cleans sheet names", () => {
    expect(sheetName("A/B: rec [1]?")).toBe("A B rec 1");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });
});
