/**
 * Trial balance compare (this period against the prior one, or two trial
 * balances) and the GL to TB tie-out: does each account's general ledger
 * total agree with its trial balance?
 */
import { keyPart, type KeyNormalise } from "./keys";

/** A trial balance line; core's TbLine fits. */
export interface TbAccount {
  code: string;
  name?: string;
  /** debits positive, credits negative */
  current: number;
  prior?: number | null;
}

export type TbStatus = "both" | "only A" | "only B";

export interface TbCompareLine {
  account: string;
  name: string;
  a: number | null;
  b: number | null;
  /** a − b */
  movement: number;
  /** movement over |b|, null when b is 0 or missing */
  pct: number | null;
  status: TbStatus;
  /** the names differ between A and B */
  renamed: string | null;
}

export interface TbCompareResult {
  lines: TbCompareLine[];
  totalA: number;
  totalB: number;
  /** each TB's lines add up to zero */
  balancesA: boolean;
  balancesB: boolean;
  onlyA: string[];
  onlyB: string[];
  /** accounts on more than one line (their lines are added together) */
  duplicatesA: string[];
  duplicatesB: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const DEFAULT_NORM: KeyNormalise = { trim: true, case: true, numbers: true };

interface Acc {
  account: string;
  name: string;
  total: number;
  lines: number;
}

function group(lines: readonly TbAccount[], value: (l: TbAccount) => number | null, o: KeyNormalise): { map: Map<string, Acc>; dup: string[] } {
  const map = new Map<string, Acc>();
  for (const l of lines) {
    const label = String(l.code || l.name || "").trim();
    const k = keyPart(label, o);
    if (k === null) continue;
    const v = value(l);
    if (v === null) continue;
    const e = map.get(k);
    if (e) {
      e.total += v;
      e.lines++;
    } else map.set(k, { account: label, name: (l.code ? l.name : "")?.trim() ?? "", total: v, lines: 1 });
  }
  return { map, dup: [...map.values()].filter((a) => a.lines > 1).map((a) => a.account) };
}

/**
 * Compare two trial balances by account (A is usually current, B prior).
 * With only `a`, each line's own prior balance is B. Accounts are matched on
 * their code (the name when there's no code), ignoring case and spaces.
 */
export function tbCompare(a: readonly TbAccount[], b?: readonly TbAccount[], opts: { normalise?: KeyNormalise } = {}): TbCompareResult {
  const o = opts.normalise ?? DEFAULT_NORM;
  const ga = group(a, (l) => l.current, o);
  const gb = b ? group(b, (l) => l.current, o) : group(a, (l) => (l.prior === undefined || l.prior === null ? 0 : l.prior), o);
  const lines: TbCompareLine[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const push = (x: Acc | undefined, y: Acc | undefined) => {
    const av = x ? round2(x.total) : null;
    const bv = y ? round2(y.total) : null;
    const movement = round2((av ?? 0) - (bv ?? 0));
    const status: TbStatus = x && y ? "both" : x ? "only A" : "only B";
    const nameA = x?.name ?? "";
    const nameB = y?.name ?? "";
    lines.push({
      account: (x ?? y)!.account,
      name: nameA || nameB,
      a: av,
      b: bv,
      movement,
      pct: bv ? Math.round((movement / Math.abs(bv)) * 10000) / 10000 : null,
      status,
      renamed: nameA && nameB && nameA.toUpperCase() !== nameB.toUpperCase() ? nameB : null,
    });
    if (status === "only A") onlyA.push(x!.account);
    if (status === "only B") onlyB.push(y!.account);
  };
  for (const [k, x] of ga.map) push(x, gb.map.get(k));
  for (const [k, y] of gb.map) if (!ga.map.has(k)) push(undefined, y);
  const totalA = round2([...ga.map.values()].reduce((s, x) => s + x.total, 0));
  const totalB = round2([...gb.map.values()].reduce((s, x) => s + x.total, 0));
  return {
    lines,
    totalA,
    totalB,
    balancesA: Math.abs(totalA) < 0.005,
    balancesB: Math.abs(totalB) < 0.005,
    onlyA,
    onlyB,
    duplicatesA: ga.dup,
    duplicatesB: b ? gb.dup : [],
  };
}

/** A general ledger line: a signed amount, or debit and credit. */
export interface GlLine {
  account: string;
  amount?: number | null;
  debit?: number | null;
  credit?: number | null;
}

export type TieStatus = "agrees" | "differs" | "only in GL" | "only in TB";

export interface TieLine {
  account: string;
  name: string;
  /** GL total for the account, and how many lines made it */
  gl: number | null;
  glLines: number;
  /** the TB figure compared against (balance or movement) */
  tb: number | null;
  /** gl − tb */
  difference: number;
  status: TieStatus;
}

export interface TieResult {
  lines: TieLine[];
  agree: number;
  differ: number;
  onlyGl: number;
  onlyTb: number;
  totalGl: number;
  totalTb: number;
  /** sum of the differences */
  totalDifference: number;
  /** GL lines with no account, left out */
  blankAccounts: number;
}

/** A GL line's signed amount: `amount`, else debit − credit (credit taken as positive). */
export function glAmount(l: GlLine): number {
  if (l.amount !== undefined && l.amount !== null && !Number.isNaN(l.amount)) return l.amount;
  const d = l.debit && !Number.isNaN(l.debit) ? l.debit : 0;
  const c = l.credit && !Number.isNaN(l.credit) ? Math.abs(l.credit) : 0;
  return d - c;
}

/**
 * Tie the GL out to the TB: total the GL by account and compare with each
 * TB account's balance, or with its movement (current − prior) when the
 * GL holds only this period's postings. An account with no GL lines and a
 * zero TB figure agrees.
 */
export function glToTb(gl: readonly GlLine[], tb: readonly TbAccount[], opts: { against?: "balance" | "movement"; tolerance?: number; normalise?: KeyNormalise } = {}): TieResult {
  const o = opts.normalise ?? DEFAULT_NORM;
  const tol = opts.tolerance ?? 0.005;
  const sums = new Map<string, { account: string; total: number; lines: number }>();
  let blankAccounts = 0;
  for (const l of gl) {
    const label = String(l.account ?? "").trim();
    const k = keyPart(label, o);
    if (k === null) {
      blankAccounts++;
      continue;
    }
    const e = sums.get(k);
    const v = glAmount(l);
    if (e) {
      e.total += v;
      e.lines++;
    } else sums.set(k, { account: label, total: v, lines: 1 });
  }
  const value = opts.against === "movement" ? (l: TbAccount) => l.current - (l.prior ?? 0) : (l: TbAccount) => l.current;
  const tbs = group(tb, value, o).map;
  const lines: TieLine[] = [];
  let agree = 0;
  let differ = 0;
  let onlyGl = 0;
  let onlyTb = 0;
  const push = (g: { account: string; total: number; lines: number } | undefined, t: Acc | undefined) => {
    const gv = g ? round2(g.total) : null;
    const tv = t ? round2(t.total) : null;
    const difference = round2((gv ?? 0) - (tv ?? 0));
    let status: TieStatus;
    if (g && t) status = Math.abs(difference) <= tol ? "agrees" : "differs";
    else if (g) status = Math.abs(gv!) <= tol ? "agrees" : "only in GL";
    else status = Math.abs(tv!) <= tol ? "agrees" : "only in TB";
    if (status === "agrees") agree++;
    else if (status === "differs") differ++;
    else if (status === "only in GL") onlyGl++;
    else onlyTb++;
    lines.push({ account: t?.account ?? g!.account, name: t?.name ?? "", gl: gv, glLines: g?.lines ?? 0, tb: tv, difference, status });
  };
  for (const [k, t] of tbs) push(sums.get(k), t);
  for (const [k, g] of sums) if (!tbs.has(k)) push(g, undefined);
  const totalGl = round2([...sums.values()].reduce((s, g) => s + g.total, 0));
  const totalTb = round2([...tbs.values()].reduce((s, t) => s + t.total, 0));
  return { lines, agree, differ, onlyGl, onlyTb, totalGl, totalTb, totalDifference: round2(totalGl - totalTb), blankAccounts };
}
