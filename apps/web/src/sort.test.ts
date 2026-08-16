import { describe, expect, it } from "vitest";
import { BlankSource, EditableSource, parseInput } from "./editable";
import { sortedOrder } from "./sort";

function column(values: string[]) {
  const s = new EditableSource(new BlankSource(values.length, 2));
  values.forEach((v, i) => {
    s.setCell(i, 0, parseInput(v));
    s.setCell(i, 1, i); // remember where each row started
  });
  return s;
}

const colA = (s: EditableSource) => Array.from({ length: s.rowCount }, (_, r) => s.getCell(r, 0));

describe("sortedOrder", () => {
  it("sorts numbers before text with blanks last", () => {
    const s = column(["b", "3", "", "A", "1"]);
    s.setRowOrder(sortedOrder(s, 0, false));
    expect(colA(s)).toEqual([1, 3, "A", "b", null]);
  });

  it("keeps blanks last when descending", () => {
    const s = column(["1", "", "3", "2"]);
    s.setRowOrder(sortedOrder(s, 0, true));
    expect(colA(s)).toEqual([3, 2, 1, null]);
  });

  it("moves whole rows, edits included", () => {
    const s = column(["2", "1"]);
    s.setRowOrder(sortedOrder(s, 0, false));
    // the row that started at index 1 is now on top
    expect(s.getCell(0, 1)).toBe(1);
  });

  it("composes with an existing order (sorting twice)", () => {
    const s = column(["3", "1", "2"]);
    s.setRowOrder(sortedOrder(s, 0, false));
    s.setRowOrder(sortedOrder(s, 0, true));
    expect(colA(s)).toEqual([3, 2, 1]);
  });

  it("is stable", () => {
    const s = column(["x", "x", "x"]);
    s.setRowOrder(sortedOrder(s, 0, false));
    expect([0, 1, 2].map((r) => s.getCell(r, 1))).toEqual([0, 1, 2]);
  });
});
