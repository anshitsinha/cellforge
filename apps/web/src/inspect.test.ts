import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { inspectCell } from "./inspect";
import { Workbook } from "./workbook";

async function setup() {
  const workbook = new Workbook({ name: "Calc", source: new EditableSource(new BlankSource(20, 6)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const history = new ActionHistory(sheetActions(), () => ctx);
  await history.run({ type: "sheet.add", params: { name: "Report" } });
  const id = workbook.sheets[0].id;
  const report = workbook.sheets[1].id;
  const put = (cells: [string, string][], sheet = id) =>
    history.run(setCells(cells.map(([ref, input]) => ({ row: Number(ref.slice(1)) - 1, col: ref.charCodeAt(0) - 65, input })), undefined, sheet));
  return { workbook, history, id, report, put };
}

describe("inspecting a cell", () => {
  it("shows steps, precedents and dependents across sheets", async () => {
    const { workbook, history, id, report, put } = await setup();
    await put([["A1", "10"], ["A2", "20"], ["A3", "30"], ["B1", "=A1*2"]]);
    await history.run({ type: "fill.down", params: { range: { top: 0, left: 1, bottom: 2, right: 1 } } });
    await put([["C1", "=SUM(A1:A3)*1.2"]]);
    await put([["A1", "=Calc!A2+1"]], report);
    const i = inspectCell(workbook, id, 1, 0); // A2
    expect(i.formula).toBeNull();
    expect(i.dependents.map((d) => d.label).sort()).toEqual(["B2", "C1", "Report!A1"]);
    const c = inspectCell(workbook, id, 0, 2); // C1
    expect(c.steps?.value).toBe("72");
    expect(c.precedents.map((p) => p.label)).toEqual(["A1:A3"]);
    expect(c.findings.map((f) => f.kind)).toEqual(["hard-coded"]);
  });

  it("flags a formula unlike its neighbours, an empty input and #REF!", async () => {
    const { workbook, id, put } = await setup();
    await put([["A1", "1"], ["A2", "2"], ["A3", "3"], ["B1", "=A1*2"], ["B2", "=A2*3"], ["B3", "=A3*2"], ["D1", "=E9+1"], ["D2", "=#REF!+1"]]);
    const kinds = (r: number, c: number) => inspectCell(workbook, id, r, c).findings.map((f) => f.kind);
    expect(kinds(1, 1)).toContain("inconsistent");
    expect(kinds(0, 1)).not.toContain("inconsistent");
    expect(kinds(0, 3)).toContain("empty-input");
    expect(kinds(1, 3)).toContain("ref-error");
  });
});
