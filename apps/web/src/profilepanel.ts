/**
 * Column profiles: one card per column of the active sheet with counts,
 * blanks, distinct values, number statistics or text lengths, the date
 * range, the most common values and text patterns, and a small histogram.
 * Columns are profiled one at a time between frames so a wide 10M-row sheet
 * fills in card by card instead of freezing the page.
 */
import { formatValue } from "@cellforge/core";
import { profile, type DataProfile } from "../../../packages/core/src/pivot";
import { readSheetColumns, type ColumnSource, type SheetColumns } from "./pivotpanel";
import "./pivot.css";

export interface ProfileDeps {
  source: () => ColumnSource;
  sheetName: () => string;
  focusGrid: () => void;
}

const count = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, of: number) => (of ? formatValue(n / of, n && n / of < 0.001 ? "0.00%" : "0.0%").text : "0%");

/** Profile column `c` of the sheet. */
export function profileOf(data: SheetColumns, c: number): DataProfile {
  return profile(data.columns[c], { date: data.isDate[c] });
}

/** The figures on a card, as label / value pairs. */
export function profileLines(p: DataProfile, numFmt = ""): [string, string, boolean?][] {
  const lines: [string, string, boolean?][] = [];
  const fmt = (v: number) => formatValue(v, p.type === "date" && p.numbers ? numFmt || "yyyy-mm-dd" : numFmt || "#,##0.####").text;
  const day = (v: number) => formatValue(v, "yyyy-mm-dd").text;
  lines.push(["Rows", count(p.count)]);
  lines.push(["Blank", `${count(p.blanks)} (${pct(p.blanks, p.count)})`, p.blanks > 0 && p.blanks === p.count]);
  if (p.type === "empty") return lines;
  lines.push(["Distinct", (p.distinctExact ? "" : "about ") + count(p.distinct) + (p.distinct === p.filled ? " (all different)" : "")]);
  const n = p.numbers;
  if (n && p.type === "date") {
    lines.push(["From", day(n.min)], ["To", day(n.max)], ["Median", day(n.median) + (n.medianExact ? "" : " (est.)")]);
  } else if (n) {
    lines.push(["Min", fmt(n.min)], ["Max", fmt(n.max)], ["Sum", fmt(n.sum)], ["Mean", fmt(n.mean)], ["Median", fmt(n.median) + (n.medianExact ? "" : " (est.)")]);
    if (n.stdev === n.stdev) lines.push(["Std dev", fmt(n.stdev)]);
    if (n.negatives) lines.push(["Negative", count(n.negatives)]);
    if (n.zeros) lines.push(["Zero", count(n.zeros)]);
    if (n.wholes !== p.filled) lines.push(["Whole numbers", `${count(n.wholes)} (${pct(n.wholes, p.filled)})`]);
  }
  const t = p.text;
  if (t) {
    lines.push(["Length", t.minLength === t.maxLength ? String(t.minLength) : `${t.minLength}–${t.maxLength} (mean ${t.meanLength.toFixed(1)})`]);
    if (p.dates) lines.push(["Dates", `${count(t.dateLike)}: ${day(p.dates.min)} to ${day(p.dates.max)}`]);
    if (t.numeric) lines.push(["Numbers as text", count(t.numeric), true]);
  }
  return lines;
}

/** Top values as text, formatted like the column. */
export function topLines(p: DataProfile, numFmt = ""): [string, string][] {
  return p.top.map(({ value, count: k }) => {
    const v = typeof value === "number" ? formatValue(value, numFmt || (p.type === "date" ? "yyyy-mm-dd" : "General")).text : value;
    return [v || "(empty text)", count(k) + (p.topExact ? "" : " (est.)")];
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function drawHistogram(canvas: HTMLCanvasElement, counts: number[]): void {
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 220;
  const h = canvas.clientHeight || 44;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx || !counts.length) return;
  ctx.scale(ratio, ratio);
  const color = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#1a73e8";
  const max = Math.max(...counts);
  const bw = w / counts.length;
  ctx.fillStyle = color;
  counts.forEach((c, i) => {
    if (!c) return;
    // at least 1px so rare values still show
    const bh = Math.max(1, (c / max) * (h - 2));
    ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
  });
}

function card(p: DataProfile, letter: string, numFmt: string): HTMLElement {
  const c = el("section", "profile-card");
  const h = el("h4");
  h.append(el("span", undefined, p.name), el("span", "profile-type", `${letter} · ${p.type}`));
  c.append(h);
  const dl = el("dl");
  for (const [k, v, warn] of profileLines(p, numFmt)) {
    const dd = el("dd", warn ? "profile-warn" : undefined, v);
    dd.title = v;
    dl.append(el("dt", undefined, k), dd);
  }
  c.append(dl);
  if (p.histogram && p.histogram.counts.length > 1) {
    const canvas = el("canvas");
    const e = p.histogram.edges;
    const f = (v: number) => formatValue(v, p.type === "date" ? "yyyy-mm-dd" : numFmt || "General").text;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Histogram of ${p.name}: ${p.histogram.counts.length} bins from ${f(e[0])} to ${f(e[e.length - 1])}`);
    canvas.title = `${f(e[0])} to ${f(e[e.length - 1])}, ${p.histogram.counts.length} bins`;
    c.append(canvas);
    requestAnimationFrame(() => drawHistogram(canvas, p.histogram!.counts));
  }
  const top = topLines(p, numFmt);
  if (top.length) {
    c.append(el("h5", undefined, "Most common"));
    const ol = el("dl");
    for (const [v, k] of top.slice(0, 5)) {
      const dt = el("dt", undefined, v);
      dt.title = v;
      ol.append(dt, el("dd", undefined, k));
    }
    c.append(ol);
  }
  if (p.patterns && p.patterns.length > 1) {
    c.append(el("h5", undefined, "Patterns"));
    const pl = el("dl");
    for (const x of p.patterns.slice(0, 4)) {
      const dt = el("dt", undefined, x.pattern || "(empty)");
      dt.title = `e.g. ${x.example}`;
      pl.append(dt, el("dd", undefined, `${count(x.count)} (${pct(x.count, p.filled)})`));
    }
    c.append(pl);
  }
  return c;
}

const letterOf = (c: number) => {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function openProfiles(d: ProfileDeps): void {
  const data = readSheetColumns(d.source());
  const back = el("div", "palette-backdrop");
  const dialog = el("div", "palette import-dialog profile-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Column profiles");
  const body = el("div", "palette-form");
  dialog.append(body);
  back.append(dialog);
  let cancelled = false;
  const close = () => {
    cancelled = true;
    back.remove();
    d.focusGrid();
  };
  const status = el("p", "hp-muted");
  status.setAttribute("aria-live", "polite");
  const cards = el("div", "profile-cards");
  const actions = el("div", "numfmt-actions");
  const ok = el("button", undefined, "Close");
  ok.type = "button";
  ok.addEventListener("click", close);
  actions.append(ok);
  body.append(el("h3", undefined, `Column profiles: ${d.sheetName()}`), status, cards, actions);
  back.addEventListener("keydown", (e) => e.key === "Escape" && close());
  back.addEventListener("mousedown", (e) => e.target === back && close());
  document.body.append(back);
  ok.focus();

  if (!data.rows || !data.columns.length) {
    status.textContent = "This sheet has no data to profile.";
    return;
  }
  const t0 = performance.now();
  let c = 0;
  const step = () => {
    if (cancelled) return;
    const until = performance.now() + 30;
    // a few small columns per frame, or one big one
    do {
      cards.append(card(profileOf(data, c), letterOf(c), data.numFmts[c]));
      c++;
    } while (c < data.columns.length && performance.now() < until);
    status.textContent =
      c < data.columns.length
        ? `Profiling column ${c + 1} of ${data.columns.length}…`
        : `${data.columns.length} columns, ${count(data.rows)} rows, in ${Math.round(performance.now() - t0)} ms. Distinct counts marked "about" are estimates; "(est.)" figures come from a sample.`;
    if (c < data.columns.length) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
