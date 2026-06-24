/**
 * The join doctor and the join itself. The doctor looks at two sets of key
 * columns before you join: how many rows find a partner each way, which
 * keys repeat, which have no partner, numbers against text, stray spaces,
 * and which normalisation would lift the match rate by how much. The join
 * is hash based: one pass to index the right side, one to probe it.
 */
import { normText, textSimilarity } from "../recon/text";
import { NORMALISE_LABEL, NORMALISE_OPTIONS, rowCount, rowKey, rowText, showKey, textNumber, type KeyColumns, type KeyNormalise, type NormaliseOption } from "./keys";
import { blockedMatch, nameSimilarity, nameTokens } from "./names";

// ------------------------------------------------------------ doctor --

export interface DoctorKey {
  /** the key as shown (columns joined by " | ") */
  key: string;
  count: number;
  /** first row with it */
  row: number;
}

export interface DoctorSide {
  rows: number;
  /** rows with a blank key (a blank never matches) */
  blank: number;
  distinct: number;
  /** rows whose key is found on the other side */
  matchedRows: number;
  /** matchedRows over the non-blank rows, 0..1 */
  matchRate: number;
  /** keys that appear more than once, and the rows they cover */
  duplicateKeys: number;
  duplicateRows: number;
  topDuplicates: DoctorKey[];
  /** keys with no partner on the other side */
  orphanKeys: number;
  orphanRows: number;
  topOrphans: DoctorKey[];
  /** key cells that are numbers, text that reads as a number ("00123"), other text */
  numbers: number;
  numericText: number;
  text: number;
  /** text keys with spaces at the ends or doubled inside */
  padded: number;
}

export interface DoctorFix {
  option: NormaliseOption | "all";
  label: string;
  matchRateLeft: number;
  matchRateRight: number;
  /** extra rows that would find a partner, each side */
  gainLeft: number;
  gainRight: number;
  /** worked out from a sample of the keys (very large sides), so approximate */
  estimated: boolean;
}

export type Relationship = "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";

export interface DoctorResult {
  left: DoctorSide;
  right: DoctorSide;
  /** among matched keys */
  relationship: Relationship;
  /** rows an inner join and a left join would produce */
  innerRows: number;
  leftRows: number;
  /** one side keys by numbers, the other by text */
  typeMismatch: boolean;
  /** normalisations that would match more rows, best first; "all" is every one at once */
  fixes: DoctorFix[];
  /** plain-language findings, most important first */
  issues: string[];
}

interface Distinct {
  /** raw key → [rows, first row] */
  map: Map<string, [number, number]>;
  rows: number;
  blank: number;
  numbers: number;
  numericText: number;
  text: number;
  padded: number;
}

const RAW: KeyNormalise = {};

function distinct(cols: KeyColumns): Distinct {
  const map = new Map<string, [number, number]>();
  const n = rowCount(cols);
  let blank = 0;
  let numbers = 0;
  let numericText = 0;
  let text = 0;
  let padded = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < cols.length; c++) {
      const v = cols[c][r];
      if (typeof v === "number") {
        if (!Number.isNaN(v)) numbers++;
      } else if (typeof v === "string" && v !== "") {
        if (textNumber(v) !== null) numericText++;
        else if (v.trim()) text++;
        if (/^\s|\s$|\s\s| /.test(v)) padded++;
      }
    }
    const k = rowKey(cols, r, RAW);
    if (k === null) {
      blank++;
      continue;
    }
    const e = map.get(k);
    if (e) e[0]++;
    else map.set(k, [1, r]);
  }
  return { map, rows: n, blank, numbers, numericText, text, padded };
}

interface Tally {
  /** normalised key → [rows, first row] */
  keys: Map<string, [number, number]>;
  blank: number;
  /** for each distinct raw key (in d.map order): its first row, row count and normalised key */
  rawRow: Int32Array;
  rawCount: Int32Array;
  rawKey: Array<string | null>;
}

function normalised(cols: KeyColumns, d: Distinct, o: KeyNormalise): Tally {
  const keys = new Map<string, [number, number]>();
  let blank = d.blank;
  const n = d.map.size;
  const rawRow = new Int32Array(n);
  const rawCount = new Int32Array(n);
  const rawKey = new Array<string | null>(n);
  let i = 0;
  if (!Object.values(o).some(Boolean)) {
    // no normalisation: the raw keys are the keys
    for (const [k, [count, row]] of d.map) {
      rawRow[i] = row;
      rawCount[i] = count;
      rawKey[i++] = k;
    }
    return { keys: d.map, blank, rawRow, rawCount, rawKey };
  }
  for (const [count, row] of d.map.values()) {
    const k = rowKey(cols, row, o);
    rawRow[i] = row;
    rawCount[i] = count;
    rawKey[i++] = k;
    if (k === null) {
      blank += count;
      continue;
    }
    const e = keys.get(k);
    if (e) {
      e[0] += count;
      if (row < e[1]) e[1] = row;
    } else keys.set(k, [count, row]);
  }
  return { keys, blank, rawRow, rawCount, rawKey };
}

/** A quick string hash (FNV-1a), for sampling keys the same way on both sides. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * How the row counts per key change when option set `o` replaces the base
 * one. Only raw keys it actually changes are looked at; with `every` > 1
 * only keys whose hash falls in a 1-in-`every` sample are counted (a key
 * is in or out of the sample on both sides alike).
 */
function shift(cols: KeyColumns, t: Tally, o: KeyNormalise, every: number): { delta: Map<string, number>; blank: number } {
  const delta = new Map<string, number>();
  let blank = t.blank;
  const bump = (k: string, by: number) => {
    if (every > 1 && hash(k) % every) return;
    delta.set(k, (delta.get(k) ?? 0) + by);
  };
  for (let i = 0; i < t.rawRow.length; i++) {
    const was = t.rawKey[i];
    const now = rowKey(cols, t.rawRow[i], o);
    if (now === was) continue;
    const c = t.rawCount[i];
    if (was === null) blank -= c;
    else bump(was, -c);
    if (now === null) blank += c;
    else bump(now, c);
  }
  return { delta, blank };
}

function matched(a: Tally, b: Tally): number {
  let n = 0;
  for (const [k, [count]] of a.keys) if (b.keys.has(k)) n += count;
  return n;
}

const rate = (m: number, rows: number, blank: number) => (rows - blank > 0 ? m / (rows - blank) : 0);
const TOP = 20;

function top(entries: Iterable<[string, [number, number]]>, keep: (k: string, count: number) => boolean): { list: DoctorKey[]; keys: number; rows: number } {
  // the TOP biggest, kept sorted as we go (most rows first, then earliest row)
  const best: Array<[string, number, number]> = [];
  const before = (c1: number, r1: number, c2: number, r2: number) => c1 > c2 || (c1 === c2 && r1 < r2);
  let keys = 0;
  let rows = 0;
  for (const [k, [count, row]] of entries) {
    if (!keep(k, count)) continue;
    keys++;
    rows += count;
    if (best.length === TOP) {
      const last = best[TOP - 1];
      if (!before(count, row, last[1], last[2])) continue;
      best.pop();
    }
    let i = best.length;
    while (i > 0 && before(count, row, best[i - 1][1], best[i - 1][2])) i--;
    best.splice(i, 0, [k, count, row]);
  }
  return { list: best.map(([k, count, row]) => ({ key: showKey(k), count, row })), keys, rows };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/**
 * Check two sets of key columns before joining them. `normalise` is what
 * the join would use; each fix is measured on top of it.
 */
export function joinDoctor(leftKeys: KeyColumns, rightKeys: KeyColumns, opts: { normalise?: KeyNormalise } = {}): DoctorResult {
  const base = opts.normalise ?? {};
  const dl = distinct(leftKeys);
  const dr = distinct(rightKeys);
  const tl = normalised(leftKeys, dl, base);
  const tr = normalised(rightKeys, dr, base);
  const ml = matched(tl, tr);
  const mr = matched(tr, tl);

  const side = (d: Distinct, t: Tally, other: Tally, m: number): DoctorSide => {
    const dup = top(t.keys, (_, c) => c > 1);
    const orphan = top(t.keys, (k) => !other.keys.has(k));
    return {
      rows: d.rows,
      blank: t.blank,
      distinct: t.keys.size,
      matchedRows: m,
      matchRate: rate(m, d.rows, t.blank),
      duplicateKeys: dup.keys,
      duplicateRows: dup.rows,
      topDuplicates: dup.list,
      orphanKeys: orphan.keys,
      orphanRows: orphan.rows,
      topOrphans: orphan.list,
      numbers: d.numbers,
      numericText: d.numericText,
      text: d.text,
      padded: d.padded,
    };
  };
  const left = side(dl, tl, tr, ml);
  const right = side(dr, tr, tl, mr);

  // shape of the matched keys, and the rows a join would make
  let manyL = false;
  let manyR = false;
  let innerRows = 0;
  let leftRows = tl.blank;
  for (const [k, [cl]] of tl.keys) {
    const r = tr.keys.get(k);
    if (r) {
      if (cl > 1) manyL = true;
      if (r[0] > 1) manyR = true;
      innerRows += cl * r[0];
      leftRows += cl * r[0];
    } else leftRows += cl;
  }
  const relationship: Relationship = manyL ? (manyR ? "many-to-many" : "many-to-one") : manyR ? "one-to-many" : "one-to-one";

  // what each normalisation would add
  const fixes: DoctorFix[] = [];
  // above 400,000 distinct keys, gains are estimated from a sample of keys
  const every = Math.max(1, Math.ceil((tl.rawRow.length + tr.rawRow.length) / 400_000));
  const tryFix = (option: NormaliseOption | "all", o: KeyNormalise) => {
    // matched rows only change for keys whose counts change on either side
    const a = shift(leftKeys, tl, o, every);
    const b = shift(rightKeys, tr, o, every);
    const touched = new Set<string>(a.delta.keys());
    for (const k of b.delta.keys()) touched.add(k);
    let gl = 0;
    let gr = 0;
    for (const k of touched) {
      const l0 = tl.keys.get(k)?.[0] ?? 0;
      const r0 = tr.keys.get(k)?.[0] ?? 0;
      const l1 = l0 + (a.delta.get(k) ?? 0);
      const r1 = r0 + (b.delta.get(k) ?? 0);
      gl += (r1 > 0 ? l1 : 0) - (r0 > 0 ? l0 : 0);
      gr += (l1 > 0 ? r1 : 0) - (l0 > 0 ? r0 : 0);
    }
    gl *= every;
    gr *= every;
    if (every > 1) {
      gl = Math.min(gl, dl.rows - a.blank - ml);
      gr = Math.min(gr, dr.rows - b.blank - mr);
      // a sample is noisy: only gains of at least 1% of a side count
      if (gl < 0.01 * (dl.rows - a.blank)) gl = 0;
      if (gr < 0.01 * (dr.rows - b.blank)) gr = 0;
      gl = Math.round(gl);
      gr = Math.round(gr);
    }
    if (gl > 0 || gr > 0) {
      fixes.push({
        option,
        label: option === "all" ? "Trim, case, numbers, punctuation and leading zeros together" : NORMALISE_LABEL[option],
        matchRateLeft: rate(ml + gl, dl.rows, a.blank),
        matchRateRight: rate(mr + gr, dr.rows, b.blank),
        gainLeft: gl,
        gainRight: gr,
        estimated: every > 1,
      });
    }
  };
  // most rows gained first; on a tie, reference rules (the bluntest) last
  const byGain = (x: DoctorFix, y: DoctorFix) => y.gainLeft + y.gainRight - (x.gainLeft + x.gainRight) || (x.option === "ref" ? 1 : 0) - (y.option === "ref" ? 1 : 0);
  const off = NORMALISE_OPTIONS.filter((o) => !base[o]);
  for (const o of off) tryFix(o, { ...base, [o]: true });
  fixes.sort(byGain);
  {
    // every option but reference rules at once, when that beats each one alone
    const all: KeyNormalise = { ...base };
    for (const o of off) if (o !== "ref") all[o] = true;
    const mild = fixes.filter((f) => f.option !== "ref");
    const bestMild = mild.length ? mild[0].gainLeft + mild[0].gainRight : 0;
    const before = fixes.length;
    if (off.filter((o) => o !== "ref").length > 1) tryFix("all", all);
    if (fixes.length > before) {
      const a = fixes[fixes.length - 1];
      if (a.gainLeft + a.gainRight <= bestMild) fixes.pop();
      else fixes.sort(byGain);
    }
  }

  // numbers on one side, text on the other
  const numberish = (s: DoctorSide) => s.numbers > (s.numericText + s.text) * 4;
  const textish = (s: DoctorSide) => s.numericText + s.text > s.numbers * 4;
  const typeMismatch = !base.numbers && !base.ref && ((numberish(left) && textish(right) && right.numericText > 0) || (numberish(right) && textish(left) && left.numericText > 0));

  const issues: string[] = [];
  if (left.matchRate < 1 || right.matchRate < 1)
    issues.push(`${pct(left.matchRate)} of the left rows and ${pct(right.matchRate)} of the right rows find a partner.`);
  else issues.push("Every row on both sides finds a partner.");
  if (typeMismatch) issues.push(`One side's keys are numbers and the other's are text that looks like numbers ("00123" isn't 123 until you say so).`);
  if (left.padded || right.padded) issues.push(`${plural(left.padded + right.padded, "key")} ${left.padded + right.padded === 1 ? "has" : "have"} spaces at the ends or doubled inside.`);
  if (left.duplicateKeys) issues.push(`The left side repeats ${plural(left.duplicateKeys, "key")} (${plural(left.duplicateRows, "row")}).`);
  if (right.duplicateKeys) issues.push(`The right side repeats ${plural(right.duplicateKeys, "key")} (${plural(right.duplicateRows, "row")}): each matching left row will appear once per repeat.`);
  if (left.blank) issues.push(`${plural(left.blank, "left row")} ${left.blank === 1 ? "has" : "have"} a blank key and can't match.`);
  if (right.blank) issues.push(`${plural(right.blank, "right row")} ${right.blank === 1 ? "has" : "have"} a blank key and can't match.`);
  if (fixes.length) {
    const f = fixes[0];
    issues.push(`${f.label} would match ${plural(f.gainLeft, "more left row")} and ${plural(f.gainRight, "more right row")}.`);
  }
  return { left, right, relationship, innerRows, leftRows, typeMismatch, fixes, issues };
}

// -------------------------------------------------------------- join --

export type JoinKind = "inner" | "left" | "right" | "full" | "anti";
export const JOIN_KINDS: readonly JoinKind[] = ["inner", "left", "right", "full", "anti"];

/** When a row's key matches several rows on the other side: keep all, keep the first, or keep all and flag them. */
export type ManyPolicy = "all" | "first" | "flag";

export interface JoinOptions {
  normalise?: KeyNormalise;
  /** fuzzy-match rows left without an exact partner when the similarity is at least this (0..1); off when missing */
  fuzzy?: number;
  /** score fuzzy candidates as person / company names (order, initials, titles) rather than plain text */
  fuzzyNames?: boolean;
  many?: ManyPolicy;
  /** stop after this many output rows */
  maxRows?: number;
  /** cap on fuzzy comparisons */
  fuzzyBudget?: number;
}

export interface JoinResult {
  /** row indices on each side for every output row; -1 = no row on that side */
  left: Int32Array;
  right: Int32Array;
  /** 1 for an exact (normalised) match, the similarity for a fuzzy one, 0 for no match */
  score: Float32Array;
  /** 1 where the driving row matched more than one row on the other side (policy "flag", and "first" to say others were dropped) */
  flag: Uint8Array;
  rows: number;
  matchedLeft: number;
  matchedRight: number;
  fuzzyMatched: number;
  /** driving rows that matched more than one row */
  manyMatched: number;
  /** stopped at maxRows */
  capped: boolean;
  fuzzyCapped: boolean;
}

class Grow {
  a: Int32Array;
  n = 0;
  constructor(cap = 1024) {
    this.a = new Int32Array(cap);
  }
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
}

/**
 * Join two sets of key columns (one or more columns each, in the same
 * order). Returns pairs of row indices. For "left", "full" and "anti" the
 * left side drives (the many-policy applies to each left row's matches);
 * "right" is "left" with the sides swapped. "anti" gives the left rows with
 * no partner.
 */
export function join(leftKeys: KeyColumns, rightKeys: KeyColumns, kind: JoinKind, opts: JoinOptions = {}): JoinResult {
  if (kind === "right") {
    const r = join(rightKeys, leftKeys, "left", opts);
    return { ...r, left: r.right, right: r.left, matchedLeft: r.matchedRight, matchedRight: r.matchedLeft };
  }
  const o = opts.normalise ?? {};
  const many = opts.many ?? "all";
  const maxRows = opts.maxRows ?? 50_000_000;
  const nl = rowCount(leftKeys);
  const nr = rowCount(rightKeys);

  // index the right side: key → first row, rows chained in order
  const head = new Map<string, number>();
  const next = new Int32Array(nr).fill(-1);
  const rKey = new Array<string | null>(nr);
  for (let r = nr - 1; r >= 0; r--) {
    const k = rowKey(rightKeys, r, o);
    rKey[r] = k;
    if (k === null) continue;
    const h = head.get(k);
    if (h !== undefined) next[r] = h;
    head.set(k, r);
  }

  // probe: each left row's first partner
  const partner = new Int32Array(nl).fill(-1);
  const lscore = new Float32Array(nl);
  const hit = new Uint8Array(nr); // by head row: some left row matched this key
  let matchedLeft = 0;
  const pending: number[] = [];
  for (let l = 0; l < nl; l++) {
    const k = rowKey(leftKeys, l, o);
    if (k === null) continue;
    const h = head.get(k);
    if (h === undefined) {
      if (opts.fuzzy !== undefined) pending.push(l);
      continue;
    }
    partner[l] = h;
    lscore[l] = 1;
    hit[h] = 1;
    matchedLeft++;
  }

  // fuzzy: unmatched left texts against right keys nobody matched
  let fuzzyMatched = 0;
  let fuzzyCapped = false;
  if (opts.fuzzy !== undefined && pending.length) {
    const candText: string[] = [];
    const candHead: number[] = [];
    for (const h of head.values()) {
      if (hit[h]) continue;
      const t = rowText(rightKeys, h);
      if (t) {
        candText.push(t);
        candHead.push(h);
      }
    }
    const byText = new Map<string, number[]>();
    for (const l of pending) {
      const t = rowText(leftKeys, l);
      if (!t) continue;
      const list = byText.get(t);
      if (list) list.push(l);
      else byText.set(t, [l]);
    }
    const texts = [...byText.keys()];
    const tokens = opts.fuzzyNames ? (s: string) => nameTokens(s) : (s: string) => normText(s).split(" ").filter(Boolean);
    const score = opts.fuzzyNames ? nameSimilarity : textSimilarity;
    const res = blockedMatch(texts, candText, tokens, score, opts.fuzzy, opts.fuzzyBudget);
    fuzzyCapped = res.capped;
    texts.forEach((t, i) => {
      const m = res.matches[i];
      if (!m) return;
      const h = candHead[m.index];
      hit[h] = 1;
      for (const l of byText.get(t)!) {
        partner[l] = h;
        lscore[l] = Math.min(m.score, 0.999); // below 1: a fuzzy match is never mistaken for an exact one
        matchedLeft++;
        fuzzyMatched++;
      }
    });
  }

  // emit
  const L = new Grow(Math.max(16, Math.min(maxRows, nl + (kind === "full" ? nr : 0))));
  const R = new Grow(L.a.length);
  const sc = new Grow(L.a.length); // score in millionths
  const fl = new Grow(L.a.length);
  let capped = false;
  let manyMatched = 0;
  const out = (l: number, r: number, s: number, f: number): boolean => {
    if (L.n >= maxRows) {
      capped = true;
      return false;
    }
    L.push(l);
    R.push(r);
    sc.push(Math.round(s * 1_000_000));
    fl.push(f);
    return true;
  };
  for (let l = 0; l < nl && !capped; l++) {
    const h = partner[l];
    if (kind === "anti") {
      if (h < 0) out(l, -1, 0, 0);
      continue;
    }
    if (h < 0) {
      if (kind !== "inner") out(l, -1, 0, 0);
      continue;
    }
    const multi = next[h] >= 0;
    if (multi) manyMatched++;
    if (many === "first") {
      out(l, h, lscore[l], multi ? 1 : 0);
      continue;
    }
    for (let r = h; r >= 0; r = next[r]) if (!out(l, r, lscore[l], multi && many === "flag" ? 1 : 0)) break;
  }

  // right rows: matched when their key's head was hit
  let matchedRight = 0;
  const headOf = (r: number) => (rKey[r] === null ? -1 : head.get(rKey[r]!)!);
  for (let r = 0; r < nr; r++) {
    const h = headOf(r);
    if (h >= 0 && hit[h]) matchedRight++;
    else if (kind === "full" && !capped) out(-1, r, 0, 0);
  }

  const n = L.n;
  const score = new Float32Array(n);
  for (let i = 0; i < n; i++) score[i] = sc.a[i] / 1_000_000;
  const flag = new Uint8Array(n);
  for (let i = 0; i < n; i++) flag[i] = fl.a[i];
  return {
    left: L.a.slice(0, n),
    right: R.a.slice(0, n),
    score,
    flag,
    rows: n,
    matchedLeft,
    matchedRight,
    fuzzyMatched,
    manyMatched,
    capped,
    fuzzyCapped,
  };
}
