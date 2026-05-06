/**
 * Names and tables UI: define a name for the selection, make a table, and
 * the name manager listing every name and table with delete buttons.
 */
import type { Action } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { sheetPrefix } from "@cellforge/core";
import type { Workbook } from "./workbook";

export interface NamesUiDeps {
  workbook: () => Workbook;
  sheetName: () => string;
  range: () => CellRange;
  run: (a: Action) => Promise<unknown>;
  focusGrid: () => void;
  goTo: (sheetId: string, row: number, col: number) => void;
}

/** 'Sheet 1'!$A$1:$B$9 for a range on a sheet. */
export function absoluteRef(sheet: string, r: CellRange): string {
  const cell = (row: number, col: number) => `$${columnLetter(col)}$${row + 1}`;
  const body = r.top === r.bottom && r.left === r.right ? cell(r.top, r.left) : `${cell(r.top, r.left)}:${cell(r.bottom, r.right)}`;
  return sheetPrefix(sheet) + body;
}

function popup(title: string): { pop: HTMLElement; close: () => void } {
  document.querySelector(".names-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "tab-menu numfmt-pop names-pop";
  const h = document.createElement("strong");
  h.textContent = title;
  pop.append(h);
  document.body.append(pop);
  pop.style.left = `${Math.max(8, innerWidth / 2 - 170)}px`;
  pop.style.top = "120px";
  const close = () => pop.remove();
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  return { pop, close };
}

export function setupNamesUi(d: NamesUiDeps) {
  function defineName() {
    const { pop, close } = popup("Define a name");
    const ref = absoluteRef(d.sheetName(), d.range());
    pop.insertAdjacentHTML(
      "beforeend",
      `<label>Name<input type="text" class="nm-name" placeholder="e.g. Revenue" /></label>
       <label>Refers to<input type="text" class="nm-ref" spellcheck="false" /></label>
       <label>Note (optional)<input type="text" class="nm-note" /></label>
       <div class="numfmt-preview nm-error" style="text-align:left;color:#d93025;display:none"></div>
       <div class="numfmt-actions"><button type="button" data-act="cancel">Cancel</button><button type="button" data-act="ok">Save</button></div>`,
    );
    const name = pop.querySelector<HTMLInputElement>(".nm-name")!;
    const target = pop.querySelector<HTMLInputElement>(".nm-ref")!;
    const note = pop.querySelector<HTMLInputElement>(".nm-note")!;
    const err = pop.querySelector<HTMLElement>(".nm-error")!;
    target.value = ref;
    const ok = async () => {
      const ok2 = await d.run({ type: "names.define", params: { name: name.value.trim(), refersTo: target.value, ...(note.value.trim() ? { comment: note.value.trim() } : {}) } });
      if (ok2) {
        close();
        d.focusGrid();
      } else {
        err.style.display = "block";
        err.textContent = "That didn't work; the status bar says why.";
      }
    };
    pop.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "ok") void ok();
      else if (act === "cancel") {
        close();
        d.focusGrid();
      }
    });
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void ok();
    });
    name.focus();
  }

  function manager() {
    const { pop, close } = popup("Names and tables");
    const wb = d.workbook();
    const list = document.createElement("div");
    list.className = "nm-list";
    const row = (label: string, detail: string, onDelete: () => void, onGo?: () => void) => {
      const r = document.createElement("div");
      r.className = "nm-row";
      const text = document.createElement("div");
      const b = document.createElement("strong");
      b.textContent = label;
      const small = document.createElement("small");
      small.textContent = detail;
      text.append(b, small);
      r.append(text);
      if (onGo) {
        const go = document.createElement("button");
        go.type = "button";
        go.textContent = "Go to";
        go.addEventListener("click", () => {
          close();
          onGo();
        });
        r.append(go);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Delete";
      del.addEventListener("click", () => {
        onDelete();
        close();
        setTimeout(manager, 0);
      });
      r.append(del);
      list.append(r);
    };
    for (const n of wb.definedNames) row(n.name, `= ${n.formula}${n.comment ? ` · ${n.comment}` : ""}`, () => void d.run({ type: "names.delete", params: { name: n.name } }));
    for (const s of wb.sheets) {
      for (const t of s.source.tables) {
        row(`${t.name} (table)`, `${s.name}!${columnLetter(t.left)}${t.top + 1}:${columnLetter(t.right)}${t.bottom + 1}`, () => void d.run({ type: "tables.delete", params: { name: t.name } }), () => d.goTo(s.id, t.top, t.left));
      }
    }
    if (!list.children.length) {
      const p = document.createElement("p");
      p.className = "hp-muted";
      p.textContent = "No names or tables yet. Select cells and use Define name or Make table (right-click, or Ctrl+K).";
      list.append(p);
    }
    pop.append(list);
    const actions = document.createElement("div");
    actions.className = "numfmt-actions";
    actions.innerHTML = `<button type="button" data-act="new">New name…</button><button type="button" data-act="close">Close</button>`;
    actions.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      close();
      if (act === "new") defineName();
      else d.focusGrid();
    });
    pop.append(actions);
    actions.querySelector("button")?.focus();
  }

  const makeTable = () => d.run({ type: "tables.create", params: { range: d.range() } });

  return { defineName, manager, makeTable };
}
