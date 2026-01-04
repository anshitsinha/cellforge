import { ColumnBuilder, Table } from "@cellforge/core";
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
  it("sorts numbers before text with blanks last", async () => {
    const s = column(["b", "3", "", "A", "1"]);
    s.setRowOrder(await sortedOrder(s, 0, false));
    expect(colA(s)).toEqual([1, 3, "A", "b", null]);
  });

  it("keeps blanks last when descending, text before numbers", async () => {
    const s = column(["1", "", "3", "x", "2"]);
    s.setRowOrder(await sortedOrder(s, 0, true));
    expect(colA(s)).toEqual(["x", 3, 2, 1, null]);
  });

  it("moves whole rows, edits included", async () => {
    const s = column(["2", "1"]);
    s.setRowOrder(await sortedOrder(s, 0, false));
    // the row that started at index 1 is now on top
    expect(s.getCell(0, 1)).toBe(1);
  });

  it("composes with an existing order (sorting twice)", async () => {
    const s = column(["3", "1", "2"]);
    s.setRowOrder(await sortedOrder(s, 0, false));
    s.setRowOrder(await sortedOrder(s, 0, true));
    expect(colA(s)).toEqual([3, 2, 1]);
  });

  it("is stable and treats case-insensitive duplicates as equal", async () => {
    const s = column(["x", "X", "x"]);
    s.setRowOrder(await sortedOrder(s, 0, false));
    expect([0, 1, 2].map((r) => s.getCell(r, 1))).toEqual([0, 1, 2]);
  });

  it("uses the columnar fast path for imported tables", async () => {
    const nums = new ColumnBuilder("n");
    const names = new ColumnBuilder("name");
    for (const [n, name] of [["3", "c"], ["", "blank"], ["1", "a"], ["2", "b"]]) {
      nums.push(n);
      names.push(name);
    }
    const s = new EditableSource(new Table([nums.finish(), names.finish()]));
    s.setRowOrder(await sortedOrder(s, 0, false));
    expect(Array.from({ length: 4 }, (_, r) => s.getCell(r, 1))).toEqual(["a", "b", "c", "blank"]);
    // then sort by the text column, through the dictionary fast path
    s.setRowOrder(await sortedOrder(s, 1, true));
    expect(Array.from({ length: 4 }, (_, r) => s.getCell(r, 1))).toEqual(["c", "blank", "b", "a"]);
  });
});
