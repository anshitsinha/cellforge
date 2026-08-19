/**
 * Chart windows: a floating, movable, resizable chart over the sheet, with
 * a small editor beside it (type, range, options), a tooltip and PNG
 * download. Charts redraw when the cells change (call refreshCharts) and
 * when the window is resized.
 */
import "./charts.css";
import { buildChart, comboLines, guessLayout, makeResolver, type ChartData, type ChartSource } from "./data";
import { CHART_TYPES, defaultSpec, formatRange, limitText, parseLimit, parseRange, type ChartSpec, type ChartType, type Limit } from "./model";
import { chartInput } from "./pivotchart";
import { drawToCanvas, readChartTheme, type Rendered } from "./render";

export interface ChartDeps {
  /** the sheet a chart reads, or null when it's gone */
  source(sheetId: string): ChartSource | null;
  activeSheet(): string;
  /** the selected range on the active sheet */
  range(): { top: number; left: number; bottom: number; right: number };
  /**
   * Told about every change to a chart (new, edited, moved, resized), and
   * with spec null when one is closed. Hook for saving charts with the file.
   */
  onChange?(id: string, spec: ChartSpec | null): void;
}

interface ChartWindow {
  spec: ChartSpec;
  deps: ChartDeps;
  el: HTMLElement;
  redraw(rebuild: boolean): void;
  dispose(): void;
}

const windows = new Map<string, ChartWindow>();
let zTop = 45;
let nextId = 1;

/** Specs of every open chart, e.g. to save them. */
export function chartSpecs(): ChartSpec[] {
  return [...windows.values()].map((w) => structuredClone(w.spec));
}

/** Re-read every open chart's cells and redraw it. Call after edits. */
export function refreshCharts(): void {
  for (const w of windows.values()) w.redraw(true);
}

export function closeChart(id: string): void {
  const w = windows.get(id);
  if (!w) return;
  w.dispose();
  windows.delete(id);
  w.deps.onChange?.(id, null);
}

export function closeAllCharts(): void {
  for (const id of [...windows.keys()]) closeChart(id);
}

if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  for (const w of windows.values()) w.redraw(false);
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A spec for the current selection: the whole used area when only one cell is selected. */
function specFromSelection(deps: ChartDeps): ChartSpec {
  const sheetId = deps.activeSheet();
  const src = deps.source(sheetId);
  let r = deps.range();
  if (r.top === r.bottom && r.left === r.right && src?.usedRange) {
    const u = src.usedRange();
    if (u.rows > 0 && u.cols > 0) r = { top: 0, left: 0, bottom: u.rows - 1, right: u.cols - 1 };
  }
  while (windows.has(`chart${nextId}`)) nextId++;
  const spec = defaultSpec(`chart${nextId++}`, { sheetId, ...r });
  if (src) Object.assign(spec, guessLayout(src, spec.range));
  const off = windows.size * 28;
  spec.frame = { x: Math.max(8, Math.round(innerWidth / 2 - 300) + off), y: Math.max(8, Math.round(innerHeight / 2 - 200) + off), w: 600, h: 380 };
  return spec;
}

/**
 * Open a chart window. With no spec, charts the selection (or the whole
 * used area of the sheet when one cell is selected) as columns. Returns the
 * chart's id.
 */
export function openChart(deps: ChartDeps, given?: ChartSpec): string {
  const spec = given ? structuredClone(given) : specFromSelection(deps);
  const existing = windows.get(spec.id);
  if (existing) {
    // reopening with a new spec: rebuild the window so the editor shows it
    existing.dispose();
    windows.delete(spec.id);
  }

  const win = el("div", "chart-window");
  win.setAttribute("role", "dialog");
  const place = () => {
    const f = spec.frame;
    win.style.left = `${f.x}px`;
    win.style.top = `${f.y}px`;
    win.style.width = `${f.w}px`;
    win.style.height = `${f.h}px`;
  };
  place();
  win.style.zIndex = String(++zTop);

  const head = el("div", "chart-head");
  const name = el("span", "chart-name");
  const editBtn = el("button", "", "Edit");
  editBtn.type = "button";
  editBtn.title = "Chart type, range and options";
  const pngBtn = el("button", "", "PNG");
  pngBtn.type = "button";
  pngBtn.title = "Download as a PNG image";
  const closeBtn = el("button", "", "✕");
  closeBtn.type = "button";
  closeBtn.title = "Close chart";
  closeBtn.setAttribute("aria-label", "Close chart");
  head.append(name, editBtn, pngBtn, closeBtn);

  const body = el("div", "chart-body");
  const wrap = el("div", "chart-canvas-wrap");
  const canvas = el("canvas");
  canvas.setAttribute("role", "img");
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  const empty = el("div", "chart-empty");
  empty.hidden = true;
  wrap.append(canvas, tip, empty);
  const editor = el("form", "chart-editor");
  editor.hidden = !!given;
  body.append(wrap, editor);
  win.append(head, body);
  document.body.append(win);

  let data: ChartData | null = null;
  let rendered: Rendered | null = null;
  let frame = 0;
  let needRebuild = true;

  const changed = () => deps.onChange?.(spec.id, structuredClone(spec));

  const draw = () => {
    frame = 0;
    if (needRebuild || !data) {
      needRebuild = false;
      try {
        // a pivot chart works its pivot out again here, so it follows the sheet
        const input = chartInput(spec, deps.source);
        if (!input) {
          data = null;
          empty.textContent = "The sheet this chart reads has been deleted.";
          empty.hidden = false;
          return;
        }
        data = buildChart(input.src, input.spec, makeResolver((sheet, row, col) => deps.source(sheet)?.getCell(row, col) ?? null));
        empty.hidden = true;
      } catch (e) {
        data = null;
        empty.textContent = `Can't draw this chart: ${(e as Error).message}`;
        empty.hidden = false;
        return;
      }
      syncSeriesRows();
    }
    const label = spec.title || `${CHART_TYPES.find((t) => t.type === spec.type)?.label ?? "Chart"} of ${spec.pivot ? "a pivot" : formatRange(spec.range)}`;
    name.textContent = label;
    win.setAttribute("aria-label", label);
    canvas.setAttribute("aria-label", label);
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w < 10 || h < 10) return;
    rendered = drawToCanvas(canvas, data, spec, readChartTheme(win), w, h);
  };
  const redraw = (rebuild: boolean) => {
    if (rebuild) needRebuild = true;
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // --- moving, resizing, bringing to front
  win.addEventListener("pointerdown", () => {
    if (win.style.zIndex !== String(zTop)) win.style.zIndex = String(++zTop);
  });
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
    e.preventDefault();
    const sx = e.clientX - spec.frame.x;
    const sy = e.clientY - spec.frame.y;
    head.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      spec.frame.x = Math.round(Math.min(innerWidth - 60, Math.max(-spec.frame.w + 80, m.clientX - sx)));
      spec.frame.y = Math.round(Math.min(innerHeight - 30, Math.max(0, m.clientY - sy)));
      place();
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      head.removeEventListener("pointerup", up);
      head.removeEventListener("pointercancel", up);
      changed();
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up);
    head.addEventListener("pointercancel", up);
  });
  let resizeTimer = 0;
  const ro = new ResizeObserver(() => {
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    if (w !== spec.frame.w || h !== spec.frame.h) {
      spec.frame.w = w;
      spec.frame.h = h;
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(changed, 300);
    }
    redraw(false);
  });
  ro.observe(wrap);

  // --- buttons
  editBtn.addEventListener("click", () => {
    editor.hidden = !editor.hidden;
    if (!editor.hidden) editor.querySelector<HTMLElement>("select, input")?.focus();
  });
  closeBtn.addEventListener("click", () => closeChart(spec.id));
  pngBtn.addEventListener("click", () => {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${(spec.title || "chart").replace(/[\\/:*?"<>|]+/g, "_")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, "image/png");
  });
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !editor.hidden) {
      editor.hidden = true;
      e.stopPropagation();
    }
  });

  // --- tooltip
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const hit = rendered?.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) {
      tip.hidden = true;
      return;
    }
    tip.textContent = "";
    const b = el("b", "", hit.label);
    tip.append(b, `\n${data && data.series.length > 1 ? hit.seriesName + ": " : ""}${hit.valueText}`);
    tip.hidden = false;
    const x = Math.min(wrap.clientWidth - tip.offsetWidth - 4, e.clientX - r.left + 12);
    const y = e.clientY - r.top - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${y < 4 ? e.clientY - r.top + 16 : y}px`;
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));

  // --- the editor
  const field = (label: string, input: HTMLElement, types?: ChartType[], hint?: string) => {
    const l = el("label");
    l.append(label, input);
    if (hint) l.append(el("small", "", hint));
    if (types) l.dataset.types = types.join(" ");
    editor.append(l);
    return l;
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void, types?: ChartType[]) => {
    const l = el("label", "check");
    const c = el("input");
    c.type = "checkbox";
    c.checked = get();
    c.addEventListener("change", () => {
      set(c.checked);
      update();
    });
    l.append(c, label);
    if (types) l.dataset.types = types.join(" ");
    editor.append(l);
    return { label: l, input: c };
  };
  const text = (get: () => string, set: (v: string) => boolean, placeholder = "") => {
    const i = el("input");
    i.value = get();
    i.placeholder = placeholder;
    i.addEventListener("input", () => {
      const ok = set(i.value);
      i.classList.toggle("bad", !ok);
      if (ok) update();
    });
    return i;
  };
  const limitInput = (key: "yMin" | "yMax" | "xMin" | "xMax" | "asOf", placeholder: string) =>
    text(
      () => limitText(spec[key]),
      (v) => {
        const l: Limit | undefined = parseLimit(v, spec.range.sheetId);
        if (l === undefined) return false;
        spec[key] = l;
        return true;
      },
      placeholder,
    );
  const pair = (a: HTMLElement, b: HTMLElement) => {
    const d = el("div", "pair");
    d.append(a, b);
    return d;
  };

  const typeSel = el("select");
  for (const t of CHART_TYPES) typeSel.append(new Option(t.label, t.type));
  typeSel.value = spec.type;
  typeSel.addEventListener("change", () => {
    spec.type = typeSel.value as ChartType;
    showFields();
    update();
  });
  field("Chart", typeSel);

  if (spec.pivot) {
    const fixed = el("input");
    fixed.value = "A pivot of this sheet";
    fixed.disabled = true;
    field("Data", fixed, undefined, "Change the pivot in the pivot table builder and chart it again.");
  } else
    field(
      "Data range",
      text(
        () => formatRange(spec.range),
        (v) => {
          const r = parseRange(v);
          if (!r) return false;
          spec.range = { sheetId: deps.activeSheet(), ...r };
          return true;
        },
        "A1:C20",
      ),
      undefined,
      "On the sheet you're on now. Whole columns like A:C work.",
    );

  const seriesSel = el("select");
  seriesSel.append(new Option("Columns", "columns"), new Option("Rows", "rows"));
  seriesSel.value = spec.seriesIn;
  field("Series in", seriesSel, ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "pie", "histogram"]);
  const namesBox = check("", () => spec.names, (v) => (spec.names = v));
  const labelsBox = check("", () => spec.labels, (v) => (spec.labels = v), ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "pie"]);
  const layoutText = () => {
    const cols = spec.seriesIn === "columns";
    namesBox.label.lastChild!.textContent = cols ? "First row has the names" : "First column has the names";
    const x = spec.type === "scatter" ? "x values" : "labels";
    labelsBox.label.lastChild!.textContent = cols ? `First column has the ${x}` : `First row has the ${x}`;
  };
  seriesSel.addEventListener("change", () => {
    spec.seriesIn = seriesSel.value as "columns" | "rows";
    layoutText();
    update();
  });

  field("Title", text(() => spec.title, (v) => ((spec.title = v), true)));
  const noPie: ChartType[] = ["column", "bar", "line", "area", "scatter", "combo", "histogram", "waterfall", "pareto", "benford", "ageing"];
  field("Horizontal axis title", text(() => spec.xTitle, (v) => ((spec.xTitle = v), true)), noPie);
  field("Vertical axis title", text(() => spec.yTitle, (v) => ((spec.yTitle = v), true)), noPie);
  field("Right axis title", text(() => spec.y2Title, (v) => ((spec.y2Title = v), true)), ["combo", "pareto"]);
  const valueTypes: ChartType[] = ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "histogram", "ageing"];
  field("Value axis min / max", pair(limitInput("yMin", "auto"), limitInput("yMax", "auto")), valueTypes, "A number, or a cell like F1 to read it from.");
  field("X axis min / max", pair(limitInput("xMin", "auto"), limitInput("xMax", "auto")), ["line", "area", "scatter"]);
  check("Stacked", () => spec.stacked, (v) => (spec.stacked = v), ["column", "bar", "line", "area"]);
  field("Number format", text(() => spec.numFmt, (v) => ((spec.numFmt = v.trim()), true), "from the cells"), valueTypes.concat("pie"), "Like #,##0 or 0.0%.");

  // histogram
  field(
    "Bin width",
    text(
      () => (spec.binWidth === null ? "" : String(spec.binWidth)),
      (v) => {
        const n = Number(v);
        if (v.trim() && !(n > 0)) return false;
        spec.binWidth = v.trim() ? n : null;
        return true;
      },
      "automatic",
    ),
    ["histogram"],
  );
  const ruleSel = el("select");
  ruleSel.append(new Option("Freedman–Diaconis (robust to outliers)", "fd"), new Option("Sturges (fewer bins)", "sturges"));
  ruleSel.value = spec.binRule;
  ruleSel.addEventListener("change", () => {
    spec.binRule = ruleSel.value as "fd" | "sturges";
    update();
  });
  field("Automatic bins by", ruleSel, ["histogram"]);

  // ageing
  field("Age at", limitInput("asOf", "today"), ["ageing"], "A date serial, or a cell holding the date.");
  field(
    "Buckets (days)",
    text(
      () => spec.buckets.join(", "),
      (v) => {
        const b = v.split(/[,;\s]+/).filter(Boolean).map(Number);
        if (!b.length || b.some((x) => !(x > 0))) return false;
        spec.buckets = b;
        return true;
      },
      "30, 60, 90, 120",
    ),
    ["ageing"],
    "First column dates, second column amounts (optional).",
  );

  // combo: per-series line / right axis
  const seriesBox = el("div", "chart-series");
  seriesBox.dataset.types = "combo";
  editor.append(seriesBox);
  let seriesKey = "";
  function syncSeriesRows() {
    if (spec.type !== "combo" || !data) return;
    const names = data.series.map((s) => s.name);
    const lines = comboLines(spec, names.length);
    const key = names.join("\u0000") + "|" + lines.join(",") + "|" + spec.secondary.join(",");
    if (key === seriesKey) return;
    seriesKey = key;
    seriesBox.textContent = "";
    const head = el("div", "chart-series-row chart-series-head");
    head.append(el("span", "", "Series"), el("span", "", "Line"), el("span", "", "Right"));
    seriesBox.append(head);
    names.forEach((n, i) => {
      const row = el("div", "chart-series-row");
      const line = el("input");
      line.type = "checkbox";
      line.checked = lines.includes(i);
      line.title = "Draw as a line";
      line.addEventListener("change", () => {
        const cur = new Set(comboLines(spec, names.length));
        if (line.checked) cur.add(i);
        else cur.delete(i);
        spec.lines = [...cur].sort((a, b) => a - b);
        // no lines at all: keep that choice rather than falling back to the default
        if (!spec.lines.length) spec.lines = [-1];
        update();
      });
      const right = el("input");
      right.type = "checkbox";
      right.checked = spec.secondary.includes(i);
      right.title = "Use the right-hand axis";
      right.addEventListener("change", () => {
        spec.secondary = right.checked ? [...new Set([...spec.secondary, i])].sort((a, b) => a - b) : spec.secondary.filter((x) => x !== i);
        update();
      });
      const label = el("span", "", n);
      label.title = n;
      row.append(label, line, right);
      seriesBox.append(row);
    });
  }

  function showFields() {
    for (const node of editor.querySelectorAll<HTMLElement>("[data-types]")) node.hidden = !node.dataset.types!.split(" ").includes(spec.type);
    layoutText();
    seriesKey = "";
  }
  editor.addEventListener("submit", (e) => e.preventDefault());
  let changeTimer = 0;
  function update() {
    redraw(true);
    clearTimeout(changeTimer);
    changeTimer = window.setTimeout(changed, 400);
  }
  showFields();

  const dispose = () => {
    ro.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(changeTimer);
    clearTimeout(resizeTimer);
    win.remove();
  };
  windows.set(spec.id, { spec, deps, el: win, redraw, dispose });
  // a window may have been restored off-screen on a smaller display
  if (spec.frame.x > innerWidth - 60 || spec.frame.y > innerHeight - 30) {
    spec.frame.x = Math.max(8, innerWidth - spec.frame.w - 8);
    spec.frame.y = Math.max(8, innerHeight - spec.frame.h - 8);
    place();
  }
  if (!given) changed();
  redraw(true);
  return spec.id;
}
