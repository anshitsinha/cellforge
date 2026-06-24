/**
 * Fuzzy matching for person and company names: "Smith, John" is
 * "John Smith", "J. Smith" is probably "John Smith", "Mr John Smith" and
 * "ACME Ltd" lose their title and legal suffix. And mapping tables: a list
 * of "this name → that name" pairs, built by hand or from suggestions, and
 * applied to a column.
 */
import { jaroWinkler } from "../recon/text";

const TITLES = new Set(["MR", "MRS", "MS", "MISS", "MX", "DR", "PROF", "PROFESSOR", "SIR", "DAME", "LORD", "LADY", "REV", "FR", "HON", "MESSRS", "M", "MME", "HERR", "FRAU"]);
const SUFFIXES = new Set(["JR", "JNR", "SR", "SNR", "II", "III", "IV", "ESQ", "PHD", "MD", "CPA", "CA", "ACA", "FCA", "ACCA"]);
const LEGAL = new Set([
  "LTD", "LIMITED", "INC", "INCORPORATED", "LLC", "LLP", "LP", "PLC", "CORP", "CORPORATION", "CO", "COMPANY", "GMBH", "AG", "SA", "SAS", "SARL", "SPA", "SRL",
  "PTY", "PTE", "BV", "NV", "AB", "AS", "OY", "KK", "BHD", "SDN", "PVT", "PRIVATE", "PUBLIC", "HOLDINGS", "GROUP", "THE",
]);

/** Name words: upper case, accents dropped, "&" read as AND, punctuation gone, "Smith, John" turned round to "JOHN SMITH". */
export function nameTokens(s: string, opts: { dropLegal?: boolean } = {}): string[] {
  let t = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/&/g, " AND ").trim();
  // "Smith, John" (one comma, not "ACME, Inc"): the part after the comma goes first
  const parts = t.split(",");
  if (parts.length === 2) {
    const after = parts[1].replace(/[^0-9A-Z]+/g, " ").trim().split(" ").filter(Boolean);
    const isTail = after.length > 0 && after.every((w) => LEGAL.has(w) || SUFFIXES.has(w));
    if (!isTail && after.length) t = `${parts[1]} ${parts[0]}`;
  }
  const words = t.replace(/[^0-9A-Z]+/g, " ").trim().split(" ").filter(Boolean);
  const kept = words.filter((w, i) => {
    if (TITLES.has(w) && words.length > 1 && (i === 0 || TITLES.has(words[i - 1]))) return false;
    if (SUFFIXES.has(w) && words.length > 1 && i > 0) return false;
    if (opts.dropLegal !== false && LEGAL.has(w) && words.length > 1) return false;
    return true;
  });
  return kept.length ? kept : words;
}

/** A name reduced to a key that ignores order, titles, legal suffixes and punctuation: "Smith, John" and "Mr John Smith" both give "JOHN SMITH". */
export function nameKey(s: string): string {
  return nameTokens(s).sort().join(" ");
}

/** How well one name word matches another: 1 same, 0.9 an initial of it, else Jaro-Winkler when close. */
function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return 0.9;
  if (a.length === 1 || b.length === 1) return 0;
  const jw = jaroWinkler(a, b);
  return jw >= 0.85 ? jw : 0;
}

/**
 * How alike two names are, 0..1, whatever the word order. Words pair up
 * best-first; an initial matches the word it starts ("J" = "JOHN"). A
 * missing middle name costs a little, a missing surname a lot.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(" ") === tb.join(" ")) return 1;
  // glued forms: "MACDONALD" vs "MAC DONALD"
  const ga = ta.join("");
  const gb = tb.join("");
  if (ga === gb) return 0.98;
  if ([...ta].sort().join("") === [...tb].sort().join("")) return 0.98;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // every pair's score, best first, each word used once
  const pairs: Array<[number, number, number]> = [];
  for (let i = 0; i < short.length; i++) for (let j = 0; j < long.length; j++) {
    const s = tokenScore(short[i], long[j]);
    if (s > 0) pairs.push([s, i, j]);
  }
  pairs.sort((x, y) => y[0] - x[0] || (short[x[1]].length === 1 ? 1 : 0) - (short[y[1]].length === 1 ? 1 : 0));
  const usedS = new Uint8Array(short.length);
  const usedL = new Uint8Array(long.length);
  let sum = 0;
  let full = 0; // matched words that aren't initials
  for (const [s, i, j] of pairs) {
    if (usedS[i] || usedL[j]) continue;
    usedS[i] = usedL[j] = 1;
    sum += s;
    if (short[i].length > 1 && long[j].length > 1) full++;
  }
  if (!full) return Math.min(0.5, sum / long.length);
  let score = sum / short.length;
  const extra = long.length - short.length;
  if (short.length === 1 && extra) score *= 0.75; // "Smith" alone against "John Smith"
  else score *= 1 - 0.04 * extra; // a missing middle name
  // every word unmatched in the short name counts against it fully
  const unmatched = short.length - usedS.reduce((t, x) => t + x, 0);
  if (unmatched) score *= (short.length - unmatched) / short.length;
  return Math.max(0, Math.min(1, score));
}

export interface NameMatch {
  /** index into the candidates */
  index: number;
  score: number;
}

/**
 * For each item, the best candidate at or above `threshold` (or null).
 * Blocking keeps it fast: each item is only scored against candidates that
 * share a word or a word's first three letters (or, for a name written
 * only in initials, an initial). A budget caps the total number of scores.
 */
export function blockedMatch(
  items: readonly string[],
  candidates: readonly string[],
  tokens: (s: string) => string[],
  score: (a: string, b: string) => number,
  threshold: number,
  budget = 5_000_000,
): { matches: Array<NameMatch | null>; capped: boolean } {
  const index = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const l = index.get(k);
    if (l) {
      if (l[l.length - 1] !== i) l.push(i);
    } else index.set(k, [i]);
  };
  candidates.forEach((c, i) => {
    for (const t of tokens(c)) {
      if (t.length > 1) {
        add(t, i);
        add(`~${t.slice(0, 3)}`, i);
      }
      add(`#${t[0]}`, i);
    }
  });
  let work = 0;
  let capped = false;
  const seen = new Int32Array(candidates.length).fill(-1);
  const matches = items.map((n, ni) => {
    if (capped) return null;
    const toks = tokens(n);
    const words = toks.filter((t) => t.length > 1);
    const keys = words.length ? words.flatMap((t) => [t, `~${t.slice(0, 3)}`]) : toks.map((t) => `#${t}`);
    let best: NameMatch | null = null;
    for (const k of keys) {
      const list = index.get(k);
      if (!list) continue;
      for (const ci of list) {
        if (seen[ci] === ni) continue;
        seen[ci] = ni;
        if (++work > budget) {
          capped = true;
          return best;
        }
        const s = score(n, candidates[ci]);
        if (s >= threshold && (!best || s > best.score)) best = { index: ci, score: s };
      }
    }
    return best;
  });
  return { matches, capped };
}

/** For each name, the most similar candidate name at or above `threshold` (or null); see nameSimilarity. */
export function matchNames(names: readonly string[], candidates: readonly string[], threshold = 0.85, budget = 5_000_000): { matches: Array<NameMatch | null>; capped: boolean } {
  return blockedMatch(names, candidates, (s) => nameTokens(s), nameSimilarity, threshold, budget);
}

// ------------------------------------------------------------ mapping --

export interface MappingTable {
  /** normalised "from" → "to" */
  map: Map<string, string>;
  /** a "from" given more than one different "to"; the first one is used */
  conflicts: Array<{ from: string; to: string[] }>;
  /** how loosely a value must equal a "from" */
  match: MappingMatch;
  /** rows with a blank "from" or "to", skipped */
  skipped: number;
}

export type MappingMatch = "exact" | "trim+case" | "name";

const mapNorm = (s: string, how: MappingMatch): string => (how === "exact" ? s : how === "trim+case" ? s.replace(/[\s ]+/g, " ").trim().toUpperCase() : nameKey(s));

/** A mapping table from pairs; `match` says how loosely a value must equal a "from" to be mapped. */
export function buildMapping(pairs: ReadonlyArray<readonly [string, string]>, match: MappingMatch = "trim+case"): MappingTable {
  const map = new Map<string, string>();
  const tos = new Map<string, Set<string>>();
  let skipped = 0;
  const firstFrom = new Map<string, string>();
  for (const [from, to] of pairs) {
    const f = (from ?? "").trim();
    const t = (to ?? "").trim();
    if (!f || !t) {
      skipped++;
      continue;
    }
    const k = mapNorm(f, match);
    if (!map.has(k)) {
      map.set(k, t);
      firstFrom.set(k, f);
      tos.set(k, new Set([t]));
    } else tos.get(k)!.add(t);
  }
  const conflicts = [...tos].filter(([, s]) => s.size > 1).map(([k, s]) => ({ from: firstFrom.get(k)!, to: [...s] }));
  return { map, conflicts, skipped, match };
}

export interface MappingResult {
  /** the mapped value for each input (the input itself when unmapped and `keepUnmapped`, else null) */
  values: Array<string | null>;
  mapped: number;
  /** of which matched only by fuzzy name matching */
  fuzzy: number;
  /** values with no mapping, with how many times each appears, most frequent first */
  unmapped: Array<{ value: string; count: number }>;
}

/**
 * Map each value through the table. With `fuzzy` (0..1), a value that has
 * no entry takes the "to" of the most similar "from" name at or above it.
 */
export function applyMapping(
  values: ReadonlyArray<string | null | undefined>,
  table: MappingTable,
  opts: { keepUnmapped?: boolean; fuzzy?: number; match?: MappingMatch } = {},
): MappingResult {
  const how = opts.match ?? table.match;
  const keep = opts.keepUnmapped !== false;
  const cache = new Map<string, { to: string | null; fuzzy: boolean }>();
  const missing = new Map<string, number>();
  const fromKeys = [...table.map.keys()];
  const out: Array<string | null> = new Array(values.length);
  let mapped = 0;
  let fuzzy = 0;
  // unmapped distinct values, resolved fuzzily in one batch at the end
  const pending: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || v === "") {
      out[i] = null;
      continue;
    }
    const s = String(v);
    let hit = cache.get(s);
    if (!hit) {
      const to = table.map.get(mapNorm(s, how));
      hit = { to: to ?? null, fuzzy: false };
      cache.set(s, hit);
    }
    if (hit.to !== null) {
      out[i] = hit.to;
      mapped++;
    } else pending.push(i);
  }
  if (opts.fuzzy !== undefined && pending.length && fromKeys.length) {
    const distinct = [...new Set(pending.map((i) => String(values[i])))];
    const { matches } = matchNames(distinct, fromKeys, opts.fuzzy);
    distinct.forEach((s, k) => {
      const m = matches[k];
      if (m) cache.set(s, { to: table.map.get(fromKeys[m.index])!, fuzzy: true });
    });
  }
  for (const i of pending) {
    const s = String(values[i]);
    const hit = cache.get(s)!;
    if (hit.to !== null) {
      out[i] = hit.to;
      mapped++;
      if (hit.fuzzy) fuzzy++;
    } else {
      out[i] = keep ? s : null;
      missing.set(s, (missing.get(s) ?? 0) + 1);
    }
  }
  const unmapped = [...missing].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
  return { values: out, mapped, fuzzy, unmapped };
}

/**
 * Suggested mapping pairs: each distinct "from" value with its most similar
 * "to" value by name matching, best first. Exact (after normalising) pairs
 * score 1. Review them, then build a table from the ones you keep.
 */
export function suggestMapping(from: ReadonlyArray<string | null | undefined>, to: ReadonlyArray<string | null | undefined>, threshold = 0.8): Array<{ from: string; to: string; score: number }> {
  const uniq = (xs: ReadonlyArray<string | null | undefined>) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()))];
  const f = uniq(from);
  const t = uniq(to);
  const { matches } = matchNames(f, t, threshold);
  const out: Array<{ from: string; to: string; score: number }> = [];
  f.forEach((s, i) => {
    const m = matches[i];
    if (m) out.push({ from: s, to: t[m.index], score: m.score });
  });
  return out.sort((a, b) => b.score - a.score || (a.from < b.from ? -1 : 1));
}
