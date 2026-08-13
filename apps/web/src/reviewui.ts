/**
 * Review mode in the app: palette commands for tick marks, review notes,
 * sign-off and workpaper references; the review status panel (every sheet,
 * who signed what, what changed since, open notes); and the tick-mark
 * legend sheet.
 */
import type { Action } from "@cellforge/actions";
import { Table, type ColumnData } from "@cellforge/core";
import { columnLetter, type CellRange } from "@cellforge/grid";
import { EditableSource } from "./editable";
import { allMarks, changedSince, reviewerName, setReviewerName } from "./review";
import type { Workbook } from "./workbook";
import { modal } from "./a11y";

export interface ReviewDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  range: () => CellRange;
  cell: () => { row: number; col: number };
  run: (a: Action) => Promise<unknown>;
  putBlob: (v: unknown) => string;
  goTo: (sheetId: string, row: number, col: number) => void;
  status: (t: string) => void;
  focusGrid: () => void;
}

function ask(title: string, label: string, value = "", multiline = false): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "palette-backdrop";
    modal(back);
    back.innerHTML = `<div class="palette" role="dialog"><div class="palette-form"><h3></h3><div class="numfmt-actions"><button type="button" data-a="c">Cancel</button><button type="button" data-a="o">OK</button></div></div></div>`;
    back.querySelector("h3")!.textContent = title;
    const field = multiline ? document.createElement("textarea") : document.createElement("input");
    field.value = value;
    field.setAttribute("aria-label", label);
    field.className = "note-field";
    if (field instanceof HTMLTextAreaElement) field.rows = 4;
    const form = back.querySelector(".palette-form")!;
    form.insertBefore(field, form.querySelector(".numfmt-actions"));
    const done = (v: string | null) => {
      back.remove();
      resolve(v);
    };
    back.querySelector("[data-a=c]")!.addEventListener("click", () => done(null));
    back.querySelector("[data-a=o]")!.addEventListener("click", () => done(field.value.trim()));
    back.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      else if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        done(field.value.trim());
      }
    });
    document.body.append(back);
    field.focus();
  });
}

/** The reviewer's name or initials: asked once, then remembered in this browser. */
export async function whoAmI(): Promise<string | null> {
  const known = reviewerName();
  if (known) return known;
  const name = await ask("Your name or initials", "Your name or initials (for sign-offs and review notes; kept in this browser)");
  if (name) setReviewerName(name);
  return name || null;
}

/** The palette commands for review mode. */
export function reviewCommands(d: ReviewDeps): { id: string; title: string; hint: string; run: () => unknown }[] {
  const wb = d.workbook();
  const sheetId = d.activeSheet();
  const src = wb.get(sheetId).source;
  const { row, col } = d.cell();
  const here = src.extraAt(row, col);
  const sr = wb.review.sheets[sheetId] ?? {};
  const signed = async (role: "prepared" | "reviewed", remove = false) => {
    const by = await whoAmI();
    if (by) await d.run({ type: "review.signoff", params: { role, by, ...(remove ? { remove: true } : {}) } });
    d.focusGrid();
  };
  const marks = allMarks(wb.review).map((m) => {
    const on = !!here?.marks?.includes(m.id);
    return {
      id: `mark:${m.id}`,
      title: `${on ? "Remove" : "Tick mark"} ${m.glyph}: ${m.label}`,
      hint: "tick mark tickmark audit review agreed footed traced vouched",
      run: () => d.run({ type: "review.mark", params: { range: d.range(), mark: m.id, on: !on } }),
    };
  });
  return [
    ...marks,
    {
      id: "review-note",
      title: here?.review ? "Edit review note…" : "Add a review note…",
      hint: "review note query point reviewer question open",
      run: async () => {
        const by = await whoAmI();
        if (!by) return;
        const text = await ask(`Review note on ${columnLetter(col)}${row + 1}`, "Review note", here?.review?.text ?? "", true);
        if (text) await d.run({ type: "review.note", params: { row, col, text, by } });
        d.focusGrid();
      },
    },
    ...(here?.review && !here.review.cleared
      ? [{ id: "review-clear", title: "Clear review note (dealt with)", hint: "review note clear resolve", run: async () => { const by = await whoAmI(); if (by) await d.run({ type: "review.note", params: { row, col, by, clear: true } }); } }]
      : []),
    ...(here?.review?.cleared ? [{ id: "review-reopen", title: "Reopen review note", hint: "review note reopen", run: async () => { const by = await whoAmI(); if (by) await d.run({ type: "review.note", params: { row, col, by, reopen: true } }); } }] : []),
    { id: "review-status", title: "Review status (sign-offs, open notes)…", hint: "review status sign off prepared reviewed open notes workpapers", run: () => openReviewStatus(d) },
    sr.prepared ? { id: "unsign-prepared", title: "Remove prepared-by sign-off", hint: "review sign off remove", run: () => signed("prepared", true) } : { id: "sign-prepared", title: "Sign off this sheet as prepared", hint: "review sign off prepared by preparer", run: () => signed("prepared") },
    sr.reviewed ? { id: "unsign-reviewed", title: "Remove reviewed-by sign-off", hint: "review sign off remove", run: () => signed("reviewed", true) } : { id: "sign-reviewed", title: "Sign off this sheet as reviewed", hint: "review sign off reviewed by reviewer", run: () => signed("reviewed") },
    {
      id: "wp-ref",
      title: "Workpaper reference…",
      hint: "workpaper reference index wp ref B-3",
      run: async () => {
        const ref = await ask("Workpaper reference for this sheet", "Workpaper reference, e.g. B-3", sr.ref ?? "");
        if (ref !== null) await d.run({ type: "review.ref", params: { ref: ref || null } });
        d.focusGrid();
      },
    },
    { id: "mark-legend", title: "Add a tick-mark legend sheet", hint: "tick mark legend key review", run: () => addLegend(d) },
  ];
}

/** A sheet listing every tick mark and what it means. */
async function addLegend(d: ReviewDeps): Promise<void> {
  const marks = allMarks(d.workbook().review);
  const text = (name: string, values: string[]): ColumnData => ({ kind: "string", name, codes: Uint32Array.from(values, (_, i) => i + 1), dict: values });
  const source = new EditableSource(new Table([text("Mark", marks.map((m) => m.glyph)), text("Meaning", marks.map((m) => m.label))]), 5);
  marks.forEach((m, i) => source.styles.apply(0, [[i, i]], { color: m.color, bold: true }));
  await d.run({ type: "sheet.insert", params: { name: "Tick-mark legend", source: d.putBlob(source), origin: "The tick marks used in this workbook" } });
}

/** Every sheet's review state: reference, sign-offs (and changes since), open review notes. */
export function openReviewStatus(d: ReviewDeps): void {
  document.querySelector(".review-panel")?.remove();
  const wb = d.workbook();
  const panel = document.createElement("aside");
  panel.className = "recipe-panel review-panel";
  panel.setAttribute("aria-label", "Review status");
  const head = document.createElement("div");
  head.className = "recipe-head";
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Close" });
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", () => panel.remove());
  head.append(Object.assign(document.createElement("strong"), { textContent: "Review status" }), close);
  panel.append(head);
  const when = (at: number) => new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  for (const sheet of wb.sheets) {
    const sr = wb.review.sheets[sheet.id] ?? {};
    const open = sheet.source.openReviewNotes();
    const box = document.createElement("div");
    box.className = "review-sheet";
    box.append(Object.assign(document.createElement("strong"), { textContent: `${sr.ref ? `${sr.ref} · ` : ""}${sheet.name}` }));
    for (const role of ["prepared", "reviewed"] as const) {
      const s = sr[role];
      const line = document.createElement("div");
      if (!s) {
        line.className = "hp-muted";
        line.textContent = `Not ${role} yet`;
      } else {
        const changed = changedSince(s, wb.evidence.log, sheet.name);
        line.textContent = `${role === "prepared" ? "Prepared" : "Reviewed"} by ${s.by}, ${when(s.at)}`;
        if (changed) {
          line.className = "cleanup-warn";
          line.textContent += ` — changed since (${changed} change${changed === 1 ? "" : "s"})`;
        }
      }
      box.append(line);
    }
    if (open.length) {
      const ul = document.createElement("ul");
      ul.className = "review-notes";
      for (const n of open) {
        const li = document.createElement("li");
        const go = Object.assign(document.createElement("button"), { type: "button", className: "hp-cell", textContent: `${columnLetter(n.col)}${n.row + 1}` });
        go.addEventListener("click", () => d.goTo(sheet.id, n.row, n.col));
        li.append(go, ` ${n.note.text} (${n.note.by})`);
        ul.append(li);
      }
      box.append(Object.assign(document.createElement("div"), { className: "cleanup-warn", textContent: `${open.length} open review note${open.length === 1 ? "" : "s"}` }), ul);
    }
    panel.append(box);
  }
  panel.addEventListener("keydown", (e) => e.key === "Escape" && panel.remove());
  document.body.append(panel);
  close.focus();
}
