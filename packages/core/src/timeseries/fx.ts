/**
 * Currency conversion from a table of rates (date, from, to, rate), where
 * 1 unit of `from` buys `rate` units of `to`.
 *
 * For a date, the rate used is the latest one on or before it (never a
 * later one). A pair is found directly, or inverted (EUR→USD from a USD→EUR
 * row), or through a base currency (GBP→JPY = GBP→USD × USD→JPY).
 */
import { roundDust } from "./periods";

export interface RateRow {
  date: number;
  from: string;
  to: string;
  rate: number;
}

export interface RateHit {
  rate: number;
  /** Date of the (oldest) rate used. */
  date: number;
  /** How it was found. */
  how: "same" | "direct" | "inverse" | "via base";
}

export interface RateTable {
  /** The rate from `from` to `to` on `date`, or null when there's none on or before it. */
  rate(date: number, from: string, to: string): RateHit | null;
  currencies: string[];
  /** Rows left out: no date, a missing currency, or a rate that isn't a positive number. */
  skipped: number;
}

const code = (c: string) => c.trim().toUpperCase();

/** Last index with dates[i] <= d, or -1. */
function lastOnOrBefore(dates: readonly number[], d: number): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * Index the rates. `base` is the currency to triangulate through (default:
 * the one that appears in the most rows). `maxAgeDays` rejects a rate older
 * than that many days before the date asked for.
 */
export function rateTable(rows: readonly RateRow[], opts: { base?: string; maxAgeDays?: number } = {}): RateTable {
  const pairs = new Map<string, { dates: number[]; rates: number[] }>();
  const uses = new Map<string, number>();
  let skipped = 0;
  const sorted = rows
    .filter((r) => {
      const ok = Number.isFinite(r.date) && r.date > 0 && Number.isFinite(r.rate) && r.rate > 0 && !!code(r.from ?? "") && !!code(r.to ?? "") && code(r.from) !== code(r.to);
      if (!ok) skipped++;
      return ok;
    })
    .slice()
    .sort((a, b) => a.date - b.date);
  for (const r of sorted) {
    const key = `${code(r.from)}>${code(r.to)}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { dates: [], rates: [] }));
    const day = Math.floor(r.date);
    // a later row for the same day replaces the earlier one
    if (p.dates.length && p.dates[p.dates.length - 1] === day) p.rates[p.rates.length - 1] = r.rate;
    else {
      p.dates.push(day);
      p.rates.push(r.rate);
    }
    for (const c of [code(r.from), code(r.to)]) uses.set(c, (uses.get(c) ?? 0) + 1);
  }
  const currencies = [...uses.keys()].sort();
  const base = opts.base ? code(opts.base) : [...uses.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";
  const maxAge = opts.maxAgeDays;

  const one = (date: number, from: string, to: string): RateHit | null => {
    const day = Math.floor(date);
    let best: RateHit | null = null;
    const direct = pairs.get(`${from}>${to}`);
    if (direct) {
      const i = lastOnOrBefore(direct.dates, day);
      if (i >= 0) best = { rate: direct.rates[i], date: direct.dates[i], how: "direct" };
    }
    const inverse = pairs.get(`${to}>${from}`);
    if (inverse) {
      const i = lastOnOrBefore(inverse.dates, day);
      if (i >= 0 && (!best || inverse.dates[i] > best.date)) best = { rate: 1 / inverse.rates[i], date: inverse.dates[i], how: "inverse" };
    }
    if (best && maxAge !== undefined && day - best.date > maxAge) return null;
    return best;
  };

  return {
    currencies,
    skipped,
    rate(date, fromRaw, toRaw) {
      const from = code(fromRaw);
      const to = code(toRaw);
      if (!Number.isFinite(date)) return null;
      if (from === to) return { rate: 1, date: Math.floor(date), how: "same" };
      const hit = one(date, from, to);
      if (hit) return hit;
      if (!base || from === base || to === base) return null;
      const a = one(date, from, base);
      const b = one(date, base, to);
      if (!a || !b) return null;
      return { rate: a.rate * b.rate, date: Math.min(a.date, b.date), how: "via base" };
    },
  };
}

/** Round half away from zero to `decimals` places (2.675 → 2.68, as people expect). */
export function roundTo(x: number, decimals = 2): number {
  const f = 10 ** decimals;
  const r = Math.round(Math.abs(roundDust(x * f))) / f;
  return x < 0 ? -r : r;
}

export interface ConvertResult {
  values: (number | null)[];
  rates: (number | null)[];
  rateDates: (number | null)[];
  how: (RateHit["how"] | null)[];
  /** Rows with an amount but no rate. */
  missing: number;
}

/** Convert amounts (each with its own currency and date) into `to`. Blank amounts stay blank. */
export function convertAmounts(table: RateTable, amounts: readonly (number | null)[], currencies: readonly string[], dates: readonly number[], to: string, decimals: number | null = 2): ConvertResult {
  const out: ConvertResult = { values: [], rates: [], rateDates: [], how: [], missing: 0 };
  amounts.forEach((a, i) => {
    const hit = table.rate(dates[i], currencies[i] ?? "", to);
    out.rates.push(hit?.rate ?? null);
    out.rateDates.push(hit?.date ?? null);
    out.how.push(hit?.how ?? null);
    if (a === null || !Number.isFinite(a)) out.values.push(null);
    else if (!hit) {
      out.values.push(null);
      out.missing++;
    } else out.values.push(decimals === null ? roundDust(a * hit.rate) : roundTo(a * hit.rate, decimals));
  });
  return out;
}

export interface FxBalance {
  /** Account or label. */
  label: string;
  currency: string;
  /** Balance in the foreign currency. */
  amount: number;
  /** What it is carried at in the base currency now (historic rates). */
  booked: number;
}

export interface FxRevaluation extends FxBalance {
  closingRate: number | null;
  rateDate: number | null;
  /** amount × closing rate, rounded. */
  revalued: number | null;
  /** revalued - booked: positive is a gain on an asset balance (and a loss on a liability written as negative). */
  gainLoss: number | null;
}

/** Revalue foreign-currency balances at the closing rate on `date` and work out the FX gain or loss. */
export function revalue(table: RateTable, balances: readonly FxBalance[], date: number, base: string, decimals = 2): { rows: FxRevaluation[]; gainLoss: number; missing: number } {
  let total = 0;
  let missing = 0;
  const rows = balances.map((b) => {
    const hit = table.rate(date, b.currency, base);
    if (!hit) {
      missing++;
      return { ...b, closingRate: null, rateDate: null, revalued: null, gainLoss: null };
    }
    const revalued = roundTo(b.amount * hit.rate, decimals);
    const gainLoss = roundTo(revalued - b.booked, decimals);
    total += gainLoss;
    return { ...b, closingRate: hit.rate, rateDate: hit.date, revalued, gainLoss };
  });
  return { rows, gainLoss: roundTo(total, decimals), missing };
}
