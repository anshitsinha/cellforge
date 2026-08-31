/**
 * Explain and Clean with a local model. Each helper starts from facts worked
 * out without the model (a formula in words, a lineage write-up, a column's
 * distinct values, rows already tagged), asks the model under a grammar so
 * the answer has the right shape, then checks the answer against those facts
 * before showing it. When there's no model, or the answer fails a check, the
 * caller gets the plain version and the reason, never an unchecked guess.
 */
import { type JsonSchema, validate } from "@cellforge/actions";
import type { Model } from "./loop";

export interface Checked<T> {
  value: T;
  /** "model" when the model's answer passed every check, "rules" when the plain version is used */
  by: "model" | "rules";
  /** why the model's answer wasn't used, if it wasn't */
  rejected?: string;
}

async function ask<T>(model: Model, prompt: string, schema: JsonSchema): Promise<T> {
  const text = await model.propose(prompt, schema);
  const value = JSON.parse(text) as unknown;
  const problems = validate(value, schema, "answer");
  if (problems.length) throw new Error(problems.join("; "));
  return value as T;
}

// ---- explain

/** Numbers written in a text: "1,250.50" → 1250.5. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/-?\d[\d,]*(\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Cell references written in a text: "C2:C10", "Rates!A:C", "B7". */
const REF = /(?<![\w$!])(?:[A-Za-z_][\w.]*!)?\$?[A-Z]{1,3}\$?\d*(?::\$?[A-Z]{1,3}\$?\d*)?\b/g;

export function refsIn(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[0]).filter((r) => /\d|:/.test(r));
}

/** the text with cell references blanked out, so "D7" isn't read as the number 7 */
const withoutRefs = (text: string) => text.replace(REF, (r) => (/\d|:/.test(r) ? " " : r));

export interface ExplainFacts {
  /** the formula as written, e.g. =SUMIFS(C:C,A:A,"North") */
  formula: string;
  /** the formula in words (formulaInWords): the fallback and the reference */
  words: string;
  /** what the cell shows now */
  value?: string;
  /** optional: where the inputs came from (lineage writeUp) */
  lineage?: string;
}

const EXPLAIN_SCHEMA: JsonSchema = {
  type: "object",
  properties: { explanation: { type: "string", minLength: 10, maxLength: 600 } },
  required: ["explanation"],
};

/**
 * A plain-English explanation of a formula (and where its inputs came from).
 * The model's version is used only if every number in it appears in the facts
 * and it names no cell the formula doesn't use.
 */
export async function explainFormula(facts: ExplainFacts, model?: Model | null): Promise<Checked<string>> {
  const plain = facts.words + (facts.lineage ? `\n\n${facts.lineage}` : "");
  if (!model) return { value: plain, by: "rules" };
  const prompt = [
    "Explain this spreadsheet formula to a finance reviewer in two or three plain sentences.",
    "Say what it works out and why someone would use it. Don't invent figures or cells.",
    `Formula: ${facts.formula}`,
    `In words: ${facts.words}`,
    facts.value !== undefined ? `It shows: ${facts.value}` : "",
    facts.lineage ? `Where the inputs came from:\n${facts.lineage}` : "",
    'Answer as JSON: {"explanation": "..."}',
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const { explanation } = await ask<{ explanation: string }>(model, prompt, EXPLAIN_SCHEMA);
    const source = [facts.formula, facts.words, facts.value ?? "", facts.lineage ?? ""].join("\n");
    const knownRefs = new Set(refsIn(source).map((r) => r.replace(/\$/g, "").toUpperCase()));
    const strayRef = refsIn(explanation).find((r) => !knownRefs.has(r.replace(/\$/g, "").toUpperCase()));
    if (strayRef) return { value: plain, by: "rules", rejected: `it mentioned ${strayRef}, which the formula doesn't use` };
    const known = new Set(numbersIn(withoutRefs(source)));
    // small counts ("two or three sentences", "the 2 ranges") are fine
    const strayNumber = numbersIn(withoutRefs(explanation)).find((n) => !known.has(n) && !known.has(-n) && !(Number.isInteger(n) && n >= 1 && n <= 3));
    if (strayNumber !== undefined) return { value: plain, by: "rules", rejected: `it mentioned ${strayNumber}, which isn't in the formula or its inputs` };
    return { value: explanation.trim(), by: "model" };
  } catch (e) {
    return { value: plain, by: "rules", rejected: (e as Error).message };
  }
}

// ---- clean: spelling variants of the same thing

export interface ValueMerge {
  /** the spellings to replace */
  from: string[];
  /** the spelling to keep (one already in the column) */
  to: string;
  /** cells changed */
  cells: number;
  by: "rules" | "model";
}

/** "ACME Ltd." / "Acme Ltd" / " acme ltd" → "acme ltd" */
export function looseKey(v: string): string {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[ \s]+/g, " ")
    .replace(/[.,;:'"`]/g, "")
    .replace(/\b(limited)\b/g, "ltd")
    .replace(/\b(incorporated)\b/g, "inc")
    .replace(/\b(company)\b/g, "co")
    .trim();
}

/**
 * Spellings that are the same once case, spacing and punctuation are ignored,
 * merged into the most common spelling. Then, with a model, variants the rules
 * can't see ("Intl Business Machines" / "IBM"): the model may only pair values
 * that are in the column, and only into the more common spelling.
 */
export async function suggestMerges(values: readonly string[], model?: Model | null, maxDistinct = 200): Promise<{ merges: ValueMerge[]; rejected?: string }> {
  const counts = new Map<string, number>();
  for (const v of values) if (v.trim()) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = new Map<string, string[]>();
  for (const v of counts.keys()) {
    const k = looseKey(v);
    const g = groups.get(k);
    if (g) g.push(v);
    else groups.set(k, [v]);
  }
  const best = (vs: string[]) => vs.reduce((a, b) => ((counts.get(b) ?? 0) > (counts.get(a) ?? 0) || ((counts.get(b) ?? 0) === (counts.get(a) ?? 0) && b.trim() === b && a.trim() !== a) ? b : a));
  const merges: ValueMerge[] = [];
  const canon: string[] = [];
  for (const vs of groups.values()) {
    const to = best(vs);
    canon.push(to);
    const from = vs.filter((v) => v !== to);
    if (from.length) merges.push({ from, to, cells: from.reduce((s, v) => s + (counts.get(v) ?? 0), 0), by: "rules" });
  }
  if (!model || canon.length < 2 || canon.length > maxDistinct) return { merges };

  const schema: JsonSchema = {
    type: "object",
    properties: {
      pairs: {
        type: "array",
        maxItems: 20,
        items: { type: "object", properties: { variant: { type: "string", enum: canon }, same_as: { type: "string", enum: canon } }, required: ["variant", "same_as"] },
      },
    },
    required: ["pairs"],
  };
  const prompt = [
    "These are the distinct values of one spreadsheet column. List pairs that name the same thing written differently",
    "(abbreviations, typos, a missing word). Leave out values that are merely similar but different things. If none, give an empty list.",
    ...canon.map((v) => `- ${v} (${counts.get(v)})`),
    'Answer as JSON: {"pairs": [{"variant": "...", "same_as": "..."}]}',
  ].join("\n");
  try {
    const { pairs } = await ask<{ pairs: { variant: string; same_as: string }[] }>(model, prompt, schema);
    const into = new Map<string, string>();
    for (const p of pairs) {
      if (p.variant === p.same_as) continue;
      // keep the more common spelling, and never chain or split a value two ways
      const [from, to] = (counts.get(p.variant) ?? 0) > (counts.get(p.same_as) ?? 0) ? [p.same_as, p.variant] : [p.variant, p.same_as];
      if (into.has(from) || into.has(to)) continue;
      into.set(from, to);
    }
    const byTarget = new Map<string, string[]>();
    for (const [from, to] of into) byTarget.set(to, [...(byTarget.get(to) ?? []), from]);
    for (const [to, froms] of byTarget) {
      // a value the rules already merge carries its own variants along
      const from = froms.flatMap((f) => [f, ...(merges.find((m) => m.to === f)?.from ?? [])]);
      merges.push({ from, to, cells: from.reduce((s, v) => s + (counts.get(v) ?? 0), 0), by: "model" });
    }
    return { merges: merges.filter((m) => m.by === "model" || !into.has(m.to)) };
  } catch (e) {
    return { merges, rejected: (e as Error).message };
  }
}

// ---- categories for untagged rows

export interface CategorySuggestion {
  /** index into the rows given */
  row: number;
  category: string;
}

/**
 * For rows no rule covers: the model picks one of the categories already in
 * use (or "not sure"), shown a few hand-tagged examples of each. The grammar
 * means it can't invent a category; "not sure" rows are left for a person.
 */
export async function suggestCategories(
  model: Model,
  untagged: readonly { text: string; amount?: number | null }[],
  examples: readonly { text: string; amount?: number | null; category: string }[],
  opts: { perCategory?: number; maxRows?: number } = {},
): Promise<{ suggestions: CategorySuggestion[]; unsure: number; failed: number }> {
  const categories = [...new Set(examples.map((e) => e.category))].sort();
  if (!categories.length) return { suggestions: [], unsure: 0, failed: 0 };
  const per = opts.perCategory ?? 3;
  const shown = categories.flatMap((c) => examples.filter((e) => e.category === c).slice(0, per));
  const show = (r: { text: string; amount?: number | null }) => `${r.text}${r.amount != null ? ` | ${r.amount}` : ""}`;
  const schema: JsonSchema = { type: "object", properties: { category: { type: "string", enum: [...categories, "not sure"] } }, required: ["category"] };
  const head = ["Pick the category for a ledger line, from the categories used in these tagged examples:", ...shown.map((e) => `- ${show(e)} → ${e.category}`)].join("\n");
  const suggestions: CategorySuggestion[] = [];
  let unsure = 0;
  let failed = 0;
  const limit = Math.min(untagged.length, opts.maxRows ?? 200);
  for (let i = 0; i < limit; i++) {
    try {
      const { category } = await ask<{ category: string }>(model, `${head}\n\nLine: ${show(untagged[i])}\nAnswer as JSON: {"category": "..."} (or "not sure")`, schema);
      if (category === "not sure") unsure++;
      else suggestions.push({ row: i, category });
    } catch {
      failed++;
    }
  }
  return { suggestions, unsure, failed };
}
