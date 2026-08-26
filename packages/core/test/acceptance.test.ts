// Acceptance test: a synthetic month of bank statement lines and cash book
// postings (6K lines in all), exported to CSV the way real systems export
// them, run through the pipeline a user would (parse → unwrap → profile →
// reconcile with default settings → rec statement) and scored against the
// planted answer key. The same at 6M lines: bench/acceptance/run.ts.
import { beforeAll, describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_LIST, generate, toCsv } from "../../../bench/acceptance/generate";
import { failures, formatReport, runAcceptance, type AcceptanceReport } from "../../../bench/acceptance/pipeline";

describe("acceptance: a bank / ledger month at 6K rows", () => {
  let rep: AcceptanceReport;
  /** records not in any match, mismatched pair or rec statement line */
  let unaccounted = { ledger: -1, bank: -1 };
  let ms = 0;

  beforeAll(() => {
    const t = performance.now();
    rep = runAcceptance({
      rows: 6000,
      inspect: ({ r, st, ledger, bank }) => {
        const seenA = new Uint8Array(ledger.length);
        const seenB = new Uint8Array(bank.length);
        for (const m of r.matches) {
          for (const i of m.a) seenA[i] = 1;
          for (const j of m.b) seenB[j] = 1;
        }
        for (const p of r.mismatched) seenA[p.a] = seenB[p.b] = 1;
        for (const l of [...st.bankLines, ...st.ledgerLines])
          for (const it of l.items) {
            for (const i of it.a) seenA[i] = 1;
            for (const j of it.b) seenB[j] = 1;
          }
        unaccounted = { ledger: seenA.filter((x) => !x).length, bank: seenB.filter((x) => !x).length };
      },
    });
    ms = performance.now() - t;
  });

  it("meets every threshold (match quality per planted category and per rule)", () => {
    const fails = failures(rep);
    // the whole table, so a failure says what got worse and by how much
    if (fails.length) throw new Error(`\n${formatReport(rep)}\n\nNOT MET:\n${fails.map((f) => "  - " + f).join("\n")}`);
    expect(fails).toEqual([]);
  });

  it("plants every kind of difference, enough of each to measure", () => {
    for (const c of CATEGORY_LIST) expect(rep.categories.find((x) => x.category === c)!.planted, c).toBeGreaterThanOrEqual(CATEGORIES[c].min);
    expect(rep.ledgerLines + rep.bankLines).toBeGreaterThan(5900);
  });

  it("cleans both exports: no titles, totals, footers or balance lines left, no transaction lost, every value read", () => {
    expect(rep.junkRecords).toEqual({ ledger: 0, bank: 0 });
    expect(rep.lostLines).toEqual({ ledger: 0, bank: 0 });
    expect(rep.unreadable).toEqual({ ledger: 0, bank: 0 });
    expect(rep.profiles.ledger).toEqual({ Date: "date", "Doc No": "text", Narrative: "text", Amount: "number", Balance: "number" });
    expect(rep.profiles.bank).toMatchObject({ Date: "date", Description: "text", "Paid out": "number", "Paid in": "number", Balance: "number" });
  });

  it("reads the bank statement's running balance without a break", () => {
    expect(rep.bankCheck).toEqual({ transactions: rep.bankLines, breaks: 0, closingMatches: true });
  });

  it("finds every 1:N split up to four parts, and every batched deposit with a slip reference", () => {
    for (const k of [2, 3, 4]) expect(rep.splitByK[k].found, `k=${k}`).toBe(rep.splitByK[k].planted);
    const batch = rep.categories.find((c) => c.category === "batch")!;
    expect(batch.found).toBe(batch.planted);
  });

  it("flags every keying error and lists every duplicate posting, with no false alarms", () => {
    for (const c of ["transposition", "slip", "signFlip", "duplicate"] as const) {
      const s = rep.categories.find((x) => x.category === c)!;
      expect(s.found, c).toBe(s.planted);
    }
    expect(rep.falseFlags).toBe(0);
    expect(rep.falseDuplicates).toBe(0);
  });

  it("accounts for every record, and the rec statement difference is 0", () => {
    expect(unaccounted).toEqual({ ledger: 0, bank: 0 });
    expect(rep.statement.difference).toBe(0);
    expect(rep.statement.adjustedBank).toBe(rep.statement.adjustedLedger);
  });

  it("runs in a few seconds", () => {
    expect(ms).toBeLessThan(5000);
  });

  it("is deterministic: the same seed gives the same files", () => {
    const a = toCsv(generate({ rows: 2000, seed: 7 }));
    const b = toCsv(generate({ rows: 2000, seed: 7 }));
    const c = toCsv(generate({ rows: 2000, seed: 8 }));
    expect(a.ledger).toBe(b.ledger);
    expect(a.bank).toBe(b.bank);
    expect(a.bank).not.toBe(c.bank);
    // and the exports are messy: titles, accounting negatives, mixed dates, page footers, subtotals
    expect(a.ledger).toMatch(/^ACME HOLDINGS LTD/);
    expect(a.ledger).toMatch(/"\(\d{1,3}(,\d{3})*\.\d\d\)"|\(\d+\.\d\d\)/);
    expect(a.ledger).toMatch(/\d{4}-\d\d-\d\d,/);
    expect(a.ledger).toMatch(/Page 1 of \d+/);
    expect(a.ledger).toMatch(/Total for /);
    expect(a.bank).toMatch(/BALANCE CARRIED FORWARD/);
  });
});
