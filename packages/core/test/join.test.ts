import { describe, expect, it } from "vitest";
import {
  applyMapping,
  buildMapping,
  compareByKey,
  glToTb,
  join,
  joinDoctor,
  keyPart,
  matchNames,
  nameKey,
  nameSimilarity,
  nameTokens,
  sameValue,
  suggestMapping,
  tbCompare,
  textNumber,
  whyKeys,
  type JoinResult,
  type KeyValue,
} from "../src/join";

const pairs = (r: JoinResult) => Array.from(r.left, (l, i) => [l, r.right[i]]);

describe("join keys", () => {
  it("compares exactly by default: number and text, case and spaces all count", () => {
    expect(keyPart(123)).not.toBe(keyPart("123"));
    expect(keyPart("abc")).not.toBe(keyPart("ABC"));
    expect(keyPart(" a")).not.toBe(keyPart("a"));
    expect(keyPart(null)).toBeNull();
    expect(keyPart("")).toBeNull();
    expect(keyPart(NaN)).toBeNull();
  });
  it("relaxes one thing per option", () => {
    expect(keyPart("  a   b ", { trim: true })).toBe("a b");
    expect(keyPart("   ", { trim: true })).toBeNull();
    expect(keyPart("Abc", { case: true })).toBe("ABC");
    expect(keyPart("00123", { numbers: true })).toBe(keyPart(123, { numbers: true }));
    expect(keyPart("1,234.50", { numbers: true })).toBe(keyPart(1234.5, { numbers: true }));
    expect(keyPart(0.1 + 0.2, { numbers: true })).toBe(keyPart(0.3, { numbers: true }));
    expect(keyPart("AB-12", { punctuation: true })).toBe(keyPart("AB 12", { punctuation: true }));
    expect(keyPart("000123A", { leadingZeros: true })).toBe("123A");
    expect(keyPart("000", { leadingZeros: true })).toBe("0");
    expect(keyPart("INV-000123", { ref: true })).toBe(keyPart(123, { ref: true }));
  });
  it("reads plain numbers from text but not dates or codes", () => {
    expect(textNumber(" 00123 ")).toBe(123);
    expect(textNumber("-1,000.5")).toBe(-1000.5);
    expect(textNumber("2024-01-02")).toBeNull();
    expect(textNumber("A12")).toBeNull();
    expect(textNumber("1,00")).toBeNull();
  });
});

describe("join doctor", () => {
  it("reports match rates, duplicates, orphans and blanks each way", () => {
    const left = [["A", "B", "B", "C", null, "D"]];
    const right = [["A", "B", "E", "E", "E"]];
    const d = joinDoctor(left, right);
    expect(d.left.rows).toBe(6);
    expect(d.left.blank).toBe(1);
    expect(d.left.matchedRows).toBe(3);
    expect(d.left.matchRate).toBeCloseTo(3 / 5);
    expect(d.right.matchedRows).toBe(2);
    expect(d.right.matchRate).toBeCloseTo(2 / 5);
    expect(d.left.duplicateKeys).toBe(1);
    expect(d.left.topDuplicates).toEqual([{ key: "B", count: 2, row: 1 }]);
    expect(d.right.topDuplicates).toEqual([{ key: "E", count: 3, row: 2 }]);
    expect(d.left.orphanKeys).toBe(2);
    expect(d.left.topOrphans.map((o) => o.key)).toEqual(["C", "D"]);
    expect(d.right.topOrphans).toEqual([{ key: "E", count: 3, row: 2 }]);
    expect(d.relationship).toBe("many-to-one");
    expect(d.innerRows).toBe(3);
    expect(d.leftRows).toBe(6);
    expect(d.fixes).toEqual([]);
    expect(d.issues[0]).toMatch(/60\.0% of the left rows and 40\.0% of the right/);
  });

  it("spots numbers against text and says which fix helps by how much", () => {
    const left = [[1, 2, 3, 4]];
    const right = [["00001", "00002", "00003", "x"]];
    const d = joinDoctor(left, right);
    expect(d.left.matchedRows).toBe(0);
    expect(d.typeMismatch).toBe(true);
    expect(d.right.numericText).toBe(3);
    expect(d.fixes[0].option).toBe("numbers");
    expect(d.fixes[0].gainLeft).toBe(3);
    expect(d.fixes[0].gainRight).toBe(3);
    expect(d.fixes[0].matchRateLeft).toBeCloseTo(0.75);
    expect(d.issues.join(" ")).toMatch(/numbers/);
    // with the fix on, nothing more to suggest and no type mismatch
    const e = joinDoctor(left, right, { normalise: { numbers: true } });
    expect(e.left.matchedRows).toBe(3);
    expect(e.typeMismatch).toBe(false);
  });

  it("finds whitespace and case problems and offers all fixes together when that beats any one", () => {
    const left = [["acme ", "Beta", "gamma", "delta"]];
    const right = [["ACME", "beta", "gamma", "Delta"]];
    const d = joinDoctor(left, right);
    expect(d.left.padded).toBe(1);
    expect(d.left.matchedRows).toBe(1);
    const byOpt = Object.fromEntries(d.fixes.map((f) => [f.option, f.gainLeft]));
    expect(byOpt.case).toBe(2);
    expect(byOpt.all).toBe(3);
    expect(byOpt.ref).toBe(3);
    expect(d.fixes[0].option).toBe("all");
    expect(d.issues.join(" ")).toMatch(/spaces/);
  });

  it("estimates fix gains from a sample of keys on very large sides", () => {
    const n = 210_000;
    const left = [Float64Array.from({ length: n }, (_, i) => i)];
    const right = [Array.from({ length: n }, (_, i) => (i < n / 2 ? String(i).padStart(7, "0") : `X${i}`))];
    const d = joinDoctor(left, right);
    expect(d.left.matchedRows).toBe(0);
    const f = d.fixes.find((x) => x.option === "numbers")!;
    expect(f.estimated).toBe(true);
    expect(Math.abs(f.gainLeft - n / 2) / (n / 2)).toBeLessThan(0.05);
  }, 30_000);

  it("handles multi-column keys", () => {
    const left = [
      ["X", "X", "Y"],
      [1, 2, 1],
    ];
    const right = [
      ["X", "Y", "Y"],
      [1, 1, 2],
    ];
    const d = joinDoctor(left, right);
    expect(d.left.matchedRows).toBe(2);
    expect(d.left.topOrphans).toEqual([{ key: "X | 2", count: 1, row: 1 }]);
    expect(d.relationship).toBe("one-to-one");
  });
});

describe("join", () => {
  const L = [["a", "b", "c", null, "b"]];
  const R = [["b", "a", "b", "z"]];

  it("inner join pairs every match, in left order then right order", () => {
    const r = join(L, R, "inner");
    expect(pairs(r)).toEqual([
      [0, 1],
      [1, 0],
      [1, 2],
      [4, 0],
      [4, 2],
    ]);
    expect(r.matchedLeft).toBe(3);
    expect(r.matchedRight).toBe(3);
    expect(r.manyMatched).toBe(2);
    expect([...r.score]).toEqual([1, 1, 1, 1, 1]);
  });

  it("left, right, full and anti joins", () => {
    expect(pairs(join(L, R, "left"))).toEqual([
      [0, 1],
      [1, 0],
      [1, 2],
      [2, -1],
      [3, -1],
      [4, 0],
      [4, 2],
    ]);
    expect(pairs(join(L, R, "full")).slice(-1)).toEqual([[-1, 3]]);
    expect(join(L, R, "full").rows).toBe(8);
    expect(pairs(join(L, R, "anti"))).toEqual([
      [2, -1],
      [3, -1],
    ]);
    expect(pairs(join(L, R, "right"))).toEqual([
      [1, 0],
      [4, 0],
      [0, 1],
      [1, 2],
      [4, 2],
      [-1, 3],
    ]);
  });

  it("one-to-many policies: all, first, flag", () => {
    const first = join(L, R, "left", { many: "first" });
    expect(pairs(first)).toEqual([
      [0, 1],
      [1, 0],
      [2, -1],
      [3, -1],
      [4, 0],
    ]);
    expect([...first.flag]).toEqual([0, 1, 0, 0, 1]);
    const flag = join(L, R, "inner", { many: "flag" });
    expect([...flag.flag]).toEqual([0, 1, 1, 1, 1]);
    expect([...join(L, R, "inner", { many: "all" }).flag]).toEqual([0, 0, 0, 0, 0]);
  });

  it("normalises keys and joins on several columns", () => {
    const l = [
      [" inv-001", "INV-002"],
      ["2024", "2024"],
    ];
    const r = [
      ["1", "2"],
      [2024, 2024],
    ];
    expect(join(l, r, "inner").rows).toBe(0);
    expect(pairs(join(l, r, "inner", { normalise: { ref: true } }))).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("fuzzy matching picks up what exact matching missed", () => {
    const l = [["Acme Trading Ltd", "Globex Corp", "Initech", "Nobody Here"]];
    const r = [["ACME TRADING LIMITED", "Globex Corporation", "Initech", "Umbrella"]];
    const exact = join(l, r, "left");
    expect(exact.matchedLeft).toBe(1);
    const fz = join(l, r, "left", { fuzzy: 0.85, fuzzyNames: true });
    expect(pairs(fz)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, -1],
    ]);
    expect(fz.fuzzyMatched).toBe(2);
    expect(fz.score[0]).toBeLessThanOrEqual(1);
    expect(fz.score[2]).toBe(1);
    expect(fz.matchedRight).toBe(3);
    const txt = join([["Jon Smith"]], [["John Smith"]], "inner", { fuzzy: 0.9 });
    expect(txt.rows).toBe(1);
    expect(txt.score[0]).toBeGreaterThan(0.9);
    expect(txt.score[0]).toBeLessThan(1);
  });

  it("stops at maxRows", () => {
    const r = join([["a", "a", "a"]], [["a", "a", "a"]], "inner", { maxRows: 5 });
    expect(r.rows).toBe(5);
    expect(r.capped).toBe(true);
  });

  it("is hash based: 200K × 200K in a second or two", { timeout: 30_000 }, () => {
    const n = 200_000;
    const a = new Float64Array(n).map((_, i) => i * 3);
    const b = Array.from({ length: n }, (_, i) => String(i * 2));
    const t0 = performance.now();
    const r = join([a], [b], "inner", { normalise: { numbers: true } });
    const ms = performance.now() - t0;
    // multiples of 6 below 2n
    expect(r.rows).toBe(Math.ceil((2 * n) / 6));
    expect(ms).toBeLessThan(8000);
  });
});

describe("why don't these match", () => {
  it("names the smallest fix", () => {
    expect(whyKeys(["ABC"], ["ABC"]).matches).toBe(true);
    const w = whyKeys([123], ["00123"]);
    expect(w.matches).toBe(false);
    expect(w.fix).toEqual(["numbers"]);
    expect(w.reasons[0]).toMatch(/the number 123.*text that looks like a number/);
    expect(whyKeys(["acme "], ["ACME"]).fix).toEqual(["trim", "case"]);
    expect(whyKeys(["INV-0042"], ["42"]).fix).toEqual(["ref"]);
    expect(whyKeys(["Jon Smith"], ["John Smith"]).fix).toBeNull();
    expect(whyKeys(["Jon Smith"], ["John Smith"]).reasons.join(" ")).toMatch(/fuzzy/);
    expect(whyKeys([null], ["x"]).reasons[0]).toMatch(/blank/);
  });
});

describe("compare two versions by key", () => {
  const oldRows: KeyValue[][] = [
    ["K1", "Acme", 100],
    ["K2", "Beta", 200],
    ["K3", "Gamma", 300],
    [null, "no key", 1],
  ];
  const newRows: KeyValue[][] = [
    ["K2", "Beta", 200.004],
    ["K1", "ACME", 150],
    ["K4", "Delta", 400],
  ];
  it("finds added, removed, changed (with old and new) and unchanged", () => {
    const r = compareByKey(oldRows, newRows, [0], [1, 2], { tolerance: 0.01 });
    expect(r.added).toEqual([2]);
    expect(r.removed).toEqual([2]);
    expect(r.unchanged).toBe(1);
    expect(r.changed).toEqual([
      {
        old: 0,
        new: 1,
        key: "K1",
        cells: [
          { col: 1, old: "Acme", new: "ACME", diff: null },
          { col: 2, old: 100, new: 150, diff: 50 },
        ],
      },
    ]);
    expect(r.blankOld).toBe(1);
  });
  it("respects case and tolerance options and pairs duplicates in order", () => {
    const r = compareByKey(oldRows, newRows, [0], [1, 2], { ignoreCase: true });
    expect(r.changed.map((c) => c.cells.map((x) => x.col))).toEqual([[2], [2]]);
    const d = compareByKey(
      [
        ["A", 1],
        ["A", 2],
      ],
      [
        ["A", 1],
        ["A", 3],
        ["A", 4],
      ],
      [0],
      [1],
    );
    expect(d.unchanged).toBe(1);
    expect(d.changed[0].cells[0]).toMatchObject({ old: 2, new: 3 });
    expect(d.added).toEqual([2]);
    expect(d.duplicates).toEqual([
      { side: "old", key: "A", count: 2 },
      { side: "new", key: "A", count: 3 },
    ]);
  });
  it("compares numbers as numbers", () => {
    expect(sameValue(100, "100.00")).toBe(true);
    expect(sameValue("1,000", "1000")).toBe(true);
    expect(sameValue(1, 1.004, { tolerance: 0.005 })).toBe(true);
    expect(sameValue(1, 1.006, { tolerance: 0.005 })).toBe(false);
    expect(sameValue("", null)).toBe(true);
    expect(sameValue("a ", "a", { trim: true })).toBe(true);
    expect(sameValue("a ", "a")).toBe(false);
  });
});

describe("trial balance compare and GL tie-out", () => {
  const cur = [
    { code: "1000", name: "Cash", current: 500 },
    { code: "2000", name: "Payables", current: -300 },
    { code: "4000", name: "Sales", current: -200 },
    { code: "1000", name: "Cash", current: 0 },
  ];
  const pri = [
    { code: "1000", name: "Cash at bank", current: 400 },
    { code: "2000", name: "Payables", current: -400 },
    { code: "3000", name: "Retained earnings", current: 0 },
  ];
  it("compares two TBs by account with movement and missing accounts", () => {
    const r = tbCompare(cur, pri);
    expect(r.lines.map((l) => [l.account, l.a, l.b, l.movement, l.status])).toEqual([
      ["1000", 500, 400, 100, "both"],
      ["2000", -300, -400, 100, "both"],
      ["4000", -200, null, -200, "only A"],
      ["3000", null, 0, 0, "only B"],
    ]);
    expect(r.lines[0].pct).toBeCloseTo(0.25);
    expect(r.lines[0].renamed).toBe("Cash at bank");
    expect(r.onlyA).toEqual(["4000"]);
    expect(r.onlyB).toEqual(["3000"]);
    expect(r.duplicatesA).toEqual(["1000"]);
    expect(r.balancesA).toBe(true);
    expect(r.balancesB).toBe(true);
  });
  it("uses each line's prior when given one TB", () => {
    const r = tbCompare([
      { code: "1", name: "x", current: 10, prior: 4 },
      { code: "2", name: "y", current: -10, prior: null },
    ]);
    expect(r.lines.map((l) => l.movement)).toEqual([6, -10]);
  });
  it("matches account codes ignoring case, spaces and number/text", () => {
    const r = tbCompare([{ code: 1000 as unknown as string, current: 1 }], [{ code: " 1000 ", current: 1 }]);
    expect(r.lines).toHaveLength(1);
  });
  it("ties the GL out to the TB", () => {
    const gl = [
      { account: "1000", debit: 300 },
      { account: "1000", debit: 200 },
      { account: "2000", credit: 300 },
      { account: "4000", amount: -150 },
      { account: "5000", amount: 25 },
      { account: "", amount: 5 },
    ];
    const r = glToTb(gl, cur);
    expect(r.lines.map((l) => [l.account, l.gl, l.tb, l.difference, l.status])).toEqual([
      ["1000", 500, 500, 0, "agrees"],
      ["2000", -300, -300, 0, "agrees"],
      ["4000", -150, -200, 50, "differs"],
      ["5000", 25, null, 25, "only in GL"],
    ]);
    expect(r.lines[0].glLines).toBe(2);
    expect([r.agree, r.differ, r.onlyGl, r.onlyTb]).toEqual([2, 1, 1, 0]);
    expect(r.blankAccounts).toBe(1);
    expect(r.totalDifference).toBe(75);
  });
  it("can tie against the movement", () => {
    const r = glToTb([{ account: "1", amount: 6 }], [
      { code: "1", current: 10, prior: 4 },
      { code: "2", current: 3, prior: 0 },
    ], { against: "movement" });
    expect(r.lines.map((l) => l.status)).toEqual(["agrees", "only in TB"]);
  });
});

describe("fuzzy names", () => {
  it("handles order, titles, legal suffixes and punctuation", () => {
    expect(nameTokens("Smith, John")).toEqual(["JOHN", "SMITH"]);
    expect(nameTokens("Acme, Inc.")).toEqual(["ACME"]);
    expect(nameTokens("Mr. John Smith Jr")).toEqual(["JOHN", "SMITH"]);
    expect(nameTokens("The Acme Co. Ltd")).toEqual(["ACME"]);
    expect(nameTokens("Müller & Söhne GmbH")).toEqual(["MULLER", "AND", "SOHNE"]);
    expect(nameKey("Smith, John")).toBe(nameKey("Mr John Smith"));
  });
  it("scores names whatever the order, with initials", () => {
    expect(nameSimilarity("Smith, John", "John Smith")).toBe(1);
    expect(nameSimilarity("J. Smith", "John Smith")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("John A. Smith", "Smith, John")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("Jon Smith", "John Smith")).toBeGreaterThan(0.9);
    expect(nameSimilarity("Acme Ltd", "ACME LIMITED")).toBe(1);
    expect(nameSimilarity("MacDonald Ltd", "Mac Donald")).toBeGreaterThan(0.95);
    expect(nameSimilarity("John Smith", "Jane Smith")).toBeLessThan(0.85);
    expect(nameSimilarity("Smith", "John Smith")).toBeLessThan(0.85);
    expect(nameSimilarity("John Smith", "Peter Jones")).toBe(0);
    expect(nameSimilarity("J", "John Smith")).toBeLessThanOrEqual(0.5);
  });
  it("finds the best candidate for each name", () => {
    const { matches } = matchNames(["Smith, John", "ACME Inc", "Nobody"], ["Acme Ltd", "John Smith", "Jane Smith"]);
    expect(matches.map((m) => m?.index ?? null)).toEqual([1, 0, null]);
  });
});

describe("mapping tables", () => {
  it("builds a table, reports conflicts and blanks, and maps values", () => {
    const t = buildMapping([
      ["ACME LTD", "Acme Limited"],
      ["acme ltd ", "Acme Holdings"],
      ["Beta", "Beta plc"],
      ["", "x"],
    ]);
    expect(t.conflicts).toEqual([{ from: "ACME LTD", to: ["Acme Limited", "Acme Holdings"] }]);
    expect(t.skipped).toBe(1);
    const r = applyMapping(["Acme Ltd", "beta", "Gamma", null, "Gamma"], t);
    expect(r.values).toEqual(["Acme Limited", "Beta plc", "Gamma", null, "Gamma"]);
    expect(r.mapped).toBe(2);
    expect(r.unmapped).toEqual([{ value: "Gamma", count: 2 }]);
    expect(applyMapping(["Gamma"], t, { keepUnmapped: false }).values).toEqual([null]);
  });
  it("maps exact or by name key, and fuzzily when asked", () => {
    const exact = buildMapping([["Smith, John", "J. Smith (staff)"]], "exact");
    expect(applyMapping(["smith, john"], exact).mapped).toBe(0);
    const byName = buildMapping([["Smith, John", "J. Smith (staff)"]], "name");
    expect(applyMapping(["Mr John Smith"], byName).values).toEqual(["J. Smith (staff)"]);
    const fz = applyMapping(["Jon Smith"], byName, { fuzzy: 0.85 });
    expect(fz.values).toEqual(["J. Smith (staff)"]);
    expect(fz.fuzzy).toBe(1);
  });
  it("suggests pairs from two lists", () => {
    const s = suggestMapping(["Smith, John", "Acme Ltd", "Zed"], ["John Smith", "ACME Limited", "Other"]);
    expect(s.map((x) => [x.from, x.to])).toEqual([
      ["Acme Ltd", "ACME Limited"],
      ["Smith, John", "John Smith"],
    ]);
  });
});
