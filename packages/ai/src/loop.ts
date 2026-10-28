/**
 * The tool loop: turn a request into a change that actually happened.
 *
 *   context → deterministic parser → (else) model proposes one action,
 *   constrained by a grammar built from the catalog → validate → run →
 *   verify → on any problem, tell the model what went wrong and retry.
 *
 * Everything with side effects is injected (`run`, `verify`, `undo`), and
 * so is the model, so the loop runs the same in tests with a fake model and
 * in the app with a local one. Every step is recorded in a transcript, for
 * the user ("here's what I did") and for evaluating models.
 */
import type { Action, JsonSchema } from "@cellforge/actions";
import { type AskContext, activeSheet, colCount, columnLetter } from "./context";
import { actionSchema } from "./grammar";
import { type Figure, type ParseResult, actionsOf, parse } from "./parse";
import { type CatalogEntry, describeProblems, validateAction } from "./validate";

/** A language model behind constrained decoding: it answers with text that matches the grammar. */
export interface Model {
  propose(prompt: string, grammar: JsonSchema): Promise<string>;
}

export interface LoopDeps {
  catalog: () => readonly CatalogEntry[];
  context: () => AskContext;
  /** apply an action (through history, so it can be undone); throws or returns false on failure */
  run: (action: Action) => Promise<unknown>;
  /**
   * After running: did it do what was asked? Return problems ([] = fine).
   * E.g. re-read the sheet and check the column is now sorted.
   */
  verify?: (action: Action, request: string, before: AskContext) => Promise<string[]> | string[];
  /** roll back the last run action, so a retry starts clean */
  undo?: () => Promise<unknown>;
  model?: Model;
  /** most model answers to try (default 3) */
  maxTries?: number;
  /** skip the deterministic parser (e.g. to evaluate a model on its own) */
  noParser?: boolean;
}

export type Step =
  | { kind: "context"; sheet: string; columns: number }
  | { kind: "parsed"; result: ParseResult }
  | { kind: "prompt"; attempt: number; prompt: string }
  | { kind: "proposed"; attempt: number; text: string }
  | { kind: "invalid"; attempt: number; problems: string[] }
  | { kind: "ran"; action: Action; source: "parser" | "model" }
  | { kind: "failed"; action: Action; problems: string[] }
  | { kind: "verified"; action: Action }
  | { kind: "rejected"; action: Action; problems: string[] }
  | { kind: "undone"; action: Action };

export type Status =
  /** the change was made and checked */
  | "done"
  /** the parser needs an answer first (see `missing`) */
  | "ask"
  /** run a palette command instead (see `command`) */
  | "command"
  /** a figure to show, not a change (see `figure`) */
  | "figure"
  /** nothing understood it and there is no model */
  | "unknown"
  /** the model never produced a working action */
  | "gave-up";

export interface Transcript {
  request: string;
  status: Status;
  steps: Step[];
  /** actions that ran and were kept */
  actions: Action[];
  explanation?: string;
  missing?: string[];
  command?: string;
  figure?: Figure;
  /** what went wrong last, in plain English */
  problems?: string[];
}

/** What the model sees about the workbook. */
export function describeContext(ctx: AskContext): string {
  const sheet = activeSheet(ctx);
  const cols = Array.from({ length: colCount(sheet) }, (_, c) => `${c} = ${columnLetter(c)}${sheet.columns[c] ? ` "${sheet.columns[c]}"` : ""}`);
  const sel = ctx.selection;
  return [
    `Sheets: ${ctx.sheets.map((s) => `${s.id} "${s.name}"${s.id === ctx.activeSheet ? " (on screen)" : ""}`).join(", ")}`,
    `Columns of "${sheet.name}" (0-based index = letter "header"): ${cols.join(", ")}`,
    `Rows: ${sheet.rowCount} (0-based)${sheet.headerRow >= 0 ? `; row ${sheet.headerRow} is the header` : "; the column names are not a row"}`,
    `Selection: rows ${sel.top}-${sel.bottom}, columns ${sel.left}-${sel.right} (0-based)`,
  ].join("\n");
}

/** The prompt for one model attempt. */
export function buildPrompt(request: string, ctx: AskContext, catalog: readonly CatalogEntry[], problems: readonly string[] = [], previous?: string): string {
  const tools = catalog.map((c) => `- ${c.type}: ${c.title}`).join("\n");
  const parts = [
    "You operate a spreadsheet by answering with exactly one action as JSON: {\"type\": ..., \"params\": {...}}.",
    "Rows and columns are 0-based (A = 0). Leave out \"sheet\" to act on the sheet on screen.",
    `Actions:\n${tools}`,
    `Workbook:\n${describeContext(ctx)}`,
    `Request: ${request}`,
  ];
  if (problems.length) parts.push(`Your previous answer was:\n${previous ?? "(none)"}\n${describeProblems(problems)}\nAnswer again, fixing these.`);
  return parts.join("\n\n");
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; problem: string } {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (e) {
    return { ok: false, problem: `The answer is not valid JSON (${(e as Error).message}).` };
  }
}

/** Run, then verify; undo when verification fails. Returns the problems ([] = kept). */
async function execute(deps: LoopDeps, action: Action, request: string, before: AskContext, source: "parser" | "model", steps: Step[]): Promise<string[]> {
  try {
    const ok = await deps.run(action);
    if (ok === false) {
      const problems = ["It didn't run (the app refused it)."];
      steps.push({ kind: "failed", action, problems });
      return problems;
    }
  } catch (e) {
    const problems = [(e as Error).message || String(e)];
    steps.push({ kind: "failed", action, problems });
    return problems;
  }
  steps.push({ kind: "ran", action, source });
  const problems = deps.verify ? await deps.verify(action, request, before) : [];
  if (problems.length) {
    steps.push({ kind: "rejected", action, problems });
    if (deps.undo) {
      await deps.undo();
      steps.push({ kind: "undone", action });
    }
    return problems;
  }
  steps.push({ kind: "verified", action });
  return [];
}

/** Handle one request from start to finish. */
export async function runRequest(request: string, deps: LoopDeps): Promise<Transcript> {
  const steps: Step[] = [];
  const done: Action[] = [];
  const ctx = deps.context();
  const sheet = activeSheet(ctx);
  steps.push({ kind: "context", sheet: sheet?.name ?? "", columns: sheet ? colCount(sheet) : 0 });
  const catalog = deps.catalog();
  let problems: string[] = [];
  let previous: string | undefined;

  // 1. the deterministic parser
  const parsed = deps.noParser ? null : parse(request, ctx);
  if (parsed) {
    steps.push({ kind: "parsed", result: parsed });
    if (parsed.missing.length) return { request, status: "ask", steps, actions: [], missing: parsed.missing };
    if (parsed.command) return { request, status: "command", steps, actions: [], command: parsed.command, explanation: parsed.explanation };
    if (parsed.figure) return { request, status: "figure", steps, actions: [], figure: parsed.figure, explanation: parsed.explanation };
    const actions = actionsOf(parsed);
    for (const a of actions) problems.push(...validateAction(a, catalog, ctx));
    if (!problems.length) {
      for (const a of actions) {
        const p = await execute(deps, a, request, ctx, "parser", steps);
        if (p.length) {
          problems = p;
          break;
        }
        done.push(a);
      }
      if (!problems.length) return { request, status: "done", steps, actions: done, explanation: parsed.explanation };
    }
    previous = JSON.stringify(actions.length === 1 ? actions[0] : actions);
    if (!deps.model) return { request, status: "gave-up", steps, actions: done, explanation: parsed.explanation, problems };
  }

  // 2. the model, constrained to the catalog
  if (!deps.model) return { request, status: "unknown", steps, actions: [] };
  const grammar = actionSchema(catalog);
  const tries = Math.max(1, deps.maxTries ?? 3);
  for (let attempt = 1; attempt <= tries; attempt++) {
    const prompt = buildPrompt(request, deps.context(), catalog, problems, previous);
    steps.push({ kind: "prompt", attempt, prompt });
    let text: string;
    try {
      text = await deps.model.propose(prompt, grammar);
    } catch (e) {
      problems = [`The model failed: ${(e as Error).message}`];
      steps.push({ kind: "invalid", attempt, problems });
      continue;
    }
    steps.push({ kind: "proposed", attempt, text });
    previous = text;
    const json = parseJson(text);
    if (!json.ok) {
      problems = [json.problem];
      steps.push({ kind: "invalid", attempt, problems });
      continue;
    }
    const now = deps.context();
    problems = validateAction(json.value, catalog, now);
    if (problems.length) {
      steps.push({ kind: "invalid", attempt, problems });
      continue;
    }
    const action = json.value as Action;
    problems = await execute(deps, action, request, now, "model", steps);
    if (!problems.length) {
      done.push(action);
      return { request, status: "done", steps, actions: done };
    }
  }
  return { request, status: "gave-up", steps, actions: done, problems };
}
