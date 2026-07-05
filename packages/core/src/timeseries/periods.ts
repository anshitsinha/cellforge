/**
 * Period summaries: totals by day, week, month, quarter, year or fiscal
 * period, then the comparisons analysts build by hand: change on the
 * previous period (MoM, QoQ), on the same period last year (YoY), year- and
 * quarter-to-date, and rolling N-period sums and averages.
 *
 * Periods run without gaps from the first date to the last (an empty month
 * shows as 0 with a count of 0), so "previous period" always means the
 * period just before, not the last one that had data.
 */
import { periodBucket, type FiscalOptions, type PeriodBucket, type PeriodGrain } from "./fiscal";

export interface PeriodSummaryOptions {
  grain: PeriodGrain;
  fiscal?: FiscalOptions;
  /** Periods in the rolling window (default 3; 0 or less = none). */
  rolling?: number;
  /** A group per row (account, entity...): each group gets its own run of periods. */
  groups?: readonly (string | null)[];
}

export interface PeriodRow extends PeriodBucket {
  group: string;
  /** Rows that fell in the period. */
  count: number;
  sum: number;
  /** The previous period's sum (null for the first period of a group). */
  prior: number | null;
  change: number | null;
  /** change / |prior|; null when there's no prior or it is 0. */
  changePct: number | null;
  /** Same period last year (null when it's before the data starts). */
  lastYear: number | null;
  yoyChange: number | null;
  yoyPct: number | null;
  /** Year to date (calendar, ISO or fiscal year, as the grain says). */
  ytd: number;
  /** Quarter to date; null for quarter and year grains. */
  qtd: number | null;
  /** Rolling sum and average of the last N periods, this one included; null until there are N. */
  rollingSum: number | null;
  rollingAvg: number | null;
}

export interface PeriodSummary {
  rows: PeriodRow[];
  /** Rows left out because the date wasn't a date. */
  badDates: number;
  /** Rows left out because the value wasn't a number. */
  badValues: number;
}

/** Most periods one summary will make (per group), so a day grain over centuries can't hang the page. */
export const MAX_PERIODS = 100_000;

const pctOf = (change: number | null, base: number | null) => (change === null || base === null || base === 0 ? null : change / Math.abs(base));

/** Totals and comparisons by period. `dates` are serials (anything else is skipped), `values` numbers. */
export function periodSummary(dates: readonly unknown[], values: readonly unknown[], opts: PeriodSummaryOptions): PeriodSummary {
  const rolling = Math.max(0, Math.trunc(opts.rolling ?? 3));
  const fiscal = opts.fiscal ?? {};
  let badDates = 0;
  let badValues = 0;
  // group -> period start -> [bucket, count, sum]
  const groups = new Map<string, Map<number, { b: PeriodBucket; count: number; sum: number }>>();
  const n = Math.min(dates.length, values.length);
  for (let i = 0; i < n; i++) {
    const d = dates[i];
    const v = values[i];
    if (typeof d !== "number" || !Number.isFinite(d) || d < 1) {
      if (d !== null && d !== undefined && d !== "") badDates++;
      continue;
    }
    if (v !== null && v !== undefined && v !== "" && (typeof v !== "number" || !Number.isFinite(v))) badValues++;
    const amount = typeof v === "number" && Number.isFinite(v) ? v : 0;
    const g = opts.groups ? String(opts.groups[i] ?? "") : "";
    let periods = groups.get(g);
    if (!periods) groups.set(g, (periods = new Map()));
    const b = periodBucket(d, opts.grain, fiscal);
    const cur = periods.get(b.start);
    if (cur) {
      cur.count++;
      cur.sum += amount;
    } else periods.set(b.start, { b, count: 1, sum: amount });
  }

  const rows: PeriodRow[] = [];
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const g of names) {
    const periods = groups.get(g)!;
    const starts = [...periods.keys()].sort((a, b) => a - b);
    const last = starts[starts.length - 1];
    // fill the gaps: walk period by period from the first to the last
    const run: PeriodRow[] = [];
    let b = periods.get(starts[0])!.b;
    for (;;) {
      if (run.length >= MAX_PERIODS) throw new Error(`That makes more than ${MAX_PERIODS.toLocaleString("en-US")} periods. Pick a longer period, such as a month.`);
      const hit = periods.get(b.start);
      run.push({ ...b, group: g, count: hit?.count ?? 0, sum: roundDust(hit?.sum ?? 0), prior: null, change: null, changePct: null, lastYear: null, yoyChange: null, yoyPct: null, ytd: 0, qtd: null, rollingSum: null, rollingAvg: null });
      if (b.start >= last) break;
      b = periodBucket(b.end + 1, opts.grain, fiscal);
    }
    const byYearIndex = new Map(run.map((r) => [`${r.year}|${r.index}`, r]));
    let ytd = 0;
    let qtd = 0;
    let window = 0;
    run.forEach((r, i) => {
      const prev = run[i - 1];
      if (prev) {
        r.prior = prev.sum;
        r.change = roundDust(r.sum - prev.sum);
        r.changePct = pctOf(r.change, r.prior);
      }
      const ly = byYearIndex.get(`${r.year - 1}|${r.index}`);
      if (ly) {
        r.lastYear = ly.sum;
        r.yoyChange = roundDust(r.sum - ly.sum);
        r.yoyPct = pctOf(r.yoyChange, ly.sum);
      }
      if (!prev || prev.year !== r.year) ytd = 0;
      ytd += r.sum;
      r.ytd = roundDust(ytd);
      if (r.quarter) {
        if (!prev || prev.year !== r.year || prev.quarter !== r.quarter) qtd = 0;
        qtd += r.sum;
        r.qtd = roundDust(qtd);
      }
      if (rolling > 0) {
        window += r.sum;
        if (i >= rolling) window -= run[i - rolling].sum;
        if (i >= rolling - 1) {
          r.rollingSum = roundDust(window);
          r.rollingAvg = roundDust(window / rolling);
        }
      }
    });
    rows.push(...run);
  }
  return { rows, badDates, badValues };
}

/** Round off floating-point dust (0.1 + 0.2) without touching real digits. */
export function roundDust(x: number): number {
  return Number.isFinite(x) ? Number(x.toPrecision(15)) : x;
}

/** Short names for the change columns at a grain: "MoM", "QoQ", "YoY". */
export function changeNames(grain: PeriodGrain): { prior: string; change: string } {
  switch (grain) {
    case "day":
      return { prior: "Previous day", change: "DoD" };
    case "week":
      return { prior: "Previous week", change: "WoW" };
    case "month":
      return { prior: "Previous month", change: "MoM" };
    case "fiscal-period":
      return { prior: "Previous period", change: "PoP" };
    case "quarter":
    case "fiscal-quarter":
      return { prior: "Previous quarter", change: "QoQ" };
    case "year":
    case "fiscal-year":
      return { prior: "Previous year", change: "YoY" };
  }
}
