/**
 * Landing page, direction B: a dark, cinematic product showcase. The hero is
 * the live app frame, tilted back and straightening as you scroll; then the
 * big numbers; then a bento grid of small live tiles. Every product picture
 * is the real grid and engines running in this tab (the landing demos in
 * ../landing, plus a few small widgets in ./b-widgets), each loaded only as
 * its tile comes near the screen.
 */
import "../landing/landing.css";
import "./b.css";

document.documentElement.classList.add("js");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- header --
const header = document.querySelector<HTMLElement>(".vb-header");

// ------------------------------------------------- hero tilt, on scroll --
// The frame starts leaning back and straightens over the first part of the
// scroll: progress goes 0 -> 1 as the frame's top travels up the screen.
const stage = document.querySelector<HTMLElement>(".vb-stage-wrap");
let queued = false;
function frame() {
  queued = false;
  header?.classList.toggle("scrolled", scrollY > 8);
  if (!stage || reduceMotion) return;
  const r = stage.getBoundingClientRect();
  const start = innerHeight * 0.95;
  const end = innerHeight * 0.18;
  const p = Math.min(1, Math.max(0, (start - r.top) / (start - end)));
  stage.style.setProperty("--p", p.toFixed(4));
}
const onScroll = () => {
  if (!queued) {
    queued = true;
    requestAnimationFrame(frame);
  }
};
window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll, { passive: true });
frame();

// ---------------------------------------------------------------- reveal --
const reveals = document.querySelectorAll<HTMLElement>(".vb-reveal");
const fmt = new Intl.NumberFormat("en-US");

function count(el: HTMLElement) {
  const to = Number(el.dataset.count);
  if (reduceMotion || !to) return;
  const msTotal = to > 1000 ? 1600 : 900;
  const t0 = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / msTotal);
    const e = 1 - Math.pow(1 - t, 4);
    el.textContent = fmt.format(Math.round(to * e));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

if (reduceMotion || !("IntersectionObserver" in window)) {
  reveals.forEach((el) => el.classList.add("in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add("in");
        el.querySelectorAll<HTMLElement>("[data-count]").forEach(count);
        io.unobserve(el);
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
  );
  reveals.forEach((el) => io.observe(el));
}

// ------------------------------------------------------------ live demos --
type Demo = { mount(root: HTMLElement): unknown };
const DEMOS: Record<string, () => Promise<Demo>> = {
  hero: () => import("../landing/hero"),
  scale: () => import("../landing/scale"),
  evidence: () => import("../landing/evidence"),
  ask: () => import("../landing/ask"),
  ring: () => import("./b-widgets").then((m) => ({ mount: m.mountRing })),
  audit: () => import("./b-widgets").then((m) => ({ mount: m.mountAudit })),
  privacy: () => import("./b-widgets").then((m) => ({ mount: m.mountPrivacy })),
};

async function start(root: HTMLElement) {
  const load = DEMOS[root.dataset.live ?? ""];
  if (!load || root.dataset.state) return;
  root.dataset.state = "loading";
  try {
    const demo = await load();
    await demo.mount(root);
    root.dataset.state = "live";
  } catch (e) {
    root.dataset.state = "failed";
    const note = root.querySelector<HTMLElement>(".af-failed");
    if (note) note.hidden = false;
    console.error("cellforge demo", root.dataset.live, e);
  }
}

const lives = document.querySelectorAll<HTMLElement>("[data-live]");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        void start(e.target as HTMLElement);
      }
    },
    { rootMargin: "900px 0px" },
  );
  lives.forEach((el) => io.observe(el));
} else lives.forEach((el) => void start(el));
