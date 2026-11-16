/**
 * Landing variant C: "the spreadsheet comes alive". Warm paper, chunky
 * colour blocks, and live cellforge grids that do the work in front of you.
 * Motion is scroll-driven: sections reveal and settle as they come up, the
 * workflow cards stack, and the 100M section follows the page's scroll.
 */
import "../landing/landing.css";
import "./home.css";

document.documentElement.classList.add("js");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
if (reduce) document.documentElement.classList.add("rm");

// ---------------------------------------------------------------- header --
const nav = document.querySelector<HTMLElement>(".cx-nav");
const onScrollNav = () => nav?.classList.toggle("is-scrolled", scrollY > 8);

// --------------------------------------------------------------- reveals --
const reveals = document.querySelectorAll<HTMLElement>("[data-reveal], [data-card], [data-scrub]");
if (reduce || !("IntersectionObserver" in window)) reveals.forEach((el) => el.classList.add("in"));
else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
  );
  reveals.forEach((el) => io.observe(el));
}

// ------------------------------------------------- scroll-linked progress --
// [data-scrub] blocks get --p: 0 as their top enters the screen, 1 once they're
// well in. Cards get --k: how far the next card has slid over them (they stack).
const scrubs = [...document.querySelectorAll<HTMLElement>("[data-scrub]")];
const cards = [...document.querySelectorAll<HTMLElement>("[data-card]")];
const listeners: (() => void)[] = [onScrollNav];
let queued = false;
function frame() {
  queued = false;
  for (const f of listeners) f();
}
function queue() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(frame);
}
if (!reduce) {
  listeners.push(() => {
    const vh = innerHeight;
    for (const el of scrubs) {
      const r = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.55)));
      el.style.setProperty("--p", p.toFixed(3));
    }
    cards.forEach((el, i) => {
      const next = cards[i + 1];
      if (!next) return;
      const a = el.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      const k = Math.min(1, Math.max(0, 1 - (b.top - a.top) / Math.max(1, a.height)));
      el.style.setProperty("--k", k.toFixed(3));
    });
  });
}
export function onScroll(f: () => void) {
  listeners.push(f);
  queue();
}
window.addEventListener("scroll", queue, { passive: true });
window.addEventListener("resize", queue);
queue();

// ------------------------------------------------------------ live demos --
type Demo = { mount(root: HTMLElement, ctx: { onScroll: typeof onScroll; reduce: boolean }): unknown };
const DEMOS: Record<string, () => Promise<Demo>> = {
  hero: () => import("./hero"),
  rec: () => import("./cards").then((m) => ({ mount: m.mountRec })),
  close: () => import("./cards").then((m) => ({ mount: m.mountClose })),
  audit: () => import("./cards").then((m) => ({ mount: m.mountAudit })),
  scale: () => import("./scale"),
  ask: () => import("./ask"),
};

async function start(root: HTMLElement) {
  const load = DEMOS[root.dataset.cx ?? ""];
  if (!load || root.dataset.state) return;
  root.dataset.state = "loading";
  try {
    const demo = await load();
    await demo.mount(root, { onScroll, reduce });
    root.dataset.state = "live";
  } catch (e) {
    root.dataset.state = "failed";
    const note = root.querySelector<HTMLElement>(".af-failed");
    if (note) note.hidden = false;
    console.error("cellforge demo", root.dataset.cx, e);
  }
}

const lives = document.querySelectorAll<HTMLElement>("[data-cx]");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        void start(e.target as HTMLElement);
      }
    },
    { rootMargin: "800px 0px" },
  );
  lives.forEach((el) => io.observe(el));
} else lives.forEach((el) => void start(el));
