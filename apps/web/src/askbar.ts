/**
 * The ask bar (Ctrl+/): type what you want in plain English, see what will
 * happen, then Do it or Cancel. Common phrasings are understood by the
 * deterministic parser in @cellforge/ai, with no model. When it doesn't
 * understand, it says what it can do and suggests the closest palette
 * commands. With the local AI loaded (`model`), a request it doesn't know
 * goes through the tool loop instead (propose, validate, run, verify,
 * retry). Its empty state says what works with and without the AI, shows the
 * AI's state, and offers to set it up (`ai`).
 */
import "./askbar.css";
import type { Action } from "@cellforge/actions";
import {
  type AskContext,
  type CatalogEntry,
  EXAMPLES,
  type Model,
  type SheetInfo,
  actionsOf,
  editDistance,
  parse,
  runRequest,
  validateAction,
} from "@cellforge/ai";
import { type Command, fuzzyScore } from "./palette";
import type { EditableSource } from "./editable";
import type { Workbook } from "./workbook";

export interface AskBarDeps {
  /** the public actions (registry.catalog()) */
  catalog: () => readonly CatalogEntry[];
  /** the workbook as the parser sees it; see `askContext` */
  context: () => AskContext;
  /** run one action through history; false or a throw means it failed */
  run: (action: Action) => Promise<unknown>;
  /** the palette's commands, for "undo", "pivot" and suggestions */
  commands: () => Command[];
  focusGrid: () => void;
  /** the loaded local model, if any */
  model?: () => Model | null;
  /** the local AI's state, so the bar can say what it can do and offer to set it up */
  ai?: AskBarAi;
}

export interface AskBarAi {
  /** state is one of none, stored, downloading, paused, loading, ready, error */
  status: () => { state: string; label: string };
  /** be told when the state changes; returns an unsubscribe function */
  subscribe?: (cb: () => void) => () => void;
  /** open the AI panel */
  setup: () => void;
}

// ------------------------------------------------------------- context --

/** Header texts of a sheet: its own column names, or a first row of text. */
export function sheetInfo(id: string, name: string, src: EditableSource): SheetInfo {
  const used = Math.max(1, src.usedRange().cols);
  const base = { id, name, rowCount: src.rowCount, colCount: Math.max(src.colCount, 1) };
  if (src.getColumnName(0) !== undefined) {
    return { ...base, headerRow: -1, columns: Array.from({ length: used }, (_, c) => src.getColumnName(c) ?? "") };
  }
  const first = Array.from({ length: used }, (_, c) => src.getCell(0, c));
  const texts = first.filter((v) => v !== null && v !== undefined && v !== "");
  // a header row: text in most of the used columns and nothing else there
  const header = src.rowCount > 1 && texts.length > 0 && texts.length * 2 >= used && texts.every((v) => typeof v === "string");
  return { ...base, headerRow: header ? 0 : -1, columns: header ? first.map((v) => (typeof v === "string" ? v.trim() : "")) : [] };
}

/** The ask context for a workbook, the sheet on screen and its selection. */
export function askContext(workbook: Workbook, activeId: string, selection: { top: number; left: number; bottom: number; right: number }): AskContext {
  return {
    sheets: workbook.sheets.map((s) => sheetInfo(s.id, s.name, s.source)),
    activeSheet: activeId,
    selection: {
      top: Math.min(selection.top, selection.bottom),
      bottom: Math.max(selection.top, selection.bottom),
      left: Math.min(selection.left, selection.right),
      right: Math.max(selection.left, selection.right),
    },
  };
}

// ------------------------------------------------------------ examples --

const AMOUNT = /amount|total|value|debit|credit|balance|price|net|gross|cost|sales|revenue/i;
const DATE = /date|period|month|posted|year/i;
const GROUP = /vendor|supplier|customer|client|account|category|region|department|dept|payee|type|status|entity|cost cent/i;
const KEY = /\bref\b|invoice|number|^no\.?$|\bid\b|document|\bdoc\b|voucher|receipt|journal/i;

/**
 * Example requests for the sheet on screen, using its own column names
 * ("sum of amount by vendor"), so every example works when clicked. Falls
 * back to the generic examples when the sheet has no header row.
 */
export function sheetExamples(ctx: AskContext, max = 8): string[] {
  const sheet = ctx.sheets.find((s) => s.id === ctx.activeSheet) ?? ctx.sheets[0];
  const cols = (sheet?.columns ?? []).map((c) => c.trim()).filter((c) => c && /^[\p{L}\p{N} _#.-]+$/u.test(c));
  if (cols.length < 2) return EXAMPLES.slice(0, max);
  const name = (c: string) => c.toLowerCase();
  const amount = cols.find((c) => AMOUNT.test(c));
  const date = cols.find((c) => c !== amount && DATE.test(c));
  const key = cols.find((c) => c !== amount && c !== date && KEY.test(c));
  const group = cols.find((c) => c !== amount && c !== date && c !== key && GROUP.test(c)) ?? cols.find((c) => c !== amount && c !== date && c !== key);
  const out: string[] = [];
  if (amount) out.push(`sort by ${name(amount)} descending`);
  if (amount && group) out.push(`sum of ${name(amount)} by ${name(group)}`);
  if (amount) out.push(`filter ${name(amount)} > 1000`, `highlight ${name(amount)} over 10000 in red`);
  if (key) out.push(`find duplicates in ${name(key)}`);
  if (date) out.push(`sort by ${name(date)}`);
  if (group) out.push(`show blanks in ${name(group)}`);
  out.push("freeze top row", "bold the header row");
  return [...new Set(out)].slice(0, max);
}

// ---------------------------------------------------------------- plan --

const STOP = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "to", "for", "by", "with", "my", "me", "this", "that", "these", "all", "please", "can", "you", "how", "do", "i", "is", "it", "what", "want", "make", "show"]);

/** Palette commands closest to a request, by shared words (and close spellings). */
export function suggestCommands(text: string, commands: readonly Command[], max = 5): Command[] {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  if (!words.length) return [];
  const scored = commands.map((c) => {
    const target = `${c.title} ${c.hint ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    let score = 0;
    for (const w of words) {
      let best = 0;
      for (const t of target) {
        if (t === w) best = Math.max(best, 4);
        else if (t.startsWith(w) || (w.startsWith(t) && t.length >= 4)) best = Math.max(best, 3);
        else if (w.length >= 5 && editDistance(w, t) <= 1) best = Math.max(best, 2);
      }
      score += best;
    }
    return { c, score: score + Math.max(0, fuzzyScore(text, c.title)) * 0.01 };
  });
  return scored
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.c);
}

export type Plan =
  | { kind: "empty" }
  | { kind: "ready"; actions: Action[]; explanation: string; confidence: number }
  | { kind: "command"; command: Command | null; id: string; explanation: string }
  | { kind: "ask"; questions: string[] }
  | { kind: "problems"; explanation: string; problems: string[] }
  | { kind: "unknown"; suggestions: Command[]; canAskModel: boolean };

/** What the ask bar would do with this text (no side effects). */
export function planFor(text: string, d: Pick<AskBarDeps, "catalog" | "context" | "commands" | "model">): Plan {
  if (!text.trim()) return { kind: "empty" };
  const ctx = d.context();
  const r = parse(text, ctx);
  if (!r) return { kind: "unknown", suggestions: suggestCommands(text, d.commands()), canAskModel: !!d.model?.() };
  if (r.missing.length) return { kind: "ask", questions: r.missing };
  if (r.command) return { kind: "command", id: r.command, command: d.commands().find((c) => c.id === r.command) ?? null, explanation: r.explanation };
  const actions = actionsOf(r);
  const catalog = d.catalog();
  const problems = actions.flatMap((a) => validateAction(a, catalog, ctx));
  if (problems.length) return { kind: "problems", explanation: r.explanation, problems };
  return { kind: "ready", actions, explanation: r.explanation, confidence: r.confidence };
}

// ------------------------------------------------------------------ UI --

export function setupAskBar(d: AskBarDeps): { open: (text?: string) => void; close: () => void } {
  let root: HTMLElement | null = null;
  let unsubscribe: (() => void) | null = null;

  function close() {
    unsubscribe?.();
    unsubscribe = null;
    root?.remove();
    root = null;
    d.focusGrid();
  }

  function open(initial = "") {
    if (root) {
      root.querySelector<HTMLInputElement>(".askbar-input")?.focus();
      return;
    }
    root = document.createElement("div");
    root.className = "palette-backdrop askbar-backdrop";
    root.innerHTML = `
      <div class="palette askbar" role="dialog" aria-label="Ask or do">
        <input type="text" class="palette-input askbar-input" placeholder="Ask or do…" spellcheck="false" autocomplete="off" aria-describedby="askbar-body" />
        <div class="askbar-body" id="askbar-body" aria-live="polite"></div>
        <div class="askbar-buttons">
          <button type="button" data-act="cancel">Cancel</button>
          <button type="button" data-act="do" class="askbar-do">Do it</button>
        </div>
      </div>`;
    document.body.append(root);
    const backdrop = root;
    const input = root.querySelector<HTMLInputElement>(".askbar-input")!;
    const body = root.querySelector<HTMLElement>(".askbar-body")!;
    const doBtn = root.querySelector<HTMLButtonElement>("[data-act=do]")!;
    const cancelBtn = root.querySelector<HTMLButtonElement>("[data-act=cancel]")!;
    let plan: Plan = { kind: "empty" };
    let busy = false;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };

    const exampleList = (items: readonly string[]) => {
      const ul = el("ul", "askbar-examples");
      for (const x of items) {
        const li = el("li", "");
        const b = el("button", "askbar-link", x);
        b.type = "button";
        b.addEventListener("click", () => {
          input.value = x;
          refresh();
          input.focus();
        });
        li.append(b);
        ul.append(li);
      }
      return ul;
    };

    const examples = (max: number) => {
      try {
        return sheetExamples(d.context(), max);
      } catch {
        return EXAMPLES.slice(0, max);
      }
    };

    const columnNames = (): string[] => {
      try {
        const ctx = d.context();
        const sheet = ctx.sheets.find((s) => s.id === ctx.activeSheet);
        return (sheet?.columns ?? []).filter((c) => c.trim()).slice(0, 20);
      } catch {
        return [];
      }
    };

    /** What the local AI adds, its state, and the way to set it up. */
    const aiBox = (afterUnknown = false): HTMLElement | null => {
      const ai = d.ai;
      if (!ai) return null;
      const s = ai.status();
      const box = el("div", `askbar-ai askbar-ai-${s.state}`);
      const dot = el("span", "askbar-ai-dot");
      dot.setAttribute("aria-hidden", "true");
      const text = el("p", "");
      let action = "Manage the local AI…";
      switch (s.state) {
        case "ready":
          text.textContent = `Local AI ready: ${s.label.replace(/^Ready: /, "").replace(/ \((GPU|CPU)\)$/,(_, b: string) => (b === "GPU" ? ", on the graphics card" : ", on the processor"))}. Requests I don't recognise go to it; it runs on this computer.`;
          break;
        case "loading":
        case "downloading":
          text.textContent = `${s.label} When it's ready, requests I don't recognise go to it.`;
          action = "Show progress…";
          break;
        case "stored":
          text.textContent = `Local AI: ${s.label}. Requests I don't recognise go to it.`;
          break;
        case "paused":
          text.textContent = "The local AI's download is paused.";
          action = "Resume the download…";
          break;
        case "error":
          text.textContent = "The local AI needs attention.";
          action = "See what happened…";
          break;
        default:
          text.textContent = afterUnknown
            ? "With the local AI you can ask in your own words instead. It runs on this computer; nothing you type is sent anywhere."
            : "These work without AI. Set up the local AI to also ask in your own words, explain numbers and suggest categories. It runs on this computer; nothing you type is sent anywhere.";
          action = "Set up the local AI…";
      }
      const b = el("button", s.state === "none" ? "btn-primary btn-sm askbar-ai-setup" : "askbar-link", action);
      b.type = "button";
      b.addEventListener("click", () => {
        close();
        ai.setup();
      });
      box.append(dot, text, b);
      return box;
    };

    const render = () => {
      body.replaceChildren();
      doBtn.disabled = true;
      doBtn.textContent = "Do it";
      switch (plan.kind) {
        case "empty": {
          body.append(el("p", "askbar-muted", "Say what you want done, for example:"), exampleList(examples(8)));
          const box = aiBox();
          if (box) body.append(box);
          break;
        }
        case "ready":
          body.append(el("p", "askbar-explain", plan.explanation));
          if (plan.confidence < 0.8) body.append(el("p", "askbar-muted", "I'm not completely sure this is what you meant, so check it before you press Do it."));
          doBtn.disabled = false;
          break;
        case "command":
          body.append(el("p", "askbar-explain", plan.explanation));
          if (plan.command) {
            doBtn.disabled = false;
            doBtn.textContent = plan.id === "undo" || plan.id === "redo" ? "Do it" : "Open";
          } else body.append(el("p", "askbar-problem", "That command isn't available right now."));
          break;
        case "ask": {
          for (const q of plan.questions) body.append(el("p", "askbar-question", q));
          // a column it couldn't find: show the ones there are
          if (plan.questions.some((q) => /column/i.test(q))) {
            const cols = columnNames();
            if (cols.length) body.append(el("p", "askbar-muted", `Columns on this sheet: ${cols.join(", ")}.`));
          }
          if (!d.model?.()) {
            const box = aiBox(true);
            if (box) body.append(box);
          }
          break;
        }
        case "problems": {
          if (plan.explanation) body.append(el("p", "askbar-explain", plan.explanation));
          body.append(el("p", "askbar-problem", "This can't run as it is:"));
          const ul = el("ul", "askbar-problems");
          for (const p of plan.problems) ul.append(el("li", "", p));
          body.append(ul);
          break;
        }
        case "unknown": {
          if (plan.canAskModel) {
            body.append(el("p", "askbar-explain", "That isn't one of the phrasings I know, so I'll ask the local model. You can undo whatever it does."));
            doBtn.disabled = false;
            doBtn.textContent = "Ask the model";
          } else {
            const state = d.ai?.status().state;
            const notYet = state === "loading" || state === "downloading" || state === "stored";
            body.append(
              el(
                "p",
                "askbar-question",
                notYet
                  ? "I don't know that phrasing, and the local AI isn't ready yet, so for now I understand requests like these:"
                  : "I don't know how to do that yet. No AI model is loaded, so I understand requests like these:",
              ),
              exampleList(examples(6)),
            );
          }
          if (plan.suggestions.length) {
            body.append(el("p", "askbar-muted", "Or one of these commands:"));
            const ul = el("ul", "askbar-suggestions");
            for (const c of plan.suggestions) {
              const li = el("li", "");
              const b = el("button", "askbar-link", c.title);
              b.type = "button";
              b.addEventListener("click", () => {
                close();
                void Promise.resolve(c.run());
              });
              li.append(b);
              if (c.keys) li.append(el("kbd", "", c.keys));
              ul.append(li);
            }
            body.append(ul);
          }
          if (!plan.canAskModel) {
            const box = aiBox(true);
            if (box) body.append(box);
          }
          break;
        }
      }
    };

    const refresh = () => {
      if (busy) return;
      try {
        plan = planFor(input.value, d);
      } catch (e) {
        plan = { kind: "problems", explanation: "", problems: [(e as Error).message] };
      }
      render();
    };

    const fail = (message: string) => {
      body.append(el("p", "askbar-problem", `That didn't work: ${message}`));
    };

    const doIt = async () => {
      if (busy || doBtn.disabled) return;
      busy = true;
      doBtn.disabled = true;
      try {
        if (plan.kind === "ready") {
          for (const a of plan.actions) {
            const ok = await d.run(a);
            if (ok === false) {
              fail("the app refused it; see the status bar.");
              return;
            }
          }
          close();
        } else if (plan.kind === "command" && plan.command) {
          const c = plan.command;
          close();
          await Promise.resolve(c.run());
        } else if (plan.kind === "unknown" && plan.canAskModel) {
          const model = d.model?.();
          if (!model) return;
          body.replaceChildren(el("p", "askbar-muted", "Asking the model…"));
          const t = await runRequest(input.value, { catalog: d.catalog, context: d.context, run: d.run, model });
          if (t.status === "done") close();
          else if (t.status === "ask") body.replaceChildren(...(t.missing ?? []).map((q) => el("p", "askbar-question", q)));
          else body.replaceChildren(el("p", "askbar-problem", `The model couldn't do it${t.problems?.length ? `: ${t.problems.join(" ")}` : "."}`));
        }
      } catch (e) {
        fail((e as Error).message);
      } finally {
        busy = false;
        if (root === backdrop && plan.kind === "ready") doBtn.disabled = false;
      }
    };

    let timer = 0;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 80);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(timer);
        refresh();
        void doIt();
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    doBtn.addEventListener("click", () => void doIt());
    cancelBtn.addEventListener("click", close);
    root.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) close();
    });
    input.value = initial;
    refresh();
    input.focus();
    // keep the AI line current (a download or load finishing while the bar is open)
    let lastState = d.ai?.status().state;
    unsubscribe =
      d.ai?.subscribe?.(() => {
        const st = d.ai!.status().state;
        if (st === lastState || busy || root !== backdrop) return;
        lastState = st;
        if (plan.kind === "empty" || plan.kind === "unknown") refresh();
      }) ?? null;
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "/" || e.code === "Slash")) {
      e.preventDefault();
      if (root) close();
      else open();
    }
  });

  return { open, close };
}
