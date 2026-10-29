import { describe, expect, it } from "vitest";
import { currencyCode, currencySymbol, formatName } from "./numfmtname";

describe("number format names", () => {
  it.each([
    ["", "General"],
    ["@", "Text"],
    ["#,##0.00", "Number, 2 dp"],
    ["#,##0.00;", "Number, 2 dp"],
    ["#,##0.00;(#,##0.00)", "Number, 2 dp, (negatives)"],
    ["#,##0;[Red](#,##0)", "Number, 0 dp, (negatives)"],
    ["0.000", "Number, 3 dp, no separator"],
    ['_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', "Accounting, 2 dp"],
    ["$#,##0.00", "Currency ($), 2 dp"],
    ["£#,##0.00;(£#,##0.00)", "Currency (£), 2 dp, (negatives)"],
    ['#,##0.00 "€"', "Currency (€), 2 dp"],
    ["0.0%", "Percent, 1 dp"],
    ["0%", "Percent, 0 dp"],
    ["0.00E+00", "Scientific"],
    ["yyyy-mm-dd", "Date"],
    ["dd/mm/yyyy", "Date"],
    ["m/d/yyyy", "Date"],
    ["dddd, mmmm d, yyyy", "Long date"],
    ["h:mm AM/PM", "Time"],
    ["yyyy-mm-dd h:mm", "Date and time"],
    ["[h]:mm:ss", "Duration"],
    ['#,##0,"K"', "Number in thousands"],
    ['#,##0.0,,"M"', "Number in millions"],
  ])("%s → %s", (code, name) => {
    expect(formatName(code)).toEqual({ name, custom: false });
  });

  it("calls anything else Custom (the code goes in the tooltip)", () => {
    expect(formatName('"Ref "@')).toEqual({ name: "Custom", custom: true });
  });

  it("uses the locale's currency", () => {
    expect(currencySymbol("en-GB")).toBe("£");
    expect(currencySymbol("en-US")).toBe("$");
    expect(currencySymbol("de-DE")).toBe("€");
    expect(currencySymbol("en-IN")).toBe("₹");
    expect(currencyCode("en-GB")).toBe("£#,##0.00");
    expect(currencyCode("fr-FR")).toBe('#,##0.00 "€"');
  });
});
