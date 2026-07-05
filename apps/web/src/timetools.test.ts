import { describe, expect, it } from "vitest";
import { dateToSerial, parseTyped, Table, type ColumnData } from "@cellforge/core";
import { rateTable } from "../../../packages/core/src/timeseries";
import { readSheet } from "./audittools";
import { EditableSource, parseInput } from "./editable";
import {
  bvaSheet,
  columnWrite,
  convertColumns,
  datesOf,
  DEFAULT_LAYOUT,
  fiscalColumns,
  guessBvaMap,
  guessJournalMap,
  guessRateMap,
  isDateColumn,
  journalExport,
  monthKey,
  parseDateInput,
  periodSheet,
  readRates,
  revalueSheet,
  scheduleSheets,
  toCsv,
} from "./timetools";

const D = (y: number, m: number, d: number) => dateToSerial(y, m, d);
const text = (name: string, values: (string | null)[]): ColumnData => {
  const dict: string[] = [];
  const codes = Uint32Array.from(values, (v) => {
    if (v === null) return 0;
    let i = dict.indexOf(v);
    if (i < 0) i = dict.push(v) - 1;
    return i + 1;
  });
  return { kind: "string", name, codes, dict };
};
const num = (name: string, values: (number | null)[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values, (v) => v ?? NaN) });
const sheet = (...cols: ColumnData[]) => new EditableSource(new Table(cols), 2);

/** What typing `input` into a cell stores (as cells.set does it). */
function typed(input: string | null): unknown {
  if (input === null) return null;
  const t = !input.trim().startsWith("=") && !input.startsWith("'") ? parseTyped(input) : null;
  return t ? t.value : parseInput(input);
}

describe("time tools: reading", () => {
  it("reads dates from serials and from text", () => {
    const src = sheet(text("When", ["31/01/2025", "2025-02-15", "nope", null]), num("Serial", [D(2025, 3, 1), null, null, null]), text("Due", ["2025-01-01", "2025-02-01", null, null]));
    const data = readSheet(src);
    expect(datesOf(data, 0)).toEqual([D(2025, 1, 31), D(2025, 2, 15), null, null]);
    expect(isDateColumn(data, 0)).toBe(false); // only 2 of 3 read as dates
    expect(isDateColumn(data, 2)).toBe(true);
    expect(datesOf(data, 1)[0]).toBe(D(2025, 3, 1));
  });

  it("writes periods as year-month however they're typed", () => {
    expect(monthKey(D(2025, 1, 31))).toBe("2025-01");
    expect(monthKey("2025-1")).toBe("2025-01");
    expect(monthKey("01/2025")).toBe("2025-01");
    expect(monthKey("Jan 2025")).toBe("2025-01");
    expect(monthKey("September-25")).toBe("2025-09");
    expect(monthKey("15/03/2025")).toBe("2025-03");
    expect(monthKey(202504)).toBe("2025-04");
    expect(monthKey(7)).toBe("7");
    expect(monthKey("Q1")).toBe("Q1");
    expect(monthKey(null)).toBe("");
  });

  it("parses typed dates", () => {
    expect(parseDateInput("2025-01-31")).toBe(D(2025, 1, 31));
    expect(parseDateInput("31/01/2025")).toBe(D(2025, 1, 31));
    expect(parseDateInput("01/31/2025")).toBe(D(2025, 1, 31));
    expect(parseDateInput("")).toBeNull();
    expect(parseDateInput("soon")).toBeNull();
  });
});

describe("fiscal columns", () => {
  it("adds year, quarter, period and label columns that type back as values", () => {
    const r = fiscalColumns([D(2024, 7, 1), null, D(2025, 6, 30)], { yearStartMonth: 7 }, { year: true, quarter: true, period: true, label: true });
    expect(r.bad).toBe(1);
    expect(r.cols.map((c) => c.name)).toEqual(["Fiscal year", "Fiscal quarter", "Fiscal period", "Fiscal label"]);
    expect(r.cols[0].values).toEqual([2025, null, 2025]);
    expect(r.cols[2].values).toEqual([1, null, 12]);
    expect(r.cols[3].values).toEqual(["FY2025 P01", null, "FY2025 P12"]);
  });

  it("counts the cells it would overwrite unless it inserts", () => {
    const src = sheet(text("Date", ["2025-01-15", "2025-02-15"]), text("Note", ["x", null]));
    const data = readSheet(src);
    expect(data.first).toBe(0); // named columns: no header row in the cells
    const r = fiscalColumns(datesOf(data, 0), {}, { year: true, quarter: false, period: true, label: false });
    const ins = columnWrite(src, data, 1, [0, 1], r.cols, true);
    expect(ins).toMatchObject({ overwrite: 0, columns: 2, insert: true, at: 1 });
    expect(ins.cells).toHaveLength(4);
    const over = columnWrite(src, data, 1, [0, 1], r.cols, false);
    expect(over.overwrite).toBe(1);
  });

  it("writes a header into the first row when the sheet has one", () => {
    const src = new EditableSource(new Table([num("", [null, D(2025, 1, 15), D(2025, 5, 2)])]), 2);
    src.setCell(0, 0, "Date");
    const data = readSheet(src);
    expect(data.first).toBe(1);
    const r = fiscalColumns(datesOf(data, 0), { yearStartMonth: 4 }, { year: true, quarter: true, period: false, label: false });
    const w = columnWrite(src, data, 1, [0, 1], r.cols, true);
    expect(w.cells.find((c) => c.row === 0 && c.col === 1)?.input).toBe("'Fiscal year");
    expect(typed(w.cells.find((c) => c.row === 1 && c.col === 1)!.input)).toBe(2025);
    expect(typed(w.cells.find((c) => c.row === 2 && c.col === 1)!.input)).toBe(2026);
    expect(typed(w.cells.find((c) => c.row === 2 && c.col === 2)!.input)).toBe(1);
    expect(w.preview[0]).toEqual(["B: Fiscal year", "C: Fiscal quarter"]);
  });
});

describe("period comparison sheet", () => {
  const src = sheet(num("Date", [D(2024, 1, 5), D(2024, 2, 5), D(2025, 1, 9), D(2025, 2, 9)]), num("Amount", [100, 200, 150, 100]), text("Entity", ["UK", "UK", "UK", "US"]));
  src.styles.apply(0, "all", { numFmt: "yyyy-mm-dd" });
  const data = readSheet(src);

  it("lays out MoM, YoY, YTD and rolling columns", () => {
    const out = periodSheet(data, "Sales", 0, 1, -1, "month", {}, 3);
    expect(out.header).toEqual(["Period", "Start", "End", "Rows", "Amount", "Previous month", "MoM change", "MoM %", "Same period last year", "YoY change", "YoY %", "YTD", "QTD", "Rolling 3 sum", "Rolling 3 average"]);
    expect(out.rows).toHaveLength(14);
    expect(out.rows[12].slice(0, 1)).toEqual(["Jan 2025"]);
    expect(out.rows[12][8]).toBe(100); // last year
    expect(out.rows[12][9]).toBe(50);
    expect(out.rows[13][9]).toBe(-100);
    expect(out.name).toBe("Sales by month");
  });

  it("drops QTD and YoY where they don't apply and splits by group", () => {
    const y = periodSheet(data, "Sales", 0, 1, 2, "year", {}, 0);
    expect(y.header).toEqual(["Entity", "Period", "Start", "End", "Rows", "Amount", "Previous year", "YoY change", "YoY %", "YTD"]);
    expect(y.rows.map((r) => [r[0], r[1], r[5]])).toEqual([
      ["UK", "2024", 300],
      ["UK", "2025", 150],
      ["US", "2025", 100],
    ]);
  });
});

describe("budget vs actual sheet", () => {
  it("matches by account and month and adds a total row", () => {
    const actual = readSheet(sheet(text("Account", ["Sales", "Rent", "Travel"]), num("Date", [D(2025, 1, 15), D(2025, 1, 31), D(2025, 1, 20)]), num("Amount", [1200, 600, 40])));
    const budget = readSheet(sheet(text("Account", ["Sales", "Rent"]), text("Month", ["Jan 2025", "2025-01"]), text("Type", ["Revenue", "Expense"]), num("Budget", [1000, 550])));
    const ma = guessBvaMap(actual);
    const mb = guessBvaMap(budget);
    expect(ma).toMatchObject({ account: 0, period: 1, amount: 2, centre: -1, type: -1 });
    expect(mb).toMatchObject({ account: 0, period: 1, type: 2, amount: 3 });
    const out = bvaSheet(actual, budget, ma, mb, "natural", "BvA");
    expect(out.header).toEqual(["Account", "Period", "Account type", "Actual", "Budget", "Variance", "Variance %", "Favourable?", "Note"]);
    expect(out.rows[0]).toEqual(["Sales", "2025-01", "Revenue", 1200, 1000, 200, 0.2, "Favourable", ""]);
    expect(out.rows[1].slice(5, 9)).toEqual([50, 50 / 550, "Unfavourable", ""]);
    expect(out.rows[2].slice(0, 1)).toEqual(["Travel"]);
    expect(out.rows[2][8]).toBe("Not in the budget");
    expect(out.rows[3].slice(0, 6)).toEqual(["Total", null, null, 1840, 1550, 290]);
  });
});

describe("currency", () => {
  const rates = readSheet(sheet(num("Date", [D(2025, 1, 1), D(2025, 1, 1)]), text("From", ["EUR", "GBP"]), text("To", ["USD", "USD"]), num("Rate", [1.1, 1.25])));

  it("reads a rates sheet with or without a To column", () => {
    const map = guessRateMap(rates);
    expect(map).toEqual({ date: 0, from: 1, to: 2, rate: 3 });
    expect(readRates(rates, map)).toHaveLength(2);
    const noTo = readRates(rates, { ...map, to: -1 }, "USD", "from-other");
    expect(noTo[0]).toMatchObject({ from: "USD", to: "EUR", rate: 1.1 });
  });

  it("converts each row and leaves missing rates blank", () => {
    const table = rateTable(readRates(rates, guessRateMap(rates)));
    const data = readSheet(sheet(num("Amount", [100, 200, 5]), text("Ccy", ["EUR", "GBP", "CHF"]), num("Date", [D(2025, 1, 2), D(2025, 1, 2), D(2025, 1, 2)])));
    const r = convertColumns(table, data, [0, 1, 2], { amountCol: 0, currencyCol: 1, currency: "", dateCol: 2, date: null, to: "eur", decimals: 2 });
    expect(r.cols.map((c) => c.name)).toEqual(["Rate to EUR", "Amount in EUR", "Rate date"]);
    expect(r.cols[1].values).toEqual([100, 227.27, null]);
    expect(r.missing).toBe(1);
  });

  it("revalues balances with a total gain or loss", () => {
    const table = rateTable(readRates(rates, guessRateMap(rates)));
    const data = readSheet(sheet(text("Account", ["EUR bank", "GBP loan"]), text("Currency", ["EUR", "GBP"]), num("Foreign amount", [1000, -400]), num("Booked USD", [1050, -480])));
    const out = revalueSheet(table, data, { label: 0, currency: 1, amount: 2, booked: 3 }, D(2025, 1, 31), "usd", "Reval");
    expect(out.rows[0].slice(6, 9)).toEqual([1100, 50, "Gain"]);
    expect(out.rows[1].slice(6, 9)).toEqual([-500, -20, "Loss"]);
    expect(out.gainLoss).toBe(30);
    expect(out.header[3]).toBe("Booked USD");
  });
});

describe("schedule sheets", () => {
  it("makes a schedule with a total and a balanced journal", () => {
    const out = scheduleSheets({ kind: "prepayment", amount: 1000, start: D(2025, 1, 1), end: D(2025, 3, 31), debitAccount: "Insurance", creditAccount: "Prepayments" }, "Insurance");
    expect(out.schedule.name).toBe("Insurance schedule");
    expect(out.schedule.rows.map((r) => r[5])).toEqual([333.33, 333.33, 333.34, 1000]);
    expect(out.schedule.rows[0].slice(4, 7)).toEqual([1000, 333.33, 666.67]);
    expect(out.journal.rows).toHaveLength(6);
    expect(out.journal.rows[0]).toEqual([1, D(2025, 1, 31), "Insurance", "Prepayment release 2025-01 (1 of 3)", 333.33, null]);
  });
});

describe("journal export", () => {
  it("maps a schedule journal into the import layout and CSV", () => {
    const j = scheduleSheets({ kind: "accrual", amount: 300, start: D(2025, 1, 1), end: D(2025, 3, 31), debitAccount: "Audit, fees", creditAccount: "Accruals" }, "Audit").journal;
    const src = sheet(num("Entry", j.rows.map((r) => r[0] as number)), num("Date", j.rows.map((r) => r[1] as number)), text("Account", j.rows.map((r) => r[2] as string)), text("Description", j.rows.map((r) => r[3] as string)), num("Debit", j.rows.map((r) => r[4] as number | null)), num("Credit", j.rows.map((r) => r[5] as number | null)));
    const data = readSheet(src);
    const map = guessJournalMap(data);
    expect(map).toEqual({ debit: 4, credit: 5, date: 1, account: 2, description: 3, reference: 0, amount: -1 });
    const out = journalExport(data, map, { ...DEFAULT_LAYOUT, dateStyle: "dd/mm/yyyy", reference: true });
    expect(out.header).toEqual(["Date", "Account", "Description", "Debit", "Credit", "Reference"]);
    expect(out.rows[0]).toEqual(["31/01/2025", "Audit, fees", "Accrual 2025-01 (1 of 3)", "100.00", "", "1"]);
    expect(out.rows[1][3]).toBe("");
    expect(out.rows[1][4]).toBe("100.00");
    expect(out).toMatchObject({ debit: 300, credit: 300, unbalanced: [], skipped: 0 });
    const csv = toCsv(out.header, out.rows.slice(0, 1));
    expect(csv).toBe('Date,Account,Description,Debit,Credit,Reference\r\n31/01/2025,"Audit, fees",Accrual 2025-01 (1 of 3),100.00,,1\r\n');
  });

  it("writes one signed amount and flags entries that don't balance", () => {
    const data = readSheet(sheet(text("Date", ["2025-01-31", "2025-01-31", "2025-02-28", null]), text("Account", ["Cash", "Sales", "Cash", null]), num("Amount", [100, -90, 50, null])));
    const map = guessJournalMap(data);
    expect(map.amount).toBe(2);
    const out = journalExport(data, map, { ...DEFAULT_LAYOUT, amounts: "signed" });
    expect(out.header).toEqual(["Date", "Account", "Description", "Amount"]);
    expect(out.rows.map((r) => r[3])).toEqual(["100.00", "-90.00", "50.00"]);
    expect(out.skipped).toBe(1);
    expect(out.unbalanced).toEqual(["2025-01-31", "2025-02-28"]);
    expect(toCsv(["a"], [[' x"y ']])).toBe('a\r\n" x""y "\r\n');
  });
});
