/**
 * Shared bits for the audit tests: reading plain cell values as numbers or
 * dates, and a small seeded random number generator so samples reproduce.
 */
import { parseDateLoose, parseNumberLoose, type DateOrder } from "../clean/values";

/** A value as it comes out of a sheet. */
export type Cell = number | string | null;

/** A cell as a number: numbers as they are, text read the loose way (1,234.50, (12), 5 CR), or null. */
export function cellNumber(v: Cell | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return parseNumberLoose(v);
}

/** A cell as a date serial: numbers are taken as serials already, text is read as a date, or null. */
export function cellDate(v: Cell | undefined, order: DateOrder = "dmy"): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return parseDateLoose(v, order);
}

/** mulberry32: a tiny, fast, seeded generator of numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh seed (a positive whole number below 2^31, easy to write down). */
export function newSeed(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c?.getRandomValues) return (c.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff) || 1;
  return Math.floor(Math.random() * 0x7fffffff) || 1;
}

/** A plain number with thousands separators and at most `dp` decimals (for labels). */
export function plain(n: number, dp = 2): string {
  const r = Math.round(n * 10 ** dp) / 10 ** dp;
  let s = Math.abs(r).toFixed(dp);
  if (s.includes(".")) s = s.replace(/\.?0+$/, "");
  const [i, f] = s.split(".");
  return (r < 0 ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}
