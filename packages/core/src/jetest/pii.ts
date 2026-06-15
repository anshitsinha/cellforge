/**
 * Personal data scan and protection. The scan looks at every value of each
 * column for emails, phone numbers, IBANs (checksum checked), card numbers
 * (Luhn checked), US social security and UK national insurance numbers, and
 * at the column names for dates of birth, names, addresses and id numbers.
 *
 * Protecting a column: mask (keep the last 4 characters), hash (salted
 * SHA-256, the same value always gives the same hash for the same salt),
 * pseudonymise (PERSON_0001 style tokens, with the mapping kept apart),
 * or redact (blank). The hasher is passed in, so tests can use a fake one.
 */
import { dateParts } from "../clean/values";
import type { Cell } from "../audit/values";

export type PiiKind = "email" | "phone" | "iban" | "card" | "ssn" | "ni" | "dob" | "name" | "address" | "id";
export const PII_LABEL: Record<PiiKind, string> = {
  email: "Email address",
  phone: "Phone number",
  iban: "IBAN",
  card: "Card number",
  ssn: "US social security number",
  ni: "UK national insurance number",
  dob: "Date of birth",
  name: "Person's name",
  address: "Address",
  id: "Id or account number",
};

export type ProtectMethod = "keep" | "mask" | "hash" | "pseudonymise" | "redact";
export const PROTECT_LABEL: Record<ProtectMethod, string> = {
  keep: "Keep as is",
  mask: "Mask (keep last 4)",
  hash: "Hash (salted SHA-256)",
  pseudonymise: "Pseudonymise (PERSON_0001)",
  redact: "Redact (blank)",
};

// ------------------------------------------------------------- checks --

/** Luhn checksum, for card numbers. */
export function luhn(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN checksum (ISO 13616 mod 97). Spaces are ignored. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch.charCodeAt(0);
    const part = code >= 65 ? String(code - 55) : ch;
    for (const d of part) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/i;
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
const SSN = /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/;
const NI = /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s.-]\d{2,5}){1,4}|\+\d{7,15}\b|\b0\d{9,10}\b/;

/** What a single value is, if it looks like personal data. */
export function detectValue(v: Cell): PiiKind | null {
  if (v === null) return null;
  if (typeof v === "number") {
    // only long whole numbers can be card numbers
    if (Number.isInteger(v) && v >= 1e12 && v < 1e19) {
      const s = String(v);
      if (/^[2-6]/.test(s) && luhn(s)) return "card";
    }
    return null;
  }
  const s = v.trim();
  if (!s) return null;
  if (EMAIL.test(s)) return "email";
  const ib = IBAN.exec(s);
  if (ib && ibanValid(ib[0])) return "iban";
  for (const m of s.matchAll(CARD)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && luhn(d)) return "card";
  }
  if (SSN.test(s)) return "ssn";
  if (NI.test(s)) return "ni";
  const ph = PHONE.exec(s);
  if (ph) {
    const t = ph[0].trim();
    const digits = t.replace(/\D/g, "").length;
    // not a date, not an amount with decimals
    const looksDate = dateParts(t) !== null || /^\d{4}[-./]\d{1,2}[-./]\d{1,2}/.test(t);
    if (digits >= 7 && digits <= 15 && !looksDate && !/^\d{1,3}(,\d{3})*\.\d{1,2}$/.test(s)) return "phone";
  }
  return null;
}

/** What the column name says the column holds. */
export function detectHeader(name: string): PiiKind | null {
  const n = name.toLowerCase().replace(/[_.-]+/g, " ").trim();
  if (!n) return null;
  if (/\b(dob|d o b|date of birth|birth ?date|birthday|born)\b/.test(n)) return "dob";
  if (/e ?mail/.test(n)) return "email";
  if (/\b(phone|mobile|cell|tel|telephone|fax)\b/.test(n)) return "phone";
  if (/\biban\b/.test(n)) return "iban";
  if (/\b(card|pan|credit card)\b/.test(n) && !/\b(id card|rate card|scorecard)\b/.test(n)) return "card";
  if (/\b(ssn|social security)\b/.test(n)) return "ssn";
  if (/\b(ni|nino|national insurance)\b/.test(n)) return "ni";
  if (/\b(national id|passport|tax id|tin|vat no|driver|licen[cs]e no|bank account|account no|account number|sort code|routing)\b/.test(n)) return "id";
  if (/\b(address|street|postcode|post code|zip|city|town)\b/.test(n)) return "address";
  if (/\b(account|file|sheet|company|product|item|branch|project|cost cent|department|vendor|supplier|bank|brand|model|job|role|title)\b/.test(n)) return null;
  if (/\b(name|first ?name|last ?name|surname|forename|full ?name|employee|staff|contact|payee|beneficiary|customer|client|patient|user|username)\b/.test(n)) return /\b(id|no|number|code|ref)\b/.test(n) ? "id" : "name";
  return null;
}

export interface PiiColumnScan {
  col: number;
  name: string;
  /** Values that aren't blank. */
  filled: number;
  /** From the column name. */
  byHeader: PiiKind | null;
  /** From the values: counts and a few examples per kind, most first. */
  kinds: { kind: PiiKind; count: number; examples: string[] }[];
  /** The kind the column most likely holds, or null. */
  kind: PiiKind | null;
  suggested: ProtectMethod;
}

export interface PiiScanOptions {
  examples?: number;
  /** Look at no more than this many values per column (all by default). */
  limit?: number;
  /** A column counts as holding a kind when at least this share of its values are that kind (default 0.05) or the header says so. */
  minShare?: number;
}

const SUGGEST: Record<PiiKind, ProtectMethod> = {
  email: "pseudonymise",
  phone: "mask",
  iban: "mask",
  card: "mask",
  ssn: "redact",
  ni: "redact",
  dob: "redact",
  name: "pseudonymise",
  address: "redact",
  id: "hash",
};

/** Scan each column. */
export function scanPii(columns: readonly { name: string; values: readonly Cell[] }[], opts: PiiScanOptions = {}): PiiColumnScan[] {
  const maxEx = opts.examples ?? 3;
  const minShare = opts.minShare ?? 0.05;
  return columns.map((c, col) => {
    const counts = new Map<PiiKind, { count: number; examples: string[] }>();
    let filled = 0;
    const n = Math.min(c.values.length, opts.limit ?? Infinity);
    for (let i = 0; i < n; i++) {
      const v = c.values[i];
      if (v === null || (typeof v === "string" && !v.trim())) continue;
      filled++;
      const k = detectValue(v);
      if (!k) continue;
      let e = counts.get(k);
      if (!e) counts.set(k, (e = { count: 0, examples: [] }));
      e.count++;
      const ex = String(v).trim();
      if (e.examples.length < maxEx && !e.examples.includes(ex)) e.examples.push(ex);
    }
    const kinds = [...counts.entries()].map(([kind, e]) => ({ kind, ...e })).sort((a, b) => b.count - a.count);
    const byHeader = detectHeader(c.name);
    let kind: PiiKind | null = null;
    if (kinds.length && kinds[0].count >= Math.max(1, filled * minShare)) kind = kinds[0].kind;
    else if (byHeader && filled) kind = byHeader;
    if (byHeader && kind && kinds.length && kinds[0].kind !== byHeader && kinds[0].count < filled * 0.5) kind = byHeader;
    return { col, name: c.name, filled, byHeader, kinds, kind, suggested: kind ? SUGGEST[kind] : "keep" };
  });
}

// ------------------------------------------------------------ protect --

/** Replace every letter and digit except the last `keep` with *, leaving spaces and punctuation. */
export function maskValue(v: string, keep = 4): string {
  let left = keep;
  const chars = [...v];
  for (let i = chars.length - 1; i >= 0; i--) {
    if (!/[\p{L}\p{N}]/u.test(chars[i])) continue;
    if (left > 0) left--;
    else chars[i] = "*";
  }
  return chars.join("");
}

/** Turns text into a hex digest. */
export type Hasher = (text: string) => string | Promise<string>;

/** SHA-256 of the text as hex, using the browser's (or Node's) Web Crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new Error("Hashing needs Web Crypto (crypto.subtle), which this browser doesn't offer here.");
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh random salt as hex. */
export function newSalt(bytes = 16): string {
  const a = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PREFIX: Record<PiiKind, string> = {
  email: "EMAIL",
  phone: "PHONE",
  iban: "ACCOUNT",
  card: "CARD",
  ssn: "ID",
  ni: "ID",
  dob: "DATE",
  name: "PERSON",
  address: "ADDRESS",
  id: "ID",
};

export function pseudonymPrefix(kind: PiiKind | null): string {
  return kind ? PREFIX[kind] : "VALUE";
}

/**
 * Hands out PERSON_0001-style tokens. The same value (ignoring case and
 * surrounding spaces) gets the same token under the same prefix, in every
 * column that uses that prefix.
 */
export class Pseudonymiser {
  private next = new Map<string, number>();
  private tokens = new Map<string, string>();
  readonly mapping: { prefix: string; original: string; token: string }[] = [];

  token(prefix: string, value: string): string {
    const k = prefix + "\u0000" + value.trim().toLowerCase();
    let t = this.tokens.get(k);
    if (!t) {
      const n = (this.next.get(prefix) ?? 0) + 1;
      this.next.set(prefix, n);
      t = `${prefix}_${String(n).padStart(4, "0")}`;
      this.tokens.set(k, t);
      this.mapping.push({ prefix, original: value.trim(), token: t });
    }
    return t;
  }
}

export interface ProtectColumn {
  name: string;
  values: readonly Cell[];
  method: ProtectMethod;
  /** Pseudonymise: the token prefix (default VALUE). */
  prefix?: string;
}

export interface ProtectOptions {
  /** Needed when any column is hashed. Salt it yourself (see saltedHasher). */
  hasher?: Hasher;
  /** Hex characters of the hash to keep. Default 16. */
  hashLength?: number;
  /** Characters left showing when masking. Default 4. */
  keep?: number;
  pseudonymiser?: Pseudonymiser;
}

export interface ProtectResult {
  columns: Cell[][];
  /** Original value → token, for each pseudonymised value. Keep it apart from the copy you share. */
  mapping: { column: string; original: string; token: string }[];
}

/** A hasher that puts the salt in front of each value. */
export function saltedHasher(salt: string, hash: Hasher = sha256Hex): Hasher {
  return (text) => hash(salt + "\u0000" + text);
}

/** Protect each column by its method. The input is never changed; blanks stay blank. */
export async function protectColumns(columns: readonly ProtectColumn[], opts: ProtectOptions = {}): Promise<ProtectResult> {
  const len = opts.hashLength ?? 16;
  const keep = opts.keep ?? 4;
  const ps = opts.pseudonymiser ?? new Pseudonymiser();
  const mapping: ProtectResult["mapping"] = [];
  const hashCache = new Map<string, string>();
  const out: Cell[][] = [];
  for (const c of columns) {
    const vals: Cell[] = new Array(c.values.length);
    const seen = new Set<string>();
    for (let i = 0; i < c.values.length; i++) {
      const v = c.values[i];
      const blank = v === null || (typeof v === "string" && !v.trim());
      if (c.method === "keep") {
        vals[i] = v;
        continue;
      }
      if (blank || c.method === "redact") {
        vals[i] = null;
        continue;
      }
      const s = typeof v === "string" ? v.trim() : String(v);
      if (c.method === "mask") vals[i] = maskValue(s, keep);
      else if (c.method === "hash") {
        if (!opts.hasher) throw new Error("No hasher given for a hashed column.");
        let h = hashCache.get(s);
        if (h === undefined) {
          h = (await opts.hasher(s)).slice(0, len);
          hashCache.set(s, h);
        }
        vals[i] = h;
      } else {
        const t = ps.token(c.prefix ?? "VALUE", s);
        vals[i] = t;
        const k = s.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          mapping.push({ column: c.name, original: s, token: t });
        }
      }
    }
    out.push(vals);
  }
  return { columns: out, mapping };
}
