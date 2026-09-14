/**
 * The string and number helpers reconciliation is built on: normalising
 * references, fuzzy text scores, and telling what kind of keying error
 * turns one amount (or reference) into another.
 */

export const DEFAULT_PREFIXES = ["INVOICE", "INV", "REF", "PO", "CHQ", "CHEQUE", "CHK", "DOC", "TXN", "TRN", "PAY", "NO", "NUM", "ID"];

/** Upper case, with only letters and digits left. */
export function bareRef(s: string): string {
  return s.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** The prefix (from `prefixes`) at the start of a reference, if any. A prefix must be followed by something that isn't a letter. */
export function refPrefix(s: string, prefixes: readonly string[] = DEFAULT_PREFIXES): string | null {
  const u = s.trim().toUpperCase().replace(/^[#\s]+/, "");
  let best: string | null = null;
  for (const p of prefixes) {
    const P = p.toUpperCase();
    if (u.startsWith(P) && !/[A-Z]/.test(u.charAt(P.length)) && u.length > P.length && (!best || P.length > best.length)) best = P;
  }
  return best;
}

/**
 * A reference reduced to what identifies it: case, spaces and punctuation
 * ignored, a known prefix (INV, REF, ...) dropped, leading zeros dropped
 * (also after letters that aren't a known prefix: "DEP-0042" is "DEP42").
 * "INV-000123", "inv 123" and "#123" all become "123".
 */
export function normRef(s: string, prefixes: readonly string[] = DEFAULT_PREFIXES): string {
  let u = s.trim().toUpperCase().replace(/^[#\s]+/, "");
  const p = refPrefix(u, prefixes);
  if (p) u = u.slice(p.length);
  u = u.replace(/[^0-9A-Z]/g, "").replace(/^([A-Z]+)0+(?=\d)/, "$1");
  const stripped = u.replace(/^0+/, "");
  return stripped || (u ? "0" : "");
}

/** Text for fuzzy comparison: upper case words of letters and digits, single spaced. */
export function normText(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^0-9A-Z]+/g, " ")
    .trim();
}

/** Words that say what kind of transaction it is, not who it's with. */
const GENERIC_WORDS = new Set(
  (
    "THE AND FOR FROM WITH REF PAYMENT PAYMENTS PAID PAY RECEIPT RECEIPTS RECEIVED RECD CUSTOMER SUPPLIER CARD CHEQUE CHQ CREDIT DEBIT " +
    "TRANSFER TRF FASTER BGC FPO FPI BACS DDR CHAPS SEPA GIRO STANDING ORDER DIRECT LTD LIMITED PLC LLP INC CORP COMPANY GROUP INVOICE " +
    "DEPOSIT BANK FEE FEES CHARGE CHARGES INTEREST ONLINE MOBILE BILL PURCHASE REFUND SALES SALE CASH ACCOUNT"
  ).split(" "),
);

/**
 * The words of a description that can name a party: three or more letters
 * (or four or more digits), not a generic banking word ("PAYMENT", "LTD",
 * "BACS"...). Takes normalised text (normText).
 */
export function nameWords(s: string): string[] {
  return s.split(" ").filter((w) => (/^\d+$/.test(w) ? w.length >= 4 : w.length >= 3) && !GENERIC_WORDS.has(w));
}

/** Two descriptions (normalised) name the same party: they have a name word in common. */
export function sharesName(a: string, b: string): boolean {
  const wa = new Set(nameWords(a));
  return nameWords(b).some((w) => wa.has(w));
}

/** Two name words that are the same, or one is the other cut short (bank lines are often truncated): "ENGINEERI" and "ENGINEERING". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3 || /^\d+$/.test(a) || /^\d+$/.test(b)) return false;
  return a.length < b.length ? b.startsWith(a) : a.startsWith(b);
}

/** Classes of how two descriptions agree on names (see nameAgreement). */
export const NAME_CLASSES = 18;
/** either side has no description at all */
export const NAME_NO_TEXT = 0;
/** descriptions on both sides, but one names no one ("CHAPS FEE", "CHEQUE DEPOSIT") */
export const NAME_NONE = 1;

/**
 * How two descriptions' name words agree, as a small class: NAME_NO_TEXT,
 * NAME_NONE, or 2 + 4k + 2·(A has a name word B lacks) + (B has one A
 * lacks), with k the words in common (a truncated word counts), at most 3.
 * "BRISTOL WILLOW PLASTICS" against "BRISTOL WILLOW FARMS" is k = 2 with a
 * word left over on each side; against "BRISTOL WILLOW PLAS" it is k = 3
 * with nothing left over. Takes the words from partyWords (null: no
 * description).
 */
export function nameAgreement(wa: readonly string[] | null, wb: readonly string[] | null): number {
  if (!wa || !wb) return NAME_NO_TEXT;
  if (!wa.length || !wb.length) return NAME_NONE;
  let inB = 0;
  for (const a of wa) if (wb.some((b) => sameWord(a, b))) inB++;
  let inA = 0;
  for (const b of wb) if (wa.some((a) => sameWord(a, b))) inA++;
  const k = Math.min(3, inA, inB);
  return 2 + 4 * k + (inB < wa.length ? 2 : 0) + (inA < wb.length ? 1 : 0);
}

/** What kind of transaction a description says it is, as bits (0: it doesn't say). */
export const KIND_CHEQUE = 1;
export const KIND_CARD = 2;
export const KIND_FEE = 4;
export const KIND_INTEREST = 8;
export const KIND_DIRECT_DEBIT = 16;
export const KIND_TRANSFER = 32;
export const KIND_DEPOSIT = 64;
const KIND_WORDS: Record<string, number> = {
  CHEQUE: KIND_CHEQUE, CHEQUES: KIND_CHEQUE, CHQ: KIND_CHEQUE, CHK: KIND_CHEQUE,
  CARD: KIND_CARD, POS: KIND_CARD, VISA: KIND_CARD, MASTERCARD: KIND_CARD, CONTACTLESS: KIND_CARD,
  FEE: KIND_FEE, FEES: KIND_FEE, CHARGE: KIND_FEE, CHARGES: KIND_FEE, COMMISSION: KIND_FEE,
  INTEREST: KIND_INTEREST,
  DD: KIND_DIRECT_DEBIT, DDR: KIND_DIRECT_DEBIT,
  BGC: KIND_TRANSFER, FPO: KIND_TRANSFER, FPI: KIND_TRANSFER, BACS: KIND_TRANSFER, CHAPS: KIND_TRANSFER, FASTER: KIND_TRANSFER, TRANSFER: KIND_TRANSFER, TRF: KIND_TRANSFER, GIRO: KIND_TRANSFER, SEPA: KIND_TRANSFER, BP: KIND_TRANSFER, SO: KIND_TRANSFER,
  DEPOSIT: KIND_DEPOSIT, LODGEMENT: KIND_DEPOSIT, COUNTER: KIND_DEPOSIT, PAYING: KIND_DEPOSIT,
};

const DATE_STAMP = /^\d{1,2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2}|\d{4})?$/;

/** The name words of a normalised description (nameWords), without words that say what kind of transaction it is ("COUNTER", "PAYING") or date stamps ("ON 05MAR"). */
export function partyWords(s: string): string[] {
  return nameWords(s).filter((w) => !(w in KIND_WORDS) && !DATE_STAMP.test(w));
}

/**
 * The kind of transaction a normalised description names, as bits:
 * cheque, card, fee, interest, direct debit, transfer, deposit. A fee or
 * interest line is only that ("CHAPS FEE" is a fee, not a transfer); a
 * cheque can be paid in, so cheque and deposit go together.
 */
export function kindOf(s: string): number {
  let m = 0;
  for (const w of s.split(" ")) m |= KIND_WORDS[w] ?? 0;
  if (m & KIND_FEE) return KIND_FEE;
  if (m & KIND_INTEREST) return KIND_INTEREST;
  if (m & (KIND_CHEQUE | KIND_DEPOSIT)) m |= KIND_CHEQUE | KIND_DEPOSIT;
  return m;
}

/** Both descriptions say what kind of transaction they are, and the kinds differ. */
export function kindsDiffer(a: number, b: number): boolean {
  return a !== 0 && b !== 0 && (a & b) === 0;
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Uint8Array(la);
  const mb = new Uint8Array(lb);
  let m = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(lb - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!mb[j] && a.charCodeAt(i) === b.charCodeAt(j)) {
        ma[i] = mb[j] = 1;
        m++;
        break;
      }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, j = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[j]) j++;
    if (a.charCodeAt(i) !== b.charCodeAt(j)) t++;
    j++;
  }
  const jaro = (m / la + m / lb + (m - t / 2) / m) / 3;
  let l = 0;
  while (l < 4 && l < la && l < lb && a.charCodeAt(l) === b.charCodeAt(l)) l++;
  return jaro + l * 0.1 * (1 - jaro);
}

/** Share of words in common (Dice), 0..1. Word order doesn't matter. */
export function tokenSimilarity(a: string, b: string): number {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of tb) {
    const c = counts.get(t);
    if (c) {
      common++;
      counts.set(t, c - 1);
    }
  }
  return (2 * common) / (ta.length + tb.length);
}

/** How alike two pieces of text are, 0..1: the better of Jaro-Winkler and word overlap, on normalised text. */
export function textSimilarity(a: string, b: string): number {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sorted = (s: string) => s.split(" ").sort().join(" ");
  return Math.max(jaroWinkler(na, nb), jaroWinkler(sorted(na), sorted(nb)), tokenSimilarity(na, nb));
}

/** Kinds of keying error between two amounts or references. */
export type KeyingError = "sign flip" | "transposition" | "digit slip" | "x10" | "x100" | "/10" | "/100";

/** Two strings the same but for one pair of neighbouring characters swapped. */
export function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let i = 0;
  while (a[i] === b[i]) i++;
  if (i + 1 >= a.length || a[i] !== b[i + 1] || a[i + 1] !== b[i]) return false;
  return a.slice(i + 2) === b.slice(i + 2);
}

/** Two strings of the same length differing in exactly one place. */
export function isOneSlip(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
}

/** Amount in whole cents. */
export const cents = (x: number): number => Math.round(x * 100);

/**
 * The keying error that turns amount `b` into amount `a`, if there is one
 * (compared in cents): a sign flip, two neighbouring digits swapped, one
 * digit wrong, or a decimal point in the wrong place.
 */
export function amountKeyingError(a: number, b: number): KeyingError | null {
  const ca = cents(a);
  const cb = cents(b);
  if (ca === cb || !ca || !cb) return null;
  if (ca === -cb) return "sign flip";
  if (ca === cb * 10) return "x10";
  if (ca === cb * 100) return "x100";
  if (ca * 10 === cb) return "/10";
  if (ca * 100 === cb) return "/100";
  if (Math.sign(ca) !== Math.sign(cb)) return null;
  const sa = String(Math.abs(ca));
  const sb = String(Math.abs(cb));
  if (isTransposition(sa, sb)) return "transposition";
  if (isOneSlip(sa, sb)) return "digit slip";
  return null;
}

/** Every amount (in cents) one keying error away from `c`, with the error that gets there. */
export function keyingVariants(c: number): Array<[number, KeyingError]> {
  const out: Array<[number, KeyingError]> = [];
  if (!c) return out;
  out.push([-c, "sign flip"], [c * 10, "/10"], [c * 100, "/100"]);
  if (c % 10 === 0) out.push([c / 10, "x10"]);
  if (c % 100 === 0) out.push([c / 100, "x100"]);
  const sign = Math.sign(c);
  const s = String(Math.abs(c));
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i] === s[i + 1] || (i === 0 && s[1] === "0")) continue;
    out.push([sign * Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)), "transposition"]);
  }
  for (let i = 0; i < s.length; i++) {
    for (let d = 0; d <= 9; d++) {
      const ch = String(d);
      if (ch === s[i] || (i === 0 && d === 0)) continue;
      out.push([sign * Number(s.slice(0, i) + ch + s.slice(i + 1)), "digit slip"]);
    }
  }
  return out;
}

export const KEYING_LABEL: Record<KeyingError, string> = {
  "sign flip": "sign flipped",
  transposition: "two digits swapped",
  "digit slip": "one digit wrong",
  x10: "ten times too big",
  x100: "a hundred times too big",
  "/10": "ten times too small",
  "/100": "a hundred times too small",
};
