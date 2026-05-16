import { describe, expect, it } from "vitest";
import { dateToSerial, parseDateLoose, parseNumberLoose, profileColumn, unwrapReport } from "../src";

describe("messy values", () => {
  it.each([
    ["1,234.50", 1234.5],
    ["(1,234.50)", -1234.5],
    ["1,234.50-", -1234.5],
    ["$ 1,234.50", 1234.5],
    ["-$12.00", -12],
    ["$-12.00", -12],
    ["1234.5 USD", 1234.5],
    ["500.00 CR", -500],
    ["500.00 DR", 500],
    ["12.5%", 0.125],
    ["1 234 567", 1234567],
    ["abc", null],
    ["", null],
  ])("%s -> %s", (raw, want) => {
    expect(parseNumberLoose(raw as string)).toBe(want);
  });

  it("decimal commas", () => {
    expect(parseNumberLoose("1.234,56", "comma")).toBe(1234.56);
    expect(parseNumberLoose("€ 12,5", "comma")).toBe(12.5);
    expect(parseNumberLoose("1'234.50")).toBe(1234.5);
  });

  it.each([
    ["2024-01-15", "dmy", 45306],
    ["15/01/2024", "dmy", 45306],
    ["01/15/2024", "mdy", 45306],
    ["15.01.2024", "dmy", 45306],
    ["15-Jan-2024", "dmy", 45306],
    ["Jan 15, 2024", "dmy", 45306],
    ["20240115", "dmy", 45306],
    ["15/01/24", "dmy", 45306],
    ["2024-01-15T12:00:00Z", "dmy", 45306.5],
    ["31/02/2024", "dmy", null],
  ])("%s (%s) -> %s", (raw, order, want) => {
    expect(parseDateLoose(raw, order as "dmy")).toBe(want);
  });

  it("profiles a column: type, separators, day/month order, misfits", () => {
    const d = profileColumn(["03/04/2024", "25/04/2024", "", "n/a", "01/05/2024"]);
    expect(d.type).toBe("date");
    expect(d.dateOrder).toBe("dmy"); // 25/04 only fits day-first
    expect(d.misfits).toEqual([{ row: 3, value: "n/a" }]);
    expect(d.confidence).toBe(0.75);
    const us = profileColumn(["04/03/2024", "04/25/2024"]);
    expect(us.dateOrder).toBe("mdy");
    const eu = profileColumn(["1.234,56", "12,5", "(3,00)"]);
    expect(eu).toMatchObject({ type: "number", numberStyle: "comma", confidence: 1 });
    expect(profileColumn(["North", "South", "12"]).type).toBe("text");
    expect(dateToSerial(2024, 4, 3)).toBe(parseDateLoose("03/04/2024", "dmy"));
  });
});

describe("report un-wrapping", () => {
  it("finds the header, drops non-data rows, fills down groups, flattens headers", () => {
    const report = [
      ["ACME Ltd — Sales by region", "", "", ""],
      ["Period: January 2024", "", "", ""],
      ["", "", "", ""],
      ["Region", "Rep", "Revenue", ""],
      ["", "", "Q1", "Q2"],
      ["North", "Ann", "100", "120"],
      ["", "Bob", "80", "90"],
      ["Subtotal North", "", "180", "210"],
      ["South", "Cid", "50", "60"],
      ["Page 1 of 2", "", "", ""],
      ["Region", "Rep", "Revenue", ""],
      ["", "Dee", "70", "75"],
      ["Grand total", "", "300", "345"],
    ];
    const u = unwrapReport(report);
    expect(u.headerRow).toBe(3);
    expect(u.header).toEqual(["Region", "Rep", "Revenue Q1", "Revenue Q2"]);
    expect(u.rows).toEqual([
      ["North", "Ann", "100", "120"],
      ["North", "Bob", "80", "90"],
      ["South", "Cid", "50", "60"],
      ["South", "Dee", "70", "75"],
    ]);
    expect(u.filledDown).toEqual([0]);
    expect(u.dropped.map((d) => d.reason)).toEqual(["title", "title", "total", "footer", "repeated header", "total"]);
    expect(u.sourceRows).toEqual([5, 6, 8, 11]);
  });
});
