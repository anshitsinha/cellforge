/**
 * The scenario manager: which cells are inputs and which are results (from
 * the selection), the scenarios with their input values (editable), apply
 * one, and compare them all side by side on a summary sheet.
 */
import type { Action } from "@cellforge/actions";
import { Table, type ColumnData } from "@cellforge/core";
import type { CellRange } from "@cellforge/grid";
import { EditableSource } from "./editable";
import { applyScenarioAction, captureInputs, cellLabel, compareScenarios, type ScenarioCell, type ScenarioModel } from "./scenarios";
import type { Workbook } from "./workbook";

export interface ScenarioDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  range: () => CellRange;
  run: (a: Action) => Promise<unknown>;
  putBlob: (v: unknown) => string;
  status: (t: string) => void;
  focusGrid: () => void;
}

function cellsOf(wb: Workbook, sheetId: string, r: CellRange): ScenarioCell[] {
  const name = wb.get(sheetId).name;
  const out: ScenarioCell[] = [];
  for (let row = r.top; row <= r.bottom && out.length < 200; row++) for (let col = r.left; col <= r.right && out.length < 200; col++) out.push({ sheet: name, row, col });
  return out;
}

/** Results as a sheet: one row per result, a column per scenario and its difference from the first. */
export function comparisonColumns(cmp: Awaited<ReturnType<typeof compareScenarios>>): ColumnData[] {
  const text = (name: string, values: string[]): ColumnData => {
    const dict = [...new Set(values.filter(Boolean))];
    return { kind: "string", name, codes: Uint32Array.from(values, (v) => (v ? dict.indexOf(v) + 1 : 0)), dict };
  };
  const cols: ColumnData[] = [text("Result", cmp.rows.map((r) => r.label))];
  cmp.scenarios.forEach((name, i) => {
    const values = cmp.rows.map((r) => r.values[i]);
    if (values.every((v) => typeof v === "number" || v === null)) cols.push({ kind: "number", name, values: Float64Array.from(values, (v) => (typeof v === "number" ? v : NaN)) });
    else cols.push(text(name, values.map((v) => (v === null ? "" : String(v)))));
    if (i > 0) {
      const diff = cmp.rows.map((r) => (typeof r.values[i] === "number" && typeof r.values[0] === "number" ? (r.values[i] as number) - (r.values[0] as number) : NaN));
      cols.push({ kind: "number", name: `${name} − ${cmp.scenarios[0]}`, values: Float64Array.from(diff) });
    }
  });
  return cols;
}

export function openScenarios(d: ScenarioDeps): void {
  document.querySelector(".scenario-panel")?.remove();
  const panel = document.createElement("aside");
  panel.className = "recipe-panel scenario-panel";
  panel.setAttribute("aria-label", "Scenarios");
  document.body.append(panel);
  const save = (m: ScenarioModel) => d.run({ type: "scenarios.set", params: { model: m } }).then(render);
  const btn = (text: string, fn: () => void, title = "") => {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: text, title });
    b.addEventListener("click", fn);
    return b;
  };

  function render() {
    const wb = d.workbook();
    const m: ScenarioModel = structuredClone(wb.scenarios);
    panel.replaceChildren();
    const head = document.createElement("div");
    head.className = "recipe-head";
    head.append(Object.assign(document.createElement("strong"), { textContent: "Scenarios" }), btn("×", () => panel.remove(), "Close"));
    panel.append(head);

    const cellsLine = (title: string, cells: ScenarioCell[], set: (c: ScenarioCell[]) => void) => {
      const box = document.createElement("div");
      box.className = "review-sheet";
      box.append(
        Object.assign(document.createElement("strong"), { textContent: title }),
        Object.assign(document.createElement("div"), { className: "hp-muted", textContent: cells.length ? cells.map(cellLabel).join(", ") : "none yet" }),
        btn("Use the selected cells", () => set(cellsOf(wb, d.activeSheet(), d.range()))),
      );
      panel.append(box);
    };
    cellsLine("Inputs (the cells scenarios change)", m.inputs, (c) => {
      // changing the inputs keeps each scenario's values for cells it already had
      const keep = (vals: (string | null)[]) => c.map((nc) => {
        const i = m.inputs.findIndex((oc) => oc.sheet === nc.sheet && oc.row === nc.row && oc.col === nc.col);
        return i >= 0 ? vals[i] : null;
      });
      void save({ inputs: c, results: m.results, scenarios: m.scenarios.map((s) => ({ ...s, values: keep(s.values) })) });
    });
    cellsLine("Results (the cells to compare)", m.results, (c) => void save({ ...m, results: c }));

    if (m.inputs.length) {
      const t = document.createElement("table");
      t.className = "cleanup-cols";
      const hr = document.createElement("tr");
      hr.append(Object.assign(document.createElement("th"), { textContent: "Scenario" }), ...m.inputs.map((c) => Object.assign(document.createElement("th"), { textContent: cellLabel(c) })), document.createElement("th"));
      t.append(hr);
      m.scenarios.forEach((sc, si) => {
        const tr = document.createElement("tr");
        const name = Object.assign(document.createElement("input"), { value: sc.name, size: 10 });
        name.setAttribute("aria-label", "Scenario name");
        name.addEventListener("change", () => {
          m.scenarios[si].name = name.value.trim() || sc.name;
          void save(m);
        });
        const nameTd = document.createElement("td");
        nameTd.append(name);
        tr.append(nameTd);
        sc.values.forEach((v, vi) => {
          const input = Object.assign(document.createElement("input"), { value: v ?? "", size: 8 });
          input.setAttribute("aria-label", `${sc.name}: ${cellLabel(m.inputs[vi])}`);
          input.addEventListener("change", () => {
            m.scenarios[si].values[vi] = input.value === "" ? null : input.value;
            void save(m);
          });
          const td = document.createElement("td");
          td.append(input);
          tr.append(td);
        });
        const tools = document.createElement("td");
        tools.append(
          btn("Show", () => void d.run(applyScenarioAction(m, sc)).then(() => d.status(`Showing scenario "${sc.name}" (undo to go back)`)), "Put these values into the input cells"),
          btn("✕", () => {
            m.scenarios.splice(si, 1);
            void save(m);
          }, "Delete this scenario"),
        );
        tr.append(tools);
        t.append(tr);
      });
      const wrap = document.createElement("div");
      wrap.className = "import-preview";
      wrap.append(t);
      panel.append(wrap);
    }

    const actions = document.createElement("div");
    actions.className = "numfmt-actions";
    actions.append(
      btn("Add the current inputs as a scenario", () => {
        if (!m.inputs.length) return d.status("Pick the input cells first.");
        m.scenarios.push({ name: m.scenarios.length ? `Scenario ${m.scenarios.length + 1}` : "Base", values: captureInputs(wb, m.inputs) });
        void save(m);
      }),
      btn("Compare on a new sheet", async () => {
        if (!m.results.length || m.scenarios.length < 1) return d.status("Pick result cells and add at least one scenario.");
        d.status("Working out each scenario…");
        const cmp = await compareScenarios(wb, m);
        const source = new EditableSource(new Table(comparisonColumns(cmp)), 5);
        await d.run({ type: "sheet.insert", params: { name: "Scenario comparison", source: d.putBlob(source), origin: `Scenarios compared: ${cmp.scenarios.join(", ")}` } });
        d.status(`Compared ${cmp.scenarios.length} scenarios`);
      }),
    );
    panel.append(actions);
    panel.append(
      Object.assign(document.createElement("p"), {
        className: "hp-muted",
        textContent: "The first scenario is the base the others are compared with. Comparing works each scenario out on a copy, so this workbook isn't changed; Show puts a scenario's values into the inputs (one undo step).",
      }),
    );
  }
  panel.addEventListener("keydown", (e) => e.key === "Escape" && panel.remove());
  render();
}
