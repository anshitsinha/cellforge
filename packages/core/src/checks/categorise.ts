/**
 * Categorisation rules: "description contains UBER → Travel", "amount over
 * 10,000 and text starts with INV → Capital". Rules are plain JSON with a
 * priority; applying them gives each row a category, keeps categories that
 * were set by hand unless told otherwise, and reports the rows no rule
 * covers and the rows where rules disagree.
 *
 * learnRules looks at rows already tagged by hand and proposes keyword
 * rules: words that turn up mostly in one category, with how often (support)
 * and how reliably (confidence), so a reviewer can accept or reject each.
 */

export type CatCondition =
  /** the text contains this (any case); `word`: only as a whole word */
  | { kind: "contains"; text: string; word?: boolean }
  | { kind: "startsWith"; text: string }
  | { kind: "equals"; text: string }
  | { kind: "regex"; pattern: string; ignoreCase?: boolean }
  /** min and max are inclusive; either can be left out */
  | { kind: "amount"; min?: number; max?: number }
  /** every condition holds */
  | { kind: "all"; conditions: CatCondition[] };

export interface CatRule {
  id: string;
  condition: CatCondition;
  category: string;
  /** lower runs first (default 100); ties keep list order */
  priority?: number;
  enabled?: boolean;
  /** where the rule came from, for the reviewer */
  source?: "manual" | "learned";
}

export interface CatRow {
  text: string;
  amount?: number | null;
  /** the category the row has now ("" or null when none) */
  category?: string | null;
}

export interface CategoriseOptions {
  /** replace categories rows already have (default false: those are kept) */
  overwrite?: boolean;
}

export interface CatConflict {
  row: number;
  /** the categories the matching rules give, the winning one first */
  categories: string[];
  /** ids of the matching rules, in priority order */
  rules: string[];
}

export interface CategoriseResult {
  /** the category each row ends up with (null: none) */
  categories: (string | null)[];
  /** the id of the rule that set it, or null (kept or none) */
  ruleOf: (string | null)[];
  /** rows whose category this would change */
  changed: number[];
  /** rows that end up with no category */
  uncategorised: number[];
  /** rows where matching rules give different categories */
  conflicts: CatConflict[];
  /** rows that kept a category they already had although a rule matched with another one */
  keptManual: number[];
  /** rows per category after applying, largest first */
  counts: { category: string; rows: number }[];
  /** rows each rule matched (before priority), by rule id */
  hits: Record<string, number>;
}

const compiled = new Map<string, RegExp | null>();
function regexOf(pattern: string, flags: string): RegExp | null {
  const key = flags + "/" + pattern;
  let re = compiled.get(key);
  if (re === undefined) {
    try {
      re = new RegExp(pattern, flags);
    } catch {
      re = null;
    }
    if (compiled.size > 500) compiled.clear();
    compiled.set(key, re);
  }
  return re;
}

const escapeRegex = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Why a rule can't be used, or null. */
export function categoryRuleProblem(rule: Pick<CatRule, "condition" | "category">): string | null {
  if (!rule.category.trim()) return "Give the category.";
  return conditionProblem(rule.condition);
}

function conditionProblem(c: CatCondition): string | null {
  switch (c.kind) {
    case "contains":
    case "startsWith":
    case "equals":
      return c.text.trim() ? null : "Type the text to look for.";
    case "regex":
      if (!c.pattern) return "Type a pattern.";
      return regexOf(c.pattern, "u") ? null : "That isn't a valid pattern.";
    case "amount":
      if (c.min === undefined && c.max === undefined) return "Give a lowest or a highest amount.";
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) return "The lowest amount is above the highest.";
      return null;
    case "all":
      if (!c.conditions.length) return "Add a condition.";
      for (const x of c.conditions) {
        const p = conditionProblem(x);
        if (p) return p;
      }
      return null;
  }
}

/** Does the condition hold for this row? */
export function matchCondition(c: CatCondition, row: Pick<CatRow, "text" | "amount">): boolean {
  switch (c.kind) {
    case "contains": {
      const want = norm(c.text);
      if (!want) return false;
      const text = norm(row.text);
      if (!c.word) return text.includes(want);
      const re = regexOf(`(?:^|[^\\p{L}\\p{N}])${escapeRegex(want)}(?:$|[^\\p{L}\\p{N}])`, "u");
      return !!re && re.test(text);
    }
    case "startsWith": {
      const want = norm(c.text);
      return !!want && norm(row.text).startsWith(want);
    }
    case "equals":
      return norm(row.text) === norm(c.text);
    case "regex": {
      const re = regexOf(c.pattern, c.ignoreCase === false ? "u" : "iu");
      return !!re && re.test(row.text);
    }
    case "amount": {
      const a = row.amount;
      if (typeof a !== "number" || !Number.isFinite(a)) return false;
      return (c.min === undefined || a >= c.min) && (c.max === undefined || a <= c.max);
    }
    case "all":
      return c.conditions.length > 0 && c.conditions.every((x) => matchCondition(x, row));
  }
}

/** A short description: contains "uber" and amount ≥ 100. */
export function describeCondition(c: CatCondition): string {
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 6 });
  switch (c.kind) {
    case "contains":
      return `contains ${c.word ? "the word " : ""}"${c.text}"`;
    case "startsWith":
      return `starts with "${c.text}"`;
    case "equals":
      return `is "${c.text}"`;
    case "regex":
      return `matches /${c.pattern}/`;
    case "amount":
      return c.min !== undefined && c.max !== undefined ? `amount ${n(c.min)} to ${n(c.max)}` : c.min !== undefined ? `amount ≥ ${n(c.min)}` : `amount ≤ ${n(c.max ?? 0)}`;
    case "all":
      return c.conditions.map(describeCondition).join(" and ");
  }
}

/** The rules in the order they're tried: priority (lower first), then list order; disabled and broken rules left out. */
export function orderRules(rules: readonly CatRule[]): CatRule[] {
  return rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.enabled !== false && !categoryRuleProblem(r))
    .sort((a, b) => (a.r.priority ?? 100) - (b.r.priority ?? 100) || a.i - b.i)
    .map(({ r }) => r);
}

const has = (c: string | null | undefined): c is string => typeof c === "string" && c.trim() !== "";

/** Apply the rules to the rows. Nothing is changed; the result says what would be. */
export function categorise(rows: readonly CatRow[], rules: readonly CatRule[], opts: CategoriseOptions = {}): CategoriseResult {
  const ordered = orderRules(rules);
  const categories: (string | null)[] = [];
  const ruleOf: (string | null)[] = [];
  const changed: number[] = [];
  const uncategorised: number[] = [];
  const conflicts: CatConflict[] = [];
  const keptManual: number[] = [];
  const hits: Record<string, number> = {};
  for (const r of ordered) hits[r.id] = 0;
  rows.forEach((row, i) => {
    const matched = ordered.filter((r) => matchCondition(r.condition, row));
    for (const r of matched) hits[r.id]++;
    const distinct = [...new Set(matched.map((r) => r.category.trim()))];
    if (distinct.length > 1) conflicts.push({ row: i, categories: distinct, rules: matched.map((r) => r.id) });
    const current = has(row.category) ? row.category.trim() : null;
    const win = matched[0];
    let cat = current;
    let by: string | null = null;
    if (win && (current === null || opts.overwrite)) {
      cat = win.category.trim();
      by = win.id;
    } else if (win && current !== null && current !== win.category.trim()) keptManual.push(i);
    categories.push(cat);
    ruleOf.push(by);
    if (cat !== current) changed.push(i);
    if (cat === null) uncategorised.push(i);
  });
  const tally = new Map<string, number>();
  for (const c of categories) if (c !== null) tally.set(c, (tally.get(c) ?? 0) + 1);
  const counts = [...tally].map(([category, n]) => ({ category, rows: n })).sort((a, b) => b.rows - a.rows || a.category.localeCompare(b.category));
  return { categories, ruleOf, changed, uncategorised, conflicts, keptManual, counts, hits };
}

// ---------------------------------------------------------------- learning --

const STOP = new Set(
  "the and for from with to of in on at by a an or ltd limited inc llc plc co corp pty gmbh payment payments pay paid card debit credit purchase pos ref reference txn transaction trans transfer tfr dd so fp bp via www com net org uk usa invoice inv no nr number date".split(" "),
);

/** The words of a text that are worth a rule: 3+ letters, not all digits, not filler. */
export function ruleTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}&]+/u)) {
    if (w.length < 3 || /^\d+$/.test(w) || /^\d/.test(w) || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

export interface LearnOptions {
  /** rows (of the category) a word must turn up in (default 2) */
  minSupport?: number;
  /** share of the rows with the word that are in the category (default 0.8) */
  minConfidence?: number;
  /** most proposals (default 50) */
  maxRules?: number;
  /** also propose two-word phrases (default true) */
  phrases?: boolean;
  /** existing rules: a proposal one of them already covers is left out */
  existing?: readonly CatRule[];
}

export interface LearnedRule {
  rule: CatRule;
  /** tagged rows with the word in this category */
  support: number;
  /** support / all tagged rows with the word */
  confidence: number;
  /** tagged rows with the word in other categories */
  against: number;
  /** share of the category's tagged rows the rule covers */
  coverage: number;
  /** a few texts it matches */
  examples: string[];
}

/**
 * Propose keyword rules from rows tagged by hand. For every word (and two-word
 * phrase), count the tagged rows it appears in per category; a word that
 * appears mostly in one category becomes a "contains the word" rule for it.
 * A phrase is only proposed when it's more reliable than its words.
 */
export function learnRules(rows: readonly CatRow[], opts: LearnOptions = {}): LearnedRule[] {
  const minSupport = opts.minSupport ?? 2;
  const minConf = opts.minConfidence ?? 0.8;
  const max = opts.maxRules ?? 50;
  const phrases = opts.phrases !== false;
  /** per term: rows per category, and examples */
  const stats = new Map<string, { per: Map<string, number>; total: number; examples: Map<string, string[]> }>();
  const perCategory = new Map<string, number>();
  for (const row of rows) {
    if (!has(row.category)) continue;
    const cat = row.category.trim();
    perCategory.set(cat, (perCategory.get(cat) ?? 0) + 1);
    const words = ruleTokens(row.text);
    const terms = new Set(words);
    if (phrases) {
      const seq = row.text.toLowerCase().split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
      for (let i = 0; i + 1 < seq.length; i++) {
        const [a, b] = [seq[i], seq[i + 1]];
        if (a.length < 2 || b.length < 2 || /^\d+$/.test(a) || /^\d+$/.test(b) || (STOP.has(a) && STOP.has(b))) continue;
        terms.add(`${a} ${b}`);
      }
    }
    for (const t of terms) {
      let s = stats.get(t);
      if (!s) stats.set(t, (s = { per: new Map(), total: 0, examples: new Map() }));
      s.total++;
      s.per.set(cat, (s.per.get(cat) ?? 0) + 1);
      const ex = s.examples.get(cat) ?? [];
      if (ex.length < 3 && !ex.includes(row.text)) ex.push(row.text);
      s.examples.set(cat, ex);
    }
  }
  const best = (t: string) => {
    const s = stats.get(t);
    if (!s) return null;
    let cat = "";
    let n = 0;
    for (const [c, k] of s.per) if (k > n || (k === n && c < cat)) [cat, n] = [c, k];
    return { cat, n, conf: n / s.total, total: s.total, examples: s.examples.get(cat) ?? [] };
  };
  const existing = (opts.existing ?? []).filter((r) => r.enabled !== false);
  const covered = (term: string, cat: string) =>
    existing.some((r) => r.category.trim().toLowerCase() === cat.toLowerCase() && (r.condition.kind === "contains" || r.condition.kind === "equals" || r.condition.kind === "startsWith") && norm(r.condition.text) === term);
  const out: LearnedRule[] = [];
  for (const term of stats.keys()) {
    const b = best(term);
    if (!b || b.n < minSupport || b.conf < minConf) continue;
    if (covered(term, b.cat)) continue;
    if (term.includes(" ")) {
      // a phrase earns a place only when its words alone aren't as good
      const parts = term.split(" ");
      const better = parts.some((p) => {
        const w = best(p);
        return w && w.cat === b.cat && w.n >= minSupport && w.conf >= b.conf && ruleTokens(p).length > 0;
      });
      if (better) continue;
    }
    const id = `learned-${b.cat}-${term}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
    out.push({
      rule: { id, condition: { kind: "contains", text: term, word: true }, category: b.cat, source: "learned" },
      support: b.n,
      confidence: b.conf,
      against: b.total - b.n,
      coverage: b.n / (perCategory.get(b.cat) ?? b.n),
      examples: b.examples,
    });
  }
  out.sort((a, b) => b.support - a.support || b.confidence - a.confidence || a.rule.condition.kind.localeCompare(b.rule.condition.kind) || termOf(a).localeCompare(termOf(b)));
  return out.slice(0, max);
}

const termOf = (l: LearnedRule) => (l.rule.condition.kind === "contains" ? l.rule.condition.text : "");
