/**
 * "Ask the guide": type a question, get the best passages from the user
 * guide, tutorials and function reference (searched on the computer), with
 * buttons that run the commands they mention. The guide's text is loaded the
 * first time it's asked, not with the app.
 */
import { FUNCTION_INFO } from "@cellforge/core";
import { DocIndex, functionPassages, passagesOf, type Hit } from "./docsearch";

export interface GuideCommand {
  id: string;
  title: string;
  run: () => unknown;
}

let indexPromise: Promise<DocIndex> | null = null;

/** The search index over the guide (built once, on first use). */
export function guideIndex(): Promise<DocIndex> {
  indexPromise ??= (async () => {
    const files = import.meta.glob(["../../../docs/guide/*.md", "../../../docs/tutorials/*.md"], { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;
    const pages = await Promise.all(Object.entries(files).map(async ([path, load]) => ({ file: path.replace(/^.*\/docs\//, ""), text: await load() })));
    return new DocIndex([...pages.flatMap((p) => passagesOf(p.file, p.text)), ...functionPassages(FUNCTION_INFO)]);
  })();
  return indexPromise;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

export function openAskGuide(commands: () => readonly GuideCommand[], focusGrid: () => void, initial = ""): void {
  document.querySelector(".ask-guide")?.closest(".palette-backdrop")?.remove();
  const back = el("div", { className: "palette-backdrop" });
  const box = el("div", { className: "palette import-dialog ask-guide" });
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Ask the guide");
  const input = el("input", { placeholder: "How do I…  (e.g. reconcile the bank, find duplicates, add a dropdown)", value: initial });
  input.setAttribute("aria-label", "Your question");
  const results = el("div", { className: "ask-guide-results" });
  results.setAttribute("aria-live", "polite");
  box.append(el("div", { className: "palette-form" }, el("h3", { textContent: "Ask the guide" }), input, results));
  back.append(box);
  document.body.append(back);
  const close = () => {
    back.remove();
    focusGrid();
  };
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.addEventListener("pointerdown", (e) => e.target === back && close());

  const show = (hits: Hit[]) => {
    results.replaceChildren();
    if (!input.value.trim()) return;
    if (!hits.length) {
      results.append(el("p", { className: "hp-muted", textContent: "Nothing in the guide matches. Try other words, or the command palette (Ctrl+K)." }));
      return;
    }
    const byTitle = new Map(commands().map((c) => [c.title.toLowerCase(), c]));
    for (const h of hits) {
      const p = h.passage;
      const card = el("article", { className: "ask-guide-hit" });
      card.append(el("strong", { textContent: p.heading ? `${p.page} › ${p.heading}` : p.page }), el("p", { textContent: h.snippet }));
      const runnable = p.commands.map((t) => byTitle.get(t.toLowerCase())).filter((c): c is GuideCommand => !!c);
      if (runnable.length) {
        const row = el("div", { className: "ask-guide-actions" });
        for (const c of runnable.slice(0, 3)) {
          const b = el("button", { type: "button", textContent: c.title });
          b.addEventListener("click", () => {
            back.remove();
            void c.run();
          });
          row.append(b);
        }
        card.append(row);
      }
      results.append(card);
    }
  };
  let timer = 0;
  const ask = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => show((await guideIndex()).search(input.value, 5)), 120);
  };
  input.addEventListener("input", ask);
  if (initial) ask();
  input.focus();
}
