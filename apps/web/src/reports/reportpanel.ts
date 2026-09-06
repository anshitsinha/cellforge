/**
 * The report builder: pick or start a report, set its parameters, add and
 * order blocks (headings, text with {{=formula}}, tables of a range or a
 * pivot, charts, page breaks), preview it, print it, and export a PDF, or a
 * report book with one report per entity and a contents page.
 *
 * Reports are saved with the workbook through "report.set", so every save
 * is one undo step.
 */
import type { Action } from "@cellforge/actions";
import { AGG_LABEL, type PivotAgg } from "@cellforge/core";
import { columnLetter } from "@cellforge/grid";
import { imageFromRgba, type PdfImage } from "@cellforge/core";
import type { ChartSpec, SavedPivot } from "../charts/model";
import { LIGHT_SERIES, renderChart, type ChartTheme } from "../charts/render";
import { readSheetColumns } from "../pivotpanel";
import type { Workbook } from "../workbook";
import { reportsOf } from "./actions";
import { rollForward, runBook, runForValues, runReport, workbookEnv, type RenderedReport } from "./engine";
import { BLOCK_LABEL, newBlock, newReport, type BlockKind, type ParamFilter, type Report, type ReportBlock } from "./model";
import { reportHtml, reportPdf, type ChartBlock } from "./output";
import "./reports.css";
import { confirmDialog } from "../ui/confirm";

export interface ReportDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  run: (a: Action) => Promise<unknown>;
  putBlob?: (value: unknown) => string;
  status: (text: string) => void;
  focusGrid: () => void;
}

/** Colours for charts on paper, whatever the screen theme. */
export const PRINT_THEME: ChartTheme = {
  bg: "#ffffff",
  text: "#1f2328",
  muted: "#656d76",
  grid: "#e3e5e8",
  axis: "#9aa0a6",
  series: LIGHT_SERIES,
  up: LIGHT_SERIES[0],
  down: LIGHT_SERIES[1],
  total: "#6b7078",
  font: "Helvetica, Arial, sans-serif",
};

const chartText = (b: ChartBlock) => ({ title: b.title, xTitle: b.spec.xTitle, yTitle: b.spec.yTitle, y2Title: b.spec.y2Title });

/** Draw a chart block on a canvas of w x h CSS pixels, sharp at `scale`. */
export function drawChartBlock(canvas: HTMLCanvasElement, b: ChartBlock, w: number, h: number, scale = 2): void {
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = PRINT_THEME.bg;
  ctx.fillRect(0, 0, w, h);
  renderChart(ctx, b.data, chartText(b), w, h, PRINT_THEME, scale);
}

/** A chart block as a picture for the PDF (pixels at twice the point size). */
export function paintChart(b: ChartBlock, w: number, h: number): PdfImage | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  drawChartBlock(canvas, b, w, h, 2);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return imageFromRgba(px.data, canvas.width, canvas.height);
}

function download(bytes: Uint8Array, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "report";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", undefined, text);
  b.type = "button";
  if (title) {
    b.title = title;
    b.setAttribute("aria-label", title);
  }
  b.addEventListener("click", onClick);
  return b;
}

function labelled(label: string, input: HTMLElement, cls = "report-field"): HTMLLabelElement {
  const l = el("label", cls);
  l.append(el("span", undefined, label), input);
  return l;
}

function selectOf(options: [string, string][], value: string, label: string): HTMLSelectElement {
  const s = el("select");
  for (const [v, t] of options) s.append(new Option(t, v));
  s.value = value;
  s.setAttribute("aria-label", label);
  return s;
}

/** How many entity reports the preview shows (the PDF has them all). */
const PREVIEW_RUNS = 3;

export function openReports(d: ReportDeps): void {
  const wb = d.workbook();
  const env = workbookEnv(wb);
  const back = el("div", "palette-backdrop");
  const dialog = el("div", "palette import-dialog report-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Reports");
  back.append(dialog);
  const body = el("div", "palette-form report-form");
  dialog.append(body);

  let rep: Report = structuredClone(reportsOf(wb)[0] ?? newReport(d.activeSheet()));
  let saved = reportsOf(wb).some((r) => r.id === rep.id) ? JSON.stringify(rep) : "";
  let saveTimer = 0;
  let previewTimer = 0;

  const save = async () => {
    clearTimeout(saveTimer);
    const now = JSON.stringify(rep);
    if (now === saved) return;
    saved = now;
    try {
      await d.run({ type: "report.set", params: { id: rep.id, report: structuredClone(rep) } });
    } catch (e) {
      d.status(`Report not saved: ${(e as Error).message}`);
    }
  };
  /** Something changed: save soon and refresh the preview. */
  const changed = (rerender = false) => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), 500);
    if (rerender) render();
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(preview, 250);
  };
  const close = () => {
    void save();
    clearTimeout(previewTimer);
    back.remove();
    d.focusGrid();
  };

  // ---- layout
  const head = el("div", "report-head");
  const editor = el("div", "report-editor");
  const previewBox = el("div", "report-preview report-doc");
  previewBox.setAttribute("aria-label", "Preview");
  previewBox.setAttribute("aria-live", "polite");
  const split = el("div", "report-split");
  split.append(editor, previewBox);
  const statusLine = el("p", "report-status");
  statusLine.setAttribute("aria-live", "polite");
  const actions = el("div", "numfmt-actions");
  body.append(el("h3", undefined, "Reports"), head, split, statusLine, actions);

  const sheets = () => wb.sheets.map((s) => [s.id, s.name] as [string, string]);
  const columnsOf = (sheetId: string): [string, string][] => {
    if (!wb.has(sheetId)) return [];
    const src = wb.get(sheetId).source;
    const cols = Math.max(1, src.usedRange().cols);
    const out: [string, string][] = [];
    for (let c = 0; c < cols; c++) {
      const name = src.getColumnName?.(c) || String(src.getCell(0, c) ?? "");
      out.push([String(c), `${columnLetter(c)}${name ? ` · ${name}` : ""}`]);
    }
    return out;
  };

  // ---- the header: which report, title, page
  function renderHead() {
    head.replaceChildren();
    const list = reportsOf(wb);
    const pick = selectOf([...list.map((r) => [r.id, r.title || "Untitled"] as [string, string]), ...(list.some((r) => r.id === rep.id) ? [] : [[rep.id, `${rep.title || "Untitled"} (new)`] as [string, string]]), ["__new", "New report…"]], rep.id, "Report");
    pick.addEventListener("change", () => {
      void save();
      if (pick.value === "__new") {
        rep = newReport(d.activeSheet(), `Report ${list.length + 1}`);
        saved = "";
        changed(true);
      } else {
        const r = reportsOf(wb).find((x) => x.id === pick.value);
        if (r) {
          rep = structuredClone(r);
          saved = JSON.stringify(rep);
          render();
          preview();
        }
      }
    });
    const title = el("input");
    title.value = rep.title;
    title.addEventListener("input", () => {
      rep.title = title.value;
      changed();
    });
    const subtitle = el("input");
    subtitle.value = rep.subtitle ?? "";
    subtitle.placeholder = "e.g. {{entity}}, period ended {{period}}";
    subtitle.addEventListener("input", () => {
      rep.subtitle = subtitle.value || undefined;
      changed();
    });
    const home = selectOf(sheets(), rep.sheetId, "Formulas read");
    home.addEventListener("change", () => {
      rep.sheetId = home.value;
      changed();
    });
    const page = rep.page ?? { size: "A4", landscape: false };
    const size = selectOf(
      [
        ["A4", "A4"],
        ["Letter", "Letter"],
      ],
      page.size,
      "Paper",
    );
    const orient = selectOf(
      [
        ["portrait", "Portrait"],
        ["landscape", "Landscape"],
      ],
      page.landscape ? "landscape" : "portrait",
      "Orientation",
    );
    const setPage = () => {
      rep.page = { size: size.value as "A4" | "Letter", landscape: orient.value === "landscape" };
      changed();
    };
    size.addEventListener("change", setPage);
    orient.addEventListener("change", setPage);
    const del = button("Delete report", async () => {
      if (!(await confirmDialog({ title: `Delete the report "${rep.title}"?`, text: "Undo brings it back.", confirm: "Delete report", danger: true }))) return;
      clearTimeout(saveTimer);
      const id = rep.id;
      void d.run({ type: "report.set", params: { id, report: null } }).then(() => {
        rep = structuredClone(reportsOf(wb)[0] ?? newReport(d.activeSheet()));
        saved = reportsOf(wb).some((r) => r.id === rep.id) ? JSON.stringify(rep) : "";
        render();
        preview();
      });
    });
    head.append(labelled("Report", pick), labelled("Title", title), labelled("Subtitle", subtitle), labelled("Formulas read", home), labelled("Paper", size), labelled("Orientation", orient), del);
  }

  // ---- parameters and "run for each"
  function renderParams(): HTMLElement {
    const box = el("section", "report-params");
    box.append(el("h4", undefined, "Parameters"));
    box.append(el("p", "hp-muted", "Use {{name}} in text and {name} inside a formula, e.g. {{=SUMIFS(C:C,A:A,{entity})}}. A date like 2026-03-31 goes into formulas as a date."));
    rep.params.forEach((p, i) => {
      const row = el("div", "report-param");
      const name = el("input");
      name.value = p.name;
      name.setAttribute("aria-label", "Parameter name");
      name.addEventListener("change", () => {
        const old = p.name;
        p.name = name.value.trim();
        if (rep.runFor?.param === old) rep.runFor.param = p.name;
        changed(true);
      });
      const value = el("input");
      value.value = p.value;
      value.setAttribute("aria-label", `Value of ${p.name}`);
      value.addEventListener("input", () => {
        p.value = value.value;
        changed();
      });
      row.append(name, el("span", undefined, "="), value, button("✕", () => {
        rep.params.splice(i, 1);
        if (rep.runFor?.param === p.name) delete rep.runFor;
        changed(true);
      }, `Remove parameter ${p.name}`));
      box.append(row);
    });
    const add = el("div", "report-row");
    add.append(
      button("Add parameter", () => {
        const taken = new Set(rep.params.map((p) => p.name.toLowerCase()));
        const name = ["entity", "period", "param"].find((n) => !taken.has(n)) ?? `param${rep.params.length + 1}`;
        rep.params.push({ name, value: name === "period" ? new Date().toISOString().slice(0, 7) : "" });
        changed(true);
      }),
      button("Roll back a period", () => roll(-1), "Move period parameters back one period"),
      button("Roll forward a period", () => roll(1), "Move period parameters on one period (2026-03 → 2026-04, Q1 2026 → Q2 2026)"),
    );
    box.append(add);

    // run for each
    const rf = rep.runFor;
    const each = el("div", "report-runfor");
    const param = selectOf([["", "Just once"], ...rep.params.map((p) => [p.name, `Once for each ${p.name}`] as [string, string])], rf?.param ?? "", "Run for each");
    param.addEventListener("change", () => {
      if (!param.value) delete rep.runFor;
      else rep.runFor = { ...(rep.runFor ?? { sheetId: rep.sheetId, column: 0 }), param: param.value };
      changed(true);
    });
    each.append(labelled("Run", param));
    if (rf) {
      const fromList = !!rf.list;
      const how = selectOf(
        [
          ["column", "Values in a column"],
          ["list", "A list I type"],
        ],
        fromList ? "list" : "column",
        "Values from",
      );
      how.addEventListener("change", () => {
        if (how.value === "list") {
          rep.runFor = { param: rf.param, list: [], ...(rf.consolidated ? { consolidated: true } : {}) };
        } else rep.runFor = { param: rf.param, sheetId: rep.sheetId, column: 0, ...(rf.consolidated ? { consolidated: true } : {}) };
        changed(true);
      });
      each.append(labelled("Values from", how));
      if (fromList) {
        const list = el("input");
        list.value = (rf.list ?? []).join(", ");
        list.placeholder = "North, South, East";
        list.addEventListener("input", () => {
          rf.list = list.value.split(",").map((x) => x.trim()).filter(Boolean);
          changed();
        });
        each.append(labelled("Values", list));
      } else {
        const sheet = selectOf(sheets(), rf.sheetId ?? rep.sheetId, "Sheet");
        sheet.addEventListener("change", () => {
          rf.sheetId = sheet.value;
          rf.column = 0;
          changed(true);
        });
        const col = selectOf(columnsOf(rf.sheetId ?? rep.sheetId), String(rf.column ?? 0), "Column");
        col.addEventListener("change", () => {
          rf.column = Number(col.value);
          changed();
        });
        each.append(labelled("Sheet", sheet), labelled("Column", col));
      }
      const cons = el("input");
      cons.type = "checkbox";
      cons.checked = !!rf.consolidated;
      cons.addEventListener("change", () => {
        rf.consolidated = cons.checked;
        changed();
      });
      const cl = el("label", "report-check");
      cl.append(cons, "Also a consolidated report (all of them; filters off, {" + rf.param + '} = "*")');
      each.append(cl);
      const n = runForValues(rep, env).length;
      each.append(el("small", "hp-muted", `${n.toLocaleString("en-US")} value${n === 1 ? "" : "s"}${rf.consolidated ? " plus the consolidated report" : ""}.`));
    }
    box.append(each);
    return box;
  }

  function roll(steps: number) {
    const { report, changed: names } = rollForward(rep, steps);
    if (!names.length) {
      statusLine.textContent = "No parameter looks like a period (2026-03-31, 2026-03, Mar 2026, Q1 2026, FY2026, 2026).";
      return;
    }
    rep = report;
    statusLine.textContent = `${names.join(", ")} → ${names.map((n) => rep.params.find((p) => p.name === n)!.value).join(", ")}`;
    changed(true);
  }

  // ---- blocks
  function filterEditor(b: { filter?: ParamFilter; sheetId?: string }, sheetId: string): HTMLElement {
    const wrap = el("div", "report-row");
    const param = selectOf([["", "All rows"], ...rep.params.map((p) => [p.name, `Only this ${p.name}`] as [string, string])], b.filter?.param ?? "", "Filter");
    const col = selectOf(columnsOf(sheetId), String(b.filter?.column ?? 0), "in column");
    col.hidden = !b.filter;
    param.addEventListener("change", () => {
      if (!param.value) delete b.filter;
      else b.filter = { param: param.value, column: Number(col.value) || 0 };
      col.hidden = !b.filter;
      changed();
    });
    col.addEventListener("change", () => {
      if (b.filter) b.filter.column = Number(col.value);
      changed();
    });
    wrap.append(labelled("Rows", param), labelled("In column", col));
    return wrap;
  }

  function pivotEditor(b: Extract<ReportBlock, { source: "pivot" }>): HTMLElement {
    const wrap = el("div", "report-row");
    const cols = columnsOf(b.sheetId);
    const p = b.pivot;
    const rowsSel = selectOf(cols, String(p.rows[0]?.field ?? 0), "Rows");
    const colsSel = selectOf([["", "(none)"], ...cols], p.cols[0] ? String(p.cols[0].field) : "", "Columns");
    const valSel = selectOf(cols, String(p.values[0]?.field ?? 0), "Values");
    const aggSel = selectOf(Object.entries(AGG_LABEL) as [string, string][], p.values[0]?.agg ?? "sum", "Summarise by");
    const set = () => {
      const names = wb.has(b.sheetId) ? readSheetColumns(wb.get(b.sheetId).source).names : undefined;
      b.pivot = {
        rows: [{ field: Number(rowsSel.value) }],
        cols: colsSel.value ? [{ field: Number(colsSel.value) }] : [],
        values: [{ field: Number(valSel.value), agg: aggSel.value as PivotAgg }],
        filters: p.filters,
        subtotals: true,
        grandTotals: true,
        ...(names ? { names } : {}),
      };
      changed();
    };
    for (const s of [rowsSel, colsSel, valSel, aggSel]) s.addEventListener("change", set);
    wrap.append(labelled("Rows", rowsSel), labelled("Columns", colsSel), labelled("Values", valSel), labelled("As", aggSel));
    return wrap;
  }

  const defaultPivot = (sheetId: string): SavedPivot => {
    const names = wb.has(sheetId) ? readSheetColumns(wb.get(sheetId).source).names : [];
    const data = wb.has(sheetId) ? readSheetColumns(wb.get(sheetId).source) : null;
    const num = data ? data.columns.findIndex((c, i) => c.kind === "number" && !data.isDate[i]) : -1;
    const txt = data ? data.columns.findIndex((c) => c.kind === "string") : -1;
    return { rows: [{ field: Math.max(0, txt) }], cols: [], values: [{ field: Math.max(0, num), agg: num >= 0 ? "sum" : "count" }], filters: [], subtotals: true, grandTotals: true, names };
  };

  function blockEditor(b: ReportBlock, i: number): HTMLElement {
    const card = el("section", "report-block");
    card.dataset.kind = b.kind;
    const top = el("div", "report-block-head");
    top.append(el("b", undefined, BLOCK_LABEL[b.kind]));
    const move = (to: number) => {
      const [x] = rep.blocks.splice(i, 1);
      rep.blocks.splice(to, 0, x);
      changed(true);
      editor.querySelectorAll<HTMLElement>(".report-block")[to]?.querySelector<HTMLElement>("button")?.focus();
    };
    if (i > 0) top.append(button("↑", () => move(i - 1), `Move ${BLOCK_LABEL[b.kind]} up`));
    if (i < rep.blocks.length - 1) top.append(button("↓", () => move(i + 1), `Move ${BLOCK_LABEL[b.kind]} down`));
    top.append(
      button("✕", () => {
        rep.blocks.splice(i, 1);
        changed(true);
      }, `Remove ${BLOCK_LABEL[b.kind]}`),
    );
    card.append(top);
    switch (b.kind) {
      case "heading": {
        const t = el("input");
        t.value = b.text;
        t.setAttribute("aria-label", "Heading text");
        t.addEventListener("input", () => {
          b.text = t.value;
          changed();
        });
        const lvl = selectOf(
          [
            ["1", "Level 1"],
            ["2", "Level 2"],
            ["3", "Level 3"],
          ],
          String(b.level),
          "Heading level",
        );
        lvl.addEventListener("change", () => {
          b.level = Number(lvl.value) as 1 | 2 | 3;
          changed();
        });
        const row = el("div", "report-row");
        row.append(t, lvl);
        card.append(row);
        break;
      }
      case "paragraph": {
        const t = el("textarea");
        t.value = b.text;
        t.rows = 3;
        t.placeholder = 'Revenue rose {{=TEXT(B5/B4-1,"0%")}} on last year.';
        t.setAttribute("aria-label", "Text");
        t.addEventListener("input", () => {
          b.text = t.value;
          changed();
        });
        card.append(t);
        break;
      }
      case "table": {
        const row = el("div", "report-row");
        const source = selectOf(
          [
            ["range", "A range of cells"],
            ["pivot", "A pivot"],
          ],
          b.source,
          "Table of",
        );
        source.addEventListener("change", () => {
          const base = { id: b.id, kind: "table" as const, sheetId: b.sheetId, ...(b.title ? { title: b.title } : {}), ...(b.filter ? { filter: b.filter } : {}) };
          rep.blocks[i] = source.value === "pivot" ? { ...base, source: "pivot", pivot: defaultPivot(b.sheetId) } : { ...base, source: "range", range: "A1:D10", headerRow: true };
          changed(true);
        });
        const sheet = selectOf(sheets(), b.sheetId, "Sheet");
        sheet.addEventListener("change", () => {
          b.sheetId = sheet.value;
          if (b.source === "pivot") b.pivot = defaultPivot(b.sheetId);
          changed(true);
        });
        const title = el("input");
        title.value = b.title ?? "";
        title.placeholder = "Caption (optional)";
        title.setAttribute("aria-label", "Table caption");
        title.addEventListener("input", () => {
          b.title = title.value || undefined;
          changed();
        });
        row.append(labelled("Table of", source), labelled("Sheet", sheet), labelled("Caption", title));
        card.append(row);
        if (b.source === "range") {
          const r = el("div", "report-row");
          const range = el("input");
          range.value = b.range;
          range.placeholder = "A1:D20 or A:D";
          range.setAttribute("aria-label", "Range");
          range.addEventListener("input", () => {
            b.range = range.value.trim();
            changed();
          });
          const hdr = el("input");
          hdr.type = "checkbox";
          hdr.checked = b.headerRow;
          hdr.addEventListener("change", () => {
            b.headerRow = hdr.checked;
            changed();
          });
          const hl = el("label", "report-check");
          hl.append(hdr, "First row is the header");
          r.append(labelled("Range", range), hl);
          card.append(r);
        } else card.append(pivotEditor(b));
        card.append(filterEditor(b, b.sheetId));
        break;
      }
      case "chart": {
        const charts = wb.charts;
        const label = (c: ChartSpec) => `${c.title || (c.pivot ? "Pivot chart" : `${c.type} chart`)} (${wb.has(c.range.sheetId) ? wb.get(c.range.sheetId).name : "?"})`;
        const pick = selectOf([["", charts.length ? "Pick a chart…" : "No charts yet: insert one first"], ...charts.map((c) => [c.id, label(c)] as [string, string])], b.chartId ?? "", "Chart");
        pick.addEventListener("change", () => {
          b.chartId = pick.value || undefined;
          changed();
        });
        const title = el("input");
        title.value = b.title ?? "";
        title.placeholder = "Title (default: the chart's)";
        title.setAttribute("aria-label", "Chart title");
        title.addEventListener("input", () => {
          b.title = title.value || undefined;
          changed();
        });
        const row = el("div", "report-row");
        row.append(labelled("Chart", pick), labelled("Title", title));
        card.append(row);
        const spec = charts.find((c) => c.id === b.chartId);
        if (spec) card.append(filterEditor(b, spec.pivot?.sheetId ?? spec.range.sheetId));
        break;
      }
      case "pageBreak":
        card.append(el("small", "hp-muted", "What follows starts on a new page."));
        break;
    }
    return card;
  }

  function render() {
    renderHead();
    const scroll = editor.scrollTop;
    editor.replaceChildren(renderParams());
    const blocks = el("div", "report-blocks");
    blocks.append(el("h4", undefined, "Blocks"));
    rep.blocks.forEach((b, i) => blocks.append(blockEditor(b, i)));
    if (!rep.blocks.length) blocks.append(el("p", "hp-muted", "Add headings, text, tables and charts. They print in this order."));
    const add = el("div", "report-row report-add");
    for (const kind of ["heading", "paragraph", "table", "chart", "pageBreak"] as BlockKind[]) {
      add.append(
        button(`+ ${BLOCK_LABEL[kind]}`, () => {
          rep.blocks.push(newBlock(kind, rep.sheetId));
          changed(true);
          editor.scrollTop = editor.scrollHeight;
        }),
      );
    }
    blocks.append(add);
    editor.append(blocks);
    editor.scrollTop = scroll;
    renderActions();
  }

  // ---- running
  let lastRuns: RenderedReport[] = [];
  const runs = (): RenderedReport[] => (rep.runFor ? runBook(rep, env) : [runReport(rep, env)]);

  function preview() {
    clearTimeout(previewTimer);
    let all: RenderedReport[];
    try {
      all = runs();
    } catch (e) {
      previewBox.replaceChildren(el("p", "report-error", (e as Error).message));
      return;
    }
    lastRuns = all;
    const shown = all.slice(0, PREVIEW_RUNS);
    previewBox.innerHTML = reportHtml(shown);
    if (all.length > shown.length) previewBox.append(el("p", "hp-muted", `Showing ${shown.length} of ${all.length} reports. The PDF has them all.`));
    drawCharts(previewBox, shown);
    const warn = all.reduce((n, r) => n + r.warnings.length, 0);
    statusLine.textContent = `${all.length} report${all.length === 1 ? "" : "s"}${warn ? `, ${warn} thing${warn === 1 ? "" : "s"} to check` : ""}.`;
  }

  function drawCharts(root: HTMLElement, reports: RenderedReport[]) {
    for (const fig of root.querySelectorAll<HTMLElement>("figure.report-chart")) {
      const [ri, bi] = (fig.dataset.chart ?? "").split(":").map(Number);
      const b = reports[ri]?.blocks[bi];
      if (!b || b.kind !== "chart" || !("data" in b)) continue;
      const canvas = el("canvas");
      fig.append(canvas);
      drawChartBlock(canvas, b, 480, 270, 2);
    }
  }

  async function exportPdf() {
    await save();
    let all: RenderedReport[];
    try {
      all = runs();
    } catch (e) {
      statusLine.textContent = (e as Error).message;
      return;
    }
    statusLine.textContent = `Writing ${all.length} report${all.length === 1 ? "" : "s"}…`;
    const page = rep.page ?? { size: "A4", landscape: false };
    try {
      const bytes = await reportPdf(all, { title: rep.title, size: page.size, landscape: page.landscape, footer: rep.title }, paintChart);
      const name = `${safeName(all.length === 1 ? all[0].title : rep.title)}.pdf`;
      download(bytes, name);
      const pages = (new TextDecoder("latin1").decode(bytes).match(/\/Type \/Page\b/g) ?? []).length;
      statusLine.textContent = `Saved ${name}: ${all.length} report${all.length === 1 ? "" : "s"}, ${pages} page${pages === 1 ? "" : "s"}.`;
      d.status(`Report PDF saved: ${name}`);
    } catch (e) {
      statusLine.textContent = `Couldn't write the PDF: ${(e as Error).message}`;
    }
  }

  function print() {
    preview();
    const host = el("div", "report-print report-doc");
    host.innerHTML = reportHtml(lastRuns);
    drawCharts(host, lastRuns);
    document.body.append(host);
    document.body.classList.add("report-printing");
    const done = () => {
      document.body.classList.remove("report-printing");
      host.remove();
      removeEventListener("afterprint", done);
    };
    addEventListener("afterprint", done);
    window.print();
    // browsers that print without blocking fire afterprint; the rest return here
    setTimeout(done, 1000);
  }

  function renderActions() {
    actions.replaceChildren(
      button("Close", close),
      button("Print", print, "Print the preview (the browser's print dialog can save a PDF too)"),
      button(rep.runFor ? `Export PDF book (each ${rep.runFor.param})` : "Export PDF", () => void exportPdf()),
    );
  }

  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });

  render();
  preview();
  document.body.append(back);
  (head.querySelector("input") as HTMLElement | null)?.focus();
}
