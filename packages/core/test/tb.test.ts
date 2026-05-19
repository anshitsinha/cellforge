import { describe, expect, it } from "vitest";
import { buildTb, guessTbRoles, readTb } from "../src";

describe("trial balance import", () => {
  it("reads a debit / credit layout with a title and a total row", () => {
    const text = [
      ["ACME Ltd", "", "", ""],
      ["Trial balance as at 31 March 2024", "", "", ""],
      ["", "", "", ""],
      ["Account Code", "Account Name", "Debit", "Credit"],
      ["1000", "Cash at bank", "5,000.00", ""],
      ["2000", "Trade creditors", "", "3,000.00"],
      ["4000", "Sales", "", "12,000.00"],
      ["5000", "Purchases", "10,000.00", ""],
      ["Total", "", "15,000.00", "15,000.00"],
    ];
    const { rows, roles } = readTb(text);
    expect(roles).toEqual(["code", "name", "debit", "credit"]);
    const tb = buildTb(rows, roles);
    expect(tb.lines.map((l) => [l.code, l.name, l.current])).toEqual([
      ["1000", "Cash at bank", 5000],
      ["2000", "Trade creditors", -3000],
      ["4000", "Sales", -12000],
      ["5000", "Purchases", 10000],
    ]);
    expect(tb.balances).toBe(true);
    expect(tb.priorBalances).toBe(null);
  });

  it("reads signed balances for two years, the earlier year as prior", () => {
    const header = ["Nominal", "Description", "2023", "2024"];
    const rows = [
      ["1000", "Bank", "100", "250"],
      ["3000", "Capital", "(100)", "250 CR"],
    ];
    const roles = guessTbRoles(header, rows);
    expect(roles).toEqual(["code", "name", "prior balance", "balance"]);
    const tb = buildTb(rows, roles);
    expect(tb.lines.map((l) => [l.current, l.prior])).toEqual([
      [250, 100],
      [-250, -100],
    ]);
    expect([tb.balances, tb.priorBalances]).toEqual([true, true]);
  });

  it("pairs a second debit / credit pair as prior, and splits '1000 Cash' into code and name", () => {
    const header = ["Account", "Debit", "Credit", "Debit", "Credit"];
    const rows = [
      ["1000 - Cash", "50", "", "40", ""],
      ["4000 - Sales", "", "60", "", "40"],
      ["5000 - Costs", "10", "", "", ""],
    ];
    const roles = guessTbRoles(header, rows);
    expect(roles).toEqual(["code+name", "debit", "credit", "prior debit", "prior credit"]);
    const tb = buildTb(rows, roles);
    expect(tb.lines.map((l) => [l.code, l.name, l.current, l.prior])).toEqual([
      ["1000", "Cash", 50, 40],
      ["4000", "Sales", -60, -40],
      ["5000", "Costs", 10, 0],
    ]);
  });

  it("flags a trial balance that doesn't balance, duplicate codes and bad numbers", () => {
    const tb = buildTb(
      [
        ["1000", "Bank", "100", ""],
        ["1000", "Bank again", "", "50"],
        ["2000", "Loan", "", "4O"],
      ],
      ["code", "name", "debit", "credit"],
    );
    expect(tb.balances).toBe(false);
    expect(tb.totalCurrent).toBe(50);
    expect(tb.duplicates).toEqual(["1000"]);
    expect(tb.bad).toEqual([{ row: 2, col: 3, value: "4O" }]);
  });
});
