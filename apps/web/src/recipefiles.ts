/**
 * Running a recipe on new files: each of the recipe's input sheets is
 * filled from a file (CSV, Excel, JSON, Parquet), the recipe runs on a
 * separate, fresh workbook, and the results are added to this workbook or
 * downloaded as Excel files. A folder means one run per file, for recipes
 * with one input. Every run is reported: which file, whether it worked,
 * which step failed, and how long it took.
 */
import { ActionHistory, BlobStore, type Action, type ActionRegistry } from "@cellforge/actions";
import { radixSortIndices, Table, type FilePart } from "@cellforge/core";
import type { SheetCtx } from "./actions";
import { readPart } from "./combine";
import { pickFiles } from "./combinedialog";
import { EditableSource } from "./editable";
import type { Recipe } from "./recipe";
import { extractKeys } from "./sort";
import { Workbook } from "./workbook";
import { saveXlsx } from "./xlsxio";

/** The sheet names a recipe works on, in the order it first uses them. */
export function recipeInputs(recipe: Recipe): string[] {
  const out: string[] = [];
  const add = (n: string) => n && !out.includes(n) && out.push(n);
  for (const s of recipe.steps) {
    if (!s.enabled) continue;
    add(s.sheet);
    const p = s.action.params as Record<string, unknown>;
    for (const k of ["sheet", "fromSheet"]) if (typeof p[k] === "string" && (p[k] as string).startsWith("@")) add((p[k] as string).slice(1));
  }
  return out;
}

/** A sheet made from a file's data. */
export function sheetFromPart(part: FilePart): EditableSource {
  const src = new EditableSource(new Table(part.columns), 10);
  (part.numFmts ?? []).forEach((numFmt, col) => {
    if (numFmt) src.styles.apply(col, "all", { numFmt });
  });
  return src;
}

export interface RunResult {
  label: string;
  ok: boolean;
  /** the error, naming the step that failed */
  message?: string;
  ms: number;
  workbook?: Workbook;
}

/** Run a recipe on a fresh workbook whose sheets are the given inputs (by name). */
export async function runOnInputs(registry: ActionRegistry<SheetCtx>, recipe: Recipe, inputs: Map<string, EditableSource>, label: string): Promise<RunResult> {
  const t0 = performance.now();
  const names = [...inputs.keys()];
  if (!names.length) return { label, ok: false, message: "No input sheets.", ms: 0 };
  const workbook = new Workbook({ name: names[0], source: inputs.get(names[0])! });
  for (const n of names.slice(1)) workbook.add(n, inputs.get(n)!);
  const ctx: SheetCtx = {
    workbook,
    activeSheet: workbook.sheets[0].id,
    blobs: new BlobStore(),
    // the same sort the app runs in a worker, on this thread (view rows in, view order out)
    sortRows: async (sheet, col, descending) => {
      const { keys, kinds } = await extractKeys(sheet, col, descending);
      return radixSortIndices(keys, kinds, descending);
    },
  };
  const history = new ActionHistory(registry, () => ctx);
  try {
    const action: Action = { type: "recipe.run", params: { name: recipe.name, steps: recipe.steps } };
    await history.run(action, "recipe");
    return { label, ok: true, ms: performance.now() - t0, workbook };
  } catch (e) {
    return { label, ok: false, message: (e as Error).message, ms: performance.now() - t0 };
  }
}

export interface RecipeFilesDeps {
  registry: ActionRegistry<SheetCtx>;
  /** add a finished workbook's sheets to this one (names prefixed) */
  addSheets: (wb: Workbook, prefix: string) => Promise<void>;
  status: (t: string) => void;
  focusGrid: () => void;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The dialog: pick files for each input (or a folder), run, show the report. */
export function openRunOnFiles(d: RecipeFilesDeps, recipe: Recipe): void {
  const inputs = recipeInputs(recipe);
  const chosen = new Map<string, File>();
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-label="Run on files"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = Object.assign(document.createElement("h3"), { textContent: `Run "${recipe.name}" on files` });
  const intro = Object.assign(document.createElement("p"), {
    className: "hp-muted",
    textContent: inputs.length === 1 ? `The recipe works on one sheet, "${inputs[0]}". Pick a file for it, or a folder to run once per file.` : `The recipe works on ${inputs.length} sheets. Pick a file for each.`,
  });
  body.append(h, intro);
  const table = document.createElement("table");
  table.className = "cleanup-cols";
  for (const name of inputs) {
    const tr = document.createElement("tr");
    const label = Object.assign(document.createElement("td"), { textContent: name });
    const fileCell = Object.assign(document.createElement("td"), { textContent: "(no file)" });
    const pick = Object.assign(document.createElement("button"), { type: "button", textContent: "Choose file…" });
    pick.addEventListener("click", async () => {
      const got = await pickFiles(false);
      if (got?.files[0]) {
        chosen.set(name, got.files[0]);
        fileCell.textContent = got.files[0].name;
      }
    });
    const td = document.createElement("td");
    td.append(pick);
    tr.append(label, fileCell, td);
    table.append(tr);
  }
  body.append(table);
  const where = document.createElement("select");
  where.setAttribute("aria-label", "Where the results go");
  where.append(new Option("Add the results to this workbook", "add"), new Option("Download each result as an Excel file", "download"));
  const whereLabel = document.createElement("label");
  whereLabel.append("Results: ", where);
  body.append(whereLabel);
  const report = document.createElement("div");
  body.append(report);
  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "Close" });
  const folder = Object.assign(document.createElement("button"), { type: "button", textContent: "Run on a folder…", hidden: inputs.length !== 1 });
  const go = Object.assign(document.createElement("button"), { type: "button", textContent: "Run" });
  actions.append(close, folder, go);
  body.append(actions);
  document.body.append(back);
  close.addEventListener("click", () => {
    back.remove();
    d.focusGrid();
  });
  back.addEventListener("keydown", (e) => e.key === "Escape" && close.click());

  const showReport = (results: RunResult[]) => {
    const t = document.createElement("table");
    t.className = "cleanup-cols";
    t.innerHTML = "<tr><th>Run</th><th>Result</th><th>Time</th></tr>";
    for (const r of results) {
      const tr = document.createElement("tr");
      const res = Object.assign(document.createElement("td"), { textContent: r.ok ? "done" : r.message ?? "failed" });
      if (!r.ok) res.className = "cleanup-warn";
      tr.append(Object.assign(document.createElement("td"), { textContent: r.label }), res, Object.assign(document.createElement("td"), { textContent: `${(r.ms / 1000).toFixed(2)} s` }));
      t.append(tr);
    }
    const ok = results.filter((r) => r.ok).length;
    report.replaceChildren(Object.assign(document.createElement("p"), { textContent: `${ok} of ${results.length} run${results.length === 1 ? "" : "s"} worked.` }), t);
  };

  const finish = async (r: RunResult) => {
    if (!r.ok || !r.workbook) return;
    const stem = r.label.replace(/\.[^.]+$/, "");
    if (where.value === "add") await d.addSheets(r.workbook, stem);
    else download(await saveXlsx(r.workbook), `${stem} - ${recipe.name}.xlsx`);
  };

  const runBatch = async (batches: { label: string; files: Map<string, File> }[]) => {
    go.disabled = folder.disabled = true;
    const results: RunResult[] = [];
    for (const [i, b] of batches.entries()) {
      d.status(`Running "${recipe.name}" (${i + 1} of ${batches.length}): ${b.label}`);
      const sheets = new Map<string, EditableSource>();
      let failed: RunResult | null = null;
      for (const name of inputs) {
        const f = b.files.get(name)!;
        try {
          sheets.set(name, sheetFromPart(await readPart(f)));
        } catch (e) {
          failed = { label: b.label, ok: false, message: `Couldn't read ${f.name}: ${(e as Error).message}`, ms: 0 };
          break;
        }
      }
      const r = failed ?? (await runOnInputs(d.registry, recipe, sheets, b.label));
      await finish(r);
      results.push({ ...r, workbook: undefined });
      showReport(results);
    }
    d.status(`Ran "${recipe.name}" ${batches.length} time${batches.length === 1 ? "" : "s"}`);
    go.disabled = folder.disabled = false;
  };

  go.addEventListener("click", () => {
    const missing = inputs.filter((n) => !chosen.has(n));
    if (missing.length) {
      report.replaceChildren(Object.assign(document.createElement("p"), { className: "cleanup-warn", textContent: `Choose a file for ${missing.join(", ")}.` }));
      return;
    }
    void runBatch([{ label: [...chosen.values()].map((f) => f.name).join(" + "), files: new Map(chosen) }]);
  });
  folder.addEventListener("click", async () => {
    const got = await pickFiles(true);
    if (!got?.files.length) return;
    void runBatch(got.files.map((f) => ({ label: f.name, files: new Map([[inputs[0], f]]) })));
  });
}
