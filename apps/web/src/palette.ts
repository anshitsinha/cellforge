import type { Action, JsonSchema } from "@cellforge/actions";
import { type CellRange, columnLetter } from "@cellforge/grid";
import { columnIndex } from "@cellforge/core";

/**
 * The command palette (Ctrl+K): one search box over everything cellforge
 * can do. App commands act on the selection; "Action:" entries are the raw
 * public actions (the same list the AI gets as tools) with a form built
 * from each action's schema.
 */

export interface Command {
  id: string;
  title: string;
  keys?: string;
  /** extra words to match, e.g. "bold strong" */
  hint?: string;
  run: () => unknown;
}

export interface PaletteDeps {
  commands: () => Command[];
  catalog: () => { type: string; title: string; schema: JsonSchema }[];
  run: (action: Action) => Promise<unknown>;
  range: () => CellRange;
  focusGrid: () => void;
}

const RECENT_KEY = "cellforge.recentCommands";

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, 20)));
  } catch {
    // private mode: recents last for this tab
  }
}

/**
 * Fuzzy score: every query character in order in the text, rewarding word
 * starts and runs. -1 means no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    const wordStart = at === 0 || /[\s.:/(-]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    score += 1 + (wordStart ? 3 : 0) + run * 2 - Math.min(3, (at - ti) * 0.1);
    ti = at + 1;
  }
  // whole-word prefix of the title counts most
  if (t.startsWith(query.toLowerCase())) score += 10;
  return score;
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

export function setupPalette(d: PaletteDeps): { open: () => void } {
  let root: HTMLElement | null = null;

  function close() {
    root?.remove();
    root = null;
    d.focusGrid();
  }

  function remember(id: string) {
    saveRecent([id, ...loadRecent().filter((x) => x !== id)]);
  }

  function entries(): Command[] {
    const actions: Command[] = d.catalog().map((a) => ({
      id: `action:${a.type}`,
      title: `Action: ${a.type}`,
      hint: a.title,
      run: () => openForm(a),
    }));
    return [...d.commands(), ...actions];
  }

  function open() {
    if (root) return;
    root = document.createElement("div");
    root.className = "palette-backdrop";
    root.innerHTML = `
      <div class="palette" role="dialog" aria-label="Command palette">
        <input type="text" class="palette-input" placeholder="Type a command or action…" spellcheck="false" autocomplete="off" />
        <ul class="palette-list" role="listbox"></ul>
      </div>`;
    document.body.append(root);
    const input = root.querySelector<HTMLInputElement>(".palette-input")!;
    const list = root.querySelector<HTMLUListElement>(".palette-list")!;
    const all = entries();
    let shown: Command[] = [];
    let sel = 0;

    const render = () => {
      const q = input.value.trim();
      const recent = loadRecent();
      if (!q) {
        const byId = new Map(all.map((c) => [c.id, c]));
        const rec = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
        shown = [...rec, ...all.filter((c) => !recent.includes(c.id))];
      } else {
        shown = all
          .map((c) => ({ c, s: Math.max(fuzzyScore(q, c.title), fuzzyScore(q, c.hint ?? "") - 4) }))
          .filter((x) => x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.c);
      }
      shown = shown.slice(0, 60);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = "";
      shown.forEach((c, i) => {
        const li = document.createElement("li");
        li.className = "palette-item" + (i === sel ? " selected" : "");
        li.setAttribute("role", "option");
        const title = document.createElement("span");
        title.textContent = c.title;
        li.append(title);
        if (c.hint && c.id.startsWith("action:")) {
          const hint = document.createElement("small");
          hint.textContent = c.hint;
          li.append(hint);
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
        list.append(li);
      });
      if (!shown.length) {
        const li = document.createElement("li");
        li.className = "palette-empty";
        li.textContent = "Nothing matches.";
        list.append(li);
      }
      list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    };

    const choose = (i: number) => {
      const c = shown[i];
      if (!c) return;
      remember(c.id);
      const isForm = c.id.startsWith("action:");
      if (!isForm) close();
      void Promise.resolve(c.run());
    };

    input.addEventListener("input", () => {
      sel = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sel = Math.min(shown.length - 1, sel + 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        sel = Math.max(0, sel - 1);
        render();
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
    render();
    input.focus();
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
          else out.textContent = "That didn't run; see the status bar.";
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

  return { open };
}
