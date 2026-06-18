/**
 * Journal entry tests: the standard checks an auditor runs over a general
 * ledger export. Lines are grouped into entries by their entry id; each test
 * flags entries with a plain reason, and a weighted score ranks the entries
 * that tripped the most (or the most serious) tests.
 *
 * Dates are Excel serials (whole days, the time as the fraction).
 */
import type { DateOrder } from "../clean/values";
import { normaliseText } from "../audit/duplicates";
import { cellDate, cellNumber, plain, type Cell } from "../audit/values";
import { dateToSerial, serialToParts } from "../numfmt";

export type JeTestId =
  | "unbalanced"
  | "weekend"
  | "afterHours"
  | "round"
  | "threshold"
  | "rareUser"
  | "backdated"
  | "seldomAccount"
  | "keywords"
  | "periodEnd"
  | "duplicates";

export const JE_TESTS: readonly JeTestId[] = ["unbalanced", "duplicates", "backdated", "weekend", "afterHours", "round", "threshold", "rareUser", "seldomAccount", "keywords", "periodEnd"];

export const JE_TEST_LABEL: Record<JeTestId, string> = {
  unbalanced: "Entries that don't balance",
  weekend: "Weekend and holiday postings",
  afterHours: "Posted outside working hours",
  round: "Round amounts",
  threshold: "Just below an approval limit",
  rareUser: "Unusual user for the account",
  backdated: "Backdated entries",
  seldomAccount: "Seldom-used accounts",
  keywords: "Keywords in the description",
  periodEnd: "Near the period end",
  duplicates: "Duplicate entries",
};

/** How much each test adds to an entry's score. */
export const JE_WEIGHTS: Record<JeTestId, number> = {
  unbalanced: 5,
  duplicates: 3,
  backdated: 2,
  threshold: 2,
  rareUser: 2,
  seldomAccount: 2,
  keywords: 2,
  weekend: 1,
  afterHours: 1,
  round: 1,
  periodEnd: 1,
};

export const DEFAULT_JE_KEYWORDS: readonly string[] = ["adjust", "reverse", "reversal", "correction", "correct", "plug", "misc", "suspense", "write off", "override", "manual"];

/** One journal line. Amounts are signed: debits positive, credits negative. */
export interface JeLine {
  entry: string;
  /** Effective (document) date. */
  date: number | null;
  /** When it was posted (may carry the time). */
  posted: number | null;
  /** Time of day, 0 to 1, when known. */
  time: number | null;
  user: string;
  account: string;
  amount: number | null;
  description: string;
}

export interface JeColumns {
  entry?: Cell[];
  date?: Cell[];
  posted?: Cell[];
  /** A separate time column: 14:35, 2:35 PM, or a fraction of a day. */
  time?: Cell[];
  user?: Cell[];
  account?: Cell[];
  /** Signed amount; or give debit and credit instead. */
  amount?: Cell[];
  debit?: Cell[];
  credit?: Cell[];
  description?: Cell[];
  dateOrder?: DateOrder;
}

/** Time of day as a fraction from 14:35, 14:35:10, 2:35 pm, or a number (its fraction). */
export function parseTimeOfDay(v: Cell | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v - Math.floor(v) : null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(v);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[4]) h = (h % 12) + (m[4].toLowerCase() === "pm" ? 12 : 0);
  if (h > 23 || Number(m[2]) > 59) return null;
  return (h * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) / 86_400;
}

const str = (v: Cell | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const frac = (s: number | null) => (s === null ? 0 : s - Math.floor(s));

/** Journal lines from columns of cells. Debit and credit become one signed amount (debit less credit, credits taken as positive). */
export function jeLines(cols: JeColumns): JeLine[] {
  const n = Math.max(0, ...[cols.entry, cols.date, cols.posted, cols.time, cols.user, cols.account, cols.amount, cols.debit, cols.credit, cols.description].map((c) => c?.length ?? 0));
  const order = cols.dateOrder ?? "dmy";
  const out: JeLine[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const date = cols.date ? cellDate(cols.date[i], order) : null;
    const posted = cols.posted ? cellDate(cols.posted[i], order) : null;
    let time: number | null = cols.time ? parseTimeOfDay(cols.time[i]) : null;
    if (time === null && frac(posted) > 0) time = frac(posted);
    if (time === null && !cols.posted && frac(date) > 0) time = frac(date);
    let amount: number | null = null;
    if (cols.amount) amount = cellNumber(cols.amount[i]);
    else {
      const dr = cols.debit ? cellNumber(cols.debit[i]) : null;
      const cr = cols.credit ? cellNumber(cols.credit[i]) : null;
      if (dr !== null || cr !== null) amount = (dr ?? 0) - Math.abs(cr ?? 0);
    }
    out[i] = {
      entry: str(cols.entry?.[i]),
      date,
      posted,
      time,
      user: str(cols.user?.[i]),
      account: str(cols.account?.[i]),
      amount,
      description: str(cols.description?.[i]),
    };
  }
  return out;
}

export interface JeOptions {
  /** Tests to run (all by default). */
  tests?: readonly JeTestId[];
  /** Out-of-balance amounts up to this are ignored. Default 0.005. */
  tolerance?: number;
  /** Holiday dates as serials. */
  holidays?: readonly number[];
  /** Days that count as the weekend, 0 = Sunday … 6 = Saturday. Default Saturday and Sunday. */
  weekendDays?: readonly number[];
  /** Which date the weekend test looks at. Default either. */
  weekendOn?: "date" | "posted" | "either";
  /** Working hours, in hours from midnight (8.5 = 08:30). Default 8 to 18. Start after end means an overnight shift. */
  hours?: { start: number; end: number };
  /** Round amounts: a nonzero multiple of `multiple` (default 1000), or at least `zeros` trailing zeros (0 = off). */
  round?: { multiple?: number; zeros?: number };
  /** Approval limits. */
  limits?: readonly number[];
  /** How far below a limit counts as just below, as a share. Default 0.05 (5%). */
  margin?: number;
  /** Compare the limit with the entry's total debits (default) or with each line. */
  thresholdBasis?: "entry" | "line";
  /** A user × account pair is unusual with at most `maxLines` lines, on an account with at least `minAccountLines`. Defaults 2 and 10. A user with at most `userEntries` entries is unusual too (default 2; 0 turns it off). */
  rare?: { maxLines?: number; minAccountLines?: number; userEntries?: number };
  /** Posted more than this many days after its date. Default 30. */
  backdatedDays?: number;
  /** Accounts used in at most this many entries. Default 3. */
  seldomEntries?: number;
  /** Words to look for at the start of a word in the description (default DEFAULT_JE_KEYWORDS). */
  keywords?: readonly string[];
  /** Dated within this many days of the period end (the end day counts as the first). Default 3. */
  periodEnd?: { days?: number; period?: "month" | "quarter" | "year" };
  /** Same accounts and amounts, dated at most `days` apart (default 0: same date; a negative number ignores the date). */
  duplicates?: { days?: number };
  weights?: Partial<Record<JeTestId, number>>;
}

export interface JeFlag {
  test: JeTestId;
  reason: string;
  /** Line indexes the flag is about. */
  lines: number[];
}

export interface JeEntry {
  /** The entry id, or "" for a line without one (each is its own entry). */
  id: string;
  lines: number[];
  date: number | null;
  posted: number | null;
  users: string[];
  debits: number;
  credits: number;
  flags: JeFlag[];
  score: number;
}

export interface JeTestSummary {
  test: JeTestId;
  label: string;
  entries: number;
  lines: number;
  /** Why the test couldn't run, when it didn't. */
  skipped?: string;
}

export interface JeResult {
  entries: JeEntry[];
  /** Entries with at least one flag, highest score first. */
  ranked: JeEntry[];
  summary: JeTestSummary[];
  /** Lines read (blank lines are left out). */
  lines: number;
  /** Lines without an entry id. */
  noId: number;
  /** Period-end clustering: the share of entries in the window and the share you'd expect if dates were spread evenly. */
  periodEnd?: { share: number; expected: number };
}

export function isoDate(serial: number): string {
  const p = serialToParts(Math.floor(serial));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function clock(fraction: number): string {
  const mins = Math.round(fraction * 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Days from `serial` to the end of its month / quarter / year (0 on the last day). */
export function daysToPeriodEnd(serial: number, period: "month" | "quarter" | "year" = "month"): number {
  const day = Math.floor(serial);
  const p = serialToParts(day);
  const nextMonth = period === "month" ? p.m + 1 : period === "quarter" ? Math.floor((p.m - 1) / 3) * 3 + 4 : 13;
  const y = nextMonth > 12 ? p.y + 1 : p.y;
  const m = nextMonth > 12 ? nextMonth - 12 : nextMonth;
  return dateToSerial(y, m, 1) - 1 - day;
}

/** Run the journal entry tests. */
export function runJeTests(all: readonly JeLine[], opts: JeOptions = {}): JeResult {
  const tests = new Set(opts.tests ?? JE_TESTS);
  const weights = { ...JE_WEIGHTS, ...opts.weights };
  // group lines into entries
  const byId = new Map<string, number>();
  const entries: JeEntry[] = [];
  let lineCount = 0;
  let noId = 0;
  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    if (!l.entry && l.amount === null && !l.account && l.date === null) continue;
    lineCount++;
    let e: JeEntry | undefined;
    if (l.entry) {
      const k = byId.get(l.entry);
      if (k !== undefined) e = entries[k];
    } else noId++;
    if (!e) {
      e = { id: l.entry, lines: [], date: null, posted: null, users: [], debits: 0, credits: 0, flags: [], score: 0 };
      if (l.entry) byId.set(l.entry, entries.length);
      entries.push(e);
    }
    e.lines.push(i);
    if (e.date === null && l.date !== null) e.date = l.date;
    if (l.posted !== null && (e.posted === null || l.posted > e.posted)) e.posted = l.posted;
    if (l.user && !e.users.includes(l.user)) e.users.push(l.user);
    if (l.amount !== null) {
      if (l.amount > 0) e.debits += l.amount;
      else e.credits -= l.amount;
    }
  }
  const hasIds = byId.size > 0;
  const summary = new Map<JeTestId, JeTestSummary>();
  for (const t of JE_TESTS) if (tests.has(t)) summary.set(t, { test: t, label: JE_TEST_LABEL[t], entries: 0, lines: 0 });
  const skip = (t: JeTestId, why: string) => {
    const s = summary.get(t);
    if (s) s.skipped = why;
  };
  const flag = (e: JeEntry, test: JeTestId, reason: string, lines: number[] = e.lines) => {
    e.flags.push({ test, reason, lines });
  };
  const has = (pick: (l: JeLine) => unknown) => all.some((l) => pick(l));

  // --- unbalanced
  if (tests.has("unbalanced")) {
    if (!hasIds) skip("unbalanced", "no entry ids");
    else {
      const tol = opts.tolerance ?? 0.005;
      for (const e of entries) {
        if (!e.id) continue;
        const net = round2(e.debits - e.credits);
        if (Math.abs(net) > tol) flag(e, "unbalanced", `Out of balance by ${plain(net)} (debits ${plain(e.debits)}, credits ${plain(e.credits)})`);
      }
    }
  }

  // --- weekend and holidays
  if (tests.has("weekend")) {
    const on = opts.weekendOn ?? "either";
    const wk = new Set(opts.weekendDays ?? [0, 6]);
    const hol = new Set((opts.holidays ?? []).map((h) => Math.floor(h)));
    const dates: Array<["date" | "posted", string]> = [];
    if (on !== "posted") dates.push(["date", "Dated"]);
    if (on !== "date") dates.push(["posted", "Posted"]);
    if (!has((l) => l.date !== null || l.posted !== null)) skip("weekend", "no dates");
    else
      for (const e of entries) {
        const reasons: string[] = [];
        let lastDay = NaN;
        for (const [which, verb] of dates) {
          const s = e[which];
          if (s === null) continue;
          const day = Math.floor(s);
          if (day === lastDay) continue;
          if (hol.has(day)) {
            reasons.push(`${verb} on a holiday, ${isoDate(day)}`);
            lastDay = day;
          } else {
            const wd = serialToParts(day).wd;
            if (wk.has(wd)) {
              reasons.push(`${verb} on a ${DAY_NAMES[wd]}, ${isoDate(day)}`);
              lastDay = day;
            }
          }
        }
        if (reasons.length) flag(e, "weekend", reasons.join("; "));
      }
  }

  // --- after hours
  if (tests.has("afterHours")) {
    const { start, end } = opts.hours ?? { start: 8, end: 18 };
    const s = start / 24;
    const t = end / 24;
    const inside = (x: number) => (s <= t ? x >= s && x < t : x >= s || x < t);
    // the time column, else the posted date's time (midnight exactly counts as no time)
    const timeOf = (l: JeLine) => l.time ?? (frac(l.posted) > 0 ? frac(l.posted) : null);
    if (!has((l) => timeOf(l) !== null)) skip("afterHours", "no posting times");
    else
      for (const e of entries) {
        const out = e.lines.filter((i) => {
          const x = timeOf(all[i]);
          return x !== null && !inside(x);
        });
        if (out.length) flag(e, "afterHours", `Posted at ${clock(timeOf(all[out[0]])!)} (working hours ${clock(s)}-${clock(t)})`, out);
      }
  }

  // --- round amounts
  if (tests.has("round")) {
    const multiple = opts.round?.multiple ?? 1000;
    const zeros = opts.round?.zeros ?? 0;
    const trailing = (a: number) => {
      if (!Number.isInteger(a) || a === 0) return 0;
      let z = 0;
      for (let x = Math.abs(a); x % 10 === 0; x /= 10) z++;
      return z;
    };
    const isRound = (a: number) => {
      const abs = Math.abs(a);
      if (!abs) return false;
      if (multiple > 0 && abs >= multiple && Math.abs(Math.round(abs / multiple) * multiple - abs) < 1e-6) return true;
      return zeros > 0 && trailing(abs) >= zeros;
    };
    for (const e of entries) {
      const hits = e.lines.filter((i) => all[i].amount !== null && isRound(all[i].amount!));
      if (!hits.length) continue;
      const amounts = [...new Set(hits.map((i) => Math.abs(all[i].amount!)))].sort((a, b) => b - a);
      flag(e, "round", `Round amount${amounts.length > 1 ? "s" : ""} ${amounts.slice(0, 3).map((a) => `${plain(a)} (${trailing(a)} trailing zeros)`).join(", ")}`, hits);
    }
  }

  // --- just below an approval limit
  if (tests.has("threshold")) {
    const limits = (opts.limits ?? []).filter((x) => x > 0).sort((a, b) => a - b);
    const margin = opts.margin ?? 0.05;
    const below = (v: number) => limits.find((L) => v >= L * (1 - margin) && v < L);
    if (!limits.length) skip("threshold", "no approval limits given");
    else
      for (const e of entries) {
        if ((opts.thresholdBasis ?? "entry") === "entry") {
          const L = below(round2(e.debits));
          if (L !== undefined) flag(e, "threshold", `Total ${plain(e.debits)} is just below the limit of ${plain(L)} (${(((L - e.debits) / L) * 100).toFixed(1)}% under)`);
        } else {
          const hits = e.lines.filter((i) => all[i].amount !== null && below(Math.abs(all[i].amount!)) !== undefined);
          if (hits.length) {
            const a = Math.abs(all[hits[0]].amount!);
            flag(e, "threshold", `Line of ${plain(a)} is just below the limit of ${plain(below(a)!)}`, hits);
          }
        }
      }
  }

  // --- unusual users
  if (tests.has("rareUser")) {
    const maxLines = opts.rare?.maxLines ?? 2;
    const minAccount = opts.rare?.minAccountLines ?? 10;
    const userEntries = opts.rare?.userEntries ?? 2;
    if (!has((l) => l.user)) skip("rareUser", "no user column");
    else {
      const combo = new Map<string, number>();
      const account = new Map<string, number>();
      const perUser = new Map<string, number>();
      for (const e of entries) for (const u of e.users) perUser.set(u, (perUser.get(u) ?? 0) + 1);
      for (const e of entries)
        for (const i of e.lines) {
          const l = all[i];
          if (!l.account) continue;
          account.set(l.account, (account.get(l.account) ?? 0) + 1);
          if (l.user) combo.set(l.user + "\u0000" + l.account, (combo.get(l.user + "\u0000" + l.account) ?? 0) + 1);
        }
      const many = perUser.size >= 3 && entries.length >= 10 * userEntries;
      for (const e of entries) {
        const reasons: string[] = [];
        const lines: number[] = [];
        for (const u of e.users) if (many && userEntries > 0 && perUser.get(u)! <= userEntries) reasons.push(`${u} posted only ${perUser.get(u)} ${perUser.get(u) === 1 ? "entry" : "entries"}`);
        const seen = new Set<string>();
        for (const i of e.lines) {
          const l = all[i];
          if (!l.user || !l.account) continue;
          const k = l.user + "\u0000" + l.account;
          const n = combo.get(k)!;
          const total = account.get(l.account)!;
          if (n <= maxLines && total >= minAccount) {
            lines.push(i);
            if (!seen.has(k)) reasons.push(`${l.user} posted ${n} of ${total} lines to ${l.account}`);
            seen.add(k);
          }
        }
        if (reasons.length) flag(e, "rareUser", reasons.join("; "), lines.length ? lines : e.lines);
      }
    }
  }

  // --- backdated
  if (tests.has("backdated")) {
    const days = opts.backdatedDays ?? 30;
    if (!has((l) => l.posted !== null) || !has((l) => l.date !== null)) skip("backdated", "needs both the date and the posted date");
    else
      for (const e of entries) {
        if (e.date === null || e.posted === null) continue;
        const gap = Math.floor(e.posted) - Math.floor(e.date);
        if (gap > days) flag(e, "backdated", `Posted ${gap} days after its date (${isoDate(e.date)} posted ${isoDate(e.posted)})`);
      }
  }

  // --- seldom-used accounts
  if (tests.has("seldomAccount")) {
    const max = opts.seldomEntries ?? 3;
    if (!has((l) => l.account)) skip("seldomAccount", "no account column");
    else {
      const uses = new Map<string, number>();
      for (const e of entries) for (const a of new Set(e.lines.map((i) => all[i].account).filter(Boolean))) uses.set(a, (uses.get(a) ?? 0) + 1);
      for (const e of entries) {
        const hits = e.lines.filter((i) => all[i].account && uses.get(all[i].account)! <= max);
        if (!hits.length) continue;
        const accts = [...new Set(hits.map((i) => all[i].account))];
        flag(e, "seldomAccount", accts.map((a) => `Account ${a} is used in only ${uses.get(a)} ${uses.get(a) === 1 ? "entry" : "entries"}`).join("; "), hits);
      }
    }
  }

  // --- keywords
  if (tests.has("keywords")) {
    const words = (opts.keywords ?? DEFAULT_JE_KEYWORDS).map((k) => normaliseText(k)).filter(Boolean);
    if (!has((l) => l.description)) skip("keywords", "no description column");
    else if (!words.length) skip("keywords", "no keywords given");
    else
      for (const e of entries) {
        const found = new Set<string>();
        const lines: number[] = [];
        for (const i of e.lines) {
          const d = all[i].description;
          if (!d) continue;
          const n = " " + normaliseText(d);
          let hit = false;
          for (const w of words)
            if (n.includes(" " + w)) {
              found.add(w);
              hit = true;
            }
          if (hit) lines.push(i);
        }
        if (found.size) flag(e, "keywords", `Description has ${[...found].map((w) => `"${w}"`).join(", ")}: ${all[lines[0]].description.slice(0, 80)}`, lines);
      }
  }

  // --- period end
  let periodEnd: JeResult["periodEnd"];
  if (tests.has("periodEnd")) {
    const days = Math.max(1, opts.periodEnd?.days ?? 3);
    const period = opts.periodEnd?.period ?? "month";
    const name = period === "month" ? "month end" : period === "quarter" ? "quarter end" : "year end";
    let dated = 0;
    let near = 0;
    for (const e of entries) {
      if (e.date === null) continue;
      dated++;
      const left = daysToPeriodEnd(e.date, period);
      if (left < days) {
        near++;
        flag(e, "periodEnd", left === 0 ? `Dated ${isoDate(e.date)}, the ${name}` : `Dated ${isoDate(e.date)}, ${left} day${left === 1 ? "" : "s"} before the ${name}`);
      }
    }
    if (!dated) skip("periodEnd", "no dates");
    else periodEnd = { share: near / dated, expected: Math.min(1, days / (period === "month" ? 30.44 : period === "quarter" ? 91.31 : 365.25)) };
  }

  // --- duplicates
  if (tests.has("duplicates")) {
    const window = opts.duplicates?.days ?? 0;
    if (!hasIds) skip("duplicates", "no entry ids");
    else {
      const groups = new Map<string, JeEntry[]>();
      for (const e of entries) {
        if (!e.id) continue;
        const parts = e.lines.filter((i) => all[i].amount !== null && all[i].amount !== 0).map((i) => `${normaliseText(all[i].account)}|${round2(all[i].amount!)}`);
        if (!parts.length) continue;
        const sig = parts.sort().join("\u0001");
        const g = groups.get(sig);
        if (g) g.push(e);
        else groups.set(sig, [e]);
      }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        let clusters: JeEntry[][];
        if (window < 0) clusters = [g];
        else {
          const sorted = [...g].sort((a, b) => (a.date ?? -1) - (b.date ?? -1));
          clusters = [];
          let cur: JeEntry[] = [sorted[0]];
          for (let k = 1; k < sorted.length; k++) {
            const a = sorted[k - 1].date;
            const b = sorted[k].date;
            if (a !== null && b !== null && Math.floor(b) - Math.floor(a) <= window) cur.push(sorted[k]);
            else if (a === null && b === null) cur.push(sorted[k]);
            else {
              clusters.push(cur);
              cur = [sorted[k]];
            }
          }
          clusters.push(cur);
        }
        for (const c of clusters) {
          if (c.length < 2) continue;
          for (const e of c) {
            const others = c.filter((x) => x !== e).map((x) => x.id);
            flag(e, "duplicates", `Same accounts and amounts as ${others.slice(0, 5).join(", ")}${others.length > 5 ? ` and ${others.length - 5} more` : ""}`);
          }
        }
      }
    }
  }

  // --- score and summary
  for (const e of entries) {
    const seen = new Set<JeTestId>();
    for (const f of e.flags) {
      if (seen.has(f.test)) continue;
      seen.add(f.test);
      e.score += weights[f.test] ?? 1;
      const s = summary.get(f.test)!;
      s.entries++;
      s.lines += f.lines.length;
    }
  }
  const ranked = entries.filter((e) => e.flags.length).sort((a, b) => b.score - a.score || b.flags.length - a.flags.length || b.debits - a.debits);
  return { entries, ranked, summary: [...summary.values()], lines: lineCount, noId, periodEnd };
}
