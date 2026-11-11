/**
 * Guess what each column of a sheet holds (dates, amounts, references,
 * names, descriptions, account codes) from its header and its first values,
 * so the finance tools can start on the right columns.
 *
 * Pure: give it the header names and a sample of each column's values.
 */
import { isDateFormat, parseDateLoose, parseNumberLoose } from "@cellforge/core";

export type ColumnKind = "date" | "amount" | "number" | "code" | "reference" | "text" | "empty";

export interface ColumnSample {
  /** the header text (without any "A: " prefix) */
  name: string;
  /** the first data values (a few hundred is plenty) */
  values: readonly unknown[];
  /** the column's number format, if any */
  numFmt?: string;
}

export interface ColumnProfile {
  index: number;
  name: string;
  kind: ColumnKind;
  /** non-blank values in the sample */
  filled: number;
  /** distinct values / non-blank values (0..1) */
  distinctShare: number;
  /** average text length of the text values */
  avgLength: number;
}

export type ColumnRole = "date" | "amount" | "reference" | "party" | "description" | "account";

export type ColumnRoles = Record<ColumnRole, number>;

const NAME = {
  date: /date|posted|posting|\bperiod\b|value d|\bwhen\b|\bdt\b|\bday\b/i,
  amount: /amount|amt|\bvalue\b|\bnet\b|\bgross\b|\btotal\b|\bsum\b|debit|credit|\bdr\b|\bcr\b|paid|money|withdraw|deposit|balance|price|cost|\bfee/i,
  reference: /\b(ref|refs|reference|invoice|inv|doc|document|voucher|cheque|check|chq|txn|transaction|journal|je|entry|receipt|po|order)\b|ref\.?$|#|\bno\.?$|\bnumber\b|\bid\b|_id$/i,
  party: /vendor|supplier|customer|payee|payer|party|client|employee|counterparty|creditor|debtor|merchant|beneficiary|\bname\b|company/i,
  description: /desc|narrat|detail|memo|particular|\btext\b|comment|note|purpose|explanation/i,
  account: /account|acct|\bgl\b|nominal|ledger|cost cent|\bcode\b/i,
};

/** people who entered or approved a line: they repeat, but they are not the counterparty */
const ACTOR = /\buser\b|preparer|prepared|approv|entered|created|posted by|keyed|operator|login/i;

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/** The kind of one column, from its values (and its header for numbers that might be dates or codes). */
export function columnKind(sample: ColumnSample): ColumnKind {
  const vals = sample.values.filter((v) => !isBlank(v));
  if (!vals.length) return "empty";
  let num = 0;
  let date = 0;
  let text = 0;
  let decimals = 0;
  let codeish = 0;
  const dateFmt = !!sample.numFmt && isDateFormat(sample.numFmt);
  for (const v of vals) {
    if (typeof v === "number") {
      if (dateFmt) date++;
      else {
        num++;
        if (!Number.isInteger(v)) decimals++;
      }
    } else if (typeof v === "boolean") text++;
    else if (v instanceof Date) date++;
    else {
      const s = String(v).trim();
      if (parseDateLoose(s) !== null && /[-/.]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) date++;
      else if (parseNumberLoose(s) !== null && !/^0\d/.test(s)) {
        num++;
        if (/[.,]\d{1,2}$/.test(s)) decimals++;
      } else {
        text++;
        if (s.length <= 24 && /^[A-Z]{0,5}[-_/#. ]?\d[\w\-/.]*$/i.test(s)) codeish++;
      }
    }
  }
  const n = vals.length;
  if (date / n >= 0.6) return "date";
  if (num / n >= 0.6) {
    // a number column named like a date, holding plausible serials (1955..2119)
    if (NAME.date.test(sample.name) && !decimals && vals.every((v) => typeof v !== "number" || (v > 20000 && v < 80000))) return "date";
    if (!decimals && NAME.account.test(sample.name) && !NAME.amount.test(sample.name)) return "code";
    if (!decimals && NAME.reference.test(sample.name) && !NAME.amount.test(sample.name)) return "reference";
    return decimals || NAME.amount.test(sample.name) ? "amount" : "number";
  }
  if (codeish / n >= 0.6) return "reference";
  // a Reference column mixing codes (INV-20452) with bare numbers (20452, a cheque number) is still references
  if (NAME.reference.test(sample.name) && !NAME.amount.test(sample.name) && !decimals && (codeish + num) / n >= 0.6) return "reference";
  return "text";
}

/** Profile every column. */
export function profileColumns(samples: readonly ColumnSample[]): ColumnProfile[] {
  return samples.map((s, index) => {
    const vals = s.values.filter((v) => !isBlank(v));
    const texts = vals.filter((v) => typeof v === "string") as string[];
    return {
      index,
      name: s.name,
      kind: columnKind(s),
      filled: vals.length,
      distinctShare: vals.length ? new Set(vals.map((v) => (typeof v === "string" ? v.trim() : v))).size / vals.length : 0,
      avgLength: texts.length ? texts.reduce((t, x) => t + x.length, 0) / texts.length : 0,
    };
  });
}

/**
 * Which column plays each finance role (-1 when none). Headers win over
 * values; each column gets one role at most.
 */
export function guessRoles(samples: readonly ColumnSample[], profiles = profileColumns(samples)): ColumnRoles {
  const roles: ColumnRoles = { date: -1, amount: -1, reference: -1, party: -1, description: -1, account: -1 };
  const taken = new Set<number>();
  const take = (role: ColumnRole, ok: (p: ColumnProfile) => boolean, rank: (p: ColumnProfile) => number = () => 0) => {
    if (roles[role] >= 0) return;
    const best = profiles.filter((p) => !taken.has(p.index) && p.kind !== "empty" && ok(p)).sort((a, b) => rank(b) - rank(a) || a.index - b.index)[0];
    if (best) {
      roles[role] = best.index;
      taken.add(best.index);
    }
  };
  // by header (and a fitting kind)
  take("date", (p) => p.kind === "date" && NAME.date.test(p.name));
  take("amount", (p) => (p.kind === "amount" || p.kind === "number") && NAME.amount.test(p.name), (p) => (/amount|amt/i.test(p.name) ? 2 : /balance/i.test(p.name) ? -1 : 0));
  take("account", (p) => (p.kind === "code" || p.kind === "reference" || p.kind === "number" || p.kind === "text") && NAME.account.test(p.name) && !NAME.party.test(p.name) && !NAME.description.test(p.name));
  // a document reference (invoice, cheque) beats a journal or entry number, which lines of one entry share
  take("reference", (p) => p.kind !== "date" && p.kind !== "amount" && NAME.reference.test(p.name) && !NAME.description.test(p.name), (p) => (/ref|invoice|\binv\b|doc|voucher|cheque|check|receipt/i.test(p.name) ? 2 : /entry|journal|\bje\b/i.test(p.name) ? -1 : 0));
  take("party", (p) => (p.kind === "text" || p.kind === "reference") && NAME.party.test(p.name) && !ACTOR.test(p.name));
  take("description", (p) => (p.kind === "text" || p.kind === "reference") && NAME.description.test(p.name));
  // by values
  take("date", (p) => p.kind === "date");
  take("amount", (p) => p.kind === "amount", (p) => p.filled);
  take("reference", (p) => p.kind === "reference", (p) => p.distinctShare);
  // a name repeats (several rows per vendor); a description is longer and mostly unique
  take("party", (p) => p.kind === "text" && !ACTOR.test(p.name) && p.distinctShare < 0.9 && p.avgLength <= 40, (p) => -p.distinctShare);
  take("description", (p) => p.kind === "text", (p) => p.avgLength);
  return roles;
}

export type DupMatch = "exact" | "text" | "number" | "date" | "fuzzy";

/**
 * The key columns a duplicate test should start with: the classic
 * "same vendor, same amount" (or "same reference, same amount" when there's
 * no vendor). Never a date column on its own: dates repeat by nature.
 */
export function defaultDuplicateKeys(samples: readonly ColumnSample[]): { col: number; how: DupMatch }[] {
  const profiles = profileColumns(samples);
  const r = guessRoles(samples, profiles);
  const keys: { col: number; how: DupMatch }[] = [];
  if (r.party >= 0) keys.push({ col: r.party, how: "text" });
  else if (r.reference >= 0) keys.push({ col: r.reference, how: "text" });
  if (r.amount >= 0) keys.push({ col: r.amount, how: "exact" });
  if (!keys.length) {
    // no finance shape: the most repetitive non-date column
    const p = profiles.filter((x) => x.kind !== "date" && x.kind !== "empty").sort((a, b) => a.distinctShare - b.distinctShare)[0];
    if (p) keys.push({ col: p.index, how: p.kind === "text" ? "text" : "exact" });
  }
  return keys;
}

/** The column most likely to hold names with spelling variants (vendor, customer, payee…), or -1. */
export function nameColumn(samples: readonly ColumnSample[]): number {
  const profiles = profileColumns(samples);
  const r = guessRoles(samples, profiles);
  if (r.party >= 0) return r.party;
  const text = profiles.filter((p) => p.kind === "text" && !ACTOR.test(p.name) && p.distinctShare < 1).sort((a, b) => a.distinctShare - b.distinctShare || a.avgLength - b.avgLength)[0];
  return text ? text.index : (r.description >= 0 ? r.description : -1);
}

/** The first column of a kind ("amount", "date"…), or -1; a role guess wins when it has that kind. */
export function firstOfKind(samples: readonly ColumnSample[], kinds: readonly ColumnKind[], prefer?: ColumnRole): number {
  const profiles = profileColumns(samples);
  if (prefer) {
    const r = guessRoles(samples, profiles)[prefer];
    if (r >= 0 && kinds.includes(profiles[r].kind)) return r;
  }
  return profiles.find((p) => kinds.includes(p.kind))?.index ?? -1;
}

/** How a result table should show a column of this kind. */
export function formatForKind(kind: ColumnKind): "date" | "amount" | "number" | "text" {
  return kind === "date" ? "date" : kind === "amount" ? "amount" : kind === "number" ? "number" : "text";
}
