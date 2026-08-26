/**
 * Bank statements to transactions. Works on lines of positioned cells, so a
 * PDF page (cells where the text sits) and a CSV (cell = column number) go
 * through the same steps:
 *
 * 1. find the header line and what each column is (date, details, money
 *    out, money in, amount, balance);
 * 2. a line starting with a date is a transaction; lines of text under it
 *    are the rest of its description; amounts go to the column they sit in;
 * 3. dates without a year get one from the statement, rolling over at the
 *    new year; day/month order is worked out for the whole statement;
 * 4. every balance is checked: previous balance + amount = this balance.
 */
import { dateToSerial } from "../numfmt";
import { parseDateLoose, parseNumberLoose, type DateOrder, type NumberStyle } from "./values";

export interface StatementCell {
  x: number;
  x2: number;
  text: string;
}

export interface StatementLine {
  page: number;
  cells: StatementCell[];
}

export type StatementRole = "date" | "description" | "debit" | "credit" | "amount" | "balance";

export interface Transaction {
  /** Excel serial date, or null when the date couldn't be read */
  date: number | null;
  dateText: string;
  description: string;
  /** money in positive, money out negative */
  amount: number | null;
  balance: number | null;
  page: number;
  /** index of the transaction's first line in the input */
  line: number;
  /** "ok", "break" (balance doesn't follow), or "" when there's nothing to check against */
  check: "ok" | "break" | "";
  /** the balance the previous one and this amount add up to, when it's a break */
  expected?: number;
  /** the amount had no sign; it was worked out from the balances */
  signFromBalance?: boolean;
}

export interface StatementPage {
  page: number;
  opening: number | null;
  closing: number | null;
  transactions: number;
  breaks: number;
}

export interface Statement {
  transactions: Transaction[];
  columns: StatementRole[];
  opening: number | null;
  closing: number | null;
  /** the closing balance printed on the statement, if any, and whether the transactions reach it */
  statedClosing: number | null;
  closingMatches: boolean | null;
  pages: StatementPage[];
  breaks: number;
  dateOrder: DateOrder;
  numberStyle: NumberStyle;
}

const ROLE_TESTS: [StatementRole, RegExp][] = [
  ["description", /descr|details|particulars|narrat|memo|payee/i],
  ["balance", /balance/i],
  ["amount", /^(transaction )?amount|^amt\b|^value$/i],
  ["debit", /debit|withdraw|paid out|money out|payments?\b|^out$|^dr\.?$|spent|charges?/i],
  ["credit", /credit|deposit|paid in|money in|receipts?\b|^in$|^cr\.?$|received/i],
  ["date", /date|^posted|^day$/i],
  ["description", /transaction|reference|^ref|type|info/i],
];

function roleOf(text: string): StatementRole | null {
  const t = text.trim();
  if (!t || t.length > 40) return null;
  for (const [role, re] of ROLE_TESTS) if (re.test(t)) return role;
  return null;
}

interface HeaderCol {
  role: StatementRole;
  x: number;
  x2: number;
}

function headerOf(line: StatementLine): HeaderCol[] | null {
  const cols: HeaderCol[] = [];
  const seen = new Set<StatementRole>();
  for (const c of line.cells) {
    const role = roleOf(c.text);
    if (!role) continue;
    // a second date column (value date) or details column joins the first
    if (seen.has(role) && (role === "date" || role === "description")) continue;
    seen.add(role);
    cols.push({ role, x: c.x, x2: c.x2 });
  }
  const money = seen.has("amount") || seen.has("debit") || seen.has("credit");
  return seen.has("date") && money && cols.length >= 3 ? cols : null;
}

/** Which header column a cell belongs to: most overlap, else nearest. */
function columnFor(cell: StatementCell, cols: HeaderCol[]): HeaderCol {
  let best = cols[0];
  let bestScore = -Infinity;
  for (const h of cols) {
    const overlap = Math.min(cell.x2, h.x2) - Math.max(cell.x, h.x);
    const score = overlap >= 0 ? overlap + 1e6 : overlap; // any overlap beats any distance
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return best;
}

const OPENING = /^(opening|previous|brought forward|balance (brought|b\/?f)|start(ing)? balance|balance forward|b\/f\b)|brought forward|balance b\/?f/i;
const CLOSING = /^(closing|ending|end balance|balance (carried|c\/?f)|carried forward|c\/f\b|new balance)|carried forward|balance c\/?f/i;
const TOTALS = /^(total|totals|sub[\s-]?total|page total)\b/i;
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** A date that may lack its year: 12 Mar, Mar 12, 12/03, 12-Mar-24, 2024-03-12. */
function dateBits(text: string, order: DateOrder): { y: number | null; m: number; d: number } | null {
  const s = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
  const full = parseDateLoose(s, order);
  if (full !== null) {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(full) * 86_400_000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]?([A-Za-z]{3,9})\.?$/.exec(s))) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? { y: null, m: mo, d: Number(m[1]) } : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?\s?(\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? { y: null, m: mo, d: Number(m[2]) } : null;
  }
  if ((m = /^(\d{1,2})[/.\-](\d{1,2})$/.exec(s))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [d, mo] = order === "mdy" ? [b, a] : [a, b];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { y: null, m: mo, d } : null;
  }
  return null;
}

/** Shaped like a date (even an impossible one like 31/02, which is kept as printed). */
const DATE_SHAPE = /^(\d{1,2}[/.\-]\d{1,2}([/.\-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})$/;
const looksLikeDate = (text: string) => DATE_SHAPE.test(text.trim()) || dateBits(text, "dmy") !== null || dateBits(text, "mdy") !== null;

/** A money amount, with any CR / DR / OD mark. */
function money(text: string, style: NumberStyle): { value: number; mark: "cr" | "dr" | null } | null {
  let s = text.trim();
  let mark: "cr" | "dr" | null = null;
  const mm = /\s*(CR|DR|OD|Cr|Dr|Od|cr|dr|od)\.?$/.exec(s);
  if (mm) {
    mark = mm[1].toLowerCase() === "cr" ? "cr" : "dr";
    s = s.slice(0, mm.index);
  }
  const v = parseNumberLoose(s, style);
  if (v === null || !/\d/.test(s)) return null;
  // plain integers that are really references (cheque numbers) are left to the caller's column
  return { value: v, mark };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function parseStatement(lines: StatementLine[]): Statement {
  // the statement's number style and day/month order, from all of its text
  let comma = 0;
  let dot = 0;
  let dmy = 0;
  let mdy = 0;
  const years: number[] = [];
  for (const l of lines) {
    for (const c of l.cells) {
      const t = c.text;
      if (/\d\.\d{3},\d{2}\b/.test(t) || /^-?\d+,\d{2}$/.test(t.trim())) comma++;
      if (/\d,\d{3}\.\d{2}\b/.test(t) || /^-?\d+\.\d{2}$/.test(t.trim())) dot++;
      for (const m of t.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2,4}))?\b/g)) {
        if (Number(m[1]) > 12 && Number(m[2]) <= 12) dmy++;
        else if (Number(m[2]) > 12 && Number(m[1]) <= 12) mdy++;
      }
      for (const m of t.matchAll(/\b(19[89]\d|20\d{2})\b/g)) years.push(Number(m[1]));
    }
  }
  const style: NumberStyle = comma > dot ? "comma" : "dot";
  const order: DateOrder = mdy > dmy ? "mdy" : "dmy";

  let header: HeaderCol[] | null = null;
  const txns: Transaction[] = [];
  let opening: number | null = null;
  let statedClosing: number | null = null;
  const pageOpenings = new Map<number, number>();
  let headerKey = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.cells.length) continue;
    const h = headerOf(line);
    if (h) {
      header = h;
      headerKey = line.cells.map((c) => c.text.toLowerCase()).join("|");
      continue;
    }
    if (!header) continue;
    if (line.cells.map((c) => c.text.toLowerCase()).join("|") === headerKey) continue;

    // sort the line's cells into the columns
    const by: Partial<Record<StatementRole, string[]>> = {};
    let firstDate: string | null = null;
    line.cells.forEach((c, k) => {
      let col = columnFor(c, header!).role;
      if (k === 0 && looksLikeDate(c.text)) {
        firstDate = c.text;
        return;
      }
      // a number sitting under the details column is still money if the line has nowhere else for it
      if (col === "date" && !looksLikeDate(c.text)) col = "description";
      (by[col] ??= []).push(c.text);
    });
    const dateText = firstDate ?? (by.date ?? []).find(looksLikeDate) ?? null;
    const text = (by.description ?? []).join(" ").trim();
    const num = (role: StatementRole) => {
      for (const t of by[role] ?? []) {
        const v = money(t, style);
        if (v) return v;
      }
      return null;
    };
    const debit = num("debit");
    const credit = num("credit");
    const amt = num("amount");
    const bal = num("balance");
    const balance = bal ? (bal.mark === "dr" ? -Math.abs(bal.value) : bal.mark === "cr" ? Math.abs(bal.value) : bal.value) : null;
    let amount: number | null = null;
    let unsigned = false;
    if (debit || credit) amount = round2((credit ? Math.abs(credit.value) : 0) - (debit ? Math.abs(debit.value) : 0));
    else if (amt) {
      amount = amt.mark === "dr" ? -Math.abs(amt.value) : amt.mark === "cr" ? Math.abs(amt.value) : amt.value;
      unsigned = amt.mark === null && amt.value >= 0;
    }
    const all = line.cells.map((c) => c.text).join(" ");

    if (OPENING.test(text || all) && amount === null) {
      if (balance !== null) {
        if (!txns.length && opening === null) opening = balance;
        if (!pageOpenings.has(line.page)) pageOpenings.set(line.page, balance);
      }
      continue;
    }
    if (CLOSING.test(text || all) && amount === null) {
      if (balance !== null) statedClosing = balance;
      continue;
    }
    if (TOTALS.test(text || all)) continue;

    const prev = txns[txns.length - 1];
    if (dateText === null && amount === null && balance === null) {
      // more of the description above
      if (prev && text) prev.description = (prev.description + " " + text).trim();
      continue;
    }
    if (dateText === null && prev && prev.amount === null && amount !== null) {
      // the amounts come on the last line of a wrapped transaction
      prev.amount = amount;
      prev.balance = balance;
      if (text) prev.description = (prev.description + " " + text).trim();
      if (unsigned) (prev as Transaction & { unsigned?: boolean }).unsigned = true;
      continue;
    }
    const t: Transaction & { unsigned?: boolean } = {
      date: null,
      dateText: dateText ?? prev?.dateText ?? "",
      description: text,
      amount,
      balance,
      page: line.page,
      line: i,
      check: "",
    };
    if (unsigned) t.unsigned = true;
    txns.push(t);
  }

  // ------------------------------------------------------------ dates --
  // (a loop, not Math.min(...years): a long statement has more years than the call stack takes arguments)
  let baseYear = Infinity;
  for (const y of years) if (y >= 1980 && y < baseYear) baseYear = y;
  if (baseYear === Infinity) baseYear = new Date().getUTCFullYear();
  let year = baseYear;
  let lastMonth = 0;
  for (const t of txns) {
    const bits = dateBits(t.dateText, order);
    if (!bits) continue;
    if (bits.y !== null) {
      year = bits.y;
    } else {
      if (lastMonth && bits.m < lastMonth - 6) year++; // December to January
      bits.y = year;
    }
    lastMonth = bits.m;
    const last = new Date(Date.UTC(bits.y, bits.m, 0)).getUTCDate();
    if (bits.d <= last) t.date = dateToSerial(bits.y, bits.m, bits.d);
  }

  // ---------------------------------------------------- running balance --
  let running: number | null = opening;
  if (running === null) {
    const first = txns.find((t) => t.balance !== null);
    if (first && first.amount !== null && first.balance !== null && first === txns[0]) running = round2(first.balance - first.amount);
  }
  const startOpening = opening ?? running;
  const pageStats = new Map<number, StatementPage>();
  let breaks = 0;
  for (const t of txns as (Transaction & { unsigned?: boolean })[]) {
    let ps = pageStats.get(t.page);
    if (!ps) {
      ps = { page: t.page, opening: pageOpenings.get(t.page) ?? running, closing: null, transactions: 0, breaks: 0 };
      pageStats.set(t.page, ps);
    }
    ps.transactions++;
    if (t.amount !== null && running !== null) {
      const plus = round2(running + t.amount);
      if (t.balance === null) running = plus;
      else if (near(plus, t.balance)) {
        t.check = "ok";
        running = t.balance;
      } else if (t.unsigned && near(round2(running - t.amount), t.balance)) {
        t.amount = -t.amount;
        t.signFromBalance = true;
        t.check = "ok";
        running = t.balance;
      } else {
        t.check = "break";
        t.expected = plus;
        breaks++;
        ps.breaks++;
        running = t.balance; // carry on from what the bank says, so one break isn't counted again and again
      }
    } else if (t.balance !== null) running = t.balance;
    if (t.balance !== null) ps.closing = t.balance;
    else if (running !== null) ps.closing = running;
    delete t.unsigned;
  }
  const closing = running;
  const columns = header ? header.map((h) => h.role) : [];
  return {
    transactions: txns,
    columns,
    opening: startOpening,
    closing,
    statedClosing,
    closingMatches: statedClosing === null || closing === null ? null : near(statedClosing, closing),
    pages: [...pageStats.values()],
    breaks,
    dateOrder: order,
    numberStyle: style,
  };
}

/** A CSV (rows of text) as statement lines: a cell's position is its column. */
export function rowsToLines(rows: string[][]): StatementLine[] {
  return rows.map((r) => ({ page: 1, cells: r.flatMap((text, c) => (text.trim() ? [{ x: c, x2: c + 0.9, text: text.trim() }] : [])) }));
}
