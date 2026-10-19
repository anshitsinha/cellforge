import { describe, expect, it } from "vitest";
import { dataExtent } from "./usedrange";

const fake = (cells: Record<string, unknown>, rows: number, cols: number) => ({
  usedRange: () => ({ rows, cols }),
  getCell: (r: number, c: number) => (cells[`${r},${c}`] ?? null) as never,
});

describe("data extent", () => {
  it("ignores formula rows that show nothing", () => {
    const cells: Record<string, unknown> = { "0,0": "Date", "0,1": "Amount", "1,0": 46023, "1,1": 10, "2,0": 46024, "2,1": 20 };
    for (let r = 3; r < 2000; r++) cells[`${r},2`] = "";
    expect(dataExtent(fake(cells, 2000, 3))).toEqual({ rows: 3, cols: 2 });
  });
  it("is empty for a blank sheet", () => {
    expect(dataExtent(fake({}, 2000, 5))).toEqual({ rows: 0, cols: 0 });
  });
  it("stops at once when the last row holds data", () => {
    let reads = 0;
    const src = { usedRange: () => ({ rows: 100_000_000, cols: 8 }), getCell: (r: number) => (reads++, r >= 0 ? 1 : null) as never };
    expect(dataExtent(src).rows).toBe(100_000_000);
    expect(reads).toBeLessThan(5000);
  });
});
