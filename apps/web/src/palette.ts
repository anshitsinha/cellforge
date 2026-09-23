import type { Action, JsonSchema } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { columnIndex } from "@cellforge/core";
import { iconSvg } from "./ui/icons";

/**
 * The command palette (Ctrl+K): one search box over everything cellforge
 * can do, grouped like the menus. With an empty query it shows Recent and
 * Suggested for this sheet, then every group to browse. A query ranks
 * whole-word matches first, and the last row hands the text to the AI
 * ("Ask AI: …"). Raw engine actions ("Action: cells.set") only show in
 * developer mode, with a form built from each action's schema.
 */

export interface Command {
  id: string;
  title: string;
  keys?: string;
  /** extra words to match, e.g. "bold strong" */
  hint?: string;
  run: () => unknown;
  /** menu group (File, Edit, …, AI, Help) */
  group?: string;
  /** one line saying what it does */
  description?: string;
  /** a ui/icons.ts name */
  icon?: string;
}

export interface PaletteDeps {
  commands: () => Command[];
  catalog: () => { type: string; title: string; schema: JsonSchema }[];
  run: (action: Action) => Promise<unknown>;
  range: () => CellRange;
  focusGrid: () => void;
  /** command ids worth suggesting for the sheet on screen */
  suggested?: () => string[];
  /** hand a request to the AI (the ask bar) */
  askAi?: (text: string) => void;
  /** show raw engine actions (developer mode) */
  dev?: () => boolean;
  /** group order for headers */
  groups?: readonly string[];
}

const RECENT_KEY = "cellforge.recentCommands";

export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...loadRecent().filter((x) => x !== id)].slice(0, 20)));
  } catch {
    // private mode: recents last for this tab
  }
}

/**
 * Fuzzy score: every query character in order in the text, rewarding word
 * starts and runs. -1 means no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    const wordStart = at === 0 || /[s.:/(-]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(3, (at - ti) * 0.1);
    ti = at + 1;
  }
  // whole-word prefix of the title counts most
  if (t.startsWith(query.toLowerCase())) score += 10;
  return score;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}→]+/u).filter(Boolean);

/**
 * How well a command matches a query (-1: not at all). The title is matched
 * fuzzily; hints, the description and the group only by whole words or
 * word starts, so a long hint can't match scattered letters. A query word
 * that is a whole word of the title or hint ranks above one that is only
 * the start of a different word ("ai" finds the AI commands before "Align").
 */
export function commandScore(query: string, c: Pick<Command, "title" | "hint" | "description" | "group">): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const qw = words(q);
  const title = words(c.title);
  const other = [...words(c.hint ?? ""), ...words(c.description ?? ""), ...words(c.group ?? "")];
  let wordScore = 0;
  for (const w of qw) {
    if (title.includes(w)) wordScore += 12;
    else if (other.includes(w)) wordScore += 9;
    else if (title.some((t) => t.startsWith(w))) wordScore += 6;
    else if (w.length >= 3 && other.some((t) => t.startsWith(w))) wordScore += 4;
    else {
      wordScore = -1;
      break;
    }
  }
  const fuzzy = fuzzyScore(q, c.title);
  if (wordScore < 0 && fuzzy < 0) return -1;
  // scattered letters in a title only count for longer queries that hit word starts ("bnk st")
  const fz = fuzzy >= 0 && (wordScore > 0 || (q.length >= 3 && fuzzy >= q.length * 3)) ? fuzzy : -1;
  if (wordScore < 0 && fz < 0) return -1;
  return Math.max(wordScore, 0) + (fz >= 0 ? fz * (wordScore > 0 ? 0.5 : 1) : 0);
}

export interface PaletteSection {
  title: string;
  items: Command[];
}

export interface PaletteView {
  sections: PaletteSection[];
  /** the "Ask AI: …" row's text, or null */
  askAi: string | null;
  /** index (in section order, Ask AI row last) selected first */
  initial: number;
  count: number;
}

/** Below this, nothing "matches well" and the Ask AI row is selected first. */
export const WEAK_MATCH = 9;

/** What the palette shows for a query: sections of commands, then the Ask AI row. Pure. */
export function paletteView(
  all: readonly Command[],
  query: string,
  opts: { recent?: readonly string[]; suggested?: readonly string[]; groups?: readonly string[]; max?: number; askAi?: boolean } = {},
): PaletteView {
  const q = query.trim();
  const groups = opts.groups ?? [];
  const order = (g: string | undefined) => {
    const i = groups.indexOf(g ?? "");
    return i < 0 ? groups.length : i;
  };
  const byGroup = (items: Command[]) => {
    const map = new Map<string, Command[]>();
    for (const c of items) {
      const g = c.group ?? "Commands";
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return map;
  };
  if (!q) {
    const byId = new Map(all.map((c) => [c.id, c]));
    const recent = (opts.recent ?? []).map((id) => byId.get(id)).filter((c): c is Command => !!c).slice(0, 5);
    const seen = new Set(recent.map((c) => c.id));
    const suggested = (opts.suggested ?? []).map((id) => byId.get(id)).filter((c): c is Command => !!c && !seen.has(c.id)).slice(0, 5);
    const sections: PaletteSection[] = [];
    if (recent.length) sections.push({ title: "Recent", items: recent });
    if (suggested.length) sections.push({ title: "Suggested for this sheet", items: suggested });
    const rest = [...byGroup([...all]).entries()].sort((a, b) => order(a[0]) - order(b[0]));
    for (const [g, items] of rest) sections.push({ title: g, items });
    return { sections, askAi: null, initial: 0, count: sections.reduce((n, s) => n + s.items.length, 0) };
  }
  const scored = all
    .map((c, i) => ({ c, i, s: commandScore(q, c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, opts.max ?? 40);
  const best = scored[0]?.s ?? 0;
  // groups in the order of their best hit; the best hit is first
  const groupBest = new Map<string, number>();
  for (const x of scored) {
    const g = x.c.group ?? "Commands";
    if (!groupBest.has(g)) groupBest.set(g, x.s);
  }
  const sections = [...byGroup(scored.map((x) => x.c)).entries()]
    .sort((a, b) => (groupBest.get(b[0]) ?? 0) - (groupBest.get(a[0]) ?? 0) || order(a[0]) - order(b[0]))
    .map(([title, items]) => ({ title, items }));
  const count = scored.length;
  const askAi = opts.askAi === false || q.length < 2 ? null : q;
  return { sections, askAi, initial: askAi && best < WEAK_MATCH ? count : 0, count };
}

const A1 = (r: CellRange) =>
  r.top === r.bottom && r.left === r.right
    ? `${columnLetter(r.left)}${r.top + 1}`
    : `${columnLetter(r.left)}${r.top + 1}:${columnLetter(r.right)}${r.bottom + 1}`;

function parseA1(text: string): CellRange | null {
  const m = /^\s*([A-Za-z]{1,3})(\d+)\s*(?::\s*([A-Za-z]{1,3})(\d+))?\s*$/.exec(text);
  if (!m) return null;
  const top = Number(m[2]) - 1;
  const left = columnIndex(m[1].toUpperCase());
  const bottom = m[4] ? Number(m[4]) - 1 : top;
  const right = m[3] ? columnIndex(m[3].toUpperCase()) : left;
  return { top: Math.min(top, bottom), bottom: Math.max(top, bottom), left: Math.min(left, right), right: Math.max(left, right) };
}

const isRange = (sch: JsonSchema) =>
  "type" in sch && sch.type === "object" && ["top", "left", "bottom", "right"].every((k) => k in sch.properties);

export function setupPalette(d: PaletteDeps): { open: (query?: string) => void; close: () => void; readonly isOpen: boolean } {
  let root: HTMLElement | null = null;

  function close() {
    root?.remove();
    root = null;
    d.focusGrid();
  }

  function entries(): Command[] {
    const commands = d.commands();
    if (!d.dev?.()) return commands;
    const actions: Command[] = d.catalog().map((a) => ({
      id: `action:${a.type}`,
      title: `Action: ${a.type}`,
      hint: a.title,
      description: a.title,
      group: "Developer: engine actions",
      icon: "formula",
      run: () => openForm(a),
    }));
    return [...commands, ...actions];
  }

  function open(initialQuery = "") {
    if (root) return;
    root = document.createElement("div");
    root.className = "palette-backdrop cf-palette-backdrop";
    root.innerHTML = `
      <div class="palette cf-palette" role="dialog" aria-label="Search commands and tools">
        <div class="cf-palette__search">
          ${iconSvg("search", { size: 18 })}
          <input type="text" class="palette-input" placeholder="Search commands and tools, or ask AI…" spellcheck="false" autocomplete="off"
            role="combobox" aria-expanded="true" aria-controls="cf-palette-list" aria-autocomplete="list" aria-label="Search commands and tools" />
          <kbd>Esc</kbd>
        </div>
        <ul class="palette-list" id="cf-palette-list" role="listbox" aria-label="Commands"></ul>
        <div class="cf-palette__foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> run</span><span><kbd>Ctrl</kbd><kbd>K</kbd> opens this anywhere</span></div>
      </div>`;
    document.body.append(root);
    const input = root.querySelector<HTMLInputElement>(".palette-input")!;
    const list = root.querySelector<HTMLUListElement>(".palette-list")!;
    input.value = initialQuery;
    const all = entries();
    const suggested = d.suggested?.() ?? [];
    let rows: ({ kind: "cmd"; c: Command } | { kind: "ask"; text: string })[] = [];
    let sel = 0;

    const paintSelection = () => {
      list.querySelectorAll<HTMLElement>("[role=option]").forEach((li, i) => {
        const on = i === sel;
        li.classList.toggle("selected", on);
        li.setAttribute("aria-selected", String(on));
        if (on) {
          input.setAttribute("aria-activedescendant", li.id);
          li.scrollIntoView({ block: "nearest" });
        }
      });
    };

    const hover = (i: number) => {
      if (sel === i) return;
      sel = i;
      paintSelection();
    };

    const item = (c: Command, i: number, section: string) => {
      const li = document.createElement("li");
      li.className = "palette-item";
      li.id = `cf-pal-${i}`;
      li.setAttribute("role", "option");
      const ic = document.createElement("span");
      ic.className = "cf-palette__icon";
      ic.innerHTML = iconSvg(c.icon ?? "play");
      const text = document.createElement("span");
      text.className = "cf-palette__text";
      const title = document.createElement("span");
      title.className = "cf-palette__title";
      title.textContent = c.title;
      text.append(title);
      if (c.description) {
        const small = document.createElement("small");
        small.textContent = c.description;
        text.append(small);
      }
      li.append(ic, text);
      // in Recent / Suggested, say which group a command lives in
      if (c.group && c.group !== section) {
        const tag = document.createElement("span");
        tag.className = "cf-palette__tag";
        tag.textContent = c.group;
        li.append(tag);
      }
      if (c.keys) {
        const k = document.createElement("kbd");
        k.textContent = c.keys;
        li.append(k);
      }
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      li.addEventListener("mousemove", () => hover(i));
      return li;
    };

    const render = (resetSelection: boolean) => {
      const view = paletteView(all, input.value, { recent: loadRecent(), suggested, groups: d.groups, askAi: !!d.askAi });
      rows = [];
      list.replaceChildren();
      for (const section of view.sections) {
        const head = document.createElement("li");
        head.className = "cf-palette__group";
        head.setAttribute("role", "presentation");
        head.textContent = section.title;
        list.append(head);
        for (const c of section.items) {
          list.append(item(c, rows.length, section.title));
          rows.push({ kind: "cmd", c });
        }
      }
      if (view.askAi) {
        const i = rows.length;
        rows.push({ kind: "ask", text: view.askAi });
        const li = document.createElement("li");
        li.className = "palette-item cf-palette__ask";
        li.id = `cf-pal-${i}`;
        li.setAttribute("role", "option");
        li.innerHTML = `<span class="cf-palette__icon">${iconSvg("sparkles")}</span><span class="cf-palette__text"><span class="cf-palette__title"></span><small>Hand this to the AI: it runs commands, writes formulas and answers questions</small></span><kbd>Ctrl /</kbd>`;
        li.querySelector(".cf-palette__title")!.textContent = `Ask AI: "${view.askAi}"`;
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          choose(i);
        });
        li.addEventListener("mousemove", () => hover(i));
        list.append(li);
      }
      if (!rows.length) {
        const li = document.createElement("li");
        li.className = "palette-empty";
        li.textContent = "Nothing matches.";
        list.append(li);
      }
      if (resetSelection) sel = view.initial;
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      paintSelection();
    };

    const choose = (i: number) => {
      const r = rows[i];
      if (!r) return;
      if (r.kind === "ask") {
        close();
        d.askAi?.(r.text);
        return;
      }
      const c = r.c;
      rememberCommand(c.id);
      const isForm = c.id.startsWith("action:");
      if (!isForm) close();
      void Promise.resolve(c.run());
    };

    input.addEventListener("input", () => render(true));
    input.addEventListener("keydown", (e) => {
      const n = Math.max(1, rows.length);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = (sel + 1) % n;
        paintSelection();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = (sel - 1 + n) % n;
        paintSelection();
      } else if (e.key === "PageDown" || e.key === "PageUp") {
        e.preventDefault();
        sel = Math.max(0, Math.min(rows.length - 1, sel + (e.key === "PageDown" ? 8 : -8)));
        paintSelection();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(sel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) close();
    });
    render(true);
    input.focus();
    input.select();
  }

  /** A form for one action, built from its schema; ranges default to the selection. */
  function openForm(a: { type: string; title: string; schema: JsonSchema }) {
    const box = root?.querySelector<HTMLElement>(".palette");
    if (!box || !("type" in a.schema) || a.schema.type !== "object") return;
    const props = Object.entries(a.schema.properties).filter(([k]) => k !== "sheet");
    const required = new Set(a.schema.required ?? []);
    box.innerHTML = `<form class="palette-form"><h3></h3><p></p><div class="fields"></div><output></output><div class="numfmt-actions"><button type="button" data-act="back">Back</button><button type="submit">Run</button></div></form>`;
    const form = box.querySelector("form")!;
    form.querySelector("h3")!.textContent = a.type;
    form.querySelector("p")!.textContent = a.title;
    const fields = form.querySelector<HTMLElement>(".fields")!;
    const out = form.querySelector("output")!;
    const readers: [string, () => unknown][] = [];
    for (const [name, raw] of props) {
      // "x or null": show x's control; empty means null when the field is required
      let sch = raw;
      let nullable = false;
      if ("anyOf" in raw) {
        const non = raw.anyOf.filter((x) => !("type" in x && x.type === "null"));
        if (non.length === 1 && non.length < raw.anyOf.length) {
          sch = non[0];
          nullable = true;
        }
      }
      const label = document.createElement("label");
      const caption = document.createElement("span");
      caption.textContent = name + (required.has(name) ? "" : " (optional)");
      label.append(caption);
      const desc = "description" in sch && sch.description ? sch.description : "";
      let read: () => unknown;
      if (isRange(sch)) {
        const input = document.createElement("input");
        input.value = A1(d.range());
        input.placeholder = "A1:B9";
        label.append(input);
        read = () => {
          const r = parseA1(input.value);
          if (!r) throw new Error(`${name}: write a range like B2:D9`);
          return r;
        };
      } else if ("type" in sch && sch.type === "boolean") {
        const input = document.createElement("input");
        input.type = "checkbox";
        label.append(input);
        read = () => (input.checked ? true : required.has(name) ? false : undefined);
      } else if ("type" in sch && sch.type === "string" && sch.enum) {
        const select = document.createElement("select");
        if (!required.has(name)) select.append(new Option("", ""));
        for (const v of sch.enum) select.append(new Option(v, v));
        label.append(select);
        read = () => select.value || undefined;
      } else if ("type" in sch && (sch.type === "integer" || sch.type === "number")) {
        const input = document.createElement("input");
        input.type = "number";
        if (name === "at" || name === "row") input.value = String(d.range().top);
        if (name === "col") input.value = String(d.range().left);
        label.append(input);
        read = () => (input.value === "" ? undefined : Number(input.value));
      } else if ("type" in sch && sch.type === "string") {
        const input = document.createElement("input");
        label.append(input);
        read = () => (input.value === "" ? undefined : input.value);
      } else {
        const ta = document.createElement("textarea");
        ta.rows = 3;
        ta.placeholder = "JSON";
        label.append(ta);
        read = () => {
          if (!ta.value.trim()) return undefined;
          try {
            return JSON.parse(ta.value);
          } catch {
            throw new Error(`${name}: not valid JSON`);
          }
        };
      }
      if (desc) {
        const small = document.createElement("small");
        small.textContent = desc;
        label.append(small);
      }
      fields.append(label);
      const base = read;
      readers.push([name, nullable && required.has(name) ? () => base() ?? null : base]);
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      try {
        const params: Record<string, unknown> = {};
        for (const [name, read] of readers) {
          const v = read();
          if (v !== undefined) params[name] = v;
        }
        void d.run({ type: a.type, params }).then((ok) => {
          if (ok) close();
          else out.textContent = "That didn't run; see the message at the bottom of the window.";
        });
      } catch (err) {
        out.textContent = (err as Error).message;
      }
    });
    form.querySelector<HTMLButtonElement>("[data-act=back]")!.addEventListener("click", () => {
      root?.remove();
      root = null;
      open();
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    (fields.querySelector("input, select, textarea") as HTMLElement | null)?.focus();
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (root) close();
      else open();
    }
  });

  return {
    open,
    close: () => {
      if (root) close();
    },
    get isOpen() {
      return !!root;
    },
  };
}
