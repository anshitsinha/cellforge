/**
 * Accrual, prepayment and deferred income schedules, and the journal lines
 * that post them month by month.
 *
 * - A prepayment (paid in advance) and deferred income (billed in advance)
 *   start as a balance of the full amount that is released to the P&L each
 *   month until it is nil.
 * - An accrual (cost incurred, not yet invoiced) starts at nil and builds up
 *   by each month's charge.
 *
 * Methods:
 * - "straight-line": the same amount each month, over the number of months
 *   the period spans counted from the start date (1 Jan-31 Dec and
 *   15 Jan-14 Jan are both 12 months; 1 Jan-15 Mar is 3), starting in the
 *   start month (the next one when the start is a month's last day).
 * - "daily": each calendar month gets its share of the days in the period.
 *
 * Every month is rounded to `decimals` places and the last month takes the
 * remainder, so the months add up to the amount exactly.
 */
import { dateToSerial, serialToParts } from "../numfmt";
import { roundDust } from "./periods";
import { roundTo } from "./fx";

export type ScheduleKind = "prepayment" | "deferred-income" | "accrual";
export type ScheduleMethod = "straight-line" | "daily";
/** Post on the last day of the month, the first, or a given day (capped at the month's length). */
export type PostingDay = "month-end" | "month-start" | number;

export interface ScheduleInput {
  kind: ScheduleKind;
  amount: number;
  /** First and last day of the period covered (serials, inclusive). */
  start: number;
  end: number;
  method?: ScheduleMethod;
  posting?: PostingDay;
  /** Account debited and credited by each month's entry. */
  debitAccount: string;
  creditAccount: string;
  description?: string;
  decimals?: number;
}

export interface ScheduleRow {
  /** 1-based month number in the schedule. */
  n: number;
  /** "2025-01" */
  month: string;
  monthStart: number;
  monthEnd: number;
  postingDate: number;
  /** Days of the period in this month. */
  days: number;
  /** Released (or charged) this month. */
  amount: number;
  opening: number;
  closing: number;
  /** Released (or charged) so far. */
  cumulative: number;
}

export interface JournalLine {
  date: number;
  account: string;
  description: string;
  debit: number;
  credit: number;
  /** Entry number: lines of one entry share it. */
  entry: number;
}

export interface Schedule {
  rows: ScheduleRow[];
  journal: JournalLine[];
  totalDays: number;
}

/** Default accounts for each kind: [debit, credit] for the monthly entry. */
export const SCHEDULE_ACCOUNTS: Record<ScheduleKind, [string, string]> = {
  prepayment: ["Expense", "Prepayments"],
  "deferred-income": ["Deferred income", "Revenue"],
  accrual: ["Expense", "Accruals"],
};

export const SCHEDULE_LABELS: Record<ScheduleKind, string> = {
  prepayment: "Prepayment (paid in advance)",
  "deferred-income": "Deferred income (billed in advance)",
  accrual: "Accrual (incurred, not yet invoiced)",
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Where a straight-line schedule starts counting: the start date, or the 1st
 * of the next month when the period starts on a month's last day (31 Jan to
 * 30 Apr is Feb, Mar and Apr).
 */
function anchorOf(start: number, end: number): number {
  return end > start && serialToParts(start + 1).m !== serialToParts(start).m ? start + 1 : start;
}

/** The months the period spans, counted from the start date (rounded up). */
export function monthsSpanned(start: number, end: number): number {
  const s = serialToParts(anchorOf(start, end));
  // whole months from the start to the day after the end, plus one for any part month
  const e = serialToParts(end + 1);
  const k = (e.y - s.y) * 12 + (e.m - s.m) + (e.d > s.d ? 1 : 0);
  if (k > 1200) throw new Error("That period is more than 100 years long.");
  return Math.max(1, k);
}

/** Build the schedule and its journal. */
export function buildSchedule(input: ScheduleInput): Schedule {
  const { amount } = input;
  const decimals = input.decimals ?? 2;
  const method = input.method ?? "straight-line";
  const start = Math.floor(input.start);
  const end = Math.floor(input.end);
  if (!Number.isFinite(amount)) throw new Error("The amount must be a number.");
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < 1) throw new Error("Give a start and an end date.");
  if (end < start) throw new Error("The end date is before the start date.");
  const totalDays = end - start + 1;
  const s = serialToParts(start);

  // month slots: [monthStart, monthEnd, daysInPeriod]
  const slots: [number, number, number][] = [];
  if (method === "daily") {
    let y = s.y;
    let m = s.m;
    for (;;) {
      const ms = dateToSerial(y, m, 1);
      const me = dateToSerial(y, m + 1, 0);
      if (ms > end) break;
      slots.push([ms, me, Math.min(me, end) - Math.max(ms, start) + 1]);
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  } else {
    const n = monthsSpanned(start, end);
    const a = serialToParts(anchorOf(start, end));
    for (let k = 0; k < n; k++) {
      const ms = dateToSerial(a.y, a.m + k, 1);
      const me = dateToSerial(a.y, a.m + k + 1, 0);
      slots.push([ms, me, Math.max(0, Math.min(me, end) - Math.max(ms, start) + 1)]);
    }
  }

  const n = slots.length;
  const shares = slots.map(([, , days]) => (method === "daily" ? (amount * days) / totalDays : amount / n));
  const amounts = shares.map((x) => roundTo(x, decimals));
  const allButLast = amounts.slice(0, -1).reduce((a, b) => a + b, 0);
  amounts[n - 1] = roundTo(amount - allButLast, decimals);

  const builds = input.kind === "accrual";
  const rows: ScheduleRow[] = [];
  const journal: JournalLine[] = [];
  let cumulative = 0;
  slots.forEach(([ms, me, days], i) => {
    const { y, m } = serialToParts(ms);
    const amt = amounts[i];
    const before = cumulative;
    cumulative = roundDust(cumulative + amt);
    const opening = builds ? roundTo(before, decimals) : roundTo(amount - before, decimals);
    const closing = builds ? roundTo(cumulative, decimals) : roundTo(amount - cumulative, decimals);
    const postingDate = postingOn(ms, me, input.posting ?? "month-end");
    rows.push({ n: i + 1, month: `${y}-${pad2(m)}`, monthStart: ms, monthEnd: me, postingDate, days, amount: amt, opening, closing, cumulative: roundTo(cumulative, decimals) });
    if (amt === 0) return;
    const text = `${input.description?.trim() || kindWord(input.kind)} ${y}-${pad2(m)} (${i + 1} of ${n})`;
    // a negative amount (a credit note, say) posts the other way round
    const [dr, cr] = amt > 0 ? [input.debitAccount, input.creditAccount] : [input.creditAccount, input.debitAccount];
    const abs = Math.abs(amt);
    journal.push({ date: postingDate, account: dr, description: text, debit: abs, credit: 0, entry: i + 1 });
    journal.push({ date: postingDate, account: cr, description: text, debit: 0, credit: abs, entry: i + 1 });
  });
  return { rows, journal, totalDays };
}

function kindWord(kind: ScheduleKind): string {
  return kind === "prepayment" ? "Prepayment release" : kind === "deferred-income" ? "Deferred income release" : "Accrual";
}

function postingOn(ms: number, me: number, p: PostingDay): number {
  if (p === "month-end") return me;
  if (p === "month-start") return ms;
  const day = Math.max(1, Math.min(Math.trunc(p), me - ms + 1));
  return ms + day - 1;
}

/** Debits minus credits for each entry (and in all), to show a journal balances. */
export function journalBalance(lines: readonly Pick<JournalLine, "debit" | "credit" | "entry">[]): { debit: number; credit: number; difference: number; unbalanced: number[] } {
  const byEntry = new Map<number, number>();
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    debit += l.debit || 0;
    credit += l.credit || 0;
    byEntry.set(l.entry, (byEntry.get(l.entry) ?? 0) + (l.debit || 0) - (l.credit || 0));
  }
  const unbalanced = [...byEntry.entries()].filter(([, d]) => Math.abs(d) > 0.005).map(([e]) => e);
  return { debit: roundDust(debit), credit: roundDust(credit), difference: roundDust(debit - credit), unbalanced };
}
