/** Sort by several columns: levels of column + direction, and whether there's a header row. */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import type { EditableSource } from "./editable";

export interface SortDialogDeps {
  source: () => EditableSource;
  activeCol: () => number;
  run: (a: Action) => Promise<unknown>;
  focusGrid: () => void;
}

export function openSortDialog(d: SortDialogDeps): void {
  const src = d.source();
  const named = src.getColumnName(0) !== undefined;
  const cols = Math.max(1, src.usedRange().cols);
  const firstRow = (c: number) => {
    const v = src.getCell(0, c);
    return typeof v === "string" ? v : "";
  };
  // a header row: text across the top while the row below has numbers, or the sheet's own names
  const looksHeader = !named && Array.from({ length: cols }, (_, c) => firstRow(c)).every((t) => t !== "");
  const label = (c: number, header: boolean) => {
    const name = named ? src.getColumnName(c) : header ? firstRow(c) : "";
    return name ? `${columnLetter(c)}: ${name}` : `Column ${columnLetter(c)}`;
  };

  const back = document.createElement("div");
  back.className = "palette-backdrop";
  back.innerHTML = `<div class="palette" role="dialog" aria-label="Sort"><div class="palette-form"></div></div>`;
  const body = back.querySelector<HTMLElement>(".palette-form")!;
  const h = document.createElement("h3");
  h.textContent = "Sort";
  const headerBox = document.createElement("label");
  const hb = document.createElement("input");
  hb.type = "checkbox";
  hb.checked = looksHeader;
  hb.disabled = named;
  headerBox.append(hb, named ? " The column names are the header" : " The first row is a header (it stays on top)");
  const levels = document.createElement("div");
  levels.className = "sort-levels";
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add a level";
  body.append(h, headerBox, levels, add);

  const keys: { col: number; descending: boolean }[] = [{ col: Math.min(d.activeCol(), cols - 1), descending: false }];
  const render = () => {
    levels.replaceChildren();
    keys.forEach((k, i) => {
      const row = document.createElement("div");
      row.className = "sort-level";
      const lead = document.createElement("span");
      lead.textContent = i === 0 ? "Sort by" : "then by";
      const colSel = document.createElement("select");
      colSel.setAttribute("aria-label", `Column for level ${i + 1}`);
      for (let c = 0; c < cols; c++) colSel.append(new Option(label(c, hb.checked), String(c), false, c === k.col));
      colSel.addEventListener("change", () => (k.col = Number(colSel.value)));
      const dir = document.createElement("select");
      dir.setAttribute("aria-label", `Order for level ${i + 1}`);
      dir.append(new Option("A → Z, smallest first", "asc", false, !k.descending), new Option("Z → A, largest first", "desc", false, k.descending));
      dir.addEventListener("change", () => (k.descending = dir.value === "desc"));
      row.append(lead, colSel, dir);
      if (keys.length > 1) {
        const del = document.createElement("button");
        del.type = "button";
        del.textContent = "Remove";
        del.addEventListener("click", () => {
          keys.splice(i, 1);
          render();
        });
        row.append(del);
      }
      levels.append(row);
    });
    add.disabled = keys.length >= Math.min(16, cols);
  };
  render();
  hb.addEventListener("change", render);
  add.addEventListener("click", () => {
    const used = new Set(keys.map((k) => k.col));
    let c = 0;
    while (used.has(c) && c < cols - 1) c++;
    keys.push({ col: c, descending: false });
    render();
  });

  const actions = document.createElement("div");
  actions.className = "numfmt-actions";
  actions.innerHTML = `<button type="button" data-act="cancel">Cancel</button><button type="button" data-act="ok">Sort</button>`;
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
      void d.run({ type: "rows.sortBy", params: { keys, hasHeader: !named && hb.checked } }).then(() => d.focusGrid());
    }
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(back);
  actions.querySelector<HTMLButtonElement>("[data-act=ok]")!.focus();
}
