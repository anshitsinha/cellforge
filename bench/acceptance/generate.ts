/**
 * A synthetic month of bank statement lines and the matching cash book
 * (ledger) postings, modelled on what real exports look like, with a
 * planted answer key.
 *
 * Deterministic: the same seed and size give byte-identical files.
 *
 * Side A is the ledger (cash book for the bank account), side B the bank
 * statement. Both use "positive = money into the bank".
 *
 * What is planted (see CATEGORIES):
 * - exact matches (same reference string, same amount, bank 0..3 days later;
 *   cheques clear 1..6 days later)
 * - reference format differences (INV-0012345 vs 12345 / inv 0012345 / #12345 / INV12345)
 * - description-only matches (no reference on the bank line)
 * - split payments (one invoice paid in 2..4 parts: 1:N)
 * - batched deposits (2..4 receipts banked as one paying-in: N:1), with and
 *   without a paying-in slip reference
 * - duplicate ledger postings
 * - amount keying errors in the ledger (two digits swapped, one digit wrong,
 *   sign flipped) and reference typos
 * - timing items: deposits in transit and unpresented cheques (ledger only)
 * - bank-only items: fees, interest, direct debits
 *
 * The data is held column-wise in typed arrays and rendered to CSV text on
 * the fly, so the 6M-row month fits in memory.
 */

// ------------------------------------------------------------------ rng --

/** mulberry32: small, fast, good enough for test data */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a stable 0..1 hash of (id, salt), for rendering choices that don't need storing */
function h01(id: number, salt: number): number {
  let x = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 0x27d4eb2f, 0xc2b2ae35);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

// ----------------------------------------------------------- categories --

export type Category =
  | "exact"
  | "refFormat"
  | "descOnly"
  | "split"
  | "batch"
  | "batchNoRef"
  | "duplicate"
  | "transposition"
  | "slip"
  | "signFlip"
  | "keyedNoRef"
  | "refTypo"
  | "dit"
  | "unpresented"
  | "bankFee"
  | "bankInterest"
  | "directDebit";

/**
 * What should happen to a planted group:
 * - match: one match holding exactly the group's A and B items
 * - mismatch: a mismatched pair (same reference) flagged with the planted keying error
 * - flag: no reference ties them, so both stay unmatched, but the pair is flagged with the planted keying error
 * - matchOrFlag: matched, or left unmatched with the pair flagged as a reference typo
 * - unmatched: left over, and on the right line of the rec statement
 * - duplicate: the original matched to the bank, the copy left over, listed as a duplicate and
 *   shown as a ledger error on the rec statement
 */
export type Expect = "match" | "mismatch" | "flag" | "matchOrFlag" | "unmatched" | "duplicate";

export interface CategoryInfo {
  label: string;
  expect: Expect;
  /** share of events (before minimums) */
  weight: number;
  /** at least this many at any size */
  min: number;
  /** for unmatched items: the rec statement line they belong on */
  line?: "dit" | "outstanding" | "bankReceipts" | "bankPayments" | "ledgerErrors";
  /** for mismatch and flag: the keying error reconcile should report */
  keying?: "transposition" | "digit slip" | "sign flip";
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  exact: { label: "Exact (same ref, same amount)", expect: "match", weight: 0.69, min: 50 },
  refFormat: { label: "Reference format differs", expect: "match", weight: 0.1, min: 40 },
  descOnly: { label: "Description only (no bank ref)", expect: "match", weight: 0.07, min: 40 },
  split: { label: "Split payment 1:N (k=2..4)", expect: "match", weight: 0.012, min: 15 },
  batch: { label: "Batched deposit N:1 with slip ref", expect: "match", weight: 0.012, min: 15 },
  batchNoRef: { label: "Batched deposit N:1, no ref", expect: "match", weight: 0.006, min: 15 },
  duplicate: { label: "Duplicate ledger posting", expect: "duplicate", weight: 0.004, min: 10, line: "ledgerErrors" },
  transposition: { label: "Amount keyed: digits swapped", expect: "mismatch", weight: 0.004, min: 10, keying: "transposition" },
  slip: { label: "Amount keyed: one digit wrong", expect: "mismatch", weight: 0.004, min: 10, keying: "digit slip" },
  signFlip: { label: "Amount keyed: sign flipped", expect: "mismatch", weight: 0.003, min: 10, keying: "sign flip" },
  keyedNoRef: { label: "Amount keyed, no ref (digits swapped)", expect: "flag", weight: 0.003, min: 10, keying: "transposition" },
  refTypo: { label: "Reference typo (digits swapped)", expect: "matchOrFlag", weight: 0.004, min: 10 },
  dit: { label: "Deposit in transit", expect: "unmatched", weight: 0.01, min: 10, line: "dit" },
  unpresented: { label: "Unpresented cheque", expect: "unmatched", weight: 0.012, min: 10, line: "outstanding" },
  bankFee: { label: "Bank fee (bank only)", expect: "unmatched", weight: 0.02, min: 10, line: "bankPayments" },
  bankInterest: { label: "Interest (bank only)", expect: "unmatched", weight: 0.0002, min: 2, line: "bankReceipts" },
  directDebit: { label: "Direct debit (bank only)", expect: "unmatched", weight: 0.018, min: 10, line: "bankPayments" },
};

export const CATEGORY_LIST = Object.keys(CATEGORIES) as Category[];

// ------------------------------------------------------- kinds & styles --

/** what a line is: decides narrative/description templates */
const Kind = {
  Receipt: 0,
  Payment: 1,
  Cheque: 2,
  Card: 3,
  Deposit: 4,
  Fee: 5,
  Interest: 6,
  DirectDebit: 7,
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];

/** how the ledger writes the document number */
const Style = {
  Inv: 0, // INV-0012345
  Po: 1, // PO-012345
  Chq: 2, // CHQ 012345
  Trf: 3, // TRF12345
  Dep: 4, // DEP-4471
  Ddr: 5, // DDR12345 (bank only)
} as const;
type Style = (typeof Style)[keyof typeof Style];

/** how the bank shows the reference */
const Variant = {
  Same: 0, // identical to the ledger
  Bare: 1, // 12345
  Lower: 2, // inv 0012345
  Hash: 3, // #12345
  Joined: 4, // INV12345
  Padded: 5, // DEP004471
  Blank: 6,
  Typo: 7, // ledger format with two digits of the number swapped (number stored already swapped)
} as const;
type Variant = (typeof Variant)[keyof typeof Variant];

const ADJ = ["North", "South", "Blue", "Red", "Green", "Silver", "Oak", "Pine", "River", "Harbour", "Summit", "Kestrel", "Falcon", "Atlas", "Orion", "Crown", "Bridge", "Castle", "Meadow", "Granite", "Copper", "Maple", "Thames", "Pennine", "Coastal", "Union", "Premier", "Apex", "Vertex", "Willow"];
const NOUN = ["Traders", "Supplies", "Logistics", "Foods", "Engineering", "Consulting", "Media", "Systems", "Plastics", "Textiles", "Motors", "Pharma", "Holdings", "Partners", "Electrical", "Print", "Joinery", "Catering", "Security", "Software", "Metals", "Packaging", "Dental", "Farms", "Freight"];
const SUFFIX = ["Ltd", "Limited", "plc", "LLP", "& Co", "Group", "Ltd", "Ltd"];
const PAYEES: string[] = [];
// about 15,000 counterparties: a big business has thousands of customers and suppliers
const PLACE = ["", "Leeds", "Bristol", "Kent", "Cardiff", "York", "Essex", "Dundee", "Bath", "Derby", "Surrey", "Norfolk", "Exeter", "Wessex", "Mercia", "Clyde", "Tyne", "Avon", "Severn", "Solent", "Fenland"];
for (const p of PLACE) for (const a of ADJ) for (const n of NOUN) PAYEES.push(`${p ? p + " " : ""}${a} ${n} ${SUFFIX[PAYEES.length % SUFFIX.length]}`);
const UTILITIES = ["British Gas", "EDF Energy", "Thames Water", "BT Group", "Vodafone", "HMRC VAT", "Zurich Insurance", "Lex Autolease", "Sage UK", "Microsoft"];
const FEES = ["SERVICE CHARGE", "ACCOUNT FEE", "CHAPS FEE", "UNPAID ITEM FEE", "BANK CHARGES"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------- the data --

export interface SideData {
  n: number;
  /** day of the month 1..31 */
  day: Uint8Array;
  /** signed amount in cents, money into the bank positive */
  cents: Float64Array;
  /** reference number (-1: none) */
  ref: Int32Array;
  style: Uint8Array;
  /** bank only: how the reference is shown */
  variant: Uint8Array;
  payee: Uint16Array;
  kind: Uint8Array;
  /** the planted group the line belongs to */
  group: Int32Array;
}

export interface Generated {
  seed: number;
  year: number;
  month: number;
  daysInMonth: number;
  openingCents: number;
  ledger: SideData;
  bank: SideData;
  /** per group: its category (index into CATEGORY_LIST) */
  groupCat: Uint8Array;
  /** per group: how many A / B items the expected match holds */
  groupA: Uint8Array;
  groupB: Uint8Array;
  groups: number;
  /** planted events per category */
  counts: Record<Category, number>;
}

class Grow {
  day: number[] = [];
  cents: number[] = [];
  ref: number[] = [];
  style: number[] = [];
  variant: number[] = [];
  payee: number[] = [];
  kind: number[] = [];
  group: number[] = [];
  push(day: number, cents: number, ref: number, style: number, variant: number, payee: number, kind: number, group: number): number {
    this.day.push(day);
    this.cents.push(cents);
    this.ref.push(ref);
    this.style.push(style);
    this.variant.push(variant);
    this.payee.push(payee);
    this.kind.push(kind);
    this.group.push(group);
    return this.day.length - 1;
  }
  /** typed arrays, in date order (stable) */
  finish(): SideData {
    const n = this.day.length;
    const order = new Int32Array(n);
    const counts = new Int32Array(33);
    for (const d of this.day) counts[d + 1]++;
    for (let d = 1; d < 33; d++) counts[d] += counts[d - 1];
    for (let i = 0; i < n; i++) order[counts[this.day[i]]++] = i;
    const take = <T extends Uint8Array | Uint16Array | Int32Array | Float64Array>(Ctor: { new (n: number): T }, src: number[]): T => {
      const out = new Ctor(n);
      for (let k = 0; k < n; k++) out[k] = src[order[k]];
      return out;
    };
    return {
      n,
      day: take(Uint8Array, this.day),
      cents: take(Float64Array, this.cents),
      ref: take(Int32Array, this.ref),
      style: take(Uint8Array, this.style),
      variant: take(Uint8Array, this.variant),
      payee: take(Uint16Array, this.payee),
      kind: take(Uint8Array, this.kind),
      group: take(Int32Array, this.group),
    };
  }
}

export interface GenOptions {
  /** total transaction lines across both files (ledger ≈ bank ≈ rows / 2) */
  rows: number;
  seed?: number;
  year?: number;
  /** 1..12 */
  month?: number;
}

/** Generate the month. */
export function generate(opts: GenOptions): Generated {
  const seed = opts.seed ?? 20250331;
  const year = opts.year ?? 2025;
  const month = opts.month ?? 3;
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  // events per category: the bulk scales with size, small categories have a floor
  const totalW = CATEGORY_LIST.reduce((t, c) => t + CATEGORIES[c].weight, 0);
  const events = Math.max(1, Math.round(opts.rows / 2));
  const counts = {} as Record<Category, number>;
  for (const c of CATEGORY_LIST) counts[c] = Math.max(CATEGORIES[c].min, Math.round((events * CATEGORIES[c].weight) / totalW));

  const L = new Grow();
  const B = new Grow();
  const groupCat: number[] = [];
  const groupA: number[] = [];
  const groupB: number[] = [];
  let nextRef = 100_000;
  const newGroup = (c: Category, a: number, b: number) => {
    groupCat.push(CATEGORY_LIST.indexOf(c));
    groupA.push(a);
    groupB.push(b);
    return groupCat.length - 1;
  };

  /** an amount in cents: log-normal around a few hundred, some round */
  const amount = (big = false): number => {
    // Box-Muller
    const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
    let v = Math.exp((big ? 7 : 5.5) + 1.5 * z);
    v = Math.min(Math.max(v, 1.5), 2_500_000);
    const u = r();
    if (u < 0.05) return Math.max(100, Math.round(v / 100) * 100) * 100; // whole hundreds
    if (u < 0.25) return Math.max(1, Math.round(v)) * 100; // whole units
    return Math.max(101, Math.round(v * 100));
  };
  const lag = (kind: Kind): number => {
    if (kind === Kind.Cheque) return int(1, 6);
    const u = r();
    return u < 0.6 ? 0 : u < 0.85 ? 1 : u < 0.95 ? 2 : 3;
  };
  /** ledger day and bank day for a matchable item (the bank line lands inside the month) */
  const days = (kind: Kind): [number, number] => {
    const l = lag(kind);
    const d = int(1, dim - l);
    return [d, d + l];
  };
  const styleOf = (kind: Kind): Style => (kind === Kind.Receipt ? Style.Inv : kind === Kind.Payment ? Style.Po : kind === Kind.Cheque ? Style.Chq : kind === Kind.Deposit ? Style.Dep : Style.Trf);
  const signOf = (kind: Kind) => (kind === Kind.Receipt || kind === Kind.Deposit || kind === Kind.Interest ? 1 : -1);
  const tradeKind = (): Kind => {
    const u = r();
    return u < 0.4 ? Kind.Receipt : u < 0.75 ? Kind.Payment : u < 0.85 ? Kind.Cheque : Kind.Card;
  };
  /** one ledger line and one bank line for the same thing */
  const pair = (c: Category, kind: Kind, variant: Variant, ledgerCents?: (x: number) => number, bankRef?: (n: number) => number) => {
    const g = newGroup(c, 1, 1);
    const [dl, db] = days(kind);
    let x = signOf(kind) * amount();
    let lx = ledgerCents ? ledgerCents(x) : x;
    while (Number.isNaN(lx)) {
      x = signOf(kind) * amount();
      lx = ledgerCents!(x);
    }
    const ref = bankRef ? typoRef() : nextRef++;
    const payee = Math.floor(r() * PAYEES.length);
    L.push(dl, lx, ref, styleOf(kind), 0, payee, kind, g);
    B.push(db, x, bankRef ? bankRef(ref) : ref, styleOf(kind), variant, payee, kind, g);
    return g;
  };

  for (let k = 0; k < counts.exact; k++) pair("exact", tradeKind(), Variant.Same);
  for (let k = 0; k < counts.refFormat; k++) {
    const kind = pick([Kind.Receipt, Kind.Receipt, Kind.Payment, Kind.Cheque]);
    pair("refFormat", kind, kind === Kind.Cheque ? Variant.Bare : pick([Variant.Bare, Variant.Lower, Variant.Hash, Variant.Joined]));
  }
  for (let k = 0; k < counts.descOnly; k++) pair("descOnly", pick([Kind.Receipt, Kind.Payment, Kind.Card]), Variant.Blank);
  for (let k = 0; k < counts.transposition; k++) {
    pair("transposition", pick([Kind.Receipt, Kind.Payment]), Variant.Same, (x) => keyTransposed(x, r));
    // (keyTransposed gives NaN for amounts with no two different neighbouring digits; pair() draws another)
  }
  for (let k = 0; k < counts.slip; k++) pair("slip", pick([Kind.Receipt, Kind.Payment]), Variant.Same, (x) => keySlipped(x, r));
  for (let k = 0; k < counts.signFlip; k++) pair("signFlip", pick([Kind.Receipt, Kind.Payment]), Variant.Same, (x) => -x);
  for (let k = 0; k < counts.keyedNoRef; k++) pair("keyedNoRef", pick([Kind.Receipt, Kind.Payment]), Variant.Blank, (x) => keyTransposed(x, r));
  // reference typos get numbers from their own range (9,000,000+), so the typo can't be another item's reference
  const typos = new Set<number>();
  const typoRef = () => {
    for (;;) {
      const n = 9_000_000 + Math.floor(r() * 1_000_000);
      if (!typos.has(n)) {
        typos.add(n);
        return n;
      }
    }
  };
  for (let k = 0; k < counts.refTypo; k++)
    pair("refTypo", pick([Kind.Receipt, Kind.Payment]), Variant.Typo, (x) => x, (n) => {
      for (;;) {
        const t = swapDigits(n, r);
        if (t !== n && !typos.has(t)) {
          typos.add(t);
          return t;
        }
      }
    });

  // duplicates: the ledger has the same posting twice
  for (let k = 0; k < counts.duplicate; k++) {
    const kind = pick([Kind.Receipt, Kind.Payment]);
    const g = newGroup("duplicate", 1, 1);
    const [dl, db] = days(kind);
    const x = signOf(kind) * amount();
    const ref = nextRef++;
    const payee = Math.floor(r() * PAYEES.length);
    L.push(dl, x, ref, styleOf(kind), 0, payee, kind, g);
    L.push(dl, x, ref, styleOf(kind), 0, payee, kind, g);
    B.push(db, x, ref, styleOf(kind), Variant.Same, payee, kind, g);
  }

  // split payments: one invoice in the ledger, paid in k = 2..4 parts on the bank
  for (let k = 0; k < counts.split; k++) {
    const parts = 2 + (k % 3);
    const g = newGroup("split", 1, parts);
    const dl = int(1, dim - 3);
    const ref = nextRef++;
    const payee = Math.floor(r() * PAYEES.length);
    const shares = splitCents(amount(true) + parts * 1000, parts, r);
    const total = shares.reduce((t, v) => t + v, 0);
    const variant = pick([Variant.Same, Variant.Bare, Variant.Lower]);
    L.push(dl, total, ref, Style.Inv, 0, payee, Kind.Receipt, g);
    for (const v of shares) B.push(dl + int(0, 3), v, ref, Style.Inv, variant, payee, Kind.Receipt, g);
  }

  // batched deposits: k = 2..4 receipts banked together
  const batch = (c: "batch" | "batchNoRef", k: number) => {
    const parts = 2 + (k % 3);
    const g = newGroup(c, parts, 1);
    const db = int(2, dim);
    const slip = nextRef++;
    let total = 0;
    for (let p = 0; p < parts; p++) {
      const x = amount();
      total += x;
      const dl = Math.max(1, db - int(0, 2));
      if (c === "batch") L.push(dl, x, slip, Style.Dep, 0, Math.floor(r() * PAYEES.length), Kind.Deposit, g);
      else L.push(dl, x, nextRef++, Style.Inv, 0, Math.floor(r() * PAYEES.length), Kind.Receipt, g);
    }
    B.push(db, total, c === "batch" ? slip : -1, Style.Dep, c === "batch" ? Variant.Padded : Variant.Blank, 0, Kind.Deposit, g);
  };
  for (let k = 0; k < counts.batch; k++) batch("batch", k);
  for (let k = 0; k < counts.batchNoRef; k++) batch("batchNoRef", k);

  // timing: receipts at month end not yet on the bank; cheques not yet presented
  for (let k = 0; k < counts.dit; k++) {
    const g = newGroup("dit", 0, 0);
    L.push(int(dim - 2, dim), amount(), nextRef++, Style.Inv, 0, Math.floor(r() * PAYEES.length), Kind.Receipt, g);
  }
  for (let k = 0; k < counts.unpresented; k++) {
    const g = newGroup("unpresented", 0, 0);
    L.push(int(Math.max(1, dim - 12), dim), -amount(), nextRef++, Style.Chq, 0, Math.floor(r() * PAYEES.length), Kind.Cheque, g);
  }

  // bank only
  for (let k = 0; k < counts.bankFee; k++) {
    const g = newGroup("bankFee", 0, 0);
    const fee = pick([500, 750, 1000, 1250, 1500, 2500, 3000, 3500]) + (r() < 0.3 ? int(1, 99) : 0);
    B.push(int(1, dim), -fee, -1, Style.Trf, Variant.Blank, Math.floor(r() * FEES.length), Kind.Fee, g);
  }
  for (let k = 0; k < counts.bankInterest; k++) {
    const g = newGroup("bankInterest", 0, 0);
    B.push(dim, int(150, 90_000), -1, Style.Trf, Variant.Blank, 0, Kind.Interest, g);
  }
  for (let k = 0; k < counts.directDebit; k++) {
    const g = newGroup("directDebit", 0, 0);
    B.push(int(1, dim), -amount(), nextRef++, Style.Ddr, Variant.Same, Math.floor(r() * UTILITIES.length), Kind.DirectDebit, g);
  }

  const ledger = L.finish();
  const bank = B.finish();
  return {
    seed,
    year,
    month,
    daysInMonth: dim,
    openingCents: 125_000_000,
    ledger,
    bank,
    groupCat: Uint8Array.from(groupCat),
    groupA: Uint8Array.from(groupA),
    groupB: Uint8Array.from(groupB),
    groups: groupCat.length,
    counts,
  };
}

// ------------------------------------------------------- keying errors --

/** two neighbouring digits of the amount swapped */
function keyTransposed(x: number, r: () => number): number {
  const s = String(Math.abs(x));
  const spots: number[] = [];
  for (let i = 0; i + 1 < s.length; i++) if (s[i] !== s[i + 1] && !(i === 0 && s[1] === "0")) spots.push(i);
  if (!spots.length) return NaN;
  const i = spots[Math.floor(r() * spots.length)];
  return Math.sign(x) * Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
}

/** one digit of the amount wrong */
function keySlipped(x: number, r: () => number): number {
  const s = String(Math.abs(x));
  const i = Math.floor(r() * s.length);
  let d = Math.floor(r() * 10);
  if (String(d) === s[i] || (i === 0 && d === 0)) d = ((Number(s[i]) + 1 + (i === 0 && s[i] === "9" ? 1 : 0)) % 10) || 1;
  return Math.sign(x) * Number(s.slice(0, i) + d + s.slice(i + 1));
}

/** a reference number with two neighbouring (different) digits swapped */
function swapDigits(n: number, r: () => number): number {
  const s = String(n);
  const spots: number[] = [];
  for (let i = 1; i + 1 < s.length; i++) if (s[i] !== s[i + 1]) spots.push(i);
  if (!spots.length) return n + 1;
  const i = spots[Math.floor(r() * spots.length)];
  return Number(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2));
}

/** a total cut into k positive parts, none of them tiny */
function splitCents(total: number, k: number, r: () => number): number[] {
  const w = Array.from({ length: k }, () => 0.3 + r());
  const sw = w.reduce((t, v) => t + v, 0);
  const out = w.map((v) => Math.max(100, Math.round((total * v) / sw)));
  out[k - 1] = total - out.slice(0, k - 1).reduce((t, v) => t + v, 0);
  if (out[k - 1] < 100) return splitCents(total + 1000, k, r);
  return out;
}

// --------------------------------------------------------------- render --

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const two = (n: number) => pad(n, 2);

/** the ledger's document number */
export function ledgerRef(style: number, n: number): string {
  switch (style as Style) {
    case Style.Inv:
      return `INV-${pad(n, 7)}`;
    case Style.Po:
      return `PO-${pad(n, 6)}`;
    case Style.Chq:
      return `CHQ ${pad(n, 6)}`;
    case Style.Dep:
      return `DEP-${n}`;
    case Style.Ddr:
      return `DDR${n}`;
    default:
      return `TRF${n}`;
  }
}

/** the reference as the bank shows it */
export function bankRef(style: number, variant: number, n: number): string {
  if (n < 0) return "";
  const full = ledgerRef(style, n);
  switch (variant as Variant) {
    case Variant.Same:
    case Variant.Typo:
      return full;
    case Variant.Bare:
      return String(n);
    case Variant.Lower:
      return full.replace(/[-\s]+/, " ").toLowerCase();
    case Variant.Hash:
      return `#${n}`;
    case Variant.Joined:
      return full.replace(/[-\s]+/, "").replace(/(\D)0+/, "$1");
    case Variant.Padded:
      return `DEP${pad(n, 9)}`;
    default:
      return "";
  }
}

const upper = (name: string, id: number) => {
  let s = name.toUpperCase().replace(/&/g, "AND");
  if (h01(id, 7) < 0.4) s = s.replace(/\s+(LTD|LIMITED|PLC|LLP|AND CO|GROUP)$/, "");
  if (h01(id, 8) < 0.3) s = s.slice(0, 18).trim();
  return s;
};

/** the ledger narrative */
export function ledgerText(sd: SideData, i: number): string {
  const p = PAYEES[sd.payee[i]];
  const u = h01(i, 1);
  switch (sd.kind[i] as Kind) {
    case Kind.Receipt:
      return u < 0.4 ? `Receipt - ${p}` : u < 0.7 ? `${p} - payment received` : `Customer receipt, ${p}`;
    case Kind.Payment:
      return u < 0.5 ? `Payment to ${p}` : `${p} - supplier payment`;
    case Kind.Cheque:
      return `Cheque ${pad(sd.ref[i], 6)} ${p}`;
    case Kind.Card:
      return `Card - ${p}`;
    case Kind.Deposit:
      return `Cheque received ${p}`;
    default:
      return p;
  }
}

/** the bank description */
export function bankText(sd: SideData, j: number, dayText: string): string {
  const u = h01(j, 2);
  const kind = sd.kind[j] as Kind;
  switch (kind) {
    case Kind.Receipt: {
      const p = upper(PAYEES[sd.payee[j]], j);
      return u < 0.4 ? `BGC ${p}` : u < 0.8 ? `FASTER PAYMENT RECEIVED ${p}` : `${p} CREDIT`;
    }
    case Kind.Payment: {
      const p = upper(PAYEES[sd.payee[j]], j);
      return u < 0.4 ? `FPO ${p}` : u < 0.8 ? `BACS ${p}` : `${p} BP`;
    }
    case Kind.Cheque:
      return `CHEQUE ${pad(sd.ref[j], 6)}`;
    case Kind.Card:
      return `CARD PAYMENT TO ${upper(PAYEES[sd.payee[j]], j)} ON ${dayText}`;
    case Kind.Deposit:
      return sd.ref[j] >= 0 ? "PAYING IN SLIP" : u < 0.5 ? "COUNTER CREDIT" : "CHEQUE DEPOSIT";
    case Kind.Fee:
      return FEES[sd.payee[j] % FEES.length];
    case Kind.Interest:
      return "CREDIT INTEREST";
    default:
      return `DD ${UTILITIES[sd.payee[j] % UTILITIES.length].toUpperCase()}`;
  }
}

/** 1,234.56 */
function money(cents: number): string {
  const c = Math.abs(Math.round(cents));
  const whole = Math.floor(c / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${two(c % 100)}`;
}

/** an amount the way GL exports write them: (1,234.56), -1234.56 or 1,234.56- */
function ledgerMoney(cents: number, id: number): string {
  const u = h01(id, 3);
  if (u < 0.7) return cents < 0 ? `(${money(cents)})` : money(cents);
  if (u < 0.9) return (cents < 0 ? "-" : "") + (Math.abs(cents) / 100).toFixed(2);
  return money(cents) + (cents < 0 ? "-" : "");
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvRow = (cells: string[]) => cells.map(csvCell).join(",");

export interface CsvOut {
  /** for each line of the file (as CsvParser returns rows): the side's row id, or -1 for lines that aren't transactions */
  lineToId: Int32Array;
  lines: number;
}

/** Write the ledger (GL detail report for the bank account) as CSV, in chunks. */
export function writeLedgerCsv(g: Generated, emit: (chunk: string) => void, perPage = 60): CsvOut {
  const sd = g.ledger;
  const { year, month } = g;
  const dmy = (d: number) => `${two(d)}/${two(month)}/${year}`;
  const dateText = (d: number, id: number) => {
    const u = h01(id, 4);
    if (u < 0.8) return dmy(d);
    if (u < 0.9) return `${year}-${two(month)}-${two(d)}`;
    return `${d}-${MON[month - 1]}-${String(year).slice(2)}`;
  };
  const W = 5;
  const blank = ",".repeat(W - 1);
  const header = csvRow(["Date", "Doc No", "Narrative", "Amount", "Balance"]);
  // pages: data lines plus one subtotal per day present
  let daysPresent = 0;
  for (let i = 0; i < sd.n; i++) if (i === 0 || sd.day[i] !== sd.day[i - 1]) daysPresent++;
  const pages = Math.max(1, Math.ceil((sd.n + daysPresent + 2) / perPage));
  const lineToId: number[] = [];
  let buf: string[] = [];
  let size = 0;
  const out = (line: string, id = -1) => {
    buf.push(line);
    lineToId.push(id);
    size += line.length + 1;
    if (size > 1 << 16) flush();
  };
  const flush = () => {
    if (buf.length) emit(buf.join("\n") + "\n");
    buf = [];
    size = 0;
  };
  let onPage = 0;
  let page = 1;
  const bodyLine = (line: string, id = -1) => {
    if (onPage === perPage) {
      out(blank);
      out(csvRow([`Page ${page} of ${pages}`]) + ",".repeat(W - 1));
      page++;
      out(header);
      onPage = 0;
    }
    out(line, id);
    onPage++;
  };
  out(csvRow(["ACME HOLDINGS LTD"]) + ",".repeat(W - 1));
  out(csvRow(["General ledger detail - 1200 Bank current account"]) + ",".repeat(W - 1));
  out(csvRow([`Period: 01/${two(month)}/${year} to ${g.daysInMonth}/${two(month)}/${year}`]) + ",".repeat(W - 1));
  out(csvRow([`Printed 01/${two(month % 12 + 1)}/${year} 09:14 by jsmith`]) + ",".repeat(W - 1));
  out(blank);
  out(header);
  let bal = g.openingCents;
  bodyLine(csvRow(["", "", "Opening balance", "", money(bal)]));
  let dayTotal = 0;
  for (let i = 0; i < sd.n; i++) {
    bal += sd.cents[i];
    dayTotal += sd.cents[i];
    bodyLine(csvRow([dateText(sd.day[i], i), ledgerRef(sd.style[i], sd.ref[i]), ledgerText(sd, i), ledgerMoney(sd.cents[i], i), (bal < 0 ? "-" : "") + money(bal)]), i);
    if (i + 1 === sd.n || sd.day[i + 1] !== sd.day[i]) {
      bodyLine(csvRow(["", "", `Total for ${dmy(sd.day[i])}`, ledgerMoney(dayTotal, i + 7), ""]));
      dayTotal = 0;
    }
  }
  bodyLine(csvRow(["", "", "Closing balance", "", (bal < 0 ? "-" : "") + money(bal)]));
  out(blank);
  out(csvRow([`Page ${page} of ${pages}`]) + ",".repeat(W - 1));
  out(csvRow(["End of report"]) + ",".repeat(W - 1));
  flush();
  return { lineToId: Int32Array.from(lineToId), lines: lineToId.length };
}

/** Write the bank statement export as CSV, in chunks. */
export function writeBankCsv(g: Generated, emit: (chunk: string) => void, perPage = 45): CsvOut {
  const sd = g.bank;
  const { year, month } = g;
  const mon = MON[month - 1];
  const dateText = (d: number, id: number) => (h01(id, 5) < 0.85 ? `${two(d)} ${mon} ${year}` : `${two(d)}/${two(month)}/${year}`);
  const W = 6;
  const blank = ",".repeat(W - 1);
  const header = csvRow(["Date", "Description", "Reference", "Paid out", "Paid in", "Balance"]);
  const lineToId: number[] = [];
  let buf: string[] = [];
  let size = 0;
  const out = (line: string, id = -1) => {
    buf.push(line);
    lineToId.push(id);
    size += line.length + 1;
    if (size > 1 << 16) flush();
  };
  const flush = () => {
    if (buf.length) emit(buf.join("\n") + "\n");
    buf = [];
    size = 0;
  };
  const balText = (c: number) => (c < 0 ? "-" : "") + money(c);
  out(csvRow(["Northbank plc"]) + ",".repeat(W - 1));
  out(csvRow(["Business current account statement"]) + ",".repeat(W - 1));
  out(csvRow(["Account 12345678  Sort code 20-00-00"]) + ",".repeat(W - 1));
  out(csvRow([`Statement period 01 ${mon} ${year} to ${g.daysInMonth} ${mon} ${year}`]) + ",".repeat(W - 1));
  out(blank);
  out(header);
  let bal = g.openingCents;
  out(csvRow([`01 ${mon} ${year}`, "BALANCE BROUGHT FORWARD", "", "", "", balText(bal)]));
  let onPage = 0;
  let page = 1;
  for (let j = 0; j < sd.n; j++) {
    if (onPage === perPage) {
      const d = `${two(sd.day[j - 1])} ${mon} ${year}`;
      out(csvRow([d, "BALANCE CARRIED FORWARD", "", "", "", balText(bal)]));
      out(blank);
      out(csvRow([`Page ${page}`]) + ",".repeat(W - 1));
      page++;
      out(header);
      out(csvRow([d, "BALANCE BROUGHT FORWARD", "", "", "", balText(bal)]));
      onPage = 0;
    }
    const c = sd.cents[j];
    bal += c;
    const dt = dateText(sd.day[j], j);
    out(csvRow([dt, bankText(sd, j, `${two(sd.day[j])}${mon.toUpperCase()}`), bankRef(sd.style[j], sd.variant[j], sd.ref[j]), c < 0 ? money(c) : "", c > 0 ? money(c) : "", balText(bal)]), j);
    onPage++;
  }
  out(csvRow([`${g.daysInMonth} ${mon} ${year}`, "CLOSING BALANCE", "", "", "", balText(bal)]));
  out(blank);
  out(csvRow([`Page ${page}`]) + ",".repeat(W - 1));
  flush();
  return { lineToId: Int32Array.from(lineToId), lines: lineToId.length };
}

/** Closing balances in cents: ledger = opening + all postings, bank = opening + all lines. */
export function closingCents(g: Generated): { ledger: number; bank: number } {
  let l = g.openingCents;
  let b = g.openingCents;
  for (let i = 0; i < g.ledger.n; i++) l += g.ledger.cents[i];
  for (let j = 0; j < g.bank.n; j++) b += g.bank.cents[j];
  return { ledger: l, bank: b };
}

/** Both files as strings (fine at test sizes). */
export function toCsv(g: Generated): { ledger: string; bank: string; ledgerOut: CsvOut; bankOut: CsvOut } {
  const lp: string[] = [];
  const bp: string[] = [];
  const ledgerOut = writeLedgerCsv(g, (c) => lp.push(c));
  const bankOut = writeBankCsv(g, (c) => bp.push(c));
  return { ledger: lp.join(""), bank: bp.join(""), ledgerOut, bankOut };
}
