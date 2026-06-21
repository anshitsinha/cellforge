/**
 * Text functions. TEXT uses the same number-format engine as the grid, so
 * TEXT(A1, "#,##0.00") shows exactly what formatting A1 that way would.
 */
import { CellError, errors } from "../ast";
import { eachValue, isError, scalarArg, toBool, toNumber, toText, type Arg, type EvalContext, type Scalar } from "../evaluate";
import { formatValue } from "../../numfmt";
import { define } from "./define";

const txt = (a: Arg | undefined): string | CellError => (a === undefined ? errors.value : toText(scalarArg(a)));
function int(a: Arg | undefined, fallback?: number): number | CellError {
  if (a === undefined) return fallback ?? errors.value;
  const n = toNumber(scalarArg(a));
  return isError(n) ? n : Math.trunc(n);
}

const textArg = { name: "text", description: "the text or a cell" };

define(
  {
    name: "LEFT",
    category: "Text",
    summary: "The first characters of a text.",
    args: [textArg, { name: "count", description: "how many characters; 1 if left out", optional: true }],
    examples: [['=LEFT("INV-2024-001", 3)', "INV"], ["=LEFT(B1)", "N"]],
  },
  (args) => {
    const t = txt(args[0]);
    const n = int(args[1], 1);
    if (isError(t)) return t;
    if (isError(n)) return n;
    return n < 0 ? errors.value : t.slice(0, n);
  },
);

define(
  {
    name: "RIGHT",
    category: "Text",
    summary: "The last characters of a text.",
    args: [textArg, { name: "count", description: "how many characters; 1 if left out", optional: true }],
    examples: [['=RIGHT("INV-2024-001", 3)', "001"]],
  },
  (args) => {
    const t = txt(args[0]);
    const n = int(args[1], 1);
    if (isError(t)) return t;
    if (isError(n)) return n;
    return n < 0 ? errors.value : n === 0 ? "" : t.slice(-n);
  },
);

define(
  {
    name: "MID",
    category: "Text",
    summary: "Characters from the middle of a text.",
    args: [textArg, { name: "start", description: "position of the first character, 1 = the first" }, { name: "count", description: "how many characters" }],
    examples: [['=MID("INV-2024-001", 5, 4)', "2024"]],
  },
  (args) => {
    if (args.length !== 3) return errors.value;
    const t = txt(args[0]);
    const s = int(args[1]);
    const n = int(args[2]);
    if (isError(t)) return t;
    if (isError(s)) return s;
    if (isError(n)) return n;
    if (s < 1 || n < 0) return errors.value;
    return t.slice(s - 1, s - 1 + n);
  },
);

function findImpl(caseSensitive: boolean) {
  return (args: Arg[]): Scalar => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const what = txt(args[0]);
    const within = txt(args[1]);
    const start = int(args[2], 1);
    if (isError(what)) return what;
    if (isError(within)) return within;
    if (isError(start)) return start;
    if (start < 1 || start > within.length + 1) return errors.value;
    if (caseSensitive) {
      const i = within.indexOf(what, start - 1);
      return i < 0 ? errors.value : i + 1;
    }
    // SEARCH: case-insensitive, with ? and * wildcards (~ escapes)
    let re = "";
    for (let i = 0; i < what.length; i++) {
      const ch = what[i];
      if (ch === "~" && i + 1 < what.length) re += what[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      else if (ch === "*") re += "[\\s\\S]*?";
      else if (ch === "?") re += "[\\s\\S]";
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const m = new RegExp(re, "i").exec(within.slice(start - 1));
    return m ? m.index + start : errors.value;
  };
}

define(
  {
    name: "FIND",
    category: "Text",
    summary: "Where one text starts inside another (1 = the first character), matching case. #VALUE! if it isn't there.",
    args: [
      { name: "find_text", description: "what to look for" },
      { name: "within_text", description: "where to look" },
      { name: "start", description: "where to start looking; 1 if left out", optional: true },
    ],
    examples: [['=FIND("-", "INV-2024-001")', 4], ['=FIND("x", "INV")', "#VALUE!"]],
  },
  findImpl(true),
);

define(
  {
    name: "SEARCH",
    category: "Text",
    summary: "Like FIND, but ignoring case and allowing ? and * wildcards.",
    args: [
      { name: "find_text", description: "what to look for" },
      { name: "within_text", description: "where to look" },
      { name: "start", description: "where to start looking; 1 if left out", optional: true },
    ],
    examples: [['=SEARCH("inv", "Paid INV-7")', 6], ['=SEARCH("2?24", "INV-2024")', 5]],
  },
  findImpl(false),
);

define(
  {
    name: "SUBSTITUTE",
    category: "Text",
    summary: "Replaces some text with other text: every occurrence, or just the n-th.",
    args: [
      textArg,
      { name: "old_text", description: "what to replace (matching case)" },
      { name: "new_text", description: "what to put instead" },
      { name: "instance", description: "which occurrence; all if left out", optional: true },
    ],
    examples: [['=SUBSTITUTE("1,234,567", ",", "")', "1234567"], ['=SUBSTITUTE("a-b-c", "-", "+", 2)', "a-b+c"]],
  },
  (args) => {
    if (args.length < 3 || args.length > 4) return errors.value;
    const t = txt(args[0]);
    const old = txt(args[1]);
    const neu = txt(args[2]);
    if (isError(t)) return t;
    if (isError(old)) return old;
    if (isError(neu)) return neu;
    if (old === "") return t;
    if (args.length === 3) return t.split(old).join(neu);
    const n = int(args[3]);
    if (isError(n)) return n;
    if (n < 1) return errors.value;
    let at = -1;
    for (let k = 0; k < n; k++) {
      at = t.indexOf(old, at + 1);
      if (at < 0) return t;
    }
    return t.slice(0, at) + neu + t.slice(at + old.length);
  },
);

define(
  {
    name: "REPLACE",
    category: "Text",
    summary: "Replaces characters at a position with other text.",
    args: [
      textArg,
      { name: "start", description: "position of the first character to replace" },
      { name: "count", description: "how many characters to replace" },
      { name: "new_text", description: "what to put instead" },
    ],
    examples: [['=REPLACE("INV-2024-001", 5, 4, "2025")', "INV-2025-001"]],
  },
  (args) => {
    if (args.length !== 4) return errors.value;
    const t = txt(args[0]);
    const s = int(args[1]);
    const n = int(args[2]);
    const neu = txt(args[3]);
    if (isError(t)) return t;
    if (isError(s)) return s;
    if (isError(n)) return n;
    if (isError(neu)) return neu;
    if (s < 1 || n < 0) return errors.value;
    return t.slice(0, s - 1) + neu + t.slice(s - 1 + n);
  },
);

define(
  {
    name: "TEXT",
    category: "Text",
    summary: "A number as text in a number format, exactly as a cell with that format shows it.",
    args: [
      { name: "value", description: "a number (or date)" },
      { name: "format", description: 'a format code, e.g. "#,##0.00", "0%", "yyyy-mm-dd", "mmm yyyy"' },
    ],
    examples: [
      ['=TEXT(1234.5, "#,##0.00")', "1,234.50"],
      ['=TEXT(D1, "mmm yyyy")', "Jan 2024"],
      ['=TEXT(0.125, "0.0%")', "12.5%"],
    ],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const v = scalarArg(args[0]);
    const code = txt(args[1]);
    if (isError(v)) return v;
    if (isError(code)) return code;
    if (typeof v === "string") {
      const n = toNumber(v);
      if (!isError(n)) return formatValue(n, code).text;
    }
    return formatValue(typeof v === "boolean" ? v : v, code).text;
  },
);

define(
  {
    name: "VALUE",
    category: "Text",
    summary: 'Text that looks like a number, as a number: "1,234", "12%", "$5", dates and times.',
    args: [textArg],
    examples: [['=VALUE("1,234")', 1234], ['=VALUE("12%")', 0.12], ['=VALUE("abc")', "#VALUE!"]],
  },
  (args) => {
    if (args.length !== 1) return errors.value;
    const v = scalarArg(args[0]);
    if (typeof v === "number" || isError(v)) return v;
    return toNumber(typeof v === "boolean" ? errors.value : v);
  },
);

define(
  {
    name: "NUMBERVALUE",
    category: "Text",
    summary: "Text to a number with the separators you say, for exports from other countries (\"1.234,56\").",
    args: [
      textArg,
      { name: "decimal_separator", description: 'e.g. ","; "." if left out', optional: true },
      { name: "group_separator", description: 'e.g. "."; "," if left out', optional: true },
    ],
    examples: [['=NUMBERVALUE("1.234,56", ",", ".")', 1234.56], ['=NUMBERVALUE("2,5%", ",")', 0.025]],
  },
  (args) => {
    if (args.length < 1 || args.length > 3) return errors.value;
    const t = txt(args[0]);
    const dec = args[1] ? txt(args[1]) : ".";
    const grp = args[2] ? txt(args[2]) : ",";
    if (isError(t)) return t;
    if (isError(dec)) return dec;
    if (isError(grp)) return grp;
    let s = t.replace(/\s/g, "");
    let pct = 0;
    while (s.endsWith("%")) {
      pct++;
      s = s.slice(0, -1);
    }
    // a group separator the same as the decimal one would eat the decimals
    if (grp && grp[0] !== dec[0]) s = s.split(grp[0]).join("");
    if (dec && dec[0] !== ".") s = s.split(dec[0]).join(".");
    if (s === "") return 0;
    const n = Number(s);
    return Number.isNaN(n) ? errors.value : n / 100 ** pct;
  },
);

function joinImpl(args: Arg[], ctx: EvalContext, delim: string, skipEmpty: boolean, from = 0): Scalar {
  const parts: string[] = [];
  let err: CellError | null = null;
  eachValue(args.slice(from), ctx, (v) => {
    if (err) return;
    if (isError(v)) return void (err = v);
    const s = toText(v) as string;
    if (skipEmpty && s === "") return;
    parts.push(s);
  });
  if (err) return err;
  const out = parts.join(delim);
  return out.length > 32_767 ? errors.value : out;
}

define(
  {
    name: "TEXTJOIN",
    category: "Text",
    summary: "Joins texts and ranges with a separator, optionally skipping empty cells.",
    args: [
      { name: "delimiter", description: 'what goes between, e.g. ", "' },
      { name: "ignore_empty", description: "TRUE to skip empty cells" },
      { name: "text1", description: "a text, cell or range" },
      { name: "text2", description: "more", optional: true, repeats: true },
    ],
    examples: [['=TEXTJOIN(", ", TRUE, B1:B3)', "North, South, North"], ['=TEXTJOIN("/", TRUE, A3:A5)', "30/apple"]],
  },
  (args, ctx) => {
    if (args.length < 3) return errors.value;
    const d = txt(args[0]);
    const skip = toBool(scalarArg(args[1]));
    if (isError(d)) return d;
    if (isError(skip)) return skip;
    return joinImpl(args, ctx, d, skip, 2);
  },
);

define(
  {
    name: "CONCATENATE",
    category: "Text",
    summary: "Joins texts (the older CONCAT; ranges aren't expanded in Excel, so pass cells one by one).",
    args: [{ name: "text1", description: "a text or cell" }, { name: "text2", description: "more", optional: true, repeats: true }],
    examples: [['=CONCATENATE(B1, " ", A1)', "North 10"]],
  },
  (args, ctx) => (args.some((a) => a.kind === "range") ? errors.value : joinImpl(args, ctx, "", false)),
);

define(
  {
    name: "PROPER",
    category: "Text",
    summary: "Capitalises the first letter of every word.",
    args: [textArg],
    examples: [['=PROPER("acme corp ltd")', "Acme Corp Ltd"]],
  },
  (args) => {
    const t = txt(args[0]);
    if (isError(t)) return t;
    return t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  },
);

define(
  {
    name: "HYPERLINK",
    category: "Text",
    summary: "A link: shows the friendly name (or the address), and Ctrl+click opens the address. Use #Sheet!A1 for a place in the workbook.",
    args: [
      { name: "link_location", description: "a web address, or #Sheet!A1" },
      { name: "friendly_name", description: "what the cell shows", optional: true },
    ],
    examples: [
      ['=HYPERLINK("https://example.com", "Example")', "Example"],
      ['=HYPERLINK("#Sheet2!A1")', "#Sheet2!A1"],
    ],
  },
  (args) => {
    const link = txt(args[0]);
    if (isError(link)) return link;
    if (args.length < 2) return link;
    const name = args[1];
    return name.kind === "value" && typeof name.value === "number" ? name.value : txt(name);
  },
);

define(
  {
    name: "EXACT",
    category: "Text",
    summary: "TRUE if two texts are exactly the same, including upper and lower case (= ignores case).",
    args: [{ name: "text1", description: "a text" }, { name: "text2", description: "another text" }],
    examples: [['=EXACT("North", B1)', true], ['=EXACT("north", B1)', false]],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const a = txt(args[0]);
    const b = txt(args[1]);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return a === b;
  },
);

define(
  {
    name: "CLEAN",
    category: "Text",
    summary: "Removes non-printing characters (tabs, line breaks, the junk exports leave behind).",
    args: [textArg],
    examples: [['=LEN(CLEAN("ab" & CHAR(9) & "c"))', 3]],
  },
  (args) => {
    const t = txt(args[0]);
    // eslint-disable-next-line no-control-regex
    return isError(t) ? t : t.replace(/[\x00-\x1f]/g, "");
  },
);

define(
  {
    name: "REPT",
    category: "Text",
    summary: "Repeats a text a number of times.",
    args: [textArg, { name: "times", description: "how many times" }],
    examples: [['=REPT("ab", 3)', "ababab"]],
  },
  (args) => {
    const t = txt(args[0]);
    const n = int(args[1]);
    if (isError(t)) return t;
    if (isError(n)) return n;
    if (n < 0 || t.length * n > 32_767) return errors.value;
    return t.repeat(n);
  },
);

define(
  {
    name: "CHAR",
    category: "Text",
    summary: "The character with a code (10 is a line break, 9 a tab).",
    args: [{ name: "number", description: "1 to 255" }],
    examples: [["=CHAR(65)", "A"]],
  },
  (args) => {
    const n = int(args[0]);
    if (isError(n)) return n;
    return n < 1 || n > 255 ? errors.value : String.fromCharCode(n);
  },
);

define(
  {
    name: "CODE",
    category: "Text",
    summary: "The code of a text's first character.",
    args: [textArg],
    examples: [['=CODE("A")', 65]],
  },
  (args) => {
    const t = txt(args[0]);
    if (isError(t)) return t;
    return t.length ? t.charCodeAt(0) : errors.value;
  },
);

function beforeAfter(after: boolean) {
  return (args: Arg[]): Scalar => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const t = txt(args[0]);
    const d = txt(args[1]);
    const n = int(args[2], 1);
    if (isError(t)) return t;
    if (isError(d)) return d;
    if (isError(n)) return n;
    if (n === 0 || d === "") return errors.value;
    // negative instance counts from the end
    let at = -1;
    if (n > 0) {
      for (let k = 0; k < n; k++) {
        at = t.indexOf(d, at + 1);
        if (at < 0) return errors.na;
      }
    } else {
      at = t.length;
      for (let k = 0; k < -n; k++) {
        at = t.lastIndexOf(d, at - 1);
        if (at < 0) return errors.na;
      }
    }
    return after ? t.slice(at + d.length) : t.slice(0, at);
  };
}

const baArgs = [
  textArg,
  { name: "delimiter", description: 'where to split, e.g. "-"' },
  { name: "instance", description: "which occurrence (1 if left out; negative counts from the end)", optional: true },
];

define(
  {
    name: "TEXTBEFORE",
    category: "Text",
    summary: "The text before a delimiter.",
    args: baArgs,
    examples: [['=TEXTBEFORE("INV-2024-001", "-")', "INV"], ['=TEXTBEFORE("INV-2024-001", "-", -1)', "INV-2024"]],
  },
  beforeAfter(false),
);

define(
  {
    name: "TEXTAFTER",
    category: "Text",
    summary: "The text after a delimiter.",
    args: baArgs,
    examples: [['=TEXTAFTER("INV-2024-001", "-")', "2024-001"], ['=TEXTAFTER("INV-2024-001", "-", -1)', "001"]],
  },
  beforeAfter(true),
);

