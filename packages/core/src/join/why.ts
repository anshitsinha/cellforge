/**
 * "Why don't these match?" for two keys: what each value is (number, text
 * that looks like a number, text with stray spaces), and the smallest set
 * of normalisations that would make them equal.
 */
import { textSimilarity } from "../recon/text";
import { keyPart, NORMALISE_LABEL, NORMALISE_OPTIONS, textNumber, type KeyNormalise, type KeyValue, type NormaliseOption } from "./keys";
import { nameSimilarity } from "./names";

export interface KeyWhy {
  /** equal with the normalisation given */
  matches: boolean;
  /** one line per finding */
  reasons: string[];
  /** options to switch on (on top of the ones given) that make them equal; null when none do */
  fix: NormaliseOption[] | null;
  /** text and name similarity of the two values, 0..1 */
  similarity: number;
  nameSimilarity: number;
}

/** A key cell described for people. */
export function describeValue(v: KeyValue): string {
  if (v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) return "blank";
  if (typeof v === "number") return `the number ${v}`;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  const bits: string[] = [];
  if (textNumber(v) !== null) bits.push("text that looks like a number");
  else bits.push("text");
  if (/^\s/.test(v)) bits.push("starts with a space");
  if (/\s$/.test(v)) bits.push("ends with a space");
  if (/\s\s/.test(v.trim())) bits.push("has a doubled space");
  if (/ /.test(v)) bits.push("has a non-breaking space");
  return `"${v}" (${bits.join(", ")})`;
}

const same = (a: readonly KeyValue[], b: readonly KeyValue[], o: KeyNormalise) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = keyPart(a[i], o);
    if (x === null || x !== keyPart(b[i], o)) return false;
  }
  return true;
};

/** Why two keys (one value per key column) do or don't match, and what would fix it. */
export function whyKeys(a: readonly KeyValue[], b: readonly KeyValue[], normalise: KeyNormalise = {}): KeyWhy {
  const text = (vs: readonly KeyValue[]) => vs.filter((v) => v !== null && v !== undefined && v !== "").map(String).join(" ");
  const similarity = textSimilarity(text(a), text(b));
  const nameSim = nameSimilarity(text(a), text(b));
  const reasons: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const pa = keyPart(a[i], normalise);
    const pb = keyPart(b[i], normalise);
    if (pa !== null && pa === pb) continue;
    const label = a.length > 1 ? `Key column ${i + 1}: ` : "";
    if (pa === null || pb === null) reasons.push(`${label}${pa === null ? "the left" : "the right"} value is blank, and a blank never matches.`);
    else reasons.push(`${label}left is ${describeValue(a[i])}, right is ${describeValue(b[i])}.`);
  }
  if (same(a, b, normalise)) return { matches: true, reasons: ["These keys match."], fix: [], similarity, nameSimilarity: nameSim };
  // the smallest set of extra options that makes them equal, mildest first;
  // reference rules (which do several things at once) only when nothing milder works
  const off = NORMALISE_OPTIONS.filter((o) => !normalise[o] && o !== "ref");
  let fix: NormaliseOption[] | null = null;
  for (let size = 1; size <= Math.min(3, off.length) && !fix; size++) {
    const pick = (start: number, chosen: NormaliseOption[]): NormaliseOption[] | null => {
      if (chosen.length === size) {
        const o: KeyNormalise = { ...normalise };
        for (const c of chosen) o[c] = true;
        return same(a, b, o) ? chosen : null;
      }
      for (let i = start; i < off.length; i++) {
        const r = pick(i + 1, [...chosen, off[i]]);
        if (r) return r;
      }
      return null;
    };
    fix = pick(0, []);
  }
  if (!fix && !normalise.ref && same(a, b, { ...normalise, ref: true })) fix = ["ref"];
  if (fix) reasons.push(`They match with: ${fix.map((f) => NORMALISE_LABEL[f].toLowerCase()).join(" + ")}.`);
  else if (Math.max(similarity, nameSim) >= 0.8) reasons.push(`No normalisation makes them equal, but they are ${Math.round(Math.max(similarity, nameSim) * 100)}% alike: a fuzzy match would pair them.`);
  else reasons.push("No normalisation makes them equal; they are different keys.");
  return { matches: false, reasons, fix, similarity, nameSimilarity: nameSim };
}
