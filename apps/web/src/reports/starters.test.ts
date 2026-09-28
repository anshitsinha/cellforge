import { describe, expect, it } from "vitest";
import { Table, type ColumnData } from "@cellforge/core";
import { EditableSource } from "../editable";
import { readSheetColumns } from "../pivotpanel";
import { Workbook } from "../workbook";
import { runBook, runReport, workbookEnv } from "./engine";
import { reportProblem } from "./model";
import { sheetFacts, starterReport, STARTERS } from "./starters";

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
