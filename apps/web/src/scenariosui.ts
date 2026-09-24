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
import "./analysis.css";
import "./recipes.css";
import { makeButton } from "./ui/dialog";
import { icon, iconButton } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";
import { toast } from "./ui/toast";

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

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The scenario manager in the side panel: pick the input cells and the
 * result cells from the selection, keep named sets of input values (Base,
 * Best, Worst…), show one on the sheet, and compare them all on a new sheet.
 */
export function openScenarios(d: ScenarioDeps): void {
  openSidePanel({
    id: "scenarios",
    title: "Scenarios",
    subtitle: "What-if: base, best and worst case side by side",
    onClose: () => d.focusGrid(),
    render: (p) => {
      const save = (m: ScenarioModel) => d.run({ type: "scenarios.set", params: { model: m } }).then(render);

      function render() {
        const wb = d.workbook();
        const m: ScenarioModel = structuredClone(wb.scenarios);
        const root = h("div", "an-stack an-stack--loose scn");

        // ---- worked example while nothing is set up
        if (!m.inputs.length && !m.results.length && !m.scenarios.length) {
          const empty = h("div", "an-empty");
          const ic = h("span", "an-empty__icon");
          ic.append(icon("scale", { size: 20 }));
          const steps = h("ol", "scn-steps");
          const li = (b: string, rest: string) => {
            const x = h("li");
            x.append(h("strong", undefined, b), rest);
            steps.append(x);
          };
          li("Select the inputs", ", e.g. growth rate and headcount, and press Use selection under Inputs.");
          li("Select the results", ", e.g. net profit and cash, and press Use selection under Results.");
          li("Save the current inputs as Base", ", then type other values for Best and Worst.");
          li("Compare", ": every scenario is worked out on a copy and set side by side on a new sheet.");
          empty.append(ic, h("h3", "an-empty__title", "See what changes if…"), steps);
          root.append(empty);
        }

        // ---- inputs and results
        const cellsSec = h("section", "an-section");
        const ch = h("div", "an-section__head");
        ch.append(h("h3", "an-section__title", "Cells"));
        cellsSec.append(ch);
        const pick = (title: string, hint: string, cells: ScenarioCell[], set: (c: ScenarioCell[]) => void) => {
          const box = h("div", `scn-pick${cells.length ? " is-set" : ""}`);
          const text = h("div", "scn-pick__text");
          const list = cells.length ? cells.map(cellLabel).join(", ") : hint;
          const cl = h("span", "scn-pick__cells", list);
          cl.title = list;
          text.append(h("span", "scn-pick__title", `${title}${cells.length ? ` (${cells.length})` : ""}`), cl);
          const b = makeButton("Use selection", cells.length ? "ghost" : "secondary");
          b.classList.add("btn-sm");
          b.title = `Make the selected cells the ${title.toLowerCase()}`;
          b.addEventListener("click", () => set(cellsOf(wb, d.activeSheet(), d.range())));
          box.append(text, b);
          cellsSec.append(box);
        };
        pick("Inputs", "The cells a scenario changes", m.inputs, (c) => {
          // changing the inputs keeps each scenario's values for cells it already had
          const keep = (vals: (string | null)[]) =>
            c.map((nc) => {
              const i = m.inputs.findIndex((oc) => oc.sheet === nc.sheet && oc.row === nc.row && oc.col === nc.col);
              return i >= 0 ? vals[i] : null;
            });
          void save({ inputs: c, results: m.results, scenarios: m.scenarios.map((s) => ({ ...s, values: keep(s.values) })) });
        });
        pick("Results", "The cells to compare", m.results, (c) => void save({ ...m, results: c }));
        root.append(cellsSec);

        // ---- scenarios
        const sSec = h("section", "an-section");
        const sh = h("div", "an-section__head");
        sh.append(h("h3", "an-section__title", "Scenarios"));
        if (m.scenarios.length) sh.append(h("span", "cf-badge", String(m.scenarios.length)));
        sSec.append(sh);
        if (m.inputs.length && m.scenarios.length) {
          const wrap = h("div", "scn-table-wrap");
          const t = h("table", "scn-table");
          const hr = h("tr");
          hr.append(h("th", undefined, "Name"), ...m.inputs.map((c) => h("th", undefined, cellLabel(c))), h("th"));
          const thead = h("thead");
          thead.append(hr);
          const tbody = h("tbody");
          m.scenarios.forEach((sc, si) => {
            const tr = h("tr");
            const name = Object.assign(h("input"), { value: sc.name });
            name.setAttribute("aria-label", "Scenario name");
            name.addEventListener("change", () => {
              m.scenarios[si].name = name.value.trim() || sc.name;
              void save(m);
            });
            const nameTd = h("td", "scn-name");
            nameTd.append(name);
            tr.append(nameTd);
            sc.values.forEach((v, vi) => {
              const input = Object.assign(h("input"), { value: v ?? "" });
              input.setAttribute("aria-label", `${sc.name}: ${cellLabel(m.inputs[vi])}`);
              input.addEventListener("change", () => {
                m.scenarios[si].values[vi] = input.value === "" ? null : input.value;
                void save(m);
              });
              const td = h("td");
              td.append(input);
              tr.append(td);
            });
            const tools = h("td", "scn-tools");
            tools.append(
              iconButton("play", `Show "${sc.name}" on the sheet`, {
                size: "sm",
                onClick: () => void d.run(applyScenarioAction(m, sc)).then(() => toast({ text: `Showing "${sc.name}" in the input cells. Ctrl+Z puts them back.` })),
              }),
              iconButton("trash", `Delete "${sc.name}"`, {
                size: "sm",
                onClick: () => {
                  m.scenarios.splice(si, 1);
                  void save(m);
                },
              }),
            );
            tr.append(tools);
            tbody.append(tr);
          });
          t.append(thead, tbody);
          wrap.append(t);
          sSec.append(wrap);
          sSec.append(h("p", "an-hint", "The first scenario is the base the others are compared with. Show puts a scenario's values into the inputs (one undo step)."));
        } else sSec.append(h("p", "an-hint", m.inputs.length ? "Add the current inputs as the first scenario: that's your base case." : "Pick the input cells first."));
        const add = makeButton(m.scenarios.length ? "Add the current inputs" : "Save the current inputs as Base", "secondary", "plus");
        add.disabled = !m.inputs.length;
        if (add.disabled) add.title = "Pick the input cells first";
        add.addEventListener("click", () => {
          m.scenarios.push({ name: m.scenarios.length ? `Scenario ${m.scenarios.length + 1}` : "Base", values: captureInputs(wb, m.inputs) });
          void save(m);
        });
        sSec.append(add);
        root.append(sSec);
        p.body.replaceChildren(root);

        // ---- footer
        const foot = h("div", "an-footer");
        const cmp = makeButton("Compare on a new sheet", "primary");
        const ready = m.results.length > 0 && m.scenarios.length > 0;
        cmp.disabled = !ready;
        cmp.title = ready ? "Work out every scenario on a copy and lay the results side by side" : "Pick the result cells and add at least one scenario";
        cmp.addEventListener("click", async () => {
          const progress = toast({ text: "Working out each scenario…", duration: 0 });
          try {
            const result = await compareScenarios(wb, m);
            const source = new EditableSource(new Table(comparisonColumns(result)), 5);
            await d.run({ type: "sheet.insert", params: { name: "Scenario comparison", source: d.putBlob(source), origin: `Scenarios compared: ${result.scenarios.join(", ")}` } });
            progress.close();
            toast({ kind: "success", text: `Compared ${result.scenarios.length} scenarios on a new sheet` });
          } catch (e) {
            progress.close();
            toast({ kind: "error", title: "Couldn't compare the scenarios", text: (e as Error).message });
          }
        });
        foot.append(h("span", "an-spacer"), cmp);
        p.footer.replaceChildren(foot);
      }
      render();
    },
  });
}
