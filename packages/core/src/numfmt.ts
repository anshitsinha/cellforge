/**
 * Excel number format codes: "#,##0.00", "0%", "$#,##0_);[Red]($#,##0)",
 * "yyyy-mm-dd", "[h]:mm", '#,##0,,"M"' and so on.
 *
 * A code has up to four sections separated by ";": positive, negative, zero
 * and text. A section can start with a colour ([Red]) and a condition
 * ([>=1000]). Inside, 0 # ? are digit placeholders, "." the decimal point, ","
 * thousands (or, at the end of the number, a divide by 1000), "%" a times
 * 100, E+ scientific, "@" the text, and y m d h s AM/PM date parts. Anything
 * in quotes or after a backslash is printed as is; "_x" leaves a space the
 * width of x and "*x" repeats x to fill the cell (we print one space).
 *
 * Dates are serial numbers in Excel's 1900 system, including its fictional
 * 29 February 1900 (serial 60), so serials match files made in Excel.
 */

export interface Formatted {
  text: string;
  /** a colour from the code, e.g. [Red] */
  color?: string;
}

type Token =
  | { t: "lit"; s: string }
  | { t: "digit"; c: "0" | "#" | "?" }
  | { t: "point" }
  | { t: "comma" }
  | { t: "percent" }
  | { t: "exp"; sign: "+" | "-" }
  | { t: "text" }
  | { t: "date"; c: string }
  | { t: "ampm"; c: string }
  | { t: "elapsed"; c: "h" | "m" | "s"; n: number }
  | { t: "general" }
  | { t: "fill" };

interface Section {
  tokens: Token[];
  color?: string;
  cond?: { op: string; value: number };
  isDate: boolean;
  isText: boolean;
  hasNumber: boolean;
  percent: number;
  /** trailing-comma scaling: divide by 1000 per comma */
  scale: number;
  /** whether the code prints its own sign (sections 2+ do) */
}

const COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#00a933",
  blue: "#0000ff",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  cyan: "#00ffff",
};


function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      const end = j < 0 ? code.length : j;
      cur += code.slice(i, end + 1);
      i = end;
    } else if (ch === "\\" || ch === "_" || ch === "*") {
      cur += code.slice(i, i + 2);
      i++;
    } else if (ch === "[") {
      const j = code.indexOf("]", i);
      const end = j < 0 ? code.length : j;
      cur += code.slice(i, end + 1);
      i = end;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseSection(src: string): Section {
  const tokens: Token[] = [];
  const sec: Section = { tokens, isDate: false, isText: false, hasNumber: false, percent: 0, scale: 0 };
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    const ch = src[i];
    const lc = lower[i];
    if (ch === '"') {
      const j = src.indexOf('"', i + 1);
      const end = j < 0 ? src.length : j;
      tokens.push({ t: "lit", s: src.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === "\\") {
      tokens.push({ t: "lit", s: src[i + 1] ?? "" });
      i += 2;
    } else if (ch === "_") {
      tokens.push({ t: "lit", s: " " });
      i += 2;
    } else if (ch === "*") {
      tokens.push({ t: "fill" });
      i += 2;
    } else if (ch === "[") {
      const j = src.indexOf("]", i);
      const inner = src.slice(i + 1, j < 0 ? src.length : j);
      const il = inner.toLowerCase();
      i = (j < 0 ? src.length : j) + 1;
      if (COLORS[il]) sec.color = COLORS[il];
      else if (/^(h+|m+|s+)$/.test(il)) {
        tokens.push({ t: "elapsed", c: il[0] as "h", n: il.length });
        sec.isDate = true;
      } else {
        const m = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(inner.trim());
        if (m) sec.cond = { op: m[1], value: Number(m[2]) };
        // locale codes like [$-409] and [$€-x] : keep a currency symbol
        else if (inner.startsWith("$")) {
          const sym = inner.slice(1).split("-")[0];
          if (sym) tokens.push({ t: "lit", s: sym });
        }
      }
    } else if (lower.startsWith("general", i)) {
      tokens.push({ t: "general" });
      sec.hasNumber = true;
      i += 7;
    } else if (lower.startsWith("am/pm", i) || lower.startsWith("a/p", i)) {
      const n = lower.startsWith("am/pm", i) ? 5 : 3;
      tokens.push({ t: "ampm", c: src.slice(i, i + n) });
      sec.isDate = true;
      i += n;
    } else if ("ymdhs".includes(lc) || (lc === "e" && !/[+-]/.test(src[i + 1] ?? ""))) {
      // a run of the same date letter: yyyy, mmm, dd, hh, ss (and "e" = year)
      let j = i;
      while (j < src.length && lower[j] === lc) j++;
      tokens.push({ t: "date", c: lower.slice(i, j).replace(/e/g, "y") });
      sec.isDate = true;
      i = j;
    } else if (ch === "0" || ch === "#" || ch === "?") {
      tokens.push({ t: "digit", c: ch });
      sec.hasNumber = true;
      i++;
    } else if (ch === ".") {
      tokens.push({ t: "point" });
      i++;
    } else if (ch === ",") {
      tokens.push({ t: "comma" });
      i++;
    } else if (ch === "%") {
      tokens.push({ t: "percent" });
      sec.percent++;
      i++;
    } else if ((lc === "e") && /[+-]/.test(src[i + 1] ?? "")) {
      tokens.push({ t: "exp", sign: src[i + 1] as "+" });
      i += 2;
    } else if (ch === "@") {
      tokens.push({ t: "text" });
      sec.isText = true;
      i++;
    } else {
      tokens.push({ t: "lit", s: ch });
      i++;
    }
  }
  // "." inside a date section is fractional seconds, not a decimal point
  if (sec.isDate) {
    for (let k = 0; k < tokens.length; k++) {
      const tk = tokens[k];
      if (tk.t === "point" && tokens[k + 1]?.t === "digit") {
        let n = 0;
        while (tokens[k + 1 + n]?.t === "digit") n++;
        tokens.splice(k, 1 + n, { t: "date", c: "." + "0".repeat(n) });
      } else if (tk.t === "comma" || tk.t === "point") tokens[k] = { t: "lit", s: tk.t === "comma" ? "," : "." };
    }
  }
  // "m" next to h or s means minutes
  if (sec.isDate) {
    const parts = tokens.map((tk, k) => ({ tk, k })).filter(({ tk }) => tk.t === "date" || tk.t === "elapsed");
    parts.forEach(({ tk }, n) => {
      if (tk.t !== "date" || tk.c[0] !== "m" || tk.c.length > 2) return;
      const prev = parts[n - 1]?.tk;
      const next = parts[n + 1]?.tk;
      const isTime = (x?: Token) => !!x && ((x.t === "date" && (x.c[0] === "h" || x.c[0] === "s")) || (x.t === "elapsed" && x.c !== "m"));
      if (isTime(prev) || isTime(next)) tk.c = "n".repeat(tk.c.length); // n = minutes
    });
  }
  // commas after the last digit placeholder scale; others are thousands
  if (sec.hasNumber && !sec.isDate) {
    let last = -1;
    tokens.forEach((tk, k) => {
      if (tk.t === "digit" || tk.t === "point") last = k;
    });
    for (let k = last + 1; k < tokens.length && tokens[k].t === "comma"; k++) {
      sec.scale++;
      tokens[k] = { t: "lit", s: "" };
    }
  }
  return sec;
}

interface Compiled {
  sections: Section[];
}

const cache = new Map<string, Compiled>();

function compile(code: string): Compiled {
  let c = cache.get(code);
  if (!c) {
    c = { sections: splitSections(code).map(parseSection) };
    if (cache.size > 500) cache.clear();
    cache.set(code, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// numbers

/** Round half away from zero to `d` decimals, without binary surprises (1.005 -> 1.01). */
function roundTo(x: number, d: number): number {
  if (!isFinite(x)) return x;
  const r = Math.round(Number(`${Math.abs(x)}e${d}`));
  return Math.sign(x) * Number(`${r}e-${d}`);
}

/** Digits of a non-negative number rounded to `d` decimals: [integer, fraction]. */
function digitsOf(x: number, d: number): [string, string] {
  const r = roundTo(x, d);
  let s = r.toFixed(d);
  if (s.includes("e")) s = BigInt(Math.round(r)).toString() + (d ? "." + "0".repeat(d) : "");
  const [a, b = ""] = s.split(".");
  return [a === "0" ? "" : a, b];
}

/** Excel's General: up to 11 characters, switching to scientific when needed. */
export function formatGeneral(n: number): string {
  if (!isFinite(n)) return n > 0 ? "#NUM!" : "#NUM!";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e11 || abs < 1e-9) {
    const [m, e] = n.toExponential(5).split("e");
    const mant = m.replace(/\.?0+$/, "");
    const exp = Number(e);
    return `${mant}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  if (Number.isInteger(n)) return String(n);
  const intDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
  const decimals = Math.max(0, 10 - intDigits);
  return String(roundTo(n, decimals)).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function formatNumber(sec: Section, value: number): string {
  const tokens = sec.tokens;
  let x = value * 100 ** sec.percent / 1000 ** sec.scale;
  const expAt = tokens.findIndex((t) => t.t === "exp");
  const pointAt = tokens.findIndex((t) => t.t === "point");
  const end = expAt >= 0 ? expAt : tokens.length;
  // placeholders before / after the decimal point (mantissa only)
  const intPh: Token[] = [];
  const fracPh: Token[] = [];
  let thousands = false;
  tokens.forEach((t, k) => {
    if (k >= end) return;
    if (t.t === "digit") (pointAt >= 0 && k > pointAt ? fracPh : intPh).push(t);
    if (t.t === "comma" && (pointAt < 0 || k < pointAt)) thousands = true;
  });
  let exponent = 0;
  if (expAt >= 0) {
    const expDigits = tokens.slice(expAt + 1).filter((t) => t.t === "digit").length;
    if (x !== 0) {
      // Excel: with "##0.0E+0" the exponent is a multiple of the # count
      const step = Math.max(1, intPh.length);
      exponent = Math.floor(Math.log10(Math.abs(x)) / step) * step;
      if (intPh.length > 1 && intPh.every((t) => t.t === "digit" && t.c === "0")) exponent = Math.floor(Math.log10(Math.abs(x))) - (intPh.length - 1);
      x = x / 10 ** exponent;
      if (Math.abs(roundTo(x, fracPh.length)) >= 10 ** Math.max(1, intPh.length)) {
        x /= 10;
        exponent += 1;
      }
    }
    void expDigits;
  }
  const [intDigits, fracDigits] = digitsOf(Math.abs(x), fracPh.length);

  // integer part: fill placeholders right to left; extra digits go on the first
  let intOut = "";
  {
    const digits = intDigits;
    const n = intPh.length;
    const parts: string[] = [];
    for (let k = 0; k < n; k++) {
      const ph = intPh[n - 1 - k] as { c: string };
      const dch = digits[digits.length - 1 - k];
      if (dch !== undefined) parts.unshift(dch);
      else parts.unshift(ph.c === "0" ? "0" : ph.c === "?" ? " " : "");
    }
    if (digits.length > n) parts.unshift(digits.slice(0, digits.length - n));
    intOut = parts.join("");
    if (thousands) {
      const lead = intOut.match(/^ */)?.[0] ?? "";
      const body = intOut.slice(lead.length);
      intOut = lead + body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
  }
  // fraction: trailing # drop zeros, ? become spaces
  let frac = fracDigits.split("");
  for (let k = fracPh.length - 1; k >= 0; k--) {
    const ph = fracPh[k] as { c: string };
    if (frac[k] !== "0" || ph.c === "0") break;
    frac[k] = ph.c === "?" ? " " : "";
  }
  const fracOut = frac.join("");

  // assemble in token order
  let out = "";
  let intDone = false;
  let fracDone = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (k === expAt) {
      const expPh = tokens.slice(expAt + 1).filter((x) => x.t === "digit").length;
      const sign = exponent < 0 ? "-" : t.t === "exp" && t.sign === "+" ? "+" : "";
      out += "E" + sign + String(Math.abs(exponent)).padStart(expPh, "0");
      // skip exponent placeholders, keep any literals after them
      k++;
      while (k < tokens.length && tokens[k].t === "digit") k++;
      k--;
      continue;
    }
    switch (t.t) {
      case "digit":
        if (pointAt >= 0 && k > pointAt) {
          if (!fracDone) {
            out += fracOut;
            fracDone = true;
          }
        } else if (!intDone) {
          out += intOut;
          intDone = true;
        }
        break;
      case "point":
        out += ".";
        if (!intDone) {
          out += "";
          intDone = true;
        }
        break;
      case "comma":
        break;
      case "percent":
        out += "%";
        break;
      case "lit":
        out += t.s;
        break;
      case "fill":
        out += " ";
        break;
      case "general":
        out += formatGeneral(Math.abs(x));
        break;
      case "text":
        break;
      default:
        break;
    }
  }
  // "0." with only # after it and no fraction digits: Excel keeps the point
  return out;
}

// ---------------------------------------------------------------------------
// dates

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Calendar parts of an Excel serial (1900 system, with the 29 Feb 1900 bug). */
export function serialToParts(serial: number): { y: number; m: number; d: number; wd: number; h: number; mi: number; s: number; ms: number } {
  const day = Math.floor(serial);
  // time to the millisecond, rounded the way Excel shows it
  let msOfDay = Math.round((serial - day) * DAY_MS);
  let whole = day;
  if (msOfDay >= DAY_MS) {
    msOfDay -= DAY_MS;
    whole++;
  }
  let y: number, m: number, d: number, wd: number;
  if (whole === 60) {
    [y, m, d] = [1900, 2, 29];
    wd = 3; // Excel says Wednesday
  } else {
    const shifted = whole < 60 ? whole + 1 : whole; // before the fake leap day
    const dt = new Date(EPOCH + shifted * DAY_MS);
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
    wd = whole === 0 ? 6 : dt.getUTCDay(); // serial 0 shows as Saturday 0 Jan 1900
    if (whole === 0) [y, m, d] = [1900, 1, 0];
  }
  return {
    y,
    m,
    d,
    wd,
    h: Math.floor(msOfDay / 3_600_000),
    mi: Math.floor(msOfDay / 60_000) % 60,
    s: Math.floor(msOfDay / 1000) % 60,
    ms: msOfDay % 1000,
  };
}

/** Excel serial for a calendar date (and optional time). */
export function dateToSerial(y: number, m: number, d: number, h = 0, mi = 0, s = 0): number {
  const days = Math.round((Date.UTC(y, m - 1, d) - EPOCH) / DAY_MS);
  // dates on or before 28 Feb 1900 sit one lower (the fake 29 Feb is 60)
  const serial = days < 61 ? days - 1 : days;
  return serial + (h * 3600 + mi * 60 + s) / 86_400;
}

function formatDate(sec: Section, value: number): string {
  if (value < 0 || value >= 2958466) return "#".repeat(10); // Excel shows ##### for these
  const p = serialToParts(value);
  const hasAmPm = sec.tokens.some((t) => t.t === "ampm");
  // fractional seconds round the seconds display
  let out = "";
  for (const t of sec.tokens) {
    switch (t.t) {
      case "date": {
        const c = t.c;
        if (c[0] === "y") out += c.length <= 2 ? String(p.y % 100).padStart(2, "0") : String(p.y);
        else if (c[0] === "m") {
          if (c.length === 1) out += p.m;
          else if (c.length === 2) out += String(p.m).padStart(2, "0");
          else if (c.length === 3) out += MONTHS[p.m - 1].slice(0, 3);
          else if (c.length === 4) out += MONTHS[p.m - 1];
          else out += MONTHS[p.m - 1][0];
        } else if (c[0] === "d") {
          if (c.length === 1) out += p.d;
          else if (c.length === 2) out += String(p.d).padStart(2, "0");
          else if (c.length === 3) out += DAYS[p.wd].slice(0, 3);
          else out += DAYS[p.wd];
        } else if (c[0] === "h") {
          const h = hasAmPm ? ((p.h + 11) % 12) + 1 : p.h;
          out += c.length >= 2 ? String(h).padStart(2, "0") : h;
        } else if (c[0] === "n") out += c.length >= 2 ? String(p.mi).padStart(2, "0") : p.mi;
        else if (c[0] === "s") out += c.length >= 2 ? String(p.s).padStart(2, "0") : p.s;
        else if (c[0] === ".") out += "." + String(p.ms).padStart(3, "0").slice(0, c.length - 1);
        break;
      }
      case "ampm": {
        const pm = p.h >= 12;
        if (t.c.length === 5) out += pm ? "PM" : "AM";
        else {
          const ch = pm ? t.c[2] : t.c[0];
          out += ch === ch.toUpperCase() ? (pm ? "P" : "A") : pm ? "p" : "a";
        }
        break;
      }
      case "elapsed": {
        const totalS = Math.round(value * 86_400);
        const n = t.c === "h" ? Math.floor(totalS / 3600) : t.c === "m" ? Math.floor(totalS / 60) : totalS;
        out += String(n).padStart(t.n, "0");
        break;
      }
      case "lit":
        out += t.s;
        break;
      case "fill":
        out += " ";
        break;
      case "comma":
        out += ",";
        break;
      case "point":
        out += ".";
        break;
      case "percent":
        out += "%";
        break;
      case "digit":
        out += t.c === "0" ? "0" : "";
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

function matches(cond: { op: string; value: number }, x: number): boolean {
  switch (cond.op) {
    case "<":
      return x < cond.value;
    case "<=":
      return x <= cond.value;
    case ">":
      return x > cond.value;
    case ">=":
      return x >= cond.value;
    case "=":
      return x === cond.value;
    case "<>":
      return x !== cond.value;
  }
  return false;
}

/** Pick the section for a number and say whether the code prints the sign itself. */
function sectionFor(c: Compiled, x: number): { sec: Section; signed: boolean } {
  const s = c.sections;
  const numeric = s.filter((sec) => !sec.isText || sec.hasNumber || sec.isDate);
  if (s.some((sec) => sec.cond)) {
    // conditional sections: first match wins; the last section is "else"
    for (let i = 0; i < Math.min(2, numeric.length); i++) {
      const sec = numeric[i];
      if (sec.cond && matches(sec.cond, x)) return { sec, signed: x < 0 && i > 0 ? true : false };
    }
    const last = numeric[Math.min(2, numeric.length - 1)];
    return { sec: last, signed: false };
  }
  if (x > 0 || numeric.length === 1) return { sec: numeric[0], signed: false };
  if (x < 0) return numeric.length >= 2 ? { sec: numeric[1], signed: true } : { sec: numeric[0], signed: false };
  return { sec: numeric[2] ?? numeric[0], signed: false };
}

/**
 * Format a value with an Excel number format code. Text uses the code's
 * text section (or shows as is); booleans show as TRUE / FALSE.
 */
export function formatValue(value: number | string | boolean | null, code: string | undefined): Formatted {
  if (value === null) return { text: "" };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  if (!code || code.toLowerCase() === "general") {
    return { text: typeof value === "number" ? formatGeneral(value) : value };
  }
  const c = compile(code);
  if (typeof value === "string") {
    const sec = c.sections.length >= 4 ? c.sections[3] : c.sections.find((s) => s.isText);
    if (!sec) return { text: value };
    let out = "";
    for (const t of sec.tokens) out += t.t === "text" ? value : t.t === "lit" ? t.s : t.t === "fill" ? " " : "";
    return { text: out, color: sec.color };
  }
  if (!isFinite(value)) return { text: "#NUM!" };
  const { sec, signed } = sectionFor(c, value);
  if (!sec) return { text: formatGeneral(value) };
  const x = signed ? Math.abs(value) : value;
  let text: string;
  if (sec.isDate) text = formatDate(sec, x);
  else if (!sec.hasNumber) {
    // a section with no placeholders: just its literals (e.g. "-" for zero)
    text = sec.tokens.map((t) => (t.t === "lit" ? t.s : t.t === "fill" ? " " : t.t === "percent" ? "%" : "")).join("");
    if (x < 0 && !signed) text = "-" + text;
  } else {
    text = formatNumber(sec, Math.abs(x));
    // the sign: only when a single section handles negatives, and the
    // number didn't round to zero
    if (x < 0 && !signed && /[1-9]/.test(text)) text = "-" + text;
  }
  return { text, color: sec.color };
}

/** True when a code shows dates or times (so typed dates keep their format). */
export function isDateFormat(code: string | undefined): boolean {
  if (!code) return false;
  return compile(code).sections.some((s) => s.isDate);
}

// ---------------------------------------------------------------------------
// typed input: "12%", "$1,200.50", "2024-01-15", "3:30 PM" become numbers
// with a matching format, the way Excel treats what you type

const MONTH_INDEX: Record<string, number> = Object.fromEntries(
  MONTHS.flatMap((m, i) => [
    [m.toLowerCase(), i + 1],
    [m.slice(0, 3).toLowerCase(), i + 1],
  ]),
);
MONTH_INDEX.sept = 9;

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 9999) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const fullYear = (y: string) => (y.length <= 2 ? (Number(y) < 30 ? 2000 : 1900) + Number(y) : Number(y));

function parseTime(s: string): { value: number; format: string } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  if (mi > 59 || sec > 59) return null;
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    const pm = m[4][0].toLowerCase() === "p";
    h = (h % 12) + (pm ? 12 : 0);
  } else if (h > 23) return null;
  const format = (m[3] ? "h:mm:ss" : "h:mm") + (m[4] ? " AM/PM" : "");
  return { value: (h * 3600 + mi * 60 + sec) / 86_400, format };
}

function parseDate(s: string): { value: number; format: string } | null {
  let m: RegExpExecArray | null;
  let y: number, mo: number, d: number, format: string;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    format = "yyyy-mm-dd";
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    // month first, as in the US, unless the first number can't be a month
    const a = Number(m[1]);
    const b = Number(m[2]);
    y = fullYear(m[3]);
    if (a > 12 && b <= 12) {
      [d, mo] = [a, b];
      format = "d/m/yyyy";
    } else {
      [mo, d] = [a, b];
      format = "m/d/yyyy";
    }
  } else if ((m = /^(\d{1,2})[- ]([a-z]{3,9})[- ,]+(\d{2}|\d{4})$/i.exec(s))) {
    mo = MONTH_INDEX[m[2].toLowerCase()];
    [d, y] = [Number(m[1]), fullYear(m[3])];
    format = "d-mmm-yy";
  } else if ((m = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/i.exec(s))) {
    mo = MONTH_INDEX[m[1].toLowerCase()];
    [d, y] = [Number(m[2]), Number(m[3])];
    format = "mmm d, yyyy";
  } else return null;
  if (!mo || !validDate(y, mo, d)) return null;
  return { value: dateToSerial(y, mo, d), format };
}

const CURRENCY: Record<string, string> = { $: "$", "€": "€", "£": "£", "¥": "¥", "₹": "₹" };

/**
 * A number typed with formatting (percent, currency, thousands separators,
 * a date or a time): its value and the format that shows it the same way.
 * Plain numbers and anything else return null.
 */
export function parseTyped(text: string): { value: number; format: string } | null {
  const s = text.trim();
  if (!s || s.length > 40) return null;
  // dates and times
  const time = parseTime(s);
  if (time) return time;
  const date = parseDate(s);
  if (date) return date;
  const dt = /^(.+?)[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m?)?)$/i.exec(s);
  if (dt) {
    const dd = parseDate(dt[1]);
    const tt = parseTime(dt[2]);
    if (dd && tt) return { value: dd.value + tt.value, format: `${dd.format} ${tt.format}` };
  }
  // numbers with decoration: sign, (negative), currency, separators, %
  const m = /^([-+])?(\()?\s*([$€£¥₹])?\s*([-+])?(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*(%)?\)?$/.exec(s);
  if (!m || (!m[5] && !m[6])) return null;
  const paren = !!m[2];
  if (paren !== s.endsWith(")")) return null;
  const sym = m[3];
  const pct = !!m[7];
  const grouped = !!m[5]?.includes(",");
  if (!sym && !pct && !grouped && !paren) return null; // a plain number
  const negative = m[1] === "-" || m[4] === "-" || paren;
  let value = Number((m[5] ?? "0").replace(/,/g, "") + (m[6] ?? ""));
  if (pct) value /= 100;
  if (negative) value = -value;
  const decimals = m[6] ? "." + "0".repeat(Math.min(m[6].length - 1, 10)) : "";
  let format: string;
  if (pct) format = `0${decimals}%`;
  else if (sym) format = `${sym === "$" ? "$" : `"${CURRENCY[sym]}"`}#,##0${decimals ? ".00" : ""}`;
  else format = `#,##0${decimals ? ".00" : ""}`;
  if (sym && paren) format = `${format};(${format})`;
  return { value, format };
}
