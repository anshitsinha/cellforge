/**
 * Lab A: "calm editorial, scroll-told story". One sticky stage whose live
 * product view follows the chapter being read, then a scroll-driven trip to
 * line 100,000,000. Everything on the stage is the real grid and engines,
 * loaded only as the page needs them.
 */
import "../landing/landing.css";
import "./a.css";
import { BIG_ROWS } from "../samples";
import type { RecStage } from "./a-story";
import type { ScaleStage } from "./a-scale";

document.documentElement.classList.add("js");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const int = new Intl.NumberFormat("en-US");

// ------------------------------------------------------------ header --
const nav = document.querySelector<HTMLElement>(".la-nav");
const onNav = () => nav?.classList.toggle("is-scrolled", scrollY > 8);

// ------------------------------------------------------------- story --
const stage = document.querySelector<HTMLElement>(".la-stage")!;
const chapters = [...document.querySelectorAll<HTMLElement>(".la-ch")];
const recLayer = stage.querySelector<HTMLElement>(".la-layer-rec")!;
const evLayer = stage.querySelector<HTMLElement>(".la-layer-ev")!;
const stamp = evLayer.querySelector<HTMLElement>(".la-stamp")!;
let rec: RecStage | null = null;
let evReady = false;
let step = -1;

function setStep(s: number) {
  if (s === step) return;
  step = s;
  stage.dataset.step = String(s);
  chapters.forEach((c) => c.classList.toggle("is-on", Number(c.dataset.step) === s));
  const ev = s >= 2;
  recLayer.inert = ev;
  evLayer.inert = !ev;
  rec?.setStep(s);
  if (s === 3) signOff();
}

// chapter 4: sign the workpaper off as reviewed, with the app's own action
let signed = false;
function signOff() {
  if (signed || !evReady) return;
  const btn = [...evLayer.querySelectorAll<HTMLButtonElement>(".af-side .af-btn-primary")].find((b) => b.textContent?.startsWith("Sign off"));
  if (!btn) return;
  signed = true;
  setTimeout(() => btn.click(), reduce ? 0 : 500);
}

function watchSigns() {
  const signs = evLayer.querySelector<HTMLElement>(".af-signs");
  if (!signs) return;
  const check = () => stamp.classList.toggle("is-on", signs.textContent?.includes("Reviewed ·") ?? false);
  new MutationObserver(check).observe(signs, { childList: true, subtree: true, characterData: true });
  check();
}

void import("./a-story")
  .then((m) => {
    rec = m.mountRec(recLayer);
    recLayer.dataset.state = "live";
    rec.setStep(Math.max(0, Math.min(1, step)));
  })
  .catch((e) => console.error("cellforge lab a: story", e));

async function startEvidence() {
  evLayer.dataset.state = "loading";
  try {
    const m = await import("../landing/evidence");
    await m.mount(evLayer);
    evLayer.dataset.state = "live";
    evReady = true;
    watchSigns();
    if (step === 3) signOff();
  } catch (e) {
    evLayer.dataset.state = "failed";
    const note = evLayer.querySelector<HTMLElement>(".af-failed");
    if (note) note.hidden = false;
    console.error("cellforge lab a: evidence", e);
  }
}

// ------------------------------------------------------------- scale --
const scaleSec = document.querySelector<HTMLElement>(".la-scale")!;
const countEl = scaleSec.querySelector<HTMLElement>(".la-count-n")!;
const ledger = scaleSec.querySelector<HTMLElement>(".la-ledger")!;
let scale: ScaleStage | null = null;
let shownRow = -1;

const showCount = (row: number) => {
  if (row === shownRow) return;
  shownRow = row;
  countEl.textContent = int.format(row + 1);
};

async function startScale() {
  try {
    const m = await import("./a-scale");
    scale = m.mountScale(ledger, showCount);
    ledger.dataset.state = "live";
    frame();
  } catch (e) {
    ledger.dataset.state = "failed";
    console.error("cellforge lab a: scale", e);
  }
}

// ------------------------------------------------------ scroll engine --
let queued = false;
function frame() {
  queued = false;
  onNav();
  const vh = innerHeight;

  // the chapter being read: the last whose top has passed the reading line
  const line = vh * (matchMedia("(max-width: 900px)").matches ? 0.62 : 0.6);
  let s = 0;
  chapters.forEach((c, i) => {
    if (c.getBoundingClientRect().top < line) s = i;
  });
  setStep(s);

  // the scale section: 0 as it pins, 1 as it lets go
  const r = scaleSec.getBoundingClientRect();
  const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - vh)));
  // the journey ends a little before the section does, so the number can rest
  const q = Math.min(1, p / 0.78);
  // orders of magnitude, evenly: the first rows slide by, the last millions fly
  const row = Math.min(BIG_ROWS - 1, Math.max(0, Math.round(Math.pow(BIG_ROWS, q)) - 1));
  if (!scale?.yours) {
    showCount(row);
    scale?.go(row);
  }
  scaleSec.classList.toggle("is-end", p > 0.72);
}
const queue = () => {
  if (!queued) {
    queued = true;
    requestAnimationFrame(frame);
  }
};
addEventListener("scroll", queue, { passive: true });
addEventListener("resize", queue);
frame();

// load the heavier demos as they come near
const near = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      near.unobserve(e.target);
      if (e.target === evLayer) void startEvidence();
      else if (e.target === ledger) void startScale();
    }
  },
  { rootMargin: "1200px 0px" },
);
near.observe(evLayer);
near.observe(ledger);

// --------------------------------------------------------- reveals --
const reveals = document.querySelectorAll<HTMLElement>(".la-reveal");
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
    { rootMargin: "0px 0px -10% 0px" },
  );
  reveals.forEach((el) => io.observe(el));
}
