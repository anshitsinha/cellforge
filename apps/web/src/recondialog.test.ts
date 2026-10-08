import { describe, expect, it } from "vitest";
import { Table, type ColumnData } from "@cellforge/core";
import { reconcile } from "@cellforge/core";
import { EditableSource } from "./editable";
import { guessMap, pickSides, readSide, reconSheets, sheetHeader } from "./recondialog";

const str = (name: string, values: string[]): ColumnData => {
  const dict = [...new Set(values.filter(Boolean))];
  return { kind: "string", name, codes: Uint32Array.from(values, (v) => (v ? dict.indexOf(v) + 1 : 0)), dict };
};
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });

describe("reconcile dialog helpers", () => {
  it("guesses the columns from named headers and reads the records", () => {
    const src = new EditableSource(
      new Table([str("Posting date", ["01/02/2024", "13/02/2024", ""]), str("Invoice no", ["INV-001", "INV-002", ""]), str("Narrative", ["Acme", "Globex", ""]), num("Debit", [100, 0, NaN]), num("Credit", [0, 25.5, NaN])]),
    );
    expect(sheetHeader(src)).toEqual({ names: ["Posting date", "Invoice no", "Narrative", "Debit", "Credit"], first: 0 });
    const map = guessMap(src);
    expect(map).toEqual({ date: 0, key: 1, text: 2, amount: 3, minus: 4 });
    const side = readSide(src, map);
    expect(side.dateOrder).toBe("dmy");
    expect(side.records).toEqual([
      { row: 1, key: "INV-001", amount: 100, date: 45323, text: "Acme" },
      { row: 2, key: "INV-002", amount: -25.5, date: 45335, text: "Globex" },
    ]);
  });

  it("uses the first row as the header when the sheet has no column names", () => {
    const src = new EditableSource(new Table([str("", ["Ref", "A1", "A2"]), str("", ["Amount", "10.00", "(5.00)"])]));
    const h = sheetHeader(src);
    expect(h).toEqual({ names: ["Ref", "Amount"], first: 1 });
    const side = readSide(src, guessMap(src));
    expect(side.records).toEqual([
      { row: 2, key: "A1", amount: 10 },
      { row: 3, key: "A2", amount: -5 },
    ]);
  });

  it("builds the four result sheets with original row numbers", () => {
    const a = [
      { row: 2, key: "K1", amount: 100 },
      { row: 3, key: "K2", amount: 1234 },
      { row: 4, key: "K3", amount: 7 },
    ];
    const b = [
      { row: 5, key: "K1", amount: 100 },
      { row: 6, key: "K2", amount: 1243 },
      { row: 7, key: "Z", amount: 99 },
    ];
    const r = reconcile(a, b, {});
    const sheets = reconSheets(r, a, b);
    expect(sheets.map((s) => s.name)).toEqual(["Rec matched", "Rec unmatched A", "Rec unmatched B", "Rec mismatched"]);
    for (const s of sheets) expect(s.numFmts.length).toBe(s.columns.length);
    const col = (s: number, name: string) => sheets[s].columns.find((c) => c.name === name)!;
    const rows = (c: ColumnData) => (c.kind === "number" ? [...c.values] : []);
    expect(rows(col(0, "Sheet row"))).toEqual([2, 5]);
    expect(rows(col(1, "Sheet row"))).toEqual([4]);
    expect(rows(col(2, "Sheet row"))).toEqual([7]);
    expect(rows(col(3, "A row"))).toEqual([3]);
    expect(rows(col(3, "Difference"))).toEqual([-9]);
    const note = col(3, "Note");
    expect(note.kind === "string" && note.dict[note.codes[0] - 1]).toContain("two digits swapped");
  });
});

describe("picking the two sides", () => {
  const sheets = [
    { id: "s", name: "Start here", amounts: false },
    { id: "c", name: "Cash book", amounts: true },
    { id: "b", name: "Bank statement", amounts: true },
    { id: "o", name: "Outstanding", amounts: true },
  ];
  it("skips sheets without amounts and puts the bank on side B", () => {
    expect(pickSides(sheets, "s")).toEqual(["c", "b"]);
    expect(pickSides(sheets, "b")).toEqual(["c", "b"]);
  });
  it("keeps the sheet on screen as side A when it has amounts", () => {
    expect(pickSides(sheets, "o")).toEqual(["o", "b"]);
    expect(pickSides([{ id: "1", name: "Sheet1", amounts: true }, { id: "2", name: "Sheet2", amounts: true }], "2")).toEqual(["2", "1"]);
  });
  it("falls back on the order when nothing has amounts", () => {
    expect(pickSides([{ id: "1", name: "Sheet1", amounts: false }, { id: "2", name: "Sheet2", amounts: false }], "1")).toEqual(["1", "2"]);
  });
});
