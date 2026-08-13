/**
 * The clean-up dialog: what the tool found in the sheet (header, rows to
 * drop and why, each column's type and how sure it is, the values that
 * don't fit) before it makes the clean sheet.
 */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import { namedHeader, planCleanup, sheetText } from "./cleanup";
import type { EditableSource } from "./editable";
import { modal } from "./a11y";

export interface CleanupDeps {
  source: () => EditableSource;
  run: (a: Action) => Promise<unknown>;
  goTo: (row: number, col: number) => void;
  focusGrid: () => void;
}

const REASONS: Record<string, string> = { title: "title rows", blank: "blank rows", total: "subtotal / total rows", footer: "page footers", "repeated header": "repeated headers" };
const TYPES: Record<string, string> = { number: "Numbers", date: "Dates", text: "Text", empty: "Empty" };

export function openCleanup(d: CleanupDeps): void {
  let plan;
  try {
    const src = d.source();
    plan = planCleanup(sheetText(src), true, namedHeader(src) ? 1 : 0).plan;
  } catch (e) {
    alertBox((e as Error).message);
    return;
  }
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  modal(back);
  back.innerHTML = `<div class="palette import-dialog" role="dialog" aria-label="Clean up this sheet"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = document.createElement("h3");
  h.textContent = "Clean up this sheet";
  body.append(h);

  const summary = document.createElement("p");
  const counts = new Map<string, number>();
  for (const r of plan.dropped) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const droppedText = [...counts].map(([k, n]) => `${n} ${REASONS[k] ?? k}`).join(", ");
  summary.textContent =
    (plan.headerRow < 0 ? "Header: the column names." : `Header on row ${plan.headerRow + 1}.`) + ` ${plan.dataRows.toLocaleString()} rows of data.` +
    (droppedText ? ` Leaving out ${droppedText}.` : " Nothing to leave out.") +
    (plan.filledDown.length ? ` Filling down group labels in ${plan.filledDown.map((c) => `"${plan.header[c]}"`).join(", ")}.` : "");
  body.append(summary);

  const table = document.createElement("table");
  table.className = "cleanup-cols";
  table.innerHTML = "<tr><th>Column</th><th>Becomes</th><th>Fits</th><th>Doesn't fit</th></tr>";
  plan.profiles.forEach((p, c) => {
    if (p.type === "empty") return;
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = plan.header[c];
    const type = document.createElement("td");
    type.textContent = TYPES[p.type] + (p.type === "number" && p.numberStyle === "comma" ? " (1.234,56)" : "") + (p.type === "date" ? ` (${p.dateOrder === "mdy" ? "month first" : p.dateOrder === "ymd" ? "year first" : "day first"})` : "");
    const conf = document.createElement("td");
    conf.textContent = `${Math.round(p.confidence * 100)}%`;
    if (p.confidence < 0.98) conf.className = "cleanup-warn";
    const misfits = document.createElement("td");
    for (const m of p.misfits.slice(0, 5)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hp-cell";
      const row = plan.sourceRows[m.row];
      b.textContent = `${columnLetter(c)}${row + 1}: ${m.value.slice(0, 20)}`;
      b.title = "Show it in the sheet";
      b.addEventListener("click", () => {
        back.remove();
        d.goTo(row, c);
      });
      misfits.append(b, " ");
    }
    if (p.misfits.length > 5) misfits.append(`and ${p.misfits.length - 5} more`);
    tr.append(name, type, conf, misfits);
    table.append(tr);
  });
  const wrap = document.createElement("div");
  wrap.className = "import-preview";
  wrap.append(table);
  body.append(wrap);

  const note = document.createElement("p");
  note.className = "hp-muted";
  note.textContent = "Values that don't fit keep their original text, so nothing is lost. This sheet stays as it is; the clean data goes on a new sheet.";
  body.append(note);

  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  actions.innerHTML = `<button type="button" data-act="cancel">Cancel</button><button type="button" data-act="ok">Make the clean sheet</button>`;
  body.append(actions);
  const close = () => {
    back.remove();
    d.focusGrid();
  };
  actions.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "cancel") close();
    else if (act === "ok") {
      back.remove();
      void d.run({ type: "data.cleanup", params: {} }).then(() => d.focusGrid());
    }
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(back);
  actions.querySelector<HTMLButtonElement>("[data-act=ok]")!.focus();
}

function alertBox(message: string): void {
  const back = document.createElement("div");
  back.className = "palette-backdrop";
  modal(back);
  back.innerHTML = `<div class="palette"><div class="palette-form"><p></p><div class="numfmt-actions"><button type="button">OK</button></div></div></div>`;
  back.querySelector("p")!.textContent = message;
  back.querySelector("button")!.addEventListener("click", () => back.remove());
  document.body.append(back);
}
