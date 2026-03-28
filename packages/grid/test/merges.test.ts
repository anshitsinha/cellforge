import { describe, expect, it } from "vitest";
import { expandToMerges, mergeAt, spliceMerges } from "../src/merges";

const M = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right });

describe("merges", () => {
  it("finds the merge under a cell and grows selections around merges", () => {
    const merges = [M(1, 1, 2, 3), M(4, 0, 4, 1)];
    expect(mergeAt(merges, 2, 2)).toEqual(M(1, 1, 2, 3));
    expect(mergeAt(merges, 0, 0)).toBeNull();
    expect(expandToMerges(M(2, 0, 4, 0), merges)).toEqual(M(1, 0, 4, 3));
  });

  it("row splices shift, grow and shrink merges like Excel", () => {
    const m = [M(2, 0, 5, 1)];
    expect(spliceMerges(m, "row", 0, 0, 2)).toEqual([M(4, 0, 7, 1)]); // insert above
    expect(spliceMerges(m, "row", 3, 0, 2)).toEqual([M(2, 0, 7, 1)]); // insert inside
    expect(spliceMerges(m, "row", 6, 0, 2)).toEqual(m); // insert below
    expect(spliceMerges(m, "row", 3, 2, 0)).toEqual([M(2, 0, 3, 1)]); // delete inside
    expect(spliceMerges(m, "row", 0, 3, 0)).toEqual([M(0, 0, 2, 1)]); // delete across the top
    expect(spliceMerges(m, "row", 1, 10, 0)).toEqual([]); // delete all of it
    expect(spliceMerges([M(2, 0, 3, 0)], "row", 3, 1, 0)).toEqual([]); // down to one cell
  });

  it("column splices work the same way", () => {
    expect(spliceMerges([M(0, 2, 0, 4)], "col", 3, 1, 0)).toEqual([M(0, 2, 0, 3)]);
    expect(spliceMerges([M(0, 2, 0, 4)], "col", 0, 0, 1)).toEqual([M(0, 3, 0, 5)]);
  });
});
