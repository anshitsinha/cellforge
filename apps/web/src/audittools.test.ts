import { describe, expect, it } from "vitest";
import { Table } from "@cellforge/core";
import { readSheet } from "./audittools";
import { EditableSource } from "./editable";

describe("audit tools: reading the sheet", () => {
  it("uses the column names and keeps grid row numbers", () => {
    const src = new EditableSource(
      new Table([
        { kind: "string", name: "Vendor", codes: Uint32Array.from([1, 2, 0]), dict: ["Acme", "Bolt"] },
        { kind: "number", name: "Amount", values: Float64Array.from([10, NaN, 30]) },
      ]),
      5,
    );
    const data = readSheet(src);
    expect(data.names.slice(0, 2)).toEqual(["A: Vendor", "B: Amount"]);
    expect(data.first).toBe(0);
    expect(data.rows).toBe(3);
    expect(data.col(0)).toEqual(["Acme", "Bolt", null]);
    expect(data.col(1)).toEqual([10, null, 30]);
    expect(data.sheetRow(0)).toBe(1);
    expect(data.nonBlank()).toEqual([0, 1, 2]);
  });

  it("takes names from the first row when the sheet has none", () => {
    const src = new EditableSource(
      new Table([
        { kind: "string", name: "", codes: Uint32Array.from([1, 2, 3]), dict: ["Invoice", "INV-1", "INV-3"] },
        { kind: "string", name: "", codes: Uint32Array.from([1, 0, 0]), dict: ["Amount"] },
      ]),
      5,
    );
    const data = readSheet(src);
    expect(data.names.slice(0, 2)).toEqual(["A: Invoice", "B: Amount"]);
    expect(data.first).toBe(1);
    expect(data.rows).toBe(2);
    expect(data.col(0)).toEqual(["INV-1", "INV-3"]);
    expect(data.sheetRow(0)).toBe(2);
  });
});
