import { describe, expect, it } from "vitest";
import { dateToSerial, pageLines, parseStatement, readPdfText, rowsToLines, type StatementLine } from "../src";
import { simplePdf, textContent } from "./pdfbuild";

/** Lines as a PDF would give them: [x, text] cells. */
const pdfLines = (page: number, rows: [number, string][][]): StatementLine[] =>
  rows.map((cells) => ({ page, cells: cells.map(([x, text]) => ({ x, x2: x + text.length * 5, text })) }));

describe("bank statements from CSV", () => {
  it("reads debit / credit / balance columns and checks every balance", () => {
    const s = parseStatement(
      rowsToLines([
        ["Account 12345678", "", "", "", ""],
        ["Date", "Description", "Debit", "Credit", "Balance"],
        ["01/03/2024", "Opening balance", "", "", "1,000.00"],
        ["02/03/2024", "Card payment TESCO", "45.20", "", "954.80"],
        ["15/03/2024", "Salary", "", "2,500.00", "3,454.80"],
        ["20/03/2024", "Rent", "1,200.00", "", "2,200.00"],
      ]),
    );
    expect(s.columns).toEqual(["date", "description", "debit", "credit", "balance"]);
    expect(s.opening).toBe(1000);
    expect(s.transactions.map((t) => [t.date, t.description, t.amount, t.balance, t.check])).toEqual([
      [dateToSerial(2024, 3, 2), "Card payment TESCO", -45.2, 954.8, "ok"],
      [dateToSerial(2024, 3, 15), "Salary", 2500, 3454.8, "ok"],
      [dateToSerial(2024, 3, 20), "Rent", -1200, 2200, "break"],
    ]);
    expect(s.transactions[2].expected).toBe(2254.8);
    expect(s.breaks).toBe(1);
  });

  it("works out the sign of an unsigned amount from the balances", () => {
    const s = parseStatement(
      rowsToLines([
        ["Date", "Details", "Amount", "Balance"],
        ["03/14/2024", "Deposit", "100.00", "600.00"],
        ["03/15/2024", "ATM", "50.00", "550.00"],
      ]),
    );
    expect(s.dateOrder).toBe("mdy");
    expect(s.opening).toBe(500);
    expect(s.transactions.map((t) => [t.amount, t.check, t.signFromBalance ?? false])).toEqual([
      [100, "ok", false],
      [-50, "ok", true],
    ]);
  });
});

describe("bank statements from PDF lines", () => {
  const header: [number, string][] = [[40, "Date"], [100, "Details"], [330, "Paid out"], [400, "Paid in"], [480, "Balance"]];
  it("merges wrapped descriptions, repairs year-less dates across the new year, and checks pages", () => {
    const lines = [
      ...pdfLines(1, [
        [[40, "Statement 1 December 2023 to 31 January 2024"]],
        header,
        [[100, "Balance brought forward"], [480, "500.00"]],
        [[40, "28 Dec"], [100, "Card payment"], [335, "20.00"], [480, "480.00"]],
        [[100, "COFFEE SHOP LONDON"]],
        [[40, "30 Dec"], [100, "Transfer from"], [480, "480.00"]].slice(0, 2) as [number, string][],
        [[100, "J SMITH"], [405, "100.00"], [480, "580.00"]],
        [[100, "Balance carried forward"], [480, "580.00"]],
      ]),
      ...pdfLines(2, [
        header,
        [[100, "Balance brought forward"], [480, "580.00"]],
        [[40, "2 Jan"], [100, "Direct debit GAS"], [335, "80.00"], [480, "500.00 CR"]],
        [[40, "3 Jan"], [100, "Fee"], [335, "600.00"], [480, "100.00 DR"]],
        [[100, "Closing balance"], [480, "100.00 DR"]],
      ]),
    ];
    const s = parseStatement(lines);
    expect(s.transactions.map((t) => [t.date, t.description, t.amount, t.balance, t.page, t.check])).toEqual([
      [dateToSerial(2023, 12, 28), "Card payment COFFEE SHOP LONDON", -20, 480, 1, "ok"],
      [dateToSerial(2023, 12, 30), "Transfer from J SMITH", 100, 580, 1, "ok"],
      [dateToSerial(2024, 1, 2), "Direct debit GAS", -80, 500, 2, "ok"],
      [dateToSerial(2024, 1, 3), "Fee", -600, -100, 2, "ok"],
    ]);
    expect(s.opening).toBe(500);
    expect(s.closing).toBe(-100);
    expect(s.closingMatches).toBe(true);
    expect(s.pages.map((p) => [p.page, p.opening, p.closing, p.transactions, p.breaks])).toEqual([
      [1, 500, 580, 2, 0],
      [2, 580, -100, 2, 0],
    ]);
  });

  it("reads a statement straight from a PDF", async () => {
    const content = textContent([
      [40, 60, "Date"], [100, 60, "Details"], [330, 60, "Paid out"], [400, 60, "Paid in"], [480, 60, "Balance"],
      [40, 80, "01/02/2024"], [100, 80, "Opening balance"], [480, 80, "1,000.00"],
      [40, 95, "05/02/2024"], [100, 95, "Card TESCO"], [345, 95, "12.50"], [480, 95, "987.50"],
      [40, 110, "06/02/2024"], [100, 110, "Refund"], [415, 110, "2.50"], [480, 110, "990.00"],
    ]);
    const pages = await readPdfText(simplePdf([content]));
    const lines = pages.flatMap((p, i) => pageLines(p).map((cells) => ({ page: i + 1, cells })));
    const s = parseStatement(lines);
    expect(s.transactions.map((t) => [t.description, t.amount, t.check])).toEqual([
      ["Card TESCO", -12.5, "ok"],
      ["Refund", 2.5, "ok"],
    ]);
  });
});
