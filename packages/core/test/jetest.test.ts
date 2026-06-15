import { describe, expect, it } from "vitest";
import {
  daysToPeriodEnd,
  detectHeader,
  detectValue,
  footRange,
  guessFootLayout,
  ibanValid,
  jeLines,
  luhn,
  maskValue,
  nameSimilarity,
  normAddress,
  normBank,
  normName,
  normPhone,
  normTaxId,
  parseTimeOfDay,
  protectColumns,
  Pseudonymiser,
  redFlagOverlaps,
  rollForward,
  runJeTests,
  saltedHasher,
  scanPii,
  sha256Hex,
  type JeLine,
  type JeResult,
  type JeTestId,
} from "../src/jetest";
import { dateToSerial } from "../src/numfmt";

const D = (y: number, m: number, d: number, h = 0, mi = 0) => dateToSerial(y, m, d, h, mi);
// 2024-03-04 is a Monday
const MON = D(2024, 3, 4);

function line(p: Partial<JeLine> & { entry: string; amount: number | null }): JeLine {
  return { date: MON, posted: null, time: null, user: "", account: "", description: "", ...p };
}

/** A balanced two-line entry. */
function entry(id: string, amount: number, p: Partial<JeLine> = {}, accounts: [string, string] = ["1000", "2000"]): JeLine[] {
  return [line({ entry: id, amount, account: accounts[0], ...p }), line({ entry: id, amount: -amount, account: accounts[1], ...p })];
}

const flagged = (r: JeResult, test: JeTestId) =>
  r.entries
    .filter((e) => e.flags.some((f) => f.test === test))
    .map((e) => e.id)
    .sort();
const reason = (r: JeResult, id: string, test: JeTestId) => r.entries.find((e) => e.id === id)?.flags.find((f) => f.test === test)?.reason ?? "";

describe("journal lines from columns", () => {
  it("reads dates, times and debit / credit", () => {
    const lines = jeLines({
      entry: ["J1", "J1", null],
      date: ["04/03/2024", D(2024, 3, 4), null],
      posted: ["2024-03-05 19:30", null, null],
      user: ["ann", "ann", null],
      account: [1000, 2000, null],
      debit: [100, null, null],
      credit: [null, "100", null],
      description: ["Accrual", null, null],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0].date).toBe(MON);
    expect(lines[0].posted).toBeCloseTo(D(2024, 3, 5, 19, 30), 6);
    expect(lines[0].time).toBeCloseTo(19.5 / 24, 6);
    expect(lines[0].amount).toBe(100);
    expect(lines[1].amount).toBe(-100);
    expect(lines[1].account).toBe("2000");
    expect(lines[1].time).toBeNull();
    expect(lines[2].amount).toBeNull();
  });

  it("uses a separate time column and negative credits", () => {
    const lines = jeLines({ entry: ["A"], amount: ["1,000.00"], time: ["9:15 PM"] });
    expect(lines[0].time).toBeCloseTo(21.25 / 24, 6);
    expect(lines[0].amount).toBe(1000);
    expect(jeLines({ credit: [-50] })[0].amount).toBe(-50);
  });

  it("parses times of day", () => {
    expect(parseTimeOfDay("07:05")).toBeCloseTo((7 * 60 + 5) / 1440, 8);
    expect(parseTimeOfDay("12:00 am")).toBe(0);
    expect(parseTimeOfDay(0.75)).toBe(0.75);
    expect(parseTimeOfDay(45000.25)).toBe(0.25);
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("soon")).toBeNull();
  });
});

describe("journal entry tests", () => {
  it("groups lines into entries and skips blank lines", () => {
    const r = runJeTests([...entry("J1", 10), line({ entry: "", amount: null, date: null }), ...entry("J2", 5)]);
    expect(r.entries.map((e) => e.id)).toEqual(["J1", "J2"]);
    expect(r.lines).toBe(4);
    expect(r.entries[0].debits).toBe(10);
    expect(r.entries[0].credits).toBe(10);
  });

  it("finds entries that don't balance, within the tolerance", () => {
    const lines = [...entry("OK", 100), line({ entry: "BAD", amount: 100 }), line({ entry: "BAD", amount: -90 }), line({ entry: "PENNY", amount: 0.1 + 0.2 }), line({ entry: "PENNY", amount: -0.3 })];
    const r = runJeTests(lines, { tests: ["unbalanced"] });
    expect(flagged(r, "unbalanced")).toEqual(["BAD"]);
    expect(reason(r, "BAD", "unbalanced")).toContain("Out of balance by 10");
    expect(runJeTests(lines, { tests: ["unbalanced"], tolerance: 20 }).ranked).toHaveLength(0);
  });

  it("skips tests that need columns that aren't there", () => {
    const r = runJeTests([line({ entry: "", amount: 5 })]);
    const s = Object.fromEntries(r.summary.map((x) => [x.test, x.skipped]));
    expect(s.unbalanced).toBe("no entry ids");
    expect(s.duplicates).toBe("no entry ids");
    expect(s.afterHours).toBe("no posting times");
    expect(s.threshold).toBe("no approval limits given");
    expect(s.backdated).toMatch(/posted date/);
    expect(s.rareUser).toBe("no user column");
    expect(s.weekend).toBeUndefined();
    expect(r.noId).toBe(1);
  });

  it("flags weekend and holiday postings", () => {
    const sat = D(2024, 3, 2);
    const xmas = D(2024, 12, 25); // a Wednesday
    const lines = [...entry("WEEKDAY", 1), ...entry("SAT", 1, { date: sat }), ...entry("POSTSUN", 1, { posted: D(2024, 3, 3, 10) }), ...entry("XMAS", 1, { date: xmas })];
    const r = runJeTests(lines, { tests: ["weekend"], holidays: [xmas] });
    expect(flagged(r, "weekend")).toEqual(["POSTSUN", "SAT", "XMAS"]);
    expect(reason(r, "SAT", "weekend")).toBe("Dated on a Saturday, 2024-03-02");
    expect(reason(r, "POSTSUN", "weekend")).toBe("Posted on a Sunday, 2024-03-03");
    expect(reason(r, "XMAS", "weekend")).toBe("Dated on a holiday, 2024-12-25");
    expect(flagged(runJeTests(lines, { tests: ["weekend"], weekendOn: "posted" }), "weekend")).toEqual(["POSTSUN"]);
    // Friday and Saturday weekend
    expect(flagged(runJeTests(lines, { tests: ["weekend"], weekendDays: [5, 6] }), "weekend")).toEqual(["SAT"]);
  });

  it("flags postings outside working hours, including overnight windows", () => {
    const at = (h: number, mi = 0) => ({ posted: D(2024, 3, 4, h, mi) });
    const lines = [...entry("DAY", 1, at(9)), ...entry("LATE", 1, at(22, 15)), ...entry("EARLY", 1, at(6, 59)), ...entry("EDGE", 1, at(18))];
    const r = runJeTests(lines, { tests: ["afterHours"] });
    expect(flagged(r, "afterHours")).toEqual(["EARLY", "EDGE", "LATE"]);
    expect(reason(r, "LATE", "afterHours")).toBe("Posted at 22:15 (working hours 08:00-18:00)");
    const night = runJeTests(lines, { tests: ["afterHours"], hours: { start: 20, end: 7 } });
    expect(flagged(night, "afterHours")).toEqual(["DAY", "EDGE"]);
  });

  it("flags round amounts", () => {
    const lines = [...entry("R", 5000), ...entry("ODD", 5001.5), ...entry("SMALL", 500), ...entry("BIG", 1_200_000)];
    const r = runJeTests(lines, { tests: ["round"] });
    expect(flagged(r, "round")).toEqual(["BIG", "R"]);
    expect(reason(r, "BIG", "round")).toBe("Round amount 1,200,000 (5 trailing zeros)");
    expect(flagged(runJeTests(lines, { tests: ["round"], round: { multiple: 0, zeros: 2 } }), "round")).toEqual(["BIG", "R", "SMALL"]);
    expect(flagged(runJeTests(lines, { tests: ["round"], round: { multiple: 100 } }), "round")).toEqual(["BIG", "R", "SMALL"]);
  });

  it("flags amounts just below an approval limit", () => {
    const lines = [...entry("JUST", 9_950), ...entry("AT", 10_000), ...entry("FAR", 8_000), ...entry("SPLIT", 4_990)];
    const r = runJeTests(lines, { tests: ["threshold"], limits: [10_000, 5_000] });
    expect(flagged(r, "threshold")).toEqual(["JUST", "SPLIT"]);
    expect(reason(r, "JUST", "threshold")).toBe("Total 9,950 is just below the limit of 10,000 (0.5% under)");
    expect(flagged(runJeTests(lines, { tests: ["threshold"], limits: [10_000], margin: 0.25 }), "threshold")).toEqual(["FAR", "JUST"]);
    // per line: a two-line entry of 6,000 + 3,900 debits is 9,900 in all, but no single line is near a limit
    const two = [line({ entry: "T", amount: 6000 }), line({ entry: "T", amount: 3900 }), line({ entry: "T", amount: -9900 })];
    expect(flagged(runJeTests(two, { tests: ["threshold"], limits: [10_000] }), "threshold")).toEqual(["T"]);
    expect(flagged(runJeTests(two, { tests: ["threshold"], limits: [10_000], thresholdBasis: "line" }), "threshold")).toEqual(["T"]); // the 9,900 credit line
    expect(flagged(runJeTests(two.slice(0, 2), { tests: ["threshold"], limits: [10_000], thresholdBasis: "line" }), "threshold")).toEqual([]);
  });

  it("flags unusual users for an account and users with few entries", () => {
    const lines: JeLine[] = [];
    for (let i = 0; i < 12; i++) lines.push(...entry(`A${i}`, 10, { user: i % 2 ? "ann" : "bob" }, ["4000", "1100"]));
    for (let i = 0; i < 12; i++) lines.push(...entry(`C${i}`, 10, { user: "cat" }, ["5000", "1100"]));
    lines.push(...entry("ODD", 10, { user: "cat" }, ["4000", "1100"]));
    lines.push(...entry("NEW", 10, { user: "dan" }, ["5000", "1100"]));
    const r = runJeTests(lines, { tests: ["rareUser"] });
    expect(flagged(r, "rareUser")).toEqual(["NEW", "ODD"]);
    expect(reason(r, "ODD", "rareUser")).toBe("cat posted 1 of 13 lines to 4000");
    expect(reason(r, "NEW", "rareUser")).toBe("dan posted only 1 entry; dan posted 1 of 13 lines to 5000; dan posted 1 of 26 lines to 1100");
    expect(flagged(runJeTests(lines, { tests: ["rareUser"], rare: { userEntries: 0, minAccountLines: 100 } }), "rareUser")).toEqual([]);
  });

  it("flags backdated entries", () => {
    const lines = [...entry("SAME", 1, { posted: MON }), ...entry("OLD", 1, { date: D(2024, 1, 31), posted: D(2024, 3, 15) }), ...entry("NOPOST", 1)];
    const r = runJeTests(lines, { tests: ["backdated"] });
    expect(flagged(r, "backdated")).toEqual(["OLD"]);
    expect(reason(r, "OLD", "backdated")).toBe("Posted 44 days after its date (2024-01-31 posted 2024-03-15)");
    expect(flagged(runJeTests(lines, { tests: ["backdated"], backdatedDays: 60 }), "backdated")).toEqual([]);
  });

  it("flags accounts used in few entries", () => {
    const lines: JeLine[] = [];
    for (let i = 0; i < 6; i++) lines.push(...entry(`E${i}`, 10, {}, ["4000", "1100"]));
    lines.push(...entry("RARE", 10, {}, ["9999", "1100"]));
    const r = runJeTests(lines, { tests: ["seldomAccount"] });
    expect(flagged(r, "seldomAccount")).toEqual(["RARE"]);
    expect(reason(r, "RARE", "seldomAccount")).toBe("Account 9999 is used in only 1 entry");
    expect(r.entries.find((e) => e.id === "RARE")!.flags[0].lines).toHaveLength(1);
  });

  it("flags keywords at the start of words", () => {
    const lines = [...entry("A", 1, { description: "Adjustment per CFO" }), ...entry("B", 1, { description: "Monthly rent" }), ...entry("C", 1, { description: "MISC. plug to TB" }), ...entry("D", 1, { description: "Unreversed item" })];
    const r = runJeTests(lines, { tests: ["keywords"] });
    expect(flagged(r, "keywords")).toEqual(["A", "C"]);
    expect(reason(r, "C", "keywords")).toBe('Description has "plug", "misc": MISC. plug to TB');
    expect(flagged(runJeTests(lines, { tests: ["keywords"], keywords: ["rent"] }), "keywords")).toEqual(["B"]);
  });

  it("works out the days to a period end", () => {
    expect(daysToPeriodEnd(D(2024, 3, 31))).toBe(0);
    expect(daysToPeriodEnd(D(2024, 2, 27))).toBe(2); // leap year
    expect(daysToPeriodEnd(D(2024, 2, 27), "quarter")).toBe(33);
    expect(daysToPeriodEnd(D(2024, 12, 30, 15), "year")).toBe(1);
    expect(daysToPeriodEnd(D(2024, 11, 30), "quarter")).toBe(31);
  });

  it("flags entries near the period end and measures the clustering", () => {
    const lines = [...entry("END", 1, { date: D(2024, 3, 31) }), ...entry("NEAR", 1, { date: D(2024, 3, 29) }), ...entry("MID", 1, { date: D(2024, 3, 15) }), ...entry("OUT", 1, { date: D(2024, 3, 28) })];
    const r = runJeTests(lines, { tests: ["periodEnd"] });
    expect(flagged(r, "periodEnd")).toEqual(["END", "NEAR"]);
    expect(reason(r, "END", "periodEnd")).toBe("Dated 2024-03-31, the month end");
    expect(reason(r, "NEAR", "periodEnd")).toBe("Dated 2024-03-29, 2 days before the month end");
    expect(r.periodEnd!.share).toBe(0.5);
    expect(r.periodEnd!.expected).toBeCloseTo(3 / 30.44, 6);
    expect(flagged(runJeTests(lines, { tests: ["periodEnd"], periodEnd: { period: "quarter", days: 4 } }), "periodEnd")).toEqual(["END", "NEAR", "OUT"]);
  });

  it("flags duplicate entries: same accounts and amounts on the same date", () => {
    const lines = [...entry("D1", 750, {}, ["6000", "2100"]), ...entry("D2", 750, {}, ["6000", "2100"]), ...entry("LATER", 750, { date: MON + 10 }, ["6000", "2100"]), ...entry("OTHER", 750, {}, ["6100", "2100"])];
    const r = runJeTests(lines, { tests: ["duplicates"] });
    expect(flagged(r, "duplicates")).toEqual(["D1", "D2"]);
    expect(reason(r, "D1", "duplicates")).toBe("Same accounts and amounts as D2");
    expect(flagged(runJeTests(lines, { tests: ["duplicates"], duplicates: { days: 10 } }), "duplicates")).toEqual(["D1", "D2", "LATER"]);
    expect(flagged(runJeTests(lines, { tests: ["duplicates"], duplicates: { days: -1 } }), "duplicates")).toEqual(["D1", "D2", "LATER"]);
  });

  it("scores and ranks entries across tests", () => {
    const lines = [
      // unbalanced (5) + round (1) + keyword (2) = 8
      line({ entry: "WORST", amount: 10_000, account: "1000", description: "plug" }),
      line({ entry: "WORST", amount: -9_000, account: "2000", description: "plug" }),
      // weekend (1) + round (1) = 2
      ...entry("SOME", 2_000, { date: D(2024, 3, 2) }),
      // round (1)
      ...entry("ONE", 3_000),
      ...entry("CLEAN", 12.34),
    ];
    const r = runJeTests(lines, { tests: ["unbalanced", "round", "keywords", "weekend"] });
    expect(r.ranked.map((e) => [e.id, e.score])).toEqual([
      ["WORST", 8],
      ["SOME", 2],
      ["ONE", 1],
    ]);
    const s = Object.fromEntries(r.summary.map((x) => [x.test, x.entries]));
    expect(s).toEqual({ unbalanced: 1, round: 3, keywords: 1, weekend: 1 });
    const custom = runJeTests(lines, { tests: ["unbalanced", "round", "keywords", "weekend"], weights: { weekend: 20 } });
    expect(custom.ranked[0].id).toBe("SOME");
  });

  it("runs every test over a larger ledger quickly", () => {
    const lines: JeLine[] = [];
    for (let i = 0; i < 20_000; i++) lines.push(...entry(`J${i}`, 100 + (i % 977), { user: `u${i % 7}`, posted: MON + (i % 40) + 0.4, date: MON + (i % 40) }, [`${4000 + (i % 50)}`, "1100"]));
    const t = performance.now();
    const r = runJeTests(lines, { limits: [10_000] });
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r.entries).toHaveLength(20_000);
    expect(r.summary.find((s) => s.test === "unbalanced")!.entries).toBe(0);
  });
});

describe("red-flag overlaps", () => {
  it("normalises the fields", () => {
    expect(normBank("GB82 WEST 1234 5698 7654 32")).toBe("GB82WEST12345698765432");
    expect(normBank("12-3")).toBe("");
    expect(normTaxId("00-1234567")).toBe("1234567");
    expect(normPhone("+44 (0)20 7946 0018")).toBe(normPhone("020 7946 0018"));
    expect(normPhone("12345")).toBe("");
    expect(normAddress("12 High Street, Suite 4")).toBe(normAddress("12 high st. ste 4"));
    expect(normName("The Acme Company Ltd.")).toBe("acme");
    expect(nameSimilarity("john smith", "smith john")).toBe(1);
    expect(nameSimilarity("jon smith", "john smith")).toBeGreaterThan(0.92);
  });

  it("finds vendors that share details with employees", () => {
    const vendors = [
      { name: "Acme Supplies Ltd", bank: "12345678", address: "1 Mill Road, Leeds", phone: "0113 496 0000", taxId: "GB123456789" },
      { name: "J. Smithe Consulting", bank: "99887766", address: "4 Elm Avenue", phone: "+44 7700 900123", taxId: "" },
      { name: "Northwind", bank: "", address: "", phone: "", taxId: "" },
      { name: "Jonathan Pryce", bank: "55555555" },
    ];
    const employees = [
      { name: "Mary Jones", bank: "12-34-56-78", address: "1 Mill Rd Leeds", phone: "", taxId: "" },
      { name: "John Smith", bank: "11112222", address: "4 Elm Ave.", phone: "07700 900123" },
      { name: "Jonathon Pryce", bank: "" },
    ];
    const r = redFlagOverlaps(vendors, employees);
    const pairs = r.pairs.map((p) => [p.a, p.b, p.matches.map((m) => m.field).sort()]);
    expect(pairs).toEqual([
      [0, 0, ["address", "bank"]],
      [1, 1, ["address", "phone"]],
      [3, 2, ["name"]],
    ]);
    expect(r.byField).toEqual({ bank: 1, taxId: 0, phone: 1, address: 2, name: 1 });
    expect(r.pairs[2].matches[0].similarity).toBeGreaterThan(0.92);
    expect(r.pairs[0].score).toBe(8);
    // only some fields; a looser name match
    const names = redFlagOverlaps(vendors, employees, { fields: ["name"], nameSimilarity: 0.7 });
    expect(names.pairs.length).toBeGreaterThanOrEqual(1);
    expect(names.pairs.every((p) => p.matches.every((m) => m.field === "name"))).toBe(true);
    expect(names.byField.bank).toBe(0);
  });

  it("ignores blanks and too-short values", () => {
    const r = redFlagOverlaps([{ name: "", bank: "", phone: "123" }], [{ name: "", bank: "", phone: "123" }]);
    expect(r.pairs).toEqual([]);
  });
});

describe("footing and cross-footing", () => {
  const block = [
    ["", "Q1", "Q2", "Total"],
    ["Sales", 100, 200, 300],
    ["Costs", -40, "-60", -100],
    ["Other", null, 5, 6],
    ["Total", 60, 145, 206],
  ];

  it("guesses the heading row and label column", () => {
    expect(guessFootLayout(block)).toEqual({ headerRows: 1, labelCols: 1 });
    expect(guessFootLayout([["", 2023, 2024], ["Cash", 1, 2]])).toEqual({ headerRows: 1, labelCols: 1 });
    expect(guessFootLayout([[1, 2], [3, 4]])).toEqual({ headerRows: 0, labelCols: 0 });
  });

  it("finds the rows and columns that don't add up", () => {
    const r = footRange(block, { headerRows: 1, labelCols: 1 });
    expect(r.columns.map((c) => [c.label, c.computed, c.stated, c.ok])).toEqual([
      ["Q1", 60, 60, true],
      ["Q2", 145, 145, true],
      ["Total", 206, 206, true],
    ]);
    expect(r.rows.map((x) => [x.label, x.computed, x.stated, x.difference, x.ok])).toEqual([
      ["Sales", 300, 300, 0, true],
      ["Costs", -100, -100, 0, true],
      ["Other", 5, 6, 1, false],
      ["Total", 205, 206, 1, false],
    ]);
    expect(r.grand).toEqual({ stated: 206, byColumns: 205, byRows: 206, ok: false });
    expect(r.issues).toBe(3);
  });

  it("checks only the totals that are there", () => {
    const r = footRange(
      [
        [1, 2],
        [3, 4],
        [4, 7],
      ],
      { totalCol: false },
    );
    expect(r.rows).toEqual([]);
    expect(r.grand).toBeNull();
    expect(r.columns.map((c) => c.difference)).toEqual([0, 1]);
    expect(r.issues).toBe(1);
    expect(footRange([[0.1, 0.2, 0.3]], { totalRow: false }).issues).toBe(0);
    expect(footRange([[1, 2, null]], { totalRow: false }).rows[0]).toMatchObject({ stated: null, ok: false, difference: -3 });
  });

  it("rolls balances forward", () => {
    const r = rollForward(
      [100, 50, null, "10"],
      [
        { values: [20, 0, null, 5] },
        { values: [10, 5, null, null], sign: -1 },
      ],
      [110, 46, null, 15],
    );
    expect(r.lines.map((l) => [l.index, l.expected, l.closing, l.difference, l.ok])).toEqual([
      [0, 110, 110, 0, true],
      [1, 45, 46, 1, false],
      [3, 15, 15, 0, true],
    ]);
    expect(r.issues).toBe(1);
    expect(r.totals).toEqual({ opening: 160, movements: [25, -15], expected: 170, closing: 171 });
  });
});

describe("personal data scan", () => {
  it("checks IBAN and Luhn checksums", () => {
    expect(ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(ibanValid("GB82 WEST 1234 5698 7654 33")).toBe(false);
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("4111111111111112")).toBe(false);
  });

  it("recognises values", () => {
    expect(detectValue("ann.lee@example.co.uk")).toBe("email");
    expect(detectValue("Contact: bob@example.com")).toBe("email");
    expect(detectValue("GB82 WEST 1234 5698 7654 32")).toBe("iban");
    expect(detectValue("GB82 WEST 1234 5698 7654 33")).not.toBe("iban");
    expect(detectValue("4111 1111 1111 1111")).toBe("card");
    expect(detectValue("4111-1111-1111-1112")).not.toBe("card");
    expect(detectValue(4111111111111111)).toBe("card");
    expect(detectValue(1234567890123)).toBeNull();
    expect(detectValue("123-45-6789")).toBe("ssn");
    expect(detectValue("000-45-6789")).not.toBe("ssn");
    expect(detectValue("AB 12 34 56 C")).toBe("ni");
    expect(detectValue("AB123456D")).toBe("ni");
    expect(detectValue("GB123456A")).toBeNull();
    expect(detectValue("+44 20 7946 0018")).toBe("phone");
    expect(detectValue("(555) 123-4567")).toBe("phone");
    expect(detectValue("07700900123")).toBe("phone");
    expect(detectValue("2024-03-15")).toBeNull();
    expect(detectValue("15/03/2024")).toBeNull();
    expect(detectValue("1,234.50")).toBeNull();
    expect(detectValue(1234.5)).toBeNull();
    expect(detectValue("Rent for March")).toBeNull();
  });

  it("reads column names", () => {
    expect(detectHeader("DOB")).toBe("dob");
    expect(detectHeader("Date of birth")).toBe("dob");
    expect(detectHeader("Employee name")).toBe("name");
    expect(detectHeader("Surname")).toBe("name");
    expect(detectHeader("Employee ID")).toBe("id");
    expect(detectHeader("Home address")).toBe("address");
    expect(detectHeader("Postcode")).toBe("address");
    expect(detectHeader("Mobile")).toBe("phone");
    expect(detectHeader("E-mail")).toBe("email");
    expect(detectHeader("Passport number")).toBe("id");
    expect(detectHeader("Account name")).toBeNull();
    expect(detectHeader("Vendor name")).toBeNull();
    expect(detectHeader("File name")).toBeNull();
    expect(detectHeader("Amount")).toBeNull();
  });

  it("scans columns with counts, examples and a suggested action", () => {
    const r = scanPii([
      { name: "Name", values: ["Ann Lee", "Bob Day", null, "Ann Lee"] },
      { name: "Contact", values: ["ann@example.com", "bob@example.com", "", "0207 946 0018"] },
      { name: "Amount", values: [10, 20, 30, 40] },
      { name: "Birth date", values: [null, null, null, null] },
      { name: "Card", values: ["4111 1111 1111 1111", "5500 0000 0000 0004", "4012888888881881", "4111111111111111"] },
    ]);
    expect(r[0]).toMatchObject({ kind: "name", byHeader: "name", filled: 3, suggested: "pseudonymise", kinds: [] });
    expect(r[1].kind).toBe("email");
    expect(r[1].kinds).toEqual([
      { kind: "email", count: 2, examples: ["ann@example.com", "bob@example.com"] },
      { kind: "phone", count: 1, examples: ["0207 946 0018"] },
    ]);
    expect(r[2]).toMatchObject({ kind: null, suggested: "keep" });
    expect(r[3]).toMatchObject({ kind: null, filled: 0, suggested: "keep" }); // empty: nothing to protect
    expect(r[4]).toMatchObject({ kind: "card", suggested: "mask" });
    expect(r[4].kinds[0]).toMatchObject({ count: 4 });
    expect(r[4].kinds[0].examples).toHaveLength(3);
  });
});

describe("protecting columns", () => {
  const fakeHash = (s: string) => {
    let h = 5381;
    for (const c of s) h = (Math.imul(h, 33) ^ c.charCodeAt(0)) >>> 0;
    return h.toString(16).padStart(8, "0") + "ffff";
  };

  it("masks all but the last 4 letters and digits", () => {
    expect(maskValue("4111 1111 1111 1234")).toBe("**** **** **** 1234");
    expect(maskValue("ann@example.com")).toBe("***@******e.com");
    expect(maskValue("abc")).toBe("abc");
    expect(maskValue("123-45-6789", 0)).toBe("***-**-****");
  });

  it("hashes with a salt, consistently", async () => {
    const h = saltedHasher("s1", fakeHash);
    expect(await h("x")).toBe(fakeHash("s1\u0000x"));
    const r = await protectColumns([{ name: "Id", values: ["A1", "A2", "A1", null, ""], method: "hash" }], { hasher: h, hashLength: 8 });
    expect(r.columns[0][0]).toBe(r.columns[0][2]);
    expect(r.columns[0][0]).not.toBe(r.columns[0][1]);
    expect((r.columns[0][0] as string).length).toBe(8);
    expect(r.columns[0].slice(3)).toEqual([null, null]);
    await expect(protectColumns([{ name: "Id", values: ["x"], method: "hash" }])).rejects.toThrow(/hasher/);
  });

  it("computes real SHA-256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("pseudonymises consistently across columns, with a separate mapping", async () => {
    const ps = new Pseudonymiser();
    const input = ["Ann Lee", "Bob Day", "ann lee ", null];
    const r = await protectColumns(
      [
        { name: "Preparer", values: input, method: "pseudonymise", prefix: "PERSON" },
        { name: "Approver", values: ["Bob Day", "Cy Fox", null, null], method: "pseudonymise", prefix: "PERSON" },
        { name: "Email", values: ["a@x.com", null, null, null], method: "pseudonymise", prefix: "EMAIL" },
      ],
      { pseudonymiser: ps },
    );
    expect(r.columns[0]).toEqual(["PERSON_0001", "PERSON_0002", "PERSON_0001", null]);
    expect(r.columns[1]).toEqual(["PERSON_0002", "PERSON_0003", null, null]);
    expect(r.columns[2][0]).toBe("EMAIL_0001");
    expect(r.mapping).toEqual([
      { column: "Preparer", original: "Ann Lee", token: "PERSON_0001" },
      { column: "Preparer", original: "Bob Day", token: "PERSON_0002" },
      { column: "Approver", original: "Bob Day", token: "PERSON_0002" },
      { column: "Approver", original: "Cy Fox", token: "PERSON_0003" },
      { column: "Email", original: "a@x.com", token: "EMAIL_0001" },
    ]);
    expect(ps.mapping).toHaveLength(4);
    expect(input).toEqual(["Ann Lee", "Bob Day", "ann lee ", null]); // never changed
  });

  it("keeps, masks and redacts", async () => {
    const r = await protectColumns([
      { name: "Amount", values: [1.5, null, "x"], method: "keep" },
      { name: "Phone", values: ["07700 900123", 12345678, null], method: "mask" },
      { name: "DOB", values: ["1980-01-01", 29221, null], method: "redact" },
    ]);
    expect(r.columns).toEqual([
      [1.5, null, "x"],
      ["***** **0123", "****5678", null],
      [null, null, null],
    ]);
    expect(r.mapping).toEqual([]);
  });
});
