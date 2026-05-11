/**
 * Excel conformance corpus: formulas with the results Excel gives, including
 * its less obvious rules. Each line is a behaviour someone migrating from
 * Excel would trip over if we got it wrong. Values come from Microsoft's
 * documentation and hand-checked cases.
 */
import { describe, expect, it } from "vitest";
import { CellError, evaluate, firstOf, parseFormula, type EvalContext, type Scalar } from "../src/formula";

// A1 = 10, A2 = 20, A3 = TRUE, A4 = "7" (text), A5 empty, B1 = "abc"
const cells: Record<string, Scalar> = { A1: 10, A2: 20, A3: true, A4: "7", B1: "abc" };
const at = (r: number, c: number) => cells[`${String.fromCharCode(65 + c)}${r + 1}`] ?? null;
const ctx: EvalContext = {
  cell: at,
  rowCount: 10,
  colCount: 5,
  eachInRange: (range, visit) => {
    for (let r = range.top; r <= Math.min(range.bottom, 9); r++) for (let c = range.left; c <= range.right; c++) visit(at(r, c));
  },
};

/** What a cell with this formula shows (an empty result shows 0, as in a sheet). */
function shows(formula: string): Scalar {
  const v = firstOf(evaluate(parseFormula(formula), ctx, 0));
  if (v instanceof CellError) return v.code;
  return v === null ? 0 : v;
}

const CORPUS: [string, Scalar, string][] = [
  // rounding and number edge cases
  ["=ROUND(1.005, 2)", 1.01, "decimal rounding, not binary (1.005*100 is 100.4999…)"],
  ["=ROUND(2.675, 2)", 2.68, "same"],
  ["=ROUND(2.5, 0)", 3, "halves away from zero"],
  ["=ROUND(-2.5, 0)", -3, "halves away from zero, negatives too"],
  ["=ROUND(1234.5678, -2)", 1200, "negative digits round to the left"],
  ["=TRUNC(-0.5)", 0, "no negative zero"],
  ["=INT(-0.5)", -1, "INT rounds down, not towards zero"],
  ["=MOD(-3, 2)", 1, "MOD takes the divisor's sign"],
  ["=MOD(3, -2)", -1, "same"],
  ["=MROUND(1.3, 0.2)", 1.4, "no float noise in the result"],
  ["=0.1+0.2=0.3", true, "comparisons use 15 significant digits"],
  ["=1/0", "#DIV/0!", ""],
  ["=SQRT(-4)", "#NUM!", ""],
  // operators
  ["=2^3^2", 64, "^ works left to right in Excel"],
  ["=-2^2", 4, "negation binds tighter than ^"],
  ["=2*3%", 0.06, "% divides by 100"],
  ['="1"+"2"', 3, "text that looks like a number is a number in maths"],
  ['="a"+1', "#VALUE!", ""],
  ["=TRUE+TRUE", 2, "TRUE is 1 in maths"],
  ['=1="1"', false, "a number never equals text"],
  ['="abc"="ABC"', true, "text compares ignoring case"],
  ['="a"<"b"', true, ""],
  ['=2<"1"', true, "numbers sort before text"],
  ['="z"<TRUE', true, "text sorts before TRUE/FALSE"],
  ['=CONCAT("a", TRUE, 1.5)', "aTRUE1.5", "& and CONCAT write TRUE and numbers as shown"],
  // empty cells
  ["=A5", 0, "a reference to an empty cell shows 0"],
  ["=A5=0", true, "empty equals 0"],
  ['=A5=""', true, "and equals empty text"],
  ["=A5+1", 1, ""],
  ["=IF(TRUE,)", 0, "a left-out argument is 0"],
  // aggregates: what counts
  ["=SUM(A1:A5)", 30, "TRUE and text in a range are skipped"],
  ["=SUM(10, TRUE, \"7\")", 18, "typed straight in, they count"],
  ["=COUNT(A1:A5)", 2, ""],
  ['=COUNT(1, "2", TRUE)', 3, "typed straight in, numeric text and TRUE count"],
  ["=COUNT(A3)", 0, "but not from a cell"],
  ["=COUNTA(A1:A5)", 4, "everything but empty"],
  ["=AVERAGE(A1:A5)", 15, "only numbers are averaged"],
  ["=AVERAGE(12, A5)", 12, "an empty cell given directly is skipped"],
  ["=MIN(5, A5)", 5, "same for MIN"],
  ["=MAX(A1:A5)", 20, ""],
  // text
  ['=LEN("")', 0, ""],
  ['=LEFT("abc", 10)', "abc", "asking for more characters than there are is fine"],
  ['=MID("abc", 5, 1)', "", ""],
  ['=FIND("", "abc")', 1, "empty text is found at the start"],
  ['=TRIM("  a   b  ")', "a b", "inner runs of spaces become one"],
  ['=UPPER(B1)&LOWER("X")', "ABCx", ""],
  ['=TEXT(0.5, "0%")', "50%", ""],
  ['=TEXT(1234.567, "#,##0.0")', "1,234.6", ""],
  ['=TEXT(45306, "dddd")', "Monday", "dates are serial numbers"],
  ['=VALUE("1e3")', 1000, ""],
  // dates
  ["=DATE(2024, 2, 30)", 45352, "an overflowing day rolls into the next month"],
  ["=DATE(1900, 3, 1)-DATE(1900, 2, 28)", 2, "Excel's phantom 29 February 1900"],
  ["=DAY(60)", 29, "serial 60 is 29 Feb 1900"],
  ["=WEEKDAY(DATE(2024, 1, 1))", 2, "1 January 2024 was a Monday"],
  ['=EOMONTH("2024-02-10", 0)', 45351, "29 Feb 2024"],
  // logic and errors
  ["=IF(1, \"y\", \"n\")", "y", "any non-zero number is TRUE"],
  ['=IF("x", 1, 2)', "#VALUE!", "text isn't TRUE or FALSE"],
  ["=AND(A1>5, A2>15)", true, ""],
  ["=IFERROR(1/0, \"none\")", "none", ""],
  ["=ISBLANK(A5)", true, ""],
  ["=ISNUMBER(A4)", false, "\"7\" in a cell is text"],
  // lookups
  ["=MATCH(15, A1:A2, 1)", 1, "approximate: the largest value not above it"],
  ["=MATCH(5, A1:A2, 1)", "#N/A", "nothing at or below"],
  ["=VLOOKUP(\"ABC\", B1:B1, 1, FALSE)", "abc", "lookups ignore case"],
  ['=XLOOKUP("zzz", B1:B1, B1:B1, "missing")', "missing", ""],
  ['=COUNTIF(A1:A5, ">=10")', 2, "criteria compare numbers numerically"],
  ['=COUNTIF(B1:B1, "a*")', 1, "and text with wildcards"],
];

describe("Excel conformance", () => {
  it.each(CORPUS)("%s → %s (%s)", (formula, expected) => {
    expect(shows(formula)).toEqual(expected);
  });
});
