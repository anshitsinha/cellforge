// Fixes found by the bank/ledger acceptance test (bench/acceptance), one
// describe per fix, each with the smallest case that shows it.
import { describe, expect, it } from "vitest";
import { parseStatement, type StatementLine } from "../src/clean/bank";
import { parseDateLoose, parseNumberLoose, profileColumn } from "../src/clean/values";
import { unwrapReport } from "../src/clean/unwrap";
import { explain } from "../src/recon/explain";
import { chanceSums, reconcile, subsetSum, type RecRecord } from "../src/recon/match";
import { proposeAdjustments, recStatement } from "../src/recon/statement";
import { nameWords, normRef, normText, sharesName } from "../src/recon/text";

const rec = (row: number, key: string | undefined, amount: number | undefined, date?: number, text?: string): RecRecord => ({ row, key, amount, date, text });
const D = 45720;

describe("normRef: leading zeros after letters that aren't a known prefix", () => {
  it("treats DEP-4471, DEP004471 and dep 0004471 as one reference", () => {
    expect(normRef("DEP-4471")).toBe("DEP4471");
    expect(normRef("DEP004471")).toBe("DEP4471");
    expect(normRef("dep 0004471")).toBe("DEP4471");
    expect(normRef("A000")).toBe("A0");
    // unchanged
    expect(normRef("INV-000123")).toBe("123");
    expect(normRef("INV/2024/0012")).toBe("20240012");
    expect(normRef("000")).toBe("0");
  });
  it("so the reference pass matches them, as explain() already said it would", () => {
    const a = rec(0, "DEP-100234", 1112.8, D);
    const b = rec(0, "DEP000100234", 1112.8, D + 1);
    expect(reconcile([a], [b]).matches.map((m) => m.rule)).toEqual(["reference"]);
    expect(explain(a, b).rule).toBe("reference");
  });
});

describe("reference pass: the same amount matches outside the date window", () => {
  it("matches a cheque presented a week after it was written", () => {
    const r = reconcile([rec(0, "CHQ 102132", -1200.52, D)], [rec(0, "102132", -1200.52, D + 6)]);
    expect(r.matches).toMatchObject([{ rule: "reference", a: [0], b: [0], days: 6 }]);
    expect(r.mismatched).toEqual([]);
  });
  it("still needs the window when the amounts only agree within tolerance", () => {
    const r = reconcile([rec(0, "CHQ 102132", -1200.52, D)], [rec(0, "102132", -1200, D + 6)], { amountTolerance: 1 });
    expect(r.matches).toEqual([]);
    expect(r.mismatched).toHaveLength(1);
  });
  it("prefers the nearest date among several", () => {
    const r = reconcile([rec(0, "CHQ 7", -50, D)], [rec(0, "7", -50, D + 20), rec(1, "7", -50, D + 9)]);
    expect(r.matches).toMatchObject([{ rule: "reference", b: [1] }]);
  });
});

describe("sums by reference", () => {
  it("matches every item with the reference when together they add up, however many (k=5 > sumMaxItems)", () => {
    const parts = [210.1, 190.25, 300, 99.65, 200];
    const r = reconcile(
      [rec(0, "INV-0000555", 1000, D)],
      parts.map((v, k) => rec(k, "555", v, D + (k % 3))),
    );
    expect(r.matches).toMatchObject([{ rule: "one-to-many", a: [0], b: [0, 1, 2, 3, 4], amountDiff: 0 }]);
  });
  it("finds a split of four with the default settings", () => {
    const r = reconcile([rec(0, "INV-9", 1000, D), rec(1, "X-1", 77, D)], [rec(0, "9", 400, D), rec(1, "9", 300, D), rec(2, "9", 200, D + 1), rec(3, "9", 100, D + 2), rec(4, "9", 12.5, D)]);
    expect(r.matches.find((m) => m.rule === "one-to-many")).toMatchObject({ a: [0], b: [0, 1, 2, 3] });
  });
});

describe("sums by date: only same-sign, unambiguous, unlikely-by-chance combinations", () => {
  it("doesn't net a payment against a receipt to make up a fee", () => {
    const r = reconcile([rec(0, undefined, -115, D), rec(1, undefined, 100, D)], [rec(0, undefined, -15, D)], { passes: { amountDate: false } as never });
    expect(r.matches).toEqual([]);
  });
  it("doesn't pick one of several combinations of round amounts", () => {
    // a cheque in the ledger; bank fees of round amounts on the bank: -60 is -35-25, -35-12.5-12.5, -25-25-10...
    const r = reconcile([rec(0, "CHQ 102908", -60, D)], [-12.5, -35, -12.5, -25, -25, -10].map((v, k) => rec(k, undefined, v, D)));
    expect(r.matches).toEqual([]);
    expect(r.unmatchedA).toEqual([0]);
  });
  it("finds a batched deposit of four receipts when nothing else in the window could make it up", () => {
    const ledger = [118.25, 540.36, 61.7, 1435.11].map((v, k) => rec(k, `INV-${k + 1}`, v, D - (k % 2)));
    const r = reconcile(ledger, [rec(0, undefined, 2155.42, D + 1, "COUNTER CREDIT")]);
    expect(r.matches).toMatchObject([{ rule: "many-to-one", a: [0, 1, 2, 3], b: [0] }]);
  });
  it("leaves out an item whose reference the other side has (it's a mismatched pair, not part of a sum)", () => {
    const r = reconcile([rec(0, "PO-7", -10, D), rec(1, "PO-8", -5, D)], [rec(0, undefined, -15, D, "SERVICE CHARGE"), rec(1, "7", -10.5, D)]);
    expect(r.matches).toEqual([]);
    expect(r.mismatched).toMatchObject([{ a: 0, b: 1 }]);
  });
  it("tries again once other sums have taken their items out of the window", () => {
    // B0 = A0 + A1 + A2, but A3 + A4 + A5 add up to it too until B1 (= A3 + A4) has taken A3 and A4
    const ledger = [100, 101, 52.61, 88.67, 62.99, 101.95].map((v, k) => rec(k, `INV-${k}`, v, D));
    const r = reconcile(ledger, [rec(0, undefined, 253.61, D, "COUNTER CREDIT"), rec(1, undefined, 151.66, D, "CHEQUE DEPOSIT")]);
    expect(r.matches.map((m) => [m.a, m.b])).toEqual(
      expect.arrayContaining([
        [[3, 4], [1]],
        [[0, 1, 2], [0]],
      ]),
    );
  });
  it("chanceSums grows with the number of candidates and items", () => {
    const vals = Array.from({ length: 40 }, (_, k) => 50 + ((k * 37) % 400) + k / 100);
    expect(chanceSums(vals.slice(0, 5), 2, 300, 0)).toBeLessThan(0.01);
    expect(chanceSums(vals, 4, 900, 0)).toBeGreaterThan(chanceSums(vals, 2, 450, 0));
    expect(chanceSums(vals, 4, 900, 0)).toBeGreaterThan(0.02);
  });
  it("subsetSum with unique reports a second combination as ambiguous", () => {
    const amt = [10, 20, 30, 40];
    const one = subsetSum([0, 1, 2, 3], (j) => amt[j], 50, 1e-7, 2, 1000, true);
    expect(one).toMatchObject({ items: null, ambiguous: true });
    const two = subsetSum([0, 1, 2, 3], (j) => amt[j], 70, 1e-7, 2, 1000, true);
    expect(two.items?.sort()).toEqual([2, 3]);
    // without unique, the first one found
    expect(subsetSum([0, 1, 2, 3], (j) => amt[j], 50, 1e-7, 2, 1000).items).not.toBeNull();
  });
});

describe("amount and date: descriptions decide between equal amounts", () => {
  it("pairs each payment with the bank line naming the same party, not the first by date", () => {
    const r = reconcile(
      [rec(0, "PO-1", -100, D, "Payment to Apex Plastics LLP"), rec(1, "PO-2", -100, D, "Payment to Summit Plastics plc")],
      [rec(0, undefined, -100, D, "BACS SUMMIT PLASTICS"), rec(1, undefined, -100, D, "BACS APEX PLASTICS")],
    );
    expect(r.matches.map((m) => [m.a[0], m.b[0]]).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });
  it("doesn't use a second copy of a matched posting to clear some other line of the same amount", () => {
    const r = reconcile(
      [rec(0, "INV-5", 100, D, "Receipt - Oak Media"), rec(1, "INV-5", 100, D, "Receipt - Oak Media")],
      [rec(0, "INV-5", 100, D, "BGC OAK MEDIA"), rec(1, undefined, 100, D + 1, "BGC PINE FOODS")],
    );
    expect(r.matches).toMatchObject([{ rule: "exact" }]);
    expect(r.unmatchedA).toEqual([1]);
    expect(r.unmatchedB).toEqual([1]);
  });
  it("without descriptions still pairs by amount and nearest date", () => {
    const r = reconcile([rec(0, undefined, 100, D), rec(1, undefined, 100, D + 2)], [rec(0, undefined, 100, D + 2), rec(1, undefined, 100, D)]);
    expect(r.matches.map((m) => [m.a[0], m.b[0]]).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });
});

describe("fuzzy: references that differ rule a pair out", () => {
  it("flags a reference typo instead of matching on the description", () => {
    const r = reconcile([rec(0, "INV-9430919", 100, D, "Silver Joinery Group")], [rec(0, "INV-9403919", 100, D, "SILVER JOINERY GROUP")]);
    expect(r.matches).toEqual([]);
    expect(r.flags).toMatchObject([{ a: 0, b: 0, field: "key", kind: "transposition" }]);
  });
});

describe("keying flags without a reference need the same party", () => {
  it("doesn't call an unpresented cheque and a bank fee one digit apart a keying error", () => {
    const r = reconcile([rec(0, "CHQ 102918", -36, D, "Cheque 102918 Crown Metals LLP")], [rec(0, undefined, -30, D, "UNPAID ITEM FEE")]);
    expect(r.flags).toEqual([]);
  });
  it("still flags swapped digits when the descriptions name the same party", () => {
    const r = reconcile([rec(0, "PO-1", -1253, D, "Payment to Atlas Systems & Co")], [rec(0, undefined, -1523, D, "FPO ATLAS SYSTEMS")]);
    expect(r.flags).toMatchObject([{ field: "amount", kind: "transposition", mismatched: false }]);
  });
  it("still flags when one side has no description", () => {
    const r = reconcile([rec(0, "PO-1", -1253, D)], [rec(0, undefined, -1523, D, "FPO ATLAS SYSTEMS")]);
    expect(r.flags).toHaveLength(1);
  });
  it("sharesName ignores generic banking words", () => {
    expect(nameWords(normText("Payment to Atlas Systems Ltd"))).toEqual(["ATLAS", "SYSTEMS"]);
    expect(sharesName(normText("Payment to Atlas Systems Ltd"), normText("FPO ATLAS SYSTEMS"))).toBe(true);
    expect(sharesName(normText("Card payment Ltd"), normText("CARD PAYMENT TO X LTD"))).toBe(false);
    expect(sharesName(normText("ref 12345"), normText("12345 BGC"))).toBe(true);
    expect(sharesName(normText("ref 123"), normText("123 BGC"))).toBe(false);
  });
});

describe("rec statement: duplicate ledger postings are errors, not timing items", () => {
  const a = [rec(0, "INV-5", 100, D, "Receipt"), rec(1, "INV-5", 100, D, "Receipt"), rec(2, "INV-6", 40, D)];
  const b = [rec(0, "INV-5", 100, D)];
  const r = reconcile(a, b);
  it("puts the copy under errors in the ledger, to be reversed", () => {
    const st = recStatement(r, a, b, { bankBalance: 1100, ledgerBalance: 1240 });
    const errors = st.ledgerLines.find((l) => l.id === "ledgerErrors")!;
    expect(errors.items).toMatchObject([{ a: [1], b: [], value: -100, duplicate: true }]);
    expect(st.bankLines.find((l) => l.id === "dit")!.items.map((i) => i.a)).toEqual([[2]]);
    expect(st.difference).toBe(0);
    const adj = proposeAdjustments(st, a, b);
    expect(adj).toHaveLength(1);
    expect(adj[0].narrative).toContain("duplicate posting");
    expect(adj[0].lines).toEqual([
      { account: "Account of the original posting", debit: 100, credit: 0 },
      { account: "Bank", debit: 0, credit: 100 },
    ]);
  });
  it("can be turned off", () => {
    const st = recStatement(r, a, b, { bankBalance: 1100, ledgerBalance: 1240, duplicatesAsErrors: false });
    expect(st.bankLines.find((l) => l.id === "dit")!.items.map((i) => i.a)).toEqual([[1], [2]]);
    expect(st.difference).toBe(0);
  });
  it("leaves copies alone when none of them is matched", () => {
    const st = recStatement(reconcile(a, []), a, [], { bankBalance: 1000, ledgerBalance: 1240 });
    expect(st.ledgerLines.find((l) => l.id === "ledgerErrors")!.items).toEqual([]);
  });
});

describe("unwrapReport: dated running-balance lines", () => {
  it("drops brought / carried forward and opening / closing balance lines even with a date", () => {
    const u = unwrapReport([
      ["Date", "Description", "Paid out", "Paid in", "Balance"],
      ["01 Mar 2025", "BALANCE BROUGHT FORWARD", "", "", "1,000.00"],
      ["02 Mar 2025", "BGC ACME", "", "50.00", "1,050.00"],
      ["02 Mar 2025", "Balance carried forward", "", "", "1,050.00"],
      ["", "Closing balance", "", "", "1,050.00"],
    ]);
    expect(u.rows.map((r) => r[1])).toEqual(["BGC ACME"]);
    expect(u.dropped.filter((d) => d.reason === "total")).toHaveLength(3);
  });
  it("keeps an account that only starts with the words", () => {
    const u = unwrapReport([
      ["Code", "Account", "Debit", "Credit"],
      ["3900", "Opening Balance Equity", "", "1,234.00"],
      ["1200", "Bank", "1,234.00", ""],
    ]);
    expect(u.rows).toHaveLength(2);
  });
  it("copes with hundreds of thousands of rows", () => {
    const rows = [["Date", "Description", "Amount"], ...Array.from({ length: 300_000 }, (_, k) => ["01/03/2025", `item ${k}`, "1.00"])];
    expect(unwrapReport(rows).rows).toHaveLength(300_000);
  });
});

describe("parseStatement: long statements", () => {
  it("reads hundreds of thousands of lines (the year isn't found with Math.min(...))", () => {
    const n = 250_000;
    const lines: StatementLine[] = [{ page: 1, cells: ["Date", "Details", "Paid out", "Paid in", "Balance"].map((text, c) => ({ x: c * 100, x2: c * 100 + 60, text })) }];
    let bal = 0;
    for (let k = 0; k < n; k++) {
      bal += 1;
      lines.push({ page: 1, cells: [{ x: 0, x2: 60, text: "05/03/2025" }, { x: 100, x2: 160, text: "BGC" }, { x: 300, x2: 360, text: "1.00" }, { x: 400, x2: 460, text: String(bal) + ".00" }] });
    }
    const st = parseStatement(lines);
    expect(st.transactions).toHaveLength(n);
    expect(st.transactions[0].date).toBe(45721);
    expect(st.breaks).toBe(0);
  }, 60_000); // big input: allow for a busy machine running the whole suite
});

describe("profileColumn / parseNumberLoose: faster, same answers", () => {
  it("keeps every number form the slow path reads", () => {
    for (const [s, v] of [["-0012", -12], ["12.50", 12.5], ["1e5", 100000], ["+7", 7], ["(1,234.50)", -1234.5], ["1,234.50-", -1234.5], [" 42 ", 42], ["-0", -0]] as const) expect(parseNumberLoose(s)).toBe(v);
    expect(parseNumberLoose("12,5", "comma")).toBe(12.5);
    expect(parseNumberLoose("1.234", "comma")).toBe(1234);
    expect(parseNumberLoose("Receipt - Acme Ltd")).toBeNull();
    expect(parseNumberLoose("12/03/2025")).toBeNull();
  });
  it("knows month lengths and leap years without a Date", () => {
    expect(parseDateLoose("29/02/2024")).not.toBeNull();
    expect(parseDateLoose("29/02/2025")).toBeNull();
    expect(parseDateLoose("29/02/1900")).toBeNull();
    expect(parseDateLoose("29/02/2000")).not.toBeNull();
    expect(parseDateLoose("31/04/2025")).toBeNull();
    expect(parseDateLoose("31/12/2025")).not.toBeNull();
  });
  it("finds the same misfits in a date column", () => {
    const p = profileColumn(["05/03/2025", "20250306", "2025-03-07", "not a date", "13/03/2025", "31/02/2025"]);
    expect(p.type).toBe("date");
    expect(p.misfits).toEqual([
      { row: 3, value: "not a date" },
      { row: 5, value: "31/02/2025" },
    ]);
  });
});
