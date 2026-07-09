import { describe, expect, it } from "vitest";
import { ColumnBuilder } from "../src/columns";
import { Table } from "../src/table";

describe("ColumnBuilder", () => {
  it("keeps all-numeric columns as Float64Array with NaN for blanks", () => {
    const b = new ColumnBuilder("x");
    ["1", "2.5", "", "-3e2"].forEach((v) => b.push(v));
    const col = b.finish();
    expect(col.kind).toBe("number");
    if (col.kind !== "number") return;
    expect(Array.from(col.values.slice(0, 2))).toEqual([1, 2.5]);
    expect(Number.isNaN(col.values[2])).toBe(true);
    expect(col.values[3]).toBe(-300);
  });

  it("switches to a dictionary-encoded string column on the first non-number", () => {
    const b = new ColumnBuilder("region");
    ["1", "North", "South", "North", ""].forEach((v) => b.push(v));
    const col = b.finish();
    expect(col.kind).toBe("string");
    if (col.kind !== "string") return;
    // "North" is stored once
    expect(col.dict).toEqual(["1", "North", "South"]);
    expect(Array.from(col.codes)).toEqual([1, 2, 3, 2, 0]);
  });

  it("grows past its initial capacity", () => {
    const b = new ColumnBuilder("n");
    for (let i = 0; i < 5000; i++) b.push(String(i));
    const col = b.finish();
    expect(col.kind === "number" && col.values.length).toBe(5000);
  });
});

describe("Table", () => {
  it("reads cells back out of columns", () => {
    const a = new ColumnBuilder("a");
    const s = new ColumnBuilder("s");
    a.push("10");
    s.push("hello");
    a.push("");
    s.push("");
    const table = new Table([a.finish(), s.finish()]);
    expect(table.rowCount).toBe(2);
    expect(table.getColumnName(1)).toBe("s");
    expect(table.getCell(0, 0)).toBe(10);
    expect(table.getCell(0, 1)).toBe("hello");
    expect(table.getCell(1, 0)).toBe(null);
    expect(table.getCell(1, 1)).toBe(null);
  });
});
