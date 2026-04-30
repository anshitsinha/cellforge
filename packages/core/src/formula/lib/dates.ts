/** More date functions: DAYS, DATEDIF, NETWORKDAYS, WORKDAY, YEARFRAC, WEEKNUM, ISOWEEKNUM, DAYS360. */
import { CellError, errors } from "../ast";
import { isError, scalarArg, tidy, toNumber, type Arg, type Scalar } from "../evaluate";
import { dateToSerial, serialToParts } from "../../numfmt";
import { define } from "./define";

function date(a: Arg | undefined): number | CellError {
  if (a === undefined) return errors.value;
  const n = toNumber(scalarArg(a));
  if (isError(n)) return n;
  return n < 0 ? errors.num : Math.floor(n);
}

/** Holiday dates from an optional range or value. */
function holidays(a: Arg | undefined): Set<number> | CellError {
  const out = new Set<number>();
  if (!a) return out;
  const add = (v: Scalar): CellError | null => {
    if (v === null) return null;
    if (isError(v)) return v;
    const n = toNumber(v);
    if (isError(n)) return n;
    out.add(Math.floor(n));
    return null;
  };
  if (a.kind === "value") {
    const e = add(a.value);
    return e ?? out;
  }
  let err: CellError | null = null;
  a.ctx.eachInRange(a.range, (v) => {
    if (!err) err = add(v);
  });
  return err ?? out;
}

const isWeekend = (serial: number) => {
  const wd = serialToParts(serial).wd;
  return wd === 0 || wd === 6;
};

define(
  {
    name: "DAYS",
    category: "Date and time",
    summary: "Days between two dates (end minus start).",
    args: [{ name: "end_date", description: "the later date" }, { name: "start_date", description: "the earlier date" }],
    examples: [['=DAYS("2024-03-31", D1)', 76]],
  },
  (args) => {
    if (args.length !== 2) return errors.value;
    const e = date(args[0]);
    const s = date(args[1]);
    if (isError(e)) return e;
    if (isError(s)) return s;
    return e - s;
  },
);

define(
  {
    name: "DATEDIF",
    category: "Date and time",
    summary: 'Whole years, months or days between two dates: "Y", "M", "D", or "YM" / "MD" / "YD" for what\'s left over.',
    args: [
      { name: "start_date", description: "the earlier date" },
      { name: "end_date", description: "the later date" },
      { name: "unit", description: '"Y", "M", "D", "YM", "MD" or "YD"' },
    ],
    examples: [
      ['=DATEDIF("2020-02-29", "2024-02-28", "Y")', 3],
      ['=DATEDIF(D1, "2024-03-31", "M")', 2],
      ['=DATEDIF(D1, "2024-03-31", "MD")', 16],
    ],
  },
  (args) => {
    if (args.length !== 3) return errors.value;
    const s = date(args[0]);
    const e = date(args[1]);
    if (isError(s)) return s;
    if (isError(e)) return e;
    if (s > e) return errors.num;
    const unit = String(scalarArg(args[2])).toUpperCase();
    const a = serialToParts(s);
    const b = serialToParts(e);
    let months = (b.y - a.y) * 12 + (b.m - a.m);
    if (b.d < a.d) months--;
    switch (unit) {
      case "D":
        return e - s;
      case "M":
        return months;
      case "Y":
        return Math.floor(months / 12);
      case "YM":
        return months % 12;
      case "MD": {
        // days past the last whole month
        const prevMonthDays = new Date(Date.UTC(b.y, b.m - 1, 0)).getUTCDate();
        return b.d >= a.d ? b.d - a.d : prevMonthDays - a.d + b.d;
      }
      case "YD": {
        let y = b.y;
        let start = dateToSerial(y, a.m, a.d);
        if (start > e) start = dateToSerial(--y, a.m, a.d);
        return e - start;
      }
      default:
        return errors.num;
    }
  },
);

define(
  {
    name: "NETWORKDAYS",
    category: "Date and time",
    summary: "Working days (Monday to Friday) between two dates, counting both, minus any holidays.",
    args: [
      { name: "start_date", description: "the first date" },
      { name: "end_date", description: "the last date" },
      { name: "holidays", description: "dates to skip, e.g. a range of bank holidays", optional: true },
    ],
    examples: [['=NETWORKDAYS(D1, "2024-01-31")', 13], ['=NETWORKDAYS(D1, "2024-01-31", "2024-01-16")', 12]],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const s = date(args[0]);
    const e = date(args[1]);
    const h = holidays(args[2]);
    if (isError(s)) return s;
    if (isError(e)) return e;
    if (isError(h)) return h;
    const [lo, hi, sign] = s <= e ? [s, e, 1] : [e, s, -1];
    if (hi - lo > 1_000_000) return errors.num;
    let n = 0;
    for (let d = lo; d <= hi; d++) if (!isWeekend(d) && !h.has(d)) n++;
    return sign * n;
  },
);

define(
  {
    name: "WORKDAY",
    category: "Date and time",
    summary: "The date a number of working days (Monday to Friday) before or after a date, skipping holidays.",
    args: [
      { name: "start_date", description: "the starting date" },
      { name: "days", description: "working days to move; negative goes back" },
      { name: "holidays", description: "dates to skip", optional: true },
    ],
    examples: [["=WORKDAY(D1, 5)", 45313], ["=WORKDAY(D1, -1)", 45303]],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const s = date(args[0]);
    const n = toNumber(scalarArg(args[1]));
    const h = holidays(args[2]);
    if (isError(s)) return s;
    if (isError(n)) return n;
    if (isError(h)) return h;
    let left = Math.trunc(n);
    const step = left < 0 ? -1 : 1;
    let d = s;
    if (Math.abs(left) > 1_000_000) return errors.num;
    while (left !== 0) {
      d += step;
      if (!isWeekend(d) && !h.has(d)) left -= step;
    }
    return d;
  },
);

/** 30/360 day count, US (NASD) unless `european`. */
function days360(s: number, e: number, european: boolean): number {
  const a = serialToParts(s);
  const b = serialToParts(e);
  let d1 = a.d;
  let d2 = b.d;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    const lastFeb = (p: typeof a) => p.m === 2 && p.d === new Date(Date.UTC(p.y, 2, 0)).getUTCDate();
    if (lastFeb(a)) {
      if (lastFeb(b)) d2 = 30;
      d1 = 30;
    }
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
}

define(
  {
    name: "DAYS360",
    category: "Date and time",
    summary: "Days between two dates on a 360-day year (twelve 30-day months), as some accounting systems count.",
    args: [
      { name: "start_date", description: "the earlier date" },
      { name: "end_date", description: "the later date" },
      { name: "european", description: "TRUE for the European method; FALSE or left out for the US method", optional: true },
    ],
    examples: [['=DAYS360("2024-01-30", "2024-02-01")', 1], ['=DAYS360("2024-01-01", "2024-12-31")', 360]],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    const s = date(args[0]);
    const e = date(args[1]);
    if (isError(s)) return s;
    if (isError(e)) return e;
    const eu = args[2] ? scalarArg(args[2]) === true || scalarArg(args[2]) === 1 : false;
    return days360(s, e, eu);
  },
);

define(
  {
    name: "YEARFRAC",
    category: "Date and time",
    summary: "The fraction of a year between two dates, under a day-count basis (for accruals and interest).",
    args: [
      { name: "start_date", description: "the first date" },
      { name: "end_date", description: "the second date" },
      { name: "basis", description: "0 US 30/360 (default), 1 actual/actual, 2 actual/360, 3 actual/365, 4 European 30/360", optional: true },
    ],
    examples: [
      ['=YEARFRAC("2024-01-01", "2024-07-01")', 0.5],
      ['=ROUND(YEARFRAC("2024-01-01", "2024-07-01", 3), 6)', 0.49863],
    ],
  },
  (args) => {
    if (args.length < 2 || args.length > 3) return errors.value;
    let s = date(args[0]);
    let e = date(args[1]);
    if (isError(s)) return s;
    if (isError(e)) return e;
    if (s > e) [s, e] = [e, s];
    const basis = args[2] ? toNumber(scalarArg(args[2])) : 0;
    if (isError(basis)) return basis;
    switch (Math.trunc(basis)) {
      case 0:
        return tidy(days360(s, e, false) / 360);
      case 2:
        return tidy((e - s) / 360);
      case 3:
        return tidy((e - s) / 365);
      case 4:
        return tidy(days360(s, e, true) / 360);
      case 1: {
        const a = serialToParts(s);
        const b = serialToParts(e);
        const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
        if (a.y === b.y) return tidy((e - s) / (leap(a.y) ? 366 : 365));
        // average year length over the years spanned (Excel's actual/actual)
        let days = 0;
        for (let y = a.y; y <= b.y; y++) days += leap(y) ? 366 : 365;
        return tidy((e - s) / (days / (b.y - a.y + 1)));
      }
      default:
        return errors.num;
    }
  },
);

define(
  {
    name: "WEEKNUM",
    category: "Date and time",
    summary: "The week of the year (week 1 contains 1 January). Weeks start on Sunday, or Monday with type 2.",
    args: [{ name: "date", description: "a date" }, { name: "type", description: "1 (default): weeks start Sunday; 2: Monday", optional: true }],
    examples: [["=WEEKNUM(D1)", 3], ['=WEEKNUM("2024-01-07", 2)', 1]],
  },
  (args) => {
    if (args.length < 1 || args.length > 2) return errors.value;
    const d = date(args[0]);
    if (isError(d)) return d;
    const t = args[1] ? toNumber(scalarArg(args[1])) : 1;
    if (isError(t)) return t;
    if (t !== 1 && t !== 2) return errors.num;
    const p = serialToParts(d);
    const jan1 = dateToSerial(p.y, 1, 1);
    const wd1 = serialToParts(jan1).wd; // 0 = Sunday
    const offset = t === 1 ? wd1 : (wd1 + 6) % 7;
    return Math.floor((d - jan1 + offset) / 7) + 1;
  },
);

define(
  {
    name: "ISOWEEKNUM",
    category: "Date and time",
    summary: "The ISO 8601 week number (weeks start Monday; week 1 has the year's first Thursday).",
    args: [{ name: "date", description: "a date" }],
    examples: [["=ISOWEEKNUM(D1)", 3], ['=ISOWEEKNUM("2021-01-03")', 53]],
  },
  (args) => {
    if (args.length !== 1) return errors.value;
    const d = date(args[0]);
    if (isError(d)) return d;
    const p = serialToParts(d);
    const iso = (p.wd + 6) % 7; // Monday = 0
    const thursday = d - iso + 3;
    const ty = serialToParts(thursday).y;
    return Math.floor((thursday - dateToSerial(ty, 1, 1)) / 7) + 1;
  },
);
