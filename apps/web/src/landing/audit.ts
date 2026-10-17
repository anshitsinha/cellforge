/**
 * The audit section: the sample journal in the real grid, with the eleven
 * journal entry tests and Benford's first-digit test run on it by the real
 * engines. Each entry's score goes in a Score column; picking an entry in
 * the panel finds its lines.
 */
import type { CellValue } from "@cellforge/grid";
import { auditSample } from "../samples";
import { benfordOf, CONFORMITY_LABEL, isoSerial, money, runJournalTests } from "./compute";
import { h, ms } from "./frame";
import { LiveSheet } from "./sheet";
import { AMOUNT, DATE, TableSource } from "./table";
import type { BenfordResult } from "./engine";

const SVG = "http://www.w3.org/2000/svg";

export function mount(root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".af")!;
  const host = frame.querySelector<HTMLElement>(".af-grid")!;
  const side = frame.querySelector<HTMLElement>(".af-side")!;
  const sample = auditSample();

  const t0 = performance.now();
  const je = runJournalTests(sample);
  const ben = benfordOf(sample);
  const took = performance.now() - t0;

  const score = new Map<string, number>();
  for (const e of je.result.entries) if (e.score > 0) score.set(e.id, e.score);
  const rows: CellValue[][] = sample.lines.map((l) => [l.entry, isoSerial(l.date), l.posted, l.user, l.account, l.description, l.amount, l.reference, score.get(String(l.entry)) ?? null]);
  const src = new TableSource(["Entry", "Date", "Posted", "User", "Account", "Description", "Amount", "Reference", "Score"], rows, {
    formats: [null, DATE, null, null, null, null, AMOUNT, null, null],
    spare: 4,
    styleOf: (row, col) => {
      if (col !== 8) return null;
      const s = rows[row][8];
      if (typeof s !== "number") return null;
      return s >= 5 ? { fill: "#ffc7ce", color: "#9c0006", bold: true } : s >= 3 ? { fill: "#ffeb9c", color: "#9c5700" } : null;
    },
  });
  host.replaceChildren();
  const sheet = new LiveSheet(host, src, {
    label: "Sample journal, a live cellforge sheet",
    frame,
    idleStatus: () => `${je.lines.toLocaleString("en-US")} lines · ${je.entries.toLocaleString("en-US")} entries`,
  });
  sheet.layout({ widths: [72, 86, 112, 78, 58, 150, 96, 76, 54], frozenRows: 1 });

  const find = (lines: number[]) => {
    const r = lines.map((i) => i + 1);
    const top = Math.min(...r);
    const bottom = Math.max(...r);
    // select the amounts: the status bar shows the entry adds up to nothing (or not)
    sheet.reveal({ top, left: 0, bottom, right: 8 }, "#d93025", { top, left: 6, bottom, right: 6 });
  };

  const max = Math.max(...je.tests.map((t) => t.entries));
  const bars = h("ul", { class: "je-bars" });
  for (const t of je.tests) {
    const bar = h("span", { class: "je-bar" }, h("i"));
    (bar.firstChild as HTMLElement).style.setProperty("--w", `${Math.max(4, (Math.sqrt(t.entries) / Math.sqrt(max)) * 100)}%`);
    bars.append(h("li", {}, h("span", { textContent: t.label }), bar, h("b", { textContent: String(t.entries) })));
  }
  const top = h("ul", { class: "rs-list" });
  je.top.forEach((e, i) => {
    const b = h(
      "button",
      {
        type: "button",
        class: "rs-item",
        onclick: () => {
          top.querySelectorAll(".rs-item").forEach((x, j) => x.setAttribute("aria-current", String(j === i)));
          find(e.lines);
        },
      },
      h("i", { class: e.score >= 5 ? "bad" : "warn" }),
      h("b", { textContent: `Entry ${e.id}` }),
      h("span", { class: "amt", textContent: `score ${e.score}` }),
      h("em", { textContent: e.flags.join(" · ") }),
    );
    top.append(h("li", {}, b));
  });

  side.replaceChildren(
    h(
      "div",
      { class: "sp" },
      h("p", { class: "sp-title" }, "Journal entry tests", h("span", { textContent: ms(took) })),
      h("p", { class: "sp-sub", textContent: `${je.entries} entries, ${je.lines.toLocaleString("en-US")} lines. Approval limit ${money(sample.approvalLimit)}.` }),
      h(
        "div",
        { class: "tiles" },
        h("div", { class: "tile" }, h("b", { textContent: String(je.result.ranked.length) }), h("span", { textContent: "entries flagged" })),
        h("div", { class: "tile" }, h("b", { textContent: String(je.top[0]?.score ?? 0) }), h("span", { textContent: "top score" })),
        h("div", { class: "tile" }, h("b", { textContent: ben.mad.toFixed(4) }), h("span", { textContent: "Benford MAD" })),
      ),
      h("p", { class: "sp-h", textContent: "Highest scores" }),
      top,
      h("p", { class: "sp-h", textContent: "Entries found, by test" }),
      bars,
      h("p", { class: "sp-h", textContent: "Benford, first digit" }),
      benfordChart(ben),
      h("div", { class: "legend" }, h("span", {}, h("i"), "Actual"), h("span", {}, h("i", { class: "line" }), "Benford")),
      h("p", { class: "sp-sub", textContent: `${CONFORMITY_LABEL[ben.conformity]} (MAD ${ben.mad.toFixed(4)}, ${ben.n.toLocaleString("en-US")} amounts). Chi-square ${ben.chiSquare.toFixed(1)}, p ${ben.pValue < 0.001 ? "< 0.001" : ben.pValue.toFixed(3)}.` }),
    ),
  );
  // start on the top-scoring entry
  (top.querySelector(".rs-item") as HTMLButtonElement | null)?.click();
}

/** Bars for the share of each first digit, with Benford's expected share as a line. */
function benfordChart(b: BenfordResult): SVGSVGElement {
  const W = 300;
  const H = 130;
  const pad = { l: 26, r: 6, t: 8, b: 20 };
  const max = Math.max(...b.digits.map((d) => Math.max(d.actual, d.expected))) * 1.08;
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) / 9) * i;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "benford");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `First digits of the journal's amounts against Benford's law: ${b.digits.map((d) => `${d.digit}: ${(d.actual * 100).toFixed(1)}% (expected ${(d.expected * 100).toFixed(1)}%)`).join(", ")}.`);
  const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const v of [0, 0.1, 0.2, 0.3]) {
    if (v > max) continue;
    el("text", { x: pad.l - 5, y: y(v) + 3.5, "text-anchor": "end" }, `${v * 100}%`);
    el("line", { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), stroke: "currentColor", "stroke-opacity": 0.12 });
  }
  const bw = (W - pad.l - pad.r) / 9;
  const pts: string[] = [];
  b.digits.forEach((d, i) => {
    const r = el("rect", { class: "bf-bar", x: x(i) + bw * 0.18, y: y(d.actual), width: bw * 0.64, height: Math.max(0, y(0) - y(d.actual)), rx: 2 });
    const t = document.createElementNS(SVG, "title");
    t.textContent = `${d.digit}: ${d.count} amounts, ${(d.actual * 100).toFixed(1)}% (Benford ${(d.expected * 100).toFixed(1)}%)`;
    r.append(t);
    el("text", { x: x(i) + bw / 2, y: H - 6, "text-anchor": "middle" }, String(d.digit));
    pts.push(`${x(i) + bw / 2},${y(d.expected)}`);
  });
  el("polyline", { class: "exp", points: pts.join(" ") });
  for (const p of pts) {
    const [cx, cy] = p.split(",");
    el("circle", { class: "dot", cx, cy, r: 2.4 });
  }
  return svg;
}
