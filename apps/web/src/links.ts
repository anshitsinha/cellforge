/**
 * Notes and links in the app: what a cell links to (its own link, or a
 * HYPERLINK formula), following a link safely, the note shown when the
 * pointer rests on a cell, and the small editors for both.
 */
import type { Action } from "@cellforge/actions";
import { parseFormula, type Node } from "@cellforge/core";
import type { CellRef } from "@cellforge/grid";
import { parseRanges } from "./cfmanager";
import type { EditableSource } from "./editable";
import type { Workbook } from "./workbook";

/** Only web, email and in-workbook links: never javascript: or data: addresses. */
export function safeLink(link: string): boolean {
  const t = link.trim();
  return t.startsWith("#") ? t.length > 1 : /^(https?:\/\/|mailto:)\S+$/i.test(t);
}

/** Where a cell links to: its link, or a HYPERLINK formula's address. */
export function cellLink(source: EditableSource, row: number, col: number): string | null {
  const own = source.extraAt(row, col)?.link;
  if (own) return own;
  const text = source.getEditText(row, col);
  if (!/^=\s*HYPERLINK\s*\(/i.test(text)) return null;
  let ast: Node;
  try {
    ast = parseFormula(text);
  } catch {
    return null;
  }
  if (ast.type !== "call" || ast.args.length === 0) return null;
  const v = source.evalAt(ast.args[0] as Node, row, col);
  return typeof v === "string" ? v : null;
}

/** A #Sheet!A1 (or #A1, or #Name) place in the workbook. */
export function resolvePlace(workbook: Workbook, activeId: string, target: string): { sheetId: string; row: number; col: number } | null {
  const t = target.replace(/^#/, "").trim();
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(.+)$/.exec(t);
  if (!m) return null;
  const sheetName = (m[1] ?? m[2])?.replace(/''/g, "'");
  const sheet = sheetName ? workbook.byName(sheetName) : workbook.get(activeId);
  if (!sheet) return null;
  try {
    const [r] = parseRanges(m[3], sheet.source.rowCount, sheet.source.colCount);
    return { sheetId: sheet.id, row: r.top, col: r.left };
  } catch {
    // a defined name
    const def = workbook.definedNames.find((n) => n.name.toLowerCase() === t.toLowerCase());
    if (def) return resolvePlace(workbook, activeId, def.formula.replace(/^=/, ""));
    return null;
  }
}

/** Follow a link: go to a place in the workbook, or open a web address in a new tab. */
export function followLink(link: string, workbook: Workbook, activeId: string, goTo: (sheetId: string, row: number, col: number) => void, status: (t: string) => void): void {
  if (!safeLink(link)) {
    status(`Not following "${link}": only web, email and workbook links open.`);
    return;
  }
  if (link.startsWith("#")) {
    const place = resolvePlace(workbook, activeId, link);
    if (place) goTo(place.sheetId, place.row, place.col);
    else status(`There's no ${link.slice(1)} in this workbook.`);
    return;
  }
  window.open(link, "_blank", "noopener,noreferrer");
}

let tip: HTMLElement | null = null;

/** The note (and link) for the cell under the pointer, or hide it. */
export function showNoteTip(source: EditableSource, cell: CellRef | null, x: number, y: number): void {
  const extra = cell ? source.extraAt(cell.row, cell.col) : null;
  const link = cell ? cellLink(source, cell.row, cell.col) : null;
  if (!extra?.note && !link && !extra?.review && !extra?.evidence) {
    tip?.remove();
    tip = null;
    return;
  }
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "note-tip";
    tip.setAttribute("role", "tooltip");
    document.body.append(tip);
  }
  tip.replaceChildren();
  if (extra?.note) tip.append(Object.assign(document.createElement("div"), { className: "note-text", textContent: extra.note }));
  if (extra?.review) {
    const r = extra.review;
    tip.append(
      Object.assign(document.createElement("div"), {
        className: "note-text",
        textContent: `Review (${r.by}): ${r.text}${r.cleared ? `\nCleared by ${r.cleared.by}` : " (open)"}`,
      }),
    );
  }
  if (extra?.evidence) tip.append(Object.assign(document.createElement("div"), { className: "hp-muted", textContent: `📎 Evidence${extra.evidence.page ? ` on page ${extra.evidence.page}` : ""} (palette: Show this cell's evidence)` }));
  if (link) tip.append(Object.assign(document.createElement("div"), { className: "hp-muted", textContent: `${link} (Ctrl+click to open)` }));
  tip.style.left = `${Math.min(x + 14, innerWidth - 300)}px`;
  tip.style.top = `${Math.min(y + 14, innerHeight - 120)}px`;
}

/** A small editor for a cell's note or link; resolves with the text ("" removes), or null if cancelled. */
export function editExtra(kind: "note" | "link", current: string, where: string): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "palette-backdrop";
    back.innerHTML = `<div class="palette" role="dialog"><div class="palette-form"><h3></h3><div class="numfmt-actions"></div></div></div>`;
    back.querySelector("h3")!.textContent = `${kind === "note" ? "Note" : "Link"} on ${where}`;
    const form = back.querySelector<HTMLElement>(".palette-form")!;
    const field = kind === "note" ? document.createElement("textarea") : document.createElement("input");
    field.value = current;
    field.setAttribute("aria-label", kind === "note" ? "Note" : "Link address");
    if (field instanceof HTMLTextAreaElement) field.rows = 5;
    else field.placeholder = "https://… or #Sheet2!A1";
    field.className = "note-field";
    const hint = Object.assign(document.createElement("p"), {
      className: "hp-muted",
      textContent: kind === "note" ? "Ctrl+Enter saves. Leave it empty to delete the note." : "A web address, an email (mailto:…), or a place in this workbook like #Sheet2!A1. Leave it empty to remove the link.",
    });
    const error = Object.assign(document.createElement("p"), { className: "cleanup-warn", hidden: true });
    form.insertBefore(field, form.querySelector(".numfmt-actions"));
    form.insertBefore(hint, form.querySelector(".numfmt-actions"));
    form.insertBefore(error, form.querySelector(".numfmt-actions"));
    const actions = form.querySelector<HTMLElement>(".numfmt-actions")!;
    const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Cancel" });
    const ok = Object.assign(document.createElement("button"), { type: "button", textContent: "Save" });
    actions.append(cancel, ok);
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    const save = () => {
      const v = field.value.trim();
      if (kind === "link" && v && !safeLink(v)) {
        error.textContent = "Use a web address (https://…), an email (mailto:…) or a place like #Sheet2!A1.";
        error.hidden = false;
        return;
      }
      done(v);
    };
    cancel.addEventListener("click", () => done(null));
    ok.addEventListener("click", save);
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && (kind === "link" || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        save();
      }
    });
    document.body.append(back);
    field.focus();
  });
}

/** The action that sets a note or link from the editor's answer. */
export function extraAction(kind: "note" | "link", cell: CellRef, text: string): Action {
  return { type: "cells.extra", params: { row: cell.row, col: cell.col, [kind]: text === "" ? null : text } };
}
