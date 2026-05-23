import { describe, expect, it } from "vitest";
import {
  ageing,
  allocate,
  autoBounds,
  benford,
  chiSquareCdf,
  chiSquareCritical,
  findDuplicates,
  jaroWinkler,
  leadingDigits,
  mulberry32,
  musSample,
  normaliseText,
  pareto,
  randomSample,
  sequenceCode,
  sequenceGaps,
  stratifiedSample,
  stratify,
  systematicSample,
  topN,
  type AuditValue,
} from "../src/audit";
import { dateToSerial } from "../src/numfmt";

const benfordData = (n: number, seed = 1): number[] => {
  // 10^U with U uniform follows Benford's law
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => Math.round(10 ** (1 + rnd() * 5) * 100) / 100);
};

describe("duplicates", () => {
  it("finds exact duplicates on one column and ignores blanks", () => {
    const r = findDuplicates([{ values: ["A", "B", "A", null, "", "B", "C", "A"] }]);
    expect(r.groups.map((g) => g.rows)).toEqual([
      [0, 2, 7],
      [1, 5],
    ]);
    expect(r.groups[0].key).toBe("A");
    expect(r.flagged).toBe(5);
    expect(r.blanks).toBe(2);
  });

  it("needs every key column to match", () => {
    const vendor = ["V1", "V1", "V2", "V1"];
    const amount = [100, 100, 100, 200];
    const r = findDuplicates([{ values: vendor }, { values: amount }]);
    expect(r.groups.map((g) => g.rows)).toEqual([[0, 1]]);
    expect(r.groups[0].key).toBe("V1 | 100");
  });

  it("treats 100 and the text 100 as different in exact mode, the same in number mode", () => {
    expect(findDuplicates([{ values: [100, "100"] }]).groups).toEqual([]);
    expect(findDuplicates([{ values: [100, "100.00"], match: "number" }]).groups.map((g) => g.rows)).toEqual([[0, 1]]);
  });

  it("matches numbers within a tolerance and chains them", () => {
    const r = findDuplicates([{ values: [100, 100.4, 100.9, 300, "1,000.00", 1000.2], match: "number", tolerance: 0.5 }]);
    expect(r.groups.map((g) => g.rows)).toEqual([
      [0, 1, 2],
      [4, 5],
    ]);
  });

  it("matches dates within N days, with an exact vendor", () => {
    const d = (day: number) => dateToSerial(2024, 3, day);
    const vendor = ["Acme", "Acme", "Acme", "Bolt"];
    const date: AuditValue[] = [d(1), "2024-03-03", d(20), d(2)];
    const r = findDuplicates([{ values: vendor }, { values: date, match: "date", tolerance: 3 }]);
    expect(r.groups.map((g) => g.rows)).toEqual([[0, 1]]);
  });

  it("checks two near keys together", () => {
    const amount = [100, 101, 100, 500];
    const date = [dateToSerial(2024, 1, 1), dateToSerial(2024, 1, 2), dateToSerial(2024, 6, 1), dateToSerial(2024, 1, 1)];
    const r = findDuplicates([
      { values: amount, match: "number", tolerance: 1 },
      { values: date, match: "date", tolerance: 5 },
    ]);
    expect(r.groups.map((g) => g.rows)).toEqual([[0, 1]]);
  });

  it("normalises text before comparing", () => {
    expect(normaliseText("  ACME   Ltd. ")).toBe("acme ltd");
    expect(normaliseText("Café & Co")).toBe("cafe and co");
    const r = findDuplicates([{ values: ["Acme Ltd", "ACME LTD.", "acme-ltd", "Acme Inc"], match: "text" }]);
    expect(r.groups.map((g) => g.rows)).toEqual([[0, 1, 2]]);
  });

  it("scores Jaro-Winkler like the textbook", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("finds misspelt names with a similarity threshold", () => {
    const names = ["Jonathan Smith", "Jonathon Smith", "Mary Jones", "The Acme Company", "Acme Company", "Zed"];
    const r = findDuplicates([{ values: names, match: "text", similarity: 0.9 }]);
    expect(r.groups.map((g) => g.rows)).toEqual([[0, 1]]);
    const loose = findDuplicates([{ values: names, match: "text", similarity: 0.75 }]);
    expect(loose.groups.map((g) => g.rows)).toContainEqual([3, 4]);
  });

  it("stays fast on 100k rows of fuzzy text", () => {
    const rnd = mulberry32(7);
    const syll = ["ka", "lo", "mi", "ne", "ru", "sa", "to", "vi", "de", "po", "zu", "ga"];
    const word = () => Array.from({ length: 3 + Math.floor(rnd() * 3) }, () => syll[Math.floor(rnd() * syll.length)]).join("");
    const names = Array.from({ length: 100_000 }, () => `${word()} ${word()} ltd`);
    names[500] = "Kalomi Nerusa Ltd";
    names[90_000] = "Kalomy Nerusa Ltd";
    const t = performance.now();
    const r = findDuplicates([{ values: names, match: "text", similarity: 0.95 }]);
    expect(performance.now() - t).toBeLessThan(15_000);
    expect(r.groups.some((g) => g.rows.includes(500) && g.rows.includes(90_000))).toBe(true);
    // far fewer comparisons than all pairs (5 billion)
    expect(r.comparisons).toBeLessThan(100_000 * 100);
  }, 30_000);
});

describe("sequence gaps", () => {
  it("finds missing ranges, duplicates and out-of-order numbers", () => {
    const r = sequenceGaps([1, 2, 3, 6, 7, 5, 7, 10, null, "x"]);
    expect(r.series).toHaveLength(1);
    const s = r.series[0];
    expect([s.first, s.last, s.count]).toEqual([1, 10, 8]);
    expect(s.missing).toEqual([
      { from: 4, to: 4, count: 1 },
      { from: 8, to: 9, count: 2 },
    ]);
    expect(s.missingCount).toBe(3);
    expect(s.duplicates).toEqual([{ number: 7, rows: [4, 6] }]);
    expect(s.outOfOrder).toEqual([{ row: 5, number: 5, previous: 7 }]);
    expect(r.skipped).toEqual([8, 9]);
  });

  it("reads codes with a number in them, keeping the padding", () => {
    const r = sequenceGaps(["INV-0001", "INV-0002", "INV-0005", "CN-12", "CN-13", "INV-0003"]);
    const inv = r.series.find((s) => s.prefix === "INV-")!;
    expect(inv.width).toBe(4);
    expect(inv.missing).toEqual([{ from: 4, to: 4, count: 1 }]);
    expect(sequenceCode(inv, 4)).toBe("INV-0004");
    const cn = r.series.find((s) => s.prefix === "CN-")!;
    expect(cn.missing).toEqual([]);
    expect(cn.width).toBe(0);
  });

  it("keeps suffixes and treats plain numbers and number text alike", () => {
    const r = sequenceGaps(["100/A", "102/A", 7, "8", 9.5, "12.5"]);
    expect(r.series.find((s) => s.suffix === "/A")!.missing).toEqual([{ from: 101, to: 101, count: 1 }]);
    expect(r.series.find((s) => s.prefix === "" && s.suffix === "")!.count).toBe(2);
    expect(r.skipped).toEqual([4, 5]);
  });
});

describe("Benford", () => {
  it("reads leading digits of any size", () => {
    expect(leadingDigits(1234, false)).toBe(1);
    expect(leadingDigits(-0.0456, true)).toBe(45);
    expect(leadingDigits(19.999999999999996, true)).toBe(20);
    expect(leadingDigits(100, true)).toBe(10);
    expect(leadingDigits(9, false)).toBe(9);
  });

  it("has the textbook expected shares", () => {
    const r = benford([123], "first");
    expect(r.digits[0].expected).toBeCloseTo(0.30103, 5);
    expect(r.digits[8].expected).toBeCloseTo(0.04576, 5);
    expect(r.digits.reduce((a, d) => a + d.expected, 0)).toBeCloseTo(1, 10);
    const two = benford([123], "firstTwo");
    expect(two.digits).toHaveLength(90);
    expect(two.digits[0].digit).toBe(10);
    expect(two.digits[0].expected).toBeCloseTo(0.04139, 5);
  });

  it("says Benford-like data conforms", () => {
    const r = benford(benfordData(20_000), "first");
    expect(r.n).toBe(20_000);
    expect(r.conformity).toBe("close");
    expect(r.mad).toBeLessThan(0.006);
    expect(r.chiSquare).toBeLessThan(r.critical5);
    expect(r.pValue).toBeGreaterThan(0.01);
    const two = benford(benfordData(50_000, 3), "firstTwo");
    expect(["close", "acceptable"]).toContain(two.conformity);
  });

  it("flags made-up numbers and the digits that stand out", () => {
    const rnd = mulberry32(5);
    const fake = Array.from({ length: 5000 }, () => 1000 + Math.floor(rnd() * 9000)); // uniform 1000-9999
    const r = benford(fake, "first");
    expect(r.conformity).toBe("nonconformity");
    expect(r.chiSquare).toBeGreaterThan(r.critical5);
    expect(r.pValue).toBeLessThan(0.001);
    expect(r.digits[0].z).toBeGreaterThan(1.96); // too few 1s
    expect(r.digits[8].z).toBeGreaterThan(1.96); // too many 9s
  });

  it("ignores zeros, blanks, text and (for first-two) values under 10", () => {
    const r = benford([0, null, "", "abc", 5, 12, "1,500", -230], "first");
    expect(r.n).toBe(4);
    expect(r.ignored).toBe(4);
    expect(Array.from(r.rowDigits)).toEqual([-1, -1, -1, -1, 5, 1, 1, 2]);
    const two = benford([5, 9.99, 12, "1,500", -230], "firstTwo");
    expect(two.n).toBe(3);
    expect(two.digits.find((d) => d.digit === 15)!.count).toBe(1);
  });

  it("computes chi-square tails", () => {
    expect(chiSquareCritical(8)).toBeCloseTo(15.507, 2);
    expect(chiSquareCritical(89)).toBeCloseTo(112.022, 1);
    expect(chiSquareCdf(3.841, 1)).toBeCloseTo(0.95, 3);
    expect(chiSquareCdf(0, 4)).toBe(0);
  });

  it("uses the continuity-corrected z", () => {
    // 100 values, all starting with 1: p = 0.30103, actual 1
    const r = benford(Array(100).fill(1), "first");
    const p = Math.log10(2);
    expect(r.digits[0].z).toBeCloseTo((1 - p - 1 / 200) / Math.sqrt((p * (1 - p)) / 100), 6);
  });
});

describe("stratification, top N, Pareto, ageing", () => {
  it("splits into the bands given", () => {
    const r = stratify([50, 999.99, 1000, 5000, 20000, "x", -10], { bounds: [10000, 1000] });
    expect(r.bounds).toEqual([1000, 10000]);
    expect(r.strata.map((s) => [s.label, s.count])).toEqual([
      ["Under 1,000", 3],
      ["1,000 to under 10,000", 2],
      ["10,000 and over", 1],
    ]);
    expect(r.strata[0].total).toBeCloseTo(1039.99, 6);
    expect(r.count).toBe(6);
    expect(r.ignored).toBe(1);
    expect(Array.from(r.rowStratum)).toEqual([0, 0, 1, 1, 2, -1, 0]);
    expect(r.strata.reduce((a, s) => a + s.countShare, 0)).toBeCloseTo(1, 10);
    expect(r.strata.reduce((a, s) => a + s.valueShare, 0)).toBeCloseTo(1, 10);
  });

  it("picks round bands automatically", () => {
    expect(autoBounds(0, 1000, 5)).toEqual([200, 400, 600, 800, 1000]);
    expect(autoBounds(3, 97, 4)).toEqual([25, 50, 75]);
    const r = stratify([3, 40, 97], { bands: 4 });
    expect(r.strata.map((s) => s.count)).toEqual([1, 1, 0, 1]);
    expect(stratify([5, 5]).strata).toHaveLength(1);
  });

  it("lists the largest items with running shares", () => {
    const r = topN([10, -500, 300, null, 190], 2);
    expect(r.items.map((i) => [i.row, i.value])).toEqual([
      [2, 300],
      [4, 190],
    ]);
    expect(r.total).toBe(1000);
    const abs = topN([10, -500, 300, null, 190], 2, { abs: true });
    expect(abs.items.map((i) => i.row)).toEqual([1, 2]);
    expect(abs.items[1].cumulative).toBeCloseTo(0.8, 10);
  });

  it("finds how few vendors make 80% of spend", () => {
    const vendor = ["A", "B", "A", "C", "D", "A", "B"];
    const amount = [500, 200, 200, 50, 50, 100, 100];
    const r = pareto(amount, vendor);
    expect(r.items.map((i) => [i.key, i.total])).toEqual([
      ["A", 800],
      ["B", 300],
      ["C", 50],
      ["D", 50],
    ]);
    expect(r.items[0].rows).toEqual([0, 2, 5]);
    expect(r.items[1].cumulative).toBeCloseTo(1100 / 1200, 10);
    expect(r.itemsToCutoff).toBe(2);
    expect(pareto([100, 0, 0, 0]).itemsToCutoff).toBe(1);
  });

  it("ages items into buckets from an as-of date", () => {
    const asOf = dateToSerial(2024, 12, 31);
    const d = (days: number) => asOf - days;
    const dates: AuditValue[] = [d(0), d(30), d(31), d(60), d(61), d(90), d(91), d(400), d(-5), null, "2024-12-01"];
    const amounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const r = ageing(dates, asOf, { amounts });
    expect(r.buckets.map((b) => b.label)).toEqual(["Not yet due", "0-30", "31-60", "61-90", "Over 90"]);
    expect(r.buckets.map((b) => b.count)).toEqual([1, 3, 2, 2, 2]);
    expect(r.buckets.map((b) => b.total)).toEqual([9, 1 + 2 + 11, 3 + 4, 5 + 6, 7 + 8]);
    expect(r.noDate).toBe(1);
    expect(r.rowDays[10]).toBe(30);
    expect(r.rowBucket[9]).toBe(-1);
    const custom = ageing([d(10), d(100), d(200)], asOf, { limits: [45, 180] });
    expect(custom.buckets.map((b) => [b.label, b.count])).toEqual([
      ["Not yet due", 0],
      ["0-45", 1],
      ["46-180", 1],
      ["Over 180", 1],
    ]);
  });
});

describe("sampling", () => {
  it("draws a reproducible random sample", () => {
    const a = randomSample(1000, 25, 42);
    const b = randomSample(1000, 25, 42);
    expect(a.items).toEqual(b.items);
    expect(a.seed).toBe(42);
    expect(new Set(a.items.map((i) => i.row)).size).toBe(25);
    expect(a.items.every((i, k) => i.row >= 0 && i.row < 1000 && (k === 0 || i.row > a.items[k - 1].row))).toBe(true);
    expect(randomSample(1000, 25, 43).items).not.toEqual(a.items);
    expect(randomSample(5, 10, 1).items).toHaveLength(5);
    expect(randomSample(100, 3).seed).toBeGreaterThan(0);
  });

  it("is roughly uniform", () => {
    const hits = new Array(10).fill(0);
    for (let s = 1; s <= 2000; s++) for (const i of randomSample(10, 1, s).items) hits[i.row]++;
    for (const h of hits) expect(h).toBeGreaterThan(140);
  });

  it("takes every kth row from a random start", () => {
    const r = systematicSample(100, 10, 9);
    expect(r.interval).toBe(10);
    expect(r.items).toHaveLength(10);
    const rows = r.items.map((i) => i.row);
    expect(rows[0]).toBe(r.start);
    for (let k = 1; k < rows.length; k++) expect(rows[k] - rows[k - 1]).toBe(10);
    expect(systematicSample(100, 10, 9)).toEqual(r);
    const odd = systematicSample(10, 3, 2);
    expect(odd.items).toHaveLength(3);
    expect(odd.items.every((i) => i.row < 10)).toBe(true);
  });

  it("allocates a stratified sample in proportion", () => {
    expect(allocate([60, 30, 10], 10)).toEqual([6, 3, 1]);
    expect(allocate([98, 1, 1], 10)).toEqual([8, 1, 1]);
    expect(allocate([3, 0], 10)).toEqual([3, 0]);
    const strata = Array.from({ length: 100 }, (_, i) => (i < 60 ? 0 : i < 90 ? 1 : i < 99 ? 2 : -1));
    const r = stratifiedSample(strata, 10, 3);
    expect(r.strata).toEqual([
      { stratum: 0, population: 60, sample: 6 },
      { stratum: 1, population: 30, sample: 3 },
      { stratum: 2, population: 9, sample: 1 },
    ]);
    expect(r.items.filter((i) => i.reason === "stratum 1")).toHaveLength(6);
    expect(r.items.every((i) => strata[i.row] === Number(i.reason.split(" ")[1]) - 1)).toBe(true);
    expect(stratifiedSample(strata, [1, 0, 2], 3).items).toHaveLength(3);
    expect(stratifiedSample(strata, 10, 3)).toEqual(r);
  });

  it("does monetary-unit sampling with sure-take items", () => {
    const amounts: AuditValue[] = [100, 2500, 300, -50, null, 1200, 400, 600, 900];
    const r = musSample(amounts, { interval: 1000, seed: 11 });
    expect(r.bookValue).toBe(6000);
    expect(r.excluded).toBe(2);
    expect(r.sureTakeValue).toBe(3700);
    const sure = r.items.filter((i) => i.reason === "sure-take").map((i) => i.row);
    expect(sure).toEqual([1, 5]);
    // the rest (2300) walked with a 1000 interval: 2 or 3 hits
    const hits = r.items.filter((i) => i.reason === "interval");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(r.items.map((i) => i.row)).not.toContain(3);
    expect(musSample(amounts, { interval: 1000, seed: 11 })).toEqual(r);
  });

  it("works out the MUS interval from a sample size and hits big items more often", () => {
    const amounts = [10, 10, 10, 10, 960];
    const r = musSample(amounts, { size: 4, seed: 1 });
    expect(r.interval).toBe(250);
    let small = 0;
    for (let s = 1; s <= 500; s++) small += musSample([10, 10, 10, 10, 200], { interval: 100, seed: s }).items.filter((i) => i.row < 4).length;
    // each small item has a 10% chance per draw: about 200 hits over 500 draws
    expect(small).toBeGreaterThan(120);
    expect(small).toBeLessThan(280);
  });
});
