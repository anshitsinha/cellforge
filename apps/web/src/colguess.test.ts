import { describe, expect, it } from "vitest";
import { columnKind, defaultDuplicateKeys, firstOfKind, guessRoles, nameColumn, type ColumnSample } from "./colguess";

const vendors = ["Acme Supplies Ltd", "ACME Supplies", "Brightway Logistics", "Northwind Traders", "Contoso Office"];
const n = 30;
const ledger: ColumnSample[] = [
  { name: "Date", values: Array.from({ length: n }, (_, i) => 46023 + i * 3), numFmt: "yyyy-mm-dd" },
  { name: "Ref", values: Array.from({ length: n }, (_, i) => `INV-${1000 + i}`) },
  { name: "Vendor", values: Array.from({ length: n }, (_, i) => vendors[i % 5]) },
  { name: "Description", values: Array.from({ length: n }, (_, i) => `Invoice ${i} for services rendered`) },
  { name: "Account", values: Array.from({ length: n }, (_, i) => 6000 + (i % 4) * 10) },
  { name: "Amount", values: Array.from({ length: n }, (_, i) => 120 + i * 37.5) },
];

describe("column guessing", () => {
  it("tells the kinds apart", () => {
    expect(ledger.map(columnKind)).toEqual(["date", "reference", "text", "text", "code", "amount"]);
    expect(columnKind({ name: "x", values: [null, "", "  "] })).toBe("empty");
    expect(columnKind({ name: "Posted", values: ["2026-01-03", "2026-02-11", "2026-03-01"] })).toBe("date");
    expect(columnKind({ name: "Total", values: ["1,234.50", "(20.00)", "7.10"] })).toBe("amount");
    expect(columnKind({ name: "Qty", values: [1, 2, 3] })).toBe("number");
  });

  it("treats a date-named column of serials as dates even without a format", () => {
    expect(columnKind({ name: "Txn date", values: [46023, 46024, 46030] })).toBe("date");
    expect(columnKind({ name: "Amount", values: [46023, 46024, 46030] })).toBe("amount");
  });

  it("finds the finance roles by header", () => {
    expect(guessRoles(ledger)).toEqual({ date: 0, amount: 5, reference: 1, party: 2, description: 3, account: 4 });
  });

  it("falls back on the values when headers say nothing", () => {
    const blind = ledger.map((s, i) => ({ ...s, name: `Column ${String.fromCharCode(65 + i)}` }));
    const r = guessRoles(blind);
    expect(r.date).toBe(0);
    expect(r.amount).toBe(5);
    expect(r.reference).toBe(1);
    expect(r.party).toBe(2);
    expect(r.description).toBe(3);
  });

  it("starts duplicates on vendor + amount, never on the date", () => {
    expect(defaultDuplicateKeys(ledger)).toEqual([
      { col: 2, how: "text" },
      { col: 5, how: "exact" },
    ]);
    // no vendor: reference + amount
    const bank = [ledger[0], { ...ledger[1], name: "Reference" }, ledger[5]];
    expect(defaultDuplicateKeys(bank)).toEqual([
      { col: 1, how: "text" },
      { col: 2, how: "exact" },
    ]);
    // only a date and a text column: never the date
    const odd = [ledger[0], { name: "Status", values: Array.from({ length: n }, (_, i) => (i % 2 ? "open" : "closed")) }];
    expect(defaultDuplicateKeys(odd).map((k) => k.col)).toEqual([1]);
  });

  it("doesn't take the user who posted a journal for the counterparty", () => {
    const journal: ColumnSample[] = [
      { name: "User", values: Array.from({ length: n }, (_, i) => ["akhan", "cnguyen", "dokafor"][i % 3]) },
      { name: "Description", values: Array.from({ length: n }, (_, i) => `Invoice INV-${2000 + i} Vantage Kitchens`) },
      { name: "Amount", values: ledger[5].values },
      { name: "Reference", values: Array.from({ length: n }, (_, i) => `INV-${2000 + i}`) },
      { name: "Entry", values: Array.from({ length: n }, (_, i) => 100400 + Math.floor(i / 2)) },
    ];
    expect(guessRoles(journal).party).toBe(-1);
    expect(defaultDuplicateKeys(journal)).toEqual([
      { col: 3, how: "text" },
      { col: 2, how: "exact" },
    ]);
  });

  it("picks the vendor-like column for spelling variants", () => {
    expect(nameColumn(ledger)).toBe(2);
    const noHeader = ledger.map((s) => ({ ...s, name: "" }));
    expect(nameColumn(noHeader)).toBe(2);
    expect(nameColumn([ledger[0], ledger[5]])).toBe(-1);
  });

  it("finds the first column of a kind, preferring the role", () => {
    expect(firstOfKind(ledger, ["amount", "number"], "amount")).toBe(5);
    expect(firstOfKind(ledger, ["date"])).toBe(0);
    expect(firstOfKind([ledger[2]], ["date"])).toBe(-1);
  });
});
