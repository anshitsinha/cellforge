import { describe, expect, it } from "vitest";
import { DepIndex } from "./deps";

const r = (top: number, bottom: number, left: number, right = left) => ({ top, bottom, left, right });

describe("DepIndex", () => {
  it("finds readers of overlapping rectangles only", () => {
    const idx = new DepIndex<string>();
    idx.set("sumA", [r(0, 9, 0)]); // =SUM(A1:A10)
    idx.set("colC", [r(0, Infinity, 2)]); // =SUM(C:C)
    idx.set("block", [r(5, 5, 0, 3)]); // reads A6:D6
    expect([...idx.readersOf(r(3, 3, 0))]).toEqual(["sumA"]);
    expect([...idx.readersOf(r(5, 5, 0))].sort()).toEqual(["block", "sumA"]);
    expect([...idx.readersOf(r(1_000_000, 1_000_000, 2))]).toEqual(["colC"]);
    expect(idx.readersOf(r(20, 20, 0)).size).toBe(0);
    expect(idx.readersOf(r(0, 0, 1)).size).toBe(0);
  });

  it("set replaces and delete removes", () => {
    const idx = new DepIndex<string>();
    idx.set("f", [r(0, 0, 0)]);
    idx.set("f", [r(0, 0, 1)]);
    expect(idx.readersOf(r(0, 0, 0)).size).toBe(0);
    expect(idx.readersOf(r(0, 0, 1)).size).toBe(1);
    idx.delete("f");
    expect(idx.readersOf(r(0, 0, 1)).size).toBe(0);
    expect(idx.size).toBe(0);
  });

  it("a query rectangle spanning columns sees each reader once", () => {
    const idx = new DepIndex<string>();
    idx.set("wide", [r(0, 0, 0, 5)]);
    expect([...idx.readersOf(r(0, 0, 0, 5))]).toEqual(["wide"]);
  });
});
