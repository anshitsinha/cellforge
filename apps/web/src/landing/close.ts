/**
 * The month-end close section: the close sample opened as the app opens it.
 * The Flux sheet's movements are the template's formulas, the flags its
 * conditional formats, and the panel runs the workbook's data checks. The
 * thresholds are cells on Settings: change them (or any balance) and the
 * formulas, formats and checks all follow, with Undo.
 */
import { moveFormula, parseFormula, runChecks, type CheckResult, type CheckTable, type CheckValue, type Node } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import type { Workbook } from "../workbook";
import { openBook, type Book } from "./book";
import { h, ms, sheetTabs } from "./frame";
import { LiveSheet } from "./sheet";

const SHEETS = ["TB current", "TB prior", "Mapping", "Settings", "Flux"];

/** The workbook's checks, run as the app's checks dialog runs them (a formula check is moved down row by row). */
export function workbookChecks(wb: Workbook): CheckResult[] {
  const cache = new Map<string, { id: string; first: number; rows: number; get: (r: number, c: number) => CheckValue } | null>();
  const data = (ref: string) => {
    if (!cache.has(ref)) {
      const sheet = wb.has(ref) ? wb.get(ref) : wb.byName(ref);
      if (!sheet) cache.set(ref, null);
      else {
        const src = sheet.source;
        const rows = Math.max(0, src.usedRange().rows - 1);
        cache.set(ref, { id: sheet.id, first: 1, rows, get: (r, c) => (src.getCell(r + 1, c) ?? null) as CheckValue });
      }
    }
    return cache.get(ref)!;
  };
  const asts = new Map<string, Node | null>();
  return runChecks(
    wb.checks,
    {
      table(ref): CheckTable | null {
        const d = data(ref);
        if (!d) return null;
        const sheet = wb.has(ref) ? wb.get(ref) : wb.byName(ref)!;
        const cols = sheet.source.usedRange().cols;
        const names = Array.from({ length: cols }, (_, c) => String(sheet.source.getCell(0, c) ?? columnLetter(c)));
        return { rows: d.rows, cols, names, get: d.get, numFmt: (c) => sheet.source.getStyle(1, c)?.numFmt ?? "" };
      },
    },
    {
      maxFailures: 20,
      evalFormula(formula, ref, row) {
        const d = data(ref);
        let ast = asts.get(formula);
        if (ast === undefined) {
          try {
            ast = parseFormula(formula.startsWith("=") ? formula : `=${formula}`);
          } catch {
            ast = null;
          }
          asts.set(formula, ast);
        }
        if (!d || !ast) throw new Error("The formula has a problem.");
        return wb.get(d.id).source.evalAt(moveFormula(ast, row, 0), d.first + row, 0);
      },
    },
  );
}

export async function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const side = frame.querySelector<HTMLElement>(".af-side")!;
  const undo = frame.querySelector<HTMLButtonElement>(".af-undo")!;
  const book: Book = await openBook("close");
  const wb = book.wb;
  const ids = SHEETS.map((n) => wb.byName(n)!.id);
  const flux = wb.byName("Flux")!;
  const settings = wb.byName("Settings")!;

  host.replaceChildren();
  let active = ids.length - 1;
  const sheet = new LiveSheet(host, book.view(ids[active]), {
    label: "Sample month-end close, a live cellforge sheet",
    frame,
    idleStatus: () => {
      return `${wb.get(ids[active]).name} · ${book.rows(ids[active]) - 1} rows`;
    },
    onEdit: (cell, text) => {
      void book.type(ids[active], [{ row: cell.row, col: cell.col, input: text }]).then(changed);
      return false;
    },
  });
  // the Flux columns a little narrower than the template sets them, so all
  // eight fit beside the checks
  const FLUX_WIDTHS = new Map([60, 172, 124, 104, 104, 100, 72, 70, 260].map((w, i) => [i, w] as [number, number]));
  const show = (keep = false) => {
    book.show(sheet, ids[active], keep);
    if (ids[active] === flux.id) sheet.grid.setColumnWidths(FLUX_WIDTHS, "landing-flux");
  };
  show();
  // open on the movements that need explaining
  sheet.grid.select(1, 7);
  const tabs = sheetTabs(frame, SHEETS, (i) => {
    active = i;
    show();
  }, active);

  let results: CheckResult[] = [];
  let took = 0;
  const thr = h("input", { type: "text", inputMode: "decimal", value: "", id: "close-thr" });
  const pct = h("input", { type: "text", inputMode: "decimal", value: "", id: "close-pct" });
  thr.setAttribute("aria-label", "Threshold amount (Settings B2)");
  pct.setAttribute("aria-label", "Threshold percentage (Settings B3)");
  const setting = (row: number, input: HTMLInputElement) => {
    input.addEventListener("change", async () => {
      await book.type(settings.id, [{ row, col: 1, input: input.value.trim() || null }]);
      changed();
    });
  };
  setting(1, thr);
  setting(2, pct);

  const go = (sheetName: string, row: number, col: number) => {
    const i = SHEETS.indexOf(sheetName);
    if (i < 0) return;
    tabs.set(i);
    sheet.reveal({ top: row, left: Math.max(0, col), bottom: row, right: Math.max(0, col) }, "#d93025");
    sheet.grid.focus();
  };

  const explainCount = () => {
    const src = flux.source;
    let n = 0;
    const rows = src.usedRange().rows;
    for (let r = 1; r < rows; r++) if (src.getCell(r, 7) === "Explain") n++;
    return n;
  };

  const render = () => {
    const flagged = explainCount();
    const pass = results.filter((r) => r.status === "pass").length;
    const list = h("ul", { class: "checks" });
    for (const r of results) {
      const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✕" : "!";
      const li = h("li", { class: "ck" }, h("span", { class: `st ${r.status}`, textContent: mark, title: r.status }), h("p", { textContent: r.name }));
      if (r.status !== "pass") {
        const f = r.failures[0];
        const why = h("p", { class: "why" });
        if (r.kind === "inList" && f) {
          why.append(`${r.failed} not on Mapping: ${r.failures.map((x) => String(x.value)).join(", ")} `);
        } else why.append(`${r.failed} row${r.failed === 1 ? "" : "s"}. `);
        if (f && f.row >= 0) why.append(h("button", { type: "button", textContent: "Show", onclick: () => go(r.sheet, f.row + 1, f.col >= 0 ? f.col : r.kind === "formula" ? 7 : 0) }));
        li.append(why);
      }
      list.append(li);
    }
    side.replaceChildren(
      h(
        "div",
        { class: "sp" },
        h("p", { class: "sp-title" }, "Data checks", h("span", { textContent: `${pass} of ${results.length} pass · ${ms(took)}` })),
        h("p", { class: "sp-sub", textContent: "The close template's checks, run on the workbook as it stands. Exports ask first while one fails." }),
        list,
        h("p", { class: "sp-h", textContent: "Flux thresholds (Settings)" }),
        h("div", { class: "tiles" }, h("div", { class: "tile" }, h("b", { textContent: String(flagged) }), h("span", { textContent: "movements flagged Explain" }))),
        h("label", { class: "thr", htmlFor: "close-thr" }, "Over", thr, "and", pct),
        h("p", { class: "sp-sub", textContent: "Both must be exceeded, as the template's Flag formula says. Press Enter to apply." }),
      ),
    );
  };

  const fmtSetting = (row: number) => {
    const s = settings.source;
    const text = s.getEditText(row, 1);
    return text || String(s.getCell(row, 1) ?? "");
  };

  function changed() {
    const t0 = performance.now();
    results = workbookChecks(wb);
    took = performance.now() - t0;
    if (document.activeElement !== thr) thr.value = fmtSetting(1);
    if (document.activeElement !== pct) pct.value = fmtSetting(2);
    show(true);
    undo.disabled = !book.history.canUndo;
    render();
  }

  undo.addEventListener("click", async () => {
    await book.undo();
    changed();
  });
  changed();
}
