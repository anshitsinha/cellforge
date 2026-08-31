import { describe, expect, it } from "vitest";
import { formulaInWords, parseFormula } from "../src";

const say = (f: string) => formulaInWords(parseFormula(f));

describe("formulas in plain English", () => {
  it.each([
    ["=SUM(C2:C10)", "The total of C2:C10."],
    ["=A1*B1", "A1 times B1."],
    ["=(A1+B1)/2", "(A1 plus B1) divided by 2."],
    ['=IF(C2>1000,"Large","Small")', 'If C2 is more than 1000 then "Large", otherwise "Small".'],
    ['=SUMIFS(C:C,A:A,"North",B:B,">=100")', 'The total of C:C where A:A is "North" and B:B is at least 100.'],
    ['=COUNTIF(F2:F200,"Open")', 'How many cells in F2:F200 are "Open".'],
    ['=COUNTIFS(A:A,"North",F:F,"<>")', 'How many rows have A:A is "North" and F:F is not blank.'],
    ["=IFERROR(VLOOKUP(A2,Rates!A:C,3,FALSE),0)", "Look up A2 in the first column of Rates!A:C and take column 3 (exact match), or 0 if that gives an error."],
    ["=XLOOKUP(E2,Customers!A:A,Customers!C:C,\"none\")", 'Look up E2 in Customers!A:A and take the matching value from Customers!C:C, or "none" if it isn\'t found.'],
    ["=INDEX(C:C,MATCH(E2,A:A,0))", "Look up E2 in A:A and take the matching value from C:C."],
    ["=ROUND(C2*1.2,2)", "C2 times 1.2 rounded to 2 decimal places."],
    ["=ROUND(C2,-3)", "C2 rounded to the nearest 1000."],
    ["=EOMONTH(B2,0)", "The last day of the month of B2."],
    ["=-A1", "Minus A1."],
  ])("%s", (f, want) => expect(say(f)).toBe(want));

  it("names cells by their headings when told how", () => {
    const text = formulaInWords(parseFormula("=SUM(C2:C200)"), { label: (_n, t) => (t === "C2:C200" ? "Amount (C2:C200)" : null) });
    expect(text).toBe("The total of Amount (C2:C200).");
  });

  it("falls back to the function's own summary for the rest", () => {
    expect(say("=PMT(0.05/12,360,-200000)")).toMatch(/^PMT\(0\.05 divided by 12, 360, minus 200000\) \(/);
  });
});
