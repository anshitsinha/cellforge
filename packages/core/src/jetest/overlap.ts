/**
 * Red-flag overlaps between two lists of people or companies, such as the
 * vendor master and the employee master: the same bank account, address,
 * phone number or tax id, or names spelled alike. Exact fields are matched
 * after normalising (case, spaces, punctuation, common address words);
 * names are compared with Jaro-Winkler, only between names that share the
 * start of a word, so big lists stay quick.
 */
import { jaroWinkler, normaliseText } from "../audit/duplicates";

export type OverlapField = "bank" | "taxId" | "phone" | "address" | "name";
export const OVERLAP_FIELDS: readonly OverlapField[] = ["bank", "taxId", "phone", "address", "name"];
export const OVERLAP_LABEL: Record<OverlapField, string> = {
  bank: "Bank account",
  taxId: "Tax id",
  phone: "Phone",
  address: "Address",
  name: "Name",
};
/** Weight of each kind of match in a pair's score. */
export const OVERLAP_WEIGHTS: Record<OverlapField, number> = { bank: 5, taxId: 5, phone: 3, address: 3, name: 2 };

export interface Party {
  name?: string;
  bank?: string;
  address?: string;
  phone?: string;
  taxId?: string;
}

export interface OverlapMatch {
  field: OverlapField;
  a: string;
  b: string;
  /** Names only: how alike, 0 to 1. */
  similarity?: number;
}

export interface OverlapPair {
  /** Indexes into the two lists. */
  a: number;
  b: number;
  matches: OverlapMatch[];
  score: number;
}

export interface OverlapResult {
  pairs: OverlapPair[];
  /** Pairs found on each field. */
  byField: Record<OverlapField, number>;
}

export interface OverlapOptions {
  /** Fields to compare (all by default). */
  fields?: readonly OverlapField[];
  /** Name similarity needed, 0 to 1. Default 0.92. */
  nameSimilarity?: number;
}

/** Bank account or IBAN: letters and digits only, upper case. Too short to mean anything gives "". */
export function normBank(s: string): string {
  const t = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return t.length >= 5 ? t : "";
}

/** Tax id: letters and digits, upper case, leading zeros dropped. */
export function normTaxId(s: string): string {
  const t = s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^0+/, "");
  return t.length >= 4 ? t : "";
}

/** Phone: the last 9 digits (so +44 20 7946 0000 and 020 7946 0000 match), or "" for fewer than 7. */
export function normPhone(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length >= 7 ? d.slice(-9) : "";
}

const ADDRESS_WORDS: Record<string, string> = {
  street: "st",
  str: "st",
  road: "rd",
  avenue: "ave",
  av: "ave",
  drive: "dr",
  lane: "ln",
  boulevard: "blvd",
  court: "ct",
  place: "pl",
  square: "sq",
  highway: "hwy",
  parkway: "pkwy",
  terrace: "ter",
  crescent: "cres",
  close: "cl",
  apartment: "apt",
  flat: "apt",
  unit: "apt",
  suite: "apt",
  ste: "apt",
  floor: "fl",
  building: "bldg",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  number: "",
  no: "",
  the: "",
  and: "",
};

/** Address: lower case, no punctuation, common words shortened (Street → st, Suite → apt). */
export function normAddress(s: string): string {
  const words = normaliseText(s)
    .split(" ")
    .map((w) => (w in ADDRESS_WORDS ? ADDRESS_WORDS[w] : w))
    .filter(Boolean);
  const out = words.join(" ");
  return out.length >= 6 ? out : "";
}

const NAME_NOISE = new Set(["ltd", "limited", "inc", "incorporated", "llc", "llp", "lp", "plc", "co", "corp", "corporation", "company", "gmbh", "ag", "sa", "sarl", "bv", "nv", "pty", "pte", "srl", "the", "mr", "mrs", "ms", "miss", "dr", "and"]);

/** Name: lower case, no punctuation, legal forms and titles dropped. */
export function normName(s: string): string {
  return normaliseText(s)
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(" ");
}

/** How alike two normalised names are: the better of as written and with the words sorted (John Smith = Smith John). */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = a.split(" ").sort().join(" ");
  const sb = b.split(" ").sort().join(" ");
  return Math.max(jaroWinkler(a, b), jaroWinkler(sa, sb));
}

const NORM: Record<Exclude<OverlapField, "name">, (s: string) => string> = { bank: normBank, taxId: normTaxId, phone: normPhone, address: normAddress };

/** Find the pairs (one from each list) that share a bank account, tax id, phone or address, or have names spelled alike. */
export function redFlagOverlaps(listA: readonly Party[], listB: readonly Party[], opts: OverlapOptions = {}): OverlapResult {
  const fields = new Set(opts.fields ?? OVERLAP_FIELDS);
  const minSim = opts.nameSimilarity ?? 0.92;
  const pairs = new Map<string, OverlapPair>();
  const byField: Record<OverlapField, number> = { bank: 0, taxId: 0, phone: 0, address: 0, name: 0 };
  const add = (a: number, b: number, m: OverlapMatch) => {
    const k = a + ":" + b;
    let p = pairs.get(k);
    if (!p) {
      p = { a, b, matches: [], score: 0 };
      pairs.set(k, p);
    }
    if (p.matches.some((x) => x.field === m.field)) return;
    p.matches.push(m);
    p.score += OVERLAP_WEIGHTS[m.field] * (m.similarity ?? 1);
    byField[m.field]++;
  };
  for (const f of ["bank", "taxId", "phone", "address"] as const) {
    if (!fields.has(f)) continue;
    const index = new Map<string, number[]>();
    listB.forEach((p, j) => {
      const v = p[f];
      const k = v ? NORM[f](String(v)) : "";
      if (!k) return;
      const list = index.get(k);
      if (list) list.push(j);
      else index.set(k, [j]);
    });
    listA.forEach((p, i) => {
      const v = p[f];
      const k = v ? NORM[f](String(v)) : "";
      if (!k) return;
      for (const j of index.get(k) ?? []) add(i, j, { field: f, a: String(v).trim(), b: String(listB[j][f]).trim() });
    });
  }
  if (fields.has("name")) {
    // block on the first three letters of each word
    const normB = listB.map((p) => (p.name ? normName(String(p.name)) : ""));
    const blocks = new Map<string, number[]>();
    normB.forEach((n, j) => {
      for (const w of new Set(n.split(" "))) {
        if (w.length < 2) continue;
        const k = w.slice(0, 3);
        const list = blocks.get(k);
        if (list) list.push(j);
        else blocks.set(k, [j]);
      }
    });
    listA.forEach((p, i) => {
      const na = p.name ? normName(String(p.name)) : "";
      if (!na) return;
      const cand = new Set<number>();
      for (const w of na.split(" ")) if (w.length >= 2) for (const j of blocks.get(w.slice(0, 3)) ?? []) cand.add(j);
      for (const j of cand) {
        const sim = nameSimilarity(na, normB[j]);
        if (sim >= minSim) add(i, j, { field: "name", a: String(p.name).trim(), b: String(listB[j].name).trim(), similarity: Math.round(sim * 1000) / 1000 });
      }
    });
  }
  const list = [...pairs.values()].sort((x, y) => y.score - x.score || y.matches.length - x.matches.length || x.a - y.a || x.b - y.b);
  for (const p of list) p.score = Math.round(p.score * 100) / 100;
  return { pairs: list, byField };
}
