/**
 * What the landing page's live demos show, computed by the real engines on
 * the sample data: the bank reconciliation (match, then the rec statement),
 * the journal entry tests and Benford. Pure, so the numbers on the page are
 * tested here, and nothing on the page is typed in by hand.
 */
import type { AuditSample, CashLine } from "../samples";
import {
  benford,
  dateToSerial,
  JE_TEST_LABEL,
  jeLines,
  KEYING_LABEL,
  reconcile,
  recStatement,
  runJeTests,
  type BenfordResult,
  type JeResult,
  type JeTestId,
  type RecRecord,
  type RecResult,
  type RecRule,
  type RecStatement,
} from "./engine";

/** "2026-10-09" as a date serial (days, as in a sheet). */
export function isoSerial(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return dateToSerial(y, m, d);
}

/** Cash lines as reconciliation records; `row` is the sheet row (row 0 is the header). */
export function recordsOf(lines: readonly CashLine[]): RecRecord[] {
  return lines.map((l, i) => ({ row: i + 1, key: l.reference || undefined, amount: l.amount, date: isoSerial(l.date), text: l.description }));
}

export const RULE_LABEL: Record<RecRule, string> = {
  exact: "Same reference and amount",
  tolerance: "Same reference, within tolerance",
  reference: "Reference written differently",
  fuzzy: "Similar description",
  "amount+date": "Amount and date",
  "one-to-many": "One to many (split)",
  "many-to-one": "Many to one (combined)",
};

export type Tone = "ok" | "warn" | "bad" | "info";

/** One line of the results list: what it is, its amount, and the cash book (a) and bank (b) lines behind it. */
export interface RecRow {
  group: "difference" | "timing" | "bank" | "matched";
  label: string;
  detail: string;
  amount: number;
  a: number[];
  b: number[];
  tone: Tone;
}

export interface BankRec {
  result: RecResult;
  a: RecRecord[];
  b: RecRecord[];
  statement: RecStatement;
  /** the hero card */
  card: {
    matchPct: number;
    matchedA: number;
    countA: number;
    matchedB: number;
    countB: number;
    splits: number;
    keying: number;
    postedTwice: number;
    leftA: number;
    leftB: number;
    difference: number;
  };
  /** the first keying error, for the "why don't these match" note */
  keyingExample: { reference: string; ledger: number; bank: number; label: string; a: number; b: number } | null;
  rows: RecRow[];
  /** what to write in each side's Note column, by line index */
  notes: { a: Map<number, { text: string; tone: Tone }>; b: Map<number, { text: string; tone: Tone }> };
}

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => (n < 0 ? `(${money(-n)})` : money(n));

/** Reconcile a cash book (A) against a bank statement (B), and build the rec statement from what's left. */
export function runBankRec(ledger: readonly CashLine[], bank: readonly CashLine[]): BankRec {
  const a = recordsOf(ledger);
  const b = recordsOf(bank);
  const result = reconcile(a, b);
  const total = (lines: readonly CashLine[]) => Math.round(lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)) / 100;
  const statement = recStatement(result, a, b, { bankBalance: total(bank), ledgerBalance: total(ledger) });
  const s = result.summary;

  const notes = { a: new Map<number, { text: string; tone: Tone }>(), b: new Map<number, { text: string; tone: Tone }>() };
  for (const m of result.matches) {
    const text = `Matched: ${RULE_LABEL[m.rule].toLowerCase()}`;
    for (const i of m.a) notes.a.set(i, { text, tone: "ok" });
    for (const j of m.b) notes.b.set(j, { text, tone: "ok" });
  }

  const rows: RecRow[] = [];
  const lineGroup: Record<string, RecRow["group"]> = { dit: "timing", outstanding: "timing", bankErrors: "difference", bankReceipts: "bank", bankPayments: "bank", ledgerErrors: "difference" };
  let keying = 0;
  let postedTwice = 0;
  let keyingExample: BankRec["keyingExample"] = null;
  for (const line of [...statement.bankLines, ...statement.ledgerLines]) {
    const group = lineGroup[line.id];
    if (!group) continue;
    for (const it of line.items) {
      let label: string;
      let detail: string;
      let tone: Tone = "warn";
      if (it.keying) {
        keying++;
        const x = a[it.a[0]];
        const y = b[it.b[0]];
        label = `${KEYING_LABEL[it.keying][0].toUpperCase()}${KEYING_LABEL[it.keying].slice(1)}`;
        detail = `${x.key ?? ""} · cash book ${money(x.amount!)}, bank ${money(y.amount!)}`;
        tone = "bad";
        keyingExample ??= { reference: x.key ?? "", ledger: x.amount!, bank: y.amount!, label: KEYING_LABEL[it.keying], a: it.a[0], b: it.b[0] };
        notes.a.set(it.a[0], { text: `${label}: bank shows ${money(y.amount!)}`, tone });
        notes.b.set(it.b[0], { text: `${label}: cash book shows ${money(x.amount!)}`, tone });
      } else if (it.duplicate) {
        postedTwice++;
        const x = a[it.a[0]];
        label = "Posted twice";
        detail = `${x.key ?? ""} · ${ledger[it.a[0]].description}`;
        tone = "bad";
        notes.a.set(it.a[0], { text: "Posted twice: reverse it", tone });
      } else if (line.id === "dit") {
        label = "Deposit in transit";
        detail = `${a[it.a[0]].key ?? ""} · ${ledger[it.a[0]].description}`;
        notes.a.set(it.a[0], { text: "Not on the bank yet", tone });
      } else if (line.id === "outstanding") {
        label = "Outstanding payment";
        detail = `${a[it.a[0]].key ?? ""} · ${ledger[it.a[0]].description}`;
        notes.a.set(it.a[0], { text: "Not through the bank yet", tone });
      } else if (line.id === "bankReceipts" || line.id === "bankPayments") {
        label = line.id === "bankReceipts" ? "Only on the bank: receipt" : "Only on the bank: payment";
        detail = bank[it.b[0]].description;
        tone = "info";
        notes.b.set(it.b[0], { text: "Not in the cash book: post it", tone });
      } else {
        label = "Difference";
        detail = it.note;
      }
      rows.push({ group, label, detail, amount: it.value, a: it.a.slice(), b: it.b.slice(), tone });
    }
  }
  // matched, the hard way: splits, reformatted references, bank-style descriptions
  const hard: RecRule[] = ["one-to-many", "many-to-one", "amount+date", "fuzzy", "reference"];
  for (const rule of hard) {
    for (const m of result.matches.filter((x) => x.rule === rule).slice(0, rule === "reference" || rule === "fuzzy" ? 2 : 3)) {
      const x = a[m.a[0]];
      const y = b[m.b[0]];
      const detail =
        m.b.length > 1
          ? `${x.key ?? ""} ${money(x.amount!)} paid in ${m.b.length} parts: ${m.b.map((j) => money(b[j].amount!)).join(" + ")}`
          : m.a.length > 1
            ? `${m.a.length} cash book lines, one bank line of ${money(y.amount!)}`
            : rule === "reference"
              ? `${x.key} in the cash book, "${y.key}" on the bank`
              : `"${ledger[m.a[0]].description}" and "${bank[m.b[0]].description}"`;
      rows.push({ group: "matched", label: RULE_LABEL[rule], detail, amount: x.amount!, a: m.a.slice(), b: m.b.slice(), tone: "ok" });
    }
  }
  const splits = s.byRule["one-to-many"] + s.byRule["many-to-one"];
  const leftA = rows.filter((r) => r.group !== "matched" && r.a.length && !r.b.length).length;
  const leftB = rows.filter((r) => r.group !== "matched" && r.b.length && !r.a.length).length;
  return {
    result,
    a,
    b,
    statement,
    card: { matchPct: Math.round(s.matchRate * 1000) / 10, matchedA: s.matchedA, countA: s.countA, matchedB: s.matchedB, countB: s.countB, splits, keying, postedTwice, leftA, leftB, difference: statement.difference },
    keyingExample,
    rows,
    notes,
  };
}

export { money, signed };

// ------------------------------------------------------------- journal --

export interface JournalTests {
  result: JeResult;
  /** test rows with something found, most entries first */
  tests: { id: JeTestId; label: string; entries: number }[];
  /** the highest-scoring entries: id, score, the tests that flagged it, and its first line (index into the sample's lines) */
  top: { id: string; score: number; flags: string[]; firstLine: number; lines: number[] }[];
  entries: number;
  lines: number;
}

export function runJournalTests(sample: AuditSample, opts: { skip?: JeTestId[] } = {}): JournalTests {
  const L = sample.lines;
  const lines = jeLines({
    entry: L.map((l) => String(l.entry)),
    date: L.map((l) => l.date),
    posted: L.map((l) => l.posted),
    user: L.map((l) => l.user),
    account: L.map((l) => String(l.account)),
    amount: L.map((l) => l.amount),
    description: L.map((l) => l.description),
    dateOrder: "dmy",
  });
  const result = runJeTests(lines, { limits: [sample.approvalLimit] });
  const skip = new Set(opts.skip ?? []);
  const tests = result.summary
    .filter((t) => !t.skipped && t.entries > 0 && !skip.has(t.test))
    .map((t) => ({ id: t.test, label: JE_TEST_LABEL[t.test], entries: t.entries }))
    .sort((x, y) => y.entries - x.entries || x.label.localeCompare(y.label));
  const top = result.ranked.slice(0, 6).map((e) => ({ id: e.id, score: e.score, flags: [...new Set(e.flags.map((f) => JE_TEST_LABEL[f.test]))], firstLine: Math.min(...e.lines), lines: e.lines.slice() }));
  return { result, tests, top, entries: result.entries.length, lines: result.lines };
}

/** Benford's first-digit test on the journal's amounts. */
export function benfordOf(sample: AuditSample): BenfordResult {
  return benford(sample.lines.map((l) => l.amount), "first");
}

export const CONFORMITY_LABEL: Record<BenfordResult["conformity"], string> = {
  close: "Close conformity",
  acceptable: "Acceptable conformity",
  marginal: "Marginal conformity",
  nonconformity: "Nonconformity",
};
