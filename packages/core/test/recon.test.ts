import { describe, expect, it } from "vitest";
import { explain } from "../src/recon/explain";
import { reconcile, subsetSum, type RecRecord, type RecSettings } from "../src/recon/match";
import { amountKeyingError, isTransposition, jaroWinkler, keyingVariants, normRef, textSimilarity } from "../src/recon/text";

const rec = (row: number, key: string | undefined, amount: number | undefined, date?: number, text?: string): RecRecord => ({ row, key, amount, date, text });
const only = (p: Partial<RecSettings["passes"]>): RecSettings["passes"] => ({
  exact: false,
  tolerance: false,
  reference: false,
  fuzzy: false,
  amountDate: false,
  sum: false,
  ...p,
});

describe("reference normalisation", () => {
  it("drops case, spaces, punctuation, prefixes and leading zeros", () => {
    expect(normRef("INV-000123")).toBe("123");
    expect(normRef("inv 123")).toBe("123");
    expect(normRef("#123")).toBe("123");
    expect(normRef("Ref: 0045/A")).toBe("45A");
    expect(normRef("INV/2024/0012")).toBe("20240012");
    expect(normRef("000")).toBe("0");
    expect(normRef("")).toBe("");
  });
  it("only drops a prefix that isn't the start of a word", () => {
    expect(normRef("INVENTORY1")).toBe("INVENTORY1");
    expect(normRef("INVOICE 77")).toBe("77");
    expect(normRef("PO12", ["PO"])).toBe("12");
    expect(normRef("PO12", [])).toBe("PO12");
  });
});

describe("text similarity", () => {
  it("scores Jaro-Winkler like the textbook", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.813, 3);
    expect(jaroWinkler("", "A")).toBe(0);
    expect(jaroWinkler("ABC", "ABC")).toBe(1);
  });
  it("ignores word order and punctuation", () => {
    expect(textSimilarity("Smith, John", "JOHN SMITH")).toBe(1);
    expect(textSimilarity("Acme Ltd payment", "ACME LTD PAYMNT")).toBeGreaterThan(0.9);
    expect(textSimilarity("Acme", "Globex")).toBeLessThan(0.6);
  });
});

describe("keying errors", () => {
  it("classifies amount errors", () => {
    expect(amountKeyingError(1234, 1243)).toBe("transposition");
    expect(amountKeyingError(12.34, 12.43)).toBe("transposition");
    expect(amountKeyingError(1234, 1284)).toBe("digit slip");
    expect(amountKeyingError(1500, 150)).toBe("x10");
    expect(amountKeyingError(15, 1500)).toBe("/100");
    expect(amountKeyingError(-80, 80)).toBe("sign flip");
    expect(amountKeyingError(100, 250)).toBeNull();
    expect(amountKeyingError(100, 100)).toBeNull();
  });
  it("lists variants that classify back to the same error", () => {
    for (const c of [123456, -9050, 100, 7]) {
      for (const [v, kind] of keyingVariants(c)) expect(amountKeyingError(c / 100, v / 100)).toBe(kind);
    }
  });
  it("spots transposed references", () => {
    expect(isTransposition("1234", "1243")).toBe(true);
    expect(isTransposition("1234", "1234")).toBe(false);
    expect(isTransposition("1234", "4231")).toBe(false);
  });
});

describe("subset sums", () => {
  const amt = (j: number) => [10, 20, 30, 45.5, 4.5, 100][j];
  it("finds 2 and 3 item sums", () => {
    expect(subsetSum([0, 1, 2, 3, 4, 5], amt, 50, 1e-7, 2, 1000).items!.map(amt).sort((a, b) => a - b)).toEqual([4.5, 45.5]);
    expect(subsetSum([0, 1, 2], amt, 60, 1e-7, 3, 1000).items!.map(amt).sort((a, b) => a - b)).toEqual([10, 20, 30]);
    expect(subsetSum([0, 1, 2], amt, 60, 1e-7, 2, 1000).items).toBeNull();
  });
  it("stops at the cap and says so", () => {
    const r = subsetSum([0, 1, 2, 3, 4], amt, 9999, 1e-7, 4, 3);
    expect(r.items).toBeNull();
    expect(r.capped).toBe(true);
  });
  it("handles mixed signs", () => {
    const v = [-30, 50, 80, 5];
    expect(subsetSum([0, 1, 2, 3], (j) => v[j], 20, 1e-7, 2, 1000).items!.map((j) => v[j]).sort((a, b) => a - b)).toEqual([-30, 50]);
  });
});

describe("reconcile", () => {
  it("matches exact key and amount, preferring the nearest date", () => {
    const a = [rec(2, "A1", 100, 45000), rec(3, "A2", 50, 45000)];
    const b = [rec(2, "A1", 100, 45010), rec(3, "A1", 100, 45001), rec(4, "A2", 50, 45000)];
    const r = reconcile(a, b, { passes: only({ exact: true }) });
    expect(r.matches.map((m) => [m.rule, m.a, m.b])).toEqual([
      ["exact", [0], [1]],
      ["exact", [1], [2]],
    ]);
    expect(r.unmatchedB).toEqual([0]);
    expect(r.summary.byRule.exact).toBe(2);
    expect(r.summary.matchRate).toBeCloseTo(4 / 5);
  });

  it("matches within an amount tolerance and date window", () => {
    const a = [rec(2, "X", 100, 45000), rec(3, "Y", 200, 45000), rec(4, "Z", 300, 45000)];
    const b = [rec(2, "X", 100.4, 45002), rec(3, "Y", 200, 45009), rec(4, "Z", 303, 45000)];
    const r = reconcile(a, b, { amountTolerance: 0.5, dateWindow: 3, passes: only({ tolerance: true }) });
    expect(r.matches).toEqual([{ rule: "tolerance", a: [0], b: [0], amountDiff: -0.4, days: 2 }]);
    // Y is outside the window, Z beyond tolerance: both mismatched (same key)
    expect(r.mismatched.map((m) => [m.a, m.b, m.amountDiff, m.days])).toEqual([
      [1, 1, 0, 9],
      [2, 2, -3, 0],
    ]);
    expect(r.unmatchedA).toEqual([]);
  });

  it("uses a percentage tolerance", () => {
    const r = reconcile([rec(1, "K", 1000)], [rec(1, "K", 1004)], { amountTolerancePct: 0.5, passes: only({ tolerance: true }) });
    expect(r.matches[0]?.rule).toBe("tolerance");
    const r2 = reconcile([rec(1, "K", 1000)], [rec(1, "K", 1006)], { amountTolerancePct: 0.5, passes: only({ tolerance: true }) });
    expect(r2.matches).toEqual([]);
  });

  it("ignores dates when the window is off", () => {
    const r = reconcile([rec(1, "K", 10, 45000)], [rec(1, "K", 10, 46000)], { dateWindow: null, passes: only({ tolerance: true }) });
    expect(r.matches[0]?.days).toBe(1000);
  });

  it("matches normalised references", () => {
    const a = [rec(2, "INV-000123", 10), rec(3, "abc 9", 20)];
    const b = [rec(2, "123", 10), rec(3, "ABC9", 20)];
    const r = reconcile(a, b, { passes: only({ exact: true, reference: true }) });
    expect(r.matches.map((m) => m.rule)).toEqual(["reference", "reference"]);
  });

  it("flips B's sign when asked", () => {
    const r = reconcile([rec(1, "K", 10)], [rec(1, "K", -10)], { flipB: true });
    expect(r.matches[0]).toMatchObject({ rule: "exact", amountDiff: 0 });
  });

  it("matches by fuzzy description within amount and date", () => {
    const a = [rec(2, undefined, 99.99, 45000, "ACME LTD INVOICE PAYMENT"), rec(3, undefined, 10, 45000, "Globex")];
    const b = [rec(2, undefined, 99.99, 45001, "Acme Limited invoice payment"), rec(3, undefined, 99.99, 45001, "Initech"), rec(4, undefined, 10, 45000, "Umbrella")];
    const r = reconcile(a, b, { fuzzyThreshold: 0.8, passes: only({ fuzzy: true }) });
    expect(r.matches.length).toBe(1);
    expect(r.matches[0]).toMatchObject({ rule: "fuzzy", a: [0], b: [0] });
    expect(r.matches[0].score).toBeGreaterThan(0.8);
  });

  it("matches on amount and date alone, not across different references", () => {
    const a = [rec(2, undefined, 50, 45000), rec(3, "R1", 70, 45000)];
    const b = [rec(2, undefined, 50, 45020), rec(3, undefined, 50, 45002), rec(4, "R2", 70, 45000)];
    const r = reconcile(a, b, { dateWindow: 5, passes: only({ amountDate: true }) });
    expect(r.matches.map((m) => [m.a[0], m.b[0]])).toEqual([[0, 1]]);
    expect(r.unmatchedA).toEqual([1]);
  });

  it("finds the in-window match among many of the same amount", () => {
    const b = Array.from({ length: 5000 }, (_, j) => rec(j, undefined, 25, 40000 + j));
    const r = reconcile([rec(1, undefined, 25, 44000)], b, { dateWindow: 0, passes: only({ amountDate: true }) });
    expect(r.matches[0].b).toEqual([4000]);
  });

  it("matches one to many and many to one", () => {
    const a = [rec(2, "P1", 300, 45000), rec(3, undefined, 40, 45010), rec(4, undefined, 60, 45010)];
    const b = [rec(2, "P1", 100, 45001), rec(3, "P1", 200, 45002), rec(4, undefined, 100, 45010), rec(5, undefined, 999, 45010)];
    const r = reconcile(a, b, { passes: only({ sum: true }) });
    expect(r.matches.map((m) => [m.rule, m.a, m.b, m.amountDiff, m.days])).toEqual([
      ["one-to-many", [0], [0, 1], 0, 2],
      ["many-to-one", [1, 2], [2], 0, 0],
    ]);
    expect(r.unmatchedB).toEqual([3]);
  });

  it("reports items whose sum search hit the cap", () => {
    const b = Array.from({ length: 30 }, (_, j) => rec(j, "K", 1 + j * 0.37));
    const r = reconcile([rec(1, "K", 12345)], b, { passes: only({ sum: true }), sumMaxItems: 5, sumStepCap: 50 });
    expect(r.matches).toEqual([]);
    expect(r.sumCapped).toEqual([{ side: "A", item: 0 }]);
  });

  it("runs the passes in order, each on what's left", () => {
    const a = [rec(1, "K1", 10), rec(2, "k-1", 10.2), rec(3, "Z9", 30)];
    const b = [rec(1, "K1", 10), rec(2, "K1", 10.2), rec(3, "Z9", 10), rec(4, "Z9", 20)];
    const r = reconcile(a, b, { amountTolerance: 0.01 });
    expect(r.matches.map((m) => m.rule)).toEqual(["exact", "reference", "one-to-many"]);
    expect(r.summary.matchRate).toBe(1);
  });

  it("lists duplicates within each side", () => {
    const a = [rec(1, "K1", 10, 45000), rec(2, "k 1", 10, 45000), rec(3, "K1", 10, 45001), rec(4, undefined, 5, 45000, "fee"), rec(5, undefined, 5, 45000, "Fee")];
    const r = reconcile(a, [], {});
    expect(r.duplicates).toEqual([
      { side: "A", items: [0, 1] },
      { side: "A", items: [3, 4] },
    ]);
    expect(r.summary.duplicatesA).toBe(2);
  });

  it("flags keying errors on mismatched and unmatched items", () => {
    const a = [rec(1, "K1", 1234, 45000), rec(2, undefined, 500, 45000), rec(3, "R12", 77, 45000), rec(4, undefined, 81.5, 45000)];
    const b = [rec(1, "K1", 1243, 45000), rec(2, undefined, -500, 45000), rec(3, "R21", 77, 45000), rec(4, undefined, 8.15, 45000)];
    const r = reconcile(a, b, { passes: only({ exact: true }) });
    expect(r.mismatched.map((m) => [m.a, m.b, m.amountDiff])).toEqual([[0, 0, -9]]);
    expect(r.flags.map((f) => [f.a, f.b, f.field, f.kind, f.mismatched])).toEqual([
      [0, 0, "amount", "transposition", true],
      [1, 1, "amount", "sign flip", false],
      [2, 2, "key", "transposition", false],
      [3, 3, "amount", "x10", false],
    ]);
  });

  it("summarises unmatched totals", () => {
    const r = reconcile([rec(1, "A", 10), rec(2, "B", 5.5)], [rec(1, "A", 10), rec(2, "C", 1.25)], { passes: only({ exact: true }) });
    expect(r.summary).toMatchObject({ countA: 2, countB: 2, matchedA: 1, matchedB: 1, unmatchedA: 1, unmatchedB: 1, unmatchedTotalA: 5.5, unmatchedTotalB: 1.25 });
  });

  it("matches on keys alone when there are no amounts", () => {
    const r = reconcile([rec(1, "A", undefined), rec(2, "B", undefined)], [rec(1, "b", undefined), rec(2, "A", undefined)], {});
    expect(r.matches.map((m) => [m.rule, m.a[0], m.b[0]])).toEqual([
      ["exact", 0, 1],
      ["reference", 1, 0],
    ]);
  });

  it("handles 100k x 100k in seconds", () => {
    const n = 100_000;
    let seed = 7;
    // mulberry32
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const a: RecRecord[] = [];
    const b: RecRecord[] = [];
    for (let i = 0; i < n; i++) {
      const amount = Math.round(rand() * 1_000_000) / 100;
      const date = 45000 + Math.floor(rand() * 60);
      const kind = i % 10;
      a.push(rec(i, `INV${100000 + i}`, amount, date, `Customer ${i % 997} payment`));
      if (kind < 5) b.push(rec(i, `INV${100000 + i}`, amount, date + (kind % 3)));
      else if (kind === 5) b.push(rec(i, `inv-0${100000 + i}`, amount, date));
      else if (kind === 6) b.push(rec(i, undefined, amount, date + 1, `CUSTOMER ${i % 997} PAYMENT`));
      else if (kind === 7) {
        const half = Math.round(amount * 50) / 100;
        b.push(rec(i, `INV${100000 + i}`, half, date), rec(i, `INV${100000 + i}`, Math.round((amount - half) * 100) / 100, date + 1));
      } else if (kind === 8) b.push(rec(i, `INV${100000 + i}`, amount + 7, date));
      else b.push(rec(i, `X${i}`, Math.round(rand() * 1_000_000) / 100, date));
    }
    const t0 = performance.now();
    const r = reconcile(a, b, { dateWindow: 3 });
    const ms = performance.now() - t0;
    console.log(`recon 100k x ${b.length}: ${Math.round(ms)} ms, rate ${(r.summary.matchRate * 100).toFixed(1)}%`, r.summary.byRule);
    expect(r.summary.byRule.exact).toBeGreaterThanOrEqual(n * 0.5 - 10);
    expect(r.summary.byRule.reference).toBeGreaterThanOrEqual(n * 0.1 - 10);
    expect(r.summary.byRule["one-to-many"]).toBeGreaterThanOrEqual(n * 0.1 - 50);
    expect(r.summary.mismatched).toBeGreaterThanOrEqual(n * 0.1 - 50);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it("handles 100k x 100k bank-style (no references) in seconds", () => {
    const n = 100_000;
    let seed = 11;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const a: RecRecord[] = [];
    const b: RecRecord[] = [];
    for (let i = 0; i < n; i++) {
      // lots of repeated round amounts, all in one month
      const amount = rand() < 0.3 ? Math.round(rand() * 20) * 50 : Math.round(rand() * 500_000) / 100;
      const date = 45000 + Math.floor(rand() * 30);
      a.push(rec(i, undefined, amount, date));
      const r = rand();
      if (r < 0.9) b.push(rec(i, undefined, -amount, date + Math.floor(rand() * 3)));
      else if (r < 0.95) b.push(rec(i, undefined, Math.round(rand() * 500_000) / -100, date));
    }
    const t0 = performance.now();
    const r = reconcile(a, b, { dateWindow: 3, flipB: true });
    const ms = performance.now() - t0;
    console.log(`bank-style 100k x ${b.length}: ${Math.round(ms)} ms, rate ${(r.summary.matchRate * 100).toFixed(1)}%, budget out ${r.sumBudgetExhausted}`, r.summary.byRule);
    expect(r.summary.byRule["amount+date"]).toBeGreaterThan(n * 0.85);
    expect(ms).toBeLessThan(30_000);
  }, 90_000);
});

describe("explain", () => {
  it("names case, spaces, prefix and leading-zero differences and suggests normalising", () => {
    const e = explain(rec(1, "inv 00123", 10), rec(1, "INV123", 10), { passes: only({ exact: true }) });
    expect(e.rule).toBeNull();
    expect(e.reasons.map((r) => r.kind)).toEqual(["case", "spaces", "leading zeros"]);
    expect(e.normalised).toEqual(["123", "123"]);
    expect(e.suggestion?.settings.passes?.reference).toBe(true);
    expect(e.suggestion?.rule).toBe("reference");
  });
  it("spots a prefix and punctuation", () => {
    const e = explain(rec(1, "REF-0045", 10), rec(1, "45", 10), { passes: only({ exact: true }) });
    expect(e.reasons.map((r) => r.kind)).toEqual(["punctuation", "prefix", "leading zeros"]);
    expect(e.reasons[1].text).toContain("REF");
  });
  it("explains a date gap and suggests a wider window", () => {
    const e = explain(rec(1, "K", 10, 45000), rec(1, "K", 10.5, 45006), { amountTolerance: 1, dateWindow: 3 });
    expect(e.rule).toBeNull();
    expect(e.reasons.map((r) => r.kind)).toEqual(["date"]);
    expect(e.suggestion).toMatchObject({ settings: { dateWindow: 6 }, rule: "tolerance" });
  });
  it("explains a sign flip", () => {
    const e = explain(rec(1, "K", 10), rec(1, "K", -10));
    expect(e.reasons.map((r) => r.kind)).toEqual(["sign"]);
    expect(e.suggestion?.settings.flipB).toBe(true);
    expect(e.suggestion?.rule).toBe("exact");
  });
  it("explains a transposed amount and a small difference", () => {
    expect(explain(rec(1, "K", 1234), rec(1, "K", 1243)).reasons.map((r) => r.kind)).toEqual(["amount transposition"]);
    const e = explain(rec(1, "K", 100), rec(1, "K", 100.3));
    expect(e.reasons[0].kind).toBe("amount");
    expect(e.suggestion).toMatchObject({ settings: { amountTolerance: 0.3 }, rule: "tolerance" });
  });
  it("explains transposed references", () => {
    expect(explain(rec(1, "1234", 5), rec(1, "1243", 5)).reasons.map((r) => r.kind)).toEqual(["key transposition"]);
  });
  it("says how they match when they do", () => {
    const e = explain(rec(1, "K", 5), rec(1, "k", 5));
    expect(e.rule).toBe("reference");
    expect(e.reasons.map((r) => r.kind)).toEqual(["case"]);
    expect(e.suggestion).toBeNull();
  });
});
