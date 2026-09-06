import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { runWorkbookChecks } from "./checksui";
import { LEDGER_HEADERS, SyntheticSource } from "./demo";
import { AUDIT_MAX_LINES, auditSample, bankMinusLedger, bankRecSample, closeSample, isSampleKind, sampleFromUrl, sampleWorkbook } from "./samples";

const cents = (n: number) => Math.round(n * 100);
const sum = (xs: number[]) => xs.reduce((s, x) => s + cents(x), 0);

describe("bank rec sample", () => {
  it("is the same every time for a seed, and different for another", () => {
    expect(bankRecSample(1)).toEqual(bankRecSample(1));
    expect(bankRecSample(2).ledger).not.toEqual(bankRecSample(1).ledger);
  });

  it("bank minus ledger is exactly the planted reconciling items", () => {
    for (const seed of [1, 2, 3, 42]) {
      const s = bankRecSample(seed);
      const diff = sum(s.bank.map((l) => l.amount)) - sum(s.ledger.map((l) => l.amount));
      expect(diff).toBe(sum(s.planted.map(bankMinusLedger)));
      expect(cents(s.ledgerClosing)).toBe(sum(s.ledger.map((l) => l.amount)));
      expect(cents(s.bankClosing)).toBe(sum(s.bank.map((l) => l.amount)));
    }
  });

  it("plants each kind of reconciling item, dated in the month, lines in date order", () => {
    const s = bankRecSample();
    const kinds = new Set(s.planted.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(["Bank only (fee, interest)", "Deposit in transit", "Ledger error", "Outstanding payment"]);
    for (const list of [s.ledger, s.bank]) {
      expect(list.length).toBeGreaterThan(100);
      expect(list.every((l) => /^2026-10-\d\d$/.test(l.date))).toBe(true);
      expect(list.map((l) => l.date)).toEqual([...list.map((l) => l.date)].sort());
      expect(list.every((l) => Number.isInteger(cents(l.amount)) && Math.abs(l.amount * 100 - cents(l.amount)) < 1e-6)).toBe(true);
    }
    // the duplicate posting: one reference twice in the cash book, once on the bank
    const dup = s.ledger.filter((l) => l.description === "Payment · Kestrel Print" && l.amount === -1180);
    expect(dup).toHaveLength(2);
    expect(s.bank.filter((l) => l.reference === dup[0].reference)).toHaveLength(1);
  });

  it("in the bank rec template, listing the planted items leaves no difference", async () => {
    const { workbook: wb, name } = await sampleWorkbook("bank-rec");
    expect(name).toMatch(/Bank reconciliation/);
    const s = bankRecSample();
    const cell = (sheet: string, r: number, c: number) => wb.byName(sheet)!.source.getCell(r, c);
    expect(cell("Cash book", 1, 2)).toBe("Opening balance");
    expect(cents(cell("Rec", 2, 1) as number)).toBe(cents(s.bankClosing));
    expect(cents(cell("Rec", 8, 1) as number)).toBe(cents(s.ledgerClosing));
    expect(cell("Rec", 13, 1)).not.toBe(0); // not reconciled yet

    const ctx: SheetCtx = { workbook: wb, activeSheet: wb.byName("Outstanding")!.id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells(s.planted.flatMap((p, i) => [
      { row: i + 1, col: 0, input: p.kind },
      { row: i + 1, col: 1, input: p.date },
      { row: i + 1, col: 2, input: p.description },
      { row: i + 1, col: 3, input: String(p.amount) },
    ])));
    expect(cell("Rec", 13, 1)).toBe(0);
    const status = Object.fromEntries(runWorkbookChecks(wb, wb.checks).map((r) => [r.name, r.status]));
    expect(status["The reconciliation has no difference"]).toBe("pass");
    expect(wb.evidence.log).toEqual([]);
  });
});

describe("month-end close sample", () => {
  it("both trial balances balance to the cent, and cash stays positive", () => {
    for (const seed of [1, 2, 7]) {
      const s = closeSample(seed);
      for (const tb of [s.current, s.prior]) {
        expect(sum(tb.map((l) => l.debit))).toBe(sum(tb.map((l) => l.credit)));
        expect(tb.find((l) => l.code === 1000)!.debit).toBeGreaterThan(0);
        expect(tb.every((l) => l.debit === 0 || l.credit === 0)).toBe(true);
      }
    }
    expect(closeSample(3)).toEqual(closeSample(3));
  });

  it("the planted movements are over both thresholds, and only one account is unmapped", () => {
    const s = closeSample();
    const bal = (tb: typeof s.current, code: number) => {
      const l = tb.find((x) => x.code === code);
      return l ? l.debit - l.credit : 0;
    };
    for (const p of s.planted) {
      const change = bal(s.current, p.code) - bal(s.prior, p.code);
      const prior = bal(s.prior, p.code);
      expect(Math.abs(change)).toBeGreaterThanOrEqual(10_000);
      if (prior !== 0) expect(Math.abs(change / prior)).toBeGreaterThanOrEqual(0.1);
    }
    const mapped = new Set(s.mapping.map((m) => m.code));
    expect(s.current.filter((l) => !mapped.has(l.code)).map((l) => l.code)).toEqual(s.unmapped);
  });

  it("in the close template, flux flags the planted accounts and the checks find the unmapped one", async () => {
    const { workbook: wb } = await sampleWorkbook("close");
    const s = closeSample();
    const flux = wb.byName("Flux")!.source;
    const flagged: number[] = [];
    for (let r = 1; r <= s.current.length; r++) if (flux.getCell(r, 7) === "Explain") flagged.push(flux.getCell(r, 0) as number);
    for (const p of s.planted) expect(flagged).toContain(p.code);
    const status = Object.fromEntries(runWorkbookChecks(wb, wb.checks).map((r) => [r.name, r.status]));
    expect(status["This month's TB balances (debits = credits)"]).toBe("pass");
    expect(status["Every account is mapped"]).toBe("fail");
  });
});

describe("audit sample", () => {
  it("is deterministic and fits the template's population sheet", () => {
    const s = auditSample();
    expect(auditSample()).toEqual(s);
    expect(s.lines.length).toBeGreaterThan(1500);
    expect(s.lines.length).toBeLessThanOrEqual(AUDIT_MAX_LINES);
  });

  it("every entry balances except the planted one, which is the whole journal's difference", () => {
    const s = auditSample();
    const byEntry = new Map<number, number>();
    for (const l of s.lines) byEntry.set(l.entry, (byEntry.get(l.entry) ?? 0) + cents(l.amount));
    const off = [...byEntry].filter(([, v]) => v !== 0);
    const unbalanced = s.planted.filter((p) => p.flag === "unbalanced").map((p) => p.entry);
    expect(off.map(([e]) => e)).toEqual(unbalanced);
    expect(sum(s.lines.map((l) => l.amount))).toBe(cents(s.outOfBalance));
    expect(s.outOfBalance).toBe(100);
  });

  it("the planted red flags are really in the data", () => {
    const s = auditSample();
    const lines = (e: number) => s.lines.filter((l) => l.entry === e);
    const entries = new Set(s.lines.map((l) => l.entry));
    for (const g of s.gaps) expect(entries.has(g)).toBe(false);
    for (const p of s.planted) {
      const ls = lines(p.entry);
      if (p.flag === "gap") continue;
      expect(ls.length).toBeGreaterThan(0);
      const day = new Date(ls[0].date + "T00:00:00Z").getUTCDay();
      const hour = Number(ls[0].posted.slice(11, 13));
      if (p.flag === "weekend") expect([0, 6]).toContain(day);
      if (p.flag === "out of hours") expect(hour < 8 || hour >= 18).toBe(true);
      if (p.flag === "below approval limit") expect(Math.max(...ls.map((l) => l.amount))).toBeGreaterThan(s.approvalLimit * 0.95);
      if (p.flag === "below approval limit") expect(Math.max(...ls.map((l) => l.amount))).toBeLessThan(s.approvalLimit);
      if (p.flag === "round amount") expect(ls.some((l) => l.amount % 1000 === 0 && l.amount !== 0)).toBe(true);
      if (p.flag === "backdated") expect(ls[0].posted.slice(0, 7)).not.toBe(ls[0].date.slice(0, 7));
      if (p.flag === "unusual user") expect(s.lines.filter((l) => l.user === ls[0].user).every((l) => l.entry === p.entry)).toBe(true);
      if (p.flag === "seldom-used account") expect(s.lines.filter((l) => l.account === 9999).every((l) => l.entry === p.entry)).toBe(true);
      if (p.flag === "duplicate") {
        const copy = lines(p.entry - 1).map(({ entry: _e, posted: _p, ...rest }) => rest);
        expect(ls.map(({ entry: _e, posted: _p, ...rest }) => rest)).toEqual(copy);
      }
    }
    // routine entries are dated on working days, in the month
    const routine = s.lines.filter((l) => !s.planted.some((p) => p.entry === l.entry));
    expect(routine.every((l) => l.date.startsWith("2026-10-") && ![0, 6].includes(new Date(l.date + "T00:00:00Z").getUTCDay()))).toBe(true);
  });

  it("fills the audit template's population", async () => {
    const { workbook: wb } = await sampleWorkbook("audit");
    const pop = wb.byName("Population")!.source;
    const s = auditSample();
    expect(pop.getCell(1, 0)).toBe(s.lines[0].entry);
    expect(pop.getCell(s.lines.length, 6)).toBe(s.lines[s.lines.length - 1].amount);
    expect(pop.getCell(s.lines.length + 1, 0)).toBe(null);
  });
});

describe("the 100M-line ledger demo", () => {
  it("is a ledger: named columns, each pair of lines one balanced entry", () => {
    const src = new SyntheticSource(1_000_000);
    expect(LEDGER_HEADERS.map((_, c) => src.getColumnName(c))).toEqual(["Entry", "Date", "Account", "Account name", "Debit", "Credit", "Description", "User"]);
    let debits = 0;
    let credits = 0;
    for (let r = 0; r < 2000; r++) {
      debits += cents((src.getCell(r, 4) as number | null) ?? 0);
      credits += cents((src.getCell(r, 5) as number | null) ?? 0);
      if (r % 2 === 1) {
        expect(src.getCell(r, 0)).toBe(src.getCell(r - 1, 0));
        expect(debits).toBe(credits);
      }
    }
    // dates run oldest first across the whole ledger
    expect(String(src.getCell(0, 1)) <= String(src.getCell(999_999, 1))).toBe(true);
    expect(new SyntheticSource(100_000_000).getCell(99_999_999, 0)).toBe(100001 + 49_999_999);
  });

  it("first digits roughly follow Benford's law", () => {
    const src = new SyntheticSource(400_000);
    const counts = Array<number>(10).fill(0);
    for (let r = 0; r < 400_000; r += 2) counts[Number(String(src.getCell(r, 4)).replace(/^0\.?0*/, "")[0])]++;
    const share1 = counts[1] / 200_000;
    expect(share1).toBeGreaterThan(0.27);
    expect(share1).toBeLessThan(0.33);
    expect(counts[9] / 200_000).toBeLessThan(0.07);
  });

  it("opens as one sheet", async () => {
    const s = await sampleWorkbook("big");
    expect(s.workbook.sheets).toHaveLength(1);
    expect(s.workbook.sheets[0].source.rowCount).toBe(100_000_000);
  });
});

describe("sample URLs", () => {
  it("reads ?sample= and ignores anything else", () => {
    expect(sampleFromUrl("?sample=bank-rec")).toBe("bank-rec");
    expect(sampleFromUrl("?sample=audit&x=1")).toBe("audit");
    expect(sampleFromUrl("?sample=nope")).toBe(null);
    expect(sampleFromUrl("")).toBe(null);
    expect(isSampleKind("close")).toBe(true);
    expect(isSampleKind("bankrec")).toBe(false);
  });
});
