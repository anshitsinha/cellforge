/**
 * Budget vs actual. Both sides are lines with the same keys (account, cost
 * centre, period...) and an amount; lines with the same keys are added up.
 * Keys match ignoring case and extra spaces. Each key gets the actual, the
 * budget, the variance (actual - budget), the variance as a share of the
 * budget, and whether it is favourable.
 *
 * Favourable depends on the kind of account. With amounts as people write
 * them ("natural": income and costs both positive), more income is good and
 * more cost is bad. With ledger signs ("debit-positive": costs positive,
 * income negative), a lower number is always good.
 */
import { roundDust } from "./periods";

export type AccountKind = "income" | "expense";
export type SignConvention = "natural" | "debit-positive";

export interface BvaLine {
  keys: readonly (string | number | null)[];
  amount: number;
  /** Account type text ("Revenue", "Cost of sales"...) used to tell income from expense. */
  type?: string | null;
}

export interface BvaOptions {
  sign?: SignConvention;
  /** Decide income or expense for a key; the default reads the type text, then the account name (first key). */
  kindOf?: (keys: readonly string[], type: string) => AccountKind | null;
}

export type BvaStatus = "both" | "actual only" | "budget only";

export interface BvaRow {
  /** Keys as first seen (actual side first). */
  keys: string[];
  type: string;
  kind: AccountKind | null;
  actual: number;
  budget: number;
  variance: number;
  /** variance / |budget|; null when the budget is 0. */
  variancePct: number | null;
  /** null when the variance is 0 or the kind isn't known. */
  favourable: boolean | null;
  status: BvaStatus;
}

export interface BvaResult {
  rows: BvaRow[];
  totals: { actual: number; budget: number; variance: number; both: number; actualOnly: number; budgetOnly: number; favourable: number; unfavourable: number };
}

const INCOME = /revenue|income|sales|turnover|fees? earned|interest received|gain|grant/i;
const EXPENSE = /expense|cost|cogs|purchases?|overhead|salar|wage|payroll|rent|depreciation|amorti|loss|fees?|travel|utilit|insurance|marketing|admin|supplies|repairs/i;

/** Income or expense from an account type or name, or null when it doesn't say. */
export function accountKind(text: string): AccountKind | null {
  if (!text.trim()) return null;
  if (/expense|cost|cogs|sales returns|discounts? given/i.test(text)) return "expense";
  if (INCOME.test(text)) return "income";
  if (EXPENSE.test(text)) return "expense";
  return null;
}

const norm = (k: string | number | null) => (k === null ? "" : String(k).trim().replace(/\s+/g, " ").toLowerCase());
const show = (k: string | number | null) => (k === null ? "" : String(k).trim());

/** Compare actual and budget lines key by key. */
export function budgetVsActual(actual: readonly BvaLine[], budget: readonly BvaLine[], opts: BvaOptions = {}): BvaResult {
  const sign = opts.sign ?? "natural";
  const kindOf = opts.kindOf ?? ((keys: readonly string[], type: string) => accountKind(type) ?? accountKind(keys[0] ?? ""));
  const map = new Map<string, { keys: string[]; type: string; actual: number; budget: number; inA: boolean; inB: boolean }>();
  const add = (line: BvaLine, side: "a" | "b") => {
    const id = line.keys.map(norm).join("\u0001");
    let r = map.get(id);
    if (!r) map.set(id, (r = { keys: line.keys.map(show), type: "", actual: 0, budget: 0, inA: false, inB: false }));
    if (!r.type && line.type) r.type = String(line.type).trim();
    const amt = Number.isFinite(line.amount) ? line.amount : 0;
    if (side === "a") {
      r.actual += amt;
      r.inA = true;
    } else {
      r.budget += amt;
      r.inB = true;
    }
  };
  for (const l of actual) add(l, "a");
  for (const l of budget) add(l, "b");
  const totals = { actual: 0, budget: 0, variance: 0, both: 0, actualOnly: 0, budgetOnly: 0, favourable: 0, unfavourable: 0 };
  const rows: BvaRow[] = [];
  for (const r of map.values()) {
    const a = roundDust(r.actual);
    const b = roundDust(r.budget);
    const variance = roundDust(a - b);
    const kind = kindOf(r.keys, r.type);
    let favourable: boolean | null = null;
    if (variance !== 0) {
      if (sign === "debit-positive") favourable = variance < 0;
      else if (kind) favourable = kind === "income" ? variance > 0 : variance < 0;
    }
    const status: BvaStatus = r.inA && r.inB ? "both" : r.inA ? "actual only" : "budget only";
    rows.push({ keys: r.keys, type: r.type, kind, actual: a, budget: b, variance, variancePct: b === 0 ? null : variance / Math.abs(b), favourable, status });
    totals.actual += a;
    totals.budget += b;
    if (status === "both") totals.both++;
    else if (status === "actual only") totals.actualOnly++;
    else totals.budgetOnly++;
    if (favourable === true) totals.favourable++;
    if (favourable === false) totals.unfavourable++;
  }
  totals.actual = roundDust(totals.actual);
  totals.budget = roundDust(totals.budget);
  totals.variance = roundDust(totals.actual - totals.budget);
  return { rows, totals };
}
