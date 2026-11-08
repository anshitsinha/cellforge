import { describe, expect, it } from "vitest";
import { Table, type ColumnData } from "@cellforge/core";
import { EditableSource } from "../editable";
import { readSheetColumns } from "../pivotpanel";
import { Workbook } from "../workbook";
import { runBook, runReport, workbookEnv } from "./engine";
import { reportProblem } from "./model";
import { inferPeriod, isFlux, sheetFacts, starterReport, STARTERS } from "./starters";

function text(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const codes = Uint32Array.from(values, (v) => {
    if (!v) return 0;
    const i = dict.indexOf(v);
    return i >= 0 ? i + 1 : dict.push(v);
  });
  return { kind: "string", name, codes, dict };
}
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });

function ledger() {
  const n = 12;
  const src = new EditableSource(
    new Table([
      num("Date", Array.from({ length: n }, (_, i) => 46023 + i * 20)),
      text("Ref", Array.from({ length: n }, (_, i) => `INV-${100 + i}`)),
      text("Vendor", Array.from({ length: n }, (_, i) => ["Acme", "Globex", "Initech"][i % 3])),
      num("Account", Array.from({ length: n }, (_, i) => 6000 + (i % 2) * 10)),
      num("Amount", Array.from({ length: n }, (_, i) => 100 + i * 10.5)),
    ]),
    5,
  );
  src.styles.apply(0, "all", { numFmt: "yyyy-mm-dd" });
  src.styles.apply(4, "all", { numFmt: "#,##0.00" });
  const wb = new Workbook({ name: "Ledger", source: src });
  const sheet = wb.sheets[0];
  return { wb, sheet, facts: sheetFacts(sheet.id, sheet.name, readSheetColumns(src)) };
}

describe("report starters", () => {
  it("finds the sheet's amount, category and date", () => {
    const { facts } = ledger();
    expect(facts).toMatchObject({ amount: 4, category: 2, date: 0, rows: 12, headerRow: false });
  });

  it("every starter makes a valid report that runs without problems", () => {
    const { wb, facts } = ledger();
    const env = workbookEnv(wb);
    for (const s of STARTERS) {
      const r = starterReport(s.kind, facts);
      expect(reportProblem(r), s.kind).toBeNull();
      const runs = runBook(r, env);
      for (const run of runs) expect(run.warnings, s.kind).toEqual([]);
      expect(runs.flatMap((x) => x.blocks).some((b) => b.kind === "error"), s.kind).toBe(false);
    }
  });

  it("the summary leads with the key figures and a table and chart by category", () => {
    const { wb, facts } = ledger();
    const r = runReport(starterReport("summary", facts), workbookEnv(wb));
    expect(r.title).toBe("Ledger summary");
    const para = r.blocks.find((b) => b.kind === "paragraph");
    expect(para && "text" in para && para.text).toBe("Total Amount: 1,893.00 across 12 lines.");
    const kinds = r.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["heading", "paragraph", "heading", "table", "chart", "pageBreak", "heading", "table"]);
    const table = r.blocks[3];
    expect(table.kind === "table" && table.rows.map((x) => x.cells[0])).toEqual(["Acme", "Globex", "Initech", "Grand total"]);
  });

  it("one report per item runs for each vendor plus a consolidated one", () => {
    const { wb, facts } = ledger();
    const runs = runBook(starterReport("entity", facts), workbookEnv(wb));
    expect(runs.map((x) => x.blocks[0].kind === "heading" && x.blocks[0].text)).toEqual(["Consolidated", "Acme", "Globex", "Initech"]);
    const acme = runs[1].blocks.find((b) => b.kind === "paragraph");
    // Acme is lines 0, 3, 6, 9: 100 + 31.5 + 63 + 94.5 + 4 x 100 … = 4 lines
    expect(acme && "text" in acme && acme.text).toMatch(/across 4 lines\.$/);
    const lines = runs[1].blocks[runs[1].blocks.length - 1];
    expect(lines.kind === "table" && lines.rows.length).toBe(4);
  });

  it("a blank report is empty, and a sheet with nothing in it still gets a report", () => {
    const { facts } = ledger();
    expect(starterReport("blank", facts).blocks).toEqual([]);
    const empty = sheetFacts("s", "Empty", null);
    expect(starterReport("summary", empty).blocks).toEqual([]);
  });
});

describe("report starters on a balanced journal", () => {
  it("count lines by category instead of adding amounts that net to nothing", () => {
    const n = 12;
    const users = Array.from({ length: n * 2 }, (_, i) => ["akhan", "jlee", "bmorales"][Math.floor(i / 2) % 3]);
    const amounts = Array.from({ length: n * 2 }, (_, i) => (i % 2 ? -1 : 1) * (100 + Math.floor(i / 2) * 7.25));
    const src = new EditableSource(new Table([text("User", users), num("Amount", amounts)]), 2);
    const wb = new Workbook({ name: "Journal", source: src });
    const facts = sheetFacts(wb.sheets[0].id, "Journal", readSheetColumns(src));
    expect(facts.balanced).toBe(true);
    const r = runReport(starterReport("summary", facts), workbookEnv(wb));
    const headings = r.blocks.filter((b) => b.kind === "heading").map((b) => ("text" in b ? b.text : ""));
    expect(headings).toContain("Lines by User");
    const table = r.blocks.find((b) => b.kind === "table");
    expect(table && table.kind === "table" && table.rows.map((x) => x.cells[1])).toEqual(["8", "8", "8", "24"]);
  });
});

describe("report starters on a flux sheet", () => {
  // a month's flux: codes, names, report lines, this month / last month / change, a flag and explanations
  function flux() {
    const names = ["Cash at bank", "Receivables", "Payables", "Accruals", "Revenue", "Legal fees", "Marketing", "Rent"];
    const lines = ["Cash", "Receivables", "Payables", "Accruals", "Revenue", "Overheads", "Overheads", "Premises"];
    const now = [414_756.36, 418_346.98, -287_392.38, -102_800, -667_450.6, 40_650, 21_500, 162_289.64];
    const last = [339_030.5, 412_880.4, -286_140.2, -64_300, -612_340, 2_150, 48_000, 160_719.3];
    const flags = [null, null, null, "Explain", null, "Explain", "Explain", null];
    const src = new EditableSource(
      new Table([
        num("Code", [1000, 1100, 2000, 2100, 4000, 6310, 6500, 6100]),
        text("Name", names),
        text("Report line", lines),
        num("This month", now),
        num("Last month", last),
        num("Change", now.map((x, i) => Math.round((x - last[i]) * 100) / 100)),
        num("Change %", now.map((x, i) => (x - last[i]) / Math.abs(last[i]))),
        text("Flag", flags),
        text("Explanation", [null, null, null, "Legal accrual", null, "Dispute accrued", null, null]),
      ]),
      2,
    );
    for (const c of [3, 4, 5]) src.styles.apply(c, "all", { numFmt: "#,##0.00;(#,##0.00)" });
    src.styles.apply(6, "all", { numFmt: "0.0%" });
    const wb = new Workbook({ name: "Flux", source: src });
    return { wb, facts: sheetFacts(wb.sheets[0].id, "Flux", readSheetColumns(src), { texts: ["Month-end close for Halden & Pryce"], today: new Date(2026, 10, 17) }) };
  }

  it("reads the flag, the notes, the report lines and the measures", () => {
    const { facts } = flux();
    expect(facts).toMatchObject({ category: 2, flag: 7, flagValue: "Explain", note: 8, amount: 3 });
    expect(facts.measures).toEqual([3, 4, 5]);
    expect(isFlux(facts)).toBe(true);
    // no dates and no month named anywhere: the month just ended
    expect(facts.period).toEqual({ key: "2026-10", label: "October 2026" });
  });

  it("leads with the flagged movements and totals by report line, never a total of 0.00 or a (blank) group", () => {
    const { wb, facts } = flux();
    for (const kind of ["summary", "close"] as const) {
      const rep = starterReport(kind, facts);
      expect(reportProblem(rep)).toBeNull();
      const r = runReport(rep, workbookEnv(wb));
      expect(r.warnings).toEqual([]);
      const headings = r.blocks.filter((b) => b.kind === "heading").map((b) => ("text" in b ? b.text : ""));
      expect(headings).toContain("Movements over threshold");
      expect(headings).toContain("Totals by Report line");
      const para = r.blocks.find((b) => b.kind === "paragraph");
      expect(para && "text" in para && para.text).toBe('3 of 8 accounts moved by more than the threshold and are flagged "Explain"; each needs an explanation.');
      const flagged = r.blocks.find((b) => b.kind === "table");
      expect(flagged?.kind === "table" && flagged.rows.map((x) => x.cells[1])).toEqual(["Accruals", "Legal fees", "Marketing"]);
      const text = JSON.stringify(r.blocks);
      expect(text).not.toContain("(blank)");
      expect(text).not.toMatch(/Total This month: 0\.00/);
    }
    expect(runReport(starterReport("close", facts), workbookEnv(wb)).subtitle).toBe("Flux, period October 2026");
  });
});

describe("the period a report is for", () => {
  const today = new Date(2026, 10, 17);
  it("comes from the latest date in the data", () => {
    expect(inferPeriod(Float64Array.from([46296, 46326]), [], today)).toEqual({ key: "2026-10", label: "October 2026" }); // 2026-10-01, 2026-10-31
  });
  it("else from a month named in the workbook, else the month just ended", () => {
    expect(inferPeriod(null, ["Trial balance, September 2026"], today).key).toBe("2026-09");
    expect(inferPeriod(null, ["TB Sept-25"], today).key).toBe("2025-09");
    expect(inferPeriod(null, ["Close 2026-08"], today).key).toBe("2026-08");
    expect(inferPeriod(null, ["Marketing 2026"], today).key).toBe("2026-10");
    expect(inferPeriod(null, [], new Date(2026, 0, 5)).key).toBe("2025-12");
  });
});
