/**
 * Fiscal calendars and period buckets. Dates are Excel serial numbers.
 *
 * A fiscal year starts on the first day of `yearStartMonth` (1 = January)
 * and is named by the calendar year it ends in (FY2025 = Jul 2024 to Jun
 * 2025) or the one it starts in. With a week pattern (4-4-5 and so on) the
 * year instead ends on a fixed weekday: the last one in the month before
 * `yearStartMonth`, or the one nearest that month's end. Each quarter is
 * 13 weeks split by the pattern; a 53rd week goes into the last period.
 */
import { dateToSerial, serialToParts } from "../numfmt";

export type WeekPattern = "4-4-5" | "4-5-4" | "5-4-4";

export interface FiscalOptions {
  /** Month the fiscal year starts in, 1-12 (default 1, January). */
  yearStartMonth?: number;
  /** Name the year by the calendar year it ends in (default) or starts in. */
  yearNamedBy?: "start" | "end";
  /** A 52/53-week calendar with this many weeks in each period of a quarter. */
  weeks?: WeekPattern;
  /** Weekday the fiscal year (and each week) ends on, 0 = Sunday ... 6 = Saturday (default 6). */
  weekEndDay?: number;
  /** "last": the last such weekday of the month; "nearest": the one nearest the month's last day (default "last"). */
  yearEnd?: "last" | "nearest";
}

export interface FiscalPeriod {
  fiscalYear: number;
  /** 1-4 */
  quarter: number;
  /** 1-12 */
  period: number;
  /** "FY2025 P03" */
  label: string;
  /** First and last day of the period, as serials. */
  start: number;
  end: number;
  /** First and last day of the fiscal year. */
  yearStart: number;
  yearEnd: number;
  /** Week of the fiscal year, 1-53 (only with a week pattern). */
  week?: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function startMonthOf(opts: FiscalOptions): number {
  const m = Math.trunc(opts.yearStartMonth ?? 1);
  if (!(m >= 1 && m <= 12)) throw new Error("The fiscal year must start in a month from 1 to 12.");
  return m;
}

/** Fiscal year name for a year whose start month falls in calendar year `startYear`. */
function nameYear(startYear: number, startMonth: number, opts: FiscalOptions): number {
  if (startMonth === 1) return startYear;
  return (opts.yearNamedBy ?? "end") === "end" ? startYear + 1 : startYear;
}

const weekday = (serial: number) => serialToParts(serial).wd;

/** Last day of the week-based fiscal year whose end month is `endMonth` of calendar year `y`. */
export function weekYearEnd(y: number, endMonth: number, opts: FiscalOptions = {}): number {
  const wd = Math.trunc(opts.weekEndDay ?? 6);
  if (!(wd >= 0 && wd <= 6)) throw new Error("The week must end on a weekday from 0 (Sunday) to 6 (Saturday).");
  const lastDay = dateToSerial(y, endMonth + 1, 0);
  const back = (weekday(lastDay) - wd + 7) % 7;
  const last = lastDay - back;
  return opts.yearEnd === "nearest" && back > 3 ? last + 7 : last;
}

function patternOf(p: WeekPattern): number[] {
  const q = p.split("-").map(Number);
  return [...q, ...q, ...q, ...q];
}

/** The fiscal year, quarter and period a date falls in. */
export function fiscalPeriod(serial: number, opts: FiscalOptions = {}): FiscalPeriod {
  if (!Number.isFinite(serial)) throw new Error("Not a date.");
  const day = Math.floor(serial);
  const sm = startMonthOf(opts);
  if (opts.weeks) return weekPeriod(day, sm, opts);
  const { y, m } = serialToParts(day);
  const offset = (m - sm + 12) % 12;
  const startYear = m >= sm ? y : y - 1;
  const fy = nameYear(startYear, sm, opts);
  const period = offset + 1;
  const quarter = Math.floor(offset / 3) + 1;
  return {
    fiscalYear: fy,
    quarter,
    period,
    label: `FY${fy} P${pad2(period)}`,
    start: dateToSerial(y, m, 1),
    end: dateToSerial(y, m + 1, 0),
    yearStart: dateToSerial(startYear, sm, 1),
    yearEnd: dateToSerial(startYear, sm + 12, 0),
  };
}

function weekPeriod(day: number, sm: number, opts: FiscalOptions): FiscalPeriod {
  const em = sm === 1 ? 12 : sm - 1;
  // the year whose end month is in calendar year y ends on weekYearEnd(y)
  let y = serialToParts(day).y - 1;
  while (weekYearEnd(y, em, opts) < day) y++;
  const end = weekYearEnd(y, em, opts);
  const start = weekYearEnd(y - 1, em, opts) + 1;
  // the start month is in calendar year y (January start) or y - 1
  const startYear = sm === 1 ? y : y - 1;
  const fy = nameYear(startYear, sm, opts);
  const weeks = patternOf(opts.weeks!);
  const totalWeeks = Math.round((end - start + 1) / 7);
  const w = Math.floor((day - start) / 7); // 0-based
  let cum = 0;
  let p = 0;
  while (p < 11 && w >= cum + weeks[p]) cum += weeks[p++];
  const pStart = start + cum * 7;
  const pWeeks = p === 11 ? totalWeeks - cum : weeks[p];
  return {
    fiscalYear: fy,
    quarter: Math.floor(p / 3) + 1,
    period: p + 1,
    label: `FY${fy} P${pad2(p + 1)}`,
    start: pStart,
    end: pStart + pWeeks * 7 - 1,
    yearStart: start,
    yearEnd: end,
    week: w + 1,
  };
}

// ------------------------------------------------------------- buckets --

export type PeriodGrain = "day" | "week" | "month" | "quarter" | "year" | "fiscal-period" | "fiscal-quarter" | "fiscal-year";

export const GRAIN_LABELS: Record<PeriodGrain, string> = {
  day: "Day",
  week: "Week (Monday to Sunday)",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  "fiscal-period": "Fiscal period",
  "fiscal-quarter": "Fiscal quarter",
  "fiscal-year": "Fiscal year",
};

/** A period of a given grain: the year it belongs to and its place in that year. */
export interface PeriodBucket {
  /** First and last day, as serials. */
  start: number;
  end: number;
  /** Calendar, ISO-week or fiscal year. */
  year: number;
  /** Place within the year: day of year as month*100+day, week, month, quarter or period number; 1 for a year. */
  index: number;
  /** Quarter within the year (0 when the grain is a quarter or a year). */
  quarter: number;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The period of `grain` that a date falls in. */
export function periodBucket(serial: number, grain: PeriodGrain, fiscal: FiscalOptions = {}): PeriodBucket {
  const day = Math.floor(serial);
  const { y, m, d, wd } = serialToParts(day);
  switch (grain) {
    case "day":
      return { start: day, end: day, year: y, index: m * 100 + d, quarter: Math.floor((m - 1) / 3) + 1, label: `${y}-${pad2(m)}-${pad2(d)}` };
    case "week": {
      const start = day - ((wd + 6) % 7); // Monday
      const thursday = start + 3;
      const ty = serialToParts(thursday).y;
      const week = Math.floor((thursday - dateToSerial(ty, 1, 1)) / 7) + 1;
      const tm = serialToParts(thursday).m;
      return { start, end: start + 6, year: ty, index: week, quarter: Math.floor((tm - 1) / 3) + 1, label: `${ty}-W${pad2(week)}` };
    }
    case "month":
      return { start: dateToSerial(y, m, 1), end: dateToSerial(y, m + 1, 0), year: y, index: m, quarter: Math.floor((m - 1) / 3) + 1, label: `${MONTHS[m - 1]} ${y}` };
    case "quarter": {
      const q = Math.floor((m - 1) / 3) + 1;
      return { start: dateToSerial(y, q * 3 - 2, 1), end: dateToSerial(y, q * 3 + 1, 0), year: y, index: q, quarter: 0, label: `Q${q} ${y}` };
    }
    case "year":
      return { start: dateToSerial(y, 1, 1), end: dateToSerial(y, 12, 31), year: y, index: 1, quarter: 0, label: String(y) };
    case "fiscal-period": {
      const f = fiscalPeriod(day, fiscal);
      return { start: f.start, end: f.end, year: f.fiscalYear, index: f.period, quarter: f.quarter, label: f.label };
    }
    case "fiscal-quarter": {
      const f = fiscalPeriod(day, fiscal);
      const first = fiscalPeriodStart(f, (f.quarter - 1) * 3 + 1, fiscal);
      const last = fiscalPeriodStart(f, f.quarter * 3 + 1, fiscal) - 1;
      return { start: first, end: last, year: f.fiscalYear, index: f.quarter, quarter: 0, label: `FY${f.fiscalYear} Q${f.quarter}` };
    }
    case "fiscal-year": {
      const f = fiscalPeriod(day, fiscal);
      return { start: f.yearStart, end: f.yearEnd, year: f.fiscalYear, index: 1, quarter: 0, label: `FY${f.fiscalYear}` };
    }
  }
}

/** First day of period `p` (1-13; 13 = the day after the year) of the fiscal year `f` is in. */
function fiscalPeriodStart(f: FiscalPeriod, p: number, fiscal: FiscalOptions): number {
  if (p > 12) return f.yearEnd + 1;
  if (fiscal.weeks) {
    const weeks = patternOf(fiscal.weeks);
    let cum = 0;
    for (let i = 0; i < p - 1; i++) cum += weeks[i];
    return f.yearStart + cum * 7;
  }
  const { y, m } = serialToParts(f.yearStart);
  return dateToSerial(y, m + p - 1, 1);
}
