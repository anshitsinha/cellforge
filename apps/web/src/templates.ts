/**
 * Starter workbooks for the three main jobs: the monthly close, a bank
 * reconciliation and a set of audit tests. Each is built with the same
 * actions a person would use (so templates always match the app), and comes
 * with instructions that name the commands to run, checks, conditional
 * formats, workpaper references and a tick-mark legend.
 */
import "./analysis.css";
import { openDialog } from "./ui/dialog";
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { Table, type ColumnData, type CheckDef } from "@cellforge/core";
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
const ROWS = 2000;

/** Rows of text (or formulas) starting at a cell. */
function block(top: number, left: number, rows: (string | null)[][]): Cell[] {
  return rows.flatMap((r, i) => r.map((input, j) => ({ row: top + i, col: left + j, input })));
}

const header = (cols: number) => ({ type: "format.set", params: { range: { top: 0, left: 0, bottom: 0, right: cols - 1 }, style: { bold: true, fill: "#e8eaed", color: "#202124" } } });
const widths = (list: number[]) => list.map((width, at) => ({ type: "cols.width", params: { at, width } }));
const freezeTop = { type: "view.freeze", params: { rows: 1, cols: 0 } };

class Builder {
  readonly wb: Workbook;
  private readonly ctx: SheetCtx;
  private readonly h: ActionHistory<SheetCtx>;

  constructor(first: string, rows = ROWS, cols = 12) {
    this.wb = new Workbook({ name: first, source: new EditableSource(new BlankSource(rows, cols)) });
    this.ctx = { workbook: this.wb, activeSheet: this.wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    this.h = new ActionHistory(sheetActions(), () => this.ctx);
  }

  sheet(name: string, rows = ROWS, cols = 12): this {
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
  async fillDown(col: number, formula: string, last = ROWS - 1): Promise<this> {
    await this.cells([{ row: 1, col, input: formula }]);
    return this.do({ type: "fill.down", params: { range: { top: 1, left: col, bottom: last, right: col } } });
  }

  checks(list: CheckNoId[]): this {
    this.wb.checks = list.map((c, i) => ({ ...c, id: `t${i + 1}` }) as CheckDef);
    return this;
  }
}

async function instructions(b: Builder, title: string, lines: string[]): Promise<void> {
  await b.cells(block(0, 0, [[title], [null], ...lines.map((l) => [l])]));
  await b.do({ type: "format.set", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, style: { bold: true, size: 14 } } }, ...widths([900]));
}

async function legend(b: Builder): Promise<void> {
  const marks = allMarks(b.wb.review);
  b.sheet("Tick-mark legend", marks.length + 2, 2);
  await b.cells(block(0, 0, [["Mark", "Meaning"], ...marks.map((m) => [m.glyph, m.label])]));
  await b.do(header(2), ...widths([60, 320]));
  for (const [i, m] of marks.entries()) await b.do({ type: "format.set", params: { range: { top: i + 1, left: 0, bottom: i + 1, right: 0 }, style: { color: m.color, bold: true } } });
}

async function closeTemplate(): Promise<Workbook> {
  const b = new Builder("Start here", 40, 1);
  await instructions(b, "Monthly close", [
    "1. Open (Ctrl+O) this month's trial balance export, then use \"Clean up this sheet (messy export)…\" and \"Map this sheet as a trial balance…\".",
    "2. Paste the Code / Name / Debit / Credit columns into \"TB current\" (and last month's into \"TB prior\"). Balance works itself out.",
    "3. Fill \"Mapping\": each account code and the report line it belongs to.",
    "4. \"Flux\" compares the months. Rows over both thresholds (the names Threshold and ThresholdPct, on \"Settings\") are flagged \"Explain\": write the reason in the Explanation column.",
    "5. Run \"Data checks…\": the TB must balance and every account must be mapped. Exports ask first while a check fails.",
    "6. Use \"Pivot table…\" on \"Flux\" for totals by report line, and \"Insert chart…\" for the movement chart.",
    "7. Tick what you've agreed (type \"tick mark\" in the command palette), then \"Sign off this sheet as prepared\". The reviewer adds review notes and signs off as reviewed.",
  ]);
  for (const name of ["TB current", "TB prior"]) {
    b.sheet(name, ROWS, 5);
    await b.cells(block(0, 0, [["Code", "Name", "Debit", "Credit", "Balance"]]));
    await b.fillDown(4, '=IF(A2="","",N(C2)-N(D2))');
    await b.do(header(5), freezeTop, ...widths([90, 260, 110, 110, 120]), { type: "format.set", params: { range: { top: 1, left: 2, bottom: ROWS - 1, right: 4 }, style: { numFmt: "#,##0.00;(#,##0.00)" } } });
  }
  b.sheet("Mapping", ROWS, 3);
  await b.cells(block(0, 0, [["Code", "Report line", "Type"]]));
  await b.do(header(3), freezeTop, ...widths([90, 220, 120]), {
    type: "validation.add",
    params: { rule: { kind: "list", list: ["Income", "Expense", "Asset", "Liability", "Equity"], ranges: [{ top: 1, left: 2, bottom: ROWS - 1, right: 2 }] } },
  });
  b.sheet("Settings", 4, 2);
  await b.cells(block(0, 0, [["Setting", "Value"], ["Threshold (amount)", "10000"], ["Threshold (%)", "10%"]]));
  await b.do(header(2), ...widths([200, 120]), { type: "names.define", params: { name: "Threshold", refersTo: "=Settings!$B$2" } }, { type: "names.define", params: { name: "ThresholdPct", refersTo: "=Settings!$B$3" } });
  b.sheet("Flux", ROWS, 9);
  await b.cells(block(0, 0, [["Code", "Name", "Report line", "This month", "Last month", "Change", "Change %", "Flag", "Explanation"]]));
  await b.fillDown(0, "=IF('TB current'!A2=\"\",\"\",'TB current'!A2)");
  await b.fillDown(1, "=IF('TB current'!A2=\"\",\"\",'TB current'!B2)");
  await b.fillDown(2, '=IF(A2="","",XLOOKUP(A2,Mapping!A:A,Mapping!B:B,"(not mapped)"))');
  await b.fillDown(3, '=IF(A2="","",\'TB current\'!E2)');
  await b.fillDown(4, '=IF(A2="","",XLOOKUP(A2,\'TB prior\'!A:A,\'TB prior\'!E:E,0))');
  await b.fillDown(5, '=IF(A2="","",D2-E2)');
  await b.fillDown(6, '=IF(OR(A2="",E2=0),"",F2/ABS(E2))');
  await b.fillDown(7, '=IF(A2="","",IF(AND(ABS(F2)>=Threshold,OR(E2=0,ABS(G2)>=ThresholdPct)),"Explain",""))');
  const all = (c: number) => ({ top: 1, left: c, bottom: ROWS - 1, right: c });
  await b.do(
    header(9),
    freezeTop,
    ...widths([90, 240, 160, 120, 120, 120, 90, 80, 320]),
    { type: "format.set", params: { range: { top: 1, left: 3, bottom: ROWS - 1, right: 5 }, style: { numFmt: "#,##0.00;(#,##0.00)" } } },
    { type: "format.set", params: { range: all(6), style: { numFmt: "0.0%" } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: "Explain", ranges: [all(7)], format: { fill: "#ffeb9c", color: "#9c5700", bold: true } } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: "not mapped", ranges: [all(2)], format: { fill: "#ffc7ce", color: "#9c0006" } } } },
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

async function bankRecTemplate(): Promise<Workbook> {
  const b = new Builder("Start here", 40, 1);
  await instructions(b, "Bank reconciliation", [
    "1. Paste (or open and copy) the cash book into \"Cash book\", and the bank statement into \"Bank statement\". A PDF statement opens directly with Ctrl+O.",
    "2. Run \"Reconcile two sheets…\" with Cash book as side A and Bank statement as side B. Matched and unmatched items go on new sheets.",
    "3. Run \"Bank rec statement…\" for the statement with proposed journal entries for bank-only items, or fill the \"Rec\" sheet below by hand.",
    "4. Next month, \"Roll forward outstanding items…\" shows which of these items cleared.",
    "5. Run \"Data checks…\" (the rec must have no difference), tick what you agreed, and sign off.",
  ]);
  for (const name of ["Cash book", "Bank statement"]) {
    b.sheet(name, ROWS, 5);
    await b.cells(block(0, 0, [["Date", "Reference", "Description", "Amount", "Note"]]));
    await b.do(header(5), freezeTop, ...widths([100, 120, 300, 120, 220]), { type: "format.set", params: { range: { top: 1, left: 0, bottom: ROWS - 1, right: 0 }, style: { numFmt: "yyyy-mm-dd" } } }, { type: "format.set", params: { range: { top: 1, left: 3, bottom: ROWS - 1, right: 3 }, style: { numFmt: "#,##0.00;(#,##0.00)" } } });
  }
  b.sheet("Outstanding", 500, 4);
  await b.cells(block(0, 0, [["Kind", "Date", "Description", "Amount"]]));
  await b.do(header(4), freezeTop, ...widths([180, 100, 300, 120]), {
    type: "validation.add",
    params: { rule: { kind: "list", list: ["Deposit in transit", "Outstanding payment", "Bank error", "Bank only (fee, interest)", "Ledger error"], ranges: [{ top: 1, left: 0, bottom: 499, right: 0 }] } },
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
    { type: "format.set", params: { range: { top: 0, left: 0, bottom: 0, right: 0 }, style: { bold: true, size: 14 } } },
    { type: "format.set", params: { range: { top: 2, left: 1, bottom: 13, right: 1 }, style: { numFmt: "#,##0.00;(#,##0.00)" } } },
    { type: "format.set", params: { range: { top: 6, left: 0, bottom: 6, right: 1 }, style: { bold: true } } },
    { type: "format.set", params: { range: { top: 11, left: 0, bottom: 11, right: 1 }, style: { bold: true } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "cell", op: "!=", a: 0, ranges: [{ top: 13, left: 1, bottom: 13, right: 1 }], format: { fill: "#ffc7ce", color: "#9c0006", bold: true } } } },
    ...widths([300, 140]),
    { type: "review.ref", params: { ref: "B-1" } },
    { type: "cells.extra", params: { row: 2, col: 1, note: "Type the closing balance from the bank statement." } },
  );
  await legend(b);
  b.checks([
    { name: "The reconciliation has no difference", sheet: "Rec", kind: "formula", formula: "=ROUND($B$14,2)=0" },
    { name: "Every outstanding item has a kind", sheet: "Outstanding", kind: "formula", formula: '=OR(AND(B2="",C2="",D2=""),A2<>"")' },
    { name: "Cash book amounts are numbers", sheet: "Cash book", kind: "type", col: 3, type: "number", allowBlank: true },
  ]);
  return b.wb;
}

async function auditTemplate(): Promise<Workbook> {
  const b = new Builder("Start here", 40, 1);
  await instructions(b, "Audit tests", [
    "1. Paste the population (journal lines, invoices or payments) into \"Population\", or open the export and copy it in. Record the source file in \"Results\".",
    "2. Run each test from the command palette on \"Population\": \"Find duplicates…\", \"Find gaps in a sequence…\", \"Benford's law test…\", \"Journal entry tests…\", \"Stratify values into bands…\".",
    "3. \"Pick a sample…\" (random, systematic or monetary unit). Write the seed it shows into \"Results\" so the sample can be picked again.",
    "4. Fill in each test's status and conclusion on \"Results\"; tick checked items (type \"tick mark\" in the command palette) and add review notes for exceptions.",
    "5. \"Save an evidence pack…\" keeps the workbook, the input fingerprints and the hash-chained log together for the file.",
  ]);
  b.sheet("Population", ROWS, 8);
  await b.cells(block(0, 0, [["Entry", "Date", "Posted", "User", "Account", "Description", "Amount", "Reference"]]));
  await b.do(header(8), freezeTop, ...widths([90, 100, 140, 90, 100, 300, 120, 120]), { type: "format.set", params: { range: { top: 1, left: 6, bottom: ROWS - 1, right: 6 }, style: { numFmt: "#,##0.00;(#,##0.00)" } } });
  b.sheet("Results", 20, 5);
  await b.cells(
    block(0, 0, [
      ["Test", "Status", "Exceptions", "Conclusion", "Workpaper"],
      ["Duplicates (exact and near)", "Not started", null, null, "A-1"],
      ["Sequence gaps", "Not started", null, null, "A-2"],
      ["Benford (first digits)", "Not started", null, null, "A-3"],
      ["Journal entry tests", "Not started", null, null, "A-4"],
      ["Stratification", "Not started", null, null, "A-5"],
      ["Sample (seed: )", "Not started", null, null, "A-6"],
      [null, null, null, null, null],
      ["Source file", null, null, null, null],
      ["Records in the population", "=COUNTA(Population!A:A)-1", null, null, null],
      ["Total amount", "=SUM(Population!G:G)", null, null, null],
    ]),
  );
  await b.do(
    header(5),
    ...widths([240, 120, 100, 420, 100]),
    { type: "validation.add", params: { rule: { kind: "list", list: ["Not started", "In progress", "Done: no exceptions", "Done: exceptions"], ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }] } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "contains", value: "exceptions", ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }], format: { fill: "#ffc7ce", color: "#9c0006" } } } },
    { type: "format.conditionalAdd", params: { rule: { kind: "text", op: "begins", value: "Done: no", ranges: [{ top: 1, left: 1, bottom: 6, right: 1 }], format: { fill: "#c6efce", color: "#006100" } } } },
    { type: "format.set", params: { range: { top: 10, left: 1, bottom: 10, right: 1 }, style: { numFmt: "#,##0.00" } } },
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

/** A fresh workbook for a template, with its first sheet active. */
export async function buildTemplate(kind: TemplateKind): Promise<Workbook> {
  const wb = kind === "close" ? await closeTemplate() : kind === "bankrec" ? await bankRecTemplate() : await auditTemplate();
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
