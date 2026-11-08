import { describe, expect, it } from "vitest";
import { fieldLabel, hasFields, textParts } from "./fields";
import { fitPage, reportHtml, tableWidth } from "./output";

const names = ["Code", "Name", "Report line", "This month", "Last month", "Change"];

describe("live fields in report text", () => {
  it("reads formulas as words", () => {
    expect(fieldLabel('=TEXT(ROUND(SUM(D:D),2),"#,##0.00")', names)).toBe("Total of This month");
    expect(fieldLabel('=TEXT(COUNT(D:D),"#,##0")', names)).toBe("Number of lines");
    expect(fieldLabel('=COUNTIF(H:H,"Explain")', names)).toBe("Lines where column H is Explain");
    expect(fieldLabel('=TEXT(ROUND(SUMIF(D:D,">0"),2),"#,##0.00")', names)).toBe("Debits in This month");
    expect(fieldLabel("=SUMIFS(F:F,C:C,{entity})", names)).toBe("Total of Change for the entity");
    expect(fieldLabel("=MAX(E2:E40)", names)).toBe("Largest Last month");
    expect(fieldLabel("=A1*2", names)).toBe("Formula");
    expect(fieldLabel("period", names)).toBe("Period");
  });

  it("splits text into words and chips", () => {
    const parts = textParts('Total This month: {{=TEXT(ROUND(SUM(D:D),2),"#,##0.00")}} for {{period}}.', names);
    expect(parts).toEqual([
      { kind: "text", text: "Total This month: " },
      { kind: "field", source: '=TEXT(ROUND(SUM(D:D),2),"#,##0.00")', label: "Total of This month", param: false },
      { kind: "text", text: " for " },
      { kind: "field", source: "period", label: "Period", param: true },
      { kind: "text", text: "." },
    ]);
    expect(hasFields("plain words")).toBe(false);
    expect(hasFields("{{period}}")).toBe(true);
  });
});

describe("fitting tables to the page", () => {
  const report = (cols: number, text = "Accumulated depreciation") => ({
    title: "T",
    subtitle: "",
    warnings: [],
    params: {},
    blocks: [{ kind: "table" as const, headers: Array.from({ length: cols }, (_, i) => `Column ${i}`), align: Array.from({ length: cols }, () => "left" as const), rows: [{ cells: Array.from({ length: cols }, () => text) }] }],
  });
  it("leaves a narrow table alone", () => {
    const f = fitPage([report(3)]);
    expect(f).toMatchObject({ landscape: false, auto: false, note: "" });
    expect(f.compact.size).toBe(0);
  });
  it("sets a wide table smaller, then turns the page, and says so", () => {
    const f = fitPage([report(5)]);
    expect(f.landscape).toBe(false);
    expect(f.compact.has("0:0")).toBe(true);
    const g = fitPage([report(7)]);
    expect(g).toMatchObject({ landscape: true, auto: true });
    expect(g.note).toMatch(/landscape/);
    expect(reportHtml([report(7)], g)).toContain("report-page--landscape");
    const h = fitPage([report(14)]);
    expect(h.squeezed.has("0:0")).toBe(true);
    expect(tableWidth(report(1).blocks[0])).toBeGreaterThan(0);
  });
  it("keeps a landscape page the user chose", () => {
    expect(fitPage([report(3)], { size: "A4", landscape: true })).toMatchObject({ landscape: true, auto: false });
  });
});
