/**
 * Help while typing a formula: function names suggested as you type, and
 * the arguments of the function you're inside, with the current one in
 * bold. Works on any <input> (the formula bar and the in-cell editor).
 */
import { FUNCTION_INFO, signature, type FunctionInfo } from "@cellforge/core";

export type Assist =
  | { kind: "names"; prefix: string; start: number; matches: FunctionInfo[] }
  | { kind: "args"; fn: FunctionInfo; index: number }
  | null;

const NAMES = Object.values(FUNCTION_INFO).sort((a, b) => a.name.localeCompare(b.name));

/** Is position `i` of `text` inside a "string literal"? */
function inString(text: string, i: number): boolean {
  let open = false;
  for (let k = 0; k < i; k++) if (text[k] === '"') open = !open;
  return open;
}

/** What help fits the caret position in a formula. */
export function analyze(text: string, caret: number): Assist {
  if (!text.startsWith("=") || inString(text, caret)) return null;
  const before = text.slice(0, caret);
  // a name being typed: letters right before the caret, not part of a
  // reference (A1, Sheet1!B2) and not directly followed by "("
  const m = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(before);
  if (m) {
    const start = caret - m[1].length;
    const prev = text[start - 1] ?? "";
    const isRef = /^[A-Za-z]{1,3}\d+$/.test(m[1]) || prev === "!" || prev === ":" || prev === "$";
    if (!isRef && text[caret] !== "(") {
      const prefix = m[1].toUpperCase();
      const matches = NAMES.filter((f) => f.name.startsWith(prefix));
      if (matches.length && !(matches.length === 1 && matches[0].name === prefix && text[caret] === "(")) {
        return { kind: "names", prefix, start, matches };
      }
    }
  }
  // inside a call: the nearest unclosed "(" and which argument we're on
  let depth = 0;
  let commas = 0;
  let quoted = false;
  for (let k = caret - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === ")") depth++;
    else if (ch === "(") {
      if (depth === 0) {
        const name = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(text.slice(0, k))?.[1]?.toUpperCase();
        const fn = name ? FUNCTION_INFO[name] : undefined;
        if (!fn) return null;
        return { kind: "args", fn, index: commas };
      }
      depth--;
    } else if (ch === "," && depth === 0) commas++;
  }
  return null;
}

/** The argument a position stands for (repeating arguments cover the rest). */
export function argAt(fn: FunctionInfo, index: number): number {
  if (index < fn.args.length) return index;
  const rep = fn.args.findIndex((a) => a.repeats);
  return rep >= 0 ? rep : -1;
}

export function attachFormulaAssist(input: HTMLInputElement): void {
  const pop = document.createElement("div");
  pop.className = "fx-assist";
  pop.hidden = true;
  document.body.append(pop);
  let state: Assist = null;
  let sel = 0;

  const hide = () => {
    pop.hidden = true;
    state = null;
  };

  const place = () => {
    const r = input.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 380))}px`;
    pop.style.top = `${r.bottom + 2}px`;
  };

  const render = () => {
    state = analyze(input.value, input.selectionStart ?? input.value.length);
    if (!state || document.activeElement !== input) return hide();
    pop.innerHTML = "";
    if (state.kind === "names") {
      sel = Math.min(sel, state.matches.length - 1);
      state.matches.slice(0, 8).forEach((f, i) => {
        const row = document.createElement("div");
        row.className = "fx-item" + (i === sel ? " selected" : "");
        const name = document.createElement("strong");
        name.textContent = f.name;
        const sum = document.createElement("span");
        sum.textContent = f.summary;
        row.append(name, sum);
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          sel = i;
          accept();
        });
        pop.append(row);
      });
      const tip = document.createElement("div");
      tip.className = "fx-tip";
      tip.textContent = "Tab to insert";
      pop.append(tip);
    } else {
      const { fn, index } = state;
      const active = argAt(fn, index);
      const sig = document.createElement("div");
      sig.className = "fx-sig";
      sig.append(`${fn.name}(`);
      fn.args.forEach((a, i) => {
        if (i) sig.append(", ");
        const label = a.repeats ? `${a.name}, …` : a.name;
        const text = a.optional ? `[${label}]` : label;
        if (i === active) {
          const b = document.createElement("b");
          b.textContent = text;
          sig.append(b);
        } else sig.append(text);
      });
      sig.append(")");
      pop.append(sig);
      if (active >= 0) {
        const d = document.createElement("div");
        d.className = "fx-desc";
        d.textContent = `${fn.args[active].name}: ${fn.args[active].description}`;
        pop.append(d);
      } else {
        const d = document.createElement("div");
        d.className = "fx-desc";
        d.textContent = `${fn.name} takes ${fn.args.length} argument${fn.args.length === 1 ? "" : "s"}.`;
        pop.append(d);
      }
    }
    place();
    pop.hidden = false;
  };

  const accept = () => {
    if (!state || state.kind !== "names") return;
    const f = state.matches[sel];
    const caret = input.selectionStart ?? input.value.length;
    const v = input.value;
    const after = v.slice(caret).startsWith("(") ? "" : "(";
    input.value = v.slice(0, state.start) + f.name + after + v.slice(caret);
    const pos = state.start + f.name.length + 1;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    sel = 0;
    render();
  };

  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("click", render);
  input.addEventListener("keyup", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") render();
  });
  input.addEventListener("blur", hide);
  // capture phase, so these keys reach us before the editor commits the cell
  input.addEventListener(
    "keydown",
    (e) => {
      if (!state || state.kind !== "names" || pop.hidden) return;
      const n = Math.min(8, state.matches.length);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        sel = (sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      } else if (e.key === "Tab" || (e.key === "Enter" && state.matches[sel].name !== state.prefix)) {
        accept();
      } else if (e.key === "Escape") {
        hide();
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state) render();
    },
    true,
  );
}

export { signature };
