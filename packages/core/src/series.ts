import { dateToSerial, serialToParts } from "./numfmt";

/**
 * Fill series, the way Excel's fill handle extends a selection:
 *
 *   1, 2        -> 3, 4, 5            (linear trend; a single number copies)
 *   2024-01-31  -> next days          (dates step by day...)
 *   Jan 31, Feb 29 -> Mar 31          (...or by month / year when that's the pattern)
 *   Mon / March -> Tue / April        (day and month names, any case, short or long)
 *   Item 7      -> Item 8             (text with a number in it)
 *   Q3          -> Q4, Q1             (quarters wrap)
 *   a, b        -> a, b, a            (anything else repeats)
 *
 * A series is a function of position: the source sits at 0..n-1, filling
 * down or right asks for n, n+1..., filling up or left asks for -1, -2...
 */

export type SeriesValue = number | string | null;

const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LISTS = [DAYS_LONG, DAYS_LONG.map((d) => d.slice(0, 3)), MONTHS_LONG, MONTHS_LONG.map((m) => m.slice(0, 3))];

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Round away floating-point noise (0.1 + 0.2 steps) without changing real values. */
const clean = (x: number) => Number(x.toPrecision(15));

function caseLike(sample: string, word: string): string {
  if (sample === sample.toUpperCase() && sample !== sample.toLowerCase()) return word.toUpperCase();
  if (sample === sample.toLowerCase()) return word.toLowerCase();
  return word;
}

function linear(values: number[]): (i: number) => number {
  const n = values.length;
  if (n === 1) return () => values[0];
  // least squares, as Excel's fill trend does (exact for evenly spaced values)
  const mx = (n - 1) / 2;
  const my = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  values.forEach((y, x) => {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  });
  const slope = sxy / sxx;
  return (i) => clean(my + slope * (i - mx));
}

function addMonths(serial: number, months: number): number {
  const p = serialToParts(serial);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = mod(total, 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return dateToSerial(y, m, Math.min(p.d, last)) + (serial - Math.floor(serial));
}

function dateSeries(values: number[]): (i: number) => number {
  if (values.length === 1) return (i) => values[0] + i;
  const parts = values.map(serialToParts);
  const months = parts.map((p) => p.y * 12 + p.m - 1);
  const stepM = months[1] - months[0];
  const sameDay = parts.every((p) => p.d === parts[0].d) || parts.every((p, k) => k === 0 || p.d === new Date(Date.UTC(p.y, p.m, 0)).getUTCDate());
  const evenMonths = months.every((m, k) => k === 0 || m - months[k - 1] === stepM);
  if (stepM !== 0 && sameDay && evenMonths) return (i) => addMonths(values[0], stepM * i);
  return linear(values);
}

/** The series function for one line of source values. */
export function seriesOf(values: readonly SeriesValue[], opts: { dates?: boolean } = {}): (i: number) => SeriesValue {
  const n = values.length;
  const repeat = (i: number) => values[mod(i, n)];
  if (n === 0) return () => null;
  if (values.every((v) => typeof v === "number")) {
    const nums = values as number[];
    if (opts.dates) return dateSeries(nums);
    return n === 1 ? repeat : linear(nums);
  }
  if (!values.every((v) => typeof v === "string")) return repeat;
  const texts = values as string[];

  // day and month names
  for (const list of LISTS) {
    const idx = texts.map((t) => list.findIndex((w) => w.toLowerCase() === t.toLowerCase()));
    if (idx.every((k) => k >= 0)) {
      const step = n === 1 ? 1 : idx[1] - idx[0];
      if (idx.every((k, j) => j === 0 || mod(k - idx[j - 1], list.length) === mod(step, list.length))) {
        return (i) => caseLike(texts[0], list[mod(idx[0] + step * i, list.length)]);
      }
    }
  }

  // text with a number: same text around it, numbers in a steady step
  const parts = texts.map((t) => /^(.*?)(\d+)(\D*)$/.exec(t));
  if (parts.every((m) => m) && parts.every((m) => m![1] === parts[0]![1] && m![3] === parts[0]![3])) {
    const [, prefix, digits, suffix] = parts[0]!;
    const nums = parts.map((m) => Number(m![2]));
    const step = n === 1 ? 1 : nums[1] - nums[0];
    if (nums.every((x, j) => j === 0 || x - nums[j - 1] === step)) {
      const quarter = /^q$/i.test(prefix) && !suffix && nums.every((x) => x >= 1 && x <= 4);
      const width = digits.startsWith("0") ? digits.length : 0;
      return (i) => {
        let x = nums[0] + step * i;
        if (quarter) x = mod(x - 1, 4) + 1;
        if (x < 0) return `${prefix}${Math.abs(x)}${suffix}`; // Excel drops the sign too
        return `${prefix}${String(x).padStart(width, "0")}${suffix}`;
      };
    }
  }
  return repeat;
}

/** `count` values continuing `values` forwards (down/right) or backwards (up/left, nearest first). */
export function extendSeries(values: readonly SeriesValue[], count: number, opts: { dates?: boolean; backwards?: boolean } = {}): SeriesValue[] {
  const f = seriesOf(values, opts);
  const n = values.length;
  return Array.from({ length: count }, (_, k) => f(opts.backwards ? -1 - k : n + k));
}
