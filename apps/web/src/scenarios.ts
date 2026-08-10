/**
 * Scenarios: named sets of values for a workbook's input cells (base,
 * best case, worst case…). Applying one writes its values into the inputs
 * as one undo step. Comparing works each scenario out on a copy of the
 * workbook (sheets share their imported data, so copies are cheap) and
 * reads the result cells, without touching the workbook itself.
 */
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import type { RecipeStep } from "./recipe";
import { Workbook } from "./workbook";

/** A cell by sheet name, so scenarios survive sheet ids changing (copies, reopened files). */
export interface ScenarioCell {
  sheet: string;
  row: number;
  col: number;
  /** a label for tables; defaults to Sheet!A1 */
  label?: string;
}

export interface Scenario {
  name: string;
  /** the input values, as typed (formulas allowed), in the same order as the model's inputs */
  values: (string | null)[];
}

export interface ScenarioModel {
  inputs: ScenarioCell[];
  results: ScenarioCell[];
  scenarios: Scenario[];
}

export const emptyScenarios = (): ScenarioModel => ({ inputs: [], results: [], scenarios: [] });

export const cellLabel = (c: ScenarioCell) => c.label ?? `${c.sheet}!${columnLetter(c.col)}${c.row + 1}`;

/** What's in the input cells now, as typed (so formulas stay formulas). */
export function captureInputs(wb: Workbook, inputs: readonly ScenarioCell[]): (string | null)[] {
  return inputs.map((c) => {
    const sheet = wb.byName(c.sheet);
    if (!sheet) return null;
    const t = sheet.source.getEditText(c.row, c.col);
    return t === "" ? null : t;
  });
}

/** The steps that put a scenario's values into the inputs (one per sheet), for recipe.run. */
export function scenarioSteps(model: ScenarioModel, scenario: Scenario): RecipeStep[] {
  const bySheet = new Map<string, { row: number; col: number; input: string | null }[]>();
  model.inputs.forEach((c, i) => {
    const list = bySheet.get(c.sheet) ?? [];
    list.push({ row: c.row, col: c.col, input: scenario.values[i] ?? null });
    bySheet.set(c.sheet, list);
  });
  return [...bySheet].map(([sheet, cells]) => ({ action: setCells(cells, `scenario "${scenario.name}"`), sheet, label: `${scenario.name}: ${sheet}`, enabled: true }));
}

/** The action that applies a scenario (one undo step). */
export function applyScenarioAction(model: ScenarioModel, scenario: Scenario): Action {
  return { type: "recipe.run", params: { name: `scenario ${scenario.name}`, steps: scenarioSteps(model, scenario) } };
}

/** A copy of the workbook for working scenarios out: same names, sheets cloned. */
function copyOf(wb: Workbook): Workbook {
  const [first, ...rest] = wb.sheets;
  const copy = new Workbook({ name: first.name, source: first.source.clone() });
  for (const s of rest) copy.add(s.name, s.source.clone());
  for (const n of wb.definedNames) copy.setName(n);
  copy.iterative = wb.iterative;
  return copy;
}

export interface Comparison {
  /** one row per result cell */
  rows: { label: string; values: (number | string | null)[] }[];
  scenarios: string[];
}

/** Every scenario's results, side by side. The first scenario is the base the others are compared with. */
export async function compareScenarios(wb: Workbook, model: ScenarioModel): Promise<Comparison> {
  const registry = sheetActions();
  const columns: (number | string | null)[][] = [];
  for (const sc of model.scenarios) {
    const copy = copyOf(wb);
    const ctx: SheetCtx = { workbook: copy, activeSheet: copy.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(registry, () => ctx);
    await h.run(applyScenarioAction(model, sc), "recipe");
    columns.push(
      model.results.map((c) => {
        const sheet = copy.byName(c.sheet);
        return sheet ? sheet.source.getCell(c.row, c.col) : null;
      }),
    );
  }
  return {
    scenarios: model.scenarios.map((s) => s.name),
    rows: model.results.map((c, i) => ({ label: cellLabel(c), values: columns.map((col) => col[i]) })),
  };
}
