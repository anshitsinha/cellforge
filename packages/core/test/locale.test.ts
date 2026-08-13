import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  delocalizeFormula,
  getLocale,
  groupDigits,
  localeById,
  LOCALES,
  localizeFormula,
  localizeNumber,
  NNBSP,
  numberStyleOf,
  setLocale,
} from "../src/locale";
import { dateToSerial, formatGeneral, formatValue, parseTyped } from "../src/numfmt";
import { detectDelimiter } from "../src/csv";
import { defaultCsvDelimiter, previewCsv } from "../src/sniff";
import { parseNumberLoose } from "../src/clean/values";

const DE = LOCALES["de-DE"];
const FR = LOCALES["fr-FR"];
const IN = LOCALES["en-IN"];
const GB = LOCALES["en-GB"];
const US = LOCALES["en-US"];

afterEach(() => {
  setLocale("en-US");
});

describe("locale registry", () => {
  it("defaults to en-US", () => {
    expect(getLocale()).toBe(DEFAULT_LOCALE);
    expect(getLocale().id).toBe("en-US");
  });

  it("finds locales by id, by language, or falls back", () => {
    expect(localeById("de-DE")).toBe(DE);
    expect(localeById("DE-de")).toBe(DE);
    expect(localeById("de-AT").id).toBe("de-DE");
    expect(localeById("fr_CA").id).toBe("fr-FR");
    expect(localeById("xx-YY")).toBe(US);
    expect(localeById(null)).toBe(US);
    expect(localeById("")).toBe(US);
  });

  it("setLocale takes an id or a locale and returns what's in use", () => {
    expect(setLocale("de-DE")).toBe(DE);
    expect(getLocale()).toBe(DE);
    expect(setLocale(FR)).toBe(FR);
    expect(setLocale("nonsense")).toBe(US);
  });

  it("every locale is self-consistent", () => {
    for (const l of Object.values(LOCALES)) {
      expect(l.decimal).not.toBe(l.group);
      expect(l.groupInput).toContain(l.group);
      // a decimal comma needs a different argument and CSV separator
      if (l.decimal === ",") {
        expect(l.argSep).toBe(";");
        expect(l.csvDelimiter).toBe(";");
      }
      expect(numberStyleOf(l)).toBe(l.decimal === "," ? "comma" : "dot");
    }
  });
});

describe("groupDigits", () => {
  it("groups in threes", () => {
    expect(groupDigits("1", US)).toBe("1");
    expect(groupDigits("123", US)).toBe("123");
    expect(groupDigits("1234", US)).toBe("1,234");
    expect(groupDigits("1234567", DE)).toBe("1.234.567");
    expect(groupDigits("1234567", FR)).toBe(`1${NNBSP}234${NNBSP}567`);
  });

  it("groups the Indian way: lakh and crore", () => {
    expect(groupDigits("1234", IN)).toBe("1,234");
    expect(groupDigits("12345", IN)).toBe("12,345");
    expect(groupDigits("123456", IN)).toBe("1,23,456");
    expect(groupDigits("1234567", IN)).toBe("12,34,567");
    expect(groupDigits("123456789", IN)).toBe("12,34,56,789");
  });
});

describe("formatValue with a locale", () => {
  it("en-US is unchanged", () => {
    expect(formatValue(1234.5, "#,##0.00").text).toBe("1,234.50");
    expect(formatValue(1234.5, "#,##0.00", US).text).toBe("1,234.50");
    expect(formatValue(0.125, "0.0%").text).toBe("12.5%");
    expect(formatValue(1.5, undefined).text).toBe("1.5");
  });

  it("de-DE: 1.234,56", () => {
    expect(formatValue(1234.56, "#,##0.00", DE).text).toBe("1.234,56");
    expect(formatValue(-1234.56, "#,##0.00", DE).text).toBe("-1.234,56");
    expect(formatValue(1234567, "#,##0", DE).text).toBe("1.234.567");
    expect(formatValue(0.125, "0.0%", DE).text).toBe("12,5%");
    expect(formatValue(1.5, "General", DE).text).toBe("1,5");
    expect(formatValue(1.5, undefined, DE).text).toBe("1,5");
    expect(formatValue(1234.5, '#,##0.00 "€"', DE).text).toBe("1.234,50 €");
    expect(formatValue(12345678, '#,##0.0,,"M"', DE).text).toBe("12,3M");
    expect(formatValue(123456, "0.00E+00", DE).text).toBe("1,23E+05");
  });

  it("fr-FR: 1 234,56 with a narrow no-break space", () => {
    expect(formatValue(1234.56, "#,##0.00", FR).text).toBe(`1${NNBSP}234,56`);
    expect(formatValue(1234567.891, "#,##0.00", FR).text).toBe(`1${NNBSP}234${NNBSP}567,89`);
    expect(formatValue(0.5, "0.00", FR).text).toBe("0,50");
  });

  it("en-IN: 12,34,567.00", () => {
    expect(formatValue(1234567, "#,##0.00", IN).text).toBe("12,34,567.00");
    expect(formatValue(123456789.5, "#,##0.00", IN).text).toBe("12,34,56,789.50");
    expect(formatValue(999, "#,##0", IN).text).toBe("999");
    expect(formatValue(-100000, "#,##0;(#,##0)", IN).text).toBe("(1,00,000)");
  });

  it("en-GB looks like en-US for numbers", () => {
    expect(formatValue(1234.5, "#,##0.00", GB).text).toBe("1,234.50");
  });

  it("reads the app-wide locale when none is passed", () => {
    setLocale("de-DE");
    expect(formatValue(1234.56, "#,##0.00").text).toBe("1.234,56");
    expect(formatValue(2.25, undefined).text).toBe("2,25");
    setLocale("en-US");
    expect(formatValue(1234.56, "#,##0.00").text).toBe("1,234.56");
  });

  it("leaves dates, text and booleans alone", () => {
    const serial = dateToSerial(2024, 1, 15);
    expect(formatValue(serial, "dd.mm.yyyy", DE).text).toBe("15.01.2024");
    expect(formatValue(serial, "yyyy-mm-dd", DE).text).toBe("2024-01-15");
    expect(formatValue("a.b,c", "#,##0.00", DE).text).toBe("a.b,c");
    expect(formatValue(true, "#,##0.00", DE).text).toBe("TRUE");
    // quoted literals keep their characters
    expect(formatValue(5, '0 "a.b"', DE).text).toBe("5 a.b");
  });

  it("formatGeneral stays en-US unless asked", () => {
    setLocale("de-DE");
    expect(formatGeneral(1.5)).toBe("1.5");
    expect(formatGeneral(1.5, DE)).toBe("1,5");
    expect(formatGeneral(1e12, DE)).toBe("1E+12");
  });
});

describe("parseTyped with a locale", () => {
  it("en-US is unchanged", () => {
    expect(parseTyped("1,234.50")).toEqual({ value: 1234.5, format: "#,##0.00" });
    expect(parseTyped("1.5")).toBeNull();
    expect(parseTyped("1,5")).toBeNull();
    expect(parseTyped("3/4/2024")).toEqual({ value: dateToSerial(2024, 3, 4), format: "m/d/yyyy" });
    expect(parseTyped("15.1.2024")).toBeNull();
    expect(parseTyped("12 €")).toBeNull();
  });

  it("de-DE: a decimal comma", () => {
    expect(parseTyped("1,5", DE)).toEqual({ value: 1.5, format: "" });
    expect(parseTyped("-1,5", DE)).toEqual({ value: -1.5, format: "" });
    expect(parseTyped("1.234,56", DE)).toEqual({ value: 1234.56, format: "#,##0.00" });
    expect(parseTyped("1.234", DE)).toEqual({ value: 1234, format: "#,##0" });
    expect(parseTyped("1.234.567", DE)).toEqual({ value: 1234567, format: "#,##0" });
    expect(parseTyped("12,5%", DE)).toEqual({ value: 0.125, format: "0.0%" });
    expect(parseTyped("1.234,50 €", DE)).toEqual({ value: 1234.5, format: '#,##0.00 "€"' });
    expect(parseTyped("€1.234,50", DE)).toEqual({ value: 1234.5, format: '"€"#,##0.00' });
    expect(parseTyped("€ 5 €", DE)).toBeNull();
  });

  it("de-DE: plain numbers with a dot are left to the caller (Number reads them)", () => {
    expect(parseTyped("1.5", DE)).toBeNull();
    expect(parseTyped("15", DE)).toBeNull();
  });

  it("de-DE: dates typed d.m.yyyy", () => {
    expect(parseTyped("15.1.2024", DE)).toEqual({ value: dateToSerial(2024, 1, 15), format: "dd.mm.yyyy" });
    expect(parseTyped("01.02.24", DE)).toEqual({ value: dateToSerial(2024, 2, 1), format: "dd.mm.yyyy" });
    expect(parseTyped("31.2.2024", DE)).toBeNull();
    expect(parseTyped("15.1.2024 14:30", DE)).toEqual({ value: dateToSerial(2024, 1, 15, 14, 30), format: "dd.mm.yyyy h:mm" });
    expect(parseTyped("2024-01-15", DE)).toEqual({ value: dateToSerial(2024, 1, 15), format: "yyyy-mm-dd" });
  });

  it("fr-FR: spaces as thousands", () => {
    expect(parseTyped(`1${NNBSP}234,56`, FR)).toEqual({ value: 1234.56, format: "#,##0.00" });
    expect(parseTyped("1 234,56", FR)).toEqual({ value: 1234.56, format: "#,##0.00" });
    expect(parseTyped("1 234,56", FR)).toEqual({ value: 1234.56, format: "#,##0.00" });
    expect(parseTyped("12,5 %", FR)).toEqual({ value: 0.125, format: "0.0%" });
    expect(parseTyped("3/4/2024", FR)).toEqual({ value: dateToSerial(2024, 4, 3), format: "dd/mm/yyyy" });
  });

  it("en-GB: day first", () => {
    expect(parseTyped("3/4/2024", GB)).toEqual({ value: dateToSerial(2024, 4, 3), format: "dd/mm/yyyy" });
    expect(parseTyped("4/13/2024", GB)).toBeNull();
    expect(parseTyped("1,234.5", GB)).toEqual({ value: 1234.5, format: "#,##0.00" });
    expect(parseTyped("1.5", GB)).toBeNull();
  });

  it("en-IN: lakh grouping typed in", () => {
    expect(parseTyped("12,34,567", IN)).toEqual({ value: 1234567, format: "#,##0" });
    expect(parseTyped("₹1,00,000.50", IN)).toEqual({ value: 100000.5, format: '"₹"#,##0.00' });
    expect(parseTyped("1,234,567", IN)).toEqual({ value: 1234567, format: "#,##0" });
  });

  it("uses the app-wide locale when none is passed", () => {
    setLocale("de-DE");
    expect(parseTyped("1,5")).toEqual({ value: 1.5, format: "" });
    expect(parseTyped("15.1.2024")?.format).toBe("dd.mm.yyyy");
  });

  it("round-trips what formatValue shows", () => {
    for (const l of [US, GB, IN, DE, FR]) {
      for (const n of [1234.56, 1234567.25, 1000000]) {
        const shown = formatValue(n, "#,##0.00", l).text;
        expect(parseTyped(shown, l)?.value).toBe(n);
      }
    }
  });
});

describe("formulas", () => {
  it("en-US leaves formulas alone", () => {
    expect(localizeFormula("=SUM(A1,B1)*1.5", US)).toBe("=SUM(A1,B1)*1.5");
    expect(delocalizeFormula("=SUM(A1,B1)*1.5", US)).toBe("=SUM(A1,B1)*1.5");
  });

  it("de-DE shows ; between arguments and a decimal comma", () => {
    expect(localizeFormula("=SUM(B2:B4)", DE)).toBe("=SUM(B2:B4)");
    expect(localizeFormula("=ROUND(A1*1.5,2)", DE)).toBe("=ROUND(A1*1,5;2)");
    expect(localizeFormula('=IF(A1>0.5,"a,b. c",0)', DE)).toBe('=IF(A1>0,5;"a,b. c";0)');
    expect(localizeFormula("='My,Sheet'!A1+Sheet1!B2", DE)).toBe("='My,Sheet'!A1+Sheet1!B2");
    expect(localizeFormula("=SUM({1,2;3,4})", DE)).toBe("=SUM({1,2;3,4})");
    expect(localizeFormula("plain text, 1.5", DE)).toBe("plain text, 1.5");
  });

  it("de-DE accepts both styles when typing", () => {
    expect(delocalizeFormula("=ROUND(A1*1,5;2)", DE)).toBe("=ROUND(A1*1.5,2)");
    expect(delocalizeFormula("=SUM(A1;B1)", DE)).toBe("=SUM(A1,B1)");
    expect(delocalizeFormula("=SUM(A1,B1)", DE)).toBe("=SUM(A1,B1)");
    expect(delocalizeFormula("=A1*1,5", DE)).toBe("=A1*1.5");
    expect(delocalizeFormula('=IF(A1;"x;y";2,5)', DE)).toBe('=IF(A1,"x;y",2.5)');
    expect(delocalizeFormula("=ROUND(1.5,0)", DE)).toBe("=ROUND(1.5,0)");
    expect(delocalizeFormula("not a formula 1,5", DE)).toBe("not a formula 1,5");
  });

  it("round-trips in every locale", () => {
    const formulas = ["=SUM(A1:A9)", "=ROUND(A1*1.25,2)", '=IF(B2>=0.5,"yes, really","no")', "=VLOOKUP(A1,'Data, 2024'!A:C,3,FALSE)", "=A1+2.5*B1"];
    for (const l of Object.values(LOCALES)) {
      for (const f of formulas) expect(delocalizeFormula(localizeFormula(f, l), l)).toBe(f);
    }
  });

  it("fr-FR uses ; too", () => {
    expect(localizeFormula("=AVERAGE(A1,A2,0.5)", FR)).toBe("=AVERAGE(A1;A2;0,5)");
  });
});

describe("plain numbers and CSV", () => {
  it("localizeNumber swaps the decimal only", () => {
    expect(localizeNumber("1234.5", DE)).toBe("1234,5");
    expect(localizeNumber("1234.5", US)).toBe("1234.5");
  });

  it("parseNumberLoose follows the locale's number style", () => {
    expect(parseNumberLoose("1.234,56", numberStyleOf(DE))).toBe(1234.56);
    expect(parseNumberLoose(`1${NNBSP}234,56`, numberStyleOf(FR))).toBe(1234.56);
    expect(parseNumberLoose("12,34,567.5", numberStyleOf(IN))).toBe(1234567.5);
  });

  it("the CSV delimiter defaults to ; where the comma is the decimal", () => {
    expect(defaultCsvDelimiter()).toBe(",");
    setLocale("de-DE");
    expect(defaultCsvDelimiter()).toBe(";");
    setLocale("fr-FR");
    expect(defaultCsvDelimiter()).toBe(";");
    setLocale("en-IN");
    expect(defaultCsvDelimiter()).toBe(",");
  });

  it("detection breaks ties towards the locale's delimiter", () => {
    expect(detectDelimiter("a,b;c\n")).toBe(",");
    expect(detectDelimiter("a,b;c\n", ";")).toBe(";");
    expect(detectDelimiter("single\n", ";")).toBe(";");
    expect(detectDelimiter("a,b,c;d\n", ";")).toBe(",");
    const bytes = new TextEncoder().encode("name\nx\n");
    expect(previewCsv(bytes).delimiter).toBe(",");
    setLocale("de-DE");
    expect(previewCsv(bytes).delimiter).toBe(";");
    expect(previewCsv(new TextEncoder().encode("a;b\n1,5;2\n")).rows[1]).toEqual(["1,5", "2"]);
  });
});
