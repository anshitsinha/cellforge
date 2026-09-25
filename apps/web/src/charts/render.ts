/**
 * Drawing a chart onto a 2D canvas, and finding what's under the pointer.
 *
 * Colours come from CSS variables (see charts.css) so light and dark mode
 * follow the app. Big xy series are downsampled to the plot's pixel width
 * here, since that's where the width is known.
 */
import { formatValue } from "@cellforge/core";
import { dateTicks, extent, niceTicks, tickLabel, type Ticks } from "./axes";
import { downsampleLine, thinScatter, type ChartData, type Series } from "./data";

export interface ChartTheme {
  bg: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  series: string[];
  up: string;
  down: string;
  total: string;
  font: string;
}

/** Colour-blind-safe categorical order, light surface (validated set; see charts.css). */
export const LIGHT_SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const DARK_SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"];

function isDark(color: string): boolean {
  let rgb: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  } else {
    const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
    if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return rgb ? 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128 : false;
}

/** Read the chart colours from CSS variables on (or above) `el`. */
export function readChartTheme(el: HTMLElement): ChartTheme {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg = v("--chart-bg", v("--bg", "#ffffff"));
  const dark = isDark(bg);
  const pal = dark ? DARK_SERIES : LIGHT_SERIES;
  return {
    bg,
    text: v("--text", dark ? "#e3e5e8" : "#1f2328"),
    muted: v("--muted", dark ? "#9aa0a6" : "#656d76"),
    grid: v("--chart-grid", dark ? "#34363b" : "#ebedf0"),
    axis: v("--chart-axis", dark ? "#5f636a" : "#9aa0a6"),
    series: pal.map((c, i) => v(`--chart-${i + 1}`, c)),
    up: v("--chart-up", pal[0]),
    down: v("--chart-down", pal[1]),
    total: v("--chart-total", dark ? "#8b8f96" : "#6b7078"),
    font: css.fontFamily || "system-ui, sans-serif",
  };
}

export interface ChartText {
  title: string;
  xTitle: string;
  yTitle: string;
  y2Title: string;
}

/** What's under the pointer, for a tooltip. */
export interface Hit {
  series: number;
  index: number;
  value: number;
  label: string;
  seriesName: string;
  valueText: string;
  /** where to anchor the tooltip, CSS px */
  px: number;
  py: number;
}

export interface Rendered {
  hitTest(x: number, y: number): Hit | null;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 12;

function valueText(v: number, fmt: string): string {
  return formatValue(v, fmt && fmt.toLowerCase() !== "general" ? fmt : "General").text;
}

function ellipsis(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo ? s.slice(0, lo) + "…" : "";
}

/** A bar with its outer end (away from base) slightly rounded. */
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, outer: "top" | "bottom" | "left" | "right") {
  if (w < 0) [x, w] = [x + w, -w];
  if (h < 0) [y, h] = [y + h, -h];
  const r = Math.min(3, w / 3, h / 2);
  if (r < 1 || typeof ctx.roundRect !== "function") {
    ctx.fillRect(x, y, w, h);
    return;
  }
  const radii = outer === "top" ? [r, r, 0, 0] : outer === "bottom" ? [0, 0, r, r] : outer === "right" ? [0, r, r, 0] : [r, 0, 0, r];
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radii);
  ctx.fill();
}

interface Legend {
  name: string;
  color: string;
  line: boolean;
}

function legendEntries(data: ChartData, theme: ChartTheme): Legend[] {
  if (data.legend) return data.legend.map((l) => ({ name: l.name, color: l.role === "up" ? theme.up : l.role === "down" ? theme.down : theme.total, line: false }));
  if (data.mode === "pie") return data.categories.map((c, i) => ({ name: c, color: theme.series[i % theme.series.length], line: false }));
  if (data.series.length < 2) return [];
  return data.series.map((s) => ({ name: s.name, color: theme.series[s.color % theme.series.length], line: s.kind === "line" || s.kind === "point" }));
}

/**
 * Draw `data` into a w x h (CSS px) area of `ctx`, which should already be
 * scaled for devicePixelRatio. Returns a hit tester in the same CSS px.
 */
export function renderChart(ctx: CanvasRenderingContext2D, data: ChartData, text: ChartText, w: number, h: number, theme: ChartTheme, dpr = 1): Rendered {
  const font = (size: number, weight = 400) => `${weight} ${size}px ${theme.font}`;
  ctx.save();
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "middle";

  let top = PAD;
  let bottom = h - PAD;
  let left = PAD;
  let right = w - PAD;

  if (text.title) {
    ctx.font = font(14, 600);
    ctx.fillStyle = theme.text;
    ctx.textAlign = "left";
    ctx.fillText(ellipsis(ctx, text.title, w - 2 * PAD), PAD, top + 8);
    top += 24;
  }

  // legend: entries in rows across the top
  const entries = legendEntries(data, theme);
  if (entries.length) {
    ctx.font = font(12);
    let x = PAD;
    let y = top + 7;
    for (const e of entries) {
      const label = ellipsis(ctx, e.name, 160);
      const ew = 18 + ctx.measureText(label).width + 14;
      if (x + ew > w - PAD && x > PAD) {
        x = PAD;
        y += 18;
      }
      ctx.fillStyle = e.color;
      if (e.line) ctx.fillRect(x, y - 1, 12, 2.5);
      else bar(ctx, x, y - 5, 10, 10, "top");
      ctx.fillStyle = theme.text;
      ctx.textAlign = "left";
      ctx.fillText(label, x + 16, y);
      x += ew;
    }
    top = y + 16;
  }

  if (data.notes.length) {
    ctx.font = font(11);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "left";
    for (let i = data.notes.length - 1; i >= 0; i--) {
      ctx.fillText(ellipsis(ctx, data.notes[i], w - 2 * PAD), PAD, bottom - 6);
      bottom -= 16;
    }
    bottom -= 4;
  }

  let result: Rendered;
  if (data.mode === "pie") result = drawPie(ctx, data, { x: left, y: top, w: right - left, h: bottom - top }, theme, font);
  else {
    if (text.xTitle) {
      ctx.font = font(12);
      ctx.fillStyle = theme.muted;
      ctx.textAlign = "center";
      ctx.fillText(ellipsis(ctx, text.xTitle, w - 2 * PAD), (left + right) / 2, bottom - 6);
      bottom -= 18;
    }
    const side = (t: string, x: number, angle: number) => {
      ctx.save();
      ctx.translate(x, (top + bottom) / 2);
      ctx.rotate(angle);
      ctx.font = font(12);
      ctx.fillStyle = theme.muted;
      ctx.textAlign = "center";
      ctx.fillText(ellipsis(ctx, t, bottom - top), 0, 0);
      ctx.restore();
    };
    if (text.yTitle) {
      side(text.yTitle, left + 6, -Math.PI / 2);
      left += 18;
    }
    if (text.y2Title && data.series.some((s) => s.axis === 1)) {
      side(text.y2Title, right - 6, Math.PI / 2);
      right -= 18;
    }
    result = drawAxes(ctx, data, { x: left, y: top, w: right - left, h: bottom - top }, theme, font, dpr);
  }
  ctx.restore();
  return result;
}

/** Size the canvas for its CSS box and the screen's pixel ratio, then draw. */
export function drawToCanvas(canvas: HTMLCanvasElement, data: ChartData, text: ChartText, theme: ChartTheme, cssW: number, cssH: number): Rendered {
  const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return renderChart(ctx, data, text, cssW, cssH, theme, dpr);
}

// -----------------------------------------------------------------------------
// pie

function drawPie(ctx: CanvasRenderingContext2D, data: ChartData, area: Rect, theme: ChartTheme, font: (s: number, w?: number) => string): Rendered {
  const values = data.series[0]?.values ?? new Float64Array(0);
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const r = Math.max(0, Math.min(area.w, area.h) / 2 - 4);
  const starts: number[] = [];
  let a = -Math.PI / 2;
  for (let i = 0; i < values.length; i++) {
    const sweep = total ? (values[i] / total) * Math.PI * 2 : 0;
    starts.push(a);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a + sweep);
    ctx.closePath();
    ctx.fillStyle = theme.series[i % theme.series.length];
    ctx.fill();
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (sweep > 0.3 && r > 40) {
      const mid = a + sweep / 2;
      ctx.font = font(11, 600);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText(`${Math.round((values[i] / total) * 100)}%`, cx + Math.cos(mid) * r * 0.65, cy + Math.sin(mid) * r * 0.65);
    }
    a += sweep;
  }
  starts.push(a);
  if (!values.length) {
    ctx.font = font(12);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "center";
    ctx.fillText("No positive numbers to show", cx, cy);
  }
  return {
    hitTest(x, y) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r || !total) return null;
      let ang = Math.atan2(dy, dx);
      if (ang < -Math.PI / 2) ang += Math.PI * 2;
      for (let i = 0; i < values.length; i++) {
        if (ang >= starts[i] && ang < starts[i + 1]) {
          const pct = ` (${((values[i] / total) * 100).toFixed(1)}%)`;
          return { series: 0, index: i, value: values[i], label: data.categories[i], seriesName: data.series[0].name, valueText: valueText(values[i], data.yFmt) + pct, px: x, py: y };
        }
      }
      return null;
    },
  };
}

// -----------------------------------------------------------------------------
// charts with axes

interface Scale {
  ticks: Ticks;
  fmt: string;
  /** value -> pixel along the value direction */
  at(v: number): number;
}

/** Lowest and highest value each axis has to show, stacking included. */
function valueRange(data: ChartData, axis: 0 | 1, n: number): [number, number] | null {
  const list = data.series.filter((s) => s.axis === axis);
  if (!list.length) return null;
  const arrays: ArrayLike<number>[] = [];
  let zero = false;
  for (const s of list) {
    if (s.kind === "column" || s.kind === "area") zero = true;
    if (s.base) {
      const ends = new Float64Array(s.values.length);
      for (let i = 0; i < ends.length; i++) ends[i] = s.base[i] + s.values[i];
      arrays.push(ends, s.base);
    } else if (!data.stacked) arrays.push(s.values);
  }
  if (data.stacked) {
    const pos = new Float64Array(n);
    const neg = new Float64Array(n);
    for (const s of list) {
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v > 0) pos[i] += v;
        else if (v < 0) neg[i] += v;
      }
    }
    arrays.push(pos, neg);
  }
  const e = extent(arrays);
  if (!e) return zero ? [0, 1] : null;
  if (zero) return [Math.min(0, e[0]), Math.max(0, e[1])];
  return e;
}

function drawAxes(ctx: CanvasRenderingContext2D, data: ChartData, area: Rect, theme: ChartTheme, font: (s: number, w?: number) => string, dpr: number): Rendered {
  const xy = data.mode === "xy";
  const horiz = data.horizontal && !xy;
  const n = xy ? (data.xs?.length ?? 0) : data.categories.length;
  const lim = data.limits;

  ctx.font = font(11);
  // value axis labels decide the left margin
  const r0 = valueRange(data, 0, n) ?? [0, 1];
  const r1 = valueRange(data, 1, n);
  const valueLen = horiz ? area.w : area.h;
  const maxTicks = Math.max(2, Math.min(10, Math.floor(valueLen / (horiz ? 80 : 32))));
  const y0t = niceTicks(r0[0], r0[1], maxTicks, { min: lim.yMin, max: lim.yMax });
  const y1t = r1 ? niceTicks(r1[0], r1[1], maxTicks, { min: lim.y2Min, max: lim.y2Max }) : null;
  const yLabels = y0t.values.map((v) => tickLabel(v, data.yFmt, y0t.step));
  const y2Labels = y1t ? y1t.values.map((v) => tickLabel(v, data.y2Fmt, y1t.step)) : [];
  const widest = (a: string[]) => a.reduce((m, s) => Math.max(m, ctx.measureText(s).width), 0);

  let catLabelW = 0;
  if (horiz) catLabelW = Math.min(140, widest(data.categories)) + 8;
  const plot: Rect = { ...area };
  if (horiz) {
    plot.x += catLabelW;
    plot.w -= catLabelW + 8;
    plot.h -= 18;
  } else {
    const lw = widest(yLabels) + 8;
    plot.x += lw;
    plot.w -= lw + (y1t ? widest(y2Labels) + 8 : 8);
    plot.h -= 20;
  }
  plot.w = Math.max(10, plot.w);
  plot.h = Math.max(10, plot.h);

  // x scale for xy charts
  let xScale: Scale | null = null;
  let xTicks: { values: number[]; labels: string[] } | null = null;
  if (xy) {
    const xs = data.xs ?? new Float64Array(0);
    const e = extent([xs]) ?? [0, 1];
    const lo = lim.xMin ?? e[0];
    const hi = lim.xMax ?? e[1];
    const xMax = Math.max(2, Math.min(10, Math.floor(plot.w / 90)));
    if (data.xIsDate) {
      const dt = dateTicks(lo, hi, xMax);
      const span = hi - lo || 1;
      xScale = { ticks: { min: lo, max: hi, step: 1, values: dt.values }, fmt: dt.fmt, at: (v) => plot.x + ((v - lo) / span) * plot.w };
      xTicks = { values: dt.values, labels: dt.values.map((v) => formatValue(v, dt.fmt).text) };
    } else {
      const fixed = { min: lim.xMin, max: lim.xMax };
      // scatter x needn't start at zero, and a line's x span is the data's
      const t = niceTicks(lo, hi, xMax, fixed);
      const xmin = lim.xMin ?? lo;
      const xmax = lim.xMax ?? hi;
      const span = xmax - xmin || 1;
      xScale = { ticks: t, fmt: data.xFmt, at: (v) => plot.x + ((v - xmin) / span) * plot.w };
      const vals = t.values.filter((v) => v >= xmin - 1e-9 && v <= xmax + 1e-9);
      xTicks = { values: vals, labels: vals.map((v) => tickLabel(v, data.xFmt, t.step)) };
    }
  }

  // value scales
  const vStart = horiz ? plot.x : plot.y + plot.h;
  const vEnd = horiz ? plot.x + plot.w : plot.y;
  const span0 = y0t.max - y0t.min || 1;
  const y0: Scale = { ticks: y0t, fmt: data.yFmt, at: (v) => vStart + ((v - y0t.min) / span0) * (vEnd - vStart) };
  const y1: Scale | null = y1t ? { ticks: y1t, fmt: data.y2Fmt, at: (v) => vStart + ((v - y1t.min) / (y1t.max - y1t.min || 1)) * (vEnd - vStart) } : null;
  const scaleOf = (s: Series) => (s.axis === 1 && y1 ? y1 : y0);

  // gridlines and value labels
  let lastRight = -Infinity;
  ctx.lineWidth = 1;
  ctx.font = font(11);
  ctx.fillStyle = theme.muted;
  y0t.values.forEach((v, i) => {
    const p = Math.round(y0.at(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? theme.axis : theme.grid;
    ctx.beginPath();
    if (horiz) {
      ctx.moveTo(p, plot.y);
      ctx.lineTo(p, plot.y + plot.h);
    } else {
      ctx.moveTo(plot.x, p);
      ctx.lineTo(plot.x + plot.w, p);
    }
    ctx.stroke();
    if (horiz) {
      // value labels along the bottom: skip one that would run into the last
      const half = ctx.measureText(yLabels[i]).width / 2;
      if (p - half < lastRight + 6) return;
      lastRight = p + half;
      ctx.textAlign = "center";
      ctx.fillText(yLabels[i], p, plot.y + plot.h + 10);
    } else {
      ctx.textAlign = "right";
      ctx.fillText(yLabels[i], plot.x - 6, p);
    }
  });
  if (y1 && y1t) {
    ctx.textAlign = "left";
    y1t.values.forEach((v, i) => ctx.fillText(y2Labels[i], plot.x + plot.w + 6, Math.round(y1.at(v)) + 0.5));
  }

  // baseline axis
  ctx.strokeStyle = theme.axis;
  ctx.beginPath();
  if (horiz) {
    ctx.moveTo(plot.x + 0.5, plot.y);
    ctx.lineTo(plot.x + 0.5, plot.y + plot.h);
  } else {
    ctx.moveTo(plot.x, plot.y + plot.h + 0.5);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5);
  }
  ctx.stroke();

  if (xy && xScale && xTicks) {
    ctx.fillStyle = theme.muted;
    ctx.textAlign = "center";
    let lastEnd = -Infinity;
    xTicks.values.forEach((v, i) => {
      const p = xScale!.at(v);
      const tw = ctx.measureText(xTicks!.labels[i]).width;
      if (p - tw / 2 < lastEnd + 6) return;
      ctx.fillText(xTicks!.labels[i], p, plot.y + plot.h + 11);
      lastEnd = p + tw / 2;
    });
    return drawXY(ctx, data, plot, xScale, scaleOf, theme, dpr);
  }
  return drawCategories(ctx, data, plot, horiz, scaleOf, y0, theme);
}

// -----------------------------------------------------------------------------
// category charts: column, bar, combo, line/area with text labels

function drawCategories(ctx: CanvasRenderingContext2D, data: ChartData, plot: Rect, horiz: boolean, scaleOf: (s: Series) => Scale, y0: Scale, theme: ChartTheme): Rendered {
  const n = data.categories.length;
  const bandLen = (horiz ? plot.h : plot.w) / Math.max(1, n);
  const bandStart = (i: number) => (horiz ? plot.y : plot.x) + i * bandLen;
  const mid = (i: number) => bandStart(i) + bandLen / 2;
  const colour = (s: Series) => theme.series[s.color % theme.series.length];

  // category labels, thinned out so they don't collide
  ctx.fillStyle = theme.muted;
  if (horiz) {
    const every = Math.max(1, Math.ceil(14 / bandLen));
    ctx.textAlign = "right";
    for (let i = 0; i < n; i += every) ctx.fillText(ellipsis(ctx, data.categories[i], 140), plot.x - 6, mid(i));
  } else {
    let widest = 0;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 200))) widest = Math.max(widest, ctx.measureText(data.categories[i]).width);
    const every = Math.max(1, Math.ceil(Math.min(widest + 8, 120) / bandLen));
    ctx.textAlign = "center";
    const room = Math.max(bandLen * every - 4, 20);
    for (let i = 0; i < n; i += every) ctx.fillText(ellipsis(ctx, data.categories[i], room), mid(i), plot.y + plot.h + 11);
  }

  const columns = data.series.filter((s) => s.kind === "column");
  const inner = bandLen * (1 - data.gap);
  const slots = data.stacked ? 1 : Math.max(1, columns.length);
  const slotLen = inner / slots;
  const posStack = new Float64Array(n);
  const negStack = new Float64Array(n);
  const marks: { s: number; i: number; a: number; b: number }[][] = data.series.map(() => []);

  data.series.forEach((s, si) => {
    const sc = scaleOf(s);
    if (s.kind === "column") {
      const slot = data.stacked ? 0 : columns.indexOf(s);
      for (let i = 0; i < Math.min(n, s.values.length); i++) {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        let from = s.base ? s.base[i] : 0;
        if (data.stacked) {
          from = v >= 0 ? posStack[i] : negStack[i];
          if (v >= 0) posStack[i] += v;
          else negStack[i] += v;
        }
        const a = sc.at(from);
        const b = sc.at(from + v);
        const off = bandStart(i) + (bandLen - inner) / 2 + slot * slotLen;
        const thick = Math.max(1, slotLen - (slots > 1 && slotLen > 6 ? 2 : 0));
        ctx.fillStyle = s.roles ? (s.roles[i] === 0 ? theme.up : s.roles[i] === 1 ? theme.down : theme.total) : colour(s);
        const up = v >= 0;
        if (horiz) bar(ctx, a, off, b - a, thick, up ? "right" : "left");
        else bar(ctx, off, b, thick, a - b, up ? "top" : "bottom");
        marks[si][i] = { s: si, i, a: Math.min(a, b), b: Math.max(a, b) };
        // waterfall connectors
        if (s.base && i + 1 < n && !horiz) {
          const yv = Math.round(sc.at(from + v)) + 0.5;
          ctx.strokeStyle = theme.axis;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(off + thick, yv);
          ctx.lineTo(bandStart(i + 1) + (bandLen - inner) / 2, yv);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  });

  // lines and areas on top of the bars
  const lineStack = new Float64Array(n);
  data.series.forEach((s, si) => {
    if (s.kind === "column") return;
    const sc = scaleOf(s);
    const pts: [number, number][] = [];
    const ys = new Float64Array(n);
    for (let i = 0; i < Math.min(n, s.values.length); i++) {
      const v = s.values[i];
      const lower = data.stacked ? lineStack[i] : 0;
      const val = data.stacked && Number.isFinite(v) ? lower + v : v;
      ys[i] = val;
      if (!Number.isFinite(val)) {
        pts.push([NaN, NaN]);
        continue;
      }
      const p = sc.at(val);
      pts.push(horiz ? [p, mid(i)] : [mid(i), p]);
      marks[si][i] = { s: si, i, a: p, b: p };
    }
    if (s.kind === "area") fillArea(ctx, pts, (i) => (horiz ? [sc.at(data.stacked ? lineStack[i] : 0), mid(i)] : [mid(i), sc.at(data.stacked ? lineStack[i] : 0)]), colour(s));
    strokeLine(ctx, pts, colour(s));
    if (n <= 60 && s.kind !== "area") for (const [x, y] of pts) if (x === x) dot(ctx, x, y, 3, colour(s), theme.bg);
    if (data.stacked) for (let i = 0; i < n; i++) if (Number.isFinite(ys[i])) lineStack[i] = ys[i];
  });

  return {
    hitTest(x, y) {
      const along = horiz ? y : x;
      const across = horiz ? x : y;
      const i = Math.floor((along - (horiz ? plot.y : plot.x)) / bandLen);
      if (i < 0 || i >= n || x < plot.x - 2 || x > plot.x + plot.w + 2 || y < plot.y - 2 || y > plot.y + plot.h + 2) return null;
      let best: { s: number; d: number } | null = null;
      marks.forEach((m, si) => {
        const mk = m[i];
        if (!mk) return;
        // inside a bar wins; otherwise nearest
        const d = across >= mk.a && across <= mk.b ? 0 : Math.min(Math.abs(across - mk.a), Math.abs(across - mk.b));
        // for side-by-side bars, prefer the bar the pointer is over
        const s = data.series[si];
        let bonus = 0;
        if (s.kind === "column" && !data.stacked && columns.length > 1) {
          const slot = columns.indexOf(s);
          const off = bandStart(i) + (bandLen - inner) / 2 + slot * slotLen;
          bonus = along >= off && along <= off + slotLen ? 0 : 1000;
        }
        if (!best || d + bonus < best.d) best = { s: si, d: d + bonus };
      });
      if (!best) return null;
      const s = data.series[(best as { s: number }).s];
      const v = s.values[i];
      const fmt = s.axis === 1 ? data.y2Fmt : y0.fmt;
      const extra = s.base && s.roles?.[i] !== 2 ? ` (running total ${valueText(s.base[i] + v, fmt)})` : "";
      return { series: (best as { s: number }).s, index: i, value: v, label: data.categories[i], seriesName: s.name, valueText: valueText(v, fmt) + extra, px: x, py: y };
    },
  };
}

function strokeLine(ctx: CanvasRenderingContext2D, pts: ArrayLike<[number, number]> | [number, number][], color: string, width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    if (x !== x || y !== y) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    pen = true;
  }
  ctx.stroke();
}

function fillArea(ctx: CanvasRenderingContext2D, pts: [number, number][], floor: (i: number) => [number, number], color: string) {
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = color;
  let start = -1;
  const close = (end: number) => {
    if (start < 0) return;
    ctx.beginPath();
    ctx.moveTo(pts[start][0], pts[start][1]);
    for (let i = start + 1; i <= end; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    for (let i = end; i >= start; i--) {
      const [fx, fy] = floor(i);
      ctx.lineTo(fx, fy);
    }
    ctx.closePath();
    ctx.fill();
    start = -1;
  };
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][0] !== pts[i][0]) close(i - 1);
    else if (start < 0) start = i;
  }
  close(pts.length - 1);
  ctx.restore();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, ring: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// -----------------------------------------------------------------------------
// xy charts: line, area and scatter with numeric or date x

function drawXY(ctx: CanvasRenderingContext2D, data: ChartData, plot: Rect, xScale: Scale, scaleOf: (s: Series) => Scale, theme: ChartTheme, dpr: number): Rendered {
  const xs = data.xs ?? new Float64Array(0);
  const n = xs.length;
  const colour = (s: Series) => theme.series[s.color % theme.series.length];
  // per series: indices of the points actually drawn (null = all)
  const drawn: (Uint32Array | null)[] = [];
  let stack: Float64Array | null = data.stacked ? new Float64Array(n) : null;
  const stacked: Float64Array[] = [];

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x - 4, plot.y - 4, plot.w + 8, plot.h + 8);
  ctx.clip();

  for (const s of data.series) {
    const sc = scaleOf(s);
    let ys: Float64Array = s.values;
    let lower: Float64Array | null = null;
    if (stack) {
      lower = stack;
      ys = new Float64Array(n);
      for (let i = 0; i < n; i++) ys[i] = Number.isFinite(s.values[i]) ? lower[i] + s.values[i] : NaN;
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) next[i] = Number.isFinite(ys[i]) ? ys[i] : lower[i];
      stack = next;
    }
    stacked.push(ys);
    const color = colour(s);
    if (s.kind === "point") {
      const toX = (x: number) => (xScale.at(x) - plot.x) * dpr;
      const toY = (y: number) => (sc.at(y) - plot.y) * dpr;
      const idx = thinScatter(xs, ys, toX, toY, plot.w * dpr + 1, plot.h * dpr + 1);
      drawn.push(idx);
      ctx.fillStyle = color;
      if (idx.length < 4000) for (const i of idx) dot(ctx, xScale.at(xs[i]), sc.at(ys[i]), 3, color, theme.bg);
      else {
        const sz = 1.5;
        for (const i of idx) ctx.fillRect(xScale.at(xs[i]) - sz / 2, sc.at(ys[i]) - sz / 2, sz, sz);
      }
      continue;
    }
    const idx = downsampleLine(xs, ys, plot.w * dpr, data.xSorted);
    drawn.push(idx);
    const m = idx ? idx.length : n;
    const pts: [number, number][] = new Array(m);
    for (let k = 0; k < m; k++) {
      const i = idx ? idx[k] : k;
      pts[k] = Number.isFinite(ys[i]) && Number.isFinite(xs[i]) ? [xScale.at(xs[i]), sc.at(ys[i])] : [NaN, NaN];
    }
    if (s.kind === "area") {
      const base = (k: number): [number, number] => {
        const i = idx ? idx[k] : k;
        return [xScale.at(xs[i]), sc.at(lower ? lower[i] : 0)];
      };
      fillArea(ctx, pts, base, color);
    }
    strokeLine(ctx, pts, color, m > plot.w ? 1.25 : 2);
    if (m <= 60 && s.kind === "line") for (const [x, y] of pts) if (x === x) dot(ctx, x, y, 3, color, theme.bg);
  }
  ctx.restore();

  const xText = (x: number) => (data.xIsDate ? formatValue(x, xScale.fmt.includes("h") ? "d mmm yyyy h:mm" : "d mmm yyyy").text : valueText(x, data.xFmt));
  return {
    hitTest(px, py) {
      if (px < plot.x - 4 || px > plot.x + plot.w + 4 || py < plot.y - 4 || py > plot.y + plot.h + 4 || !n) return null;
      let best: { s: number; i: number; d: number } | null = null;
      data.series.forEach((s, si) => {
        const sc = scaleOf(s);
        const ys = stacked[si];
        const consider = (i: number) => {
          if (!Number.isFinite(ys[i]) || !Number.isFinite(xs[i])) return;
          const dx = xScale.at(xs[i]) - px;
          const dy = sc.at(ys[i]) - py;
          // lines: nearest in x first, then y; scatter: straight distance
          const d = s.kind === "point" ? Math.hypot(dx, dy) : Math.abs(dx) * 4 + Math.abs(dy);
          if (!best || d < best.d) best = { s: si, i, d };
        };
        if (s.kind !== "point" && data.xSorted) {
          // binary search the original data near the pointer's x
          let lo = 0;
          let hi = n - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (!(xScale.at(xs[mid]) < px)) hi = mid;
            else lo = mid + 1;
          }
          for (let i = Math.max(0, lo - 2); i <= Math.min(n - 1, lo + 2); i++) consider(i);
        } else {
          const idx = drawn[si];
          if (idx) for (const i of idx) consider(i);
          else for (let i = 0; i < n; i++) consider(i);
        }
      });
      if (!best) return null;
      const b = best as { s: number; i: number; d: number };
      const s = data.series[b.s];
      if (s.kind === "point" && b.d > 12) return null;
      const v = s.values[b.i];
      return { series: b.s, index: b.i, value: v, label: xText(xs[b.i]), seriesName: s.name, valueText: valueText(v, s.axis === 1 ? data.y2Fmt : data.yFmt), px: xScale.at(xs[b.i]), py: scaleOf(s).at(stacked[b.s][b.i]) };
    },
  };
}
