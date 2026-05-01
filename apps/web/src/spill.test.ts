import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(20, 8)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const history = new ActionHistory(sheetActions(), () => ctx);
  const sheet = workbook.sheets[0].source;
  const type = (cells: [string, string][]) =>
    history.run(setCells(cells.map(([ref, input]) => ({ row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65, input }))));
  const at = (ref: string) => sheet.getCell(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65);
  return { history, sheet, type, at };
}

describe("dynamic arrays", () => {
  it("a range times a number spills down", async () => {
    const { type, at, sheet } = setup();
    await type([["A1", "1"], ["A2", "2"], ["A3", "3"], ["B1", "=A1:A3*10"]]);
    expect([at("B1"), at("B2"), at("B3")]).toEqual([10, 20, 30]);
    expect(sheet.getEditText(1, 1)).toBe(""); // spilled, not typed
    expect(at("B4")).toBeNull();
  });

  it("something in the way gives #SPILL!, clearing it lets the array spill", async () => {
    const { type, at, history } = setup();
    await type([["A1", "1"], ["A2", "2"], ["B2", "x"], ["B1", "=A1:A2"]]);
    expect(at("B1")).toBe("#SPILL!");
    await type([["B2", ""]]);
    expect([at("B1"), at("B2")]).toEqual([1, 2]);
    await history.undo();
    expect(at("B1")).toBe("#SPILL!");
  });

  it("array constants, A1# references and dependents of spilled cells", async () => {
    const { type, at } = setup();
    await type([["A1", "={1,2,3;4,5,6}"], ["E1", "=SUM(A1#)"], ["E2", "=C2+1"]]);
    expect([at("A1"), at("C1"), at("A2"), at("C2")]).toEqual([1, 3, 4, 6]);
    expect(at("E1")).toBe(21);
    expect(at("E2")).toBe(7);
  });

  it("scalar functions work cell by cell over arrays", async () => {
    const { type, at } = setup();
    await type([["A1", "apple"], ["A2", "kiwi"], ["B1", "=UPPER(A1:A2)"], ["C1", '=IF(LEN(A1:A2)>4, "long", "short")']]);
    expect([at("B1"), at("B2")]).toEqual(["APPLE", "KIWI"]);
    expect([at("C1"), at("C2")]).toEqual(["long", "short"]);
  });

  it("LET, LAMBDA, MAP, REDUCE, BYROW", async () => {
    const { type, at } = setup();
    await type([
      ["A1", "1"],
      ["A2", "2"],
      ["A3", "3"],
      ["C1", "=LET(x, 5, y, x*2, x+y)"],
      ["C2", "=LAMBDA(n, n*n)(7)"],
      ["D1", "=MAP(A1:A3, LAMBDA(v, v+100))"],
      ["C3", "=REDUCE(0, A1:A3, LAMBDA(acc, v, acc+v))"],
      ["C4", "=LET(sq, LAMBDA(n, n*n), sq(4))"],
    ]);
    expect(at("C1")).toBe(15);
    expect(at("C2")).toBe(49);
    expect([at("D1"), at("D2"), at("D3")]).toEqual([101, 102, 103]);
    expect(at("C3")).toBe(6);
    expect(at("C4")).toBe(16);
  });
});
