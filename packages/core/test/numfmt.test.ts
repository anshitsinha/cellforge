import { describe, expect, it } from "vitest";
import { dateToSerial, formatGeneral, formatValue, isDateFormat, parseTyped } from "../src/numfmt";

const f = (v: number | string, code: string) => formatValue(v, code).text;

// expected values are what Excel (en-US) shows
describe("number format codes", () => {
  it.each([
    [1234.567, "0", "1235"],
    [1234.567, "0.00", "1234.57"],
    [1234.567, "#,##0", "1,235"],
    [1234.567, "#,##0.00", "1,234.57"],
    [0.5, "#,##0.00", "0.50"],
    [0.5, "#.##", ".5"],
    [1.005, "0.00", "1.01"],
    [2.5, "0", "3"],
    [-2.5, "0", "-3"],
    [0.125, "0%", "13%"],
    [0.125, "0.0%", "12.5%"],
    [1234567, '#,##0,"K"', "1,235K"],
    [1234567, '#,##0.0,,"M"', "1.2M"],
    [12, "000", "012"],
    [5, "?.??", "5.  "],
    [12345.678, "0.00E+00", "1.23E+04"],
    [0.000123, "0.00E+00", "1.23E-04"],
    [12345, "##0.0E+0", "12.3E+3"],
    [1234.5, "$#,##0.00", "$1,234.50"],
    [-1234.5, "$#,##0.00", "-$1,234.50"],
    [-1234.5, "#,##0.00;(#,##0.00)", "(1,234.50)"],
    [0, '#,##0.00;(#,##0.00);"-"', "-"],
    [-0.001, "0.00", "0.00"],
    [42, '"Total: "0', "Total: 42"],
    [42, "0\\ \\h", "42 h"],
    [1500, "[>=1000]#,##0,\"K\";0", "2K"],
    [500, "[>=1000]#,##0,\"K\";0", "500"],
  ])("%s with %s -> %s", (v, code, want) => {
    expect(f(v, code)).toBe(want);
  });

  it("accounting: $ on the left, negatives in parentheses, zero as a dash", () => {
    const acct = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
    expect(f(1234.5, acct)).toBe(" $ 1,234.50 ");
    expect(f(-1234.5, acct)).toBe(" $ (1,234.50)");
    expect(f(0, acct)).toBe(" $ -   ");
    expect(f("note", acct)).toBe(" note ");
  });

  it("colours come from the section", () => {
    expect(formatValue(-5, "0;[Red]-0")).toEqual({ text: "-5", color: "#ff0000" });
    expect(formatValue(5, "0;[Red]-0").color).toBeUndefined();
  });

  it("text sections", () => {
    expect(f("abc", '0;-0;0;"<"@">"')).toBe("<abc>");
    expect(f("abc", "0.00")).toBe("abc");
    expect(f(3, "@")).toBe("3");
  });
});

describe("General", () => {
  it.each([
    [0, "0"],
    [123, "123"],
    [-1.5, "-1.5"],
    [0.1 + 0.2, "0.3"],
    [1 / 3, "0.333333333"],
    [123456.789012345, "123456.789"],
    [12345678901, "12345678901"],
    [123456789012, "1.23457E+11"],
    [0.0000000001, "1E-10"],
  ])("%s -> %s", (v, want) => {
    expect(formatGeneral(v)).toBe(want);
  });
});

describe("dates and times", () => {
  it("serials match Excel's 1900 system, fake leap day included", () => {
    expect(dateToSerial(1900, 1, 1)).toBe(1);
    expect(dateToSerial(1900, 2, 28)).toBe(59);
    expect(dateToSerial(1900, 3, 1)).toBe(61);
    expect(dateToSerial(2024, 1, 15)).toBe(45306);
    expect(f(60, "yyyy-mm-dd")).toBe("1900-02-29");
    expect(f(61, "yyyy-mm-dd")).toBe("1900-03-01");
  });

  it.each([
    [45306, "yyyy-mm-dd", "2024-01-15"],
    [45306, "m/d/yyyy", "1/15/2024"],
    [45306, "d-mmm-yy", "15-Jan-24"],
    [45306, "dddd, mmmm d, yyyy", "Monday, January 15, 2024"],
    [45306, "mmm yyyy", "Jan 2024"],
    [45306.75, "h:mm AM/PM", "6:00 PM"],
    [45306.5, "hh:mm:ss", "12:00:00"],
    [45306 + 1 / 1440 * 61, "h:mm", "1:01"],
    [1.5, "[h]:mm", "36:00"],
    [0.000694444, "[mm]:ss", "01:00"],
    [45306.25, "yyyy-mm-dd hh:mm", "2024-01-15 06:00"],
    [45306.123456, "hh:mm:ss.000", "02:57:46.598"],
  ])("%s with %s -> %s", (v, code, want) => {
    expect(f(v, code)).toBe(want);
  });

  it("knows date codes", () => {
    expect(isDateFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateFormat("[h]:mm")).toBe(true);
    expect(isDateFormat("#,##0.00")).toBe(false);
    expect(isDateFormat('0.0 "days"')).toBe(false);
  });
});

describe("typed input", () => {
  it.each([
    ["12%", 0.12, "0%"],
    ["12.5%", 0.125, "0.0%"],
    ["$1,234.50", 1234.5, "$#,##0.00"],
    ["-$20", -20, "$#,##0"],
    ["($20)", -20, "$#,##0;($#,##0)"],
    ["€5", 5, '"€"#,##0'],
    ["1,234,567", 1234567, "#,##0"],
    ["2024-01-15", 45306, "yyyy-mm-dd"],
    ["1/15/2024", 45306, "m/d/yyyy"],
    ["15/1/2024", 45306, "d/m/yyyy"],
    ["15-Jan-2024", 45306, "d-mmm-yy"],
    ["Jan 15, 2024", 45306, "mmm d, yyyy"],
    ["13:30", 13.5 / 24, "h:mm"],
    ["1:30 PM", 13.5 / 24, "h:mm AM/PM"],
    ["2024-01-15 06:00", 45306.25, "yyyy-mm-dd h:mm"],
  ])("%s", (text, value, format) => {
    const got = parseTyped(text);
    expect(got?.format).toBe(format);
    expect(got?.value).toBeCloseTo(value, 9);
  });

  it.each(["42", "hello", "2024-02-30", "13/13/2024", "1,23", "25:00", "$", "%", "1.2.3", "(5"])("%s is not a typed format", (text) => {
    expect(parseTyped(text)).toBeNull();
  });

  it("round-trips through its own format", () => {
    for (const t of ["12%", "$1,234.50", "2024-01-15", "1:30 PM", "1,234,567"]) {
      const p = parseTyped(t)!;
      expect(formatValue(p.value, p.format).text).toBe(t);
    }
  });
});
