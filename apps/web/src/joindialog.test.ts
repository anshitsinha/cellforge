import { describe, expect, it } from "vitest";
import { Table, type ColumnData } from "@cellforge/core";
import { glToTb, tbCompare } from "../../../packages/core/src/join";
import { EditableSource } from "./editable";
import {
  cellInput,
  compareResultSheets,
  compareSheets,
  guessGlMap,
  guessKeyPair,
  guessMappingCols,
  joinSheet,
  mappingCells,
  pairColumns,
  readColumn,
  readGl,
  readTbSheet,
  suggestionSheet,
  tbCompareSheet,
  tieSheet,
  toColumn,
  type JoinSpec,
} from "./joindialog";

const str = (name: string, values: string[]): ColumnData => {
  const dict = [...new Set(values.filter(Boolean))];
  return { kind: "string", name, codes: Uint32Array.from(values, (v) => (v ? dict.indexOf(v) + 1 : 0)), dict };
};
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });
const sheet = (...cols: ColumnData[]) => new EditableSource(new Table(cols));
const vals = (c: ColumnData | undefined): Array<string | number | null> =>
  !c ? [] : c.kind === "number" ? [...c.values].map((v) => (Number.isNaN(v) ? null : v)) : [...c.codes].map((k) => (k ? c.dict[k - 1] : null));
const col = (cols: ColumnData[], name: string) => cols.find((c) => c.name === name);

describe("join dialog helpers", () => {
  it("makes number columns when every value is a number, text otherwise", () => {
    expect(toColumn("n", [1, null, 2]).kind).toBe("number");
    expect(vals(toColumn("t", [1, "a", null]))).toEqual(["1", "a", null]);
  });

  it("guesses the key columns from overlapping values", () => {
    const a = sheet(str("Name", ["Acme", "Beta", "Gamma"]), num("Customer ID", [101, 102, 103]), num("Amount", [5, 6, 7]));
    const b = sheet(str("Cust no", ["00101", "00103", "00104"]), str("Region", ["N", "S", "N"]));
    expect(guessKeyPair(a, b)).toEqual([1, 0]);
  });

  it("joins two sheets, bringing the chosen columns and saying how each row matched", () => {
    const a = sheet(num("ID", [1, 2, 3]), str("Name", ["Acme", "Beta", "Gamma"]));
    const b = sheet(str("ID", ["001", "003", "003", "009"]), num("Amount", [10, 30, 31, 90]));
    const spec: JoinSpec = { keysA: [0], keysB: [0], kind: "left", normalise: { numbers: true }, many: "flag", fuzzy: null, names: false, bringA: [0, 1], bringB: [0, 1] };
    const { sheet: s, result } = joinSheet(a, b, "Sales", "Ledger", spec);
    expect(s.name).toBe("Join Sales + Ledger");
    expect(s.columns.map((c) => c.name)).toEqual(["ID", "Name", "ID (Ledger)", "Amount", "Match", "Sales row", "Ledger row"]);
    expect(s.numFmts.length).toBe(s.columns.length);
    expect(vals(col(s.columns, "Name"))).toEqual(["Acme", "Beta", "Gamma", "Gamma"]);
    expect(vals(col(s.columns, "Amount"))).toEqual([10, null, 30, 31]);
    expect(vals(col(s.columns, "Match"))).toEqual(["match", "only in Sales", "match; one of several matches", "match; one of several matches"]);
    expect(vals(col(s.columns, "Ledger row"))).toEqual([1, null, 2, 3]);
    expect(result.matchedRight).toBe(3);
    const anti = joinSheet(a, b, "Sales", "Ledger", { ...spec, kind: "anti" }).sheet;
    expect(anti.columns.map((c) => c.name)).toEqual(["ID", "Name", "Match", "Sales row"]);
    expect(vals(anti.columns[1])).toEqual(["Beta"]);
  });

  it("compares two versions by key into added, removed and changed sheets", () => {
    const oldS = sheet(str("Code", ["A", "B", "C"]), num("Qty", [1, 2, 3]), str("Desc", ["x", "y", "z"]));
    const newS = sheet(str("code ", ["B", "C", "D"]), str("Desc", ["y", "zz", "w"]), num("Qty", [2, 3.5, 4]));
    const pairs = pairColumns(["Code", "Qty", "Desc"], ["code ", "Desc", "Qty"]);
    expect(pairs).toEqual([
      [0, 0],
      [1, 2],
      [2, 1],
    ]);
    const spec = { keys: [pairs[0]], compare: pairs.slice(1), tolerance: 0, ignoreCase: false, trim: true, normalise: {} };
    const r = compareSheets(oldS, newS, spec);
    expect(r.added).toEqual([2]);
    expect(r.removed).toEqual([0]);
    expect(r.unchanged).toBe(1);
    const [added, removed, changed] = compareResultSheets(oldS, newS, spec, r);
    expect(added.name).toBe("Compare added");
    expect(vals(col(added.columns, "code "))).toEqual(["D"]);
    expect(vals(col(removed.columns, "Old row"))).toEqual([1]);
    expect(vals(col(changed.columns, "Code"))).toEqual(["C", "C"]);
    expect(vals(col(changed.columns, "Column"))).toEqual(["Qty", "Desc"]);
    expect(vals(col(changed.columns, "Old"))).toEqual(["3", "z"]);
    expect(vals(col(changed.columns, "New"))).toEqual(["3.5", "zz"]);
    expect(vals(col(changed.columns, "Difference"))).toEqual([0.5, null]);
    for (const s of [added, removed, changed]) expect(s.numFmts.length).toBe(s.columns.length);
  });

  it("reads trial balances from sheets and lays out the compare", () => {
    const cur = sheet(str("Account", ["1000", "2000", "4000"]), str("Name", ["Cash", "Payables", "Sales"]), num("Debit", [500, 0, 0]), num("Credit", [0, 300, 200]));
    const pri = sheet(str("Code", ["1000", "2000"]), str("Description", ["Cash", "Payables"]), num("Balance", [400, -400]));
    const a = readTbSheet(cur);
    expect(a.lines.map((l) => [l.code, l.current])).toEqual([
      ["1000", 500],
      ["2000", -300],
      ["4000", -200],
    ]);
    expect(a.balances).toBe(true);
    const r = tbCompare(a.lines, readTbSheet(pri).lines);
    const s = tbCompareSheet(r, "2024", "2023");
    expect(s.columns.map((c) => c.name)).toEqual(["Account", "Name", "2024", "2023", "Movement", "Movement %", "Status", "Name in 2023"]);
    expect(vals(col(s.columns, "Movement"))).toEqual([100, 100, -200]);
    expect(vals(col(s.columns, "Status"))).toEqual([null, null, "only in 2024"]);
  });

  it("maps GL columns and ties out to the TB", () => {
    expect(guessGlMap(["Date", "Account", "Narrative", "Debit", "Credit"])).toEqual({ account: 1, amount: -1, debit: 3, credit: 4 });
    expect(guessGlMap(["GL code", "Amount"])).toEqual({ account: 0, amount: 1, debit: -1, credit: -1 });
    const gl = sheet(str("Account", ["1000", "1000", "2000", ""]), str("Debit", ["300", "200", "", "5"]), num("Credit", [0, 0, 250, 0]));
    const g = readGl(gl, guessGlMap(["Account", "Debit", "Credit"]));
    expect(g.lines).toHaveLength(3);
    const r = glToTb(g.lines, [
      { code: "1000", name: "Cash", current: 500 },
      { code: "2000", name: "Payables", current: -300 },
    ]);
    const s = tieSheet(r);
    expect(vals(col(s.columns, "Difference"))).toEqual([0, 50]);
    expect(vals(col(s.columns, "Status"))).toEqual(["agrees", "differs"]);
  });

  it("applies a mapping table, keeping number and text types", () => {
    expect(guessMappingCols(["Name as written", "Standard name"])).toEqual([0, 1]);
    expect(guessMappingCols(["A", "B", "C"])).toEqual([0, 1]);
    expect(guessMappingCols(["Code", "Map to"])).toEqual([0, 1]);
    expect(cellInput("00123")).toBe("'00123");
    expect(cellInput("=1+1")).toBe("'=1+1");
    expect(cellInput("Acme")).toBe("Acme");
    expect(cellInput(5)).toBe("5");
    const r = mappingCells(["acme ltd", "Beta", "Gamma", null], [["ACME LTD", 4000], ["beta", "00200"]], { match: "trim+case", fuzzy: null, keepUnmapped: true });
    expect(r.inputs).toEqual(["4000", "'00200", "Gamma", null]);
    expect(r.mapped).toBe(2);
    expect(r.unmapped).toEqual([{ value: "Gamma", count: 1 }]);
    const n = mappingCells(["Smith, John"], [["John Smith", "J Smith (staff)"]], { match: "name", fuzzy: null, keepUnmapped: false });
    expect(n.inputs).toEqual(["J Smith (staff)"]);
  });

  it("suggests a mapping table from a column and a master list", () => {
    const s = suggestionSheet(["Smith, John", "Acme Ltd", "Acme Ltd", "Zed"], ["John Smith", "ACME Limited", "Other"], 0.85);
    expect(vals(s.columns[0])).toEqual(["Acme Ltd", "Smith, John"]);
    expect(vals(s.columns[1])).toEqual(["ACME Limited", "John Smith"]);
  });

  it("reads a column below the header row", () => {
    const src = sheet(str("", ["Ref", "A1", "A2"]), str("", ["Amount", "1", "2"]));
    expect(readColumn(src, 0)).toEqual(["A1", "A2"]);
  });
});
