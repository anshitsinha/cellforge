import "./home.css";
import { Grid } from "@cellforge/grid";
import { SyntheticSource } from "./demo";

// Motion is opt-in from here: without this class (no JS) everything is
// simply visible, and with reduced motion the CSS leaves it alone.
document.documentElement.classList.add("js");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- header --
const header = document.querySelector<HTMLElement>(".site-header");
const onScroll = () => header?.classList.toggle("scrolled", scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

// close the phone menu when a link in it is chosen
const menu = document.querySelector<HTMLDetailsElement>(".menu");
menu?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) menu.open = false;
});
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && menu?.open) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
});

// ---------------------------------------------------------------- reveal --
const reveals = document.querySelectorAll<HTMLElement>(".reveal");
if (reduceMotion || !("IntersectionObserver" in window)) {
  reveals.forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  reveals.forEach((el) => io.observe(el));
}

// ---------------------------------------------------- the live 100M grid --
// A real cellforge grid over the 100M-line ledger demo: the best proof that
// the number isn't marketing. Built only when it scrolls near the screen.
const ROWS = 100_000_000;
const container = document.getElementById("demo-grid");
const label = document.getElementById("demo-label");

function startLiveGrid(el: HTMLElement) {
  const fmt = new Intl.NumberFormat("en-US");
  // touch: false - this grid is decoration inside a scrolling page, so a
  // swipe over it on a phone should scroll the page, not the grid
  const grid = new Grid(el, new SyntheticSource(ROWS), { defaultColumnWidth: 92, touch: false, label: "General ledger demo" });
  const show = (row: number) => {
    if (label) label.textContent = `line ${fmt.format(row + 1)} of ${fmt.format(ROWS)}`;
  };
  if (reduceMotion) {
    // still worth showing how deep it goes: one static jump
    grid.select(47_500_000, 0);
    show(47_500_000);
    return;
  }

  // glide down, then "teleport" deeper so it's obvious we're not looping
  // over the first few hundred rows
  const JUMPS = [0, 1_250_000, 18_000_000, 47_500_000, 99_999_000];
  let jump = 0;
  let row = 0;
  let paused = false;
  let visible = true;
  el.addEventListener("mouseenter", () => (paused = true));
  el.addEventListener("mouseleave", () => (paused = false));
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(el);

  const tick = () => {
    if (!paused && visible && !document.hidden) {
      row += 0.06;
      // stay on the first column, so the grid doesn't scroll sideways
      grid.select(Math.floor(row), 0);
      show(Math.floor(row));
    }
    requestAnimationFrame(tick);
  };
  setInterval(() => {
    if (paused || !visible || document.hidden) return;
    jump = (jump + 1) % JUMPS.length;
    row = JUMPS[jump];
  }, 4000);
  requestAnimationFrame(tick);
}

if (container) {
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        startLiveGrid(container);
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(container);
  } else startLiveGrid(container);
}

// ------------------------------------------------------- counting number --
// the hero's "95.7% matched" counts up once, after the card appears
const counter = document.querySelector<HTMLElement>("[data-count]");
if (counter && !reduceMotion) {
  const target = Number(counter.dataset.count);
  const dp = Number(counter.dataset.dp ?? 0);
  const start = performance.now() + 1100;
  const dur = 1300;
  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / dur));
    const eased = 1 - Math.pow(1 - t, 3);
    counter.textContent = (target * eased).toFixed(dp);
    if (t < 1) requestAnimationFrame(step);
  };
  counter.textContent = (0).toFixed(dp);
  requestAnimationFrame(step);
}
