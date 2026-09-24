/**
 * Column profiles: one card per column of the active sheet with counts,
 * blanks, distinct values, number statistics or text lengths, the date
 * range, the most common values and text patterns, and a small histogram.
 * Columns are profiled one at a time between frames so a wide 10M-row sheet
 * fills in card by card instead of freezing the page.
 */
import { formatValue } from "@cellforge/core";
import { profile, type DataProfile } from "@cellforge/core";
import { readSheetColumns, type ColumnSource, type SheetColumns } from "./pivotpanel";
import "./pivot.css";
import "./analysis.css";
import { icon } from "./ui/icons";
import { openSidePanel } from "./ui/sidepanel";

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
  // without a format: whole numbers with separators, others with up to 4 decimals
  const fmt = (v: number) => formatValue(v, p.type === "date" && p.numbers ? numFmt || "yyyy-mm-dd" : numFmt || (Number.isInteger(v) ? "#,##0" : "#,##0.00##")).text;
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
  const h = canvas.clientHeight || 40;
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx || !counts.length) return;
  ctx.scale(ratio, ratio);
  const css = getComputedStyle(canvas);
  const color = css.getPropertyValue("--chart-1").trim() || css.getPropertyValue("--accent").trim() || "#2a78d6";
  const max = Math.max(...counts);
  const bw = w / counts.length;
  ctx.fillStyle = color;
  counts.forEach((c, i) => {
    if (!c) return;
    // at least 1px so rare values still show
    const bh = Math.max(1, (c / max) * (h - 2));
    const r = Math.min(2, bw / 3);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1.5), bh, [r, r, 0, 0]);
    else ctx.rect(i * bw + 0.5, h - bh, Math.max(1, bw - 1.5), bh);
    ctx.fill();
  });
}

const TYPE_ICON: Record<string, string> = { number: "formula", date: "calendar", text: "document", mixed: "warning", empty: "info" };

function card(p: DataProfile, letter: string, numFmt: string): HTMLElement {
  const c = el("section", "profile-card");
  const h = el("header", "profile-card__head");
  const kind = el("span", "profile-kind");
  kind.append(icon(TYPE_ICON[p.type] ?? "info", { size: 12 }));
  const name = el("span", "profile-name", p.name);
  name.title = p.name;
  h.append(kind, name, el("span", "profile-type", `${p.type} · ${letter}`));
  c.append(h);

  // filled vs blank
  const filled = p.count ? (p.count - p.blanks) / p.count : 0;
  const bar = el("div", "profile-fill");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${pct(p.count - p.blanks, p.count)} filled`);
  bar.title = `${pct(p.count - p.blanks, p.count)} filled`;
  const fillPart = el("span");
  fillPart.style.width = `${Math.round(filled * 1000) / 10}%`;
  bar.append(fillPart);
  if (p.blanks && p.blanks === p.count) bar.classList.add("is-empty");
  else if (p.blanks) bar.classList.add("has-blanks");
  c.append(bar);

  const dl = el("dl", "profile-stats");
  for (const [k, v, warn] of profileLines(p, numFmt)) {
    const dd = el("dd", warn ? "profile-warn" : undefined, v);
    dd.title = v;
    dl.append(el("dt", undefined, k), dd);
  }
  c.append(dl);
  if (p.histogram && p.histogram.counts.length > 1) {
    const canvas = el("canvas", "profile-hist");
    const e = p.histogram.edges;
    const f = (v: number) => formatValue(v, p.type === "date" ? "yyyy-mm-dd" : numFmt || (Number.isInteger(v) ? "#,##0" : "#,##0.00")).text;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `Histogram of ${p.name}: ${p.histogram.counts.length} bins from ${f(e[0])} to ${f(e[e.length - 1])}`);
    const axis = el("div", "profile-axis");
    axis.append(el("span", undefined, f(e[0])), el("span", undefined, f(e[e.length - 1])));
    c.append(canvas, axis);
    requestAnimationFrame(() => drawHistogram(canvas, p.histogram!.counts));
  }
  const top = p.top.slice(0, 5);
  if (top.length && p.distinct !== p.filled) {
    c.append(el("h4", "profile-sub", "Most common"));
    const ol = el("ol", "profile-top");
    const most = Math.max(...top.map((t) => t.count));
    topLines(p, numFmt)
      .slice(0, 5)
      .forEach(([v, k], i) => {
        const li = el("li");
        const b = el("span", "profile-top__bar");
        b.style.width = `${Math.max(2, (top[i].count / most) * 100)}%`;
        const label = el("span", "profile-top__label", v);
        label.title = v;
        li.append(b, label, el("span", "profile-top__count", k));
        ol.append(li);
      });
    c.append(ol);
  }
  if (p.patterns && p.patterns.length > 1) {
    const det = el("details", "profile-patterns");
    det.append(el("summary", undefined, `${p.patterns.length} text patterns`));
    const pl = el("dl", "profile-stats");
    for (const x of p.patterns.slice(0, 6)) {
      const dt = el("dt", "an-mono", x.pattern || "(empty)");
      dt.title = `e.g. ${x.example}`;
      pl.append(dt, el("dd", undefined, `${count(x.count)} (${pct(x.count, p.filled)})`));
    }
    det.append(pl, el("p", "an-hint", "A is a letter and 9 a digit. Several patterns in one column often mean mixed formats."));
    c.append(det);
  }
  return c;
}

const letterOf = (c: number) => {
  let s = "";
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * Column profiles in the side panel, beside the sheet: one card per column,
 * filled in one by one between frames so a wide 10M-row sheet never freezes.
 */
export function openProfiles(d: ProfileDeps): void {
  const data = readSheetColumns(d.source());
  openSidePanel({
    id: "profiles",
    title: "Column profiles",
    subtitle: `${d.sheetName()} · ${count(data.rows)} rows · ${data.columns.length} columns`,
    onClose: () => d.focusGrid(),
    render: (p) => {
      let cancelled = false;
      const root = el("div", "an-stack profile-panel");
      const status = el("p", "an-hint");
      status.setAttribute("aria-live", "polite");
      const find = el("input");
      find.type = "search";
      find.placeholder = "Find a column";
      find.setAttribute("aria-label", "Find a column");
      const cards = el("div", "profile-cards");
      root.append(status);
      if (data.columns.length > 6) root.append(find);
      root.append(cards);
      p.body.append(root);
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        for (const node of Array.from(cards.children) as HTMLElement[]) node.hidden = !!q && !(node.dataset.name ?? "").includes(q);
      });
      if (!data.rows || !data.columns.length) {
        const empty = el("div", "an-empty");
        empty.append(el("p", undefined, "This sheet has no data to profile. A profile shows, for every column, how full it is, its type, range, totals and most common values: a quick health check before you test or reconcile."));
        root.replaceChildren(empty);
        return;
      }
      const t0 = performance.now();
      let c = 0;
      const step = () => {
        if (cancelled) return;
        const until = performance.now() + 30;
        do {
          const node = card(profileOf(data, c), letterOf(c), data.numFmts[c]);
          node.dataset.name = data.names[c].toLowerCase();
          cards.append(node);
          c++;
        } while (c < data.columns.length && performance.now() < until);
        status.textContent =
          c < data.columns.length ? `Profiling column ${c + 1} of ${data.columns.length}…` : `Profiled in ${Math.max(1, Math.round(performance.now() - t0))} ms. Figures marked "about" or "(est.)" come from a sample.`;
        if (c < data.columns.length) setTimeout(step, 0);
      };
      setTimeout(step, 0);
      return () => {
        cancelled = true;
      };
    },
  });
}
