/** Small vocabularies the parser shares: numbers in words, colours, dates. */

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, twenty: 20, fifty: 50, hundred: 100,
};

/** "3", "three", "a" → 3, 3, 1; NaN if it isn't a count. */
export function parseCount(text: string | undefined): number {
  if (text === undefined) return NaN;
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUMBERS[t] ?? NaN;
}

/**
 * "10,000", "$1,200.50", "10k", "1.5m", "-3", "(250)", "12%" → a number;
 * NaN when it isn't one.
 */
export function parseNumber(text: string | undefined): number {
  if (text === undefined) return NaN;
  let t = text.trim().toLowerCase().replace(/\s+/g, "");
  let sign = 1;
  if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  if (t.startsWith("-")) {
    sign = -sign;
    t = t.slice(1);
  }
  t = t.replace(/^[$€£¥]/, "").replace(/(usd|eur|gbp|dollars?|euros?|pounds?)$/, "");
  let scale = 1;
  if (t.endsWith("%")) {
    scale = 0.01;
    t = t.slice(0, -1);
  } else if (/[0-9.]k$/.test(t)) {
    scale = 1e3;
    t = t.slice(0, -1);
  } else if (/[0-9.](m|mn|million)$/.test(t)) {
    scale = 1e6;
    t = t.replace(/(m|mn|million)$/, "");
  } else if (/[0-9.](bn|b|billion)$/.test(t)) {
    scale = 1e9;
    t = t.replace(/(bn|b|billion)$/, "");
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$|^\.\d+$/.test(t)) return NaN;
  const n = Number(t.replace(/,/g, "")) * scale * sign;
  // 0.1 * 3 style noise from the scale
  return Number.isFinite(n) ? Number(n.toPrecision(15)) : NaN;
}

/** An ISO date (2024-01-31) as a spreadsheet serial number, or NaN. */
export function parseDateSerial(text: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCDate() !== d) return NaN;
  return (ms - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Colours people name, as text colour and as a soft highlight (fill + text). */
export const COLORS: Record<string, { text: string; fill: string; ink: string }> = {
  red: { text: "#c00000", fill: "#ffc7ce", ink: "#9c0006" },
  green: { text: "#00803c", fill: "#c6efce", ink: "#006100" },
  yellow: { text: "#9c5700", fill: "#ffeb9c", ink: "#9c5700" },
  orange: { text: "#c55a11", fill: "#fcd5b4", ink: "#843c0c" },
  blue: { text: "#1f5fbf", fill: "#bdd7ee", ink: "#1f4e79" },
  purple: { text: "#7030a0", fill: "#e4dfec", ink: "#5b2a86" },
  pink: { text: "#c71585", fill: "#fbd3e9", ink: "#8b1a5a" },
  grey: { text: "#595959", fill: "#e7e6e6", ink: "#3a3a3a" },
  gray: { text: "#595959", fill: "#e7e6e6", ink: "#3a3a3a" },
  black: { text: "#000000", fill: "#404040", ink: "#ffffff" },
  white: { text: "#ffffff", fill: "#ffffff", ink: "#000000" },
};

export const COLOR_WORDS = Object.keys(COLORS).join("|");

/** "North, South and East" → ["North", "South", "East"] */
export function splitList(text: string): string[] {
  return text
    .split(/\s*[,;/|]\s*(?:and\s+|or\s+)?|\s+(?:and|or)\s+/i)
    .map((x) => x.trim().replace(/^["'“‘]|["'”’]$/g, "").trim())
    .filter((x) => x !== "");
}

export const unquote = (t: string) => t.trim().replace(/^["'“‘](.*)["'”’]$/, "$1").trim();
