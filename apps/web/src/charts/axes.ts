/**
 * Axis maths: round tick steps (1, 2, 5 x 10^n), tick labels in the cells'
 * number format, and calendar ticks (days, months, years) for date axes.
 */
import { dateToSerial, formatValue, isDateFormat, serialToParts } from "@cellforge/core";

export interface Ticks {
  min: number;
  max: number;
  step: number;
  values: number[];
}

/** Heckbert's nice number: 1, 2, 5 or 10 x a power of ten near x. */
export function niceNum(x: number, round: boolean): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = Math.floor(Math.log10(x));
  const f = x / 10 ** e;
  const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * 10 ** e;
}

const clean = (x: number) => (x === 0 ? 0 : +x.toPrecision(12));

/**
 * Round ticks covering lo..hi with at most about `maxTicks` of them. A
 * fixed min or max is kept exactly (ticks then fall on round numbers inside).
 */
export function niceTicks(lo: number, hi: number, maxTicks = 6, fixed: { min?: number | null; max?: number | null } = {}): Ticks {
  if (fixed.min != null) lo = fixed.min;
  if (fixed.max != null) hi = fixed.max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    if (fixed.min == null) lo -= pad;
    if (fixed.max == null || fixed.min != null) hi += pad;
  }
  const n = Math.max(2, maxTicks);
  const step = niceNum(niceNum(hi - lo, false) / (n - 1), true);
  const min = fixed.min != null ? lo : clean(Math.floor(lo / step + 1e-9) * step);
  const max = fixed.max != null ? hi : clean(Math.ceil(hi / step - 1e-9) * step);
  const values: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) values.push(clean(v));
  return { min, max, step, values };
}

/** Bounds of the finite values, or null when there are none. */
export function extent(arrays: ArrayLike<number>[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Label for a tick. With a number format from the cells we use it; with
 * none we pick decimals from the step and shorten millions and billions.
 */
export function tickLabel(v: number, fmt: string, step: number): string {
  if (fmt && fmt.toLowerCase() !== "general") {
    // amounts on an axis read short: 500k, 1.5M, (500k) in a bracket format; no decimals on whole steps
    if (!fmt.includes("%") && !isDateFormat(fmt) && Math.abs(step) >= 1000) return compactNumber(v, fmt);
    if (Number.isInteger(step) && /0\.0+/.test(fmt)) return formatValue(v, fmt.replace(/(0)\.0+/g, "$1")).text;
    return formatValue(v, fmt).text;
  }
  const big = Math.abs(step) >= 1e8 ? [1e9, "B"] : Math.abs(step) >= 1e5 ? [1e6, "M"] : null;
  const [div, suffix] = big ?? [1, ""];
  const s = step / (div as number);
  const dec = Math.max(0, Math.min(10, -Math.floor(Math.log10(s) + 1e-9)));
  const code = "#,##0" + (dec ? "." + "0".repeat(dec) : "");
  return formatValue(v / (div as number), code).text + suffix;
}

// -----------------------------------------------------------------------------
// dates

export interface DateTicks {
  values: number[];
  /** format for the tick labels */
  fmt: string;
}

const HOURS = [1, 2, 3, 6, 12];
const DAYS = [1, 2, 7, 14];
const MONTHS = [1, 2, 3, 6];

/**
 * Calendar ticks between two date serials: hours, days, weeks, months,
 * quarters or years, whichever gives no more than `maxTicks`.
 */
export function dateTicks(lo: number, hi: number, maxTicks = 6): DateTicks {
  if (!(hi > lo)) return { values: [lo], fmt: "d mmm yyyy" };
  const span = hi - lo;
  const fits = (stepDays: number) => span / stepDays <= maxTicks;
  for (const h of HOURS) {
    if (span > 3) break;
    if (fits(h / 24)) {
      const step = h / 24;
      const values: number[] = [];
      for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) values.push(clean(v));
      return { values, fmt: span > 1 ? "d mmm h:mm" : "h:mm" };
    }
  }
  for (const d of DAYS) {
    if (fits(d)) {
      // weeks start on Monday (serial 2 was a Monday)
      const first = d === 7 || d === 14 ? Math.ceil((lo - 2) / 7) * 7 + 2 : Math.ceil(lo / d - 1e-9) * d;
      const values: number[] = [];
      for (let v = first; v <= hi + 1e-9; v += d) values.push(v);
      return { values, fmt: "d mmm" };
    }
  }
  const p = serialToParts(lo);
  for (const m of MONTHS) {
    if (fits(m * 30.44)) {
      const values: number[] = [];
      let y = p.y;
      let mo = Math.ceil((p.m - 1) / m) * m; // zero-based month on a multiple of the step
      if (dateToSerial(y, mo + 1, 1) < lo - 1e-9) mo += m;
      for (;;) {
        while (mo >= 12) {
          mo -= 12;
          y++;
        }
        const v = dateToSerial(y, mo + 1, 1);
        if (v > hi + 1e-9) break;
        values.push(v);
        mo += m;
      }
      return { values, fmt: m >= 12 ? "yyyy" : "mmm yyyy" };
    }
  }
  const years = span / 365.25;
  const ys = niceNum(Math.max(1, years / Math.max(1, maxTicks - 1)), true);
  const step = Math.max(1, Math.round(ys));
  const values: number[] = [];
  for (let y = Math.ceil(p.y / step) * step; ; y += step) {
    const v = dateToSerial(y, 1, 1);
    if (v < lo - 1e-9) continue;
    if (v > hi + 1e-9) break;
    values.push(v);
  }
  return { values, fmt: "yyyy" };
}

/**
 * A short axis figure: 950, 12.5k, 1.5M, 2B; negatives in brackets when the
 * cells' format uses them, and the format's currency sign kept.
 */
export function compactNumber(v: number, fmt = ""): string {
  const a = Math.abs(v);
  const [div, unit] = a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "k"] : [1, ""];
  const n = Math.round((a / div) * 10) / 10;
  const body = `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}`;
  const sign = /[£$€¥]/.exec(fmt.split(";")[0])?.[0] ?? "";
  if (v < 0 && !(n === 0)) return /\(/.test(fmt.split(";")[1] ?? "") ? `(${sign}${body})` : `-${sign}${body}`;
  return `${sign}${body}`;
}
