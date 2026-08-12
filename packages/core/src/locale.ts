/**
 * Locales: how numbers, dates and formulas are written in a country.
 *
 * Format codes are always stored the Excel way ("#,##0.00", "dd/mm/yyyy",
 * "=SUM(A1,B1)"), so files stay portable. A locale only changes what people
 * see and type: the decimal and thousands separators, the formula argument
 * separator, the default date format and the CSV delimiter.
 *
 * There is one current locale for the whole app (set once at startup).
 * formatValue and parseTyped use it unless a locale is passed in. The
 * default is en-US, which is exactly how cellforge behaved before locales.
 */

export type LocaleId = "en-US" | "en-GB" | "en-IN" | "de-DE" | "fr-FR";

export interface Locale {
  id: LocaleId;
  /** a name for menus, e.g. "English (United States)" */
  name: string;
  /** decimal separator in display and typing */
  decimal: "." | ",";
  /** thousands separator in display */
  group: string;
  /** other characters accepted as thousands separators when typing */
  groupInput: string[];
  /** "indian" groups 12,34,567 (lakh and crore) */
  grouping: "standard" | "indian";
  /** formula argument separator in display (both are accepted when typing) */
  argSep: "," | ";";
  /** how a numeric date like 01/02/2024 is read */
  dateOrder: "mdy" | "dmy";
  /** the format a typed date gets (an Excel code) */
  dateFormat: string;
  /** the delimiter a CSV defaults to (";" where the comma is the decimal) */
  csvDelimiter: "," | ";";
}

/** U+202F narrow no-break space: the French thousands separator. */
export const NNBSP = " ";

export const LOCALES: Readonly<Record<LocaleId, Locale>> = {
  "en-US": {
    id: "en-US",
    name: "English (United States)",
    decimal: ".",
    group: ",",
    groupInput: [","],
    grouping: "standard",
    argSep: ",",
    dateOrder: "mdy",
    dateFormat: "m/d/yyyy",
    csvDelimiter: ",",
  },
  "en-GB": {
    id: "en-GB",
    name: "English (United Kingdom)",
    decimal: ".",
    group: ",",
    groupInput: [","],
    grouping: "standard",
    argSep: ",",
    dateOrder: "dmy",
    dateFormat: "dd/mm/yyyy",
    csvDelimiter: ",",
  },
  "en-IN": {
    id: "en-IN",
    name: "English (India)",
    decimal: ".",
    group: ",",
    groupInput: [","],
    grouping: "indian",
    argSep: ",",
    dateOrder: "dmy",
    dateFormat: "dd/mm/yyyy",
    csvDelimiter: ",",
  },
  "de-DE": {
    id: "de-DE",
    name: "Deutsch (Deutschland)",
    decimal: ",",
    group: ".",
    groupInput: ["."],
    grouping: "standard",
    argSep: ";",
    dateOrder: "dmy",
    dateFormat: "dd.mm.yyyy",
    csvDelimiter: ";",
  },
  "fr-FR": {
    id: "fr-FR",
    name: "Français (France)",
    decimal: ",",
    group: NNBSP,
    groupInput: [NNBSP, " ", " "],
    grouping: "standard",
    argSep: ";",
    dateOrder: "dmy",
    dateFormat: "dd/mm/yyyy",
    csvDelimiter: ";",
  },
};

export const DEFAULT_LOCALE: Locale = LOCALES["en-US"];

// kept on globalThis so every copy of this module (a bundler can load it
// through two paths) sees the same choice
const STATE = Symbol.for("cellforge.locale");
const shared = globalThis as { [STATE]?: Locale };

/** The app-wide locale (en-US until setLocale is called). */
export function getLocale(): Locale {
  return shared[STATE] ?? DEFAULT_LOCALE;
}

/** Change the app-wide locale; an unknown id falls back to en-US. Returns the locale now in use. */
export function setLocale(locale: Locale | LocaleId | string): Locale {
  const l = typeof locale === "string" ? localeById(locale) : locale;
  shared[STATE] = l;
  return l;
}

/** The locale for an id like "de-DE" (case-insensitive), or the closest one by language, or en-US. */
export function localeById(id: string | null | undefined): Locale {
  if (!id) return DEFAULT_LOCALE;
  const want = id.toLowerCase();
  const all = Object.values(LOCALES);
  const exact = all.find((l) => l.id.toLowerCase() === want);
  if (exact) return exact;
  const lang = want.split(/[-_]/)[0];
  return all.find((l) => l.id.toLowerCase().split("-")[0] === lang) ?? DEFAULT_LOCALE;
}

/** True when the locale writes numbers the way en-US does (nothing to translate). */
export function isPlainLocale(l: Locale): boolean {
  return l.decimal === "." && l.group === "," && l.grouping === "standard";
}

/** The decimal style for parseNumberLoose / profileColumn ("dot" or "comma"). */
export function numberStyleOf(l: Locale): "dot" | "comma" {
  return l.decimal === "," ? "comma" : "dot";
}

/** Put thousands separators into a run of digits: 1234567 -> 1,234,567 (or 12,34,567 in India). */
export function groupDigits(digits: string, l: Locale = getLocale()): string {
  if (digits.length <= 3) return digits;
  if (l.grouping === "indian") {
    const head = digits.slice(0, -3);
    return head.replace(/\B(?=(\d{2})+(?!\d))/g, l.group) + l.group + digits.slice(-3);
  }
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, l.group);
}

// ---------------------------------------------------------------------------
// formulas: "=SUM(A1,B1)" is stored; de-DE shows and accepts "=SUM(A1;B1)"

/**
 * Walk a formula, calling `fn` on each piece outside string literals,
 * quoted sheet names and array constants ({...}). Those three pass through
 * untouched.
 */
function mapOutsideLiterals(f: string, fn: (part: string) => string): string {
  let out = "";
  let plain = "";
  const flush = () => {
    out += fn(plain);
    plain = "";
  };
  for (let i = 0; i < f.length; i++) {
    const ch = f[i];
    if (ch === '"' || ch === "'") {
      flush();
      // "" and '' inside are escaped quotes
      let j = i + 1;
      while (j < f.length) {
        if (f[j] === ch && f[j + 1] === ch) j += 2;
        else if (f[j] === ch) break;
        else j++;
      }
      out += f.slice(i, j + 1);
      i = j;
    } else if (ch === "{") {
      flush();
      const j = f.indexOf("}", i);
      const end = j < 0 ? f.length - 1 : j;
      out += f.slice(i, end + 1);
      i = end;
    } else plain += ch;
  }
  flush();
  return out;
}

/** A number literal starts here (not inside a name or reference like A1 or Sheet1). */
const NUMBER_AT = /(^|[^A-Za-z0-9_.$\\])(\d+)([.,])(\d+)/g;

/** A stored formula ("=ROUND(A1*1.5,2)") as the locale shows it ("=ROUND(A1*1,5;2)"). */
export function localizeFormula(formula: string, l: Locale = getLocale()): string {
  if (l.argSep === "," && l.decimal === ".") return formula;
  if (!formula.startsWith("=")) return formula;
  return mapOutsideLiterals(formula, (part) => {
    // swap separators through a placeholder so 1.5 -> 1,5 and , -> ; don't collide
    let s = part.replace(NUMBER_AT, (m, pre, a, sep, b) => (sep === "." ? `${pre}${a}\u0000${b}` : m));
    if (l.argSep === ";") s = s.replace(/,/g, ";");
    return s.replace(/\u0000/g, l.decimal);
  });
}

/**
 * What someone typed ("=ROUND(A1*1,5;2)" in de-DE) as a stored formula
 * ("=ROUND(A1*1.5,2)"). Both styles are accepted: a formula with no ";" and
 * a comma that isn't between two digits is taken as already written the
 * en-US way and left alone.
 */
export function delocalizeFormula(formula: string, l: Locale = getLocale()): string {
  if (!formula.startsWith("=")) return formula;
  if (l.argSep === "," && l.decimal === ".") return formula;
  let hasSemi = false;
  let loneComma = false;
  mapOutsideLiterals(formula, (part) => {
    if (part.includes(";")) hasSemi = true;
    // commas that are not decimal commas in a number
    const stripped = part.replace(NUMBER_AT, (m, pre, a, sep, b) => (sep === "," ? `${pre}${a}${b}` : m));
    if (stripped.includes(",")) loneComma = true;
    return part;
  });
  if (!hasSemi && loneComma) return formula; // typed the en-US way
  return mapOutsideLiterals(formula, (part) => {
    let s = l.decimal === "," ? part.replace(NUMBER_AT, (m, pre, a, sep, b) => (sep === "," ? `${pre}${a}\u0000${b}` : m)) : part;
    if (l.argSep === ";") s = s.replace(/;/g, ",");
    return s.replace(/\u0000/g, ".");
  });
}

// ---------------------------------------------------------------------------
// plain text numbers (formula bar, edit text)

/** A plain number string ("1234.5") with the locale's decimal ("1234,5"). No grouping. */
export function localizeNumber(text: string, l: Locale = getLocale()): string {
  return l.decimal === "." ? text : text.replace(".", l.decimal);
}
