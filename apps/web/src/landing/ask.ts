/**
 * Private AI: the ask bar's deterministic parser (@cellforge/ai, no model,
 * no network) on the sample's bank statement. A request becomes the app's
 * own actions, checked against the action catalogue and described first;
 * Do it runs them through the undo history, as in the app.
 */
import type { Action } from "@cellforge/actions";
import { actionsOf, parse, validateAction, type AskContext, type SheetInfo } from "@cellforge/ai";
import type { EditableSource } from "../editable";
import { openBook } from "./book";
import { h } from "./frame";
import { LiveSheet } from "./sheet";

const EXAMPLES = ["sort by amount descending", "highlight duplicates in reference", "filter description contains fee", "highlight amounts over 10000 in red", "show blanks in reference", "clear filter", "which customers paid late?"];

/** A sheet as the parser sees it: its name and the headings in row 1. */
export function sheetInfo(id: string, name: string, src: EditableSource): SheetInfo {
  const cols = Math.max(1, src.usedRange().cols);
  const columns = Array.from({ length: cols }, (_, c) => {
    const v = src.getCell(0, c);
    return typeof v === "string" ? v.trim() : "";
  });
  return { id, name, rowCount: src.rowCount, colCount: Math.max(src.colCount, 1), headerRow: 0, columns };
}

type Plan =
  | { kind: "empty" }
  | { kind: "ready"; actions: Action[]; explanation: string }
  | { kind: "info"; text: string }
  | { kind: "unknown" };

export async function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const body = frame.querySelector<HTMLElement>(".af-body")!;
  const undoBtn = frame.querySelector<HTMLButtonElement>(".af-undo")!;
  const book = await openBook("bank-rec");
  const wb = book.wb;
  const bank = wb.byName("Bank statement")!;
  const catalog = book.registry.catalog();

  host.replaceChildren();
  const sheet = new LiveSheet(host, book.view(bank.id), {
    label: "The sample bank statement, a live cellforge sheet",
    frame,
    idleStatus: () => {
      const hidden = bank.source.filteredRowIds.length;
      return hidden ? `Filtered · ${bank.source.usedRange().rows - 1 - hidden} of ${bank.source.usedRange().rows - 1} rows` : `${bank.source.usedRange().rows - 1} rows`;
    },
    onEdit: (cell, text) => {
      void book.type(bank.id, [{ row: cell.row, col: cell.col, input: text }]).then(sync);
      return false;
    },
  });
  book.show(sheet, bank.id);

  const ctx = (): AskContext => {
    const r = sheet.range;
    return { sheets: wb.sheets.map((s) => sheetInfo(s.id, s.name, s.source)), activeSheet: bank.id, selection: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } };
  };

  const input = h("input", { type: "text", class: "ask-input", placeholder: "Ask or do… e.g. sort by amount descending", spellcheck: false, autocomplete: "off" });
  input.setAttribute("aria-label", "Ask or do, in plain English");
  const doBtn = h("button", { type: "button", class: "af-btn af-btn-primary", textContent: "Do it", disabled: true });
  const plan = h("div", { class: "ask-plan is-empty" });
  plan.setAttribute("aria-live", "polite");
  const chips = h("div", { class: "ask-chips" });
  chips.setAttribute("aria-label", "Examples");
  for (const x of EXAMPLES) chips.append(h("button", { type: "button", class: "chip", textContent: x, onclick: () => ((input.value = x), void go()) }));
  const bar = h("div", { class: "ask-bar" }, input, doBtn);
  const wrap = h("div", { class: "ask-wrap" }, bar, chips, plan);
  body.before(wrap);

  let current: Plan = { kind: "empty" };
  const done: { label: string; steps: number }[] = [];

  const planFor = (text: string): Plan => {
    if (!text.trim()) return { kind: "empty" };
    const c = ctx();
    const r = parse(text, c);
    if (!r) return { kind: "unknown" };
    if (r.missing.length) return { kind: "info", text: r.missing.join(" ") };
    if (r.command === "undo") return done.length ? { kind: "info", text: "Undo the last change: press Undo." } : { kind: "info", text: "There's nothing to undo yet." };
    if (r.command) return { kind: "info", text: `${r.explanation} In the app this opens the tool; this page shows only the sheet.` };
    const actions = actionsOf(r);
    const problems = actions.flatMap((a) => validateAction(a, catalog, c));
    if (problems.length) return { kind: "info", text: `${r.explanation} It can't run: ${problems.join(" ")}` };
    return { kind: "ready", actions, explanation: r.explanation };
  };

  const show = (p: Plan, note?: string) => {
    current = p;
    plan.className = "ask-plan";
    doBtn.disabled = p.kind !== "ready";
    switch (p.kind) {
      case "empty":
        plan.classList.add("is-empty");
        plan.replaceChildren(h("p", { textContent: "Type a request, or pick one above. The plan shows here before anything changes." }));
        break;
      case "ready":
        plan.replaceChildren(h("p", {}, p.explanation, h("small", { textContent: `${p.actions.map((a) => a.type).join(", ")} · checked against the sheet. Enter or Do it to run.` })));
        break;
      case "info":
        plan.replaceChildren(h("p", { textContent: p.text }));
        break;
      case "unknown":
        plan.classList.add("is-unknown");
        plan.replaceChildren(
          h("p", {}, "The built-in parser doesn't know that one.", h("small", { textContent: "In the app, a local AI model you load once takes requests like this, on your computer, with the same plan-first, undoable steps. This page doesn't load a model." })),
        );
        break;
    }
    if (note) {
      plan.classList.add("is-done");
      plan.replaceChildren(h("p", {}, note, h("small", { textContent: "Done through the app's actions. Undo puts it back." })));
    }
  };

  async function go() {
    const p = planFor(input.value);
    show(p);
    if (p.kind !== "ready") return;
    const label = p.explanation;
    let steps = 0;
    try {
      for (const a of p.actions) if (await book.run(a)) steps++;
    } catch (e) {
      show({ kind: "info", text: (e as Error).message });
      return;
    }
    if (steps) done.push({ label, steps });
    sync();
    show(p, steps ? label : "That's already so: nothing changed.");
  }

  function sync() {
    book.show(sheet, bank.id, true);
    undoBtn.disabled = !book.history.canUndo;
  }

  input.addEventListener("input", () => show(planFor(input.value)));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void go();
    }
  });
  doBtn.addEventListener("click", () => void go());
  undoBtn.addEventListener("click", async () => {
    const last = done.pop();
    if (last) for (let i = 0; i < last.steps; i++) await book.undo();
    else await book.undo();
    sync();
    show({ kind: "info", text: last ? `Undone: ${last.label}` : "Undone." });
  });
  show(current);
}
