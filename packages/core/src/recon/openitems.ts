/**
 * Open items, built on reconcile():
 *
 * - rolling last period's outstanding items forward: which cleared this
 *   period (and when), which are still open, and how old they are;
 * - open-item matching inside one account (suspense, clearing, AR / AP
 *   control): debits against credits by reference, amount and sums,
 *   leaving the open items aged;
 * - supplier / customer statement recs: our ledger against their
 *   statement, matched by document number first and then amount and date,
 *   with the differences sorted into the usual reconciling categories.
 */
import { ageing, type AgeBucket } from "../audit/strata";
import { DEFAULT_REC_SETTINGS, reconcile, toleranceFor, type RecRecord, type RecResult, type RecRule, type RecSettings } from "./match";
import { differenceItems, money, round2, type RecItem, type RecLine } from "./statement";
import { normRef } from "./text";

/**
 * reconcile() in two stages: first by reference (dates ignored), then what
 * neither side could pair by reference by amount and date and by sums,
 * with the references left out (a payment's reference rarely matches the
 * invoice's). Pairs with the same reference but different amounts stay
 * mismatched. Indexes in the result are into `a` and `b`.
 */
export function reconcileTwoStage(a: RecRecord[], b: RecRecord[], settings: Partial<RecSettings>, loose: { dateWindow: number | null; amountDate?: boolean; sum?: boolean }): RecResult {
  const r1 = reconcile(a, b, { ...settings, dateWindow: null, passes: { exact: true, tolerance: true, reference: true, fuzzy: false, amountDate: false, sum: false } });
  const leftA = r1.unmatchedA;
  const leftB = r1.unmatchedB;
  const strip = (r: RecRecord): RecRecord => {
    const { key: _key, ...rest } = r;
    return rest;
  };
  const r2 = reconcile(
    leftA.map((i) => strip(a[i])),
    leftB.map((j) => strip(b[j])),
    { ...settings, dateWindow: loose.dateWindow, passes: { exact: false, tolerance: false, reference: false, fuzzy: false, amountDate: loose.amountDate ?? true, sum: loose.sum ?? true } },
  );
  const mapA = (i: number) => leftA[i];
  const mapB = (j: number) => leftB[j];
  const unmatchedA = r2.unmatchedA.map(mapA);
  const unmatchedB = r2.unmatchedB.map(mapB);
  const flags = [...r1.flags.filter((f) => f.mismatched), ...r2.flags.map((f) => ({ ...f, a: mapA(f.a), b: mapB(f.b) }))];
  // reference typos found in stage 1 between items still unmatched
  const freeA = new Set(unmatchedA);
  const freeB = new Set(unmatchedB);
  for (const f of flags) {
    if (f.mismatched) continue;
    freeA.delete(f.a);
    freeB.delete(f.b);
  }
  for (const f of r1.flags) if (!f.mismatched && f.field === "key" && freeA.has(f.a) && freeB.has(f.b)) flags.push(f);
  return {
    ...r1,
    matches: [...r1.matches, ...r2.matches.map((m) => ({ ...m, a: m.a.map(mapA), b: m.b.map(mapB) }))],
    unmatchedA,
    unmatchedB,
    flags,
    sumCapped: r2.sumCapped.map((c) => ({ ...c, item: c.side === "A" ? mapA(c.item) : mapB(c.item) })),
    sumBudgetExhausted: r2.sumBudgetExhausted,
  };
}

const amountOf = (r: RecRecord | undefined): number => (r?.amount === undefined || !Number.isFinite(r.amount) ? NaN : r.amount);
const finiteDate = (r: RecRecord | undefined): number | null => (r?.date === undefined || !Number.isFinite(r.date) ? null : r.date);

/** Ages for items: days from each date to `asOf` and the bucket label ("" without a date). */
function ages(dates: Array<number | null>, amounts: number[], asOf: number | undefined, limits: number[] | undefined): { days: Array<number | null>; bucket: string[]; buckets: AgeBucket[] } {
  if (asOf === undefined || !Number.isFinite(asOf)) return { days: dates.map(() => null), bucket: dates.map(() => ""), buckets: [] };
  const g = ageing(dates, asOf, { limits, amounts });
  return {
    days: dates.map((_, i) => (Number.isNaN(g.rowDays[i]) ? null : g.rowDays[i])),
    bucket: dates.map((_, i) => (g.rowBucket[i] < 0 ? "" : g.buckets[g.rowBucket[i]].label)),
    buckets: g.buckets.map((b) => ({ ...b, total: round2(b.total) })),
  };
}

// ---------------------------------------------------- roll forward --

export type OutstandingStatus = "cleared" | "differs" | "open";

export interface RolledItem {
  /** index into the prior list */
  index: number;
  status: OutstandingStatus;
  /** indexes into the current list that cleared it */
  clearedBy: number[];
  rule: RecRule | null;
  /** latest date among the clearing items */
  clearedDate: number | null;
  /** days from the item's date to the clearing date */
  daysToClear: number | null;
  /** days from the item's date to the as-of date (open items) */
  age: number | null;
  bucket: string;
  stale: boolean;
  note: string;
}

export interface RollOutstandingOptions {
  /** date serial the open items are aged to (usually this period's end) */
  asOf: number;
  /** passed to reconcile(); by default dates are ignored (an item may clear weeks later) and the fuzzy pass is off */
  settings?: Partial<RecSettings>;
  /** ageing bucket ends, default 30, 60, 90 */
  limits?: number[];
  /** open items older than this many days are flagged stale (default 180, as for stale cheques) */
  staleDays?: number;
}

export interface OutstandingRoll {
  items: RolledItem[];
  /** current items used to clear prior ones (leave them out of this period's rec) */
  usedCurrent: number[];
  buckets: AgeBucket[];
  summary: {
    broughtForward: number;
    broughtForwardTotal: number;
    cleared: number;
    clearedTotal: number;
    /** cleared by an item with the same reference but a different amount */
    differs: number;
    differsTotal: number;
    open: number;
    openTotal: number;
    stale: number;
    staleTotal: number;
  };
}

/**
 * Roll last period's outstanding items forward against this period's data
 * (for a bank rec: last month's deposits in transit and unpresented cheques
 * against this month's bank statement).
 */
export function rollOutstanding(prior: RecRecord[], current: RecRecord[], opts: RollOutstandingOptions): OutstandingRoll {
  const settings: Partial<RecSettings> = { dateWindow: null, ...opts.settings, passes: { ...DEFAULT_REC_SETTINGS.passes, fuzzy: false, ...opts.settings?.passes } };
  const r = reconcileTwoStage(prior, current, settings, { dateWindow: settings.dateWindow ?? null, amountDate: settings.passes?.amountDate, sum: settings.passes?.sum });
  const staleDays = opts.staleDays ?? 180;
  const items: RolledItem[] = prior.map((_, i) => ({ index: i, status: "open", clearedBy: [], rule: null, clearedDate: null, daysToClear: null, age: null, bucket: "", stale: false, note: "" }));
  const used = new Set<number>();
  const clear = (i: number, by: number[], rule: RecRule | null, status: OutstandingStatus, note: string) => {
    const it = items[i];
    it.status = status;
    it.clearedBy = by.slice().sort((x, y) => x - y);
    it.rule = rule;
    it.note = note;
    let last: number | null = null;
    for (const j of by) {
      used.add(j);
      const d = finiteDate(current[j]);
      if (d !== null) last = Math.max(last ?? d, d);
    }
    it.clearedDate = last;
    const d0 = finiteDate(prior[i]);
    it.daysToClear = last !== null && d0 !== null ? Math.round(last - d0) : null;
  };
  for (const m of r.matches) {
    const note = m.amountDiff ? `cleared with a difference of ${money(m.amountDiff)}` : m.b.length > 1 ? `cleared by ${m.b.length} items` : m.a.length > 1 ? `cleared together with ${m.a.length - 1} other item${m.a.length > 2 ? "s" : ""}` : "";
    for (const i of m.a) clear(i, m.b, m.rule, "cleared", note);
  }
  for (const p of r.mismatched) {
    clear(p.a, [p.b], null, "differs", `same reference cleared for ${money(amountOf(current[p.b]))}: difference ${money(p.amountDiff)}`);
  }
  for (const f of r.flags) {
    if (f.mismatched || items[f.a].status !== "open") continue;
    items[f.a].note = `possible keying error against current row ${current[f.b].row}`;
  }
  const openIds = items.filter((it) => it.status === "open").map((it) => it.index);
  const ag = ages(
    openIds.map((i) => finiteDate(prior[i])),
    openIds.map((i) => amountOf(prior[i]) || 0),
    opts.asOf,
    opts.limits,
  );
  openIds.forEach((i, k) => {
    const it = items[i];
    it.age = ag.days[k];
    it.bucket = ag.bucket[k];
    it.stale = it.age !== null && it.age > staleDays;
    if (it.stale) it.note = [it.note, `older than ${staleDays} days: consider writing it back`].filter(Boolean).join("; ");
  });
  const sum = (st: (it: RolledItem) => boolean) => {
    const sel = items.filter(st);
    return [sel.length, round2(sel.reduce((t, it) => t + (amountOf(prior[it.index]) || 0), 0))] as const;
  };
  const [bf, bfT] = sum(() => true);
  const [cl, clT] = sum((it) => it.status === "cleared");
  const [df, dfT] = sum((it) => it.status === "differs");
  const [op, opT] = sum((it) => it.status === "open");
  const [stl, stlT] = sum((it) => it.stale);
  return {
    items,
    usedCurrent: [...used].sort((x, y) => x - y),
    buckets: ag.buckets,
    summary: { broughtForward: bf, broughtForwardTotal: bfT, cleared: cl, clearedTotal: clT, differs: df, differsTotal: dfT, open: op, openTotal: opT, stale: stl, staleTotal: stlT },
  };
}

// --------------------------------------------- open-item matching --

export interface OpenItemRecord extends RecRecord {
  /** what items are matched within: a customer, supplier, employee... (blank: the whole account) */
  party?: string;
}

/** "reference group": all items with one reference net to zero; "zero": an item of 0.00 clears itself */
export type OpenItemRule = RecRule | "reference group" | "zero";

export interface OpenItemGroup {
  /** 1, 2, ... */
  n: number;
  party: string;
  rule: OpenItemRule;
  /** indexes into the records */
  items: number[];
  /** what's left when the group is netted (0 unless matched within a tolerance) */
  net: number;
  /** the latest date in the group: when it cleared */
  date: number | null;
}

export interface OpenItem {
  index: number;
  party: string;
  age: number | null;
  bucket: string;
  note: string;
}

export interface OpenItemOptions {
  /** passed to reconcile() for debits against credits; by default dates are ignored and the fuzzy pass is off */
  settings?: Partial<RecSettings>;
  /** date serial to age the open items to */
  asOf?: number;
  limits?: number[];
}

export interface OpenItemResult {
  groups: OpenItemGroup[];
  open: OpenItem[];
  buckets: AgeBucket[];
  summary: {
    count: number;
    /** the account balance: every amount added up */
    balance: number;
    clearedCount: number;
    /** what the cleared groups leave (only with a tolerance) */
    clearedNet: number;
    openCount: number;
    openTotal: number;
    parties: number;
    /** parties with something open */
    openParties: number;
    /** records without an amount (left open) */
    noAmount: number;
  };
}

/**
 * Clear the items of one account against each other, within each party:
 * first whole reference groups that net to zero (an invoice and its part
 * payments), then debits against credits through reconcile() (same
 * reference, amount and date, one against a sum of several). What's left
 * is open, aged to `asOf`.
 */
export function matchOpenItems(records: OpenItemRecord[], opts: OpenItemOptions = {}): OpenItemResult {
  const s: RecSettings = {
    ...DEFAULT_REC_SETTINGS,
    dateWindow: null,
    ...opts.settings,
    flipB: true,
    passes: { ...DEFAULT_REC_SETTINGS.passes, fuzzy: false, ...opts.settings?.passes },
  };
  const byParty = new Map<string, number[]>();
  records.forEach((r, i) => {
    const p = (r.party ?? "").trim();
    const g = byParty.get(p);
    if (g) g.push(i);
    else byParty.set(p, [i]);
  });
  const groups: OpenItemGroup[] = [];
  const openIds: number[] = [];
  const notes = new Map<number, string[]>();
  const note = (i: number, t: string) => {
    const l = notes.get(i);
    if (l) l.push(t);
    else notes.set(i, [t]);
  };
  const addGroup = (party: string, rule: OpenItemRule, items: number[]) => {
    let net = 0;
    let date: number | null = null;
    for (const i of items) {
      net += amountOf(records[i]) || 0;
      const d = finiteDate(records[i]);
      if (d !== null) date = Math.max(date ?? d, d);
    }
    groups.push({ n: groups.length + 1, party, rule, items: items.slice().sort((x, y) => x - y), net: round2(net), date });
  };
  let noAmount = 0;
  for (const [party, ids] of byParty) {
    const free = new Set<number>();
    for (const i of ids) {
      const x = amountOf(records[i]);
      if (Number.isNaN(x)) {
        noAmount++;
        note(i, "no amount");
        openIds.push(i);
      } else if (Math.round(x * 100) === 0) addGroup(party, "zero", [i]);
      else free.add(i);
    }
    // 1. whole reference groups that net to zero
    const byRef = new Map<string, number[]>();
    for (const i of free) {
      const k = records[i].key ? normRef(records[i].key!, s.prefixes) : "";
      if (!k) continue;
      const g = byRef.get(k);
      if (g) g.push(i);
      else byRef.set(k, [i]);
    }
    for (const g of byRef.values()) {
      if (g.length < 2) continue;
      const vals = g.map((i) => amountOf(records[i]));
      if (!vals.some((v) => v > 0) || !vals.some((v) => v < 0)) continue;
      const total = vals.reduce((t, v) => t + v, 0);
      const big = Math.max(...vals.map(Math.abs));
      if (Math.abs(total) > toleranceFor(big, s)) continue;
      // a plain pair is left to reconcile() so it gets the exact / reference rule
      if (g.length === 2) continue;
      addGroup(party, "reference group", g);
      for (const i of g) free.delete(i);
    }
    // 2. debits against credits
    const deb = [...free].filter((i) => amountOf(records[i]) > 0);
    const cred = [...free].filter((i) => amountOf(records[i]) < 0);
    const r = reconcileTwoStage(
      deb.map((i) => records[i]),
      cred.map((i) => records[i]),
      s,
      { dateWindow: s.dateWindow, amountDate: s.passes.amountDate, sum: s.passes.sum },
    );
    for (const m of r.matches) addGroup(party, m.rule, [...m.a.map((k) => deb[k]), ...m.b.map((k) => cred[k])]);
    for (const p of r.mismatched) {
      const i = deb[p.a];
      const j = cred[p.b];
      note(i, `part settled: same reference as row ${records[j].row}, ${money(round2(amountOf(records[i]) + amountOf(records[j])))} left`);
      note(j, `same reference as row ${records[i].row}`);
    }
    for (const f of r.flags) {
      if (f.mismatched) continue;
      note(deb[f.a], `possible keying error against row ${records[cred[f.b]].row}`);
      note(cred[f.b], `possible keying error against row ${records[deb[f.a]].row}`);
    }
    for (const p of r.mismatched) openIds.push(deb[p.a], cred[p.b]);
    for (const k of r.unmatchedA) openIds.push(deb[k]);
    for (const k of r.unmatchedB) openIds.push(cred[k]);
  }
  openIds.sort((x, y) => x - y);
  const ag = ages(
    openIds.map((i) => finiteDate(records[i])),
    openIds.map((i) => amountOf(records[i]) || 0),
    opts.asOf,
    opts.limits,
  );
  const open: OpenItem[] = openIds.map((i, k) => ({ index: i, party: (records[i].party ?? "").trim(), age: ag.days[k], bucket: ag.bucket[k], note: (notes.get(i) ?? []).join("; ") }));
  const balance = round2(records.reduce((t, r) => t + (amountOf(r) || 0), 0));
  const openTotal = round2(openIds.reduce((t, i) => t + (amountOf(records[i]) || 0), 0));
  return {
    groups,
    open,
    buckets: ag.buckets,
    summary: {
      count: records.length,
      balance,
      clearedCount: groups.reduce((t, g) => t + g.items.length, 0),
      clearedNet: round2(groups.reduce((t, g) => t + g.net, 0)),
      openCount: open.length,
      openTotal,
      parties: byParty.size,
      openParties: new Set(open.map((o) => o.party)).size,
      noAmount,
    },
  };
}

// ------------------------------------- supplier / customer statements --

export interface StatementRecRecord extends RecRecord {
  /** the document type as written (Invoice, Credit note, Payment, INV, CRN...), if there's a column for it */
  type?: string;
}

export type RecDocType = "invoice" | "credit note" | "payment" | "other";

const CREDIT_RE = /\b(credit ?notes?|credit memo|cr\.? ?note|crn|cn|c\/n|credit)\b/i;
const INVOICE_RE = /\b(inv|invoices?|bills?|tax invoice|debit note|dn)\b/i;
const PAYMENT_RE = /\b(pay|payments?|paid|receipts?|remit|remittance|bacs|chq|cheque|check|transfer|wire|ach|cash|fps|faster payment|direct debit|dd|sepa)\b/i;

/**
 * What kind of document a record is: from its type column, else its
 * reference (CN123, INV-9...), else its description, else its sign
 * (`invoiceSign` is the sign invoices have, in the record's own sign).
 */
export function classifyDoc(r: StatementRecRecord, invoiceSign: 1 | -1): RecDocType {
  const t = (r.type ?? "").trim();
  if (t) {
    if (CREDIT_RE.test(t) && !/debit/i.test(t)) return "credit note";
    if (INVOICE_RE.test(t)) return "invoice";
    if (PAYMENT_RE.test(t)) return "payment";
    return "other";
  }
  const k = (r.key ?? "").trim();
  if (/^(CN|CRN|CR|CRM)[-\s#/]*\d/i.test(k)) return "credit note";
  if (/^(PAY|PMT|PYMT|CHQ|RCPT|RCT)[-\s#/]*\d/i.test(k)) return "payment";
  const x = r.text ?? "";
  if (CREDIT_RE.test(x)) return "credit note";
  if (PAYMENT_RE.test(x)) return "payment";
  if (/^(INV|IN|SI|PI)[-\s#/]*\d/i.test(k) || INVOICE_RE.test(x)) return "invoice";
  const v = amountOf(r);
  if (Number.isNaN(v) || !v) return "other";
  return Math.sign(v) === invoiceSign ? "invoice" : "payment";
}

export type StatementRecLineId = "their-invoice" | "their-credit" | "their-payment" | "their-other" | "our-invoice" | "our-credit" | "our-payment" | "our-other" | "difference";

export const STATEMENT_REC_LABEL: Record<StatementRecLineId, string> = {
  "their-invoice": "Invoices on their statement not in our ledger",
  "their-credit": "Credit notes on their statement not booked by us",
  "their-payment": "Payments on their statement not in our ledger",
  "their-other": "Other items on their statement only",
  "our-payment": "Payments in transit (in our ledger, not yet on their statement)",
  "our-invoice": "Invoices in our ledger not on their statement",
  "our-credit": "Credit notes in our ledger not on their statement",
  "our-other": "Other items in our ledger only",
  difference: "Amount differences",
};

const LINE_ORDER: StatementRecLineId[] = ["their-invoice", "their-credit", "their-payment", "their-other", "our-payment", "our-invoice", "our-credit", "our-other", "difference"];
const TYPE_KEY: Record<RecDocType, string> = { invoice: "invoice", "credit note": "credit", payment: "payment", other: "other" };

export interface StatementRecOptions {
  /** their amounts have the opposite sign to ours (default true: their invoices are debits, ours credits, or the other way round) */
  flipTheirs?: boolean;
  /** invoices are positive in our ledger (an AR ledger; usually false for an AP ledger exported debit-positive). Default true. */
  invoicesPositive?: boolean;
  /** our ledger balance, in our ledger's sign (default: our items added up) */
  ourBalance?: number;
  /** the balance on their statement, in their sign (default: their items added up) */
  theirBalance?: number;
  /** their statement date: our items dated after it are noted as cut-off */
  statementDate?: number;
  /** tolerances, prefixes, the date window for the amount and date pass (default ±7 days) */
  settings?: Partial<RecSettings>;
}

export interface StatementRecResult {
  /** +1 or −1: what our ledger's amounts are multiplied by so invoices are positive; every amount below is in that sign */
  sign: 1 | -1;
  theirBalance: number;
  lines: RecLine[];
  /** their balance taken through the lines */
  computedOurs: number;
  ourBalance: number;
  /** computed minus stated: 0 when everything is explained */
  difference: number;
  /** the matching, with indexes into ours (A) and theirs (B) */
  rec: RecResult;
  typesOurs: RecDocType[];
  typesTheirs: RecDocType[];
}

/** Guess the sign settings: their balance opposite in sign to ours means flip; our balance's sign is the invoices' sign. */
export function guessStatementSigns(ours: RecRecord[], theirs: RecRecord[]): { flipTheirs: boolean; invoicesPositive: boolean } {
  const sum = (l: RecRecord[]) => l.reduce((t, r) => t + (amountOf(r) || 0), 0);
  const so = sum(ours);
  const st = sum(theirs);
  return { flipTheirs: so && st ? Math.sign(so) !== Math.sign(st) : true, invoicesPositive: so >= 0 };
}

/**
 * Reconcile our ledger for one supplier or customer (A) with their
 * statement (B): by document number first (normalised, dates ignored),
 * then what's left by amount and date and by sums. Every amount in the
 * result is turned so invoices are positive, and the lines take their
 * balance to ours.
 */
export function statementRec(ours: StatementRecRecord[], theirs: StatementRecRecord[], opts: StatementRecOptions = {}): StatementRecResult {
  const flip = opts.flipTheirs ?? true;
  const k: 1 | -1 = opts.invoicesPositive ?? true ? 1 : -1;
  // by document number whatever the dates, then the rest by amount and date, and sums
  const rec = reconcileTwoStage(ours, theirs, { ...opts.settings, flipB: flip }, { dateWindow: opts.settings?.dateWindow === undefined ? 7 : opts.settings.dateWindow, sum: opts.settings?.passes?.sum ?? true });

  const typesOurs = ours.map((r) => classifyDoc(r, k));
  const theirInvoiceSign = (flip ? -k : k) as 1 | -1;
  const typesTheirs = theirs.map((r) => classifyDoc(r, theirInvoiceSign));
  const diffs = differenceItems(rec, ours, theirs, flip, true);
  const buckets = new Map<StatementRecLineId, RecItem[]>(LINE_ORDER.map((id) => [id, []]));
  const cutoff = (d: number | undefined) => opts.statementDate !== undefined && d !== undefined && d > opts.statementDate;
  for (const j of rec.unmatchedB) {
    if (diffs.usedB.has(j)) continue;
    const v = amountOf(theirs[j]);
    if (Number.isNaN(v)) continue;
    const ourSign = flip ? -v : v;
    buckets.get(`their-${TYPE_KEY[typesTheirs[j]]}` as StatementRecLineId)!.push({ a: [], b: [j], value: round2(-ourSign * k), note: `${typesTheirs[j]} on their statement only` });
  }
  for (const i of rec.unmatchedA) {
    if (diffs.usedA.has(i)) continue;
    const v = amountOf(ours[i]);
    if (Number.isNaN(v)) continue;
    const late = cutoff(ours[i].date);
    buckets.get(`our-${TYPE_KEY[typesOurs[i]]}` as StatementRecLineId)!.push({ a: [i], b: [], value: round2(v * k), note: `${typesOurs[i]} in our ledger only${late ? " (dated after their statement)" : ""}` });
  }
  for (const it of diffs.items) buckets.get("difference")!.push({ ...it, value: round2(it.value * k), note: it.note.replace("ledger", "ours").replace("bank", "theirs") });
  const lines: RecLine[] = LINE_ORDER.map((id) => {
    const items = buckets.get(id)!;
    return { id, label: STATEMENT_REC_LABEL[id], items, total: round2(items.reduce((t, x) => t + x.value, 0)) };
  });
  const theirStated = opts.theirBalance ?? theirs.reduce((t, r) => t + (amountOf(r) || 0), 0);
  const ourStated = opts.ourBalance ?? ours.reduce((t, r) => t + (amountOf(r) || 0), 0);
  const theirBalance = round2((flip ? -theirStated : theirStated) * k);
  const ourBalance = round2(ourStated * k);
  const computedOurs = round2(theirBalance + lines.reduce((t, l) => t + l.total, 0));
  return { sign: k, theirBalance, lines, computedOurs, ourBalance, difference: round2(computedOurs - ourBalance), rec, typesOurs, typesTheirs };
}
