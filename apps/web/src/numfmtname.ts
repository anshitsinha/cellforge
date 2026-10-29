/**
 * Friendly names for number format codes, so the format bar says
 * "Accounting, 2 dp" or "Date" instead of "Custom · #,##0.00;", and the
 * currency the locale uses (£ on a UK company's books, not $).
 */

export type CurrencyLocale = "en-US" | "en-GB" | "en-IN" | "de-DE" | "fr-FR" | string;

/** The currency symbol for a locale. */
export function currencySymbol(locale: CurrencyLocale): string {
  if (locale === "en-GB") return "£";
  if (locale === "en-IN") return "₹";
  if (locale === "de-DE" || locale === "fr-FR" || /^(de|fr|es|it|nl|pt|fi|el|sk|sl|et|lv|lt)-/.test(locale)) return "€";
  return "$";
}

/** The currency format code for a locale: "£#,##0.00", or "#,##0.00 €" where the symbol follows. */
export function currencyCode(locale: CurrencyLocale): string {
  const sym = currencySymbol(locale);
  return sym === "€" ? '#,##0.00 "€"' : `${sym}#,##0.00`;
}

/** Decimal places in the number part of a code ("#,##0.00" → 2). */
function places(section: string): number {
  const m = /0\.(0+)/.exec(section);
  return m ? m[1].length : 0;
}

const dp = (n: number) => `${n} dp`;

/** Strip quoted text and escapes so the tests below see only the pattern. */
function bare(code: string): string {
  return code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?:Red|Black|Blue|Green|Color\d+)\]/gi, "");
}

/**
 * A short name for a format code. `custom` is true when it isn't one of
 * the common kinds (the caller then shows the code in a tooltip only).
 */
export function formatName(code: string | null | undefined): { name: string; custom: boolean } {
  const c = (code ?? "").trim();
  if (!c || /^general$/i.test(c)) return { name: "General", custom: false };
  if (c === "@") return { name: "Text", custom: false };
  const sections = c.split(";");
  const first = bare(sections[0]);
  // accounting: the _( padding and the * fill
  if (/_\(|_\)|\*\s/.test(c) && /0/.test(first)) return { name: `Accounting, ${dp(places(first))}`, custom: false };
  if (/%/.test(first)) return { name: `Percent, ${dp(places(first))}`, custom: false };
  if (/E[+-]0/i.test(first)) return { name: "Scientific", custom: false };
  // dates and times: d, m, y, h, s letters with no digit placeholders
  if (!/[#0?]/.test(first.replace(/\[h+\]|\[m+\]|\[s+\]/gi, "")) || /^\[h\]/i.test(first)) {
    const lower = first.toLowerCase().replace(/am\/pm|a\/p/g, " ~ ");
    if (/\[h+\]/.test(lower)) return { name: "Duration", custom: false };
    const date = /[dy]/.test(lower) || /m{3,}/.test(lower) || /(^|[^h:m])m+[/.\- ]/.test(lower);
    const time = /h|s|~/.test(lower);
    if (date && time) return { name: "Date and time", custom: false };
    if (date) return { name: /dddd|mmmm/.test(lower) ? "Long date" : "Date", custom: false };
    if (time) return { name: "Time", custom: false };
  }
  const currency = /[$£€¥₹]/.exec(sections[0]);
  if (/0/.test(first)) {
    const scale = /0,,(?![#0])/.test(first) ? " millions" : /0,(?![#0])/.test(first) ? " thousands" : "";
    if (currency) return { name: `Currency (${currency[0]})${scale}, ${dp(places(first))}`, custom: false };
    if (scale) return { name: `Number in${scale}`, custom: false };
    return { name: `Number, ${dp(places(first))}${/#,##/.test(first) ? "" : ", no separator"}`, custom: false };
  }
  return { name: "Custom", custom: true };
}
