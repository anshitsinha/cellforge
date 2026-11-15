/**
 * Variant C's private-AI moment: the landing page's live ask bar (the app's
 * own parser and actions, no model, no network), which types a couple of
 * requests by itself when it scrolls into view. Touch it and it stops.
 */
import { mount as mountAsk } from "../landing/ask";

const SCRIPT = ["highlight amounts over 10000 in red", "sort by amount descending"];

export async function mount(root: HTMLElement, ctx: { reduce: boolean }) {
  await mountAsk(root);
  if (ctx.reduce) return;
  const input = root.querySelector<HTMLInputElement>(".ask-input");
  if (!input) return;
  let stopped = false;
  const stop = () => (stopped = true);
  for (const ev of ["pointerdown", "keydown", "focusin"]) root.addEventListener(ev, stop, { passive: true });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const play = async () => {
    for (const text of SCRIPT) {
      if (stopped) return;
      input.value = "";
      for (const ch of text) {
        if (stopped) return;
        input.value += ch;
        input.dispatchEvent(new Event("input"));
        await wait(38 + Math.random() * 40);
      }
      await wait(700);
      if (stopped) return;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await wait(2600);
    }
  };
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      void play();
    },
    { threshold: 0.6 },
  );
  io.observe(root);
}
