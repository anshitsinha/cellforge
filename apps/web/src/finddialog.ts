/**
 * The find & replace dialog. It stays open beside the grid: Find next jumps
 * to each match in turn, Find all lists them as links, Replace changes the
 * match under the cursor and moves on, Replace all changes every match as
 * one undo step.
 */
import "./findreplace.css";
import "./analysis.css";
import type { Action } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { compileQuery, find, findNext, type FindOptions, planReplace, replaceAction, replacementInput, type Match } from "./findreplace";
import { setCells } from "./actions";
import type { Workbook } from "./workbook";
import { iconSvg } from "./ui/icons";

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

  // a floating card at the top right: the sheet stays usable behind it, so it isn't modal
  const back = document.createElement("div");
  back.className = "find-bar";
  back.setAttribute("role", "dialog");
  back.setAttribute("aria-modal", "false");
  back.setAttribute("aria-labelledby", "find-title");
  back.innerHTML = `
    <header class="find-head">
      <h2 class="cf-sr-only" id="find-title">Find and replace</h2>
      <div class="find-tabs" role="tablist" aria-label="Find or replace">
        <button type="button" role="tab" data-act="tab-find">Find</button>
        <button type="button" role="tab" data-act="tab-replace">Replace</button>
      </div>
      <button type="button" class="btn-ghost btn-icon btn-sm" data-act="close" aria-label="Close (Esc)" title="Close (Esc)">${iconSvg("close", { size: 14 })}</button>
    </header>
    <div class="find-body">
      <div class="find-field">
        ${iconSvg("search", { size: 14, className: "find-field__icon" })}
        <input type="text" data-k="query" spellcheck="false" autocomplete="off" aria-label="Find" placeholder="Find in the sheet">
        <span class="find-count" aria-hidden="true"></span>
      </div>
      <div class="find-field" data-k="replace-row">
        ${iconSvg("redo", { size: 14, className: "find-field__icon" })}
        <input type="text" data-k="replacement" spellcheck="false" autocomplete="off" aria-label="Replace with" placeholder="Replace with">
      </div>
      <div class="find-options">
        <label class="find-toggle" title="Match case"><input type="checkbox" data-k="matchCase"><span>Aa</span><span class="cf-sr-only">Match case</span></label>
        <label class="find-toggle" title="Whole cell only"><input type="checkbox" data-k="wholeCell"><span>[ab]</span><span class="cf-sr-only">Whole cell</span></label>
        <label class="find-toggle" title="Regular expression"><input type="checkbox" data-k="regex"><span>.*</span><span class="cf-sr-only">Regular expression</span></label>
        <span class="find-sep"></span>
        <label class="find-select"><span class="cf-sr-only">Within</span><select data-k="scope" title="Where to look"><option value="selection">In the selection</option><option value="sheet">In this sheet</option><option value="all">In all sheets</option></select></label>
        <details class="find-more">
          <summary>More</summary>
          <div class="find-more__body">
            <label class="an-field"><span>Search</span><select data-k="order"><option value="rows">By rows</option><option value="cols">By columns</option></select></label>
            <label class="an-field"><span>Look in</span><select data-k="lookIn"><option value="values">Values</option><option value="formulas">Formulas</option></select></label>
          </div>
        </details>
      </div>
      <p class="find-status" aria-live="polite"></p>
      <div class="find-actions">
        <button type="button" class="btn-ghost btn-sm" data-act="all">Find all</button>
        <span class="an-spacer"></span>
        <button type="button" class="btn-secondary btn-sm" data-act="replace">Replace</button>
        <button type="button" class="btn-secondary btn-sm" data-act="replaceAll">Replace all</button>
        <button type="button" class="btn-secondary btn-icon btn-sm" data-act="prev" title="Previous (Shift+Enter)" aria-label="Previous match">${iconSvg("chevron-up", { size: 14 })}</button>
        <button type="button" class="btn-primary btn-sm" data-act="next" title="Next (Enter)">Next</button>
      </div>
      <ul class="find-results" aria-label="Matches"></ul>
    </div>`;
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
  const count = $<HTMLElement>(".find-count");

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
    $("[data-act=tab-find]").setAttribute("aria-selected", String(!replacing));
    $("[data-act=tab-replace]").setAttribute("aria-selected", String(replacing));
    back.classList.toggle("is-replacing", replacing);
    $("[data-k=replace-row]").hidden = !replacing;
    $("[data-act=replace]").hidden = !replacing;
    $("[data-act=replaceAll]").hidden = !replacing;
    $("[data-act=all]").hidden = replacing;
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
    status.classList.toggle("is-error", problem);
    count.textContent = "";
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
    const counted = `${list.length.toLocaleString()}${capped ? "+" : ""}`;
    say(list.length ? `${list.length.toLocaleString()}${capped ? "+" : ""} ${list.length === 1 ? "cell" : "cells"} found.` + (list.length > SHOW_MAX ? ` Showing the first ${SHOW_MAX.toLocaleString()}.` : "") : "No matches.");
    count.textContent = list.length ? counted : "";
    const multi = new Set(list.map((m) => m.sheetId)).size > 1 || o.scope === "all";
    for (const m of list.slice(0, SHOW_MAX)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "find-ref";
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
      if (status.classList.contains("is-error")) say("");
    } catch (e) {
      say((e as Error).message, true);
    }
  };
  query.addEventListener("input", check);
  regex.addEventListener("change", check);
  wholeCell.addEventListener("change", check);

  back.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest("button")?.dataset.act;
    if (act === "tab-find") setMode("find");
    else if (act === "tab-replace") setMode("replace");
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
