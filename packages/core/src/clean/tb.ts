/**
 * Trial balances from whatever layout an accounting system exports: work
 * out which column is the account code, the name, debit and credit or a
 * signed balance, this period and the prior one; then build a standard
 * table (code, name, current, prior, movement) and check it balances.
 */
import { unwrapReport } from "./unwrap";
import { parseNumberLoose, type NumberStyle } from "./values";

export type TbRole =
  | "code"
  | "name"
  | "code+name"
  | "debit"
  | "credit"
  | "balance"
  | "prior debit"
  | "prior credit"
  | "prior balance"
  | "ignore";

export const TB_ROLES: TbRole[] = ["code", "name", "code+name", "debit", "credit", "balance", "prior debit", "prior credit", "prior balance", "ignore"];

const PRIOR = /prior|previous|last year|\bpy\b|comparative|opening|brought|b\/f|\bly\b/i;

/** What each column most likely is, from its header and values. */
export function guessTbRoles(header: string[], rows: string[][], style: NumberStyle = "dot"): TbRole[] {
  const numericShare = header.map((_, c) => {
    const vals = rows.map((r) => (r[c] ?? "").trim()).filter(Boolean);
    return vals.length ? vals.filter((v) => parseNumberLoose(v, style) !== null).length / vals.length : 0;
  });
  // years in the headers: the latest is current, an earlier one prior
  const yearOf = (h: string) => Number(/\b(19|20)\d{2}\b/.exec(h)?.[0] ?? 0);
  const years = header.map(yearOf).filter(Boolean);
  const latest = years.length ? Math.max(...years) : 0;
  const isPrior = (h: string) => PRIOR.test(h) || (latest > 0 && yearOf(h) > 0 && yearOf(h) < latest);

  const roles: TbRole[] = header.map((raw, c) => {
    const h = raw.trim().toLowerCase();
    const prior = isPrior(h);
    if (/^(dr|debit|debits)\b|\bdebit/.test(h)) return prior ? "prior debit" : "debit";
    if (/^(cr|credit|credits)\b|\bcredit/.test(h)) return prior ? "prior credit" : "credit";
    if (/(code|number|\bno\.?$|\bnum\b|\bid$|^gl$|^acct$|nominal|ledger)/.test(h) && !/name|descr/.test(h)) return "code";
    if (/name|descr|title|^account$|^particulars/.test(h)) return numericShare[c] > 0.8 ? "code" : "name";
    if (/balance|amount|net|total|value|closing|current|\bcy\b|this year|ytd|\b(19|20)\d{2}\b/.test(h) || numericShare[c] > 0.8) {
      return prior ? "prior balance" : "balance";
    }
    return "ignore";
  });

  // "Debit Credit Debit Credit": the second pair is the prior period
  const pairUp = (cur: TbRole, pri: TbRole) => {
    const at = roles.flatMap((r, i) => (r === cur ? [i] : []));
    for (const i of at.slice(1)) roles[i] = pri;
  };
  pairUp("debit", "prior debit");
  pairUp("credit", "prior credit");
  // two balance columns with no other hint: the first is current
  const bal = roles.flatMap((r, i) => (r === "balance" ? [i] : []));
  for (const i of bal.slice(1)) roles[i] = "prior balance";
  // no code column, but names that start with one ("1000 Cash")
  if (!roles.includes("code")) {
    const ni = roles.indexOf("name");
    if (ni >= 0) {
      const vals = rows.map((r) => (r[ni] ?? "").trim()).filter(Boolean);
      if (vals.length && vals.filter((v) => /^[\w.-]*\d[\w.-]*\s*[-–:]?\s+\S/.test(v)).length / vals.length > 0.8) roles[ni] = "code+name";
    }
  }
  // the first text column without a role is the name, if there's none
  if (!roles.includes("name") && !roles.includes("code+name")) {
    const i = roles.findIndex((r, c) => r === "ignore" && numericShare[c] < 0.5);
    if (i >= 0) roles[i] = "name";
  }
  return roles;
}

export interface TbLine {
  code: string;
  name: string;
  current: number;
  prior: number | null;
  /** row in the rows given */
  row: number;
}

export interface TbResult {
  lines: TbLine[];
  totalCurrent: number;
  totalPrior: number | null;
  balances: boolean;
  priorBalances: boolean | null;
  duplicates: string[];
  /** rows left out (totals, headings without numbers) */
  skipped: number[];
  /** values in number columns that aren't numbers */
  bad: { row: number; col: number; value: string }[];
}

const TOTAL = /^(total|totals|grand total|sub[\s-]?total|net (profit|loss)|difference|check)\b/i;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Build the trial balance, debits positive and credits negative. A single
 * balance column is taken as signed: credits shown negative, in brackets,
 * or marked CR.
 */
export function buildTb(rows: string[][], roles: TbRole[], style: NumberStyle = "dot"): TbResult {
  const col = (r: TbRole) => roles.indexOf(r);
  const lines: TbLine[] = [];
  const skipped: number[] = [];
  const bad: TbResult["bad"] = [];
  const num = (row: string[], r: number, c: number): number | null => {
    if (c < 0) return null;
    const raw = (row[c] ?? "").trim();
    if (!raw || raw === "-" || raw === "–") return 0;
    const v = parseNumberLoose(raw, style);
    if (v === null) bad.push({ row: r, col: c, value: raw });
    return v ?? 0;
  };
  const hasPrior = col("prior debit") >= 0 || col("prior credit") >= 0 || col("prior balance") >= 0;
  rows.forEach((row, r) => {
    let code = col("code") >= 0 ? (row[col("code")] ?? "").trim() : "";
    let name = col("name") >= 0 ? (row[col("name")] ?? "").trim() : "";
    if (col("code+name") >= 0) {
      const both = (row[col("code+name")] ?? "").trim();
      const m = /^([\w.-]*\d[\w.-]*)\s*[-–:]?\s+(.*)$/.exec(both);
      if (m) [code, name] = [m[1], m[2]];
      else name = both;
    }
    const label = `${code} ${name}`.trim();
    const numbersPresent = roles.some((ro, c) => ro !== "code" && ro !== "name" && ro !== "code+name" && ro !== "ignore" && (row[c] ?? "").trim() !== "");
    if (!numbersPresent || TOTAL.test(name || code) || !label) {
      skipped.push(r);
      return;
    }
    const current =
      col("balance") >= 0 ? (num(row, r, col("balance")) ?? 0) : (num(row, r, col("debit")) ?? 0) - Math.abs(num(row, r, col("credit")) ?? 0);
    const prior = !hasPrior
      ? null
      : col("prior balance") >= 0
        ? (num(row, r, col("prior balance")) ?? 0)
        : (num(row, r, col("prior debit")) ?? 0) - Math.abs(num(row, r, col("prior credit")) ?? 0);
    lines.push({ code, name, current: round2(current), prior: prior === null ? null : round2(prior), row: r });
  });
  const totalCurrent = round2(lines.reduce((s, l) => s + l.current, 0));
  const totalPrior = hasPrior ? round2(lines.reduce((s, l) => s + (l.prior ?? 0), 0)) : null;
  const seen = new Map<string, number>();
  for (const l of lines) if (l.code) seen.set(l.code, (seen.get(l.code) ?? 0) + 1);
  return {
    lines,
    totalCurrent,
    totalPrior,
    balances: Math.abs(totalCurrent) < 0.005,
    priorBalances: totalPrior === null ? null : Math.abs(totalPrior) < 0.005,
    duplicates: [...seen].filter(([, n]) => n > 1).map(([c]) => c),
    skipped,
    bad,
  };
}

/** A sheet's text as a trial balance: header row found, then roles guessed. */
export function readTb(text: string[][], style: NumberStyle = "dot"): { header: string[]; rows: string[][]; sourceRows: number[]; roles: TbRole[] } {
  const u = unwrapReport(text);
  return { header: u.header, rows: u.rows, sourceRows: u.sourceRows, roles: guessTbRoles(u.header, u.rows, style) };
}
