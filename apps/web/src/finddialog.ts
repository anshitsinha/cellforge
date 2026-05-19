/**
 * The find & replace dialog. It stays open beside the grid: Find next jumps
 * to each match in turn, Find all lists them as links, Replace changes the
 * match under the cursor and moves on, Replace all changes every match as
 * one undo step.
 */
import "./findreplace.css";
import type { Action } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { compileQuery, find, findNext, type FindOptions, planReplace, replaceAction, replacementInput, type Match } from "./findreplace";
import { setCells } from "./actions";
import type { Workbook } from "./workbook";

export interface FindReplaceDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  /** the selected range */
  range: () => CellRange;
  /** the active cell */
  selection: () => { row: number; col: number };
  run: (a: Action) => Promise<unknown>;
  goTo: (sheetId: string, row: number, col: number) => void;
  focusGrid: () => void;
}

/** What was typed last time, so reopening carries on. */
const last = { query: "", replacement: "", matchCase: false, wholeCell: false, regex: false, lookIn: "values" as "values" | "formulas", byColumns: false, all: false };
const SHOW_MAX = 1000;

let current: { back: HTMLElement; setMode: (m: "find" | "replace") => void } | null = null;

export function closeFindReplace(): void {
  current?.back.remove();
  current = null;
}

export function openFindReplace(d: FindReplaceDeps, mode: "find" | "replace"): void {
  if (current) {
    current.setMode(mode);
    return;
  }
  // a range selected when the dialog opens is what "Selection" searches
  const startSheet = d.activeSheet();
  const startRange = d.range();
  const hasRange = startRange.bottom > startRange.top || startRange.right > startRange.left;

  const back = document.createElement("div");
  back.className = "palette-backdrop find-backdrop";
  back.innerHTML = `<div class="palette find-dialog" role="dialog" aria-label="Find and replace"><div class="palette-form">
    <h3></h3>
    <label>Find <input type="text" data-k="query" spellcheck="false" autocomplete="off"></label>
    <label data-k="replace-row">Replace with <input type="text" data-k="replacement" spellcheck="false" autocomplete="off"></label>
    <div class="find-options">
      <label><input type="checkbox" data-k="matchCase"> Match case</label>
      <label><input type="checkbox" data-k="wholeCell"> Whole cell</label>
      <label><input type="checkbox" data-k="regex"> Regular expression</label>
    </div>
    <div class="find-options">
      <label>Within <select data-k="scope"><option value="selection">Selection</option><option value="sheet">Sheet</option><option value="all">All sheets</option></select></label>
      <label>Search <select data-k="order"><option value="rows">By rows</option><option value="cols">By columns</option></select></label>
      <label>Look in <select data-k="lookIn"><option value="values">Values</option><option value="formulas">Formulas</option></select></label>
    </div>
    <p class="find-status" aria-live="polite"></p>
    <div class="numfmt-actions">
      <button type="button" data-act="mode"></button>
      <button type="button" data-act="all">Find all</button>
      <button type="button" data-act="prev" title="Shift+Enter">Previous</button>
      <button type="button" data-act="next" title="Enter">Find next</button>
      <button type="button" data-act="replace">Replace</button>
      <button type="button" data-act="replaceAll">Replace all</button>
      <button type="button" data-act="close" title="Esc">Close</button>
    </div>
    <ul class="find-results"></ul>
  </div></div>`;
  const $ = <T extends HTMLElement>(sel: string) => back.querySelector<T>(sel)!;
  const query = $<HTMLInputElement>("[data-k=query]");
  const replacement = $<HTMLInputElement>("[data-k=replacement]");
  const matchCase = $<HTMLInputElement>("[data-k=matchCase]");
  const wholeCell = $<HTMLInputElement>("[data-k=wholeCell]");
  const regex = $<HTMLInputElement>("[data-k=regex]");
  const scope = $<HTMLSelectElement>("[data-k=scope]");
  const order = $<HTMLSelectElement>("[data-k=order]");
  const lookIn = $<HTMLSelectElement>("[data-k=lookIn]");
  const status = $<HTMLElement>(".find-status");
  const results = $<HTMLUListElement>(".find-results");

  query.value = last.query;
  replacement.value = last.replacement;
  matchCase.checked = last.matchCase;
  wholeCell.checked = last.wholeCell;
  regex.checked = last.regex;
  lookIn.value = last.lookIn;
  order.value = last.byColumns ? "cols" : "rows";
  scope.value = hasRange ? "selection" : last.all ? "all" : "sheet";
  if (!hasRange) scope.querySelector<HTMLOptionElement>("[value=selection]")!.disabled = true;

  let replacing = mode === "replace";
  const setMode = (m: "find" | "replace") => {
    replacing = m === "replace";
    $("h3").textContent = replacing ? "Find and replace" : "Find";
    $("[data-k=replace-row]").hidden = !replacing;
    $("[data-act=replace]").hidden = !replacing;
    $("[data-act=replaceAll]").hidden = !replacing;
    $("[data-act=mode]").textContent = replacing ? "Find only" : "Replace…";
    // replacing changes what was typed, so that's what it searches
    lookIn.disabled = replacing;
    if (replacing) lookIn.value = "formulas";
    else lookIn.value = last.lookIn;
    query.focus();
    query.select();
  };

  const options = (): FindOptions => {
    const sc = scope.value as "selection" | "sheet" | "all";
    return {
      matchCase: matchCase.checked,
      wholeCell: wholeCell.checked,
      regex: regex.checked,
      lookIn: replacing ? "formulas" : (lookIn.value as "values" | "formulas"),
      byColumns: order.value === "cols",
      scope: sc,
      sheetId: sc === "selection" ? startSheet : d.activeSheet(),
      range: startRange,
    };
  };

  const remember = () => {
    Object.assign(last, {
      query: query.value,
      replacement: replacement.value,
      matchCase: matchCase.checked,
      wholeCell: wholeCell.checked,
      regex: regex.checked,
      byColumns: order.value === "cols",
      all: scope.value === "all",
      ...(lookIn.disabled ? {} : { lookIn: lookIn.value as "values" | "formulas" }),
    });
  };

  const say = (text: string, problem = false) => {
    status.textContent = text;
    status.classList.toggle("cleanup-warn", problem);
  };

  const address = (m: { sheetId: string; row: number; col: number }, withSheet: boolean) => {
    const a = `${columnLetter(m.col)}${m.row + 1}`;
    if (!withSheet) return a;
    const name = d.workbook().get(m.sheetId).name;
    return `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`}!${a}`;
  };

  /** Run a search step; a bad query shows its message instead. */
  const attempt = <T,>(f: () => T): T | undefined => {
    remember();
    try {
      return f();
    } catch (e) {
      say((e as Error).message, true);
      return undefined;
    }
  };

  const jump = (m: Match) => {
    d.goTo(m.sheetId, m.row, m.col);
    query.focus(); // keep typing / pressing Enter here
  };

  const next = (backwards: boolean) => {
    const o = options();
    const sel = d.selection();
    const m = attempt(() => findNext(d.workbook(), query.value, o, { sheetId: d.activeSheet(), row: sel.row, col: sel.col }, backwards));
    if (m === undefined) return;
    if (!m) return say("No matches.");
    say(`${address(m, o.scope === "all")}: ${short(m.text)}`);
    jump(m);
  };

  const findAll = () => {
    const o = options();
    const list = attempt(() => find(d.workbook(), query.value, o));
    if (!list) return;
    results.replaceChildren();
    const capped = list.length >= (o.limit ?? 10_000);
    say(list.length ? `${list.length.toLocaleString()}${capped ? "+" : ""} ${list.length === 1 ? "cell" : "cells"} found.` + (list.length > SHOW_MAX ? ` Showing the first ${SHOW_MAX.toLocaleString()}.` : "") : "No matches.");
    const multi = new Set(list.map((m) => m.sheetId)).size > 1 || o.scope === "all";
    for (const m of list.slice(0, SHOW_MAX)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "hp-cell";
      b.textContent = address(m, multi);
      b.title = "Show it in the sheet";
      b.addEventListener("click", () => jump(m));
      const t = document.createElement("span");
      t.textContent = short(m.text);
      li.append(b, t);
      results.append(li);
    }
  };

  const inScope = (o: FindOptions, sheetId: string, row: number, col: number) => {
    if (o.scope === "all") return true;
    if (sheetId !== o.sheetId) return false;
    if (o.scope !== "selection") return true;
    const r = startRange;
    return row >= r.top && row <= r.bottom && col >= r.left && col <= r.right;
  };

  const replaceOne = async () => {
    const o = options();
    const m = attempt(() => compileQuery(query.value, o));
    if (!m) return;
    const sheetId = d.activeSheet();
    const { row, col } = d.selection();
    const input = inScope(o, sheetId, row, col) ? replacementInput(d.workbook().get(sheetId).source, row, col, m, replacement.value) : null;
    if (input !== null) {
      try {
        await d.run(setCells([{ row, col, input }], `replace in ${address({ sheetId, row, col }, false)}`, sheetId));
      } catch (e) {
        return say((e as Error).message, true);
      }
    }
    next(false);
  };

  const replaceAll = async () => {
    const o = options();
    const plan = attempt(() => planReplace(d.workbook(), query.value, replacement.value, o));
    if (!plan) return;
    const action = replaceAction(plan, `replace "${short(query.value, 30)}" with "${short(replacement.value, 30)}"`);
    if (!action) return say("Nothing to replace.");
    try {
      await d.run(action);
    } catch (e) {
      return say((e as Error).message, true);
    }
    results.replaceChildren();
    say(`Replaced ${plan.count.toLocaleString()} ${plan.count === 1 ? "cell" : "cells"}` + (plan.sheets.length > 1 ? ` on ${plan.sheets.length} sheets.` : ".") + " Ctrl+Z undoes it.");
  };

  const close = () => {
    remember();
    closeFindReplace();
    d.focusGrid();
  };

  // a broken regular expression is pointed out while typing
  const check = () => {
    if (!query.value) return say("");
    try {
      compileQuery(query.value, options());
      if (status.classList.contains("cleanup-warn")) say("");
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  query.addEventListener("input", check);
  regex.addEventListener("change", check);
  wholeCell.addEventListener("change", check);

  $(".numfmt-actions").addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "mode") setMode(replacing ? "find" : "replace");
    else if (act === "all") findAll();
    else if (act === "prev") next(true);
    else if (act === "next") next(false);
    else if (act === "replace") void replaceOne();
    else if (act === "replaceAll") void replaceAll();
    else if (act === "close") close();
  });
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      next(e.shiftKey);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h")) {
      // Ctrl+F / Ctrl+H again switch between find and replace (not the browser's find)
      e.preventDefault();
      setMode(e.key.toLowerCase() === "h" ? "replace" : "find");
    }
    // keys typed here aren't grid shortcuts
    e.stopPropagation();
  });

  document.body.append(back);
  current = { back, setMode };
  setMode(mode);
}

function short(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
