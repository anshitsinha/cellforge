/**
 * After a bank reconciliation: the reconciliation statement (balance per
 * bank and per ledger, each taken to an adjusted balance through the
 * reconciling items) and the adjusting entries the ledger needs for what
 * only the bank has (fees, interest, direct debits) and for keying errors.
 *
 * Side A is the ledger (cash book), side B the bank statement, as in
 * reconcile(). Every amount here is in the ledger's sign: positive is money
 * into the bank, negative money out. With `flipB`, B's amounts are turned
 * round first, exactly as reconcile() does.
 */
import type { RecRecord, RecResult } from "./match";
import { KEYING_LABEL, type KeyingError } from "./text";

/** One reconciling item: the records behind it (indexes into A and B) and what it adds to its line. */
export interface RecItem {
  a: number[];
  b: number[];
  /** signed amount this item adds to its line */
  value: number;
  note: string;
  /** for differences: the keying error, if it looks like one */
  keying?: KeyingError;
  /** a ledger posting that repeats one already matched (same reference, amount and date) */
  duplicate?: boolean;
}

export interface RecLine {
  id: string;
  label: string;
  total: number;
  items: RecItem[];
}

export type BankLineId = "bank" | "dit" | "outstanding" | "bankErrors" | "ledger" | "bankReceipts" | "bankPayments" | "ledgerErrors";

export const BANK_LINE_LABEL: Record<BankLineId, string> = {
  bank: "Balance per bank statement",
  dit: "Add: deposits in transit",
  outstanding: "Less: outstanding payments",
  bankErrors: "Add / less: bank errors",
  ledger: "Balance per ledger",
  bankReceipts: "Add: receipts on the bank only (interest, direct credits)",
  bankPayments: "Less: payments on the bank only (fees, direct debits)",
  ledgerErrors: "Add / less: errors in the ledger",
};

export interface RecStatementOptions {
  /** closing balance on the bank statement, in the ledger's sign (an overdraft is negative) */
  bankBalance: number;
  /** closing balance of the bank account in the ledger */
  ledgerBalance: number;
  /** B's amounts have the opposite sign (as passed to reconcile) */
  flipB?: boolean;
  /** who made the errors (mismatched pairs, differences on matched items, keying errors): the ledger (default) or the bank */
  errorsOn?: "ledger" | "bank";
  /** treat unmatched pairs flagged as keying errors as one error instead of two timing items (default true) */
  flagsAsErrors?: boolean;
  /**
   * an unmatched ledger posting with a reference, listed as a duplicate of one
   * that is matched, goes under errors in the ledger (to be reversed) rather
   * than under deposits in transit / outstanding payments (default true)
   */
  duplicatesAsErrors?: boolean;
}

export interface RecStatement {
  bankLines: RecLine[];
  ledgerLines: RecLine[];
  adjustedBank: number;
  adjustedLedger: number;
  /** adjusted bank minus adjusted ledger; 0 when everything is explained */
  difference: number;
  errorsOn: "ledger" | "bank";
  /** unmatched records without an amount, left out */
  noAmount: { a: number[]; b: number[] };
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;
export const money = (n: number): string => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = (r: RecRecord | undefined, flip = false): number => (r?.amount === undefined || !Number.isFinite(r.amount) ? NaN : flip ? -r.amount : r.amount);

/**
 * Differences between what A and B hold for the same thing, each with
 * value A − B (B in A's sign): matched groups that differ within tolerance,
 * mismatched pairs, and (optionally) unmatched pairs flagged as keying
 * errors. The A and B items used by flagged pairs are returned so callers
 * can leave them out of their one-sided lines.
 */
export function differenceItems(r: RecResult, a: RecRecord[], b: RecRecord[], flipB: boolean, flagsAsErrors: boolean): { items: RecItem[]; usedA: Set<number>; usedB: Set<number> } {
  const items: RecItem[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  for (const m of r.matches) {
    if (!m.amountDiff || !Number.isFinite(m.amountDiff)) continue;
    items.push({ a: m.a.slice(), b: m.b.slice(), value: m.amountDiff, note: `matched (${m.rule}) with a difference of ${money(m.amountDiff)}` });
  }
  for (const p of r.mismatched) {
    const x = amt(a[p.a]);
    const y = amt(b[p.b], flipB);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const d = round2(x - y);
    if (!d) continue;
    const f = r.flags.find((g) => g.mismatched && g.a === p.a && g.b === p.b);
    const item: RecItem = { a: [p.a], b: [p.b], value: d, note: `same reference, ledger ${money(x)}, bank ${money(y)}${f ? `: ${KEYING_LABEL[f.kind]}` : ""}` };
    if (f) item.keying = f.kind;
    items.push(item);
  }
  if (flagsAsErrors) {
    for (const f of r.flags) {
      if (f.mismatched) continue;
      const x = amt(a[f.a]);
      const y = amt(b[f.b], flipB);
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      usedA.add(f.a);
      usedB.add(f.b);
      const d = round2(x - y);
      const what = f.field === "key" ? `same amount, reference ${f.kind === "transposition" ? "has two characters swapped" : "differs in one character"}` : `ledger ${money(x)}, bank ${money(y)}: ${KEYING_LABEL[f.kind]}`;
      const item: RecItem = { a: [f.a], b: [f.b], value: d, note: `possible keying error: ${what}` };
      if (f.field === "amount") item.keying = f.kind;
      items.push(item);
    }
  }
  return { items, usedA, usedB };
}

const line = (id: string, label: string, items: RecItem[]): RecLine => ({ id, label, items, total: round2(items.reduce((t, i) => t + i.value, 0)) });

/** The bank reconciliation statement from a reconcile() result (A = ledger, B = bank) and the two stated balances. */
export function recStatement(r: RecResult, a: RecRecord[], b: RecRecord[], opts: RecStatementOptions): RecStatement {
  const flip = !!opts.flipB;
  const errorsOn = opts.errorsOn ?? "ledger";
  const diffs = differenceItems(r, a, b, flip, opts.flagsAsErrors ?? true);
  const noAmount = { a: [] as number[], b: [] as number[] };
  const dit: RecItem[] = [];
  const outstanding: RecItem[] = [];
  const dups: RecItem[] = [];
  if (opts.duplicatesAsErrors ?? true) {
    const matched = new Set<number>();
    for (const m of r.matches) for (const i of m.a) matched.add(i);
    const unmatched = new Set(r.unmatchedA);
    for (const d of r.duplicates) {
      if (d.side !== "A" || !d.items.some((i) => matched.has(i))) continue;
      for (const i of d.items) {
        const x = amt(a[i]);
        if (!unmatched.has(i) || diffs.usedA.has(i) || !a[i]?.key || Number.isNaN(x) || !x) continue;
        diffs.usedA.add(i);
        dups.push({ a: [i], b: [], value: round2(-x), note: `duplicate posting: ${a[i].key} ${money(x)} is already in the ledger and matched`, duplicate: true });
      }
    }
  }
  for (const i of r.unmatchedA) {
    if (diffs.usedA.has(i)) continue;
    const x = amt(a[i]);
    if (Number.isNaN(x)) {
      noAmount.a.push(i);
      continue;
    }
    if (!x) continue;
    (x > 0 ? dit : outstanding).push({ a: [i], b: [], value: x, note: x > 0 ? "in the ledger, not yet on the bank" : "paid in the ledger, not yet through the bank" });
  }
  const receipts: RecItem[] = [];
  const payments: RecItem[] = [];
  for (const j of r.unmatchedB) {
    if (diffs.usedB.has(j)) continue;
    const y = amt(b[j], flip);
    if (Number.isNaN(y)) {
      noAmount.b.push(j);
      continue;
    }
    if (!y) continue;
    (y > 0 ? receipts : payments).push({ a: [], b: [j], value: y, note: "on the bank, not in the ledger" });
  }
  // a difference A − B is put right by −(A − B) in the ledger, or by A − B on the bank side
  const bankErr = errorsOn === "bank" ? diffs.items.map((it) => ({ ...it, value: round2(it.value) })) : [];
  const ledgerErr = [...(errorsOn === "ledger" ? diffs.items.map((it) => ({ ...it, value: round2(-it.value) })) : []), ...dups];
  const bankLines = [
    line("bank", BANK_LINE_LABEL.bank, []),
    line("dit", BANK_LINE_LABEL.dit, dit),
    line("outstanding", BANK_LINE_LABEL.outstanding, outstanding),
    line("bankErrors", BANK_LINE_LABEL.bankErrors, bankErr),
  ];
  bankLines[0].total = round2(opts.bankBalance);
  const ledgerLines = [
    line("ledger", BANK_LINE_LABEL.ledger, []),
    line("bankReceipts", BANK_LINE_LABEL.bankReceipts, receipts),
    line("bankPayments", BANK_LINE_LABEL.bankPayments, payments),
    line("ledgerErrors", BANK_LINE_LABEL.ledgerErrors, ledgerErr),
  ];
  ledgerLines[0].total = round2(opts.ledgerBalance);
  const adjustedBank = round2(bankLines.reduce((t, l) => t + l.total, 0));
  const adjustedLedger = round2(ledgerLines.reduce((t, l) => t + l.total, 0));
  return { bankLines, ledgerLines, adjustedBank, adjustedLedger, difference: round2(adjustedBank - adjustedLedger), errorsOn, noAmount };
}

// ------------------------------------------------- adjusting entries --

/** A keyword rule for the account an adjusting entry goes to. */
export interface AdjRule {
  name: string;
  pattern: RegExp;
  /** account credited when the bank has money in */
  receipt: string;
  /** account debited when the bank has money out */
  payment: string;
  /** add the payee (the text with the keyword and numbers taken out) to the account name */
  payee?: boolean;
}

export const DEFAULT_ADJ_RULES: AdjRule[] = [
  { name: "FX", pattern: /\b(fx|forex|foreign exchange|exchange (rate|difference|diff)|currency conversion|conversion fee|revaluation)\b/i, receipt: "FX gains and losses", payment: "FX gains and losses" },
  { name: "Interest", pattern: /\b(interest|int paid|int recd|credit int|debit int|o\/?d int)\b/i, receipt: "Interest income", payment: "Interest expense" },
  { name: "Returned item", pattern: /\b(returned|dishonou?red|unpaid|nsf|bounced|refer to drawer)\b/i, receipt: "Accounts receivable", payment: "Accounts receivable" },
  { name: "Bank charges", pattern: /\b(fees?|charges?|chgs?|commission|service charge|maintenance|account fee|card fee|bank chg|levy)\b/i, receipt: "Bank charges", payment: "Bank charges" },
  { name: "Tax", pattern: /\b(tax|vat|gst|withholding|wht|hmrc|irs)\b/i, receipt: "Tax", payment: "Tax" },
  { name: "Direct debit", pattern: /\b(dd|ddr|direct debit|standing order|s\/o|so|sepa dd)\b/i, receipt: "Accounts receivable", payment: "Accounts payable", payee: true },
  { name: "Direct credit", pattern: /\b(direct credit|bacs credit|bgc|giro credit|faster payment received|fpi)\b/i, receipt: "Accounts receivable", payment: "Accounts payable", payee: true },
];

export interface AdjLine {
  account: string;
  debit: number;
  credit: number;
}

export interface AdjEntry {
  /** 1, 2, ... */
  n: number;
  kind: "bank only" | "error";
  date?: number;
  narrative: string;
  /** the rule that chose the account, or null for suspense */
  rule: string | null;
  lines: AdjLine[];
  item: RecItem;
}

export interface AdjOptions {
  /** the bank account in the ledger (default "Bank") */
  bankAccount?: string;
  rules?: AdjRule[];
  /** where items no rule recognises go (default "Suspense") */
  suspense?: string;
}

/** The payee in a bank narrative: the keyword, references and numbers taken out. */
export function payeeOf(text: string, pattern: RegExp): string {
  return text
    .replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), " ")
    .replace(/\b[A-Z]*\d[\w/-]*\b/gi, " ")
    .replace(/[^\p{L}\s&'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The rule (and account) for a narrative. */
export function accountFor(text: string, value: number, rules: readonly AdjRule[], suspense: string): { account: string; rule: string | null } {
  for (const r of rules) {
    if (!r.pattern.test(text)) continue;
    let account = value >= 0 ? r.receipt : r.payment;
    if (r.payee) {
      const p = payeeOf(text, r.pattern);
      if (p) account += `: ${p}`;
    }
    return { account, rule: r.name };
  }
  return { account: suspense, rule: null };
}

/**
 * Journal entries that bring the ledger to the adjusted balance: one for
 * each bank-only item (bank against an account chosen by keyword) and, when
 * the errors are the ledger's, one for each difference (the correction
 * amount, bank against the original posting's account where a rule
 * recognises it).
 */
export function proposeAdjustments(st: RecStatement, a: RecRecord[], b: RecRecord[], opts: AdjOptions = {}): AdjEntry[] {
  const bank = opts.bankAccount ?? "Bank";
  const rules = opts.rules ?? DEFAULT_ADJ_RULES;
  const suspense = opts.suspense ?? "Suspense";
  const out: AdjEntry[] = [];
  const pairLines = (value: number, other: string): AdjLine[] => {
    const v = round2(Math.abs(value));
    return value > 0
      ? [
          { account: bank, debit: v, credit: 0 },
          { account: other, debit: 0, credit: v },
        ]
      : [
          { account: other, debit: v, credit: 0 },
          { account: bank, debit: 0, credit: v },
        ];
  };
  const textOf = (r: RecRecord | undefined) => [r?.text, r?.key].filter(Boolean).join(" ");
  for (const l of st.ledgerLines) {
    for (const it of l.items) {
      if (!round2(it.value)) continue;
      if (l.id === "bankReceipts" || l.id === "bankPayments") {
        const rec = b[it.b[0]];
        const t = textOf(rec);
        const { account, rule } = accountFor(t, it.value, rules, suspense);
        const e: AdjEntry = { n: out.length + 1, kind: "bank only", narrative: `${it.value > 0 ? "Receipt" : "Payment"} on the bank statement not in the ledger${t ? `: ${t}` : ""}`, rule, lines: pairLines(it.value, account), item: it };
        if (rec?.date !== undefined) e.date = rec.date;
        out.push(e);
      } else if (l.id === "ledgerErrors") {
        const ra = a[it.a[0]];
        const rb = b[it.b[0]];
        const { account, rule } = accountFor(textOf(ra) || textOf(rb), it.value, rules, "");
        const what = it.duplicate ? "duplicate posting" : it.keying ? KEYING_LABEL[it.keying] : "amount differs";
        const ref = ra?.key ?? rb?.key;
        const e: AdjEntry = {
          n: out.length + 1,
          kind: "error",
          narrative: `Correct ledger${ref ? ` ${ref}` : ""} (${what}): ${it.value > 0 ? "increase" : "decrease"} by ${money(Math.abs(it.value))}`,
          rule,
          lines: pairLines(it.value, account || "Account of the original posting"),
          item: it,
        };
        const d = rb?.date ?? ra?.date;
        if (d !== undefined) e.date = d;
        out.push(e);
      }
    }
  }
  return out;
}
