import { describe, expect, it } from "vitest";
import {
  compilePattern,
  extractPattern,
  goalSeek,
  pivotWider,
  removeDuplicates,
  splitDelimited,
  splitFixed,
  textToColumns,
  unpivot,
} from "../src/transform";
import { dateToSerial } from "../src/numfmt";

describe("removeDuplicates", () => {
  const rows = [
    ["Acme", 100, "A"],
    ["acme ", 100, "B"],
    ["Bolt", 50, "C"],
    ["Acme", 100, "D"],
    ["Bolt", "50", "E"],
    [null, null, "F"],
    ["", null, "G"],
  ];

  it("keeps the first of each key by default", () => {
    const r = removeDuplicates(rows, [0, 1]);
    expect(r.kept).toEqual([0, 1, 2, 5]);
    expect(r.removed).toEqual([3, 4, 6]);
    expect(r.keptFor).toEqual([0, 2, 5]);
    expect(r.groups).toBe(3);
  });

  it("treats a number and the same number as text as equal, and blank keys as equal", () => {
    const r = removeDuplicates(rows, [0, 1]);
    expect(r.removed).toContain(4); // "50" vs 50
    expect(r.removed).toContain(6); // "" vs null
  });

  it("ignores case and trims when asked", () => {
    const r = removeDuplicates(rows, [0, 1], { ignoreCase: true, trim: true });
    expect(r.kept).toEqual([0, 2, 5]);
    expect(r.removed).toEqual([1, 3, 4, 6]);
  });

  it("only trims (case still matters)", () => {
    expect(removeDuplicates([["Acme "], ["Acme"], ["ACME"]], [0], { trim: true }).kept).toEqual([0, 2]);
    expect(removeDuplicates([["Acme "], ["Acme"]], [0]).kept).toEqual([0, 1]);
    expect(removeDuplicates([["a  b"], ["a b"]], [0], { trim: true }).kept).toEqual([0]);
  });

  it("keeps the last of each key", () => {
    const r = removeDuplicates(rows, [0, 1], { keep: "last" });
    expect(r.kept).toEqual([1, 3, 4, 6]);
    expect(r.removed).toEqual([0, 2, 5]);
    expect(r.keptFor).toEqual([3, 4, 6]);
  });

  it("uses the whole row when no key columns are given", () => {
    expect(removeDuplicates([[1, "a"], [1, "a"], [1, "b"]], []).kept).toEqual([0, 2]);
  });

  it("handles no rows and booleans", () => {
    expect(removeDuplicates([], [0])).toEqual({ kept: [], removed: [], keptFor: [], groups: 0 });
    expect(removeDuplicates([[true], [true], [false]], [0]).kept).toEqual([0, 2]);
  });

  it("is fast enough for 200,000 rows", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => [`V${i % 1000}`, i % 7]);
    const t = performance.now();
    const r = removeDuplicates(big, [0, 1]);
    expect(r.kept.length).toBe(7000);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("text to columns", () => {
  it("splits by one delimiter, keeping empty pieces", () => {
    expect(splitDelimited("a,b,,c", [","])).toEqual(["a", "b", "", "c"]);
    expect(splitDelimited("a,b,", [","])).toEqual(["a", "b", ""]);
    expect(splitDelimited("", [","])).toEqual([""]);
    expect(splitDelimited("abc", [","])).toEqual(["abc"]);
  });

  it("splits by several delimiters, and longer ones first", () => {
    expect(splitDelimited("a;b\tc,d", [";", "\t", ","])).toEqual(["a", "b", "c", "d"]);
    expect(splitDelimited("x - y-z", ["-", " - "])).toEqual(["x", "y", "z"]);
  });

  it("treats consecutive delimiters as one", () => {
    expect(splitDelimited("a  b   c", [" "], true)).toEqual(["a", "b", "c"]);
    expect(splitDelimited("a,;b", [",", ";"], true)).toEqual(["a", "b"]);
    expect(splitDelimited("a,,", [","], true)).toEqual(["a"]);
  });

  it("keeps delimiters inside quotes, with doubled quotes as one", () => {
    expect(splitDelimited('"Smith, John",42', [","])).toEqual(["Smith, John", "42"]);
    expect(splitDelimited('"He said ""hi""",x', [","])).toEqual(['He said "hi"', "x"]);
    expect(splitDelimited('"open,x', [","])).toEqual(['"open', "x"]);
    expect(splitDelimited('a"b,c', [","])).toEqual(['a"b', "c"]);
    expect(splitDelimited('"a,b",c', [","], false, "")).toEqual(['"a', 'b"', "c"]);
  });

  it("cuts at fixed widths and trims", () => {
    expect(splitFixed("0042  Rent      1200.00", [6, 16])).toEqual(["0042", "Rent", "1200.00"]);
    expect(splitFixed("ab", [5])).toEqual(["ab", ""]);
    expect(splitFixed("abcdef", [4, 2, 2, 0, -1])).toEqual(["ab", "cd", "ef"]);
  });

  it("types the new columns: numbers, dates and text", () => {
    const r = textToColumns(["2024-01-15|1,200.50|Rent", "2024-02-15|(300.00)|Refund", "|  |"], { mode: "delimited", delimiters: ["|"] });
    expect(r.columns.length).toBe(3);
    expect(r.profiles.map((p) => p.type)).toEqual(["date", "number", "text"]);
    expect(r.values[0]).toEqual([dateToSerial(2024, 1, 15), dateToSerial(2024, 2, 15), null]);
    expect(r.values[1]).toEqual([1200.5, -300, null]);
    expect(r.values[2]).toEqual(["Rent", "Refund", null]);
  });

  it("keeps codes with leading zeros as text", () => {
    const r = textToColumns(["0042 Rent", "0101 Rates", "1200 Fees"], { mode: "delimited", delimiters: [" "] });
    expect(r.profiles[0].type).toBe("text");
    expect(r.values[0]).toEqual(["0042", "0101", "1200"]);
  });

  it("pads short rows and keeps values that don't fit the column type as text", () => {
    const r = textToColumns(["1,a", "2", "x,b,c"], { mode: "delimited", delimiters: [","] });
    expect(r.columns).toEqual([
      ["1", "2", "x"],
      ["a", "", "b"],
      ["", "", "c"],
    ]);
    expect(r.profiles[0].type).toBe("number");
    expect(r.values[0]).toEqual([1, 2, "x"]);
  });

  it("works with fixed widths", () => {
    const r = textToColumns(["AB12", "CD34"], { mode: "fixed", breaks: [2] });
    expect(r.values).toEqual([
      ["AB", "CD"],
      [12, 34],
    ]);
  });

  it("reads day-first and month-first dates by the column", () => {
    const r = textToColumns(["03/04/2024;x", "25/12/2024;y"], { mode: "delimited", delimiters: [";"] });
    expect(r.values[0][0]).toBe(dateToSerial(2024, 4, 3));
  });
});

describe("unpivot", () => {
  const header = ["Account", "Name", "Jan", "Feb", "Mar"];
  const rows = [
    ["4000", "Sales", 100, 120, null],
    ["5000", "Rent", 50, "", 50],
  ];

  it("makes one row per value, skipping blanks", () => {
    const r = unpivot(header, rows, [0, 1], [2, 3, 4], { nameColumn: "Month", valueColumn: "Amount" });
    expect(r.header).toEqual(["Account", "Name", "Month", "Amount"]);
    expect(r.rows).toEqual([
      ["4000", "Sales", "Jan", 100],
      ["4000", "Sales", "Feb", 120],
      ["5000", "Rent", "Jan", 50],
      ["5000", "Rent", "Mar", 50],
    ]);
    expect(r.sourceRow).toEqual([0, 0, 1, 1]);
  });

  it("keeps blanks when asked and uses default names", () => {
    const r = unpivot(header, rows, [0], [2, 3, 4], { skipBlanks: false });
    expect(r.header).toEqual(["Account", "Attribute", "Value"]);
    expect(r.rows.length).toBe(6);
    expect(r.rows[2]).toEqual(["4000", "Mar", null]);
  });

  it("works with no ID columns", () => {
    expect(unpivot(["A", "B"], [[1, 2]], [], [0, 1]).rows).toEqual([
      ["A", 1],
      ["B", 2],
    ]);
  });
});

describe("pivotWider", () => {
  const rows = [
    ["4000", "Jan", 100],
    ["4000", "Feb", 120],
    ["5000", "Jan", 50],
    ["4000", "Jan", "1,000.00"],
    ["5000", "Mar", "n/a"],
    ["5000", null, 7],
    [4000, "Feb", null],
  ];

  it("sums by default, in order of first appearance", () => {
    const r = pivotWider(rows, [0], 1, 2);
    expect(r.keys).toEqual([["4000"], ["5000"]]);
    expect(r.columns).toEqual(["Jan", "Feb", "Mar", "(blank)"]);
    expect(r.values).toEqual([
      [1100, 120, null, null],
      [50, null, null, 7],
    ]);
    expect(r.skipped).toBe(1);
  });

  it("matches number and text keys and counts", () => {
    const r = pivotWider(rows, [0], 1, 2, "count");
    expect(r.keys.length).toBe(2); // 4000 the number joins "4000"
    expect(r.values).toEqual([
      [2, 1, 0, 0],
      [1, 0, 1, 1],
    ]);
  });

  it("averages, takes min, max and first", () => {
    expect(pivotWider(rows, [0], 1, 2, "avg").values[0][0]).toBe(550);
    expect(pivotWider(rows, [0], 1, 2, "min").values[0][0]).toBe(100);
    expect(pivotWider(rows, [0], 1, 2, "max").values[0][0]).toBe(1000);
    expect(pivotWider(rows, [0], 1, 2, "first").values[0][0]).toBe(100);
    expect(pivotWider(rows, [0], 1, 2, "first").values[1][2]).toBe("n/a");
  });

  it("uses several row keys", () => {
    const r = pivotWider(
      [
        ["UK", "Sales", "Q1", 1],
        ["UK", "Rent", "Q1", 2],
        ["UK", "Sales", "Q2", 3],
      ],
      [0, 1],
      2,
      3,
    );
    expect(r.keys).toEqual([
      ["UK", "Sales"],
      ["UK", "Rent"],
    ]);
    expect(r.values).toEqual([
      [1, 3],
      [2, null],
    ]);
  });

  it("round-trips an unpivot", () => {
    const header = ["Acct", "Jan", "Feb"];
    const data = [
      ["A", 1, 2],
      ["B", 3, 4],
    ];
    const long = unpivot(header, data, [0], [1, 2]);
    const wide = pivotWider(long.rows, [0], 1, 2, "first");
    expect(wide.columns).toEqual(["Jan", "Feb"]);
    expect(wide.keys.map((k, i) => [...k, ...wide.values[i]])).toEqual(data);
  });
});

describe("extractPattern", () => {
  it("finds emails", () => {
    const r = extractPattern(["Contact jane.doe@acme.co.uk.", "none", null], { kind: "email" });
    expect(r.values).toEqual(["jane.doe@acme.co.uk", null, null]);
    expect(r.matched).toEqual([true, false, false]);
    expect(r.count).toBe(1);
    expect(r.type).toBe("text");
  });

  it("finds phone numbers but not dates or amounts", () => {
    const r = extractPattern(["Call +44 20 7946 0958 today", "tel (555) 123-4567", "on 12/03/2024", "paid 1234.50", "ref 12345"], { kind: "phone" });
    expect(r.values).toEqual(["+44 20 7946 0958", "(555) 123-4567", null, null, null]);
  });

  it("finds URLs without trailing punctuation", () => {
    const r = extractPattern(["see https://example.com/a?b=1.", "www.acme.com, then", "nothing"], { kind: "url" });
    expect(r.values).toEqual(["https://example.com/a?b=1", "www.acme.com", null]);
  });

  it("finds the first number", () => {
    const r = extractPattern(["Qty 1,200 units", "item -3.5 left", "no digits", 42], { kind: "number" });
    expect(r.values).toEqual([1200, -3.5, null, 42]);
    expect(r.type).toBe("number");
  });

  it("finds amounts: currency, decimals, thousands, brackets and CR", () => {
    const r = extractPattern(
      ["Paid $1,234.50 on 2024", "Refund (300.00) issued", "INV 2024 total 99.95", "Fee GBP 75", "Balance 1,000.00 CR", "Year 2024 only", "-$12.00 fee"],
      { kind: "amount" },
    );
    expect(r.values).toEqual([1234.5, -300, 99.95, 75, -1000, null, -12]);
  });

  it("finds dates and guesses day or month first", () => {
    const dmy = extractPattern(["paid 03/04/2024", "due 25/12/2024", "x"], { kind: "date" });
    expect(dmy.values).toEqual([dateToSerial(2024, 4, 3), dateToSerial(2024, 12, 25), null]);
    expect(dmy.type).toBe("date");
    const mdy = extractPattern(["03/04/2024", "12/25/2024"], { kind: "date" });
    expect(mdy.values[0]).toBe(dateToSerial(2024, 3, 4));
    const words = extractPattern(["on 15 Jan 2024", "by March 3rd, 2025", "at 2024-06-30"], { kind: "date" });
    expect(words.values).toEqual([dateToSerial(2024, 1, 15), dateToSerial(2025, 3, 3), dateToSerial(2024, 6, 30)]);
    expect(extractPattern(["31/02/2024"], { kind: "date" }).values).toEqual([null]);
  });

  it("finds invoice-like codes", () => {
    const r = extractPattern(["Payment INV-2024-0012 thanks", "PO#12345 received", "AB12", "Just words 12", "Ref X1"], { kind: "code" });
    expect(r.values).toEqual(["INV-2024-0012", "PO#12345", "AB12", null, null]);
  });

  it("finds the reference after a keyword", () => {
    const r = extractPattern(["BACS Ref: ABC-123 London", "Invoice No. 4471.", "ref#X9", "no keyword"], { kind: "after", keyword: "ref" });
    expect(r.values).toEqual(["ABC-123", null, "X9", null]);
    const inv = extractPattern(["Invoice No. 4471."], { kind: "after", keyword: "Invoice" });
    expect(inv.values).toEqual(["4471"]);
    expect(extractPattern(["a"], { kind: "after", keyword: "  " }).count).toBe(0);
    // whole words only
    expect(extractPattern(["Refund ref: R77", "Reference 12"], { kind: "after", keyword: "ref" }).values).toEqual(["R77", null]);
    expect(extractPattern(["paid #A12"], { kind: "after", keyword: "#" }).values).toEqual(["A12"]);
  });

  it("uses a custom pattern's capture group", () => {
    expect(extractPattern(["Order 123-ABC", "Order 9-Z"], { kind: "regex", regex: "Order (\\d+)" }).values).toEqual(["123", "9"]);
    expect(extractPattern(["abc123"], { kind: "regex", regex: "\\d+" }).values).toEqual(["123"]);
    expect(extractPattern(["ABC"], { kind: "regex", regex: "abc", ignoreCase: false }).values).toEqual([null]);
    expect(() => extractPattern(["x"], { kind: "regex", regex: "(" })).toThrow(/isn't valid/);
    expect(() => compilePattern("")).toThrow(/Type a pattern/);
  });

  it("returns every match when asked", () => {
    const r = extractPattern(["a@x.com and b@y.org"], { kind: "email" }, { all: true });
    expect(r.values).toEqual(["a@x.com; b@y.org"]);
    const n = extractPattern(["1 and 2"], { kind: "number" }, { all: true });
    expect(n.values).toEqual(["1; 2"]);
    expect(n.type).toBe("text");
  });
});

describe("goalSeek", () => {
  it("solves a linear formula in a step or two", () => {
    const r = goalSeek((x) => 3 * x + 2, 20, 0);
    expect(r.converged).toBe(true);
    expect(r.x).toBeCloseTo(6, 9);
    expect(r.iterations).toBeLessThanOrEqual(3);
  });

  it("returns at once when the start already hits the target", () => {
    expect(goalSeek((x) => x * 2, 10, 5)).toMatchObject({ converged: true, x: 5, iterations: 0 });
  });

  it("finds a loan rate (PMT)", () => {
    const pmt = (rate: number) => (1000 * rate) / (1 - (1 + rate) ** -12);
    const r = goalSeek(pmt, 90, 0.01);
    expect(r.converged).toBe(true);
    expect(pmt(r.x)).toBeCloseTo(90, 5);
    expect(r.x).toBeGreaterThan(0.01);
  });

  it("solves a square root and respects the tolerance", () => {
    const r = goalSeek((x) => x * x, 2, 1, { tolerance: 1e-12 });
    expect(r.converged).toBe(true);
    expect(Math.abs(r.x * r.x - 2)).toBeLessThanOrEqual(1e-12);
  });

  it("falls back to bisection on a curve the secant handles badly", () => {
    const f = (x: number) => Math.cbrt(x - 1);
    const r = goalSeek(f, 0.5, 5);
    expect(r.converged).toBe(true);
    expect(r.x).toBeCloseTo(1.125, 6);
  });

  it("finds a bracket when the start is on a flat part", () => {
    const f = (x: number) => (x < 10 ? 0 : x - 10);
    const r = goalSeek(f, 5, 0);
    expect(r.converged).toBe(true);
    expect(r.x).toBeCloseTo(15, 6);
  });

  it("backs off from inputs with no answer", () => {
    const f = (x: number) => (x < 0 ? NaN : Math.sqrt(x));
    const r = goalSeek(f, 3, 1);
    expect(r.converged).toBe(true);
    expect(r.x).toBeCloseTo(9, 6);
  });

  it("reports a target it can't reach", () => {
    const r = goalSeek((x) => x * x + 1, 0, 3, { maxIter: 50 });
    expect(r.converged).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.iterations).toBeLessThanOrEqual(50);
  });

  it("reports a jump over the target", () => {
    const r = goalSeek((x) => (x < 2 ? -1 : 1), 0, 0);
    expect(r.converged).toBe(false);
    expect(r.x).toBeCloseTo(2, 6);
    expect(r.reason).toMatch(/jumps/);
  });

  it("reports a formula that errors at the start, or throws", () => {
    expect(goalSeek(() => NaN, 1, 0).converged).toBe(false);
    expect(
      goalSeek(
        () => {
          throw new Error("x");
        },
        1,
        0,
      ).reason,
    ).toMatch(/starting value/);
  });
});
