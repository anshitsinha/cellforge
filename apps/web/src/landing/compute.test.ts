import { describe, expect, it } from "vitest";
import { auditSample, bankRecSample } from "../samples";
import { benfordOf, isoSerial, recordsOf, runBankRec, runJournalTests } from "./compute";

describe("landing: bank rec on the sample", () => {
  const s = bankRecSample();
  const rec = runBankRec(s.ledger, s.bank);

  it("reads cash lines as records, row 1 being the first line under the header", () => {
    const r = recordsOf(s.ledger);
    expect(r).toHaveLength(s.ledger.length);
    expect(r[0]).toMatchObject({ row: 1, key: "OB", amount: s.openingBalance });
    expect(isoSerial("2026-10-01") + 30).toBe(isoSerial("2026-10-31"));
  });

  it("matches what the engine matches, and the statement agrees", () => {
    const sum = rec.result.summary;
    expect(rec.card.countA).toBe(s.ledger.length);
    expect(rec.card.countB).toBe(s.bank.length);
    expect(rec.card.matchedA).toBe(sum.matchedA);
    expect(rec.card.matchPct).toBeCloseTo(sum.matchRate * 100, 1);
    expect(rec.card.difference).toBe(0);
    expect(rec.statement.adjustedBank).toBe(rec.statement.adjustedLedger);
  });

  it("finds the planted problems: the keying error, the payment posted twice, the split", () => {
    expect(rec.card.keying).toBe(1);
    expect(rec.card.postedTwice).toBe(1);
    expect(rec.card.splits).toBe(1);
    expect(rec.keyingExample).toMatchObject({ ledger: 4725, bank: 4752 });
    const planted = s.planted.filter((p) => p.kind === "Deposit in transit" || p.kind === "Outstanding payment").length;
    expect(rec.rows.filter((r) => r.group === "timing")).toHaveLength(planted);
    expect(rec.rows.filter((r) => r.group === "bank")).toHaveLength(s.planted.filter((p) => p.kind === "Bank only (fee, interest)").length);
    // left to explain: everything one-sided, per side
    expect(rec.card.leftA).toBe(planted + 1);
    expect(rec.card.leftB).toBe(3);
  });

  it("every result row points at real lines, and notes go on both sides of a keying error", () => {
    for (const r of rec.rows) {
      expect(r.a.length + r.b.length).toBeGreaterThan(0);
      for (const i of r.a) expect(s.ledger[i]).toBeDefined();
      for (const j of r.b) expect(s.bank[j]).toBeDefined();
    }
    const k = rec.keyingExample!;
    expect(rec.notes.a.get(k.a)?.tone).toBe("bad");
    expect(rec.notes.b.get(k.b)?.text).toContain("4,725.00");
  });

  it("follows an edit: fix the keyed amount and the error is gone", () => {
    const ledger = s.ledger.map((l, i) => (i === rec.keyingExample!.a ? { ...l, amount: 4752 } : l));
    const fixed = runBankRec(ledger, s.bank);
    expect(fixed.card.keying).toBe(0);
    expect(fixed.card.matchedA).toBe(rec.card.matchedA + 1);
    expect(fixed.card.difference).toBe(0);
  });
});

describe("landing: journal tests and Benford on the sample", () => {
  const a = auditSample();

  it("runs every test the engine has and ranks the planted duplicate first", () => {
    const t = runJournalTests(a);
    expect(t.lines).toBe(a.lines.length);
    expect(t.entries).toBe(new Set(a.lines.map((l) => l.entry)).size);
    const by = Object.fromEntries(t.tests.map((x) => [x.id, x.entries]));
    expect(by.unbalanced).toBe(1);
    expect(by.duplicates).toBe(2);
    expect(by.weekend).toBeGreaterThanOrEqual(2);
    expect(t.top[0].id).toMatch(/^10061[12]$/);
    expect(a.lines[t.top[0].firstLine].entry).toBe(Number(t.top[0].id));
    expect(t.tests.map((x) => x.entries)).toEqual([...t.tests.map((x) => x.entries)].sort((x, y) => y - x));
  });

  it("can leave a test out of the list", () => {
    expect(runJournalTests(a, { skip: ["periodEnd"] }).tests.some((x) => x.id === "periodEnd")).toBe(false);
  });

  it("counts first digits of every amount", () => {
    const b = benfordOf(a);
    expect(b.n).toBe(a.lines.filter((l) => l.amount !== 0).length);
    expect(b.digits).toHaveLength(9);
    expect(b.digits.reduce((s, d) => s + d.count, 0)).toBe(b.n);
  });
});
