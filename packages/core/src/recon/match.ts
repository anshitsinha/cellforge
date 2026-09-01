/**
 * Reconciliation: match two lists of records (a ledger and a bank
 * statement, two sub-ledgers, ...) in passes, strictest first. Each pass
 * only sees what the earlier ones left. Then the leftovers are sorted into
 * mismatched (same reference, different amount) and unmatched, with
 * possible keying errors flagged and duplicates within each side listed.
 *
 * Everything is indexed (by key, by amount, by date), so 100k x 100k runs
 * in seconds; nothing compares every record with every other one.
 */
import {
  amountKeyingError,
  cents,
  DEFAULT_PREFIXES,
  isOneSlip,
  isTransposition,
  keyingVariants,
  kindOf,
  kindsDiffer,
  NAME_CLASSES,
  NAME_NO_TEXT,
  nameAgreement,
  nameWords,
  normRef,
  normText,
  partyWords,
  sharesName,
  textSimilarity,
  type KeyingError,
} from "./text";

export interface RecRecord {
  /** where the record came from (the sheet row), carried through to the results */
  row: number;
  key?: string;
  amount?: number;
  /** a date serial (days) */
  date?: number;
  text?: string;
}

export type RecRule = "exact" | "tolerance" | "reference" | "fuzzy" | "amount+date" | "one-to-many" | "many-to-one";
export const REC_RULES: readonly RecRule[] = ["exact", "tolerance", "reference", "fuzzy", "amount+date", "one-to-many", "many-to-one"];

export interface RecPasses {
  /** same key, same amount */
  exact: boolean;
  /** same key, amount within tolerance, date within the window */
  tolerance: boolean;
  /**
   * same reference once normalised (case, spaces, punctuation, leading zeros,
   * prefixes), amount within tolerance, date within the window; with the very
   * same amount, any date (as exact)
   */
  reference: boolean;
  /** descriptions alike, amount within tolerance, date within the window (references, if both have one, the same) */
  fuzzy: boolean;
  /**
   * amount within tolerance and date within the window, whatever the key
   * (unless both have one and they differ): pairs whose descriptions name the
   * same party first, best first; then the rest, nearest date first. When
   * the key passes matched enough pairs with descriptions to learn from, a
   * pair needs its names and kinds to agree more than chance would explain
   * among the items of that amount in the window (and, without
   * descriptions, the two sides to hold about as many of them); the fuzzy
   * pass and the keying flags are weighed the same way
   */
  amountDate: boolean;
  /**
   * one item equals the sum of 2..k on the other side (1:N and N:1): among
   * items with the same reference first; then, for items whose reference the
   * other side lacks, among everything of the same sign in the date window,
   * if exactly one combination adds up and that is unlikely by chance
   */
  sum: boolean;
}

export interface RecSettings {
  /** absolute amount tolerance */
  amountTolerance: number;
  /** amount tolerance as a percentage of the amount; the larger of the two applies */
  amountTolerancePct: number;
  /** ± days; null ignores dates */
  dateWindow: number | null;
  /** B amounts have the opposite sign (bank vs ledger) */
  flipB: boolean;
  passes: RecPasses;
  /** 0..1, how alike descriptions must be for the fuzzy pass */
  fuzzyThreshold: number;
  /** the most items one sum may add up (2..8); items sharing a reference that add up as a whole match whatever their number */
  sumMaxItems: number;
  /** candidates looked at for each sum by reference; the date search gives up when the window holds more than 4x this */
  sumCandidates: number;
  /** combinations tried per item before giving up on it */
  sumStepCap: number;
  /** combinations tried in the whole run before the sum pass stops */
  sumTotalCap: number;
  /** reference prefixes dropped when normalising */
  prefixes: string[];
}

export const DEFAULT_REC_SETTINGS: RecSettings = {
  amountTolerance: 0,
  amountTolerancePct: 0,
  dateWindow: 3,
  flipB: false,
  passes: { exact: true, tolerance: true, reference: true, fuzzy: true, amountDate: true, sum: true },
  fuzzyThreshold: 0.85,
  sumMaxItems: 4,
  sumCandidates: 24,
  sumStepCap: 4000,
  sumTotalCap: 20_000_000,
  prefixes: DEFAULT_PREFIXES,
};

export interface RecMatch {
  rule: RecRule;
  /** indexes into the A list */
  a: number[];
  /** indexes into the B list */
  b: number[];
  /** sum of A amounts minus sum of B amounts (B sign-flipped if asked) */
  amountDiff: number;
  /** largest date gap in the group, in days; null without dates */
  days: number | null;
  /** text similarity for the fuzzy pass */
  score?: number;
}

export interface RecPair {
  a: number;
  b: number;
  amountDiff: number;
  days: number | null;
}

export interface RecFlag {
  a: number;
  b: number;
  field: "amount" | "key";
  kind: KeyingError;
  /** the pair is a mismatched pair (same key); otherwise both are unmatched */
  mismatched: boolean;
}

export interface RecDuplicate {
  side: "A" | "B";
  items: number[];
}

export interface RecResult {
  matches: RecMatch[];
  mismatched: RecPair[];
  unmatchedA: number[];
  unmatchedB: number[];
  duplicates: RecDuplicate[];
  flags: RecFlag[];
  /** items whose sum search hit the step cap (a match may exist but wasn't searched for exhaustively) */
  sumCapped: { side: "A" | "B"; item: number }[];
  /** the whole-run sum budget ran out, so some items weren't tried at all */
  sumBudgetExhausted: boolean;
  summary: RecSummary;
}

export interface RecSummary {
  countA: number;
  countB: number;
  matchedA: number;
  matchedB: number;
  /** matched share of all records, both sides together, 0..1 */
  matchRate: number;
  byRule: Record<RecRule, number>;
  mismatched: number;
  unmatchedA: number;
  unmatchedB: number;
  unmatchedTotalA: number;
  unmatchedTotalB: number;
  mismatchedTotalA: number;
  mismatchedTotalB: number;
  duplicatesA: number;
  duplicatesB: number;
  flags: number;
}

const EPS = 1e-7;
const HALF_CENT = 0.004;

/** The amount tolerance for an amount. */
export function toleranceFor(amount: number, s: Pick<RecSettings, "amountTolerance" | "amountTolerancePct">): number {
  return Math.max(s.amountTolerance, (Math.abs(amount) * s.amountTolerancePct) / 100) + EPS;
}

/**
 * Items sorted by (value, date), with "next free position" pointers so
 * used items are skipped in amortised constant time.
 */
class Pool {
  readonly ids: Int32Array;
  readonly vals: Float64Array;
  readonly dates: Float64Array;
  private readonly nextFree: Int32Array;
  readonly pos = new Map<number, number>();

  constructor(ids: number[], val: (i: number) => number, date: (i: number) => number) {
    const sorted = ids.slice().sort((x, y) => val(x) - val(y) || dateKey(date(x)) - dateKey(date(y)) || x - y);
    this.ids = Int32Array.from(sorted);
    this.vals = Float64Array.from(sorted, val);
    this.dates = Float64Array.from(sorted, date);
    this.nextFree = Int32Array.from({ length: sorted.length + 1 }, (_, i) => i);
    sorted.forEach((id, p) => this.pos.set(id, p));
  }

  get size(): number {
    return this.ids.length;
  }

  /** first free position at or after p (size if none) */
  free(p: number): number {
    let r = p;
    while (this.nextFree[r] !== r) r = this.nextFree[r];
    while (this.nextFree[p] !== r) {
      const n = this.nextFree[p];
      this.nextFree[p] = r;
      p = n;
    }
    return r;
  }

  take(p: number): void {
    this.nextFree[p] = p + 1;
  }

  takeId(id: number): void {
    const p = this.pos.get(id);
    if (p !== undefined) this.take(p);
  }

  /** first position with (val, date) >= (v, d) */
  lowerBound(v: number, d = -Infinity): number {
    let lo = 0;
    let hi = this.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const mv = this.vals[mid];
      if (mv < v || (mv === v && dateKey(this.dates[mid]) < d)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

const dateKey = (d: number) => (Number.isNaN(d) ? -Infinity : d);

interface Side {
  n: number;
  amount: Float64Array;
  date: Float64Array;
  key: string[];
  ref: string[];
  text: string[];
}

function side(records: RecRecord[], flip: boolean, prefixes: readonly string[]): Side {
  const n = records.length;
  const amount = new Float64Array(n);
  const date = new Float64Array(n);
  const key: string[] = new Array(n);
  const ref: string[] = new Array(n);
  const text: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = records[i];
    amount[i] = r.amount === undefined || !Number.isFinite(r.amount) ? NaN : flip ? -r.amount : r.amount;
    date[i] = r.date === undefined || !Number.isFinite(r.date) ? NaN : r.date;
    key[i] = (r.key ?? "").trim();
    ref[i] = key[i] ? normRef(key[i], prefixes) : "";
    text[i] = r.text ? normText(r.text) : "";
  }
  return { n, amount, date, key, ref, text };
}

/** Run a reconciliation. */
export function reconcile(aRecords: RecRecord[], bRecords: RecRecord[], settings: Partial<RecSettings> = {}): RecResult {
  const s: RecSettings = { ...DEFAULT_REC_SETTINGS, ...settings, passes: { ...DEFAULT_REC_SETTINGS.passes, ...settings.passes } };
  const A = side(aRecords, false, s.prefixes);
  const B = side(bRecords, s.flipB, s.prefixes);
  const usedA = new Uint8Array(A.n);
  const usedB = new Uint8Array(B.n);
  const matches: RecMatch[] = [];
  const win = s.dateWindow;

  const days = (i: number, j: number): number | null => {
    const da = A.date[i];
    const db = B.date[j];
    return Number.isNaN(da) || Number.isNaN(db) ? null : Math.round(Math.abs(da - db));
  };
  const inWindow = (i: number, j: number): boolean => {
    if (win === null) return true;
    const d = days(i, j);
    return d === null || d <= win;
  };
  const amountDiff = (i: number, j: number): number => {
    const x = A.amount[i];
    const y = B.amount[j];
    if (Number.isNaN(x) && Number.isNaN(y)) return 0;
    return round2(x - y);
  };
  const pair = (rule: RecRule, i: number, j: number, score?: number) => {
    usedA[i] = 1;
    usedB[j] = 1;
    const m: RecMatch = { rule, a: [i], b: [j], amountDiff: amountDiff(i, j), days: days(i, j) };
    if (score !== undefined) m.score = score;
    matches.push(m);
  };
  const freeA = () => {
    const out: number[] = [];
    for (let i = 0; i < A.n; i++) if (!usedA[i]) out.push(i);
    return out;
  };
  const freeB = () => {
    const out: number[] = [];
    for (let j = 0; j < B.n; j++) if (!usedB[j]) out.push(j);
    return out;
  };
  /** nearest by date within the window among a list of candidates (or the first, without dates) */
  const nearest = (i: number, cands: number[], limit = 64): number => {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < cands.length && k < limit; k++) {
      const j = cands[k];
      if (!inWindow(i, j)) continue;
      const d = days(i, j) ?? 0;
      if (d < bestD) {
        best = k;
        bestD = d;
        if (!d) break;
      }
    }
    return best;
  };

  // 1. exact: same key, same amount (in cents)
  if (s.passes.exact) {
    const buckets = new Map<string, number[]>();
    for (let j = 0; j < B.n; j++) {
      if (!B.key[j]) continue;
      const k = B.key[j] + "\u0000" + amtKey(B.amount[j]);
      const list = buckets.get(k);
      if (list) list.push(j);
      else buckets.set(k, [j]);
    }
    for (let i = 0; i < A.n; i++) {
      if (!A.key[i]) continue;
      const list = buckets.get(A.key[i] + "\u0000" + amtKey(A.amount[i]));
      if (!list?.length) continue;
      // exact ignores the window, but prefers the nearest date
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < list.length && k < 64; k++) {
        const d = days(i, list[k]) ?? 0;
        if (d < bestD) {
          best = k;
          bestD = d;
          if (!d) break;
        }
      }
      const j = list[best];
      list[best] = list[list.length - 1];
      list.pop();
      pair("exact", i, j);
    }
  }

  // 2. and 3. same key (raw, then normalised) within tolerance and window
  let lastScore = 0;
  const keyed = (rule: RecRule, keyOf: (sd: Side, i: number) => string) => {
    const groups = new Map<string, number[]>();
    for (const j of freeB()) {
      const k = keyOf(B, j);
      if (!k) continue;
      const g = groups.get(k);
      if (g) g.push(j);
      else groups.set(k, [j]);
    }
    const pools = new Map<string, { pool: Pool; blank: number[] }>();
    for (const [k, ids] of groups) {
      const withAmt = ids.filter((j) => !Number.isNaN(B.amount[j]));
      const blank = ids.filter((j) => Number.isNaN(B.amount[j]));
      pools.set(k, { pool: new Pool(withAmt, (j) => B.amount[j], (j) => B.date[j]), blank });
    }
    for (const i of freeA()) {
      const k = keyOf(A, i);
      if (!k) continue;
      const g = pools.get(k);
      if (!g) continue;
      const x = A.amount[i];
      if (Number.isNaN(x)) {
        const b = nearest(i, g.blank);
        if (b >= 0) {
          const j = g.blank[b];
          g.blank.splice(b, 1);
          pair(rule, i, j);
        }
        continue;
      }
      let j = bestInRange(g.pool, i, x, toleranceFor(x, s), 256);
      // the same reference and the very same amount is as good as exact, which ignores the window
      // (a cheque presented a week after it was written): nearest date first
      if (j < 0 && rule === "reference" && win !== null) j = bestInRange(g.pool, i, x, HALF_CENT, 256, undefined, true);
      if (j >= 0) pair(rule, i, j);
    }
  };
  /**
   * The free pool item with an amount within tol of x and a date in the
   * window (any date with anyDate): with a scorer, the best score first; then
   * the smallest difference; then the best tie-breaker (worked out only when
   * two candidates are equally close); then the nearest date.
   */
  const bestInRange = (pool: Pool, i: number, x: number, tol: number, cap: number, accept?: (j: number) => number | null, anyDate = false, tie?: (j: number) => number): number => {
    let bestPos = -1;
    let bestDiff = Infinity;
    let bestDays = Infinity;
    let bestScore = -Infinity;
    let bestTie = NaN;
    let scanned = 0;
    const dated = !anyDate && !Number.isNaN(A.date[i]) && win !== null;
    let p = pool.free(pool.lowerBound(x - tol));
    while (p < pool.size && pool.vals[p] <= x + tol && scanned < cap) {
      scanned++;
      const j = pool.ids[p];
      if (anyDate || inWindow(i, j)) {
        const score = accept ? accept(j) : 0;
        if (score !== null) {
          const diff = Math.abs(pool.vals[p] - x);
          const d = days(i, j) ?? 0;
          let better: boolean;
          let t = NaN;
          if (bestPos < 0) better = true;
          else if (Math.abs(score - bestScore) > 1e-12) better = score > bestScore;
          else if (Math.abs(diff - bestDiff) > EPS) better = diff < bestDiff;
          else if (tie) {
            if (Number.isNaN(bestTie)) bestTie = tie(pool.ids[bestPos]);
            t = tie(j);
            better = Math.abs(t - bestTie) > 1e-12 ? t > bestTie : d < bestDays;
          } else better = d < bestDays;
          if (better) {
            bestPos = p;
            bestDiff = diff;
            bestDays = d;
            bestScore = score;
            bestTie = t;
          }
        }
      } else if (dated && !Number.isNaN(pool.dates[p])) {
        // within one amount the pool is sorted by date: jump to the window, or past this amount
        p = pool.free(Math.max(p + 1, pool.dates[p] < A.date[i] ? pool.lowerBound(pool.vals[p], A.date[i] - win! - 0.5) : pool.lowerBound(nextUp(pool.vals[p]))));
        continue;
      }
      p = pool.free(p + 1);
    }
    if (bestPos < 0) return -1;
    pool.take(bestPos);
    lastScore = bestScore;
    return pool.ids[bestPos];
  };

  if (s.passes.tolerance) keyed("tolerance", (sd, i) => sd.key[i]);
  if (s.passes.reference) keyed("reference", (sd, i) => sd.ref[i]);

  // From here on, references only rule things out: keys that are both
  // present and different can't pair, and an item whose reference the other
  // side has (unmatched) is spoken for: it's left for that item (a sum by
  // reference, or a mismatched pair with a keying error to flag).
  const refsOf = (sd: Side, free: number[]) => {
    const out = new Set<string>();
    for (const i of free) if (sd.ref[i]) out.add(sd.ref[i]);
    return out;
  };
  const conflict = (i: number, j: number, refsA: Set<string>, refsB: Set<string>) =>
    A.ref[i] ? (B.ref[j] ? A.ref[i] !== B.ref[j] : false) || refsB.has(A.ref[i]) : !!B.ref[j] && refsA.has(B.ref[j]);

  // What agreeing descriptions look like, learnt from this run: the pairs
  // the reference passes matched (true pairs) against random leftovers
  // (strangers). Null when there are too few of either; the passes below
  // then work as they always have.
  const model = s.passes.fuzzy || s.passes.amountDate ? textModel(A, B, matches, usedA, usedB) : null;
  /** free items with an amount, sorted by (amount, date), for counting candidates */
  const counters = model ? { a: new Pool(freeA().filter((i) => !Number.isNaN(A.amount[i])), (i) => A.amount[i], (i) => A.date[i]), b: new Pool(freeB().filter((j) => !Number.isNaN(B.amount[j])), (j) => B.amount[j], (j) => B.date[j]) } : null;
  /** free items in a pool within tol of x and in the window of date d (the other side's free items that could pair with an item) */
  const countNear = (pool: Pool, x: number, tol: number, d: number): number => {
    let n = 0;
    let p = pool.lowerBound(x - tol);
    for (let values = 0; p < pool.size && pool.vals[p] <= x + tol && values < 1000; values++) {
      const v = pool.vals[p];
      const end = pool.lowerBound(nextUp(v));
      if (win === null || Number.isNaN(d)) n += end - p;
      else {
        // undated items sort first and are always in the window
        const dated = pool.lowerBound(v, -Number.MAX_VALUE);
        const lo = Math.max(dated, pool.lowerBound(v, d - win - 0.5));
        n += dated - p + Math.max(0, pool.lowerBound(v, d + win + 0.5) - lo);
      }
      p = end;
    }
    return Math.max(1, n);
  };
  const countM = new Int32Array(model ? B.n : 0);
  /** with the model: how many free A items could pair with B item j (at least 1) */
  const crowdA = (j: number): number => {
    if (!countM[j]) countM[j] = countNear(counters!.a, B.amount[j], toleranceFor(B.amount[j], s), B.date[j]);
    return countM[j];
  };
  /** first position in a list of B items sorted by date (undated first) that can be in the window of date d */
  const windowStart = (list: number[], d: number): number => {
    if (win === null || Number.isNaN(d) || !list.length || Number.isNaN(B.date[list[0]])) return 0;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (B.date[list[mid]] < d - win - 0.5) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** visit up to cap items of a date-sorted list of B items that are in the window of A item i */
  const eachInWindow = (list: number[] | undefined, i: number, cap: number, visit: (j: number) => void) => {
    if (!list) return;
    const d = A.date[i];
    for (let k = windowStart(list, d), n = 0; k < list.length && n < cap; k++) {
      const j = list[k];
      if (!inWindow(i, j)) {
        if (!Number.isNaN(B.date[j]) && !Number.isNaN(d) && B.date[j] > d) break;
        continue;
      }
      n++;
      visit(j);
    }
  };
  /** B items by (amount in cents, party word), each list sorted by date */
  const wordIndex = (ids: ArrayLike<number>): Map<string, number[]> => {
    const index = new Map<string, number[]>();
    for (let k = 0; k < ids.length; k++) {
      const j = ids[k];
      const ws = model!.wordsB(j);
      if (!ws?.length || Number.isNaN(B.amount[j])) continue;
      const c = cents(B.amount[j]);
      for (const w of new Set(ws)) {
        const k = c + " " + w;
        const list = index.get(k);
        if (list) list.push(j);
        else index.set(k, [j]);
      }
    }
    const byDate = (x: number, y: number) => dateKey(B.date[x]) - dateKey(B.date[y]) || x - y;
    for (const list of index.values()) if (list.length > 1) list.sort(byDate);
    return index;
  };
  /**
   * The B items of a pool that could pair with A item i, each once: those of
   * the same amount that share a party word with it, anywhere in the window
   * (however many items of that amount the window holds), and the nearest by
   * date of each amount within tol.
   */
  const eachCandidate = (pool: Pool, words: Map<string, number[]>, i: number, x: number, tol: number, visit: (j: number) => void) => {
    const seen = new Set<number>();
    const once = (j: number) => {
      if (seen.has(j)) return;
      seen.add(j);
      visit(j);
    };
    const wa = model!.wordsA(i);
    if (wa) for (const w of new Set(wa)) eachInWindow(words.get(cents(x) + " " + w), i, 64, once);
    const d = A.date[i];
    let p = pool.lowerBound(x - tol);
    for (let values = 0; p < pool.size && pool.vals[p] <= x + tol && values < 64; values++) {
      const v = pool.vals[p];
      const end = pool.lowerBound(nextUp(v));
      const dated = pool.lowerBound(v, -Number.MAX_VALUE);
      for (let q = p; q < dated; q++) once(pool.ids[q]);
      if (win === null || Number.isNaN(d)) {
        for (let q = dated; q < end && q < dated + NEAREST; q++) once(pool.ids[q]);
      } else {
        // outwards from the date, nearest first
        let lo = pool.lowerBound(v, d) - 1;
        let hi = lo + 1;
        for (let n = 0; n < NEAREST; n++) {
          const dl = lo >= dated ? d - pool.dates[lo] : Infinity;
          const dh = hi < end ? pool.dates[hi] - d : Infinity;
          if (Math.min(dl, dh) > win + 0.5) break;
          if (dl <= dh) once(pool.ids[lo--]);
          else once(pool.ids[hi++]);
        }
      }
      p = end;
    }
  };

  // 4. fuzzy text with amount and date
  if (s.passes.fuzzy && model) {
    // every candidate pair first, then the best pairs first over the whole
    // run; a pair only counts when its names agree more than they would by
    // chance among this many candidates of the same amount
    const fb = freeB();
    const fa = freeA();
    const allRefsB = refsOf(B, Array.from({ length: B.n }, (_, j) => j));
    const refsA = refsOf(A, fa);
    const refsB = refsOf(B, fb);
    const pool = new Pool(
      fb.filter((j) => B.text[j] && !Number.isNaN(B.amount[j])),
      (j) => B.amount[j],
      (j) => B.date[j],
    );
    const words = wordIndex(pool.ids);
    const pi: number[] = [];
    const pj: number[] = [];
    const ps: number[] = [];
    const pe: number[] = [];
    for (const i of fa) {
      const x = A.amount[i];
      if (!A.text[i] || Number.isNaN(x) || (A.ref[i] && allRefsB.has(A.ref[i]))) continue;
      const ta = A.text[i];
      const tol = toleranceFor(x, s);
      let n = -1;
      eachCandidate(pool, words, i, x, tol, (j) => {
        if (conflict(i, j, refsA, refsB)) return;
        const sc = textSimilarity(ta, B.text[j]);
        if (sc < s.fuzzyThreshold) return;
        if (n < 0) n = countNear(counters!.b, x, tol, A.date[i]);
        const ev = model.evidence(i, j);
        if (ev < Math.log(Math.max(n, crowdA(j)))) return;
        pi.push(i);
        pj.push(j);
        ps.push(sc);
        pe.push(ev - (days(i, j) ?? 0) * 1e-3);
      });
    }
    const order = Array.from(ps.keys()).sort((x, y) => pe[y] - pe[x] || ps[y] - ps[x] || pi[x] - pi[y] || pj[x] - pj[y]);
    for (const k of order) if (!usedA[pi[k]] && !usedB[pj[k]]) pair("fuzzy", pi[k], pj[k], Math.round(ps[k] * 1000) / 1000);
  } else if (s.passes.fuzzy) {
    const fb = freeB();
    const fa = freeA();
    const refsA = refsOf(A, fa);
    const refsB = refsOf(B, fb);
    const pool = new Pool(
      fb.filter((j) => B.text[j] && !Number.isNaN(B.amount[j])),
      (j) => B.amount[j],
      (j) => B.date[j],
    );
    for (const i of fa) {
      const x = A.amount[i];
      if (!A.text[i] || Number.isNaN(x) || (A.ref[i] && refsB.has(A.ref[i]))) continue;
      const ta = A.text[i];
      const j = bestInRange(pool, i, x, toleranceFor(x, s), 200, (j) => {
        if (conflict(i, j, refsA, refsB)) return null;
        const sc = textSimilarity(ta, B.text[j]);
        return sc >= s.fuzzyThreshold ? sc : null;
      });
      if (j >= 0) pair("fuzzy", i, j, Math.round(lastScore * 1000) / 1000);
    }
  }

  // 5. amount and date only. With many items of one amount (100.00 on the
  // same few days) the first candidate by date is often the wrong one, so
  // pairs whose descriptions name the same party go first, best pairs
  // first over the whole run; then the rest, one A item at a time, equally
  // good candidates told apart by their descriptions.
  if (s.passes.amountDate && model) {
    // With a model of what agreeing descriptions look like, and at volume:
    // every candidate pair is weighed. Names and kinds that agree count for
    // a pair as much as they are likelier between true pairs than between
    // strangers (nameAgreement / kindOf, learnt above); against that, the
    // number of items of that amount in the window on the busier side, any
    // of which could show the same agreement by chance. Without descriptions
    // a pair needs the two sides to hold about as many items of that amount
    // in the window (each item then has a counterpart: a reference-less bank
    // file); a lone ledger item among a crowd of bank lines of that amount
    // (a cheque among a day's fees) is left alone. Then the best pairs first
    // over the whole run.
    const fb = freeB();
    const fa = freeA();
    const allRefsA = refsOf(A, Array.from({ length: A.n }, (_, i) => i));
    const allRefsB = refsOf(B, Array.from({ length: B.n }, (_, j) => j));
    const pool = new Pool(
      fb.filter((j) => !Number.isNaN(B.amount[j]) && !(B.ref[j] && allRefsA.has(B.ref[j]))),
      (j) => B.amount[j],
      (j) => B.date[j],
    );
    const words = wordIndex(pool.ids);
    const pi: number[] = [];
    const pj: number[] = [];
    const pe: number[] = [];
    const pd: number[] = [];
    for (const i of fa) {
      const x = A.amount[i];
      if (Number.isNaN(x) || (A.ref[i] && allRefsB.has(A.ref[i]))) continue;
      const tol = toleranceFor(x, s);
      let n = -1;
      eachCandidate(pool, words, i, x, tol, (j) => {
        if (A.ref[i] && B.ref[j] && A.ref[i] !== B.ref[j]) return;
        if (n < 0) n = countNear(counters!.b, x, tol, A.date[i]);
        const m = crowdA(j);
        const dd = days(i, j) ?? 0;
        if (model.cls(i, j) === NAME_NO_TEXT) {
          // nothing to tell them apart: pairs where both sides hold about as many, each ledger item in turn, nearest date first
          if (Math.max(n, m) > BALANCE * Math.min(n, m)) return;
          pi.push(i);
          pj.push(j);
          pe.push(-Infinity);
          pd.push(dd);
          return;
        }
        // pairs with better names and kinds first, over the whole run
        const ev = model.evidence(i, j);
        if (ev < Math.log(Math.max(n, m))) return;
        pi.push(i);
        pj.push(j);
        pe.push(ev);
        pd.push(dd);
      });
    }
    const order = Array.from(pe.keys()).sort((x, y) => (pe[x] === pe[y] ? 0 : pe[y] - pe[x]) || (pe[x] === -Infinity ? pi[x] - pi[y] : 0) || pd[x] - pd[y] || pi[x] - pi[y] || pj[x] - pj[y]);
    for (const k of order) if (!usedA[pi[k]] && !usedB[pj[k]]) pair("amount+date", pi[k], pj[k]);
  } else if (s.passes.amountDate) {
    const fb = freeB();
    const fa = freeA();
    const refsA = refsOf(A, fa);
    const refsB = refsOf(B, fb);
    const spoken = (i: number) => !!A.ref[i] && refsB.has(A.ref[i]);

    // 5a. same amount (to the cent), in the window, a name in common
    {
      const wordsB = new Map<number, string[]>();
      const index = new Map<string, number[]>();
      for (const j of fb) {
        if (Number.isNaN(B.amount[j]) || !B.text[j]) continue;
        const ws = nameWords(B.text[j]);
        if (!ws.length) continue;
        wordsB.set(j, ws);
        for (const w of new Set(ws)) {
          const k = cents(B.amount[j]) + " " + w;
          const list = index.get(k);
          if (list) list.push(j);
          else index.set(k, [j]);
        }
      }
      const byDate = (x: number, y: number) => dateKey(B.date[x]) - dateKey(B.date[y]) || x - y;
      for (const list of index.values()) if (list.length > 1) list.sort(byDate);
      const pi: number[] = [];
      const pj: number[] = [];
      const ps: number[] = [];
      for (const i of fa) {
        if (Number.isNaN(A.amount[i]) || !A.text[i] || spoken(i)) continue;
        const wa = nameWords(A.text[i]);
        if (!wa.length) continue;
        const own = new Set(wa);
        const seen = new Set<number>();
        for (const w of own) {
          const list = index.get(cents(A.amount[i]) + " " + w);
          if (!list) continue;
          // from the start of the window
          let lo = 0;
          if (win !== null && !Number.isNaN(A.date[i])) {
            let hi = list.length;
            const from = A.date[i] - win - 0.5;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (dateKey(B.date[list[mid]]) < from) lo = mid + 1;
              else hi = mid;
            }
            // undated items sort first and are always in the window
            if (Number.isNaN(B.date[list[0]])) lo = 0;
          }
          for (let k = lo, n = 0; k < list.length && n < 64; k++) {
            const j = list[k];
            if (seen.has(j)) continue;
            seen.add(j);
            if (!inWindow(i, j)) {
              if (!Number.isNaN(B.date[j]) && !Number.isNaN(A.date[i]) && B.date[j] > A.date[i]) break;
              continue;
            }
            n++;
            if (conflict(i, j, refsA, refsB)) continue;
            let shared = 0;
            for (const x of new Set(wordsB.get(j))) if (own.has(x)) shared++;
            pi.push(i);
            pj.push(j);
            ps.push(shared + textSimilarity(A.text[i], B.text[j]) - (days(i, j) ?? 0) * 1e-3);
          }
        }
      }
      const order = Array.from(ps.keys()).sort((x, y) => ps[y] - ps[x] || pi[x] - pi[y] || pj[x] - pj[y]);
      for (const k of order) if (!usedA[pi[k]] && !usedB[pj[k]]) pair("amount+date", pi[k], pj[k]);
    }

    // 5b. the rest, on amount and date alone (nearest date; equally good
    // candidates told apart by their descriptions). Not for an item whose
    // reference the other side has somewhere: a second copy of a matched
    // posting isn't some other payment that happens to agree.
    const allRefsA = refsOf(A, Array.from({ length: A.n }, (_, i) => i));
    const allRefsB = refsOf(B, Array.from({ length: B.n }, (_, j) => j));
    const pool = new Pool(
      fb.filter((j) => !usedB[j] && !Number.isNaN(B.amount[j]) && !(B.ref[j] && allRefsA.has(B.ref[j]))),
      (j) => B.amount[j],
      (j) => B.date[j],
    );
    for (const i of fa) {
      const x = A.amount[i];
      if (usedA[i] || Number.isNaN(x) || (A.ref[i] && allRefsB.has(A.ref[i]))) continue;
      const ta = A.text[i];
      const j = bestInRange(
        pool,
        i,
        x,
        toleranceFor(x, s),
        256,
        (j) => (A.ref[i] && B.ref[j] && A.ref[i] !== B.ref[j] ? null : 0),
        false,
        ta ? (j) => (B.text[j] ? textSimilarity(ta, B.text[j]) : 0) : undefined,
      );
      if (j >= 0) pair("amount+date", i, j);
    }
  }

  // 6. sums: one item against 2..k on the other side. First where a
  // reference ties them (strong evidence), both ways; then, for items whose
  // reference the other side doesn't have, among the nearest by date (weak
  // evidence: only items of the same sign, and only when exactly one
  // combination adds up, so a coincidence of round amounts isn't a match).
  const sumCapped: { side: "A" | "B"; item: number }[] = [];
  let budget = s.sumTotalCap;
  let dateCapped: { side: "A" | "B"; item: number }[] = [];
  if (s.passes.sum && s.sumMaxItems >= 2) {
    const run = (one: Side, usedOne: Uint8Array, many: Side, usedMany: Uint8Array, oneIsA: boolean, byDateToo: boolean) => {
      const free: number[] = [];
      for (let j = 0; j < many.n; j++) if (!usedMany[j] && !Number.isNaN(many.amount[j])) free.push(j);
      const byRef = new Map<string, number[]>();
      for (const j of free) {
        const r = many.ref[j];
        if (!r) continue;
        const g = byRef.get(r);
        if (g) g.push(j);
        else byRef.set(r, [j]);
      }
      // in the date search, an item whose reference the one side has is spoken for
      const spoken = byDateToo ? refsOf(one, Array.from({ length: one.n }, (_, i) => i).filter((i) => !usedOne[i])) : null;
      const byDate = byDateToo
        ? new Pool(
            free.filter((j) => !Number.isNaN(many.date[j])),
            (j) => many.date[j],
            () => 0,
          )
        : null;
      const inWin = (i: number, j: number) => {
        if (win === null) return true;
        const a = one.date[i];
        const b = many.date[j];
        return Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) <= win + EPS;
      };
      for (let i = 0; i < one.n; i++) {
        if (budget <= 0) break;
        if (usedOne[i] || Number.isNaN(one.amount[i])) continue;
        const target = one.amount[i];
        const tol = toleranceFor(target, s);
        // candidates: same reference if the other side has it; else nearest by date
        let cands: number[] = [];
        const r = one.ref[i];
        const g = r ? byRef.get(r) : undefined;
        if (g && !byDate) {
          for (let k = 0; k < g.length && cands.length < s.sumCandidates * 4; k++) if (!usedMany[g[k]] && inWin(i, g[k])) cands.push(g[k]);
          // everything with this reference adds up: one group, however many items
          if (cands.length >= 2 && cands.length <= s.sumCandidates) {
            const all = cands.reduce((t, j) => t + many.amount[j], 0);
            if (Math.abs(all - target) <= tol) {
              take(one, usedOne, many, usedMany, oneIsA, i, cands, null);
              continue;
            }
          }
        } else if (!g && byDate && byDate.size && !Number.isNaN(one.date[i]) && target) {
          const sign = Math.sign(target);
          const limit = s.sumCandidates * 4;
          const near = nearestByDate(byDate, one.date[i], win, limit, usedMany);
          cands = near.filter((j) => Math.sign(many.amount[j]) === sign && !(r && many.ref[j] && many.ref[j] !== r) && !(many.ref[j] && spoken!.has(many.ref[j])));
          // only a search of everything in the window can tell a real sum from a coincidence
          if (near.length >= limit) {
            dateCapped.push({ side: oneIsA ? "A" : "B", item: i });
            continue;
          }
          if (cands.length < 2) continue;
          // fewest items first: 2, then 3, ... each searched in full; a second subset that adds up makes it ambiguous
          let steps = 0;
          let items: number[] | null = null;
          let capped = false;
          const vals = cands.map((j) => many.amount[j]);
          for (let m = 2; m <= s.sumMaxItems && m <= cands.length; m++) {
            // so many combinations that one would add up by chance: not evidence of anything
            if (chanceSums(vals, m, target, tol) > CHANCE_LIMIT) break;
            const found = subsetSum(cands, (j) => many.amount[j], target, tol, m, Math.min(s.sumStepCap, budget) - steps, true);
            steps += found.steps;
            if (found.items) items = found.items;
            capped = found.capped;
            if (found.items || found.ambiguous || found.capped) break;
          }
          budget -= steps;
          if (capped) dateCapped.push({ side: oneIsA ? "A" : "B", item: i });
          if (items) take(one, usedOne, many, usedMany, oneIsA, i, items, byDate);
          continue;
        }
        if (cands.length < 2) continue;
        if (cands.length > s.sumCandidates) {
          const d = one.date[i];
          cands.sort((x, y) => (Number.isNaN(d) ? 0 : Math.abs(many.date[x] - d) - Math.abs(many.date[y] - d)) || x - y);
          cands.length = s.sumCandidates;
        }
        const found = subsetSum(cands, (j) => many.amount[j], target, tol, s.sumMaxItems, Math.min(s.sumStepCap, budget));
        budget -= found.steps;
        if (found.capped && !found.items) sumCapped.push({ side: oneIsA ? "A" : "B", item: i });
        if (found.items) take(one, usedOne, many, usedMany, oneIsA, i, found.items, byDate);
      }
    };
    const take = (one: Side, usedOne: Uint8Array, many: Side, usedMany: Uint8Array, oneIsA: boolean, i: number, items: number[], byDate: Pool | null) => {
      usedOne[i] = 1;
      for (const j of items) {
        usedMany[j] = 1;
        byDate?.takeId(j);
      }
      const target = one.amount[i];
      const sumMany = items.reduce((t, j) => t + many.amount[j], 0);
      let maxDays: number | null = null;
      for (const j of items) {
        const a = one.date[i];
        const b = many.date[j];
        if (!Number.isNaN(a) && !Number.isNaN(b)) maxDays = Math.max(maxDays ?? 0, Math.round(Math.abs(a - b)));
      }
      const sorted = items.slice().sort((x, y) => x - y);
      matches.push({
        rule: oneIsA ? "one-to-many" : "many-to-one",
        a: oneIsA ? [i] : sorted,
        b: oneIsA ? sorted : [i],
        amountDiff: round2(oneIsA ? target - sumMany : sumMany - target),
        days: maxDays,
      });
    };
    run(A, usedA, B, usedB, true, false);
    run(B, usedB, A, usedA, false, false);
    // by date, in rounds: each sum found takes its items out of the others' windows,
    // which can leave a sum that was ambiguous with only one way to add up
    for (let round = 0; round < 4 && budget > 0; round++) {
      const before = matches.length;
      dateCapped = [];
      run(A, usedA, B, usedB, true, true);
      run(B, usedB, A, usedA, false, true);
      if (matches.length === before) break;
    }
    for (const c of dateCapped) sumCapped.push(c);
  }

  // leftovers: same key (normalised) but amounts too far apart
  const mismatched: RecPair[] = [];
  {
    const groups = new Map<string, number[]>();
    for (const j of freeB()) {
      const r = B.ref[j];
      if (!r) continue;
      const g = groups.get(r);
      if (g) g.push(j);
      else groups.set(r, [j]);
    }
    for (const i of freeA()) {
      const g = A.ref[i] ? groups.get(A.ref[i]) : undefined;
      if (!g?.length) continue;
      // nearest amount, then nearest date
      let best = 0;
      let bestDiff = Infinity;
      let bestDays = Infinity;
      for (let k = 0; k < g.length && k < 64; k++) {
        const j = g[k];
        const diff = Math.abs(amountDiff(i, j));
        const d = days(i, j) ?? 0;
        if ((Number.isNaN(diff) ? Infinity : diff) < bestDiff || (diff === bestDiff && d < bestDays)) {
          best = k;
          bestDiff = Number.isNaN(diff) ? Infinity : diff;
          bestDays = d;
        }
      }
      const j = g[best];
      g.splice(best, 1);
      usedA[i] = 1;
      usedB[j] = 1;
      mismatched.push({ a: i, b: j, amountDiff: amountDiff(i, j), days: days(i, j) });
    }
  }

  const unmatchedA = freeA();
  const unmatchedB = freeB();

  // keying errors
  const flags: RecFlag[] = [];
  for (const m of mismatched) {
    const kind = Number.isNaN(A.amount[m.a]) || Number.isNaN(B.amount[m.b]) ? null : amountKeyingError(A.amount[m.a], B.amount[m.b]);
    if (kind) flags.push({ a: m.a, b: m.b, field: "amount", kind, mismatched: true });
  }
  {
    const flaggedB = new Uint8Array(B.n);
    const byDate = (x: number, y: number) => dateKey(B.date[x]) - dateKey(B.date[y]) || x - y;
    const group = (keys: (j: number) => Iterable<string | number>): Map<string | number, number[]> => {
      const index = new Map<string | number, number[]>();
      for (const j of unmatchedB) {
        if (Number.isNaN(B.amount[j])) continue;
        for (const k of keys(j)) {
          const list = index.get(k);
          if (list) list.push(j);
          else index.set(k, [j]);
        }
      }
      for (const list of index.values()) if (list.length > 1) list.sort(byDate);
      return index;
    };
    /** the keys a reference typo leaves in common: the amount with one character, or two neighbouring ones, blanked out */
    const typoKeys = (ref: string, c: number): string[] => {
      const out: string[] = [];
      for (let p = 0; p < ref.length; p++) {
        out.push(`${c}|${ref.slice(0, p)}?${ref.slice(p + 1)}`);
        if (p + 1 < ref.length) out.push(`${c}|${ref.slice(0, p)}??${ref.slice(p + 2)}`);
      }
      return out;
    };
    const byCents = group((j) => [cents(B.amount[j])]);
    const byTypo = group((j) => (B.ref[j] ? typoKeys(B.ref[j], cents(B.amount[j])) : []));
    const pick = (i: number, lists: (number[] | undefined)[], ok: (j: number) => boolean): number => {
      let best = -1;
      let bestD = Infinity;
      for (const list of lists)
        eachInWindow(list, i, 64, (j) => {
          if (flaggedB[j] || !ok(j)) return;
          const d = days(i, j) ?? 0;
          if (d < bestD || (d === bestD && j < best)) {
            best = j;
            bestD = d;
          }
        });
      return best;
    };
    const RANK: Record<KeyingError, number> = { "sign flip": 0, x10: 1, x100: 1, "/10": 1, "/100": 1, transposition: 2, "digit slip": 3 };
    const refOk = (i: number, j: number) => !(A.ref[i] && B.ref[j]) || A.ref[i] === B.ref[j];
    const keyFlagged = new Uint8Array(model ? A.n : 0);
    for (const i of unmatchedA) {
      if (Number.isNaN(A.amount[i])) continue;
      const c = cents(A.amount[i]);
      // a reference typo: same amount, keys one swap or one character apart
      if (A.ref[i]) {
        const j = pick(
          i,
          typoKeys(A.ref[i], c).map((k) => byTypo.get(k)),
          (j) => !!B.ref[j] && (isTransposition(A.ref[i], B.ref[j]) || isOneSlip(A.ref[i], B.ref[j])),
        );
        if (j >= 0) {
          flaggedB[j] = 1;
          flags.push({ a: i, b: j, field: "key", kind: isTransposition(A.ref[i], B.ref[j]) ? "transposition" : "digit slip", mismatched: false });
          if (model) keyFlagged[i] = 1;
          continue;
        }
      }
      if (model) continue;
      // an amount typo: a differently keyed amount, with nothing to say the references differ;
      // nothing ties the two but the amount, so when both have descriptions they must share a name
      let found: { j: number; kind: KeyingError } | null = null;
      for (const [v, kind] of keyingVariants(c)) {
        if (found && RANK[found.kind] <= RANK[kind]) break;
        const j = pick(i, [byCents.get(v)], (j) => refOk(i, j) && (!A.text[i] || !B.text[j] || sharesName(A.text[i], B.text[j])));
        if (j >= 0 && (!found || RANK[kind] < RANK[found.kind])) found = { j, kind };
      }
      if (found) {
        flaggedB[found.j] = 1;
        flags.push({ a: i, b: found.j, field: "amount", kind: found.kind, mismatched: false });
      }
    }
    if (model) {
      // With a model, and at volume: every item at an amount a typo could
      // have made, in the window, is a candidate; a pair is flagged only when
      // its names and kinds agree more than chance would explain among that
      // many candidates. Best pairs first over the whole run. Not for an item
      // whose reference the other side has (a second copy of a matched posting).
      const allRefsB = refsOf(B, Array.from({ length: B.n }, (_, j) => j));
      const byWord = group((j) => {
        const c = cents(B.amount[j]);
        return new Set((model.wordsB(j) ?? []).map((w) => c + " " + w));
      });
      /** items of a date-sorted list in the window of A item i */
      const countInWindow = (list: number[] | undefined, i: number): number => {
        if (!list) return 0;
        const d = A.date[i];
        if (win === null || Number.isNaN(d)) return list.length;
        const first = (from: number, pred: (j: number) => boolean) => {
          let lo = from;
          let hi = list.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pred(list[mid])) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const undated = first(0, (j) => Number.isNaN(B.date[j]));
        const lo = first(undated, (j) => B.date[j] < d - win - 0.5);
        return undated + first(lo, (j) => B.date[j] <= d + win + 0.5) - lo;
      };
      const fi: number[] = [];
      const fj: number[] = [];
      const fk: KeyingError[] = [];
      const fe: number[] = [];
      for (const i of unmatchedA) {
        if (keyFlagged[i] || Number.isNaN(A.amount[i]) || (A.ref[i] && allRefsB.has(A.ref[i]))) continue;
        const variants = keyingVariants(cents(A.amount[i]));
        let n = 0;
        for (const [v] of variants) n += countInWindow(byCents.get(v), i);
        if (!n) continue;
        const crowd = Math.log(n);
        const words = new Set(model.wordsA(i) ?? []);
        for (const [v, kind] of variants) {
          const seen = new Set<number>();
          const visit = (j: number) => {
            if (seen.has(j) || flaggedB[j] || !refOk(i, j)) return;
            seen.add(j);
            const ev = model.evidence(i, j) - crowd;
            if (ev < 0) return;
            fi.push(i);
            fj.push(j);
            fk.push(kind);
            fe.push(ev - RANK[kind] * 1e-2 - (days(i, j) ?? 0) * 1e-4);
          };
          for (const w of words) eachInWindow(byWord.get(v + " " + w), i, 64, visit);
          eachInWindow(byCents.get(v), i, 4, visit);
        }
      }
      const flaggedA = new Uint8Array(A.n);
      const order = Array.from(fe.keys()).sort((x, y) => fe[y] - fe[x] || fi[x] - fi[y] || fj[x] - fj[y]);
      for (const k of order) {
        if (flaggedA[fi[k]] || flaggedB[fj[k]]) continue;
        flaggedA[fi[k]] = flaggedB[fj[k]] = 1;
        flags.push({ a: fi[k], b: fj[k], field: "amount", kind: fk[k], mismatched: false });
      }
    }
  }

  const duplicates = [...findDuplicates(A, "A"), ...findDuplicates(B, "B")];

  const byRule = Object.fromEntries(REC_RULES.map((r) => [r, 0])) as Record<RecRule, number>;
  let matchedA = 0;
  let matchedB = 0;
  for (const m of matches) {
    byRule[m.rule]++;
    matchedA += m.a.length;
    matchedB += m.b.length;
  }
  const total = (sd: Side, ids: number[]) => round2(ids.reduce((t, i) => t + (Number.isNaN(sd.amount[i]) ? 0 : sd.amount[i]), 0));
  const summary: RecSummary = {
    countA: A.n,
    countB: B.n,
    matchedA,
    matchedB,
    matchRate: A.n + B.n ? (matchedA + matchedB) / (A.n + B.n) : 0,
    byRule,
    mismatched: mismatched.length,
    unmatchedA: unmatchedA.length,
    unmatchedB: unmatchedB.length,
    unmatchedTotalA: total(A, unmatchedA),
    unmatchedTotalB: total(B, unmatchedB),
    mismatchedTotalA: total(A, mismatched.map((m) => m.a)),
    mismatchedTotalB: total(B, mismatched.map((m) => m.b)),
    duplicatesA: duplicates.filter((d) => d.side === "A").length,
    duplicatesB: duplicates.filter((d) => d.side === "B").length,
    flags: flags.length,
  };
  return { matches, mismatched, unmatchedA, unmatchedB, duplicates, flags, sumCapped, sumBudgetExhausted: s.passes.sum && budget <= 0, summary };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const amtKey = (x: number) => (Number.isNaN(x) ? "-" : String(cents(x)));
const nextUp = (x: number) => x + Math.max(Math.abs(x) * Number.EPSILON * 2, Number.MIN_VALUE);

/** Without descriptions, a pair on amount and date needs the busier side to hold at most this many times the items of that amount in the window as the other. */
const BALANCE = 2;
/** Candidates looked at per amount, nearest by date first, besides those that share a party word. */
const NEAREST = 32;
/** Pairs sampled to learn what true pairs' and strangers' descriptions look like. */
const MODEL_SAMPLE = 20_000;
/** Fewer pairs than this of either and there's no model. */
const MODEL_MIN = 200;

interface TextModel {
  /** party words of an A item and of a B item (partyWords; null without a description) */
  wordsA(i: number): string[] | null;
  wordsB(j: number): string[] | null;
  /** how the two descriptions' names agree (nameAgreement) */
  cls(i: number, j: number): number;
  /** log of how much likelier this agreement of names and kinds is between true pairs than between strangers */
  evidence(i: number, j: number): number;
}

/**
 * What agreeing descriptions look like in this run. True pairs: the 1:1
 * matches the key passes made. Strangers: random free items of A against
 * random free items of B. For each class of name agreement, and for kinds
 * that differ, the log of the ratio of the two rates (smoothed). Null with
 * too few of either: then nothing is known about how descriptions agree.
 */
function textModel(A: Side, B: Side, matches: RecMatch[], usedA: Uint8Array, usedB: Uint8Array): TextModel | null {
  const words = (sd: Side, cache: (string[] | null | undefined)[], i: number): string[] | null => {
    let w = cache[i];
    if (w === undefined) w = cache[i] = sd.text[i] ? partyWords(sd.text[i]) : null;
    return w;
  };
  const kinds = (sd: Side, cache: Int8Array, i: number): number => {
    if (cache[i] < 0) cache[i] = sd.text[i] ? kindOf(sd.text[i]) : 0;
    return cache[i];
  };
  const wA: (string[] | null | undefined)[] = new Array(A.n);
  const wB: (string[] | null | undefined)[] = new Array(B.n);
  const kA = new Int8Array(A.n).fill(-1);
  const kB = new Int8Array(B.n).fill(-1);
  const cls = (i: number, j: number) => nameAgreement(words(A, wA, i), words(B, wB, j));
  const differ = (i: number, j: number) => kindsDiffer(kinds(A, kA, i), kinds(B, kB, j));

  const tally = (pairs: Iterable<[number, number]>) => {
    const byClass = new Float64Array(NAME_CLASSES);
    let n = 0;
    let kd = 0;
    for (const [i, j] of pairs) {
      byClass[cls(i, j)]++;
      if (differ(i, j)) kd++;
      n++;
    }
    return { byClass, n, kd };
  };
  // true pairs: key matches with descriptions on both sides, evenly spread over the run
  const keyed: number[] = [];
  for (let k = 0; k < matches.length; k++) {
    const m = matches[k];
    if (m.a.length === 1 && m.b.length === 1 && A.text[m.a[0]] && B.text[m.b[0]]) keyed.push(k);
  }
  const step = Math.max(1, Math.floor(keyed.length / MODEL_SAMPLE));
  const truth = tally(
    (function* () {
      for (let k = 0; k < keyed.length; k += step) yield [matches[keyed[k]].a[0], matches[keyed[k]].b[0]] as [number, number];
    })(),
  );
  // strangers: random free items with descriptions
  const fa: number[] = [];
  const fb: number[] = [];
  for (let i = 0; i < A.n; i++) if (!usedA[i] && A.text[i]) fa.push(i);
  for (let j = 0; j < B.n; j++) if (!usedB[j] && B.text[j]) fb.push(j);
  let seed = 0x5eed;
  const rand = (n: number) => {
    // mulberry32: deterministic, so a run gives the same result every time
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  const chance = tally(
    (function* () {
      if (!fa.length || !fb.length) return;
      for (let k = 0; k < MODEL_SAMPLE; k++) yield [fa[rand(fa.length)], fb[rand(fb.length)]] as [number, number];
    })(),
  );
  if (truth.n < MODEL_MIN || chance.n < MODEL_MIN) return null;
  const lr = new Float64Array(NAME_CLASSES);
  for (let c = 0; c < NAME_CLASSES; c++) {
    const rt = (truth.byClass[c] + 0.5) / (truth.n + 0.5 * NAME_CLASSES);
    const rc = (chance.byClass[c] + 0.5) / (chance.n + 0.5 * NAME_CLASSES);
    lr[c] = Math.log(rt / rc);
  }
  lr[NAME_NO_TEXT] = 0;
  const kt = (truth.kd + 0.5) / (truth.n + 1);
  const kc = (chance.kd + 0.5) / (chance.n + 1);
  const kindDiffer = Math.log(kt / kc);
  const kindSame = Math.log((1 - kt) / (1 - kc));
  return {
    cls,
    wordsA: (i) => words(A, wA, i),
    wordsB: (j) => words(B, wB, j),
    evidence: (i, j) => lr[cls(i, j)] + (differ(i, j) ? kindDiffer : kindSame),
  };
}

/** In the date search: the most combinations expected to add up by accident before a sum stops counting as a match. */
const CHANCE_LIMIT = 0.02;

/**
 * About how many m-item subsets of these amounts would add up to target
 * (within tol) by accident: the number of subsets times the density of
 * their sums at the target, taking the sums as normally distributed.
 */
export function chanceSums(vals: readonly number[], m: number, target: number, tol: number): number {
  const n = vals.length;
  if (m > n || m < 1) return 0;
  let mean = 0;
  for (const v of vals) mean += v;
  mean /= n;
  let sq = 0;
  for (const v of vals) sq += (v - mean) ** 2;
  // in cents: amounts are only ever equal to the cent
  const sd = Math.max(Math.sqrt((m * sq) / n) * 100, 1);
  const z = (target - m * mean) / (sd / 100);
  const density = Math.exp((-z * z) / 2) / (sd * Math.sqrt(2 * Math.PI));
  let subsets = 1;
  for (let k = 0; k < m; k++) subsets = (subsets * (n - k)) / (k + 1);
  return subsets * density * (2 * Math.round(tol * 100) + 1);
}

/** Up to `limit` free items within the window of date d, nearest first. */
function nearestByDate(pool: Pool, d: number, win: number | null, limit: number, used: Uint8Array): number[] {
  const out: number[] = [];
  const start = pool.lowerBound(d);
  let lo = start - 1;
  let hi = start;
  const max = win ?? Infinity;
  let guard = 0;
  while (out.length < limit && guard++ < limit * 8) {
    if (hi < pool.size) hi = pool.free(hi);
    const dl = lo >= 0 ? d - pool.vals[lo] : Infinity;
    const dh = hi < pool.size ? pool.vals[hi] - d : Infinity;
    if (dl === Infinity && dh === Infinity) break;
    if (dl > max + EPS && dh > max + EPS) break;
    if (dl <= dh) {
      if (!used[pool.ids[lo]]) out.push(pool.ids[lo]);
      lo--;
    } else {
      if (!used[pool.ids[hi]]) out.push(pool.ids[hi]);
      hi++;
    }
  }
  return out;
}

/**
 * A subset of 2..k candidates whose amounts add up to target within tol.
 * Depth-first over candidates sorted by amount, the last item found by
 * binary search. Stops after `cap` steps.
 *
 * With `unique`, the search goes on after the first subset: if a second,
 * different one also adds up, the answer is ambiguous and no subset is
 * returned (nor is one when the cap cuts the search short).
 */
export function subsetSum(
  cands: number[],
  amount: (j: number) => number,
  target: number,
  tol: number,
  k: number,
  cap: number,
  unique = false,
): { items: number[] | null; steps: number; capped: boolean; ambiguous: boolean } {
  const ids = cands.slice().sort((x, y) => amount(x) - amount(y));
  const vals = ids.map(amount);
  const n = ids.length;
  // prefix sums for pruning when everything has one sign
  const allPos = vals.every((v) => v >= 0);
  const allNeg = vals.every((v) => v <= 0);
  const want = unique ? 2 : 1;
  let steps = 0;
  let capped = false;
  const chosen: number[] = [];
  const found: number[][] = [];
  const lb = (v: number, from: number) => {
    let lo = from;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** true: stop searching */
  const dfs = (from: number, sum: number, size: number): boolean => {
    for (let p = from; p < n; p++) {
      if (++steps > cap) {
        capped = true;
        return true;
      }
      const s2 = sum + vals[p];
      if (allPos && s2 > target + tol && vals[p] > 0) return false;
      if (allNeg && s2 < target - tol && vals[p] < 0) return false;
      chosen.push(p);
      if (size + 2 <= k) {
        // try finishing with one more item after p (each item that fits is another subset)
        const need = target - s2;
        for (let q = lb(need - tol, p + 1); q < n && vals[q] <= need + tol; q++) {
          found.push([...chosen, q]);
          if (found.length >= want) {
            chosen.pop();
            return true;
          }
        }
        if (size + 2 < k && dfs(p + 1, s2, size + 1)) {
          chosen.pop();
          return true;
        }
      }
      chosen.pop();
    }
    return false;
  };
  if (n >= 2) dfs(0, 0, 0);
  const ambiguous = unique && found.length >= 2;
  const ok = unique ? found.length === 1 && !capped : found.length >= 1;
  return { items: ok ? found[0].map((p) => ids[p]) : null, steps, capped: capped && !ok, ambiguous };
}

/** A description and amount seen on other days at this rate a day or more are routine (a bank's standard fee): two on one day are not a duplicate. */
const ROUTINE_RATE = 0.25;

/**
 * Records on one side that look the same: same normalised key (or text),
 * amount and date.
 * Records known only by their description are left out when that
 * description and amount are routine: they turn up on other days at
 * ROUTINE_RATE a day or more, so two on one day are what volume gives.
 */
function findDuplicates(sd: Side, name: "A" | "B"): RecDuplicate[] {
  const groups = new Map<string, number[]>();
  const routine = new Map<string, number>();
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < sd.n; i++) {
    const id = sd.ref[i] || sd.text[i];
    if (!id) continue;
    const d = sd.date[i];
    if (!Number.isNaN(d)) {
      if (d < first) first = d;
      if (d > last) last = d;
    }
    const k = id + "\u0000" + amtKey(sd.amount[i]) + "\u0000" + (Number.isNaN(d) ? "-" : Math.floor(d));
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
    if (!sd.ref[i]) {
      const r = id + "\u0000" + amtKey(sd.amount[i]);
      routine.set(r, (routine.get(r) ?? 0) + 1);
    }
  }
  const otherDays = last >= first ? Math.floor(last) - Math.floor(first) : 0;
  const out: RecDuplicate[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const i = g[0];
    if (!sd.ref[i] && otherDays > 0 && !Number.isNaN(sd.date[i])) {
      const elsewhere = routine.get(sd.text[i] + "\u0000" + amtKey(sd.amount[i]))! - g.length;
      if (elsewhere / otherDays >= ROUTINE_RATE) continue;
    }
    out.push({ side: name, items: g });
  }
  return out;
}
