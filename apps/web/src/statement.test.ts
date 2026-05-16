import { describe, expect, it } from "vitest";
import { parseStatement, rowsToLines, Table } from "@cellforge/core";
import { statementColumns } from "./statement";

describe("statement sheet", () => {
  it("lays out date, description, amount, balance, page and the balance check", () => {
    const s = parseStatement(
      rowsToLines([
        ["Date", "Details", "Money out", "Money in", "Balance"],
        ["01/03/2024", "Opening balance", "", "", "100.00"],
        ["02/03/2024", "Shop", "10.00", "", "90.00"],
        ["31/02/2024", "Odd date", "", "5.00", "99.00"],
      ]),
    );
    const { columns, numFmts } = statementColumns(s);
    const t = new Table(columns);
    expect(columns.map((c) => c.name)).toEqual(["Date", "Description", "Amount", "Balance", "Page", "Balance check", "Date as printed"]);
    expect([t.getCell(0, 2), t.getCell(0, 3), t.getCell(0, 5)]).toEqual([-10, 90, "ok"]);
    expect(t.getCell(1, 0)).toBe(null); // 31 February isn't a date
    expect(t.getCell(1, 6)).toBe("31/02/2024");
    expect(t.getCell(1, 5)).toBe("break: expected 95.00");
    expect(numFmts[0]).toBe("yyyy-mm-dd");
  });
});
