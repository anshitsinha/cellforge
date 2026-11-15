/**
 * Direction B's own small live widgets for the bento tiles. Each one runs
 * the real engines on the sample data (the same calls the landing demos
 * make, from ../landing/compute), and only draws the result differently:
 * a match ring, a Benford chart with the top journal scores, and a live
 * count of the requests this page has sent to other servers.
 */
import { auditSample, bankRecSample } from "../samples";
import { benfordOf, CONFORMITY_LABEL, RULE_LABEL, runBankRec, runJournalTests } from "../landing/compute";
import { h, ms } from "../landing/frame";

const SVG = "http://www.w3.org/2000/svg";
const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Add `.on` to the widget once it's well on screen (CSS animates from there). */
function whenSeen(el: HTMLElement, fn: () => void) {
  if (reduce() || !("IntersectionObserver" in window)) {
    el.classList.add("on");
    fn();
    return;
  }
  const io = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      el.classList.add("on");
      fn();
    },
    { threshold: 0.35 },
  );
  io.observe(el);
}

function countTo(el: HTMLElement, to: number, dp: number, msTotal = 1200) {
  if (reduce()) {
    el.textContent = to.toFixed(dp);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / msTotal);
    el.textContent = (to * (1 - Math.pow(1 - t, 3))).toFixed(dp);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------ match ring --

export function mountRing(root: HTMLElement) {
  const s = bankRecSample();
  const t0 = performance.now();
  const rec = runBankRec(s.ledger, s.bank);
  const took = performance.now() - t0;
  const c = rec.card;
  const by = rec.result.summary.byRule;

  const R = 52;
  const C = 2 * Math.PI * R;
  const svg = svgEl("svg", { viewBox: "0 0 128 128", class: "ring", "aria-hidden": "true" });
  svg.append(svgEl("circle", { cx: 64, cy: 64, r: R, class: "ring-track" }));
  const arc = svgEl("circle", { cx: 64, cy: 64, r: R, class: "ring-arc", "stroke-dasharray": `${C} ${C}`, "stroke-dashoffset": C, transform: "rotate(-90 64 64)" });
  svg.append(arc);

  const pct = h("b", { textContent: "0.0" });
  const center = h("div", { class: "ring-center" }, h("span", { class: "ring-pct" }, pct, h("i", { textContent: "%" })), h("span", { class: "ring-sub", textContent: "matched" }));
  const ring = h("div", { class: "ring-wrap" }, svg, center);

  const stat = (n: number | string, label: string, tone = "") => h("div", { class: `rs ${tone}` }, h("b", { textContent: String(n) }), h("span", { textContent: label }));
  const stats = h(
    "div",
    { class: "ring-stats" },
    stat(by.exact, RULE_LABEL.exact),
    stat(by.reference + by.fuzzy, "Written differently"),
    stat(c.splits, c.splits === 1 ? "Split payment" : "Split payments", "ok"),
    stat(c.keying, c.keying === 1 ? "Keying error" : "Keying errors", c.keying ? "warn" : "ok"),
    stat(c.postedTwice, "Posted twice", c.postedTwice ? "warn" : "ok"),
    stat(`${c.leftA} · ${c.leftB}`, "Left: book · bank"),
  );
  const note = h("p", { class: "ring-note", textContent: `${c.matchedA} of ${c.countA} cash book lines, ${c.matchedB} of ${c.countB} bank lines. Matched in ${ms(took)}, in this tab.` });
  root.replaceChildren(h("div", { class: "ring-row" }, ring, stats), note);
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", `Sample bank reconciliation: ${c.matchPct.toFixed(1)}% matched. ${c.splits} split payments, ${c.keying} keying errors, ${c.postedTwice} posted twice.`);

  whenSeen(root, () => {
    arc.setAttribute("stroke-dashoffset", String(C * (1 - c.matchPct / 100)));
    countTo(pct, c.matchPct, 1);
  });
}

// ----------------------------------------------------- benford + scores --

export function mountAudit(root: HTMLElement) {
  const sample = auditSample();
  const je = runJournalTests(sample);
  const ben = benfordOf(sample);

  const W = 320;
  const H = 150;
  const pad = { l: 4, r: 4, t: 10, b: 20 };
  const max = Math.max(...ben.digits.map((d) => Math.max(d.actual, d.expected))) * 1.1;
  const bw = (W - pad.l - pad.r) / 9;
  const x = (i: number) => pad.l + bw * i;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "bf", role: "img" });
  svg.setAttribute("aria-label", `First digits of the sample journal's amounts against Benford's law: ${ben.digits.map((d) => `${d.digit}: ${(d.actual * 100).toFixed(1)}% (expected ${(d.expected * 100).toFixed(1)}%)`).join(", ")}.`);
  svg.append(svgEl("line", { x1: 0, x2: W, y1: y(0), y2: y(0), class: "bf-base" }));
  const pts: string[] = [];
  ben.digits.forEach((d, i) => {
    const bar = svgEl("rect", { class: "bf-b", x: x(i) + bw * 0.16, y: y(d.actual), width: bw * 0.68, height: Math.max(0, y(0) - y(d.actual)), rx: 3 });
    (bar as SVGElement).style.transitionDelay = `${i * 45}ms`;
    bar.append(svgEl("title", {}, `${d.digit}: ${(d.actual * 100).toFixed(1)}% of amounts (Benford ${(d.expected * 100).toFixed(1)}%)`));
    svg.append(bar);
    svg.append(svgEl("text", { x: x(i) + bw / 2, y: H - 5, "text-anchor": "middle" }, String(d.digit)));
    pts.push(`${x(i) + bw / 2},${y(d.expected)}`);
  });
  svg.append(svgEl("polyline", { class: "bf-exp", points: pts.join(" ") }));
  for (const p of pts) {
    const [cx, cy] = p.split(",");
    svg.append(svgEl("circle", { class: "bf-dot", cx, cy, r: 2.6 }));
  }

  const legend = h(
    "p",
    { class: "bf-legend" },
    h("span", {}, h("i", { class: "sw" }), "First digit, actual"),
    h("span", {}, h("i", { class: "ln" }), "Benford"),
    h("span", { class: "bf-mad", textContent: `${CONFORMITY_LABEL[ben.conformity]} · MAD ${ben.mad.toFixed(4)}` }),
  );

  const scores = h("div", { class: "je-top" });
  for (const e of je.top.slice(0, 3)) {
    scores.append(
      h(
        "div",
        { class: "je-row" },
        h("span", { class: `je-score ${e.score >= 5 ? "bad" : "warn"}`, textContent: String(e.score) }),
        h("span", { class: "je-id", textContent: `Entry ${e.id}` }),
        h("span", { class: "je-flags", textContent: e.flags.slice(0, 3).join(" · ") }),
      ),
    );
  }
  const head = h("p", { class: "je-cap", textContent: `${je.result.ranked.length} of ${je.entries} entries flagged · highest scores` });
  root.replaceChildren(svg, legend, head, scores);
  whenSeen(root, () => {});
}

// ---------------------------------------------------------------- privacy --

export function mountPrivacy(root: HTMLElement) {
  const count = () =>
    performance.getEntriesByType("resource").filter((e) => {
      try {
        return new URL(e.name, location.href).origin !== location.origin;
      } catch {
        return false;
      }
    }).length;

  const n = h("b", { class: "pv-n", textContent: String(count()) });
  const art = document.createElementNS(SVG, "svg");
  art.setAttribute("viewBox", "0 0 240 120");
  art.setAttribute("class", "pv-art");
  art.setAttribute("aria-hidden", "true");
  // a laptop, a broken line, a cloud with nothing in it
  art.innerHTML = `
    <rect x="18" y="30" width="78" height="52" rx="6" class="pv-stroke"/>
    <rect x="26" y="38" width="62" height="36" rx="2" class="pv-screen"/>
    <path d="M8 90h98l-6 8H14z" class="pv-stroke"/>
    <g class="pv-cells"><rect x="31" y="43" width="16" height="7" rx="1.5"/><rect x="49" y="43" width="16" height="7" rx="1.5"/><rect x="67" y="43" width="16" height="7" rx="1.5"/><rect x="31" y="53" width="16" height="7" rx="1.5"/><rect x="49" y="53" width="16" height="7" rx="1.5"/><rect x="67" y="53" width="16" height="7" rx="1.5"/><rect x="31" y="63" width="16" height="7" rx="1.5"/><rect x="49" y="63" width="16" height="7" rx="1.5"/><rect x="67" y="63" width="16" height="7" rx="1.5"/></g>
    <path d="M108 58h20M150 58h20" class="pv-dash"/>
    <path d="M132 50l14 16M146 50l-14 16" class="pv-x"/>
    <path d="M186 74h34a14 14 0 0 0 0-28 20 20 0 0 0-38-4 13 13 0 0 0 4 32z" class="pv-cloud"/>`;

  const meter = h("div", { class: "pv-meter" }, n, h("span", { textContent: "requests from this page to any other server, counted live by your browser" }));
  root.replaceChildren(art, meter);
  if ("PerformanceObserver" in window) {
    try {
      new PerformanceObserver(() => (n.textContent = String(count()))).observe({ type: "resource", buffered: true });
    } catch {
      /* older browsers: the first count stands */
    }
  }
  whenSeen(root, () => {});
}
