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
