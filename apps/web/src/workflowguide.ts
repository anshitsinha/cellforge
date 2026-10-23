/**
 * The workflow guide: a side panel that walks through a sample or template
 * step by step. Each step says what it does and why, has a button that
 * opens the right tool on the right sheet, and ticks itself when the
 * workbook shows it's done ("B-1 Rec ties: 0.00"). It replaces the old
 * plain-text "Start here" instructions; the Start here sheet stays as a
 * short cover for anyone who opens the file in another program.
 *
 * Which guide a workbook gets is worked out from its sheets (Cash book +
 * Bank statement + Rec → the bank rec, and so on), so it needs nothing
 * saved with the file and works after a reload.
 *
 * For the shell (app.ts):
 *
 *   import { maybeOpenWorkflowGuide, openWorkflowGuide } from "./workflowguide";
 *   const guideDeps = () => ({ workbook: () => workbook, activeSheet: () => activeId, showSheet, goTo, run, runCommand: (id) => commands().find((c) => c.id === id)?.run(), focusGrid: () => grid.focus() });
 *   // after a sample or template is loaded:
 *   maybeOpenWorkflowGuide(guideDeps());
 *   // a command (Help menu): "Workflow guide" → openWorkflowGuide(guideDeps())
 */
import "./workflowguide.css";
import type { Action } from "@cellforge/actions";
import { formatValue } from "@cellforge/core";
import { runWorkbookChecks } from "./checksui";
import { changedSince } from "./review";
import { BIG_ROWS } from "./samples";
import { RESULTS_ROWS, REC_ROWS } from "./templates";
import { dataRows } from "./usedrange";
import { el, emptyState, plural } from "./toolkit";
import { icon } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";
import type { Sheet, Workbook } from "./workbook";

export interface GuideDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  /** switch to a sheet */
  showSheet: (id: string) => void;
  /** show a cell (switch sheet, select it) */
  goTo: (sheetId: string, row: number, col: number) => void;
  /** run an action (undoable, logged) */
  run: (a: Action) => Promise<unknown>;
  /** run a command by its id (commands.ts), as the palette does, on the sheet now showing */
  runCommand: (id: string) => void;
  focusGrid: () => void;
}

export type GuideKind = "bankrec" | "close" | "audit" | "big";

/** Which guide fits this workbook, from its sheets; null when none does. Pure. */
export function guideKindOf(wb: Pick<Workbook, "sheets" | "byName">): GuideKind | null {
  const has = (...names: string[]) => names.every((n) => !!wb.byName(n));
  if (has("Cash book", "Bank statement", "Outstanding", "Rec")) return "bankrec";
  if (has("TB current", "TB prior", "Mapping", "Flux")) return "close";
  if (has("Population", "Results")) return "audit";
  if (wb.sheets.length === 1 && wb.sheets[0].source.rowCount >= 10_000_000 && wb.sheets[0].source.getColumnName?.(4) === "Debit") return "big";
  return null;
}

/** Where a step stands: done (ticked), to do, or nothing to tick (an optional look-around). */
export type StepState = "done" | "todo" | "info";

export interface GuideStep {
  id: string;
  title: string;
  text: string;
  /** a live figure under the text ("Difference (4,824.43)") */
  status?: string;
  /** "bad" shows the status in the warning colour */
  tone?: "good" | "bad";
  state: StepState;
  /** buttons; the first is the main one */
  actions: { label: string; run: () => void }[];
}

export interface Guide {
  title: string;
  intro: string;
  steps: GuideStep[];
  /** the sentence when every step is done */
  finish: string;
}

const money = (n: number) => formatValue(n, "#,##0.00;(#,##0.00)").text;
const sheet = (wb: Workbook, name: string): Sheet | null => wb.byName(name) ?? null;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Checks: how many fail and warn (run fresh). */
function checkCounts(wb: Workbook): { total: number; fail: number; warn: number } {
  const enabled = wb.checks.filter((c) => c.enabled !== false);
  if (!enabled.length) return { total: 0, fail: 0, warn: 0 };
  const r = runWorkbookChecks(wb, wb.checks);
  return { total: r.length, fail: r.filter((x) => x.status === "fail").length, warn: r.filter((x) => x.status === "warn").length };
}

const signedOff = (wb: Workbook, s: Sheet | null) => {
  const p = s ? wb.review.sheets[s.id]?.prepared : undefined;
  return !!p && changedSince(p, wb.evidence.log, s!.name) === 0;
};

const refOf = (wb: Workbook, s: Sheet | null) => (s ? `${wb.review.sheets[s.id]?.ref ? `${wb.review.sheets[s.id]!.ref} ` : ""}${s.name}` : "");

/** The steps for a workbook, worked out from what's in it now. */
export function buildGuide(kind: GuideKind, wb: Workbook, d: GuideDeps): Guide {
  const on = (s: Sheet | null, then?: () => void) => () => {
    if (s) d.showSheet(s.id);
    then?.();
  };
  const cmd = (s: Sheet | null, id: string) => on(s, () => d.runCommand(id));
  const checksStep = (): GuideStep => {
    const c = checkCounts(wb);
    return {
      id: "checks",
      title: "Run the data checks",
      text: "The rules this workbook must pass before it's exported or signed: they're set up already.",
      status: c.total ? (c.fail || c.warn ? `${plural(c.total - c.fail - c.warn, "check")} of ${c.total} pass${c.fail ? `, ${c.fail} failing` : ""}${c.warn ? `, ${c.warn} to look at` : ""}` : `All ${c.total} checks pass`) : undefined,
      tone: c.fail || c.warn ? "bad" : "good",
      state: c.total && !c.fail && !c.warn ? "done" : "todo",
      actions: [{ label: "Data checks", run: () => d.runCommand("data-checks") }],
    };
  };
  const signStep = (s: Sheet | null): GuideStep => ({
    id: "sign",
    title: `Sign off ${refOf(wb, s)} as preparer`,
    text: "Records your name, the time and the change log's position. A reviewer then signs it off as reviewed.",
    status: s && wb.review.sheets[s.id]?.prepared && !signedOff(wb, s) ? "Changed since it was signed: sign again" : undefined,
    tone: "bad",
    state: signedOff(wb, s) ? "done" : "todo",
    actions: [{ label: "Sign off", run: cmd(s, "sign-prepared") }],
  });

  if (kind === "bankrec") {
    const cash = sheet(wb, "Cash book");
    const bank = sheet(wb, "Bank statement");
    const out = sheet(wb, "Outstanding");
    const rec = sheet(wb, "Rec");
    const cashRows = cash ? Math.max(0, dataRows(cash.source) - 1) : 0;
    const bankRows = bank ? Math.max(0, dataRows(bank.source) - 1) : 0;
    const items = out ? Math.max(0, dataRows(out.source) - 1) : 0;
    const diff = rec ? num(rec.source.getCell(REC_ROWS.difference, 1)) : null;
    const reconciled = wb.sheets.some((s) => /^rec\b./i.test(s.name) && s.name !== "Rec") || items > 0;
    const ties = items > 0 && diff === 0;
    return {
      title: "Bank reconciliation",
      intro: "Match the cash book to the bank statement, list what's left as reconciling items, and show the rec ties to 0.00.",
      finish: `Reconciled: ${refOf(wb, rec)} ties to 0.00, the checks pass and it's signed off.`,
      steps: [
        {
          id: "data",
          title: "Bring in the cash book and the bank statement",
          text: "Paste each into its sheet, or open the files (a PDF statement opens with Ctrl+O). Put the statement's closing balance on Rec.",
          status: cashRows || bankRows ? `${plural(cashRows, "cash book line")}, ${plural(bankRows, "statement line")}` : undefined,
          state: cashRows && bankRows ? "done" : "todo",
          actions: [{ label: "Show Cash book", run: on(cash) }],
        },
        {
          id: "match",
          title: "Reconcile the cash book to the bank",
          text: "Matches line by line on reference, amount and date, and explains what doesn't match.",
          state: reconciled ? "done" : "todo",
          actions: [{ label: "Reconcile", run: cmd(cash, "reconcile") }],
        },
        {
          id: "statement",
          title: "Prepare the rec statement and fill Outstanding",
          text: "Sets out deposits in transit, outstanding payments, bank-only items and errors, then puts each on Outstanding with its kind.",
          status: items ? plural(items, "reconciling item") + " on Outstanding" : undefined,
          state: items ? "done" : "todo",
          actions: [{ label: "Bank rec statement", run: cmd(cash, "openitems-bankstatement") }],
        },
        {
          id: "ties",
          title: `${refOf(wb, rec)} ties to 0.00`,
          text: "Adjusted bank balance less adjusted cash book balance. Anything left is unexplained.",
          status: diff === null ? undefined : `Difference ${money(diff)}`,
          tone: diff === 0 ? "good" : "bad",
          state: ties ? "done" : "todo",
          actions: [{ label: "Show the difference", run: () => rec && d.goTo(rec.id, REC_ROWS.difference, 1) }],
        },
        checksStep(),
        signStep(rec),
      ],
    };
  }

  if (kind === "close") {
    const cur = sheet(wb, "TB current");
    const map = sheet(wb, "Mapping");
    const flux = sheet(wb, "Flux");
    const accounts = cur ? Math.max(0, dataRows(cur.source) - 1) : 0;
    const unmapped: { row: number; code: unknown; name: unknown }[] = [];
    const toExplain: number[] = [];
    let flagged = 0;
    if (flux) {
      const n = dataRows(flux.source);
      for (let r = 1; r < n; r++) {
        if (flux.source.getCell(r, 2) === "(not mapped)") unmapped.push({ row: r, code: flux.source.getCell(r, 0), name: flux.source.getCell(r, 1) });
        if (flux.source.getCell(r, 7) === "Explain") {
          flagged++;
          const why = flux.source.getCell(r, 8);
          if (why === null || why === "") toExplain.push(r);
        }
      }
    }
    const mapNext = async () => {
      if (!map || !unmapped.length) return;
      const free = Math.max(1, dataRows(map.source));
      // the code goes in for them; the report line is theirs to choose
      await d.run({ type: "cells.set", params: { cells: [{ row: free, col: 0, input: String(unmapped[0].code) }], label: "map an account", sheet: map.id } });
      d.goTo(map.id, free, 1);
    };
    const pivoted = wb.sheets.some((s) => /pivot/i.test(s.name));
    return {
      title: "Month-end close",
      intro: "Map every account, explain the movements over the thresholds, pass the checks and sign off the flux.",
      finish: `Closed: every account is mapped, every flagged movement is explained, and ${refOf(wb, flux)} is signed off.`,
      steps: [
        {
          id: "data",
          title: "Bring in this month's and last month's trial balance",
          text: "Code, name, debit and credit into TB current and TB prior, and each account's report line into Mapping.",
          status: accounts ? plural(accounts, "account") : undefined,
          state: accounts ? "done" : "todo",
          actions: [{ label: "Show TB current", run: on(cur) }],
        },
        {
          id: "map",
          title: "Map every account to a report line",
          text: "Flux shows (not mapped) for an account Mapping doesn't list yet. Add its code and pick the report line.",
          status: unmapped.length ? `${plural(unmapped.length, "account")} not mapped: ${unmapped.slice(0, 2).map((u) => `${u.code} ${u.name}`).join(", ")}${unmapped.length > 2 ? "…" : ""}` : accounts ? "Every account is mapped" : undefined,
          tone: unmapped.length ? "bad" : "good",
          state: accounts && !unmapped.length ? "done" : "todo",
          actions: unmapped.length ? [{ label: `Map ${String(unmapped[0].code)}`, run: () => void mapNext() }] : [{ label: "Show Mapping", run: on(map) }],
        },
        {
          id: "explain",
          title: "Explain the flagged movements",
          text: "Changes over both thresholds (Settings) are flagged Explain. Write the reason in the Explanation column.",
          status: flagged ? `${flagged - toExplain.length} of ${flagged} explained` : undefined,
          tone: toExplain.length ? "bad" : "good",
          state: accounts && !toExplain.length ? "done" : "todo",
          actions: toExplain.length && flux ? [{ label: "Next to explain", run: () => d.goTo(flux.id, toExplain[0], 8) }] : [{ label: "Show Flux", run: on(flux) }],
        },
        checksStep(),
        {
          id: "pivot",
          title: "Totals by report line (optional)",
          text: "A pivot of Flux by report line, and a chart of the movements, for the pack.",
          state: pivoted ? "done" : "info",
          actions: [{ label: "Pivot table", run: cmd(flux, "pivot") }],
        },
        signStep(flux),
      ],
    };
  }

  if (kind === "audit") {
    const pop = sheet(wb, "Population");
    const res = sheet(wb, "Results");
    const lines = pop ? Math.max(0, dataRows(pop.source) - 1) : 0;
    const status = (row: number) => String(res?.source.getCell(row, 1) ?? "");
    const done = (row: number) => /^done/i.test(status(row));
    const testRows = Object.values(RESULTS_ROWS);
    const doneCount = testRows.filter(done).length;
    const noConclusion = testRows.filter((r) => done(r) && !String(res?.source.getCell(r, 3) ?? "").trim());
    const testStep = (id: string, title: string, text: string, rows: number[], buttons: [string, string][]): GuideStep => ({
      id,
      title,
      text,
      status: rows.some(done) ? rows.map((r) => `${String(res?.source.getCell(r, 0) ?? "")}: ${status(r) || "Not started"}`).join(" · ") : undefined,
      state: rows.every(done) ? "done" : "todo",
      actions: buttons.map(([label, cmdId]) => ({ label, run: cmd(pop, cmdId) })),
    });
    return {
      title: "Audit tests",
      intro: "Run the tests on the journal, record each result and conclusion on Results, and sign off.",
      finish: "Every test is done and concluded on Results, and it's signed off.",
      steps: [
        {
          id: "data",
          title: "Bring in the population",
          text: "Journal lines, invoices or payments on Population, with the column names in the first row.",
          status: lines ? plural(lines, "line") : undefined,
          state: lines ? "done" : "todo",
          actions: [{ label: "Show Population", run: on(pop) }],
        },
        testStep("je", "Journal entry tests", "Weekend and late-night postings, round amounts, entries that don't balance, unusual users, scored riskiest first.", [RESULTS_ROWS.journal], [["Journal entry tests", "je-journal"]]),
        testStep("tests", "Duplicates, gaps and Benford", "Each test's Create results sheet records its status and exceptions on Results.", [RESULTS_ROWS.duplicates, RESULTS_ROWS.sequence, RESULTS_ROWS.benford], [
          ["Duplicates", "audit-duplicates"],
          ["Sequence gaps", "audit-sequence"],
          ["Benford", "audit-benford"],
        ]),
        testStep("sample", "Pick a sample to test in detail", "Random, systematic or monetary-unit; the seed goes on Results so the same sample can be picked again.", [RESULTS_ROWS.sample], [["Pick a sample", "audit-sample"]]),
        {
          id: "conclude",
          title: "Write a conclusion for each test",
          text: "On Results: what was found and what it means. Set the status of tests run elsewhere from its list.",
          status: doneCount ? `${doneCount - noConclusion.length} of ${doneCount} done tests concluded` : undefined,
          tone: noConclusion.length ? "bad" : "good",
          state: doneCount >= 4 && !noConclusion.length ? "done" : "todo",
          actions: [{ label: noConclusion.length ? "Next conclusion" : "Show Results", run: () => res && d.goTo(res.id, noConclusion[0] ?? 1, noConclusion.length ? 3 : 1) }],
        },
        checksStep(),
        signStep(res),
      ],
    };
  }

  // the 100M-line ledger
  const s = wb.sheets[0];
  return {
    title: "100M-line ledger",
    intro: `${plural(BIG_ROWS, "line")} of a fictional general ledger, worked out as you scroll: nothing is stored.`,
    finish: "",
    steps: [
      { id: "scroll", title: "Go anywhere", text: "Ctrl+End jumps to the last line; the scroll bar reaches any of them.", state: "info", actions: [{ label: "Go to the last line", run: () => d.goTo(s.id, BIG_ROWS - 1, 0) }] },
      {
        id: "sort",
        title: "Sort by amount",
        text: "All 100 million lines, largest debit first. The sort runs in the background; the toast says how long it took.",
        state: s.source.rowOrder ? "done" : "info",
        actions: [
          {
            label: "Sort by Debit",
            run: () => {
              d.goTo(s.id, 0, 4);
              d.runCommand("sort-desc");
            },
          },
        ],
      },
      { id: "pivot", title: "Pivot by account", text: "Totals of Debit by Account name, straight from the 100M lines.", state: "info", actions: [{ label: "Pivot table", run: cmd(s, "pivot") }] },
      { id: "find", title: "Find an entry", text: "Search a description or a reference, such as INV-20452.", state: "info", actions: [{ label: "Find", run: () => d.runCommand("find") }] },
    ],
  };
}

const STATE_LABEL: Record<StepState, string> = { done: "Done", todo: "To do", info: "" };

/** A short signature of a guide, so the panel only redraws when something it shows changed. */
const signature = (g: Guide) => JSON.stringify(g.steps.map((s) => [s.state, s.status, s.title, s.actions.map((a) => a.label)]));

/** Open the guide for this workbook (an empty state when it has none). */
export function openWorkflowGuide(d: GuideDeps): void {
  const first = guideKindOf(d.workbook());
  openSidePanel({
    id: "workflow-guide",
    title: first ? buildTitle(first) : "Workflow guide",
    subtitle: "Step by step, with a button for each",
    onClose: () => d.focusGrid(),
    render: (p) => {
      let last = "";
      const draw = () => {
        const wb = d.workbook();
        const kind = guideKindOf(wb);
        if (!kind) {
          if (last !== "none") p.body.replaceChildren(emptyState({ icon: "help", title: "No guide for this workbook", text: "Guides come with the samples and templates (bank rec, month-end close, audit tests): open one from File ▸ New." }));
          last = "none";
          return;
        }
        const g = buildGuide(kind, wb, d);
        const sig = kind + signature(g);
        if (sig === last) return;
        last = sig;
        p.setTitle(g.title, "Step by step, with a button for each");
        const tickable = g.steps.filter((s) => s.state !== "info");
        const doneN = tickable.filter((s) => s.state === "done").length;
        const all = tickable.length > 0 && doneN === tickable.length;
        const head = el("div", { className: `wg-head${all ? " wg-head--done" : ""}` });
        head.append(el("p", { className: "wg-intro", textContent: all && g.finish ? g.finish : g.intro }));
        if (tickable.length) {
          const bar = el("div", { className: "wg-progress" });
          bar.setAttribute("role", "progressbar");
          bar.setAttribute("aria-valuemin", "0");
          bar.setAttribute("aria-valuemax", String(tickable.length));
          bar.setAttribute("aria-valuenow", String(doneN));
          bar.setAttribute("aria-label", `${doneN} of ${tickable.length} steps done`);
          const fill = el("span");
          fill.style.width = `${(doneN / tickable.length) * 100}%`;
          bar.append(fill);
          head.append(el("div", { className: "wg-progress-row" }, bar, el("span", { className: "wg-count", textContent: `${doneN} of ${tickable.length} done` })));
        }
        // the next step to do is the one shown open with its main button primary
        const next = g.steps.find((s) => s.state === "todo");
        const list = el("ol", { className: "wg-steps" });
        g.steps.forEach((s, i) => {
          const li = el("li", { className: `wg-step wg-step--${s.state}${s === next ? " wg-step--next" : ""}` });
          const mark = el("span", { className: "wg-step__mark" });
          mark.setAttribute("aria-hidden", "true");
          if (s.state === "done") mark.append(icon("check", { size: 14 }));
          else mark.textContent = String(i + 1);
          const main = el("div", { className: "wg-step__main" });
          const title = el("div", { className: "wg-step__title" }, el("span", { textContent: s.title }));
          if (s.state !== "info") title.append(el("span", { className: "cf-sr-only", textContent: ` (${STATE_LABEL[s.state]})` }));
          main.append(title, el("p", { className: "wg-step__text", textContent: s.text }));
          if (s.status) main.append(el("p", { className: `wg-step__status${s.tone ? ` wg-step__status--${s.tone}` : ""}`, textContent: s.status }));
          if (s.actions.length) {
            const acts = el("div", { className: "wg-step__acts" });
            s.actions.forEach((a, k) => {
              const b = el("button", { type: "button", className: `btn-sm ${s === next && k === 0 ? "btn-primary" : "btn-secondary"}`, textContent: a.label });
              b.addEventListener("click", () => a.run());
              acts.append(b);
            });
            main.append(acts);
          }
          li.append(mark, main);
          list.append(li);
        });
        const focused = p.body.contains(document.activeElement) ? (document.activeElement as HTMLElement).textContent : null;
        p.body.replaceChildren(head, list);
        // keep keyboard focus on the same button across a redraw
        if (focused) [...p.body.querySelectorAll("button")].find((b) => b.textContent === focused)?.focus();
      };
      draw();
      // the workbook changes under the guide (tools, typing, undo): look again now and then
      const timer = window.setInterval(draw, 1200);
      return () => window.clearInterval(timer);
    },
  });
}

function buildTitle(kind: GuideKind): string {
  return kind === "bankrec" ? "Bank reconciliation" : kind === "close" ? "Month-end close" : kind === "audit" ? "Audit tests" : "100M-line ledger";
}

/** Open the guide when the workbook has one (after a sample or template loads). Returns whether it opened. */
export function maybeOpenWorkflowGuide(d: GuideDeps): boolean {
  if (!guideKindOf(d.workbook())) return false;
  openWorkflowGuide(d);
  return true;
}
