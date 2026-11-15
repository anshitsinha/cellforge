import "./home.css";
import "./landing/landing.css";

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

// --------------------------------------------------------- workflow nav --
// The row of workflow links above the four workflows marks the one you're
// reading: the last whose top has passed a line a third of the way down.
const wfLinks = [...document.querySelectorAll<HTMLAnchorElement>(".wf-nav a")];
const wfArticles = wfLinks.map((a) => document.querySelector<HTMLElement>(a.hash)).filter((x): x is HTMLElement => !!x);
let spyQueued = false;
let spyCurrent = -2;
function spy() {
  spyQueued = false;
  const line = innerHeight / 3;
  let current = -1;
  wfArticles.forEach((el, i) => {
    if (el.getBoundingClientRect().top <= line) current = i;
  });
  const last = wfArticles[wfArticles.length - 1];
  if (last && last.getBoundingClientRect().bottom < line) current = -1;
  if (current === spyCurrent) return;
  spyCurrent = current;
  wfLinks.forEach((a, i) => (i === current ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
  // on a narrow screen the row scrolls sideways: keep the marked one in view
  const on = wfLinks[current];
  const bar = on?.parentElement;
  if (on && bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2, behavior: reduceMotion ? "auto" : "smooth" });
}
if (wfArticles.length) {
  window.addEventListener(
    "scroll",
    () => {
      if (!spyQueued) {
        spyQueued = true;
        requestAnimationFrame(spy);
      }
    },
    { passive: true },
  );
  spy();
}

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

// ------------------------------------------------------------ live demos --
// Every product picture on this page is the real thing: the cellforge grid
// and engines running on the sample data, in this tab. Each demo's code is
// fetched only when its section comes near the screen, so the page itself
// stays small; until then a skeleton holds its place.
type Demo = { mount(root: HTMLElement): unknown };
const DEMOS: Record<string, () => Promise<Demo>> = {
  hero: () => import("./landing/hero"),
  rec: () => import("./landing/rec"),
  close: () => import("./landing/close"),
  audit: () => import("./landing/audit"),
  evidence: () => import("./landing/evidence"),
  ask: () => import("./landing/ask"),
  scale: () => import("./landing/scale"),
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
    // start well before it's on screen: the code and the engines take a moment
    { rootMargin: "900px 0px" },
  );
  lives.forEach((el) => io.observe(el));
} else lives.forEach((el) => void start(el));
