/**
 * The acceptance pipeline, run the way a user would: two CSV exports →
 * parse → unwrap the printed report (titles, subtotals, page footers,
 * repeated headers) → profile each column and read dates and amounts →
 * reconcile with default settings → bank rec statement; then everything is
 * scored against the generator's answer key.
 *
 * Shared by packages/core/test/acceptance.test.ts (6K rows) and
 * bench/acceptance/run.ts (any size, with timings and memory).
 */
import { columnsToLines, parseStatement } from "../../packages/core/src/clean/bank";
import { ColumnCollector, tableRow, unwrapColumns, type ColumnTable, type UnwrappedColumns } from "../../packages/core/src/clean/unwrap";
import { parseAs, parseNumberLoose, profileColumn, type ColumnProfile } from "../../packages/core/src/clean/values";
import { CsvParser } from "../../packages/core/src/csv";
import { reconcile, REC_RULES, type RecRecord, type RecResult, type RecRule } from "../../packages/core/src/recon/match";
import { recStatement, type RecStatement } from "../../packages/core/src/recon/statement";
import { CATEGORIES, CATEGORY_LIST, closingCents, generate, writeBankCsv, writeLedgerCsv, type Category, type GenOptions, type Generated } from "./generate";

export interface Stage {
  name: string;
  ms: number;
  /** heap used and resident set after the stage, MB */
  heapMB: number;
  rssMB: number;
}

/** minimum recall per planted category */
export const RECALL_THRESHOLD: Record<Category, number> = {
  exact: 0.99,
  refFormat: 0.95,
  descOnly: 0.95,
  split: 1,
  batch: 1,
  batchNoRef: 0.9,
  duplicate: 1,
  transposition: 1,
  slip: 1,
  signFlip: 1,
  keyedNoRef: 0.95,
  refTypo: 0.95,
  dit: 0.99,
  unpresented: 0.99,
  bankFee: 0.99,
  bankInterest: 1,
  directDebit: 0.99,
};

/** minimum precision of the matches each rule makes (rules with no matches pass) */
export const PRECISION_THRESHOLD = 0.99;

export interface CategoryScore {
  category: Category;
  planted: number;
  found: number;
  recall: number;
  threshold: number;
}

export interface RuleScore {
  rule: RecRule;
  matches: number;
  correct: number;
  precision: number;
}

export interface AcceptanceReport {
  rows: number;
  ledgerLines: number;
  bankLines: number;
  stages: Stage[];
  peakRssMB: number;
  categories: CategoryScore[];
  /** recall of 1:N splits by number of parts */
  splitByK: Record<number, { planted: number; found: number }>;
  rules: RuleScore[];
  /** wrong: matches that don't equal a planted group */
  wrongMatches: number;
  /** of the wrong matches: one-to-one pairs of a line and a line for the same party, same amount and kind (planted for two different events, but nothing in the data tells them apart) */
  interchangeable: number;
  /** flags (keying errors) that don't belong to a planted keying error */
  falseFlags: number;
  flags: number;
  /** duplicate groups that aren't planted duplicates */
  falseDuplicates: number;
  duplicates: number;
  /** planted groups that weren't found, by category (group ids, for digging in) */
  missed: Partial<Record<Category, number[]>>;
  /** clean-up: records that aren't transactions (leaked titles, totals...) and transactions that went missing */
  junkRecords: { ledger: number; bank: number };
  lostLines: { ledger: number; bank: number };
  /** column profiles: the type chosen for each column */
  profiles: { ledger: Record<string, string>; bank: Record<string, string> };
  /** values in date/amount columns that couldn't be read */
  unreadable: { ledger: number; bank: number };
  statement: { difference: number; adjustedBank: number; adjustedLedger: number; bankBalance: number; ledgerBalance: number };
  /** bank statement check from parseStatement */
  bankCheck: { transactions: number; breaks: number; closingMatches: boolean | null } | null;
  matchRate: number;
  sumBudgetExhausted: boolean;
}

export interface RunOptions extends GenOptions {
  /** run parseStatement over the bank file (running-balance check); default true */
  statementCheck?: boolean;
  /** called after each stage (for progress output) */
  onStage?: (s: Stage) => void;
  /** called with everything the pipeline produced, before scoring (for digging into misses) */
  inspect?: (x: { g: Generated; r: RecResult; st: RecStatement; ledger: RecRecord[]; bank: RecRecord[]; idA: Int32Array; idB: Int32Array }) => void;
}

const mb = (n: number) => Math.round((n / 1048576) * 10) / 10;

/** Generate, run the whole pipeline and score it. */
export function runAcceptance(opts: RunOptions): AcceptanceReport {
  const stages: Stage[] = [];
  const stage = <T>(name: string, fn: () => T): T => {
    const t = performance.now();
    const out = fn();
    const ms = Math.round(performance.now() - t);
    const m = process.memoryUsage();
    const s: Stage = { name, ms, heapMB: mb(m.heapUsed), rssMB: mb(m.rss) };
    stages.push(s);
    opts.onStage?.(s);
    return out;
  };

  // 1. the month and its two exports
  const g = stage("generate month", () => generate(opts));
  const ledgerChunks: string[] = [];
  const bankChunks: string[] = [];
  const { ledgerOut, bankOut } = stage("write CSV exports", () => ({
    ledgerOut: writeLedgerCsv(g, (c) => ledgerChunks.push(c)),
    bankOut: writeBankCsv(g, (c) => bankChunks.push(c)),
  }));

  // 2. parse (streamed in chunks, as a file is read), kept as columns the way the app keeps a sheet
  const parse = (chunks: string[]) => {
    const table = new ColumnCollector();
    const p = new CsvParser((r) => table.add(r));
    for (let k = 0; k < chunks.length; k++) {
      p.push(chunks[k]);
      chunks[k] = "";
    }
    p.end();
    return table;
  };
  const parsed = stage("parse CSV", () => ({ ledger: parse(ledgerChunks), bank: parse(bankChunks) }));
  const ledgerRows: ColumnTable = parsed.ledger;
  const bankRows: ColumnTable = parsed.bank;

  // bank statement running-balance check (the bank module on the same rows)
  let bankCheck: AcceptanceReport["bankCheck"] = null;
  if (opts.statementCheck !== false) {
    bankCheck = stage("bank statement check", () => {
      const st = parseStatement(columnsToLines(bankRows));
      return { transactions: st.transactions.length, breaks: st.breaks, closingMatches: st.closingMatches };
    });
  }

  // the balances the user reads off the two reports
  const closingRow = (t: ColumnTable, label: RegExp, col: number) => {
    for (let r = t.rows - 1; r >= 0; r--) {
      const row = tableRow(t, r);
      if (row.some((c) => label.test(c))) return parseNumberLoose(row[col] ?? "") ?? NaN;
    }
    return NaN;
  };
  const ledgerBalance = closingRow(ledgerRows, /^closing balance$/i, 4);
  const bankBalance = closingRow(bankRows, /^closing balance$/i, 5);

  // 3. unwrap the printed reports (column by column, compacting the parsed columns in place)
  const { lu, bu } = stage("unwrap reports", () => ({ lu: unwrapColumns(ledgerRows), bu: unwrapColumns(bankRows) }));

  // 4. profile the columns and read the values
  const read = (u: UnwrappedColumns) => {
    const profiles: ColumnProfile[] = u.header.map((_, c) => profileColumn(u.columns[c]));
    return profiles;
  };
  const { lp, bp } = stage("profile columns", () => ({ lp: read(lu), bp: read(bu) }));
  const col = (u: UnwrappedColumns, name: string) => u.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const profileNames = (u: UnwrappedColumns, ps: ColumnProfile[]) => Object.fromEntries(u.header.map((h, c) => [h, ps[c].type]));

  // 5. records, as the reconcile dialog reads them: key, amount (in − out), date, text
  const unreadable = { ledger: 0, bank: 0 };
  const records = stage("build records", () => {
    const value = (side: "ledger" | "bank", v: string, p: ColumnProfile): number | undefined => {
      if (!v.trim()) return undefined;
      const x = parseAs(v, p);
      if (x === null) {
        unreadable[side]++;
        return undefined;
      }
      return x;
    };
    const build = (side: "ledger" | "bank", u: UnwrappedColumns, ps: ColumnProfile[], m: { key: number; text: number; date: number; amount: number; minus: number }) => {
      const out: RecRecord[] = [];
      const cell = (c: number, k: number) => u.columns[c][k];
      for (let k = 0; k < u.rows; k++) {
        const rec: RecRecord = { row: k };
        if (cell(m.key, k)) rec.key = cell(m.key, k);
        if (cell(m.text, k)) rec.text = cell(m.text, k);
        const d = value(side, cell(m.date, k), ps[m.date]);
        if (d !== undefined) rec.date = Math.floor(d);
        const a = value(side, cell(m.amount, k), ps[m.amount]);
        const b = m.minus >= 0 ? value(side, cell(m.minus, k), ps[m.minus]) : undefined;
        if (a !== undefined || b !== undefined) rec.amount = Math.round(((a ?? 0) - (b ?? 0)) * 100) / 100;
        out.push(rec);
      }
      return out;
    };
    const ledger = build("ledger", lu, lp, { key: col(lu, "Doc No"), text: col(lu, "Narrative"), date: col(lu, "Date"), amount: col(lu, "Amount"), minus: -1 });
    const bank = build("bank", bu, bp, { key: col(bu, "Reference"), text: col(bu, "Description"), date: col(bu, "Date"), amount: col(bu, "Paid in"), minus: col(bu, "Paid out") });
    return { ledger, bank };
  });
  // which generated line each record is
  const idsOf = (u: UnwrappedColumns, out: { lineToId: Int32Array }) => Int32Array.from(u.sourceRows, (r) => out.lineToId[r] ?? -1);
  const idA = idsOf(lu, ledgerOut);
  const idB = idsOf(bu, bankOut);
  // the text columns aren't needed any more
  lu.columns.length = 0;
  bu.columns.length = 0;

  // 6. reconcile with the default settings
  const r = stage("reconcile", () => reconcile(records.ledger, records.bank));

  // 7. the rec statement
  const st = stage("rec statement", () => recStatement(r, records.ledger, records.bank, { bankBalance, ledgerBalance }));

  opts.inspect?.({ g, r, st, ledger: records.ledger, bank: records.bank, idA, idB });

  // 8. score
  const scored = stage("score vs answer key", () => score(g, r, st, idA, idB));
  const usage = process.resourceUsage();
  return {
    rows: opts.rows,
    ledgerLines: g.ledger.n,
    bankLines: g.bank.n,
    stages,
    peakRssMB: Math.round(usage.maxRSS / 1024),
    ...scored,
    junkRecords: { ledger: count(idA, (x) => x < 0), bank: count(idB, (x) => x < 0) },
    lostLines: { ledger: g.ledger.n - count(idA, (x) => x >= 0), bank: g.bank.n - count(idB, (x) => x >= 0) },
    profiles: { ledger: profileNames(lu, lp), bank: profileNames(bu, bp) },
    unreadable,
    statement: { difference: st.difference, adjustedBank: st.adjustedBank, adjustedLedger: st.adjustedLedger, bankBalance, ledgerBalance },
    bankCheck,
    matchRate: r.summary.matchRate,
    sumBudgetExhausted: r.sumBudgetExhausted,
  };
}

const count = (xs: Int32Array, f: (x: number) => boolean) => {
  let n = 0;
  for (const x of xs) if (f(x)) n++;
  return n;
};

type Scored = Pick<AcceptanceReport, "categories" | "splitByK" | "rules" | "wrongMatches" | "interchangeable" | "falseFlags" | "flags" | "falseDuplicates" | "duplicates" | "missed">;

/** Compare a reconcile result and statement with the answer key. */
export function score(g: Generated, r: RecResult, st: RecStatement, idA: Int32Array, idB: Int32Array): Scored {
  const gA = (k: number) => (idA[k] >= 0 ? g.ledger.group[idA[k]] : -1);
  const gB = (k: number) => (idB[k] >= 0 ? g.bank.group[idB[k]] : -1);
  const cat = (grp: number): Category => CATEGORY_LIST[g.groupCat[grp]];
  const found = new Uint8Array(g.groups);
  const matched = new Uint8Array(g.groups);

  // matches
  const rules = Object.fromEntries(REC_RULES.map((x) => [x, { rule: x, matches: 0, correct: 0, precision: 1 }])) as Record<RecRule, RuleScore>;
  let wrongMatches = 0;
  let interchangeable = 0;
  for (const m of r.matches) {
    const rs = rules[m.rule];
    rs.matches++;
    const grp = m.a.length ? gA(m.a[0]) : gB(m.b[0]);
    const ok =
      grp >= 0 &&
      m.a.every((k) => gA(k) === grp) &&
      m.b.every((k) => gB(k) === grp) &&
      m.a.length === g.groupA[grp] &&
      m.b.length === g.groupB[grp] &&
      CATEGORIES[cat(grp)].expect !== "unmatched" &&
      CATEGORIES[cat(grp)].expect !== "mismatch";
    if (ok) {
      rs.correct++;
      matched[grp] = 1;
      const e = CATEGORIES[cat(grp)].expect;
      if (e === "match" || e === "matchOrFlag") found[grp] = 1;
    } else {
      wrongMatches++;
      if (m.a.length === 1 && m.b.length === 1 && idA[m.a[0]] >= 0 && idB[m.b[0]] >= 0) {
        const a = idA[m.a[0]];
        const b = idB[m.b[0]];
        if (g.ledger.payee[a] === g.bank.payee[b] && g.ledger.cents[a] === g.bank.cents[b] && g.ledger.kind[a] === g.bank.kind[b]) interchangeable++;
      }
    }
  }
  for (const rs of Object.values(rules)) rs.precision = rs.matches ? rs.correct / rs.matches : 1;

  // flags
  let falseFlags = 0;
  const flagOf = new Map<string, (typeof r.flags)[number]>();
  for (const f of r.flags) {
    flagOf.set(`${f.a}:${f.b}`, f);
    const grp = gA(f.a);
    const c = grp >= 0 ? cat(grp) : null;
    const e = c ? CATEGORIES[c].expect : null;
    const ok = grp >= 0 && gB(f.b) === grp && (e === "mismatch" || e === "flag" ? f.field === "amount" && f.kind === CATEGORIES[c!].keying : c === "refTypo" && f.field === "key");
    if (!ok) falseFlags++;
    else if (c === "refTypo" || (e === "flag" && !f.mismatched)) found[grp] = 1;
  }
  for (const p of r.mismatched) {
    const grp = gA(p.a);
    if (grp < 0 || gB(p.b) !== grp || CATEGORIES[cat(grp)].expect !== "mismatch") continue;
    const f = flagOf.get(`${p.a}:${p.b}`);
    if (f && f.mismatched && f.kind === CATEGORIES[cat(grp)].keying) found[grp] = 1;
  }

  // duplicates: the copy left over, listed together with the original (and on the ledger errors line, below)
  const dupListed = new Uint8Array(g.groups);
  let falseDuplicates = 0;
  const unmatchedA = new Set(r.unmatchedA);
  for (const d of r.duplicates) {
    const ids = d.items.map((k) => (d.side === "A" ? gA(k) : gB(k)));
    const grp = ids[0];
    const ok = d.side === "A" && grp >= 0 && cat(grp) === "duplicate" && ids.every((x) => x === grp) && d.items.length === 2;
    if (!ok) {
      falseDuplicates++;
      continue;
    }
    if (matched[grp] && d.items.some((k) => unmatchedA.has(k))) dupListed[grp] = 1;
  }

  // leftovers: each on the right line of the statement
  for (const l of [...st.bankLines, ...st.ledgerLines]) {
    for (const it of l.items) {
      if (it.a.length + it.b.length !== 1) continue;
      const grp = it.a.length ? gA(it.a[0]) : gB(it.b[0]);
      if (grp < 0 || CATEGORIES[cat(grp)].line !== l.id) continue;
      const e = CATEGORIES[cat(grp)].expect;
      if (e === "unmatched" || (e === "duplicate" && dupListed[grp])) found[grp] = 1;
    }
  }

  const categories: CategoryScore[] = CATEGORY_LIST.map((c) => ({ category: c, planted: 0, found: 0, recall: 0, threshold: RECALL_THRESHOLD[c] }));
  const splitByK: Record<number, { planted: number; found: number }> = {};
  const missed: Partial<Record<Category, number[]>> = {};
  for (let grp = 0; grp < g.groups; grp++) {
    const cs = categories[g.groupCat[grp]];
    cs.planted++;
    if (found[grp]) cs.found++;
    else (missed[cs.category] ??= []).push(grp);
    if (cs.category === "split") {
      const k = g.groupB[grp];
      splitByK[k] ??= { planted: 0, found: 0 };
      splitByK[k].planted++;
      if (found[grp]) splitByK[k].found++;
    }
  }
  for (const cs of categories) cs.recall = cs.planted ? cs.found / cs.planted : 1;
  return { categories, splitByK, rules: Object.values(rules), wrongMatches, interchangeable, falseFlags, flags: r.flags.length, falseDuplicates, duplicates: r.duplicates.length, missed };
}

/** What doesn't meet the bar, one line each (empty when everything passes). */
export function failures(rep: AcceptanceReport): string[] {
  const out: string[] = [];
  for (const c of rep.categories) if (c.recall + 1e-12 < c.threshold) out.push(`${c.category}: recall ${pct(c.recall)} < ${pct(c.threshold)} (${c.found}/${c.planted})`);
  for (const x of rep.rules) if (x.matches && x.precision + 1e-12 < PRECISION_THRESHOLD) out.push(`rule ${x.rule}: precision ${pct(x.precision)} < ${pct(PRECISION_THRESHOLD)} (${x.correct}/${x.matches})`);
  for (const [k, v] of Object.entries(rep.splitByK)) if (v.found < v.planted) out.push(`1:N split with k=${k}: ${v.found}/${v.planted}`);
  if (Math.abs(rep.statement.difference) > 0.005) out.push(`rec statement difference ${rep.statement.difference}`);
  if (rep.junkRecords.ledger || rep.junkRecords.bank) out.push(`clean-up left non-transaction rows: ledger ${rep.junkRecords.ledger}, bank ${rep.junkRecords.bank}`);
  if (rep.lostLines.ledger || rep.lostLines.bank) out.push(`clean-up lost transactions: ledger ${rep.lostLines.ledger}, bank ${rep.lostLines.bank}`);
  if (rep.unreadable.ledger || rep.unreadable.bank) out.push(`unreadable dates/amounts: ledger ${rep.unreadable.ledger}, bank ${rep.unreadable.bank}`);
  if (rep.bankCheck && (rep.bankCheck.breaks || rep.bankCheck.closingMatches === false)) out.push(`bank statement balance check: ${rep.bankCheck.breaks} breaks, closing matches ${rep.bankCheck.closingMatches}`);
  if (rep.sumBudgetExhausted) out.push("sum pass ran out of budget");
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const padR = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
const padL = (s: string, w: number) => " ".repeat(Math.max(0, w - s.length)) + s;

/** The report as plain-text tables. */
export function formatReport(rep: AcceptanceReport): string {
  const L: string[] = [];
  L.push(`Acceptance: ${rep.rows.toLocaleString("en-US")} rows (ledger ${rep.ledgerLines.toLocaleString("en-US")}, bank ${rep.bankLines.toLocaleString("en-US")})`);
  L.push("");
  L.push(`${padR("Stage", 24)}${padL("ms", 9)}${padL("heap MB", 10)}${padL("RSS MB", 9)}`);
  for (const s of rep.stages) L.push(`${padR(s.name, 24)}${padL(String(s.ms), 9)}${padL(String(s.heapMB), 10)}${padL(String(s.rssMB), 9)}`);
  L.push(`${padR("peak RSS", 24)}${padL("", 9)}${padL("", 10)}${padL(String(rep.peakRssMB), 9)}`);
  L.push("");
  L.push(`${padR("Planted category", 38)}${padL("planted", 9)}${padL("found", 9)}${padL("recall", 9)}${padL("need", 8)}  `);
  for (const c of rep.categories) {
    const ok = c.recall + 1e-12 >= c.threshold;
    L.push(`${padR(CATEGORIES[c.category].label, 38)}${padL(String(c.planted), 9)}${padL(String(c.found), 9)}${padL(pct(c.recall), 9)}${padL(pct(c.threshold), 8)}  ${ok ? "ok" : "FAIL"}`);
  }
  L.push(`1:N splits by parts: ${Object.entries(rep.splitByK).map(([k, v]) => `k=${k} ${v.found}/${v.planted}`).join(", ")}`);
  L.push("");
  L.push(`${padR("Rule", 14)}${padL("matches", 9)}${padL("correct", 9)}${padL("precision", 11)}`);
  for (const x of rep.rules) L.push(`${padR(x.rule, 14)}${padL(String(x.matches), 9)}${padL(String(x.correct), 9)}${padL(pct(x.precision), 11)}${x.matches && x.precision < PRECISION_THRESHOLD ? "  FAIL" : ""}`);
  L.push("");
  L.push(`wrong matches ${rep.wrongMatches} (same party, amount and kind: ${rep.interchangeable}); flags ${rep.flags} (not planted ${rep.falseFlags}); duplicate groups ${rep.duplicates} (not planted ${rep.falseDuplicates})`);
  L.push(`match rate ${pct(rep.matchRate)}; junk records ${rep.junkRecords.ledger}/${rep.junkRecords.bank}; lost lines ${rep.lostLines.ledger}/${rep.lostLines.bank}; unreadable ${rep.unreadable.ledger}/${rep.unreadable.bank}`);
  L.push(`profiles: ledger ${JSON.stringify(rep.profiles.ledger)}; bank ${JSON.stringify(rep.profiles.bank)}`);
  if (rep.bankCheck) L.push(`bank statement check: ${rep.bankCheck.transactions} transactions, ${rep.bankCheck.breaks} breaks, closing matches ${rep.bankCheck.closingMatches}`);
  L.push(`rec statement: bank ${rep.statement.bankBalance} → ${rep.statement.adjustedBank}, ledger ${rep.statement.ledgerBalance} → ${rep.statement.adjustedLedger}, difference ${rep.statement.difference}`);
  return L.join("\n");
}

export { closingCents };
