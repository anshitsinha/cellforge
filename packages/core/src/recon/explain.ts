/**
 * "Why don't these match?": compare one record from each side, list what
 * differs (case, spaces, leading zeros, a date gap, an amount difference,
 * a flipped sign, swapped digits...) and suggest the setting that would
 * make them match.
 */
import { DEFAULT_REC_SETTINGS, reconcile, toleranceFor, type RecRecord, type RecRule, type RecSettings } from "./match";
import { amountKeyingError, isOneSlip, isTransposition, KEYING_LABEL, normRef, refPrefix, textSimilarity } from "./text";

export type ExplainKind =
  | "case"
  | "spaces"
  | "punctuation"
  | "prefix"
  | "leading zeros"
  | "key transposition"
  | "key typo"
  | "different key"
  | "missing key"
  | "sign"
  | "amount transposition"
  | "digit slip"
  | "decimal point"
  | "amount"
  | "missing amount"
  | "date"
  | "text";

export interface ExplainReason {
  kind: ExplainKind;
  text: string;
}

export interface Explanation {
  /** the rule they match by with these settings, or null */
  rule: RecRule | null;
  reasons: ExplainReason[];
  /** what to change so they'd match, if anything simple would */
  suggestion: { text: string; settings: Partial<RecSettings>; rule: RecRule | null } | null;
  /** the two references after normalisation (when both have one) */
  normalised: [string, string] | null;
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Why `a` and `b` don't match (or how they do). */
export function explain(a: RecRecord, b: RecRecord, settings: Partial<RecSettings> = {}): Explanation {
  const s: RecSettings = { ...DEFAULT_REC_SETTINGS, ...settings, passes: { ...DEFAULT_REC_SETTINGS.passes, ...settings.passes } };
  const ruleWith = (st: RecSettings): RecRule | null => {
    const r = reconcile([{ ...a, row: 0 }], [{ ...b, row: 0 }], { ...st, passes: { ...st.passes, sum: false } });
    return r.matches[0]?.rule ?? null;
  };
  const rule = ruleWith(s);
  const reasons: ExplainReason[] = [];
  const patch: Partial<RecSettings> = {};
  const passes = { ...s.passes };
  const fixes: string[] = [];

  // the references
  const ka = (a.key ?? "").trim();
  const kb = (b.key ?? "").trim();
  let normalised: [string, string] | null = null;
  let keysAgree = false;
  if (ka && kb) {
    normalised = [normRef(ka, s.prefixes), normRef(kb, s.prefixes)];
    if (ka !== kb) {
      const steps: Array<[ExplainKind, string, (x: string) => string]> = [
        ["case", "The references differ in upper and lower case", (x) => x.toUpperCase()],
        ["spaces", "The references differ in spaces", (x) => x.replace(/\s+/g, "")],
        ["punctuation", "The references differ in punctuation (- / . # and so on)", (x) => x.replace(/[^0-9A-Za-z\s]/g, "")],
        ["prefix", "One reference has a prefix the other hasn't", (x) => {
          // case-sensitive here, so a lower-case prefix counts as a case difference
          const p = s.prefixes.map((q) => q.toUpperCase()).filter((q) => x.startsWith(q) && x.length > q.length && !/[A-Za-z]/.test(x.charAt(q.length))).sort((p1, p2) => p2.length - p1.length)[0];
          return p ? x.slice(p.length) : x;
        }],
        ["leading zeros", "The references differ in leading zeros", (x) => x.replace(/^([A-Za-z]*)0+(?=\d)/, "$1")],
      ];
      const through = (v: string, skip: number) => steps.reduce((acc, [, , f], k) => (k === skip ? acc : f(acc)), v);
      if (through(ka, -1) === through(kb, -1)) {
        // each step that's needed: leave it out and they no longer agree
        steps.forEach(([kind, text], k) => {
          if (through(ka, k) === through(kb, k)) return;
          const p = refPrefix(ka.toUpperCase(), s.prefixes) ?? refPrefix(kb.toUpperCase(), s.prefixes);
          reasons.push({ kind, text: kind === "prefix" && p ? `${text} (${p})` : text });
        });
        keysAgree = true;
        if (!s.passes.reference) {
          passes.reference = true;
          fixes.push(`compare references normalised ("${normalised[0]}")`);
        }
      } else if (isTransposition(normalised[0], normalised[1])) {
        reasons.push({ kind: "key transposition", text: `The references are the same but for two characters swapped (${ka} / ${kb})` });
      } else if (isOneSlip(normalised[0], normalised[1])) {
        reasons.push({ kind: "key typo", text: `The references differ in one character (${ka} / ${kb})` });
      } else reasons.push({ kind: "different key", text: `The references are different (${ka} / ${kb})` });
    } else keysAgree = true;
  } else if (ka || kb) reasons.push({ kind: "missing key", text: `Only ${ka ? "A" : "B"} has a reference` });

  // the amounts
  const xa = a.amount;
  const xb0 = b.amount;
  if (xa === undefined || xb0 === undefined || !Number.isFinite(xa) || !Number.isFinite(xb0)) {
    if ((xa === undefined) !== (xb0 === undefined)) reasons.push({ kind: "missing amount", text: `Only ${xa !== undefined ? "A" : "B"} has an amount` });
  } else {
    const xb = s.flipB ? -xb0 : xb0;
    const diff = Math.round((xa - xb) * 100) / 100;
    const tol = toleranceFor(xa, s);
    if (Math.abs(xa - xb) > tol) {
      const pct = Math.abs(diff / (xa || 1)) * 100;
      const small = Math.abs(diff) <= 1 || pct <= 1;
      const keyed = amountKeyingError(xa, xb);
      const kind = keyed === "digit slip" && small ? null : keyed;
      if (kind === "sign flip") {
        reasons.push({ kind: "sign", text: `The amounts have opposite signs (${money(xa)} / ${money(xb0)})` });
        passes.amountDate = passes.amountDate || !keysAgree;
        patch.flipB = !s.flipB;
        fixes.push(s.flipB ? "treat B amounts as the same sign as A" : "treat B amounts as the opposite sign to A");
      } else if (kind === "transposition") {
        reasons.push({ kind: "amount transposition", text: `The amounts are the same but for two digits swapped (${money(xa)} / ${money(xb)}); the difference ${money(diff)} divides by 9` });
      } else if (kind === "digit slip") {
        reasons.push({ kind: "digit slip", text: `The amounts differ in one digit (${money(xa)} / ${money(xb)})` });
      } else if (kind) {
        reasons.push({ kind: "decimal point", text: `A is ${KEYING_LABEL[kind]} compared with B (${money(xa)} / ${money(xb)})` });
      } else {
        reasons.push({ kind: "amount", text: `The amounts differ by ${money(diff)} (${money(xa)} / ${money(xb)})` });
        if (small) {
          patch.amountTolerance = Math.max(s.amountTolerance, Math.ceil(Math.abs(diff) * 100) / 100);
          fixes.push(`allow an amount difference of ${money(patch.amountTolerance)}`);
        }
      }
    }
  }

  // the dates
  if (a.date !== undefined && b.date !== undefined && Number.isFinite(a.date) && Number.isFinite(b.date)) {
    const days = Math.round(Math.abs(a.date - b.date));
    if (days && s.dateWindow !== null && days > s.dateWindow) {
      reasons.push({ kind: "date", text: `The dates are ${days} day${days === 1 ? "" : "s"} apart; the window is ±${s.dateWindow}` });
      if (days <= 31) {
        patch.dateWindow = days;
        fixes.push(`widen the date window to ±${days} days`);
      }
    }
  }

  // the descriptions, when nothing else ties them
  if (a.text && b.text && !keysAgree) {
    const sc = textSimilarity(a.text, b.text);
    if (sc < s.fuzzyThreshold) reasons.push({ kind: "text", text: `The descriptions are only ${Math.round(sc * 100)}% alike (the fuzzy pass needs ${Math.round(s.fuzzyThreshold * 100)}%)` });
  }

  if (JSON.stringify(passes) !== JSON.stringify(s.passes)) patch.passes = passes;
  let suggestion: Explanation["suggestion"] = null;
  if (!rule && fixes.length) {
    const after = ruleWith({ ...s, ...patch, passes: { ...s.passes, ...patch.passes } });
    suggestion = { text: cap(fixes.join(", and ")) + (after ? "." : " (they still wouldn't match on that alone)."), settings: patch, rule: after };
  }
  if (!rule && !reasons.length) reasons.push({ kind: "amount", text: "Nothing differs that a pass looks at; check the passes are turned on" });
  return { rule, reasons, suggestion, normalised };
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
