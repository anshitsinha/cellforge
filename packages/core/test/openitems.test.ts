import { describe, expect, it } from "vitest";
import { reconcile, type RecRecord } from "../src/recon/match";
import { accountFor, DEFAULT_ADJ_RULES, payeeOf, proposeAdjustments, recStatement } from "../src/recon/statement";
import { classifyDoc, guessStatementSigns, matchOpenItems, rollOutstanding, statementRec, type OpenItemRecord, type StatementRecRecord } from "../src/recon/openitems";

const rec = (row: number, key: string | undefined, amount: number, date?: number, text?: string): RecRecord => {
  const r: RecRecord = { row, amount };
  if (key) r.key = key;
  if (date !== undefined) r.date = date;
  if (text) r.text = text;
  return r;
};
const D = 45600; // a date serial

describe("bank rec statement", () => {
  // ledger: opening 1,000 + items; bank: opening 1,000 + items
  const ledger = [
    rec(2, "CHQ101", -200, D + 1, "Acme Ltd"),
    rec(3, "DEP1", 500, D + 2, "Takings"),
    rec(4, "CHQ102", -1243, D + 3, "Globex"), // bank paid 1,234: transposition in the ledger
    rec(5, "CHQ103", -300, D + 28, "Initech"), // not yet presented
    rec(6, "DEP2", 750, D + 30, "Takings"), // deposit in transit
  ];
  const bank = [
    rec(2, "CHQ101", -200, D + 3, "CHQ 101"),
    rec(3, "DEP1", 500, D + 2, "Counter credit"),
    rec(4, "CHQ102", -1234, D + 5, "CHQ 102"),
    rec(5, undefined, -15, D + 30, "Monthly account fee"),
    rec(6, undefined, 4.2, D + 30, "Credit interest"),
    rec(7, undefined, -89.99, D + 15, "DD BRITISH GAS 12345678"),
  ];
  const sumOf = (l: RecRecord[]) => Math.round(l.reduce((t, r) => t + r.amount!, 0) * 100) / 100;
  const ledgerBalance = Math.round((1000 + sumOf(ledger)) * 100) / 100;
  const bankBalance = Math.round((1000 + sumOf(bank)) * 100) / 100;
  const r = reconcile(ledger, bank, { dateWindow: 5 });
  const st = recStatement(r, ledger, bank, { bankBalance, ledgerBalance });

  it("takes both balances to the same adjusted balance", () => {
    const line = (id: string) => [...st.bankLines, ...st.ledgerLines].find((l) => l.id === id)!;
    expect(line("bank").total).toBe(bankBalance);
    expect(line("dit").total).toBe(750);
    expect(line("dit").items.map((i) => i.a)).toEqual([[4]]);
    expect(line("outstanding").total).toBe(-300);
    expect(line("ledger").total).toBe(ledgerBalance);
    expect(line("bankReceipts").total).toBe(4.2);
    expect(line("bankPayments").total).toBe(-104.99);
    expect(line("ledgerErrors").total).toBe(9);
    expect(line("ledgerErrors").items[0].keying).toBe("transposition");
    expect(st.adjustedBank).toBe(Math.round((bankBalance + 750 - 300) * 100) / 100);
    expect(st.adjustedLedger).toBe(st.adjustedBank);
    expect(st.difference).toBe(0);
  });

  it("puts the errors on the bank side when asked", () => {
    const s2 = recStatement(r, ledger, bank, { bankBalance, ledgerBalance, errorsOn: "bank" });
    expect(s2.bankLines.find((l) => l.id === "bankErrors")!.total).toBe(-9);
    expect(s2.ledgerLines.find((l) => l.id === "ledgerErrors")!.total).toBe(0);
    expect(s2.difference).toBe(0);
  });

  it("shows an unexplained difference", () => {
    const s3 = recStatement(r, ledger, bank, { bankBalance: bankBalance + 10, ledgerBalance });
    expect(s3.difference).toBe(10);
  });

  it("works with the bank's sign flipped", () => {
    const flipped = bank.map((b) => ({ ...b, amount: -b.amount! }));
    const rf = reconcile(ledger, flipped, { dateWindow: 5, flipB: true });
    const sf = recStatement(rf, ledger, flipped, { bankBalance, ledgerBalance, flipB: true });
    expect(sf.difference).toBe(0);
    expect(sf.ledgerLines.find((l) => l.id === "bankReceipts")!.total).toBe(4.2);
  });

  it("treats an unmatched keying-error pair as one error", () => {
    const a = [rec(1, undefined, -560, D)];
    const b = [rec(1, undefined, -650, D)];
    const rr = reconcile(a, b, {});
    expect(rr.flags.length).toBe(1);
    const s = recStatement(rr, a, b, { bankBalance: -650, ledgerBalance: -560 });
    expect(s.ledgerLines.find((l) => l.id === "ledgerErrors")!.total).toBe(-90);
    expect(s.bankLines.find((l) => l.id === "outstanding")!.items).toEqual([]);
    expect(s.difference).toBe(0);
    const s2 = recStatement(rr, a, b, { bankBalance: -650, ledgerBalance: -560, flagsAsErrors: false });
    expect(s2.bankLines.find((l) => l.id === "outstanding")!.total).toBe(-560);
    expect(s2.difference).toBe(0);
  });

  it("proposes balanced adjusting entries", () => {
    const entries = proposeAdjustments(st, ledger, bank, { bankAccount: "Cash at bank" });
    expect(entries.length).toBe(4);
    for (const e of entries) {
      const dr = e.lines.reduce((t, l) => t + l.debit, 0);
      const cr = e.lines.reduce((t, l) => t + l.credit, 0);
      expect(dr).toBeCloseTo(cr, 9);
      expect(e.lines.some((l) => l.account === "Cash at bank")).toBe(true);
    }
    const by = (rule: string | null) => entries.find((e) => e.rule === rule)!;
    expect(by("Interest").lines).toEqual([
      { account: "Cash at bank", debit: 4.2, credit: 0 },
      { account: "Interest income", debit: 0, credit: 4.2 },
    ]);
    expect(by("Bank charges").lines[0]).toEqual({ account: "Bank charges", debit: 15, credit: 0 });
    expect(by("Direct debit").lines[0]).toEqual({ account: "Accounts payable: BRITISH GAS", debit: 89.99, credit: 0 });
    const err = entries.find((e) => e.kind === "error")!;
    expect(err.lines[0]).toEqual({ account: "Cash at bank", debit: 9, credit: 0 });
    expect(err.narrative).toMatch(/two digits swapped/);
  });

  it("chooses accounts by keyword", () => {
    expect(accountFor("FX conversion fee", -3, DEFAULT_ADJ_RULES, "Suspense").account).toBe("FX gains and losses");
    expect(accountFor("Overdraft interest", -3, DEFAULT_ADJ_RULES, "Suspense").account).toBe("Interest expense");
    expect(accountFor("Returned cheque 123", -3, DEFAULT_ADJ_RULES, "Suspense").account).toBe("Accounts receivable");
    expect(accountFor("Something odd", 3, DEFAULT_ADJ_RULES, "Suspense")).toEqual({ account: "Suspense", rule: null });
    expect(payeeOf("Direct Debit Thames Water REF 99812", DEFAULT_ADJ_RULES[5].pattern)).toBe("Thames Water REF");
  });
});

describe("roll forward of outstanding items", () => {
  const prior = [
    rec(2, "CHQ090", -120, D - 40, "Old cheque"),
    rec(3, "CHQ095", -400, D - 10),
    rec(4, "DEP9", 250, D - 1),
    rec(5, "CHQ096", -75, D - 5),
    rec(6, "CHQ050", -60, D - 300),
  ];
  const current = [
    rec(2, "CHQ095", -400, D + 6),
    rec(3, "DEP9", 250, D + 1),
    rec(4, "CHQ096", -57, D + 3),
    rec(5, undefined, -999, D + 4),
  ];
  const roll = rollOutstanding(prior, current, { asOf: D + 30 });

  it("marks what cleared, when, and what's still open", () => {
    expect(roll.items.map((i) => i.status)).toEqual(["open", "cleared", "cleared", "differs", "open"]);
    expect(roll.items[1]).toMatchObject({ clearedBy: [0], clearedDate: D + 6, daysToClear: 16 });
    expect(roll.items[2].daysToClear).toBe(2);
    expect(roll.items[3].note).toMatch(/difference/);
    expect(roll.usedCurrent).toEqual([0, 1, 2]);
  });

  it("ages the open items and flags stale ones", () => {
    expect(roll.items[0]).toMatchObject({ age: 70, bucket: "61-90", stale: false });
    expect(roll.items[4]).toMatchObject({ age: 330, stale: true });
    expect(roll.summary).toMatchObject({ broughtForward: 5, broughtForwardTotal: -405, cleared: 2, clearedTotal: -150, differs: 1, open: 2, openTotal: -180, stale: 1, staleTotal: -60 });
    expect(roll.buckets.find((b) => b.label === "Over 90")!.total).toBe(-60);
  });
});

describe("open-item matching in one account", () => {
  const items: OpenItemRecord[] = [
    { row: 2, party: "C1", key: "INV-1", amount: 1000, date: D },
    { row: 3, party: "C1", key: "1", amount: -400, date: D + 10 },
    { row: 4, party: "C1", key: "inv 1", amount: -600, date: D + 20 },
    { row: 5, party: "C1", key: "INV-2", amount: 250, date: D + 5 },
    { row: 6, party: "C1", key: "PAY-77", amount: -250, date: D + 40 },
    { row: 7, party: "C2", key: "INV-3", amount: 500, date: D },
    { row: 8, party: "C2", amount: -200, date: D + 3 },
    { row: 9, party: "C2", amount: -300, date: D + 4 },
    { row: 10, party: "C2", key: "INV-4", amount: 90, date: D - 100 },
    { row: 11, party: "C3", key: "INV-5", amount: 70, date: D }, // same amount as a C2 credit-free item, other party
    { row: 12, party: "C2", key: "INV-6", amount: 120, date: D },
    { row: 13, party: "C2", key: "INV-6", amount: -100, date: D + 2 },
    { row: 14, party: "C1", amount: 0, date: D },
  ];
  const res = matchOpenItems(items, { asOf: D + 60 });

  it("clears reference groups, pairs and sums within a party", () => {
    const g = res.groups.map((x) => [x.rule, x.items]);
    expect(g).toContainEqual(["reference group", [0, 1, 2]]);
    expect(g).toContainEqual(["amount+date", [3, 4]]);
    expect(g).toContainEqual(["one-to-many", [5, 6, 7]]);
    expect(g).toContainEqual(["zero", [12]]);
    expect(res.groups.every((x) => x.net === 0)).toBe(true);
    expect(res.groups.find((x) => x.rule === "reference group")!.date).toBe(D + 20);
  });

  it("leaves the rest open, aged, with part-settlement notes", () => {
    expect(res.open.map((o) => o.index)).toEqual([8, 9, 10, 11]);
    expect(res.open.find((o) => o.index === 8)).toMatchObject({ party: "C2", age: 160, bucket: "Over 90" });
    expect(res.open.find((o) => o.index === 10)!.note).toMatch(/part settled.*20\.00 left/);
    expect(res.summary).toMatchObject({ count: 13, balance: 180, clearedCount: 9, clearedNet: 0, openCount: 4, openTotal: 180, parties: 3, openParties: 2 });
  });
});

describe("supplier statement rec", () => {
  // our AP ledger, invoices negative (credits); their statement, invoices positive
  const ours: StatementRecRecord[] = [
    { row: 2, key: "INV-1001", amount: -1200, date: D, type: "Invoice" },
    { row: 3, key: "INV-1002", amount: -560, date: D + 5, type: "Invoice" }, // they have 650: transposition
    { row: 4, key: "PAY-1", amount: 1200, date: D + 20, type: "Payment" },
    { row: 5, key: "PAY-2", amount: 300, date: D + 29, type: "Payment" }, // in transit
    { row: 6, key: "INV-1004", amount: -80, date: D + 9, type: "Invoice" },
  ];
  const theirs: StatementRecRecord[] = [
    { row: 2, key: "1001", amount: 1200, date: D, type: "INV" },
    { row: 3, key: "1002", amount: 650, date: D + 5, type: "INV" },
    { row: 4, key: "RCPT 1", amount: -1200, date: D + 22, type: "Receipt" },
    { row: 5, key: "1003", amount: 900, date: D + 25, type: "INV" }, // not in our ledger
    { row: 6, key: "CN-12", amount: -50, date: D + 26, type: "Credit note" }, // not booked
    { row: 7, key: "1004", amount: 80, date: D + 60, type: "INV" }, // dates far apart: number still matches
  ];

  it("guesses the signs", () => {
    expect(guessStatementSigns(ours, theirs)).toEqual({ flipTheirs: true, invoicesPositive: false });
  });

  it("classifies documents", () => {
    expect(classifyDoc({ row: 1, type: "Credit Note" }, 1)).toBe("credit note");
    expect(classifyDoc({ row: 1, key: "CN-5", amount: -10 }, 1)).toBe("credit note");
    expect(classifyDoc({ row: 1, text: "BACS payment", amount: -10 }, 1)).toBe("payment");
    expect(classifyDoc({ row: 1, amount: 10 }, 1)).toBe("invoice");
    expect(classifyDoc({ row: 1, amount: -10 }, 1)).toBe("payment");
    expect(classifyDoc({ row: 1, type: "Journal", amount: 5 }, 1)).toBe("other");
  });

  it("takes their balance to ours through the reconciling items", () => {
    const res = statementRec(ours, theirs, { flipTheirs: true, invoicesPositive: false, statementDate: D + 28 });
    expect(res.sign).toBe(-1);
    expect(res.theirBalance).toBe(1580);
    expect(res.ourBalance).toBe(340);
    const line = (id: string) => res.lines.find((l) => l.id === id)!;
    expect(line("their-invoice").total).toBe(-900);
    expect(line("their-credit").total).toBe(50);
    expect(line("our-payment").total).toBe(-300);
    expect(line("our-payment").items[0].note).toMatch(/after their statement/);
    expect(line("difference").total).toBe(-90);
    expect(line("difference").items[0].keying).toBe("transposition");
    expect(res.computedOurs).toBe(340);
    expect(res.difference).toBe(0);
    // INV-1004 matched by number despite 51 days between the dates; the payment by amount and date
    const rules = res.rec.matches.map((m) => [m.rule, m.a, m.b]);
    expect(rules).toContainEqual(["reference", [4], [5]]);
    expect(rules).toContainEqual(["amount+date", [2], [2]]);
  });

  it("reports an unexplained difference against the stated balances", () => {
    const res = statementRec(ours, theirs, { flipTheirs: true, invoicesPositive: false, theirBalance: 1600 });
    expect(res.difference).toBe(20);
  });
});
