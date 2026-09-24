/** Sort by several columns: levels of column + direction, and whether there's a header row. */
import type { Action } from "@cellforge/actions";
import { columnLetter } from "@cellforge/grid";
import "./analysis.css";
import "./sortdialog.css";
import type { EditableSource } from "./editable";
import { makeButton, openDialog } from "./ui/dialog";
import { iconButton } from "./ui/icons";

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
  // a header row: text across the top, or the sheet's own names
  const looksHeader = !named && Array.from({ length: cols }, (_, c) => firstRow(c)).every((t) => t !== "");
  const label = (c: number, header: boolean) => {
    const name = named ? src.getColumnName(c) : header ? firstRow(c) : "";
    return name ? `${name} (${columnLetter(c)})` : `Column ${columnLetter(c)}`;
  };
  // numbers and dates sort smallest first, text A to Z
  const isNumeric = (c: number) => {
    const rows = Math.min(src.usedRange().rows, 50);
    let n = 0;
    let t = 0;
    for (let r = 1; r < rows; r++) {
      const v = src.getCell(r, c);
      if (typeof v === "number") n++;
      else if (v !== null && v !== "") t++;
    }
    return n > t;
  };

  const body = document.createElement("div");
  body.className = "an-stack sort-dlg";
  const headerBox = document.createElement("label");
  headerBox.className = "an-check";
  const hb = document.createElement("input");
  hb.type = "checkbox";
  hb.checked = named || looksHeader;
  hb.disabled = named;
  const hbText = document.createElement("span");
  hbText.textContent = named ? "The column names are the header" : "The first row is a header (it stays on top)";
  headerBox.append(hb, hbText);
  const levels = document.createElement("ol");
  levels.className = "sort-levels";
  levels.setAttribute("aria-label", "Sort levels");
  const add = makeButton("Add a level", "ghost", "plus");
  add.classList.add("btn-sm", "sort-add");
  body.append(levels, add, headerBox);

  const keys: { col: number; descending: boolean }[] = [{ col: Math.min(d.activeCol(), cols - 1), descending: false }];
  const render = () => {
    levels.replaceChildren();
    keys.forEach((k, i) => {
      const row = document.createElement("li");
      row.className = "sort-level";
      const lead = document.createElement("span");
      lead.className = "sort-level__lead";
      lead.textContent = i === 0 ? "Sort by" : "then by";
      const colSel = document.createElement("select");
      colSel.setAttribute("aria-label", `Column for level ${i + 1}`);
      for (let c = 0; c < cols; c++) colSel.append(new Option(label(c, hb.checked), String(c), false, c === k.col));
      const dir = document.createElement("select");
      dir.setAttribute("aria-label", `Order for level ${i + 1}`);
      const fill = () => {
        const num = isNumeric(k.col);
        dir.replaceChildren(new Option(num ? "Smallest first" : "A to Z", "asc", false, !k.descending), new Option(num ? "Largest first" : "Z to A", "desc", false, k.descending));
      };
      fill();
      colSel.addEventListener("change", () => {
        k.col = Number(colSel.value);
        fill();
      });
      dir.addEventListener("change", () => (k.descending = dir.value === "desc"));
      row.append(lead, colSel, dir);
      if (keys.length > 1)
        row.append(
          iconButton("close", `Remove level ${i + 1}`, {
            size: "sm",
            onClick: () => {
              keys.splice(i, 1);
              render();
            },
          }),
        );
      else row.append(document.createElement("span"));
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
    levels.querySelectorAll("select")[levels.querySelectorAll("select").length - 2]?.focus();
  });

  openDialog({
    title: "Sort",
    subtitle: "By one column, then by others to break ties",
    size: "md",
    body,
    initialFocus: "primary",
    actions: [
      { label: "Cancel", dismiss: true },
      {
        label: "Sort",
        kind: "primary",
        onClick: () => {
          void d.run({ type: "rows.sortBy", params: { keys, hasHeader: !named && hb.checked } }).then(() => d.focusGrid());
        },
      },
    ],
    onClose: (r) => {
      if (r === "dismiss") d.focusGrid();
    },
  });
}
