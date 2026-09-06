/**
 * Finance sample data: a bank reconciliation month, a month-end trial balance
 * pair and a journal for audit tests, plus the 100M-line ledger demo. All of
 * it is fictional and deterministic (a seed always gives the same data), and
 * each set has known problems planted in it so the tools have something to
 * find. The planted items are returned with the data, which is what the tests
 * check against.
 *
 * The app opens a sample with `sampleWorkbook(kind)`: the matching template
 * (templates.ts) with the sample data filled in. `/app.html?sample=<kind>`
 * does that on start-up (see `sampleFromUrl`).
 */
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { SyntheticSource } from "./demo";
import { EditableSource } from "./editable";
import { buildTemplate } from "./templates";
import { Workbook } from "./workbook";

export type SampleKind = "bank-rec" | "close" | "audit" | "big";

export const SAMPLES: { kind: SampleKind; title: string; summary: string }[] = [
  { kind: "bank-rec", title: "Bank reconciliation", summary: "October's cash book and bank statement, with deposits in transit, unpresented cheques, bank fees, a keying error and a duplicate posting to find." },
  { kind: "close", title: "Month-end close", summary: "This month's and last month's trial balance, mapped to report lines, with movements to explain and one account nobody mapped." },
  { kind: "audit", title: "Audit tests", summary: "A month of journal entries with duplicates, a sequence gap, weekend and late-night postings, round amounts and an entry that doesn't balance." },
  { kind: "big", title: "100M-line ledger", summary: "Ten years of a general ledger, 100 million lines, to scroll, sort and pivot." },
];

/** The company in every sample. Fictional. */
export const SAMPLE_COMPANY = "Halden & Pryce Ltd";

/** Lines in the big demo. */
export const BIG_ROWS = 100_000_000;

export function isSampleKind(x: unknown): x is SampleKind {
  return x === "bank-rec" || x === "close" || x === "audit" || x === "big";
}

/** `?sample=bank-rec` → "bank-rec"; anything else → null. */
export function sampleFromUrl(search: string): SampleKind | null {
  const v = new URLSearchParams(search).get("sample");
  return isSampleKind(v) ? v : null;
}

// ------------------------------------------------------------- helpers --

/** mulberry32: small, fast, seeded. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
/** cents, log-uniform between lo and hi (in currency units) */
function money(r: () => number, lo: number, hi: number): number {
  return Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))) * 100);
}
const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const units = (cents: number): number => cents / 100;
const fixed = (cents: number): string => (cents / 100).toFixed(2);

const CUSTOMERS = ["Morrow Retail", "Nettle & Co", "Oakridge Clinics", "Pellam Hotels", "Quarry Lane Dental", "Rowan Schools Trust", "Sable Engineering", "Thistle Foods", "Umber Studios", "Vantage Kitchens", "Wexcombe Farms", "Yarrow Health"];
const SUPPLIERS = ["Arden Office Supplies", "Brightwater Utilities", "Calder Logistics", "Dunmore Insurance", "Fenwick Consulting", "Ivel Software", "Juniper Catering", "Kestrel Print", "Larch Cleaning Co", "Mardale Freight"];

// ------------------------------------------------------ bank rec month --

export interface CashLine {
  /** yyyy-mm-dd */
  date: string;
  reference: string;
  description: string;
  /** receipts positive, payments negative */
  amount: number;
}

export type ReconcilingKind = "Deposit in transit" | "Outstanding payment" | "Bank only (fee, interest)" | "Ledger error";

/**
 * A planted reconciling item, written the way the bank rec template's
 * "Outstanding" sheet wants it: deposits in transit and outstanding payments
 * as positive amounts, bank-only items and ledger corrections signed as they
 * change the cash book.
 */
export interface ReconcilingItem {
  kind: ReconcilingKind;
  date: string;
  description: string;
  amount: number;
}

export interface BankRecSample {
  company: string;
  /** e.g. "October 2026" */
  period: string;
  ledger: CashLine[];
  bank: CashLine[];
  /** what the rec should find; matched-but-awkward items (split, reformatted references, timing) aren't listed */
  planted: ReconcilingItem[];
  openingBalance: number;
  ledgerClosing: number;
  bankClosing: number;
}

/** How a reconciling item makes the bank differ from the cash book (bank − ledger). */
export function bankMinusLedger(item: ReconcilingItem): number {
  switch (item.kind) {
    case "Deposit in transit":
      return -item.amount;
    case "Outstanding payment":
      return item.amount;
    default:
      return item.amount;
  }
}

const bankName = (s: string, cut = 18): string => s.toUpperCase().replace(/&/g, "AND").replace(/\s+/g, " ").slice(0, cut).trim();

/** One month (October 2026) of a cash book and its bank statement. */
export function bankRecSample(seed = 1): BankRecSample {
  const r = rng(seed);
  const Y = 2026;
  const M = 10;
  const ledger: (CashLine & { k: number })[] = [];
  const bank: (CashLine & { k: number })[] = [];
  let k = 0; // insertion order, to keep sorting stable
  const L = (day: number, reference: string, description: string, cents: number) => ledger.push({ date: iso(Y, M, day), reference, description, amount: units(cents), k: k++ });
  const B = (day: number, reference: string, description: string, cents: number) => bank.push({ date: iso(Y, M, Math.min(31, day)), reference, description, amount: units(cents), k: k++ });

  const opening = 8_421_055;
  L(1, "OB", "Opening balance", opening);
  B(1, "OB", "Opening balance", opening);

  let inv = 20410;
  let pay = 4410;
  let chq = 104500;
  let card = 7700;
  for (let i = 0; i < 118; i++) {
    const day = int(r, 1, 27);
    const t = r();
    if (t < 0.38) {
      // customer receipt, by bank giro credit
      const who = pick(r, CUSTOMERS);
      const cents = r() < 0.2 ? int(r, 3, 120) * 10_000 : money(r, 240, 24_000);
      const ref = `INV-${inv++}`;
      L(day, ref, `Receipt · ${who}`, cents);
      B(day + int(r, 0, 3), r() < 0.6 ? ref : ref.slice(4), `BGC ${bankName(who, 24)}`, cents);
    } else if (t < 0.72) {
      // supplier payment, by faster payment
      const who = pick(r, SUPPLIERS);
      const cents = r() < 0.15 ? int(r, 1, 40) * 10_000 : money(r, 60, 11_500);
      const ref = `PAY-${pay++}`;
      L(day, ref, `Payment · ${who}`, -cents);
      B(day + int(r, 0, 2), ref, `FPO ${bankName(who)}`, -cents);
    } else if (t < 0.84) {
      // card spend
      const who = pick(r, ["Juniper Catering", "Kestrel Print", "Arden Office Supplies", "Ivel Software", "Larch Cleaning Co"]);
      const cents = money(r, 12, 640);
      L(day, `CARD-${card++}`, `Card · ${who}`, -cents);
      B(day + int(r, 0, 2), "", `CARD PAYMENT TO ${who.toUpperCase()}`, -cents);
    } else if (t < 0.92) {
      // cheque
      const who = pick(r, SUPPLIERS);
      const cents = money(r, 90, 4_800);
      const no = chq++;
      L(day, `CHQ ${no}`, `Cheque · ${who}`, -cents);
      B(day + int(r, 1, 4), String(no), `CHQ ${no}`, -cents);
    } else {
      // direct debit, recorded in both
      const who = pick(r, ["Dunmore Insurance", "Brightwater Utilities", "Calder Logistics"]);
      const cents = money(r, 80, 2_400);
      L(day, `DD-${who.slice(0, 3).toUpperCase()}`, `Direct debit · ${who}`, -cents);
      B(day, "", `DD ${bankName(who, 22)}`, -cents);
    }
  }

  const planted: ReconcilingItem[] = [];

  // a receipt paid in two parts: matched as a split, not a reconciling item
  {
    const ref = `INV-${inv++}`;
    L(14, ref, "Receipt · Sable Engineering", 1_240_000);
    B(15, ref, "BGC SABLE ENGINEERING", 740_000);
    B(16, ref, "BGC SABLE ENGINEERING", 500_000);
  }
  // keyed wrong in the cash book: 4,725.00 for 4,752.00 (two digits swapped)
  {
    const ref = `INV-${inv++}`;
    L(9, ref, "Receipt · Thistle Foods", 472_500);
    B(10, ref, "BGC THISTLE FOODS", 475_200);
    planted.push({ kind: "Ledger error", date: iso(Y, M, 9), description: `${ref} Thistle Foods keyed as 4,725.00, bank shows 4,752.00`, amount: 27 });
  }
  // the same payment posted twice in the cash book
  {
    const ref = `PAY-${pay++}`;
    L(21, ref, "Payment · Kestrel Print", -118_000);
    L(22, ref, "Payment · Kestrel Print", -118_000);
    B(22, ref, "FPO KESTREL PRINT", -118_000);
    planted.push({ kind: "Ledger error", date: iso(Y, M, 22), description: `${ref} Kestrel Print posted twice`, amount: 1_180 });
  }
  // deposits in transit: banked on the last days, not on the statement yet
  for (const [day, who, cents] of [[30, "Rowan Schools Trust", 864_000], [31, "Oakridge Clinics", 231_540]] as const) {
    const ref = `INV-${inv++}`;
    L(day, ref, `Receipt · ${who}`, cents);
    planted.push({ kind: "Deposit in transit", date: iso(Y, M, day), description: `${ref} ${who}`, amount: units(cents) });
  }
  // unpresented cheques
  for (const [day, who, cents] of [[27, "Mardale Freight", 145_000], [29, "Fenwick Consulting", 61_275], [30, "Larch Cleaning Co", 320_000]] as const) {
    const no = chq++;
    L(day, `CHQ ${no}`, `Cheque · ${who}`, -cents);
    planted.push({ kind: "Outstanding payment", date: iso(Y, M, day), description: `CHQ ${no} ${who}`, amount: units(cents) });
  }
  // on the bank only
  for (const [day, desc, cents] of [[31, "ACCOUNT FEE OCT", -4_500], [31, "INTEREST PAID", 1_862], [18, "DD GRANITE TELECOM", -31_240]] as const) {
    B(day, "", desc, cents);
    planted.push({ kind: "Bank only (fee, interest)", date: iso(Y, M, day), description: desc, amount: units(cents) });
  }

  const order = (a: { date: string; k: number }, b: { date: string; k: number }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.k - b.k);
  ledger.sort(order);
  bank.sort(order);
  const strip = ({ k: _k, ...line }: CashLine & { k: number }): CashLine => line;
  const total = (lines: CashLine[]) => units(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0));
  const led = ledger.map(strip);
  const bnk = bank.map(strip);
  return { company: SAMPLE_COMPANY, period: "October 2026", ledger: led, bank: bnk, planted, openingBalance: units(opening), ledgerClosing: total(led), bankClosing: total(bnk) };
}

// ------------------------------------------------- month-end close (TB) --

export type AccountType = "Asset" | "Liability" | "Equity" | "Income" | "Expense";

export interface TbLine {
  code: number;
  name: string;
  debit: number;
  credit: number;
}

export interface CloseSample {
  company: string;
  period: string;
  priorPeriod: string;
  current: TbLine[];
  prior: TbLine[];
  /** code → report line and type; one account is left out on purpose */
  mapping: { code: number; line: string; type: AccountType }[];
  /** accounts whose movement should be flagged for explanation (over 10,000 and 10%) */
  planted: { code: number; why: string }[];
  /** an account in this month's TB that isn't mapped */
  unmapped: number[];
}

/** [code, name, report line, type, last month's balance (debit positive, in units)] */
const CHART: [number, string, string, AccountType, number][] = [
  [1000, "Cash at bank", "Cash", "Asset", 0], // balances the TB
  [1100, "Trade receivables", "Receivables", "Asset", 412_880.4],
  [1150, "Prepayments", "Prepayments", "Asset", 36_200],
  [1200, "Inventory", "Inventory", "Asset", 268_415.75],
  [1400, "Plant and equipment", "Fixed assets", "Asset", 940_000],
  [1500, "Accumulated depreciation", "Fixed assets", "Asset", -312_500],
  [2000, "Trade payables", "Payables", "Liability", -286_140.2],
  [2100, "Accrued expenses", "Accruals", "Liability", -64_300],
  [2200, "VAT payable", "Tax", "Liability", -48_912.6],
  [2300, "Payroll liabilities", "Accruals", "Liability", -41_075],
  [2500, "Bank loan", "Borrowings", "Liability", -350_000],
  [3000, "Share capital", "Equity", "Equity", -100_000],
  [3100, "Retained earnings", "Equity", "Equity", -737_450],
  [4000, "Product revenue", "Revenue", "Income", -612_340],
  [4100, "Service revenue", "Revenue", "Income", -148_900],
  [4900, "Interest income", "Other income", "Income", -1_215.3],
  [5000, "Cost of sales", "Cost of sales", "Expense", 351_880],
  [5100, "Freight", "Cost of sales", "Expense", 22_410.5],
  [6000, "Salaries and wages", "Staff costs", "Expense", 184_300],
  [6050, "Employer taxes", "Staff costs", "Expense", 21_940],
  [6100, "Rent", "Premises", "Expense", 28_500],
  [6200, "Utilities", "Premises", "Expense", 6_315.4],
  [6300, "Professional fees", "Professional fees", "Expense", 12_600],
  [6310, "Legal fees", "Professional fees", "Expense", 2_150],
  [6400, "Depreciation", "Depreciation", "Expense", 15_625],
  [6500, "Marketing", "Marketing", "Expense", 48_000],
  [6600, "Travel", "Other overheads", "Expense", 7_820.35],
  [6700, "Insurance", "Other overheads", "Expense", 4_250],
  [6800, "Bank charges", "Other overheads", "Expense", 515.2],
];

function tbLines(balances: Map<number, number>, names: Map<number, string>): TbLine[] {
  return [...balances.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, cents]) => ({ code, name: names.get(code)!, debit: cents > 0 ? units(cents) : 0, credit: cents < 0 ? units(-cents) : 0 }));
}

/** Balance a TB (in cents) through cash, so debits = credits exactly. */
function balanceThroughCash(b: Map<number, number>): void {
  let sum = 0;
  for (const [code, v] of b) if (code !== 1000) sum += v;
  b.set(1000, -sum);
}

/** September and October 2026 trial balances, and the mapping to report lines. */
export function closeSample(seed = 1): CloseSample {
  const r = rng(seed + 100);
  const names = new Map(CHART.map(([code, name]) => [code, name]));
  const prior = new Map<number, number>();
  for (const [code, , , , bal] of CHART) prior.set(code, Math.round(bal * 100));
  balanceThroughCash(prior);

  const current = new Map<number, number>();
  for (const [code, v] of prior) {
    // small, unremarkable movements: under 3%
    current.set(code, Math.round(v * (1 + (r() - 0.5) * 0.05)));
  }
  current.set(4000, Math.round(prior.get(4000)! * 1.09)); // a good month, but under 10%
  current.set(6310, 4_065_000); // legal fees: a dispute accrued
  current.set(2100, prior.get(2100)! - 3_850_000);
  current.set(6500, 2_150_000); // marketing campaign ended
  current.set(6420, 1_488_000); // new account, nobody mapped it
  names.set(6420, "Software subscriptions");
  balanceThroughCash(current);

  return {
    company: SAMPLE_COMPANY,
    period: "October 2026",
    priorPeriod: "September 2026",
    current: tbLines(current, names),
    prior: tbLines(prior, names),
    mapping: CHART.map(([code, , line, type]) => ({ code, line, type })),
    planted: [
      { code: 2100, why: "Accrued expenses up 38,500.00: the legal fees accrual" },
      { code: 6310, why: "Legal fees up from 2,150.00 to 40,650.00: a dispute was accrued" },
      { code: 6420, why: "Software subscriptions: a new account, not in last month's TB" },
      { code: 6500, why: "Marketing down from 48,000.00 to 21,500.00: the campaign ended" },
    ],
    unmapped: [6420],
  };
}

// --------------------------------------------------- journal (audit) --

export interface JournalLine {
  entry: number;
  /** effective date, yyyy-mm-dd */
  date: string;
  /** when it was posted, "yyyy-mm-dd hh:mm" */
  posted: string;
  user: string;
  account: number;
  description: string;
  /** debits positive, credits negative */
  amount: number;
  reference: string;
}

export type JournalFlag = "duplicate" | "gap" | "unbalanced" | "weekend" | "out of hours" | "below approval limit" | "round amount" | "keyword" | "unusual user" | "seldom-used account" | "backdated";

export interface AuditSample {
  company: string;
  period: string;
  lines: JournalLine[];
  /** entry numbers never used */
  gaps: number[];
  /** the planted findings, by entry */
  planted: { entry: number; flag: JournalFlag; why: string }[];
  /** debits − credits over the whole journal: the unbalanced entry's difference */
  outOfBalance: number;
  approvalLimit: number;
}

/** Lines in the audit sample stay under this (the template's Population sheet has 2,000 rows). */
export const AUDIT_MAX_LINES = 1_999;

/** A month (October 2026) of journal entries with red flags planted. */
export function auditSample(seed = 1): AuditSample {
  const r = rng(seed + 200);
  const lines: JournalLine[] = [];
  const planted: AuditSample["planted"] = [];
  const users = ["akhan", "bmorales", "cnguyen", "dokafor", "eschmidt"];
  const busines = [...Array(31).keys()].map((d) => d + 1).filter((d) => ![0, 6].includes(new Date(Date.UTC(2026, 9, d)).getUTCDay()));
  const hm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const workTime = () => hm(int(r, 8, 17), int(r, 0, 59));

  type Spec = { date: string; posted?: string; user?: string; lines: [number, string, number][]; ref: string };
  const add = (entry: number, s: Spec) => {
    const posted = s.posted ?? `${s.date} ${workTime()}`;
    const user = s.user ?? pick(r, users);
    for (const [account, description, cents] of s.lines) lines.push({ entry, date: s.date, posted, user, account, description, amount: units(cents), reference: s.ref });
  };

  // the ordinary run of entries
  const routine = (): Spec => {
    const date = iso(2026, 10, pick(r, busines));
    const t = r();
    if (t < 0.34) {
      const who = pick(r, CUSTOMERS);
      const net = money(r, 80, 30_000);
      const vat = Math.round(net * 0.2);
      const ref = `INV-${int(r, 20400, 21900)}`;
      return { date, ref, lines: [[1100, `Invoice ${ref} ${who}`, net + vat], [4000, `Invoice ${ref} ${who}`, -net], [2200, `VAT on ${ref}`, -vat]] };
    }
    if (t < 0.6) {
      const who = pick(r, SUPPLIERS);
      const net = money(r, 40, 18_000);
      const ref = `PI-${int(r, 8000, 8999)}`;
      return { date, ref, lines: [[pick(r, [5000, 5100, 6200, 6300, 6600, 6700]), `Purchase invoice ${ref} ${who}`, net], [2000, `Purchase invoice ${ref} ${who}`, -net]] };
    }
    if (t < 0.8) {
      const who = pick(r, CUSTOMERS);
      const c = money(r, 80, 30_000);
      return { date, ref: `RCPT-${int(r, 3000, 3999)}`, lines: [[1000, `Receipt ${who}`, c], [1100, `Receipt ${who}`, -c]] };
    }
    const who = pick(r, SUPPLIERS);
    const c = money(r, 40, 18_000);
    return { date, ref: `PAY-${int(r, 4400, 4999)}`, lines: [[2000, `Payment ${who}`, c], [1000, `Payment ${who}`, -c]] };
  };

  // the planted entries, keyed by entry number; the rest are routine
  const first = 100401;
  const count = 760;
  const gaps = [100457, 100458];
  const special = new Map<number, Spec>();
  const flag = (entry: number, f: JournalFlag, why: string, spec?: Spec) => {
    if (spec) special.set(entry, spec);
    planted.push({ entry, flag: f, why });
  };
  flag(100488, "weekend", "Dated and posted on a Saturday", { date: "2026-10-10", posted: "2026-10-10 11:04", user: "jlee", ref: "JNL-0488", lines: [[6600, "Travel reimbursement", 184_250], [2000, "Travel reimbursement", -184_250]] });
  flag(100533, "weekend", "Dated and posted on a Sunday", { date: "2026-10-18", posted: "2026-10-18 16:40", user: "jlee", ref: "JNL-0533", lines: [[6300, "Consulting accrual", 715_000], [2100, "Consulting accrual", -715_000]] });
  flag(100560, "out of hours", "Posted at 23:14", { date: "2026-10-20", posted: "2026-10-20 23:14", user: "dokafor", ref: "JNL-0560", lines: [[1200, "Stock adjustment", 1_262_000], [5000, "Stock adjustment", -1_262_000]] });
  flag(100571, "out of hours", "Posted at 05:52", { date: "2026-10-22", posted: "2026-10-22 05:52", user: "cnguyen", ref: "JNL-0571", lines: [[6200, "Utilities true-up", 96_340], [2100, "Utilities true-up", -96_340]] });
  flag(100590, "below approval limit", "9,950.00, just under the 10,000.00 approval limit", { date: "2026-10-23", user: "bmorales", ref: "JNL-0590", lines: [[6300, "Advisory fee", 995_000], [2000, "Advisory fee", -995_000]] });
  flag(100591, "below approval limit", "9,985.00 the same day, by the same user", { date: "2026-10-23", user: "bmorales", ref: "JNL-0591", lines: [[6300, "Advisory fee", 998_500], [2000, "Advisory fee", -998_500]] });
  flag(100611, "round amount", "A round 25,000.00 manual adjustment", { date: "2026-10-26", user: "eschmidt", ref: "JNL-0611", lines: [[6500, "Manual adjustment marketing", 2_500_000], [2100, "Manual adjustment marketing", -2_500_000]] });
  flag(100612, "duplicate", "Same accounts, amounts and date as 100611", { date: "2026-10-26", user: "eschmidt", ref: "JNL-0611", lines: [[6500, "Manual adjustment marketing", 2_500_000], [2100, "Manual adjustment marketing", -2_500_000]] });
  flag(100640, "keyword", "\"Plug\" and \"suspense\" in the description, to an account used once", { date: "2026-10-28", user: "akhan", ref: "JNL-0640", lines: [[9999, "Plug to suspense - misc adjustment", 1_340_000], [1100, "Plug to suspense - misc adjustment", -1_340_000]] });
  flag(100640, "seldom-used account", "9999 Suspense appears in no other entry");
  flag(100655, "keyword", "\"Reverse\" and \"correction\" in the description", { date: "2026-10-29", user: "cnguyen", ref: "JNL-0655", lines: [[2100, "Reverse accrual correction", 430_000], [6300, "Reverse accrual correction", -430_000]] });
  flag(100668, "unusual user", "The only entry by temp.admin, straight to revenue", { date: "2026-10-30", user: "temp.admin", ref: "JNL-0668", lines: [[1100, "Revenue adjustment", 5_000_000], [4000, "Revenue adjustment", -5_000_000]] });
  flag(100668, "round amount", "A round 50,000.00 to revenue");
  flag(100680, "backdated", "Dated 12 September, posted 29 October", { date: "2026-09-12", posted: "2026-10-29 10:12", user: "dokafor", ref: "JNL-0680", lines: [[6100, "Rent September", 950_000], [2000, "Rent September", -950_000]] });
  flag(100705, "unbalanced", "Debits 5,430.00, credits 5,330.00: 100.00 out", { date: "2026-10-30", user: "akhan", ref: "JNL-0705", lines: [[5100, "Freight recharge", 543_000], [2000, "Freight recharge", -533_000]] });
  for (const g of gaps) planted.push({ entry: g, flag: "gap", why: "Entry number never used" });

  for (let e = first; e < first + count; e++) {
    if (gaps.includes(e)) continue;
    add(e, special.get(e) ?? routine());
  }
  const outOfBalance = units(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0));
  return { company: SAMPLE_COMPANY, period: "October 2026", lines, gaps, planted, outOfBalance, approvalLimit: 10_000 };
}

// ------------------------------------------------------------ workbooks --

type Cell = { row: number; col: number; input: string | null };

/** Rows of values written under the header row (row 0) of a sheet. */
function rowsBelowHeader(rows: (string | number | null)[][]): Cell[] {
  return rows.flatMap((row, i) => row.map((v, col) => ({ row: i + 1, col, input: v === null ? null : String(v) })));
}

function driver(wb: Workbook) {
  const ctx: SheetCtx = { workbook: wb, activeSheet: wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  return async (sheet: string, cells: Cell[]) => {
    ctx.activeSheet = wb.byName(sheet)!.id;
    await h.run(setCells(cells), "system");
  };
}

const note = (text: string): Cell[] => [{ row: 1, col: 0, input: text }];

/**
 * A ready-to-use workbook for a sample: the matching template with the
 * sample data filled in, and the sheet to show first. For the shell:
 *
 *   const s = await sampleWorkbook("bank-rec");
 *   loadWorkbook(s.workbook, s.active, s.name);
 */
export async function sampleWorkbook(kind: SampleKind, seed = 1): Promise<{ workbook: Workbook; active: string; name: string }> {
  if (kind === "big") {
    const workbook = new Workbook({ name: "General ledger", source: new EditableSource(new SyntheticSource(BIG_ROWS), 10) });
    workbook.sheets[0].origin = "Sample data: a fictional 100M-line general ledger";
    return { workbook, active: workbook.sheets[0].id, name: "demo — 100M-line general ledger" };
  }
  const wb = await buildTemplate(kind === "bank-rec" ? "bankrec" : kind);
  const put = driver(wb);
  const intro = `Sample data for ${SAMPLE_COMPANY}, a fictional company, October 2026.`;
  if (kind === "bank-rec") {
    const s = bankRecSample(seed);
    const lines = (list: CashLine[]) => rowsBelowHeader(list.map((l) => [l.date, l.reference, l.description, fixed(Math.round(l.amount * 100)), null]));
    await put("Cash book", lines(s.ledger));
    await put("Bank statement", lines(s.bank));
    await put("Rec", [{ row: 2, col: 1, input: fixed(Math.round(s.bankClosing * 100)) }]);
    await put("Start here", note(`${intro} Step 1 is done: the cash book and the bank statement are filled in, and the statement's closing balance is on "Rec".`));
  } else if (kind === "close") {
    const s = closeSample(seed);
    const tb = (list: TbLine[]) => rowsBelowHeader(list.map((l) => [l.code, l.name, l.debit ? l.debit.toFixed(2) : null, l.credit ? l.credit.toFixed(2) : null]));
    await put("TB current", tb(s.current));
    await put("TB prior", tb(s.prior));
    await put("Mapping", rowsBelowHeader(s.mapping.map((m) => [m.code, m.line, m.type])));
    await put("Start here", note(`${intro} Steps 1 to 3 are done: both trial balances and the mapping are filled in. Look at "Flux", then run "Data checks…".`));
  } else {
    const s = auditSample(seed);
    await put("Population", rowsBelowHeader(s.lines.map((l) => [l.entry, l.date, l.posted, l.user, l.account, l.description, l.amount.toFixed(2), l.reference])));
    await put("Results", [{ row: 8, col: 1, input: `Sample journal, ${s.period} (fictional)` }]);
    await put("Start here", note(`${intro} Step 1 is done: the journal is on "Population". Approval limit: 10,000.00.`));
  }
  // filling in the sample isn't the user's work
  wb.evidence = { log: [], inputs: [] };
  const title = SAMPLES.find((x) => x.kind === kind)!.title;
  for (const sh of wb.sheets) sh.origin = `Sample data (fictional): ${title}`;
  return { workbook: wb, active: wb.sheets[0].id, name: `Sample — ${title}` };
}
