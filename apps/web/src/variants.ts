/**
 * "Fix spelling variants in this column": "ACME LTD." / "Acme Ltd" /
 * " acme ltd" become one spelling. Variants that differ only in case,
 * spacing and punctuation are found by rules; a local model, when loaded,
 * can add ones the rules can't see ("Intl Business Machines" / "IBM"),
 * restricted to values already in the column. Nothing changes until the
 * ticked merges are written, as one undoable step.
 */
import type { Action } from "@cellforge/actions";
import { suggestMerges, type Model, type ValueMerge } from "@cellforge/ai";
import { columnLetter } from "@cellforge/grid";
import { setCells } from "./actions";
import { readSheet } from "./audittools";
import { categoryInput } from "./checksui";
import type { EditableSource } from "./editable";

/** The text values of a column's data rows (non-text values left as ""). */
export function columnTexts(src: EditableSource, col: number): { first: number; values: string[] } {
  const data = readSheet(src);
  const v = data.col(col);
  return { first: data.first, values: Array.from({ length: data.rows }, (_, i) => (typeof v[i] === "string" ? (v[i] as string) : "")) };
}

/** The cells to write for the chosen merges. */
export function mergeCells(values: readonly string[], first: number, col: number, merges: readonly ValueMerge[]): { row: number; col: number; input: string }[] {
  const to = new Map<string, string>();
  for (const m of merges) for (const f of m.from) to.set(f, m.to);
  const cells: { row: number; col: number; input: string }[] = [];
  values.forEach((v, i) => {
    const t = to.get(v);
    if (t !== undefined) cells.push({ row: i + first, col, input: categoryInput(t) });
  });
  return cells;
}

export interface VariantsDeps {
  source: () => EditableSource;
  activeSheet: () => string;
  /** the selected column */
  col: () => number;
  run: (a: Action) => Promise<unknown>;
  status: (t: string) => void;
  focusGrid: () => void;
  model?: () => Model | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

export async function openVariants(d: VariantsDeps): Promise<void> {
  const col = d.col();
  const sheet = d.activeSheet();
  const { first, values } = columnTexts(d.source(), col);
  const back = el("div", { className: "palette-backdrop" });
  const box = el("div", { className: "palette import-dialog" });
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Fix spelling variants");
  const form = el("div", { className: "palette-form" });
  const body = el("div", { className: "share-body" });
  const actions = el("div", { className: "numfmt-actions" });
  form.append(el("h3", { textContent: `Spelling variants in column ${columnLetter(col)}` }), body, actions);
  box.append(form);
  back.append(box);
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  const cancel = el("button", { type: "button", textContent: "Close" });
  cancel.addEventListener("click", close);
  actions.append(cancel);
  document.body.append(back);

  const model = d.model?.() ?? null;
  const note = el("p", { className: "hp-muted", textContent: model ? "Looking for variants (rules, then the local model)…" : "Looking for variants…" });
  note.setAttribute("aria-live", "polite");
  body.append(note);
  cancel.focus();

  const { merges, rejected } = await suggestMerges(values, model);
  if (!merges.length) {
    note.textContent = `No spelling variants found in ${values.filter(Boolean).length.toLocaleString("en-US")} text values.${rejected ? ` (The model's answer wasn't used: ${rejected}.)` : ""}`;
    return;
  }
  merges.sort((a, b) => b.cells - a.cells);
  note.textContent = `${merges.length} group${merges.length === 1 ? "" : "s"} of spellings that look like the same thing. Each becomes the commonest spelling. ${model ? "Groups marked model came from the local model: check them." : "Load a local AI model to also find abbreviations and typos."}${rejected ? ` (The model's answer wasn't used: ${rejected}.)` : ""}`;
  const table = el("table", { className: "ck-rule-table" });
  const head = el("tr");
  for (const t of ["", "Change", "To", "Cells", "Found by"]) head.append(el("th", { textContent: t }));
  table.append(head);
  const picks: HTMLInputElement[] = [];
  for (const m of merges) {
    const tick: HTMLInputElement = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = m.by === "rules";
    tick.setAttribute("aria-label", `Change ${m.from.join(", ")} to ${m.to}`);
    picks.push(tick);
    const tr = el("tr");
    const cell = (x: Node | string, cls = "") => el("td", { className: cls }, x);
    tr.append(cell(tick), cell(m.from.map((f) => JSON.stringify(f)).join(", "), "ck-ex"), cell(JSON.stringify(m.to)), cell(String(m.cells), "num"), cell(m.by === "model" ? "model" : "rules"));
    table.append(tr);
  }
  const wrap = el("div", { className: "import-preview" });
  wrap.append(table);
  body.append(wrap);
  const write = el("button", { type: "button", textContent: "Change the ticked spellings" });
  write.addEventListener("click", () => {
    const chosen = merges.filter((_, i) => picks[i].checked);
    const cells = mergeCells(values, first, col, chosen);
    if (!cells.length) return;
    write.disabled = true;
    void d
      .run(setCells(cells, `merge ${chosen.length} spelling variant${chosen.length === 1 ? "" : "s"} in column ${columnLetter(col)}`, sheet))
      .then(() => {
        d.status(`Changed ${cells.length.toLocaleString("en-US")} cells to a common spelling (undo with Ctrl+Z)`);
        close();
      })
      .catch((e: Error) => {
        body.append(el("p", { className: "cleanup-warn", textContent: e.message }));
        write.disabled = false;
      });
  });
  actions.append(write);
  write.focus();
}
