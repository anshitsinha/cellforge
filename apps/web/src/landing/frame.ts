/** Small DOM helpers for the app-window frames on the landing page. */

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const k of kids) if (k !== null && k !== false && k !== undefined) el.append(k);
  return el;
}

/**
 * The sheet tabs at the foot of a frame, as in the app. Arrow keys move
 * between them (one tab stop for the whole strip).
 */
export function sheetTabs(frame: HTMLElement, names: string[], onPick: (i: number) => void, active = 0): { set(i: number): void; get(): number } {
  const strip = frame.querySelector<HTMLElement>(".af-tabs")!;
  strip.replaceChildren();
  strip.setAttribute("role", "tablist");
  let current = active;
  const buttons = names.map((name, i) => {
    const b = h("button", { type: "button", class: "af-tab", textContent: name });
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => pick(i));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = (current + d + names.length) % names.length;
      pick(n);
      buttons[n].focus();
    });
    strip.append(b);
    return b;
  });
  const mark = () =>
    buttons.forEach((b, i) => {
      b.classList.toggle("active", i === current);
      b.setAttribute("aria-selected", String(i === current));
      b.tabIndex = i === current ? 0 : -1;
    });
  const pick = (i: number) => {
    if (i === current) return;
    current = i;
    mark();
    onPick(i);
  };
  mark();
  return {
    set(i) {
      if (i === current) return;
      current = i;
      mark();
      onPick(i);
    },
    get: () => current,
  };
}

export const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const isDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";

/** Count a number up from 0 (or just show it, with reduced motion). */
export function countUp(el: HTMLElement, to: number, dp = 0, ms = 900) {
  if (reduceMotion()) {
    el.textContent = to.toFixed(dp);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = (to * (1 - Math.pow(1 - t, 3))).toFixed(dp);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** "31 ms" */
export const ms = (n: number) => (n < 1 ? "under 1 ms" : `${Math.round(n)} ms`);
