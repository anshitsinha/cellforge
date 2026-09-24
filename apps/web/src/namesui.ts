/**
 * Names and tables UI: define a name for the selection, make a table, and
 * the name manager listing every name and table with delete buttons.
 */
import type { Action } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { sheetPrefix } from "@cellforge/core";
import type { Workbook } from "./workbook";
import "./analysis.css";
import { makeButton, openDialog } from "./ui/dialog";
import { iconButton } from "./ui/icons";
import { toast } from "./ui/toast";

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

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function field(label: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  const l = h("label", "an-field");
  l.append(h("span", undefined, label), input);
  if (hint) l.append(h("small", "an-hint", hint));
  return l;
}

/** Why a name can't be used, or null (the engine checks again). */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "Give it a name.";
  if (/\s/.test(n)) return "Names can't have spaces; use _ instead, like Opening_balance.";
  if (!/^[\p{L}_\\][\p{L}\p{N}_.]*$/u.test(n)) return "Start with a letter or _, then letters, digits, _ or dots.";
  if (/^[A-Za-z]{1,3}[0-9]+$/.test(n) || /^R[0-9]*C[0-9]*$/i.test(n)) return `${n} looks like a cell address; pick another name.`;
  return null;
}

export function setupNamesUi(d: NamesUiDeps) {
  function defineName() {
    const name = h("input");
    name.placeholder = "e.g. Opening_balance";
    name.spellcheck = false;
    const target = h("input");
    target.spellcheck = false;
    target.className = "an-mono";
    target.value = absoluteRef(d.sheetName(), d.range());
    const note = h("input");
    note.placeholder = "What it is, for whoever reads the formulas";
    openDialog({
      title: "Define a name",
      subtitle: "Formulas can then say =Opening_balance instead of a cell address",
      size: "sm",
      body: [field("Name", name), field("Refers to", target, "A cell, a range or a formula."), field("Note (optional)", note)],
      initialFocus: name,
      actions: [
        { label: "Cancel", dismiss: true },
        {
          label: "Save name",
          kind: "primary",
          onClick: async () => {
            const problem = nameProblem(name.value);
            if (problem) {
              name.focus();
              throw new Error(problem);
            }
            const ok = await d.run({ type: "names.define", params: { name: name.value.trim(), refersTo: target.value, ...(note.value.trim() ? { comment: note.value.trim() } : {}) } });
            if (!ok) throw new Error("That name can't be used. Check it isn't taken and that Refers to is a cell, range or formula.");
            toast({ kind: "success", text: `Defined ${name.value.trim()}` });
          },
        },
      ],
      onClose: () => d.focusGrid(),
    });
    for (const i of [name, target, note])
      i.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (i.closest(".cf-dialog")?.querySelector(".btn-primary") as HTMLButtonElement | null)?.click();
        }
      });
  }

  function manager() {
    const wb = d.workbook();
    const list = h("ul", "an-list nm-list");
    const body = h("div", "an-stack");
    const empty = h("div", "an-empty");
    empty.append(h("p", undefined, "No names or tables yet. A name gives a cell or range a word formulas can use (=Revenue - Costs); a table turns a block with headers into one you can refer to by column. Select cells and use New name, or press Ctrl+T for a table."));
    let dlg: ReturnType<typeof openDialog> | null = null;
    const row = (label: string, kind: "name" | "table", detail: string, onDelete: () => Promise<unknown>, onGo?: () => void) => {
      const li = h("li");
      const main = h("div", "an-list__main");
      const title = h("strong", undefined, label);
      main.append(title, h("span", "an-list__sub an-mono", detail));
      li.append(h("span", `cf-badge${kind === "table" ? " cf-badge--accent" : ""}`, kind), main);
      if (onGo) {
        const go = makeButton("Go to", "ghost");
        go.classList.add("btn-sm");
        go.addEventListener("click", () => {
          dlg?.close("go");
          onGo();
        });
        li.append(go);
      }
      li.append(
        iconButton("trash", `Delete ${label}`, {
          size: "sm",
          onClick: async () => {
            await onDelete();
            li.remove();
            if (!list.children.length) list.replaceWith(empty);
            toast({ text: `Deleted ${label}. Ctrl+Z brings it back.` });
          },
        }),
      );
      list.append(li);
    };
    for (const n of wb.definedNames) row(n.name, "name", `= ${n.formula}${n.comment ? `  ·  ${n.comment}` : ""}`, () => d.run({ type: "names.delete", params: { name: n.name } }));
    for (const s of wb.sheets) {
      for (const t of s.source.tables) row(t.name, "table", `${s.name}!${columnLetter(t.left)}${t.top + 1}:${columnLetter(t.right)}${t.bottom + 1}`, () => d.run({ type: "tables.delete", params: { name: t.name } }), () => d.goTo(s.id, t.top, t.left));
    }
    body.append(list.children.length ? list : empty);
    dlg = openDialog({
      title: "Names and tables",
      subtitle: "Named cells, ranges and tables that formulas can use",
      size: "md",
      body,
      actions: [
        { label: "Close", id: "close" },
        {
          label: "New name…",
          kind: "primary",
          onClick: () => {
            setTimeout(defineName, 0);
          },
        },
      ],
      onClose: (r) => {
        if (r !== "New name…" && r !== "go") d.focusGrid();
      },
    });
  }

  const makeTable = () => d.run({ type: "tables.create", params: { range: d.range() } });

  return { defineName, manager, makeTable };
}
