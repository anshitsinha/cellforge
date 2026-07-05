import { describe, expect, it } from "vitest";
import {
  accountKind,
  budgetVsActual,
  buildSchedule,
  convertAmounts,
  fiscalPeriod,
  journalBalance,
  monthsSpanned,
  periodBucket,
  periodSummary,
  rateTable,
  revalue,
  roundTo,
  weekYearEnd,
} from "../src/timeseries";
import { dateToSerial, serialToParts } from "../src/numfmt";

const D = (y: number, m: number, d: number) => dateToSerial(y, m, d);
const iso = (s: number) => {
  const p = serialToParts(s);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

describe("fiscalPeriod: calendar months", () => {
  it("is the calendar year with a January start", () => {
    const f = fiscalPeriod(D(2025, 3, 15));
    expect(f).toMatchObject({ fiscalYear: 2025, quarter: 1, period: 3, label: "FY2025 P03" });
    expect(iso(f.start)).toBe("2025-03-01");
    expect(iso(f.end)).toBe("2025-03-31");
    expect(iso(f.yearStart)).toBe("2025-01-01");
    expect(iso(f.yearEnd)).toBe("2025-12-31");
  });

  it("names a July year by the year it ends in, or starts in", () => {
    const opts = { yearStartMonth: 7 };
    expect(fiscalPeriod(D(2024, 7, 1), opts)).toMatchObject({ fiscalYear: 2025, quarter: 1, period: 1 });
    expect(fiscalPeriod(D(2025, 6, 30), opts)).toMatchObject({ fiscalYear: 2025, quarter: 4, period: 12 });
    expect(fiscalPeriod(D(2024, 12, 31), opts)).toMatchObject({ fiscalYear: 2025, quarter: 2, period: 6 });
    expect(fiscalPeriod(D(2024, 12, 31), { ...opts, yearNamedBy: "start" })).toMatchObject({ fiscalYear: 2024, period: 6 });
    const f = fiscalPeriod(D(2025, 2, 10), opts);
    expect(iso(f.yearStart)).toBe("2024-07-01");
    expect(iso(f.yearEnd)).toBe("2025-06-30");
    expect(iso(f.end)).toBe("2025-02-28");
  });

  it("handles an April start (UK) and the time of day", () => {
    expect(fiscalPeriod(D(2025, 4, 5) + 0.75, { yearStartMonth: 4 })).toMatchObject({ fiscalYear: 2026, period: 1, quarter: 1 });
    expect(fiscalPeriod(D(2025, 3, 31), { yearStartMonth: 4 })).toMatchObject({ fiscalYear: 2025, period: 12, quarter: 4 });
  });

  it("rejects a bad start month", () => {
    expect(() => fiscalPeriod(D(2025, 1, 1), { yearStartMonth: 13 })).toThrow(/1 to 12/);
  });
});

describe("fiscalPeriod: 4-4-5 week calendars", () => {
  it("ends the year on the last Saturday of the end month", () => {
    // last Saturday of December 2024 is the 28th
    expect(iso(weekYearEnd(2024, 12))).toBe("2024-12-28");
    // nearest Saturday to 31 Dec 2025 (a Wednesday) is 3 Jan 2026
    expect(iso(weekYearEnd(2025, 12, { yearEnd: "nearest" }))).toBe("2026-01-03");
    expect(iso(weekYearEnd(2025, 12, { yearEnd: "last" }))).toBe("2025-12-27");
  });

  it("splits a 52-week year 4-4-5", () => {
    const opts = { weeks: "4-4-5" as const };
    // FY2025 runs 29 Dec 2024 - 27 Dec 2025
    const first = fiscalPeriod(D(2024, 12, 29), opts);
    expect(first).toMatchObject({ fiscalYear: 2025, period: 1, quarter: 1, week: 1 });
    expect(iso(first.yearStart)).toBe("2024-12-29");
    expect(iso(first.yearEnd)).toBe("2025-12-27");
    expect(iso(first.end)).toBe("2025-01-25");
    const p3 = fiscalPeriod(D(2025, 3, 1), opts); // week 9: third period (5 weeks)
    expect(p3).toMatchObject({ period: 3, quarter: 1, week: 9 });
    expect(p3.end - p3.start + 1).toBe(35);
    expect(fiscalPeriod(D(2025, 3, 30), opts)).toMatchObject({ period: 4, quarter: 2, week: 14 });
    expect(fiscalPeriod(D(2025, 12, 27), opts)).toMatchObject({ fiscalYear: 2025, period: 12, week: 52 });
    expect(fiscalPeriod(D(2025, 12, 28), opts)).toMatchObject({ fiscalYear: 2026, period: 1, week: 1 });
  });

  it("puts a 53rd week in the last period", () => {
    const opts = { weeks: "4-4-5" as const, yearEnd: "nearest" as const };
    // FY2025 with "nearest": 29 Dec 2024 - 3 Jan 2026 = 53 weeks
    const f = fiscalPeriod(D(2026, 1, 2), opts);
    expect(f).toMatchObject({ fiscalYear: 2025, period: 12, week: 53 });
    expect(f.end - f.start + 1).toBe(42);
    expect(iso(f.yearEnd)).toBe("2026-01-03");
  });

  it("follows the 5-4-4 pattern and a July start", () => {
    const opts = { weeks: "5-4-4" as const, yearStartMonth: 7 };
    // year ends on the last Saturday of June 2025 (the 28th); starts 30 Jun 2024 (after 29 Jun 2024)
    const f = fiscalPeriod(D(2024, 8, 3), opts); // week 5
    expect(iso(f.yearStart)).toBe("2024-06-30");
    expect(f).toMatchObject({ fiscalYear: 2025, period: 1, week: 5 });
    expect(fiscalPeriod(D(2024, 8, 4), opts)).toMatchObject({ period: 2, week: 6 });
  });
});

describe("periodBucket", () => {
  it("buckets by ISO week, month, quarter and year", () => {
    const w = periodBucket(D(2025, 1, 1), "week");
    expect(w.label).toBe("2025-W01");
    expect(iso(w.start)).toBe("2024-12-30");
    expect(periodBucket(D(2021, 1, 3), "week").label).toBe("2020-W53");
    expect(periodBucket(D(2025, 5, 20), "month")).toMatchObject({ label: "May 2025", index: 5, quarter: 2, year: 2025 });
    expect(periodBucket(D(2025, 5, 20), "quarter")).toMatchObject({ label: "Q2 2025", index: 2 });
    expect(iso(periodBucket(D(2025, 5, 20), "quarter").end)).toBe("2025-06-30");
    expect(periodBucket(D(2025, 5, 20), "year").label).toBe("2025");
  });

  it("buckets by fiscal quarter and year", () => {
    const q = periodBucket(D(2025, 5, 20), "fiscal-quarter", { yearStartMonth: 4 });
    expect(q).toMatchObject({ label: "FY2026 Q1", year: 2026, index: 1 });
    expect(iso(q.start)).toBe("2025-04-01");
    expect(iso(q.end)).toBe("2025-06-30");
    const y = periodBucket(D(2025, 5, 20), "fiscal-year", { yearStartMonth: 4 });
    expect(y.label).toBe("FY2026");
    expect(iso(y.end)).toBe("2026-03-31");
    const wq = periodBucket(D(2025, 3, 1), "fiscal-quarter", { weeks: "4-4-5" });
    expect(wq.end - wq.start + 1).toBe(91);
  });
});

describe("periodSummary", () => {
  const dates = [D(2024, 1, 5), D(2024, 1, 20), D(2024, 2, 3), D(2024, 4, 9), D(2025, 1, 15), D(2025, 2, 1)];
  const values = [100, 50, 200, 80, 300, 100];

  it("totals by month, fills empty months, and compares", () => {
    const r = periodSummary(dates, values, { grain: "month", rolling: 3 });
    expect(r.rows.map((x) => x.label).slice(0, 4)).toEqual(["Jan 2024", "Feb 2024", "Mar 2024", "Apr 2024"]);
    expect(r.rows).toHaveLength(14); // Jan 2024 .. Feb 2025
    const [jan, feb, mar, apr] = r.rows;
    expect(jan).toMatchObject({ sum: 150, count: 2, prior: null, change: null, ytd: 150, qtd: 150, rollingSum: null });
    expect(feb).toMatchObject({ sum: 200, prior: 150, change: 50, ytd: 350, qtd: 350 });
    expect(feb.changePct).toBeCloseTo(1 / 3);
    expect(mar).toMatchObject({ sum: 0, count: 0, change: -200, changePct: -1, rollingSum: 350 });
    expect(mar.rollingAvg).toBeCloseTo(350 / 3);
    expect(apr).toMatchObject({ sum: 80, prior: 0, change: 80, changePct: null, qtd: 80, ytd: 430 });
    const jan25 = r.rows[12];
    expect(jan25).toMatchObject({ label: "Jan 2025", sum: 300, lastYear: 150, yoyChange: 150, yoyPct: 1, ytd: 300 });
    const feb25 = r.rows[13];
    expect(feb25).toMatchObject({ lastYear: 200, yoyChange: -100, yoyPct: -0.5, ytd: 400 });
  });

  it("works by quarter and year with no QTD", () => {
    const q = periodSummary(dates, values, { grain: "quarter", rolling: 0 });
    expect(q.rows.map((x) => [x.label, x.sum])).toEqual([
      ["Q1 2024", 350],
      ["Q2 2024", 80],
      ["Q3 2024", 0],
      ["Q4 2024", 0],
      ["Q1 2025", 400],
    ]);
    expect(q.rows[4]).toMatchObject({ lastYear: 350, yoyChange: 50, qtd: null, rollingSum: null });
    const y = periodSummary(dates, values, { grain: "year" });
    expect(y.rows.map((x) => x.sum)).toEqual([430, 400]);
    expect(y.rows[1]).toMatchObject({ prior: 430, lastYear: 430, change: -30 });
  });

  it("restarts YTD at the fiscal year", () => {
    const r = periodSummary([D(2024, 6, 10), D(2024, 7, 10), D(2024, 8, 10)], [10, 20, 30], { grain: "fiscal-period", fiscal: { yearStartMonth: 7 } });
    expect(r.rows.map((x) => [x.label, x.ytd])).toEqual([
      ["FY2024 P12", 10],
      ["FY2025 P01", 20],
      ["FY2025 P02", 50],
    ]);
  });

  it("runs each group separately and counts bad rows", () => {
    const r = periodSummary([D(2024, 1, 1), D(2024, 1, 2), D(2024, 3, 1), "not a date", D(2024, 2, 1), null], [1, 2, 3, 4, "x", 5], {
      grain: "month",
      groups: ["B", "A", "A", "A", "B", "B"],
    });
    expect(r.badDates).toBe(1);
    expect(r.badValues).toBe(1);
    expect(r.rows.map((x) => `${x.group} ${x.label} ${x.sum}`)).toEqual(["A Jan 2024 2", "A Feb 2024 0", "A Mar 2024 3", "B Jan 2024 1", "B Feb 2024 0"]);
  });

  it("adds without floating-point dust", () => {
    const r = periodSummary([D(2024, 1, 1), D(2024, 1, 2)], [0.1, 0.2], { grain: "month" });
    expect(r.rows[0].sum).toBe(0.3);
  });

  it("refuses far too many periods", () => {
    expect(() => periodSummary([D(1900, 3, 1), D(2199, 1, 1)], [1, 1], { grain: "day" })).toThrow(/periods/);
  });
});

describe("budgetVsActual", () => {
  it("matches keys, adds up lines and flags favourable by account kind", () => {
    const actual = [
      { keys: ["Sales", "UK", "2025-01"], amount: 1200, type: "Revenue" },
      { keys: ["Rent", "UK", "2025-01"], amount: 500, type: "Expense" },
      { keys: ["rent ", "uk", "2025-01"], amount: 100 },
      { keys: ["Travel", "UK", "2025-01"], amount: 40 },
    ];
    const budget = [
      { keys: ["Sales", "UK", "2025-01"], amount: 1000 },
      { keys: ["Rent", "UK", "2025-01"], amount: 550 },
      { keys: ["Marketing", "UK", "2025-01"], amount: 300 },
    ];
    const r = budgetVsActual(actual, budget);
    const by = Object.fromEntries(r.rows.map((x) => [x.keys[0], x]));
    expect(by.Sales).toMatchObject({ actual: 1200, budget: 1000, variance: 200, variancePct: 0.2, favourable: true, kind: "income", status: "both" });
    expect(by.Rent).toMatchObject({ actual: 600, budget: 550, variance: 50, favourable: false, kind: "expense", type: "Expense" });
    expect(by.Travel).toMatchObject({ status: "actual only", budget: 0, variancePct: null, favourable: false });
    expect(by.Marketing).toMatchObject({ status: "budget only", actual: 0, variance: -300, favourable: true });
    expect(r.totals).toMatchObject({ actual: 1840, budget: 1850, variance: -10, both: 2, actualOnly: 1, budgetOnly: 1, favourable: 2, unfavourable: 2 });
  });

  it("uses ledger signs when asked", () => {
    const r = budgetVsActual([{ keys: ["4000"], amount: -1200 }], [{ keys: ["4000"], amount: -1000 }], { sign: "debit-positive" });
    expect(r.rows[0]).toMatchObject({ variance: -200, favourable: true, variancePct: -0.2 });
  });

  it("leaves favourable blank when it can't tell or there's no variance", () => {
    const r = budgetVsActual(
      [
        { keys: ["Widget"], amount: 10 },
        { keys: ["Sales"], amount: 5 },
      ],
      [
        { keys: ["Widget"], amount: 5 },
        { keys: ["Sales"], amount: 5 },
      ],
    );
    expect(r.rows.map((x) => x.favourable)).toEqual([null, null]);
  });

  it("tells income from expense", () => {
    expect(accountKind("Sales and marketing expense")).toBe("expense");
    expect(accountKind("Cost of sales")).toBe("expense");
    expect(accountKind("Interest received")).toBe("income");
    expect(accountKind("Turnover")).toBe("income");
    expect(accountKind("Salaries")).toBe("expense");
    expect(accountKind("Suspense")).toBeNull();
  });
});

describe("currency", () => {
  const rows = [
    { date: D(2025, 1, 1), from: "EUR", to: "USD", rate: 1.1 },
    { date: D(2025, 1, 10), from: "eur", to: "usd", rate: 1.2 },
    { date: D(2025, 1, 5), from: "USD", to: "JPY", rate: 150 },
    { date: D(2025, 1, 8), from: "GBP", to: "USD", rate: 1.25 },
    { date: D(2025, 1, 1), from: "XXX", to: "USD", rate: -1 },
  ];
  const t = rateTable(rows);

  it("finds the latest rate on or before the date", () => {
    expect(t.rate(D(2025, 1, 9), "EUR", "USD")).toEqual({ rate: 1.1, date: D(2025, 1, 1), how: "direct" });
    expect(t.rate(D(2025, 1, 10), "EUR", "USD")?.rate).toBe(1.2);
    expect(t.rate(D(2025, 2, 1) + 0.5, "EUR", "USD")?.rate).toBe(1.2);
    expect(t.rate(D(2024, 12, 31), "EUR", "USD")).toBeNull();
    expect(t.rate(D(2024, 12, 31), "eur", "EUR")).toMatchObject({ rate: 1, how: "same" });
    expect(t.skipped).toBe(1);
    expect(t.currencies).toEqual(["EUR", "GBP", "JPY", "USD"]);
  });

  it("inverts and triangulates through the base", () => {
    const inv = t.rate(D(2025, 1, 10), "USD", "EUR")!;
    expect(inv.how).toBe("inverse");
    expect(inv.rate).toBeCloseTo(1 / 1.2);
    const tri = t.rate(D(2025, 1, 10), "GBP", "EUR")!;
    expect(tri.how).toBe("via base");
    expect(tri.rate).toBeCloseTo(1.25 / 1.2);
    expect(tri.date).toBe(D(2025, 1, 8));
    expect(t.rate(D(2025, 1, 6), "GBP", "JPY")).toBeNull(); // no GBP rate yet
    expect(t.rate(D(2025, 1, 9), "GBP", "JPY")?.rate).toBeCloseTo(187.5);
  });

  it("rejects stale rates", () => {
    const fresh = rateTable(rows, { maxAgeDays: 5 });
    expect(fresh.rate(D(2025, 1, 9), "EUR", "USD")).toBeNull();
    expect(fresh.rate(D(2025, 1, 12), "EUR", "USD")?.rate).toBe(1.2);
  });

  it("converts amounts row by row", () => {
    const r = convertAmounts(t, [100, null, 10, 5], ["EUR", "EUR", "CHF", "USD"], [D(2025, 1, 2), D(2025, 1, 2), D(2025, 1, 2), D(2025, 1, 2)], "USD");
    expect(r.values).toEqual([110, null, null, 5]);
    expect(r.missing).toBe(1);
    expect(r.how).toEqual(["direct", "direct", null, "same"]);
  });

  it("revalues balances at the closing rate", () => {
    const r = revalue(
      t,
      [
        { label: "EUR bank", currency: "EUR", amount: 1000, booked: 1100 },
        { label: "EUR payable", currency: "EUR", amount: -500, booked: -560 },
        { label: "CHF", currency: "CHF", amount: 10, booked: 11 },
      ],
      D(2025, 1, 31),
      "USD",
    );
    expect(r.rows[0]).toMatchObject({ closingRate: 1.2, revalued: 1200, gainLoss: 100 });
    expect(r.rows[1]).toMatchObject({ revalued: -600, gainLoss: -40 });
    expect(r.rows[2]).toMatchObject({ closingRate: null, gainLoss: null });
    expect(r.gainLoss).toBe(60);
    expect(r.missing).toBe(1);
  });

  it("rounds half away from zero", () => {
    expect(roundTo(2.675)).toBe(2.68);
    expect(roundTo(-2.675)).toBe(-2.68);
    expect(roundTo(1.005)).toBe(1.01);
    expect(roundTo(1234.5, 0)).toBe(1235);
  });
});

describe("schedules", () => {
  it("counts the months a period spans", () => {
    expect(monthsSpanned(D(2025, 1, 1), D(2025, 12, 31))).toBe(12);
    expect(monthsSpanned(D(2025, 1, 15), D(2026, 1, 14))).toBe(12);
    expect(monthsSpanned(D(2025, 1, 1), D(2025, 3, 15))).toBe(3);
    expect(monthsSpanned(D(2025, 1, 31), D(2025, 4, 30))).toBe(3);
    expect(monthsSpanned(D(2025, 5, 5), D(2025, 5, 5))).toBe(1);
    expect(monthsSpanned(D(2025, 1, 1), D(2025, 2, 1))).toBe(2);
  });

  it("starts a month-end start in the next month", () => {
    const s = buildSchedule({ kind: "prepayment", amount: 300, start: D(2025, 1, 31), end: D(2025, 4, 30), debitAccount: "x", creditAccount: "y" });
    expect(s.rows.map((r) => r.month)).toEqual(["2025-02", "2025-03", "2025-04"]);
  });

  it("releases a prepayment straight-line with the remainder in the last month", () => {
    const s = buildSchedule({ kind: "prepayment", amount: 1000, start: D(2025, 1, 1), end: D(2025, 12, 31), debitAccount: "Insurance", creditAccount: "Prepayments", description: "Insurance" });
    expect(s.rows).toHaveLength(12);
    expect(s.rows.slice(0, 11).every((r) => r.amount === 83.33)).toBe(true);
    expect(s.rows[11].amount).toBe(83.37);
    expect(s.rows.reduce((a, r) => a + r.amount, 0)).toBeCloseTo(1000, 10);
    expect(s.rows[0]).toMatchObject({ month: "2025-01", opening: 1000, closing: 916.67, cumulative: 83.33 });
    expect(s.rows[11]).toMatchObject({ opening: 83.37, closing: 0, cumulative: 1000 });
    expect(iso(s.rows[1].postingDate)).toBe("2025-02-28");
    expect(s.journal).toHaveLength(24);
    expect(s.journal[0]).toMatchObject({ account: "Insurance", debit: 83.33, credit: 0, description: "Insurance 2025-01 (1 of 12)", entry: 1 });
    expect(s.journal[1]).toMatchObject({ account: "Prepayments", debit: 0, credit: 83.33 });
    expect(journalBalance(s.journal)).toMatchObject({ debit: 1000, credit: 1000, difference: 0, unbalanced: [] });
  });

  it("spreads by days and builds up an accrual", () => {
    const s = buildSchedule({ kind: "accrual", amount: 3100, start: D(2025, 1, 17), end: D(2025, 3, 16), method: "daily", posting: 25, debitAccount: "Audit fee", creditAccount: "Accruals" });
    // 15 + 28 + 16 = 59 days
    expect(s.totalDays).toBe(59);
    expect(s.rows.map((r) => r.days)).toEqual([15, 28, 16]);
    expect(s.rows.map((r) => r.amount)).toEqual([788.14, 1471.19, 840.67]);
    expect(s.rows[0]).toMatchObject({ opening: 0, closing: 788.14 });
    expect(s.rows[2]).toMatchObject({ closing: 3100, cumulative: 3100 });
    expect(iso(s.rows[1].postingDate)).toBe("2025-02-25");
    expect(s.journal[0].description).toBe("Accrual 2025-01 (1 of 3)");
  });

  it("straight-lines a mid-month year over 12 months", () => {
    const s = buildSchedule({ kind: "deferred-income", amount: 1200, start: D(2025, 1, 15), end: D(2026, 1, 14), debitAccount: "Deferred income", creditAccount: "Revenue", posting: "month-start" });
    expect(s.rows).toHaveLength(12);
    expect(s.rows[0].month).toBe("2025-01");
    expect(s.rows[11].month).toBe("2025-12");
    expect(s.rows.every((r) => r.amount === 100)).toBe(true);
    expect(iso(s.rows[0].postingDate)).toBe("2025-01-01");
  });

  it("posts a negative amount the other way round", () => {
    const s = buildSchedule({ kind: "prepayment", amount: -200, start: D(2025, 1, 1), end: D(2025, 2, 28), debitAccount: "Expense", creditAccount: "Prepayments" });
    expect(s.rows.map((r) => r.amount)).toEqual([-100, -100]);
    expect(s.journal[0]).toMatchObject({ account: "Prepayments", debit: 100 });
    expect(s.journal[1]).toMatchObject({ account: "Expense", credit: 100 });
  });

  it("checks its inputs", () => {
    const base = { kind: "accrual" as const, amount: 1, debitAccount: "a", creditAccount: "b" };
    expect(() => buildSchedule({ ...base, start: D(2025, 2, 1), end: D(2025, 1, 1) })).toThrow(/before/);
    expect(() => buildSchedule({ ...base, start: NaN, end: D(2025, 1, 1) })).toThrow(/start/);
  });

  it("finds unbalanced entries", () => {
    const b = journalBalance([
      { entry: 1, debit: 10, credit: 0 },
      { entry: 1, debit: 0, credit: 10 },
      { entry: 2, debit: 5, credit: 0 },
    ]);
    expect(b).toMatchObject({ debit: 15, credit: 10, difference: 5, unbalanced: [2] });
  });
});
