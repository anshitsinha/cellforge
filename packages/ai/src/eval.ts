/**
 * The eval harness: a set of requests with the answer each should get, run
 * through an answerer (the parser, a model, or both through the ask loop),
 * scored for accuracy and time-to-answer per category.
 *
 * Answers are compared by what they would do, not how they were found: the
 * same actions, the same question back to the user, or the same command.
 */
import type { Action } from "@cellforge/actions";
import type { AskContext } from "./context";
import { type Model, runRequest } from "./loop";
import { type Figure, actionsOf, parse } from "./parse";
import type { CatalogEntry } from "./validate";

/** What a request should become: actions, a question back (matching the pattern), a command, or nothing. */
export type Expected = { actions: unknown[] } | { ask: RegExp } | { command: string } | { figure: FigureKey } | null;

/** What identifies a figure answer: the function, the column and the sheet. */
export interface FigureKey {
  fn: string;
  col: number;
  sheet?: string;
}

const figureKey = (f: Figure): FigureKey => (f.sheet ? { fn: f.fn, col: f.col, sheet: f.sheet } : { fn: f.fn, col: f.col });

export interface EvalCase {
  category: string;
  text: string;
  want: Expected;
}

/** What an answerer came back with. */
export type Answer = { actions: unknown[] } | { ask: string } | { command: string } | { figure: FigureKey } | null;

export type Answerer = (text: string) => Answer | Promise<Answer>;

export interface CategoryScore {
  category: string;
  cases: number;
  correct: number;
  /** total and slowest milliseconds to answer */
  totalMs: number;
  maxMs: number;
}

export interface EvalFailure {
  category: string;
  text: string;
  want: string;
  got: string;
}

export interface EvalReport {
  name: string;
  categories: CategoryScore[];
  cases: number;
  correct: number;
  accuracy: number;
  meanMs: number;
  failures: EvalFailure[];
}

const show = (v: unknown): string => (v instanceof RegExp ? String(v) : JSON.stringify(v));

/** Does an answer match what was wanted? */
export function answerMatches(want: Expected, got: Answer): boolean {
  if (want === null) return got === null;
  if (got === null) return false;
  if ("ask" in want) return "ask" in got && want.ask.test(got.ask);
  if ("command" in want) return "command" in got && got.command === want.command;
  if ("figure" in want) return "figure" in got && deepEqual(got.figure, want.figure);
  return "actions" in got && deepEqual(got.actions, want.actions);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Run every case through an answerer and score it. */
export async function runEval(name: string, cases: readonly EvalCase[], answer: Answerer, now: () => number = () => performance.now()): Promise<EvalReport> {
  const byCat = new Map<string, CategoryScore>();
  const failures: EvalFailure[] = [];
  let correct = 0;
  let totalMs = 0;
  for (const c of cases) {
    const t0 = now();
    let got: Answer;
    try {
      got = await answer(c.text);
    } catch (e) {
      got = { ask: `error: ${(e as Error).message}` };
    }
    const ms = now() - t0;
    totalMs += ms;
    let s = byCat.get(c.category);
    if (!s) byCat.set(c.category, (s = { category: c.category, cases: 0, correct: 0, totalMs: 0, maxMs: 0 }));
    s.cases++;
    s.totalMs += ms;
    s.maxMs = Math.max(s.maxMs, ms);
    if (answerMatches(c.want, got)) {
      s.correct++;
      correct++;
    } else failures.push({ category: c.category, text: c.text, want: show(c.want), got: show(got) });
  }
  return {
    name,
    categories: [...byCat.values()],
    cases: cases.length,
    correct,
    accuracy: cases.length ? correct / cases.length : 1,
    meanMs: cases.length ? totalMs / cases.length : 0,
    failures,
  };
}

/** The deterministic parser as an answerer. */
export function parserAnswerer(context: () => AskContext): Answerer {
  return (text) => {
    const r = parse(text, context());
    if (!r) return null;
    if (r.missing.length) return { ask: r.missing.join(" ") };
    if (r.command) return { command: r.command };
    if (r.figure) return { figure: figureKey(r.figure) };
    return { actions: actionsOf(r) };
  };
}

/**
 * The ask loop as an answerer: the parser first, then the model for what the
 * parser can't do (or the model alone with `noParser`). Actions are recorded,
 * not run.
 */
export function loopAnswerer(opts: { context: () => AskContext; catalog: () => readonly CatalogEntry[]; model?: Model; noParser?: boolean; maxTries?: number }): Answerer {
  return async (text) => {
    const ran: Action[] = [];
    const t = await runRequest(text, {
      catalog: opts.catalog,
      context: opts.context,
      run: async (a) => {
        ran.push(a);
        return true;
      },
      model: opts.model,
      noParser: opts.noParser,
      maxTries: opts.maxTries ?? 1,
    });
    if (t.status === "ask") return { ask: (t.missing ?? []).join(" ") };
    if (t.status === "command") return { command: t.command ?? "" };
    if (t.status === "figure" && t.figure) return { figure: figureKey(t.figure) };
    if (t.status === "done") return { actions: ran };
    return null;
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => (n < 10 ? n.toFixed(2) : n.toFixed(0));

/** A report as a Markdown table (plus the misses). */
export function formatReport(r: EvalReport): string {
  const lines = [
    `## ${r.name}`,
    "",
    `${r.correct} of ${r.cases} right (${pct(r.accuracy)}); ${ms(r.meanMs)} ms per request on average.`,
    "",
    "| Category | Cases | Right | Accuracy | Mean ms | Slowest ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...r.categories.map((c) => `| ${c.category} | ${c.cases} | ${c.correct} | ${pct(c.correct / c.cases)} | ${ms(c.totalMs / c.cases)} | ${ms(c.maxMs)} |`),
  ];
  if (r.failures.length) {
    lines.push("", "Misses:", "");
    for (const f of r.failures) lines.push(`- (${f.category}) "${f.text}": wanted ${f.want}, got ${f.got}`);
  }
  return lines.join("\n");
}
