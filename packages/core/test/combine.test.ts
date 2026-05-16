import { describe, expect, it } from "vitest";
import { alignColumns, columnKey, combineParts, type ColumnData, type FilePart } from "../src";

const num = (name: string, v: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(v) });
const str = (name: string, v: string[]): ColumnData => {
  const dict = [...new Set(v.filter(Boolean))];
  return { kind: "string", name, codes: Uint32Array.from(v.map((x) => (x ? dict.indexOf(x) + 1 : 0))), dict };
};
const text = (c: ColumnData, r: number) => (c.kind === "number" ? c.values[r] : c.codes[r] ? c.dict[c.codes[r] - 1] : "");

describe("column keys", () => {
  it("ignores case, spacing and punctuation, and knows common abbreviations", () => {
    expect(columnKey("Invoice No.")).toBe("invoicenumber");
    expect(columnKey("invoice_no")).toBe("invoicenumber");
    expect(columnKey(" AMT ")).toBe("amount");
    expect(columnKey("Customer Name")).toBe(columnKey("customer_name"));
  });
});

describe("aligning and combining files", () => {
  const jan: FilePart = { name: "jan.csv", columns: [num("Date", [45292, 45293]), str("Customer", ["Acme", "Beta"]), num("Amount", [10, 20])], numFmts: ["yyyy-mm-dd"] };
  const feb: FilePart = { name: "feb.csv", columns: [str("customer", ["Gamma"]), num("AMT", [5]), num("date", [45323]), str("Region", ["North"])], numFmts: [undefined, undefined, "yyyy-mm-dd"] };

  it("matches columns by name whatever their order, and keeps columns only some files have", () => {
    const a = alignColumns([jan.columns.map((c) => c.name), feb.columns.map((c) => c.name)]);
    expect(a.map((c) => c.name)).toEqual(["Date", "Customer", "Amount", "Region"]);
    expect(a.map((c) => c.from)).toEqual([[0, 2], [1, 0], [2, 1], [null, 3]]);
  });

  it("stacks the rows with a source-file column", () => {
    const a = alignColumns([jan.columns.map((c) => c.name), feb.columns.map((c) => c.name)]);
    const { columns, numFmts } = combineParts([jan, feb], a);
    expect(columns.map((c) => c.name)).toEqual(["source file", "Date", "Customer", "Amount", "Region"]);
    expect([0, 1, 2].map((r) => text(columns[0], r))).toEqual(["jan.csv", "jan.csv", "feb.csv"]);
    expect([0, 1, 2].map((r) => text(columns[3], r))).toEqual([10, 20, 5]);
    expect([0, 1, 2].map((r) => text(columns[4], r))).toEqual(["", "", "North"]);
    expect(numFmts[1]).toBe("yyyy-mm-dd");
  });

  it("merges columns the user says are the same", () => {
    const a = alignColumns([["Cust", "Amount"], ["Customer", "Amount"]], { cust: "customer" });
    expect(a.map((c) => c.from)).toEqual([[0, 0], [1, 1]]);
  });

  it("turns a column into text when one file has text in it, losing nothing", () => {
    const x: FilePart = { name: "a", columns: [num("Code", [101])] };
    const y: FilePart = { name: "b", columns: [str("Code", ["A-7"])] };
    const { columns } = combineParts([x, y], alignColumns([["Code"], ["Code"]]));
    expect(columns[1].kind).toBe("string");
    expect([text(columns[1], 0), text(columns[1], 1)]).toEqual(["101", "A-7"]);
  });

  it("keeps two same-named columns of one file apart", () => {
    const a = alignColumns([["Amount", "Amount"]]);
    expect(a.length).toBe(2);
  });
});
