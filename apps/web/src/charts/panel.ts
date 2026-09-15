/**
 * Charts on the sheet, and the chart editor in the side panel.
 *
 * - "Insert chart" opens the editor in the side panel with a live preview
 *   and a sensible first chart (charts/defaults.ts: amounts over time or by
 *   a category, never IDs or account codes as series). Nothing is added to
 *   the workbook until "Insert chart"; Esc or Cancel leaves it as it was.
 * - An inserted chart is an object over the sheet: drag it by its header,
 *   resize it from the corner, nudge it with the arrow keys. Edit (or
 *   Enter, or a double-click) opens the same editor beside the grid and the
 *   chart follows every change. Esc puts focus back on the sheet; Delete
 *   (or the bin) removes the chart, with Undo in the toast.
 * - Charts redraw when the cells change (refreshCharts) and when resized.
 */
import "./charts.css";
import "../analysis.css";
import type { DateGroup, PivotAgg } from "@cellforge/core";
import { closeSidePanel, currentSidePanel, openSidePanel } from "../ui/sidepanel";
import { icon, iconButton } from "../ui/icons";
import { toast } from "../ui/toast";
import { makeButton } from "../ui/dialog";
import { readSheetColumns, type SheetColumns } from "../pivotpanel";
import { buildChart, clampRange, comboLines, guessLayout, makeResolver, type ChartData, type ChartSource } from "./data";
import { isIdLike, profileColumns, suggestChart, type ColumnInfo } from "./defaults";
import { CHART_TYPES, colLetters, defaultSpec, formatRange, limitText, parseLimit, parseRange, type ChartSpec, type ChartType, type Limit, type SavedPivot } from "./model";
import { chartInput, isColumnSource } from "./pivotchart";
import { pivotChartSpec, PIVOT_CHART_TYPES } from "./pivotspec";
import { drawToCanvas, readChartTheme, type Rendered } from "./render";

export interface ChartDeps {
  /** the sheet a chart reads, or null when it's gone */
  source(sheetId: string): ChartSource | null;
  activeSheet(): string;
  /** the selected range on the active sheet */
  range(): { top: number; left: number; bottom: number; right: number };
  /**
   * Told about every change to a chart (new, edited, moved, resized), and
   * with spec null when one is removed. Hook for saving charts with the file.
   */
  onChange?(id: string, spec: ChartSpec | null): void;
  /** put keyboard focus back on the grid (Esc on a chart) */
  focusGrid?(): void;
}

interface ChartWindow {
  spec: ChartSpec;
  deps: ChartDeps;
  el: HTMLElement;
  redraw(rebuild: boolean): void;
  /** the spec changed in the editor */
  respec(spec: ChartSpec): void;
  dispose(): void;
}

const windows = new Map<string, ChartWindow>();
let zTop = 45;
let nextId = 1;

/** Specs of every chart on the sheet, e.g. to save them. */
export function chartSpecs(): ChartSpec[] {
  return [...windows.values()].map((w) => structuredClone(w.spec));
}

/** Re-read every chart's cells and redraw it. Call after edits. */
export function refreshCharts(): void {
  for (const w of windows.values()) w.redraw(true);
  previewRedraw?.();
}

/** Take a chart off the screen and tell onChange it's gone (removes it from the workbook). */
export function closeChart(id: string): void {
  const w = windows.get(id);
  if (!w) return;
  w.dispose();
  windows.delete(id);
  if (currentSidePanel() === `chart:${id}`) closeSidePanel();
  w.deps.onChange?.(id, null);
}

export function closeAllCharts(): void {
  for (const id of [...windows.keys()]) closeChart(id);
}

if (typeof matchMedia === "function")
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    for (const w of windows.values()) w.redraw(false);
    previewRedraw?.();
  });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const typeLabel = (t: ChartType) => CHART_TYPES.find((x) => x.type === t)?.label ?? "Chart";

/** What a chart is called when it has no title. */
export function chartName(spec: ChartSpec): string {
  return spec.title || `${typeLabel(spec.type)} of ${spec.pivot ? "a pivot" : formatRange(spec.range)}`;
}

type Named = { getColumnName?(c: number): string | undefined };

// ------------------------------------------------------------ new charts --

/** Where a new chart sits: over the right half of the sheet. */
function newFrame(): ChartSpec["frame"] {
  const sheet = document.getElementById("sheet")?.getBoundingClientRect();
  const area = sheet && sheet.width > 200 ? sheet : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const w = Math.min(600, Math.max(320, Math.round(area.width * 0.48)));
  const h = Math.min(380, Math.max(240, Math.round(area.height * 0.55)));
  const off = (windows.size % 5) * 24;
  return { x: Math.max(8, Math.round(area.left + area.width - w - 32 - off)), y: Math.round(area.top + 48 + off), w, h };
}

function freshId(): string {
  while (windows.has(`chart${nextId}`)) nextId++;
  return `chart${nextId++}`;
}

/**
 * The first chart for the selection (or the whole used area when one cell
 * is selected), as suggested by charts/defaults.ts. `note` says why there
 * is nothing sensible to chart, when that's so.
 */
export function specFromSelection(deps: ChartDeps): { spec: ChartSpec; note: string | null } {
  const sheetId = deps.activeSheet();
  const src = deps.source(sheetId);
  let r = deps.range();
  let whole = false;
  if (src?.usedRange) {
    const u = src.usedRange();
    if (u.rows > 0 && u.cols > 0) {
      if (r.top === r.bottom && r.left === r.right) r = { top: 0, left: 0, bottom: u.rows - 1, right: u.cols - 1 };
      // the whole table is selected: a summary of every row is fair game
      whole = r.top === 0 && r.left === 0 && r.bottom >= u.rows - 1 && r.right >= u.cols - 1;
    }
  }
  const id = freshId();
  const spec = defaultSpec(id, { sheetId, ...r });
  spec.frame = newFrame();
  if (!src) return { spec, note: null };
  Object.assign(spec, guessLayout(src, spec.range));
  if (spec.seriesIn !== "columns") return { spec, note: null };
  const cols = profileColumns(src, spec.range, spec.names, (c) => (src as Named).getColumnName?.(c));
  const s = suggestChart(cols, { canPivot: whole && isColumnSource(src) });
  if (s.kind === "none") return { spec, note: s.reason };
  if (s.kind === "pivot") {
    const names = readSheetColumns(src as never).names;
    const saved: SavedPivot = {
      rows: [{ field: s.rowField, ...(s.group ? { group: s.group } : {}) }],
      cols: [],
      values: s.values.map((field) => ({ field, agg: s.agg })),
      filters: [],
      subtotals: false,
      grandTotals: false,
      names,
    };
    const p = pivotChartSpec(id, sheetId, saved, s.type, s.title);
    p.frame = spec.frame;
    return { spec: p, note: null };
  }
  spec.type = s.type;
  spec.title = s.title;
  spec.series = s.series;
  if (s.labelCol !== null) {
    spec.labels = true;
    spec.labelCol = s.labelCol;
  } else spec.labels = false;
  return { spec, note: null };
}

/**
 * Open a chart. With a spec, shows that chart on the sheet (restoring a
 * saved one). Without one, opens the editor in the side panel for a new
 * chart of the selection; it is added to the workbook on "Insert chart".
 * Returns the chart's id.
 */
export function openChart(deps: ChartDeps, given?: ChartSpec): string {
  if (!given) {
    const { spec, note } = specFromSelection(deps);
    openEditor(deps, spec, "new", note);
    return spec.id;
  }
  const spec = structuredClone(given);
  const existing = windows.get(spec.id);
  if (existing) {
    existing.dispose();
    windows.delete(spec.id);
  }
  mountWindow(deps, spec);
  return spec.id;
}

/** Open the editor for a chart on the sheet (e.g. from a context menu). */
export function editChart(id: string): void {
  const w = windows.get(id);
  if (w) openEditor(w.deps, w.spec, "edit");
}

// ---------------------------------------------------------- the object --

function mountWindow(deps: ChartDeps, spec: ChartSpec): void {
  const win = el("section", "chart-window");
  win.tabIndex = 0;
  win.setAttribute("role", "figure");
  win.setAttribute("aria-roledescription", "chart");
  const place = () => {
    const f = spec.frame;
    win.style.left = `${f.x}px`;
    win.style.top = `${f.y}px`;
    win.style.width = `${f.w}px`;
    win.style.height = `${f.h}px`;
  };
  place();
  win.style.zIndex = String(++zTop);

  const head = el("header", "chart-head");
  head.title = "Drag to move · Enter to edit · Delete to remove";
  const name = el("span", "chart-name");
  const editBtn = iconButton("settings", "Edit chart", { size: "sm", onClick: () => openEditor(deps, spec, "edit") });
  const pngBtn = iconButton("download", "Download as PNG", { size: "sm", onClick: () => downloadPng(canvas, spec) });
  const delBtn = iconButton("trash", "Delete chart", { size: "sm", onClick: () => removeWithUndo(spec.id) });
  head.append(name, editBtn, pngBtn, delBtn);

  const wrap = el("div", "chart-canvas-wrap");
  const canvas = el("canvas");
  canvas.setAttribute("role", "img");
  const tip = el("div", "chart-tip");
  tip.hidden = true;
  const empty = el("div", "chart-empty");
  empty.hidden = true;
  wrap.append(canvas, tip, empty);
  win.append(head, wrap);
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
      const built = build(deps, spec);
      data = built.data;
      empty.textContent = built.error ?? "";
      empty.hidden = !built.error;
      canvas.style.visibility = data ? "" : "hidden";
      if (!data) return;
    }
    const label = chartName(spec);
    name.textContent = label;
    name.title = label;
    win.setAttribute("aria-label", label);
    canvas.setAttribute("aria-label", label);
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w < 10 || h < 10) return;
    // the header shows the title, so the canvas doesn't repeat it
    rendered = drawToCanvas(canvas, data, { ...spec, title: "" }, readChartTheme(win), w, h);
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
    win.focus({ preventScroll: true });
    const sx = e.clientX - spec.frame.x;
    const sy = e.clientY - spec.frame.y;
    head.setPointerCapture(e.pointerId);
    win.classList.add("is-moving");
    const move = (m: PointerEvent) => {
      spec.frame.x = Math.round(Math.min(innerWidth - 60, Math.max(-spec.frame.w + 80, m.clientX - sx)));
      spec.frame.y = Math.round(Math.min(innerHeight - 30, Math.max(0, m.clientY - sy)));
      place();
    };
    const up = () => {
      win.classList.remove("is-moving");
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

  // --- keyboard: Esc back to the sheet, Delete removes, Enter edits, arrows nudge
  win.addEventListener("keydown", (e) => {
    if (e.target !== win) {
      if (e.key === "Escape") {
        e.preventDefault();
        win.focus();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (currentSidePanel() === `chart:${spec.id}`) closeSidePanel();
      if (deps.focusGrid) deps.focusGrid();
      else win.blur();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      removeWithUndo(spec.id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      openEditor(deps, spec, "edit");
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 32 : 8;
      if (e.key === "ArrowLeft") spec.frame.x -= step;
      if (e.key === "ArrowRight") spec.frame.x += step;
      if (e.key === "ArrowUp") spec.frame.y = Math.max(0, spec.frame.y - step);
      if (e.key === "ArrowDown") spec.frame.y += step;
      place();
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(changed, 300);
    }
  });
  win.addEventListener("dblclick", (e) => {
    if (!(e.target as HTMLElement).closest("button")) openEditor(deps, spec, "edit");
  });

  attachTooltip(canvas, wrap, tip, () => rendered, () => data);

  const dispose = () => {
    ro.disconnect();
    cancelAnimationFrame(frame);
    clearTimeout(resizeTimer);
    win.remove();
  };
  windows.set(spec.id, {
    spec,
    deps,
    el: win,
    redraw,
    respec(next) {
      const keep = spec.frame;
      for (const k of Object.keys(spec) as (keyof ChartSpec)[]) delete spec[k];
      Object.assign(spec, structuredClone(next), { frame: keep });
      redraw(true);
    },
    dispose,
  });
  // a window may have been restored off-screen on a smaller display
  if (spec.frame.x > innerWidth - 60 || spec.frame.y > innerHeight - 30) {
    spec.frame.x = Math.max(8, innerWidth - spec.frame.w - 8);
    spec.frame.y = Math.max(8, innerHeight - spec.frame.h - 8);
    place();
  }
  redraw(true);
}

function build(deps: ChartDeps, spec: ChartSpec): { data: ChartData | null; error: string | null } {
  try {
    // a pivot chart works its pivot out again here, so it follows the sheet
    const input = chartInput(spec, deps.source);
    if (!input) return { data: null, error: "The sheet this chart reads has been deleted." };
    const data = buildChart(input.src, input.spec, makeResolver((sheet, row, col) => deps.source(sheet)?.getCell(row, col) ?? null));
    if (!data.series.length) return { data: null, error: "Nothing to draw yet. Pick at least one column of numbers under Values." };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: `Can't draw this chart: ${(e as Error).message}` };
  }
}

function attachTooltip(canvas: HTMLCanvasElement, wrap: HTMLElement, tip: HTMLElement, rendered: () => Rendered | null, data: () => ChartData | null): void {
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    const hit = rendered()?.hitTest(e.clientX - r.left, e.clientY - r.top);
    if (!hit) {
      tip.hidden = true;
      return;
    }
    tip.textContent = "";
    const d = data();
    tip.append(el("b", "", hit.label), `\n${d && d.series.length > 1 ? hit.seriesName + ": " : ""}${hit.valueText}`);
    tip.hidden = false;
    const x = Math.min(wrap.clientWidth - tip.offsetWidth - 4, e.clientX - r.left + 12);
    const y = e.clientY - r.top - tip.offsetHeight - 10;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${y < 4 ? e.clientY - r.top + 16 : y}px`;
  });
  canvas.addEventListener("pointerleave", () => (tip.hidden = true));
}

function downloadPng(canvas: HTMLCanvasElement, spec: ChartSpec): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${chartName(spec).replace(/[\\/:*?"<>|]+/g, "_")}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");
}

function removeWithUndo(id: string): void {
  const w = windows.get(id);
  if (!w) return;
  const spec = structuredClone(w.spec);
  const deps = w.deps;
  closeChart(id);
  deps.focusGrid?.();
  toast({ kind: "info", text: `Deleted the chart "${chartName(spec)}"`, action: { label: "Undo", run: () => deps.onChange?.(spec.id, spec) } });
}

// ------------------------------------------------------------ the editor --

/** A small drawing of each chart type for the type picker. */
function glyph(t: ChartType): string {
  const p: Record<string, string> = {
    column: '<rect x="3" y="10" width="4" height="9" rx="1"/><rect x="10" y="5" width="4" height="14" rx="1"/><rect x="17" y="12" width="4" height="7" rx="1"/>',
    bar: '<rect x="3" y="3" width="12" height="4" rx="1"/><rect x="3" y="9" width="17" height="4" rx="1"/><rect x="3" y="15" width="8" height="4" rx="1"/>',
    line: '<path d="M3 17l5-6 4 3 5-8 4 4" fill="none"/>',
    area: '<path d="M3 19V15l5-6 4 3 5-7 4 4v10z" opacity=".35" stroke="none"/><path d="M3 15l5-6 4 3 5-7 4 4" fill="none"/>',
    pie: '<path d="M11 4a8 8 0 1 0 8 8h-8z" opacity=".45" stroke="none"/><path d="M13 2.5a7.5 7.5 0 0 1 7.5 7.5H13z" stroke="none"/>',
    scatter: '<circle cx="5" cy="16" r="1.7" stroke="none"/><circle cx="9" cy="11" r="1.7" stroke="none"/><circle cx="13" cy="14" r="1.7" stroke="none"/><circle cx="16" cy="7" r="1.7" stroke="none"/><circle cx="20" cy="9" r="1.7" stroke="none"/>',
    combo: '<rect x="3" y="11" width="4" height="8" rx="1" opacity=".4" stroke="none"/><rect x="10" y="8" width="4" height="11" rx="1" opacity=".4" stroke="none"/><rect x="17" y="12" width="4" height="7" rx="1" opacity=".4" stroke="none"/><path d="M4 9l7-4 7 3" fill="none"/>',
  };
  return `<svg width="28" height="22" viewBox="0 0 24 22" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p[t] ?? ""}</svg>`;
}

const MAIN_TYPES: ChartType[] = ["column", "bar", "line", "area", "pie", "scatter", "combo"];
const ANALYST_TYPES: ChartType[] = ["histogram", "waterfall", "pareto", "benford", "ageing"];
const SHORT: Partial<Record<ChartType, string>> = { combo: "Combo" };

/** Redraws the editor's preview (set while a "new chart" editor is open). */
let previewRedraw: (() => void) | null = null;

/**
 * The editor in the side panel. "new": a draft with a preview, added on
 * Insert. "edit": changes go straight to the chart on the sheet.
 */
function openEditor(deps: ChartDeps, original: ChartSpec, mode: "new" | "edit", note: string | null = null): void {
  const spec = structuredClone(original);
  const panelId = `chart:${spec.id}`;
  let commitTimer = 0;
  const cleanups: (() => void)[] = [];

  const commit = () => {
    if (mode !== "edit") return;
    windows.get(spec.id)?.respec(spec);
    clearTimeout(commitTimer);
    commitTimer = window.setTimeout(() => deps.onChange?.(spec.id, structuredClone(windows.get(spec.id)?.spec ?? spec)), 350);
  };

  openSidePanel({
    id: panelId,
    title: mode === "new" ? "New chart" : "Edit chart",
    subtitle: mode === "new" ? "Pick what to show. The preview follows." : chartName(spec),
    onClose: () => {
      if (mode === "edit") windows.get(spec.id)?.el.focus({ preventScroll: true });
      else deps.focusGrid?.();
    },
    render: (p) => {
      const root = el("div", "an-stack an-stack--loose chart-editor");
      p.body.append(root);
      let data: ChartData | null = null;

      // --- preview (new charts only; an edited chart is its own preview)
      if (mode === "new") {
        const box = el("div", "an-preview chart-preview");
        const canvas = el("canvas");
        canvas.setAttribute("role", "img");
        const tip = el("div", "chart-tip");
        tip.hidden = true;
        const previewEmpty = el("div", "chart-empty");
        previewEmpty.hidden = true;
        box.append(canvas, tip, previewEmpty);
        root.append(box);
        let rendered: Rendered | null = null;
        let raf = 0;
        attachTooltip(canvas, box, tip, () => rendered, () => data);
        const drawPreview = () => {
          raf = 0;
          const built = build(deps, spec);
          data = built.data;
          previewEmpty.hidden = !built.error;
          previewEmpty.textContent = built.error ?? "";
          canvas.style.visibility = data ? "" : "hidden";
          if (!data) return;
          const w = box.clientWidth;
          const h = box.clientHeight;
          if (w < 10 || h < 10) return;
          rendered = drawToCanvas(canvas, data, spec, readChartTheme(box), w, h);
          canvas.setAttribute("aria-label", `Preview: ${chartName(spec)}`);
        };
        previewRedraw = () => {
          if (!raf) raf = requestAnimationFrame(drawPreview);
        };
        const ro = new ResizeObserver(() => previewRedraw?.());
        ro.observe(box);
        if (note) {
          const n = el("div", "an-note an-note--warning");
          n.setAttribute("role", "status");
          n.append(icon("info"), el("span", "", note));
          root.append(n);
        }
        cleanups.push(() => {
          ro.disconnect();
          cancelAnimationFrame(raf);
          previewRedraw = null;
        });
      }

      const refreshers: (() => void)[] = [];
      const update = () => {
        if (mode === "new") previewRedraw?.();
        else {
          commit();
          p.setTitle("Edit chart", chartName(spec));
        }
        if (spec.type === "combo") fillCombo();
      };

      // --- chart type
      const typeSec = section("Chart type");
      const tiles = el("div", "an-tiles");
      tiles.setAttribute("role", "radiogroup");
      tiles.setAttribute("aria-label", "Chart type");
      const available = spec.pivot ? PIVOT_CHART_TYPES : MAIN_TYPES;
      const tileButtons = new Map<ChartType, HTMLButtonElement>();
      for (const t of available) {
        const b = el("button", "an-tile");
        b.type = "button";
        b.setAttribute("role", "radio");
        b.innerHTML = glyph(t);
        b.append(el("span", "", SHORT[t] ?? typeLabel(t)));
        b.addEventListener("click", () => setType(t));
        tileButtons.set(t, b);
        tiles.append(b);
      }
      // arrow keys move between the tiles (one tab stop)
      tiles.addEventListener("keydown", (e) => {
        if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)) return;
        e.preventDefault();
        const list = [...tileButtons.keys()];
        const i = Math.max(0, list.indexOf(spec.type));
        const next = list[(i + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length];
        setType(next);
        tileButtons.get(next)?.focus();
      });
      typeSec.append(tiles);
      let analystSel: HTMLSelectElement | null = null;
      if (!spec.pivot) {
        analystSel = el("select");
        analystSel.setAttribute("aria-label", "Audit and analysis charts");
        analystSel.append(new Option("Audit and analysis charts…", ""));
        for (const t of ANALYST_TYPES) analystSel.append(new Option(typeLabel(t), t));
        analystSel.addEventListener("change", () => {
          if (analystSel!.value) setType(analystSel!.value as ChartType);
        });
        typeSec.append(analystSel);
      }
      root.append(typeSec);

      // --- title
      const titleSec = section("Title");
      const titleInput = textInput(() => spec.title, (v) => ((spec.title = v), true), "A title for the chart", update);
      titleInput.setAttribute("aria-label", "Chart title");
      titleSec.append(titleInput);
      root.append(titleSec);

      // --- data
      const dataSec = section("Data");
      root.append(dataSec);
      if (spec.pivot)
        dataSec.append(
          ...pivotFields(deps, spec, update, (t) => {
            spec.title = t;
            titleInput.value = t;
          }),
        );
      else dataSec.append(...rangeFields(deps, spec, update, () => syncType(), refreshers));

      // --- more options
      const more = el("details", "an-more");
      more.append(el("summary", "", "Axes, number format and layout"));
      const opts = el("div", "an-stack");
      more.append(opts);
      root.append(more);
      const { syncLayoutText, comboBox } = advancedFields(opts, spec, update, refreshers);
      function fillCombo() {
        const d = data ?? build(deps, spec).data;
        fillComboRows(comboBox, spec, d, update);
      }

      function syncType() {
        for (const [t, b] of tileButtons) {
          b.setAttribute("aria-checked", String(t === spec.type));
          b.tabIndex = t === spec.type || (!tileButtons.has(spec.type) && t === available[0]) ? 0 : -1;
        }
        if (analystSel) analystSel.value = ANALYST_TYPES.includes(spec.type) ? spec.type : "";
        for (const node of root.querySelectorAll<HTMLElement>("[data-types]")) node.hidden = !node.dataset.types!.split(" ").includes(spec.type);
        syncLayoutText();
        if (spec.type === "combo") more.open = true;
      }
      function setType(t: ChartType) {
        spec.type = t;
        syncType();
        update();
      }
      syncType();

      // --- footer
      const foot = el("div", "an-footer");
      if (mode === "new") {
        const cancel = makeButton("Cancel", "secondary");
        cancel.addEventListener("click", () => closeSidePanel());
        const insert = makeButton("Insert chart", "primary");
        insert.addEventListener("click", () => {
          const id = spec.id;
          const made = structuredClone(spec);
          closeSidePanel();
          deps.onChange?.(id, made);
          // the shell shows it (through openChart with the spec); without a shell, show it here
          if (!windows.has(id)) mountWindow(deps, structuredClone(made));
          windows.get(id)?.el.focus({ preventScroll: true });
          toast({ kind: "success", text: `Added the chart "${chartName(made)}". Drag it by its title; Enter edits it.` });
        });
        foot.append(el("span", "an-spacer"), cancel, insert);
      } else {
        const del = makeButton("Delete chart", "ghost", "trash");
        del.classList.add("btn-danger-ghost");
        del.addEventListener("click", () => removeWithUndo(spec.id));
        const done = makeButton("Done", "primary");
        done.addEventListener("click", () => closeSidePanel());
        foot.append(del, el("span", "an-spacer"), done);
      }
      p.footer.append(foot);
      update();
      if (mode === "new") requestAnimationFrame(() => (tileButtons.get(spec.type) ?? tiles.querySelector<HTMLElement>("button"))?.focus());
      if (mode === "edit") requestAnimationFrame(() => keepClearOfPanel(spec.id));
      return () => {
        for (const c of cleanups.splice(0)) c();
        clearTimeout(commitTimer);
        if (mode === "edit" && windows.has(spec.id)) deps.onChange?.(spec.id, structuredClone(windows.get(spec.id)!.spec));
      };
    },
  });
}

/** Slide a chart left so the side panel doesn't hide it while it's edited. */
function keepClearOfPanel(id: string): void {
  const w = windows.get(id);
  const aside = document.querySelector<HTMLElement>(".cf-sidepanel:not([hidden])");
  if (!w || !aside) return;
  const left = aside.getBoundingClientRect().left;
  const f = w.spec.frame;
  if (f.x + f.w <= left - 8) return;
  f.x = Math.max(8, Math.round(left - f.w - 16));
  w.el.style.left = `${f.x}px`;
  w.deps.onChange?.(id, structuredClone(w.spec));
}

function section(title: string): HTMLElement {
  const s = el("section", "an-section");
  const head = el("div", "an-section__head");
  head.append(el("h3", "an-section__title", title));
  s.append(head);
  return s;
}

function field(label: string, control: HTMLElement, hint?: string, types?: ChartType[]): HTMLLabelElement {
  const l = el("label", "an-field");
  l.append(el("span", "", label), control);
  if (hint) l.append(el("small", "an-hint", hint));
  if (types) l.dataset.types = types.join(" ");
  return l;
}

function textInput(get: () => string, set: (v: string) => boolean, placeholder = "", onOk?: () => void): HTMLInputElement {
  const i = el("input");
  i.value = get();
  i.placeholder = placeholder;
  i.addEventListener("input", () => {
    const ok = set(i.value);
    i.classList.toggle("bad", !ok);
    i.setAttribute("aria-invalid", String(!ok));
    if (ok) onOk?.();
  });
  return i;
}

/** Range charts: the cells, the label column and the value columns. */
function rangeFields(deps: ChartDeps, spec: ChartSpec, update: () => void, retype: () => void, refreshers: (() => void)[]): HTMLElement[] {
  const src = () => deps.source(spec.range.sheetId);
  const rangeRow = el("div", "an-row");
  const rangeIn = textInput(
    () => formatRange(spec.range),
    (v) => {
      const r = parseRange(v);
      if (!r) return false;
      spec.range = { sheetId: deps.activeSheet(), ...r };
      return true;
    },
    "A1:F40",
    () => {
      refreshColumns();
      update();
    },
  );
  const useSel = makeButton("Use selection", "secondary");
  useSel.classList.add("an-fit");
  useSel.title = "Chart the cells selected on the sheet";
  useSel.addEventListener("click", () => {
    spec.range = { sheetId: deps.activeSheet(), ...deps.range() };
    rangeIn.value = formatRange(spec.range);
    const s = src();
    if (s) Object.assign(spec, guessLayout(s, spec.range));
    delete spec.series;
    delete spec.labelCol;
    refreshColumns();
    retype();
    update();
  });
  rangeRow.append(field("Cells", rangeIn), useSel);

  const labelSel = el("select");
  const labelField = field("Labels along the axis", labelSel, undefined, ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "pie"]);
  const values = el("div", "an-field");
  const valuesCaption = el("span", "", "Values");
  valuesCaption.id = `chart-values-${spec.id}`;
  const chips = el("div", "an-chips");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-labelledby", valuesCaption.id);
  values.append(valuesCaption, chips, el("small", "an-hint", "IDs, references and account codes are left out. Click a column to add or remove it."));

  labelSel.addEventListener("change", () => {
    const v = labelSel.value;
    if (v === "") {
      spec.labels = false;
      delete spec.labelCol;
    } else {
      spec.labels = true;
      spec.labelCol = Number(v);
      if (spec.series) spec.series = spec.series.filter((c) => c !== spec.labelCol);
    }
    refreshColumns();
    update();
  });

  function refreshColumns() {
    const s = src();
    const byCol = spec.seriesIn === "columns";
    labelField.style.display = byCol ? "" : "none";
    values.style.display = byCol ? "" : "none";
    if (!s || !byCol) return;
    const r = clampRange(s, spec.range);
    if (r.right - r.left > 60) {
      values.style.display = "none";
      return;
    }
    const cols: ColumnInfo[] = profileColumns(s, r, spec.names, (c) => (s as Named).getColumnName?.(c));
    const nameOf = (c: ColumnInfo) => c.name || `Column ${colLetters(c.col)}`;
    const labelCol = spec.labels ? (spec.labelCol ?? r.left) : null;
    labelSel.replaceChildren(new Option("None (1, 2, 3…)", ""));
    for (const c of cols) labelSel.append(new Option(`${nameOf(c)} (${c.kind === "number" && isIdLike(c) ? "code" : c.kind})`, String(c.col)));
    labelSel.value = labelCol === null ? "" : String(labelCol);
    const plotted = new Set(spec.series ?? cols.filter((c) => c.col !== labelCol).map((c) => c.col));
    chips.replaceChildren();
    for (const c of cols) {
      if (c.col === labelCol) continue;
      const usable = c.kind === "number" || c.kind === "date";
      const on = plotted.has(c.col);
      const b = el("button", "an-chip");
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      if (!on && (!usable || isIdLike(c))) b.classList.add("an-chip--muted");
      if (on) b.append(icon("check", { size: 12 }));
      b.append(el("span", "", nameOf(c)));
      if (isIdLike(c)) b.append(el("small", "", "ID"));
      else if (!usable) b.append(el("small", "", "text"));
      b.title = !usable ? "Text: there are no numbers to plot" : on ? "Plotted. Click to leave it out." : "Click to plot it";
      b.addEventListener("click", () => {
        const now = new Set(spec.series ?? [...plotted]);
        if (now.has(c.col)) now.delete(c.col);
        else now.add(c.col);
        spec.series = cols.map((x) => x.col).filter((x) => now.has(x));
        refreshColumns();
        chips.querySelectorAll<HTMLButtonElement>("button")[[...cols.filter((x) => x.col !== labelCol)].indexOf(c)]?.focus();
        update();
      });
      chips.append(b);
    }
  }
  refreshColumns();
  refreshers.push(refreshColumns);
  return [rangeRow, labelField, values];
}

const AGG_CHOICES: [PivotAgg, string][] = [
  ["sum", "Total"],
  ["count", "Number of rows"],
  ["avg", "Average"],
  ["min", "Smallest"],
  ["max", "Largest"],
];
const GROUPS: [DateGroup, string][] = [
  ["day", "Day"],
  ["month", "Month"],
  ["quarter", "Quarter"],
  ["year", "Year"],
];

/** Pivot charts: "Total of [Amount] by [Vendor]". */
function pivotFields(deps: ChartDeps, spec: ChartSpec, update: () => void, setTitle: (t: string) => void): HTMLElement[] {
  const src = deps.source(spec.pivot!.sheetId);
  let data: SheetColumns | null = null;
  try {
    data = src && isColumnSource(src) ? readSheetColumns(src) : null;
  } catch {
    data = null;
  }
  const hint = el("p", "an-hint", "Worked out from every row of the sheet, so the chart follows the data. For more than one field, use the pivot table.");
  if (!data) return [hint];
  const d = data;
  const saved = spec.pivot!.pivot;
  if (saved.rows.length > 1 || saved.cols.length || saved.values.length > 1) return [el("p", "an-hint", "This chart shows a pivot built in the pivot table. Change the pivot there and chart it again.")];
  const aggSel = el("select");
  for (const [v, t] of AGG_CHOICES) aggSel.append(new Option(t, v));
  aggSel.value = saved.values[0]?.agg ?? "sum";
  const valSel = el("select");
  const bySel = el("select");
  const groupSel = el("select");
  for (const [v, t] of GROUPS) groupSel.append(new Option(t, v));
  d.names.forEach((n, i) => {
    if (d.columns[i].kind === "number" && !d.isDate[i]) valSel.append(new Option(n, String(i)));
    bySel.append(new Option(n, String(i)));
  });
  if (saved.values[0] && aggSel.value !== "count") valSel.value = String(saved.values[0].field);
  bySel.value = String(saved.rows[0]?.field ?? 0);
  groupSel.value = saved.rows[0]?.group ?? "month";
  const groupField = field("Group dates by", groupSel);
  const valField = field("Of", valSel);
  const sync = () => {
    groupField.style.display = d.isDate[Number(bySel.value)] ? "" : "none";
    valField.style.display = aggSel.value === "count" ? "none" : "";
  };
  const apply = () => {
    const by = Number(bySel.value);
    const agg = aggSel.value as PivotAgg;
    const vf = agg === "count" ? by : Number(valSel.value);
    saved.rows = [{ field: by, ...(d.isDate[by] ? { group: groupSel.value as DateGroup } : {}) }];
    saved.values = [{ field: vf, agg }];
    saved.names = d.names;
    const what = agg === "count" ? "Number of rows" : agg === "sum" ? d.names[vf] : `${AGG_CHOICES.find((a) => a[0] === agg)![1]} ${d.names[vf]}`;
    setTitle(`${what} by ${d.isDate[by] ? groupSel.value : d.names[by]}`);
    sync();
    update();
  };
  for (const s of [aggSel, valSel, bySel, groupSel]) s.addEventListener("change", apply);
  sync();
  const row = el("div", "an-row");
  row.append(field("Show", aggSel), valField);
  const row2 = el("div", "an-row");
  row2.append(field("By", bySel), groupField);
  return [row, row2, hint];
}

/** Titles, axes, number format and the special settings of the analyst charts. */
function advancedFields(box: HTMLElement, spec: ChartSpec, update: () => void, refreshers: (() => void)[]): { syncLayoutText: () => void; comboBox: HTMLElement } {
  const limitInput = (key: "yMin" | "yMax" | "xMin" | "xMax" | "asOf", placeholder: string) =>
    textInput(
      () => limitText(spec[key]),
      (v) => {
        const l: Limit | undefined = parseLimit(v, spec.range.sheetId);
        if (l === undefined) return false;
        spec[key] = l;
        return true;
      },
      placeholder,
      update,
    );
  const pair = (a: HTMLElement, b: HTMLElement, types?: ChartType[]) => {
    const d = el("div", "an-row");
    d.append(a, b);
    if (types) d.dataset.types = types.join(" ");
    return d;
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void, types?: ChartType[]) => {
    const l = el("label", "an-check");
    const c = el("input");
    c.type = "checkbox";
    c.checked = get();
    c.addEventListener("change", () => {
      set(c.checked);
      refreshers.forEach((f) => f());
      update();
    });
    const t = el("span", "", label);
    l.append(c, t);
    if (types) l.dataset.types = types.join(" ");
    box.append(l);
    return { label: l, text: t };
  };

  const noPie: ChartType[] = ["column", "bar", "line", "area", "scatter", "combo", "histogram", "waterfall", "pareto", "benford", "ageing"];
  const valueTypes: ChartType[] = ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "histogram", "ageing"];
  box.append(pair(field("Horizontal axis title", textInput(() => spec.xTitle, (v) => ((spec.xTitle = v), true), "", update)), field("Vertical axis title", textInput(() => spec.yTitle, (v) => ((spec.yTitle = v), true), "", update)), noPie));
  box.append(field("Right axis title", textInput(() => spec.y2Title, (v) => ((spec.y2Title = v), true), "", update), undefined, ["combo", "pareto"]));
  box.append(pair(field("Value axis from", limitInput("yMin", "auto")), field("to", limitInput("yMax", "auto")), valueTypes));
  box.append(pair(field("X axis from", limitInput("xMin", "auto")), field("to", limitInput("xMax", "auto")), ["line", "area", "scatter"]));
  box.append(field("Number format", textInput(() => spec.numFmt, (v) => ((spec.numFmt = v.trim()), true), "From the cells, e.g. #,##0", update), "Like #,##0 or 0.0%. Axis limits can be a cell such as F1.", valueTypes.concat("pie")));
  check("Stack the series", () => spec.stacked, (v) => (spec.stacked = v), ["column", "bar", "line", "area"]);

  // histogram
  box.append(
    field(
      "Bin width",
      textInput(
        () => (spec.binWidth === null ? "" : String(spec.binWidth)),
        (v) => {
          const n = Number(v);
          if (v.trim() && !(n > 0)) return false;
          spec.binWidth = v.trim() ? n : null;
          return true;
        },
        "automatic",
        update,
      ),
      undefined,
      ["histogram"],
    ),
  );
  const ruleSel = el("select");
  ruleSel.append(new Option("Freedman–Diaconis (robust to outliers)", "fd"), new Option("Sturges (fewer bins)", "sturges"));
  ruleSel.value = spec.binRule;
  ruleSel.addEventListener("change", () => {
    spec.binRule = ruleSel.value as "fd" | "sturges";
    update();
  });
  box.append(field("Automatic bins by", ruleSel, undefined, ["histogram"]));

  // ageing
  box.append(field("Age at", limitInput("asOf", "today"), "A date serial, or a cell holding the date.", ["ageing"]));
  box.append(
    field(
      "Buckets (days)",
      textInput(
        () => spec.buckets.join(", "),
        (v) => {
          const b = v.split(/[,;\s]+/).filter(Boolean).map(Number);
          if (!b.length || b.some((x) => !(x > 0))) return false;
          spec.buckets = b;
          return true;
        },
        "30, 60, 90, 120",
        update,
      ),
      "First column dates, second column amounts (optional).",
      ["ageing"],
    ),
  );

  // layout of the range (not for pivot charts)
  let syncLayoutText = () => {};
  if (!spec.pivot) {
    const seriesSel = el("select");
    seriesSel.append(new Option("Each column is a series", "columns"), new Option("Each row is a series", "rows"));
    seriesSel.value = spec.seriesIn;
    box.append(field("Series", seriesSel, undefined, ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "pie", "histogram"]));
    const namesBox = check("", () => spec.names, (v) => (spec.names = v));
    const labelsBox = check("", () => spec.labels, (v) => (spec.labels = v), ["column", "bar", "line", "area", "scatter", "combo", "waterfall", "pareto", "pie"]);
    syncLayoutText = () => {
      const cols = spec.seriesIn === "columns";
      namesBox.text.textContent = cols ? "First row has the names" : "First column has the names";
      const x = spec.type === "scatter" ? "x values" : "labels";
      labelsBox.text.textContent = cols ? `First column has the ${x}` : `First row has the ${x}`;
      // series in columns pick their label column under Data
      if (cols) labelsBox.label.hidden = true;
    };
    seriesSel.addEventListener("change", () => {
      spec.seriesIn = seriesSel.value as "columns" | "rows";
      if (spec.seriesIn === "rows") {
        delete spec.series;
        delete spec.labelCol;
      }
      syncLayoutText();
      refreshers.forEach((f) => f());
      update();
    });
  }

  // combo: per-series line / right axis
  const comboBox = el("div", "chart-series");
  comboBox.dataset.types = "combo";
  box.append(comboBox);
  return { syncLayoutText, comboBox };
}

function fillComboRows(box: HTMLElement, spec: ChartSpec, data: ChartData | null, update: () => void): void {
  const names = data?.series.map((s) => s.name) ?? [];
  const key = names.join("\u0000") + "|" + comboLines(spec, names.length).join(",") + "|" + spec.secondary.join(",");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren();
  if (!names.length) return;
  const lines = comboLines(spec, names.length);
  const head = el("div", "chart-series-row chart-series-head");
  head.append(el("span", "", "Series"), el("span", "", "Line"), el("span", "", "Right axis"));
  box.append(head);
  names.forEach((n, i) => {
    const row = el("div", "chart-series-row");
    const line = el("input");
    line.type = "checkbox";
    line.checked = lines.includes(i);
    line.setAttribute("aria-label", `Draw ${n} as a line`);
    line.addEventListener("change", () => {
      const cur = new Set(comboLines(spec, names.length));
      if (line.checked) cur.add(i);
      else cur.delete(i);
      spec.lines = [...cur].sort((a, b) => a - b);
      if (!spec.lines.length) spec.lines = [-1];
      update();
    });
    const right = el("input");
    right.type = "checkbox";
    right.checked = spec.secondary.includes(i);
    right.setAttribute("aria-label", `Put ${n} on the right-hand axis`);
    right.addEventListener("change", () => {
      spec.secondary = right.checked ? [...new Set([...spec.secondary, i])].sort((a, b) => a - b) : spec.secondary.filter((x) => x !== i);
      update();
    });
    const label = el("span", "", n);
    label.title = n;
    row.append(label, line, right);
    box.append(row);
  });
}
