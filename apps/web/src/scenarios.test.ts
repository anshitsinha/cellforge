import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { applyScenarioAction, captureInputs, compareScenarios, type ScenarioModel } from "./scenarios";
import { Workbook } from "./workbook";

async function setup() {
  const workbook = new Workbook({ name: "Inputs", source: new EditableSource(new BlankSource(10, 3)) });
  workbook.add("Model", new EditableSource(new BlankSource(10, 3)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  // inputs: growth and price; result: revenue = 1000 units * (1 + growth) * price
  await h.run(setCells([{ row: 0, col: 0, input: "0.05" }, { row: 1, col: 0, input: "10" }]));
  await h.run(setCells([{ row: 0, col: 0, input: "=1000*(1+Inputs!A1)*Inputs!A2" }, { row: 1, col: 0, input: "=A1*0.3" }], undefined, workbook.sheets[1].id));
  const model: ScenarioModel = {
    inputs: [
      { sheet: "Inputs", row: 0, col: 0, label: "Growth" },
      { sheet: "Inputs", row: 1, col: 0, label: "Price" },
    ],
    results: [
      { sheet: "Model", row: 0, col: 0, label: "Revenue" },
      { sheet: "Model", row: 1, col: 0, label: "Margin" },
    ],
    scenarios: [],
  };
  model.scenarios.push({ name: "Base", values: captureInputs(workbook, model.inputs) });
  model.scenarios.push({ name: "Best", values: ["0.2", "12"] });
  model.scenarios.push({ name: "Worst", values: ["-0.1", "=8+1"] });
  return { workbook, h, model };
}

describe("scenarios", () => {
  it("compare results across scenarios without changing the workbook", async () => {
    const { workbook, model } = await setup();
    expect(model.scenarios[0].values).toEqual(["0.05", "10"]);
    const cmp = await compareScenarios(workbook, model);
    expect(cmp.scenarios).toEqual(["Base", "Best", "Worst"]);
    expect(cmp.rows.map((r) => [r.label, ...r.values.map((v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v))])).toEqual([
      ["Revenue", 10500, 14400, 8100],
      ["Margin", 3150, 4320, 2430],
    ]);
    // the workbook itself still has the base inputs
    expect(workbook.sheets[0].source.getCell(0, 0)).toBe(0.05);
    expect(workbook.sheets[1].source.getCell(0, 0)).toBe(10500);
  });

  it("apply a scenario as one undo step, and are saved with the workbook", async () => {
    const { workbook, h, model } = await setup();
    await h.run({ type: "scenarios.set", params: { model } });
    await h.run(applyScenarioAction(model, model.scenarios[2]));
    expect(workbook.sheets[1].source.getCell(0, 0)).toBe(8100);
    expect(workbook.sheets[0].source.getEditText(1, 0)).toBe("=8+1");
    await h.undo();
    expect(workbook.sheets[1].source.getCell(0, 0)).toBe(10500);

    const { packWorkbook, unpackWorkbook } = await import("./persist");
    const packed = packWorkbook(workbook, workbook.sheets[0].id, "Plan");
    const back = await unpackWorkbook(JSON.parse(JSON.stringify(packed.meta)), async (n) => packed.files.get(n)!);
    expect(back.workbook.scenarios.scenarios.map((s) => s.name)).toEqual(["Base", "Best", "Worst"]);
    await expect(h.run({ type: "scenarios.set", params: { model: { ...model, scenarios: [{ name: "Bad", values: ["1"] }] } } })).rejects.toThrow(/1 values for 2 inputs/);
  });
});
