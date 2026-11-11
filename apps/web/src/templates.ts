/**
 * Starter workbooks for the three main jobs: the monthly close, a bank
 * reconciliation and a set of audit tests. Each is built with the same
 * actions a person would use (so templates always match the app), and comes
 * with checks, conditional formats, workpaper references and a tick-mark
 * legend. The steps themselves live in the workflow guide panel
 * (workflowguide.ts); the "Start here" sheet is a short cover for anyone
 * who opens the file in another program.
 */
import "./analysis.css";
import { openDialog } from "./ui/dialog";
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { Table, type ColumnData, type CheckDef } from "@cellforge/core";
import type { CellStyle } from "@cellforge/grid";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { allMarks } from "./review";
import { Workbook } from "./workbook";

export type TemplateKind = "close" | "bankrec" | "audit";

export const TEMPLATES: { kind: TemplateKind; title: string; summary: string }[] = [
  { kind: "close", title: "Monthly close", summary: "Trial balance this month and last, mapping to report lines, flux analysis with thresholds, checks and sign-off." },
  { kind: "bankrec", title: "Bank reconciliation", summary: "Cash book and bank statement sheets, the reconciliation statement, outstanding items, checks and sign-off." },
  { kind: "audit", title: "Audit tests", summary: "A population sheet and a results summary for duplicates, gaps, Benford, journal entry tests and a recorded sample." },
];

type Cell = { row: number; col: number; input: string | null };
type CheckNoId = CheckDef extends infer C ? (C extends CheckDef ? Omit<C, "id"> : never) : never;

/** Rows on an empty template's data sheets: room to paste a month. */
export const TEMPLATE_ROWS = 2000;

/**
 * Cell looks that read in both themes: semantic roles that the grid paints
 * in the theme's own colours (a soft grey header band on white, a lighter
 * band on the dark grid; flags in amber, red and green tints), with the
 * text in the theme's colour. No hard-coded fills or text colours.
 */
export const ROLE_STYLES = {
  header: { bold: true, role: "header" },
  flagWarn: { bold: true, role: "flag-warn" },
  flagBad: { bold: true, role: "flag-bad" },
  good: { role: "flag-good" },
  total: { bold: true, role: "total" },
  title: { bold: true, size: 16 },
} satisfies Record<string, CellStyle>;

/**
 * Conditional-format looks (rules carry colours, not roles): translucent
 * tints (#rrggbbaa) over the sheet's own background, with the theme's text
 * colour, so they read on white and on the dark grid alike. Excel export
 * blends the tint over white.
 */
export const CF_STYLES = {
  flagWarn: { bold: true, fill: "#f9ab0047" },
  flagBad: { bold: true, fill: "#ea433540" },
  good: { fill: "#34a85338" },
} as const;

/** Rows of text (or formulas) starting at a cell. */
function block(top: number, left: number, rows: (string | null)[][]): Cell[] {
  return rows.flatMap((r, i) => r.map((input, j) => ({ row: top + i, col: left + j, input })));
}

const styled = (top: number, left: number, bottom: number, right: number, style: CellStyle) => ({ type: "format.set", params: { range: { top, left, bottom, right }, style } });
const header = (cols: number) => styled(0, 0, 0, cols - 1, ROLE_STYLES.header);
const widths = (list: number[]) => list.map((width, at) => ({ type: "cols.width", params: { at, width } }));
const freezeTop = { type: "view.freeze", params: { rows: 1, cols: 0 } };
const MONEY = "#,##0.00;(#,##0.00)";

class Builder {
  readonly wb: Workbook;
  private readonly ctx: SheetCtx;
  private readonly h: ActionHistory<SheetCtx>;

  constructor(first: string, rows: number, cols = 12) {
    this.wb = new Workbook({ name: first, source: new EditableSource(new BlankSource(rows, cols)) });
    this.ctx = { workbook: this.wb, activeSheet: this.wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    this.h = new ActionHistory(sheetActions(), () => this.ctx);
  }

  sheet(name: string, rows: number, cols = 12): this {
    const s = this.wb.add(name, new EditableSource(new BlankSource(rows, cols)));
    this.ctx.activeSheet = s.id;
    return this;
  }

  on(name: string): this {
    this.ctx.activeSheet = this.wb.byName(name)!.id;
    return this;
  }

  async do(...actions: Action[]): Promise<this> {
    for (const a of actions) await this.h.run(a, "system");
    return this;
  }

  cells(cells: Cell[]): Promise<this> {
    return this.do(setCells(cells));
  }

  /** a formula written for row 2, filled down to the last row */
  async fillDown(col: number, formula: string, last: number): Promise<this> {
    await this.cells([{ row: 1, col, input: formula }]);
    return this.do({ type: "fill.down", params: { range: { top: 1, left: col, bottom: last, right: col } } });
  }

  checks(list: CheckNoId[]): this {
    this.wb.checks = list.map((c, i) => ({ ...c, id: `t${i + 1}` }) as CheckDef);
    return this;
  }
}

/**
 * The cover sheet: a title and two short lines that fit the column (the
 * steps are in the guide panel). `lines` should stay under about 100
 * characters each.
 */
async function coverSheet(b: Builder, title: string, lines: [string, string]): Promise<void> {
  await b.cells(block(0, 0, [[title], [lines[0]], [lines[1]]]));
  await b.do(styled(0, 0, 0, 0, ROLE_STYLES.title), { type: "rows.height", params: { at: 0, height: 34 } }, styled(1, 0, 2, 0, { wrap: true }), ...widths([760]));
}

async function legend(b: Builder): Promise<void> {
  const marks = allMarks(b.wb.review);
  b.sheet("Tick-mark legend", marks.length + 2, 2);
  await b.cells(block(0, 0, [["Mark", "Meaning"], ...marks.map((m) => [m.glyph, m.label])]));
  await b.do(header(2), ...widths([60, 320]));
  for (const [i, m] of marks.entries()) await b.do(styled(i + 1, 0, i + 1, 0, { color: m.color, bold: true }));
}

/** How big to make the data sheets. */
export interface TemplateSize {
  /** rows on the data sheets (header included); formulas fill down this far */
  rows?: number;
}

const GUIDE_LINE = "In cellforge, the guide on the right takes you through each step with a button for each.";

async function closeTemplate(size: TemplateSize): Promise<Workbook> {
  const R = size.rows ?? TEMPLATE_ROWS;
  const b = new Builder("Start here", 3, 1);
  await coverSheet(b, "Monthly close", [GUIDE_LINE, "Elsewhere: fill TB current, TB prior and Mapping; Flux flags movements to explain; then sign off."]);
  for (const name of ["TB current", "TB prior"]) {
    b.sheet(name, R, 5);
    await b.cells(block(0, 0, [["Code", "Name", "Debit", "Credit", "Balance"]]));
    await b.fillDown(4, '=IF(A2="","",N(C2)-N(D2))', R - 1);
    await b.do(header(5), freezeTop, ...widths([90, 260, 110, 110, 120]), styled(1, 2, R - 1, 4, { numFmt: MONEY }));
  }
  b.sheet("Mapping", R, 3);
  await b.cells(block(0, 0, [["Code", "Report line", "Type"]]));
  await b.do(header(3), freezeTop, ...widths([90, 220, 120]), {
    type: "validation.add",
    params: { rule: { kind: "list", list: ["Income", "Expense", "Asset", "Liability", "Equity"], ranges: [{ top: 1, left: 2, bottom: R - 1, right: 2 }] } },
  });
  b.sheet("Settings", 4, 2);
  await b.cells(block(0, 0, [["Setting", "Value"], ["Threshold (amount)", "10000"], ["Threshold (%)", "10%"]]));
  await b.do(header(2), ...widths([200, 120]), styled(1, 1, 1, 1, { numFmt: "#,##0" }), { type: "names.define", params: { name: "Threshold", refersTo: "=Settings!$B$2" } }, { type: "names.define", params: { name: "ThresholdPct", refersTo: "=Settings!$B$3" } });
  b.sheet("Flux", R, 9);
  await b.cells(block(0, 0, [["Code", "Name", "Report line", "This month", "Last month", "Change", "Change %", "Flag", "Explanation"]]));
  await b.fillDown(0, "=IF('TB current'!A2=\"\",\"\",'TB current'!A2)", R - 1);
  await b.fillDown(1, "=IF('TB current'!A2=\"\",\"\",'TB current'!B2)", R - 1);
  await b.fillDown(2, '=IF(A2="","",XLOOKUP(A2,Mapping!A:A,Mapping!B:B,"(not mapped)"))', R - 1);
  await b.fillDown(3, '=IF(A2="","",\'TB current\'!E2)', R - 1);
  await b.fillDown(4, '=IF(A2="","",XLOOKUP(A2,\'TB prior\'!A:A,\'TB prior\'!E:E,0))', R - 1);
  await b.fillDown(5, '=IF(A2="","",D2-E2)', R - 1);
  await b.fillDown(6, '=IF(OR(A2="",E2=0),"",F2/ABS(E2))', R - 1);
  await b.fillDown(7, '=IF(A2="","",IF(AND(ABS(F2)>=Threshold,OR(E2=0,ABS(G2)>=ThresholdPct)),"Explain",""))', R - 1);
  const all = (c: number) => ({ top: 1, left: c, bottom: R - 1, right: c });
  await b.do(
    header(9),
    freezeTop,
    ...widths([90, 240, 160, 120, 120, 120, 90, 80, 320]),
    styled(1, 3, R - 1, 5, { numFmt: MONEY }),
    { type: "format.set", params: { range: all(6), style: { numFmt: "0.0%" } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: "Explain", ranges: [all(7)], format: CF_STYLES.flagWarn } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: "not mapped", ranges: [all(2)], format: CF_STYLES.flagBad } } },
    { type: "review.ref", params: { ref: "C-2" } },
  );
  await b.on("TB current").do({ type: "review.ref", params: { ref: "C-1" } });
  await legend(b);
  b.checks([
    { name: "This month's TB balances (debits = credits)", sheet: "TB current", kind: "totalsEqual", col: 4, tolerance: 0.005 },
    { name: "Every account is mapped", sheet: "TB current", kind: "inList", col: 0, listSheet: "Mapping", listCol: 0, allowBlank: true },
    { name: "No account code twice in this month's TB", sheet: "TB current", kind: "noDuplicateKeys", cols: [0] },
    { name: "Every flagged change is explained", sheet: "Flux", kind: "formula", formula: '=OR(H2<>"Explain",I2<>"")', severity: "warn" },
  ]);
  return b.wb;
}

/** The Rec sheet's layout: the label in A and the figure in B, 0-based rows. */
export const REC_ROWS = { bank: 2, dit: 3, outstanding: 4, bankErrors: 5, adjustedBank: 6, ledger: 8, bankOnly: 9, ledgerErrors: 10, adjustedLedger: 11, difference: 13 } as const;

/** The kinds on the Outstanding sheet, in the order the Rec sheet uses them. */
export const OUTSTANDING_KINDS = ["Deposit in transit", "Outstanding payment", "Bank error", "Bank only (fee, interest)", "Ledger error"] as const;
export type OutstandingKind = (typeof OUTSTANDING_KINDS)[number];

async function bankRecTemplate(size: TemplateSize): Promise<Workbook> {
  const R = size.rows ?? TEMPLATE_ROWS;
  const b = new Builder("Start here", 3, 1);
  await coverSheet(b, "Bank reconciliation", [GUIDE_LINE, "Elsewhere: list each reconciling item on Outstanding with its kind; Rec must show a nil difference."]);
  for (const name of ["Cash book", "Bank statement"]) {
    b.sheet(name, R, 5);
    await b.cells(block(0, 0, [["Date", "Reference", "Description", "Amount", "Note"]]));
    await b.do(header(5), freezeTop, ...widths([100, 120, 300, 120, 220]), styled(1, 0, R - 1, 0, { numFmt: "yyyy-mm-dd" }), styled(1, 3, R - 1, 3, { numFmt: MONEY }));
  }
  const O = Math.min(500, Math.max(60, R));
  b.sheet("Outstanding", O, 4);
  await b.cells(block(0, 0, [["Kind", "Date", "Description", "Amount"]]));
  await b.do(header(4), freezeTop, ...widths([200, 100, 380, 120]), styled(1, 1, O - 1, 1, { numFmt: "yyyy-mm-dd" }), styled(1, 3, O - 1, 3, { numFmt: MONEY }), {
    type: "validation.add",
    params: { rule: { kind: "list", list: [...OUTSTANDING_KINDS], ranges: [{ top: 1, left: 0, bottom: O - 1, right: 0 }] } },
  });
  b.sheet("Rec", 16, 2);
  await b.cells(
    block(0, 0, [
      ["Bank reconciliation", null],
      [null, null],
      ["Balance per bank statement", "0"],
      ["Add: deposits in transit", '=SUMIFS(Outstanding!D:D,Outstanding!A:A,"Deposit in transit")'],
      ["Less: outstanding payments", '=-SUMIFS(Outstanding!D:D,Outstanding!A:A,"Outstanding payment")'],
      ["Bank errors", '=SUMIFS(Outstanding!D:D,Outstanding!A:A,"Bank error")'],
      ["Adjusted bank balance", "=SUM(B3:B6)"],
      [null, null],
      ["Balance per cash book", "=SUM('Cash book'!D:D)"],
      ["Bank-only items (fees, interest)", '=SUMIFS(Outstanding!D:D,Outstanding!A:A,"Bank only (fee, interest)")'],
      ["Ledger errors", '=SUMIFS(Outstanding!D:D,Outstanding!A:A,"Ledger error")'],
      ["Adjusted cash book balance", "=SUM(B9:B11)"],
      [null, null],
      ["Difference (should be 0.00)", "=ROUND(B7-B12,2)"],
    ]),
  );
  await b.do(
    styled(0, 0, 0, 0, ROLE_STYLES.title),
    { type: "rows.height", params: { at: 0, height: 34 } },
    styled(2, 1, 13, 1, { numFmt: MONEY }),
    styled(6, 0, 6, 1, ROLE_STYLES.total),
    styled(11, 0, 11, 1, ROLE_STYLES.total),
    styled(13, 0, 13, 1, ROLE_STYLES.total),
    { type: "format.conditionalAdd", params: { rule: { kind: "cell", op: "!=", a: 0, ranges: [{ top: 13, left: 1, bottom: 13, right: 1 }], format: CF_STYLES.flagBad } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "cell", op: "=", a: 0, ranges: [{ top: 13, left: 1, bottom: 13, right: 1 }], format: CF_STYLES.good } } },
    ...widths([300, 140]),
    { type: "review.ref", params: { ref: "B-1" } },
    { type: "cells.extra", params: { row: 2, col: 1, note: "The closing balance from the bank statement." } },
  );
  await legend(b);
  b.checks([
    { name: "The reconciliation has no difference", sheet: "Rec", kind: "cell", cell: "B14", op: "=", value: 0, tolerance: 0.005 },
    { name: "Every outstanding item has a kind", sheet: "Outstanding", kind: "formula", formula: '=OR(AND(B2="",C2="",D2=""),A2<>"")' },
    { name: "Cash book amounts are numbers", sheet: "Cash book", kind: "type", col: 3, type: "number", allowBlank: true },
  ]);
  return b.wb;
}

/** The audit Results sheet: one row per test (0-based sheet rows), filled in by the audit tools. */
export const RESULTS_ROWS = { duplicates: 1, sequence: 2, benford: 3, journal: 4, stratify: 5, sample: 6 } as const;
export type ResultsTest = keyof typeof RESULTS_ROWS;

async function auditTemplate(size: TemplateSize): Promise<Workbook> {
  const R = size.rows ?? TEMPLATE_ROWS;
  const b = new Builder("Start here", 3, 1);
  await coverSheet(b, "Audit tests", [GUIDE_LINE, "Elsewhere: the population is on Population; each test's status, exceptions and conclusion go on Results."]);
  b.sheet("Population", R, 8);
  await b.cells(block(0, 0, [["Entry", "Date", "Posted", "User", "Account", "Description", "Amount", "Reference"]]));
  await b.do(header(8), freezeTop, ...widths([90, 100, 140, 90, 100, 300, 120, 120]), styled(1, 1, R - 1, 1, { numFmt: "yyyy-mm-dd" }), styled(1, 6, R - 1, 6, { numFmt: MONEY }));
  b.sheet("Results", 20, 6);
  await b.cells(
    block(0, 0, [
      ["Test", "Status", "Exceptions", "Conclusion", "Workpaper", "Detail"],
      ["Duplicates (exact and near)", "Not started", null, null, "A-1", null],
      ["Sequence gaps", "Not started", null, null, "A-2", null],
      ["Benford (first digits)", "Not started", null, null, "A-3", null],
      ["Journal entry tests", "Not started", null, null, "A-4", null],
      ["Stratification", "Not started", null, null, "A-5", null],
      ["Sample", "Not started", null, null, "A-6", null],
      [null, null, null, null, null, null],
      ["Source file", null, null, null, null, null],
      ["Lines in the population", "=COUNTA(Population!A:A)-1", null, null, null, null],
      ["Total debits", '=SUMIF(Population!G:G,">0")', null, null, null, null],
    ]),
  );
  await b.do(
    header(6),
    ...widths([220, 160, 100, 380, 90, 260]),
    { type: "validation.add", params: { rule: { kind: "list", list: ["Not started", "In progress", "Done: no exceptions", "Done: exceptions"], ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }] } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: ": exceptions", ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }], format: CF_STYLES.flagWarn } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "begins", value: "Done: no", ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }], format: CF_STYLES.good } } },
    styled(1, 2, 6, 2, { numFmt: "#,##0" }),
    styled(9, 1, 9, 1, { numFmt: "#,##0" }),
    styled(10, 1, 10, 1, { numFmt: MONEY }),
    { type: "review.ref", params: { ref: "A" } },
  );
  await legend(b);
  b.checks([
    { name: "Every entry has an amount", sheet: "Population", kind: "type", col: 6, type: "number" },
    { name: "Entry numbers aren't repeated on the same line", sheet: "Population", kind: "noDuplicateKeys", cols: [0, 4, 6], severity: "warn" },
    { name: "Every test has a conclusion", sheet: "Results", kind: "formula", formula: '=OR(A2="",LEFT(B2,4)<>"Done",D2<>"")', severity: "warn" },
  ]);
  return b.wb;
}

/** A fresh workbook for a template, with its first sheet active. `size.rows` sizes the data sheets (samples use only what their data needs). */
export async function buildTemplate(kind: TemplateKind, size: TemplateSize = {}): Promise<Workbook> {
  const wb = kind === "close" ? await closeTemplate(size) : kind === "bankrec" ? await bankRecTemplate(size) : await auditTemplate(size);
  // the template's build steps aren't the user's history
  wb.evidence = { log: [], inputs: [] };
  for (const s of wb.sheets) s.origin = `From the "${TEMPLATES.find((t) => t.kind === kind)!.title}" template`;
  return wb;
}

/** The gallery: resolves with the chosen kind, or null. */
export function pickTemplate(): Promise<TemplateKind | null> {
  const cards = document.createElement("div");
  cards.className = "an-cards";
  let chosen: TemplateKind | null = null;
  const dlg = openDialog({
    title: "New from a template",
    subtitle: "A workbook laid out for the job, ready for your data",
    size: "lg",
    body: cards,
    actions: [{ label: "Cancel", dismiss: true }],
  });
  for (const t of TEMPLATES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "an-card";
    const title = document.createElement("span");
    title.className = "an-card__title";
    title.textContent = t.title;
    const text = document.createElement("span");
    text.className = "an-card__text";
    text.textContent = t.summary;
    card.append(title, text);
    card.addEventListener("click", () => {
      chosen = t.kind;
      dlg.close(t.kind);
    });
    cards.append(card);
  }
  cards.querySelector("button")?.focus();
  return dlg.closed.then(() => chosen);
}

/** For tests: a small table as a sheet. */
export function tableSheet(columns: ColumnData[]): EditableSource {
  return new EditableSource(new Table(columns), 5);
}
