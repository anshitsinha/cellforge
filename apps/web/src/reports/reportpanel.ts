/**
 * The report builder: start from a pack laid out for the sheet, add and
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
import { BLOCK_LABEL, newBlock, type BlockKind, type ParamFilter, type Report, type ReportBlock } from "./model";
import { fitPage, reportHtml, reportPdf, type ChartBlock } from "./output";
import "./reports.css";
import "./reportui.css";
import { confirmDialog } from "../ui/confirm";
import { makeButton, openDialog } from "../ui/dialog";
import { icon, iconButton } from "../ui/icons";
import { toast } from "../ui/toast";
import "../analysis.css";
import { sheetFacts, starterReport, STARTERS, type SheetFacts, type StarterKind } from "./starters";
import { hasFields, textParts } from "./fields";

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

function field(label: string, input: HTMLElement): HTMLLabelElement {
  const l = el("label", "an-field");
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

const BLOCK_ICON: Record<BlockKind, string> = {
  heading: "document",
  paragraph: "document",
  table: "table",
  chart: "chart",
  pageBreak: "chevron-down",
};
const BLOCK_HINT: Record<BlockKind, string> = {
  heading: "A title for a section",
  paragraph: "Words, with live figures from the sheet",
  table: "Cells of a sheet, or a summary (pivot)",
  chart: "A chart from this workbook",
  pageBreak: "Start a new page",
};

/** A tiny page sketch for a starter card. */
function starterThumb(kind: StarterKind): HTMLElement {
  const t = el("span", `report-thumb report-thumb--${kind}`);
  t.setAttribute("aria-hidden", "true");
  for (const part of kind === "blank" ? ["h"] : kind === "entity" ? ["h", "l", "l", "b", "t"] : kind === "close" ? ["h", "l", "b", "t", "l"] : ["h", "l", "t", "b"]) t.append(el("i", `report-thumb__${part}`));
  return t;
}

/**
 * Reports: start from a pack laid out for the sheet (or a blank page) with a
 * live preview, then edit the contents and print or export a PDF. Reports
 * save with the workbook ("report.set", one undo step per change). The
 * {{…}} templating and run-for-each live under "Parameters and paper".
 */
export function openReports(d: ReportDeps): void {
  const wb = d.workbook();
  const env = workbookEnv(wb);
  let rep: Report | null = reportsOf(wb)[0] ? structuredClone(reportsOf(wb)[0]) : null;
  let saved = rep ? JSON.stringify(rep) : "";
  let saveTimer = 0;
  let previewTimer = 0;
  // text blocks showing their {{…}} source instead of chips
  const sourceOpen = new Set<string>();
  let mode: "start" | "edit" = rep ? "edit" : "start";
  let starter: StarterKind = "summary";

  const editor = el("div", "report-editor");
  const previewWrap = el("div", "report-preview-wrap");
  const previewNote = el("div", "an-note an-note--warning report-preview-note");
  previewNote.hidden = true;
  const previewBox = el("div", "report-preview report-doc");
  previewBox.setAttribute("aria-label", "Preview");
  previewBox.tabIndex = 0;
  previewWrap.append(previewNote, previewBox);
  const split = el("div", "report-split");
  split.append(editor, previewWrap);

  const dlg = openDialog({
    title: "Reports",
    subtitle: "Board packs, close packs and one-report-per-entity books, as PDF",
    size: "xl",
    className: "report-dlg",
    body: split,
    actions: [],
    onClose: () => {
      if (mode === "edit") void save();
      clearTimeout(previewTimer);
      d.focusGrid();
    },
  });
  const footer = dlg.footer;
  footer.hidden = false;

  const facts = (): SheetFacts => {
    const id = wb.has(d.activeSheet()) ? d.activeSheet() : wb.sheets[0]?.id;
    if (!id) return sheetFacts("", "Sheet", null);
    const sheet = wb.get(id);
    let data = null;
    try {
      data = readSheetColumns(sheet.source);
    } catch {
      data = null;
    }
    // text that may name the period ("October 2026"): sheet names and the top of every sheet
    const texts: string[] = [];
    for (const s of wb.sheets) {
      texts.push(s.name);
      for (let r = 0; r < 12; r++)
        for (let c = 0; c < 6; c++) {
          const v = s.source.getCell(r, c);
          if (typeof v === "string" && v.length < 200) texts.push(v);
        }
    }
    return sheetFacts(id, sheet.name, data, { texts });
  };
  const sheetInfo = facts();

  const save = async () => {
    clearTimeout(saveTimer);
    if (!rep) return;
    const now = JSON.stringify(rep);
    if (now === saved) return;
    saved = now;
    try {
      await d.run({ type: "report.set", params: { id: rep.id, report: structuredClone(rep) } });
    } catch (e) {
      toast({ kind: "error", title: "The report wasn't saved", text: (e as Error).message });
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

  const sheets = () => wb.sheets.map((s) => [s.id, s.name] as [string, string]);
  const columnsOf = (sheetId: string): [string, string][] => {
    if (!wb.has(sheetId)) return [];
    const src = wb.get(sheetId).source;
    const cols = Math.max(1, src.usedRange().cols);
    const out: [string, string][] = [];
    for (let c = 0; c < cols; c++) {
      const name = src.getColumnName?.(c) || String(src.getCell(0, c) ?? "");
      out.push([String(c), name ? `${name} (${columnLetter(c)})` : `Column ${columnLetter(c)}`]);
    }
    return out;
  };

  // ---------------------------------------------------------- start view --

  function renderStart() {
    editor.replaceChildren();
    const intro = el("div", "report-start-intro");
    intro.append(el("h3", "report-start-title", "Start a report"), el("p", "an-hint", `Laid out for ${sheetInfo.sheetName}${sheetInfo.amount !== null ? `: ${sheetInfo.names[sheetInfo.amount]}` : ""}${sheetInfo.category !== null ? ` by ${sheetInfo.names[sheetInfo.category]}` : ""}. Everything can be changed afterwards.`));
    const list = el("div", "report-starters");
    list.setAttribute("role", "radiogroup");
    list.setAttribute("aria-label", "Start from");
    const cards: HTMLButtonElement[] = [];
    for (const s of STARTERS) {
      const b = el("button", "report-starter");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(s.kind === starter));
      b.tabIndex = s.kind === starter ? 0 : -1;
      const txt = el("span", "report-starter__text");
      txt.append(el("span", "report-starter__title", s.title), el("span", "report-starter__desc", s.text));
      b.append(starterThumb(s.kind), txt);
      b.addEventListener("click", () => pickStarter(s.kind));
      b.addEventListener("dblclick", () => create());
      cards.push(b);
      list.append(b);
    }
    list.addEventListener("keydown", (e) => {
      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(e.key)) return;
      e.preventDefault();
      const i = STARTERS.findIndex((s) => s.kind === starter);
      const next = (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : STARTERS.length - 1)) % STARTERS.length;
      pickStarter(STARTERS[next].kind);
      cards[next].focus();
    });
    editor.append(intro, list);
    const existing = reportsOf(wb);
    if (existing.length) {
      const sec = el("section", "an-section");
      const head = el("div", "an-section__head");
      head.append(el("h3", "an-section__title", "Or open a saved report"));
      const ul = el("ul", "an-list");
      for (const r of existing) {
        const li = el("li");
        const b = el("button", "report-open");
        b.type = "button";
        b.append(icon("report", { size: 14 }), el("span", undefined, r.title || "Untitled"));
        b.addEventListener("click", () => openReport(r));
        li.append(b, el("span", "an-list__sub", `${r.blocks.length} block${r.blocks.length === 1 ? "" : "s"}`));
        ul.append(li);
      }
      sec.append(head, ul);
      editor.append(sec);
    }
    footer.replaceChildren();
    const start = el("div", "cf-dialog__footer-start");
    footer.append(start);
    if (existing.length) {
      const back = makeButton("Back to the report", "ghost", "arrow-left");
      back.addEventListener("click", () => openReport(existing[0]));
      start.append(back);
    }
    const cancel = makeButton("Cancel", "secondary");
    cancel.addEventListener("click", () => dlg.close("dismiss"));
    const go = makeButton("Create report", "primary");
    go.addEventListener("click", create);
    footer.append(cancel, go);
    requestAnimationFrame(() => cards.find((c) => c.tabIndex === 0)?.focus());
    preview();

    function pickStarter(k: StarterKind) {
      starter = k;
      cards.forEach((c, i) => {
        const on = STARTERS[i].kind === k;
        c.setAttribute("aria-checked", String(on));
        c.tabIndex = on ? 0 : -1;
      });
      preview();
    }
  }

  function create() {
    rep = starterReport(starter, sheetInfo);
    saved = "";
    mode = "edit";
    void save();
    render();
    preview();
    toast({ kind: "success", text: `Created "${rep.title}". It's saved with the workbook.` });
    requestAnimationFrame(() => editor.querySelector<HTMLInputElement>(".report-title-input")?.focus());
  }

  function openReport(r: Report) {
    void save();
    rep = structuredClone(r);
    saved = JSON.stringify(rep);
    mode = "edit";
    render();
    preview();
  }

  // ----------------------------------------------------------- edit view --

  function renderTop(r: Report): HTMLElement {
    const top = el("div", "an-stack");
    const list = reportsOf(wb);
    const pickRow = el("div", "an-row");
    const options: [string, string][] = list.map((x) => [x.id, x.title || "Untitled"]);
    if (!list.some((x) => x.id === r.id)) options.push([r.id, r.title || "Untitled"]);
    const pick = selectOf(options, r.id, "Report");
    pick.addEventListener("change", () => {
      const x = reportsOf(wb).find((y) => y.id === pick.value);
      if (x) openReport(x);
    });
    const add = makeButton("New", "secondary", "plus");
    add.classList.add("an-fit");
    add.title = "Start another report";
    add.addEventListener("click", () => {
      void save();
      mode = "start";
      render();
    });
    pickRow.append(field("Report", pick), add);
    const title = el("input", "report-title-input");
    title.value = r.title;
    title.addEventListener("input", () => {
      r.title = title.value;
      changed();
      pick.selectedOptions[0] && (pick.selectedOptions[0].textContent = r.title || "Untitled");
    });
    const subtitle = el("input");
    subtitle.value = r.subtitle ?? "";
    subtitle.placeholder = "e.g. Period ended 31 October 2026";
    subtitle.addEventListener("input", () => {
      r.subtitle = subtitle.value || undefined;
      changed();
    });
    top.append(pickRow, field("Title", title), field("Subtitle", subtitle));
    return top;
  }

  function renderAdvanced(r: Report): HTMLElement {
    const box = el("details", "an-more");
    box.append(el("summary", undefined, "Parameters, paper and run for each"));
    const inner = el("div", "an-stack");
    box.append(inner);
    if (r.params.length || r.runFor) box.open = true;

    const page = r.page ?? { size: "A4", landscape: false };
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
      r.page = { size: size.value as "A4" | "Letter", landscape: orient.value === "landscape" };
      changed();
    };
    size.addEventListener("change", setPage);
    orient.addEventListener("change", setPage);
    const home = selectOf(sheets(), r.sheetId, "Formulas read");
    home.addEventListener("change", () => {
      r.sheetId = home.value;
      changed();
    });
    const paper = el("div", "an-row");
    paper.append(field("Paper", size), field("Orientation", orient));
    inner.append(paper, field("Formulas read the sheet", home));

    // parameters
    const params = el("div", "an-section");
    const ph = el("div", "an-section__head");
    ph.append(el("h3", "an-section__title", "Parameters"));
    params.append(ph);
    const help = el("p", "an-hint report-syntax");
    help.append("Write ", el("code", undefined, "{{period}}"), " in any text to show a parameter, and ", el("code", undefined, "{{=SUM(F:F)}}"), " for a live figure. Inside a formula a parameter is ", el("code", undefined, "{period}"), ", e.g. ", el("code", undefined, "{{=SUMIFS(F:F,C:C,{entity})}}"), ".");
    params.append(help);
    r.params.forEach((p, i) => {
      const row = el("div", "report-param");
      const name = el("input");
      name.value = p.name;
      name.setAttribute("aria-label", "Parameter name");
      name.addEventListener("change", () => {
        const old = p.name;
        p.name = name.value.trim();
        if (r.runFor?.param === old) r.runFor.param = p.name;
        changed(true);
      });
      const value = el("input");
      value.value = p.value;
      value.setAttribute("aria-label", `Value of ${p.name}`);
      value.addEventListener("input", () => {
        p.value = value.value;
        changed();
      });
      row.append(
        name,
        el("span", "report-eq", "="),
        value,
        iconButton("close", `Remove parameter ${p.name}`, {
          size: "sm",
          onClick: () => {
            r.params.splice(i, 1);
            if (r.runFor?.param === p.name) delete r.runFor;
            changed(true);
          },
        }),
      );
      params.append(row);
    });
    const addRow = el("div", "report-row");
    const addParam = makeButton("Add parameter", "secondary", "plus");
    addParam.classList.add("btn-sm");
    addParam.addEventListener("click", () => {
      const taken = new Set(r.params.map((p) => p.name.toLowerCase()));
      const name = ["entity", "period", "param"].find((n) => !taken.has(n)) ?? `param${r.params.length + 1}`;
      r.params.push({ name, value: name === "period" ? new Date().toISOString().slice(0, 7) : "" });
      changed(true);
    });
    const back = makeButton("Previous period", "ghost");
    back.classList.add("btn-sm");
    back.title = "Move period parameters back one period";
    back.addEventListener("click", () => roll(-1));
    const fwd = makeButton("Next period", "ghost");
    fwd.classList.add("btn-sm");
    fwd.title = "Move period parameters on one period (2026-03 → 2026-04, Q1 2026 → Q2 2026)";
    fwd.addEventListener("click", () => roll(1));
    addRow.append(addParam, back, fwd);
    params.append(addRow);
    inner.append(params);

    // run for each
    const rf = r.runFor;
    const each = el("div", "an-section");
    const eh = el("div", "an-section__head");
    eh.append(el("h3", "an-section__title", "Run for each"));
    each.append(eh);
    const param = selectOf([["", "Just once"], ...r.params.map((p) => [p.name, `Once for each ${p.name}`] as [string, string])], rf?.param ?? "", "Run");
    param.disabled = !r.params.length;
    if (!r.params.length) param.title = "Add a parameter first";
    param.addEventListener("change", () => {
      if (!param.value) delete r.runFor;
      else r.runFor = { ...(r.runFor ?? { sheetId: r.sheetId, column: 0 }), param: param.value };
      changed(true);
    });
    each.append(field("Run", param));
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
        if (how.value === "list") r.runFor = { param: rf.param, list: [], ...(rf.consolidated ? { consolidated: true } : {}) };
        else r.runFor = { param: rf.param, sheetId: r.sheetId, column: 0, ...(rf.consolidated ? { consolidated: true } : {}) };
        changed(true);
      });
      each.append(field("Values from", how));
      if (fromList) {
        const list = el("input");
        list.value = (rf.list ?? []).join(", ");
        list.placeholder = "North, South, East";
        list.addEventListener("input", () => {
          rf.list = list.value
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          changed();
        });
        each.append(field("Values", list));
      } else {
        const sheet = selectOf(sheets(), rf.sheetId ?? r.sheetId, "Sheet");
        sheet.addEventListener("change", () => {
          rf.sheetId = sheet.value;
          rf.column = 0;
          changed(true);
        });
        const col = selectOf(columnsOf(rf.sheetId ?? r.sheetId), String(rf.column ?? 0), "Column");
        col.addEventListener("change", () => {
          rf.column = Number(col.value);
          changed();
        });
        const row = el("div", "an-row");
        row.append(field("Sheet", sheet), field("Column", col));
        each.append(row);
      }
      const cons = el("input");
      cons.type = "checkbox";
      cons.checked = !!rf.consolidated;
      cons.addEventListener("change", () => {
        rf.consolidated = cons.checked;
        changed();
      });
      const cl = el("label", "an-check");
      cl.append(cons, el("span", undefined, "Also a consolidated report of all of them"));
      each.append(cl);
      const n = runForValues(r, env).length;
      each.append(el("p", "an-hint", `${n.toLocaleString()} report${n === 1 ? "" : "s"}${rf.consolidated ? " plus the consolidated one" : ""} in the PDF.`));
    }
    inner.append(each);
    return box;
  }

  function roll(steps: number) {
    if (!rep) return;
    const { report, changed: names } = rollForward(rep, steps);
    if (!names.length) {
      toast({ kind: "warning", text: "No parameter looks like a period (2026-03-31, 2026-03, Mar 2026, Q1 2026, FY2026, 2026)." });
      return;
    }
    rep = report;
    toast({ text: `${names.join(", ")} now ${names.map((n) => rep!.params.find((p) => p.name === n)!.value).join(", ")}` });
    changed(true);
  }

  // ---- blocks
  function filterEditor(r: Report, b: { filter?: ParamFilter; sheetId?: string }, sheetId: string): HTMLElement | null {
    if (!r.params.length) return null;
    const wrap = el("div", "an-row");
    const param = selectOf([["", "All rows"], ...r.params.map((p) => [p.name, `Only this ${p.name}`] as [string, string])], b.filter?.param ?? "", "Rows");
    const col = selectOf(columnsOf(sheetId), String(b.filter?.column ?? 0), "In column");
    const colField = field("In column", col);
    colField.hidden = !b.filter;
    param.addEventListener("change", () => {
      if (!param.value) delete b.filter;
      else b.filter = { param: param.value, column: Number(col.value) || 0 };
      colField.hidden = !b.filter;
      changed();
    });
    col.addEventListener("change", () => {
      if (b.filter) b.filter.column = Number(col.value);
      changed();
    });
    wrap.append(field("Rows", param), colField);
    return wrap;
  }

  function pivotEditor(b: Extract<ReportBlock, { source: "pivot" }>): HTMLElement {
    const wrap = el("div", "an-row report-pivot-row");
    const cols = columnsOf(b.sheetId);
    const p = b.pivot;
    const rowsSel = selectOf(cols, String(p.rows[0]?.field ?? 0), "Rows");
    const colsSel = selectOf([["", "(none)"], ...cols], p.cols[0] ? String(p.cols[0].field) : "", "Across");
    const valSel = selectOf(cols, String(p.values[0]?.field ?? 0), "Values");
    const aggSel = selectOf(Object.entries(AGG_LABEL) as [string, string][], p.values[0]?.agg ?? "sum", "Summarise by");
    const set = () => {
      const names = wb.has(b.sheetId) ? readSheetColumns(wb.get(b.sheetId).source).names : undefined;
      b.pivot = {
        rows: [{ field: Number(rowsSel.value), ...(p.rows[0]?.field === Number(rowsSel.value) && p.rows[0]?.group ? { group: p.rows[0].group } : {}) }],
        cols: colsSel.value ? [{ field: Number(colsSel.value) }] : [],
        values: [{ field: Number(valSel.value), agg: aggSel.value as PivotAgg }],
        filters: p.filters,
        subtotals: p.subtotals ?? true,
        grandTotals: p.grandTotals ?? true,
        ...(names ? { names } : {}),
      };
      changed();
    };
    for (const s of [rowsSel, colsSel, valSel, aggSel]) s.addEventListener("change", set);
    wrap.append(field("Summarise", aggSel), field("of", valSel), field("by", rowsSel), field("across", colsSel));
    return wrap;
  }

  const defaultPivot = (sheetId: string): SavedPivot => {
    const data = wb.has(sheetId) ? readSheetColumns(wb.get(sheetId).source) : null;
    const f = sheetFacts(sheetId, "", data);
    const by = f.category ?? Math.max(0, data ? data.columns.findIndex((c) => c.kind === "string") : 0);
    return { rows: [{ field: by }], cols: [], values: [f.amount === null ? { field: by, agg: "count" } : { field: f.amount, agg: "sum" }], filters: [], subtotals: true, grandTotals: true, names: f.names };
  };

  function blockSummary(b: ReportBlock): string {
    switch (b.kind) {
      case "heading":
        return b.text || "Heading";
      case "paragraph":
        return b.text ? b.text.slice(0, 60) : "Text";
      case "table":
        return b.title || (b.source === "pivot" ? "Summary table" : `Cells ${b.range}`);
      case "chart":
        return b.title || b.spec?.title || "Chart";
      case "pageBreak":
        return "Page break";
    }
  }

  function blockEditor(r: Report, b: ReportBlock, i: number): HTMLElement {
    const card = el("section", "report-block");
    card.dataset.kind = b.kind;
    const top = el("div", "report-block-head");
    const kind = el("span", "report-block-kind");
    kind.append(icon(BLOCK_ICON[b.kind], { size: 14 }), el("span", undefined, BLOCK_LABEL[b.kind]));
    const sum = el("span", "report-block-sum", b.kind === "heading" || b.kind === "paragraph" || b.kind === "pageBreak" ? "" : blockSummary(b));
    top.append(kind, sum);
    const move = (to: number) => {
      const [x] = r.blocks.splice(i, 1);
      r.blocks.splice(to, 0, x);
      changed(true);
      editor.querySelectorAll<HTMLElement>(".report-block")[to]?.querySelector<HTMLElement>("button")?.focus();
    };
    if (i > 0) top.append(iconButton("chevron-up", `Move ${BLOCK_LABEL[b.kind]} up`, { size: "sm", onClick: () => move(i - 1) }));
    if (i < r.blocks.length - 1) top.append(iconButton("chevron-down", `Move ${BLOCK_LABEL[b.kind]} down`, { size: "sm", onClick: () => move(i + 1) }));
    top.append(
      iconButton("trash", `Remove ${BLOCK_LABEL[b.kind]}`, {
        size: "sm",
        onClick: () => {
          const removed = r.blocks.splice(i, 1)[0];
          changed(true);
          toast({ text: `Removed the ${BLOCK_LABEL[removed.kind].toLowerCase()}`, action: { label: "Undo", run: () => (r.blocks.splice(i, 0, removed), changed(true)) } });
        },
      }),
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
            ["1", "Large"],
            ["2", "Medium"],
            ["3", "Small"],
          ],
          String(b.level),
          "Heading size",
        );
        lvl.addEventListener("change", () => {
          b.level = Number(lvl.value) as 1 | 2 | 3;
          changed();
        });
        lvl.classList.add("report-level");
        const row = el("div", "an-row");
        row.append(t, lvl);
        card.append(row);
        break;
      }
      case "paragraph": {
        const t = el("textarea");
        t.value = b.text;
        t.rows = 3;
        t.placeholder = "Write a note.";
        t.setAttribute("aria-label", "Text");
        t.addEventListener("input", () => {
          b.text = t.value;
          changed();
        });
        // text with live figures reads as words and chips; the {{…}} source is behind a toggle
        if (!hasFields(b.text) && !sourceOpen.has(b.id)) {
          card.append(t);
          break;
        }
        const names = columnsOf(r.sheetId).map(([, label]) => label.replace(/ \([A-Z]+\)$/, ""));
        const view = el("div", "report-text-view");
        view.setAttribute("aria-label", "Text with live figures");
        for (const part of textParts(b.text, names)) {
          if (part.kind === "text") view.append(part.text);
          else {
            const chip = el("span", `report-chip${part.param ? " report-chip--param" : ""}`);
            chip.append(icon(part.param ? "info" : "formula", { size: 12 }), el("span", undefined, part.label));
            chip.title = part.param ? `Parameter: shows the value of {{${part.source.trim()}}}` : `Live figure: ${part.source.trim()}`;
            view.append(chip);
          }
        }
        const open = sourceOpen.has(b.id);
        const toggle = makeButton(open ? "Done" : "Edit source", "ghost", open ? undefined : "formula");
        toggle.classList.add("btn-sm", "report-source-toggle");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.title = open ? "Back to the words and live figures" : "Edit the text, with the formulas behind the live figures";
        toggle.addEventListener("click", () => {
          if (open) sourceOpen.delete(b.id);
          else sourceOpen.add(b.id);
          changed(true);
          if (!open) editor.querySelector<HTMLTextAreaElement>(`.report-block[data-id="${b.id}"] textarea`)?.focus();
        });
        card.dataset.id = b.id;
        if (open) {
          t.placeholder = "Write a note. A live figure looks like {{=SUM(F:F)}}; a parameter like {{period}}.";
          const tools = el("div", "report-text-tools");
          tools.append(toggle);
          card.append(t, tools);
        } else {
          const tools = el("div", "report-text-tools");
          tools.append(toggle);
          card.append(view, tools);
        }
        break;
      }
      case "table": {
        const row = el("div", "an-row");
        const source = selectOf(
          [
            ["pivot", "A summary (pivot)"],
            ["range", "Cells as they are"],
          ],
          b.source,
          "Show",
        );
        source.addEventListener("change", () => {
          const base = { id: b.id, kind: "table" as const, sheetId: b.sheetId, ...(b.title ? { title: b.title } : {}), ...(b.filter ? { filter: b.filter } : {}) };
          r.blocks[i] = source.value === "pivot" ? { ...base, source: "pivot", pivot: defaultPivot(b.sheetId) } : { ...base, source: "range", range: "A1:D10", headerRow: true };
          changed(true);
        });
        const sheet = selectOf(sheets(), b.sheetId, "Sheet");
        sheet.addEventListener("change", () => {
          b.sheetId = sheet.value;
          if (b.source === "pivot") b.pivot = defaultPivot(b.sheetId);
          changed(true);
        });
        row.append(field("Show", source), field("From", sheet));
        card.append(row);
        if (b.source === "range") {
          const rr = el("div", "an-row");
          const range = el("input");
          range.value = b.range;
          range.placeholder = "A1:D20 or A:D";
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
          const hl = el("label", "an-check an-fit");
          hl.append(hdr, el("span", undefined, "Header row"));
          rr.append(field("Cells", range), hl);
          card.append(rr);
        } else card.append(pivotEditor(b));
        const title = el("input");
        title.value = b.title ?? "";
        title.placeholder = "Optional";
        title.addEventListener("input", () => {
          b.title = title.value || undefined;
          changed();
        });
        card.append(field("Caption", title));
        const f = filterEditor(r, b, b.sheetId);
        if (f) card.append(f);
        break;
      }
      case "chart": {
        const charts = wb.charts;
        const label = (c: ChartSpec) => `${c.title || (c.pivot ? "Pivot chart" : `${c.type} chart`)} (${wb.has(c.range.sheetId) ? wb.get(c.range.sheetId).name : "?"})`;
        const own = b.spec && !b.chartId ? [["__own", b.spec.title || "This report's chart"] as [string, string]] : [];
        const pick = selectOf([...own, ["", charts.length || own.length ? "Pick a chart…" : "No charts yet: insert one on the sheet first"], ...charts.map((c) => [c.id, label(c)] as [string, string])], b.chartId ?? (own.length ? "__own" : ""), "Chart");
        pick.addEventListener("change", () => {
          if (pick.value === "__own") return;
          b.chartId = pick.value || undefined;
          if (b.chartId) delete b.spec;
          changed(true);
        });
        const title = el("input");
        title.value = b.title ?? "";
        title.placeholder = "The chart's own title";
        title.addEventListener("input", () => {
          b.title = title.value || undefined;
          changed();
        });
        card.append(field("Chart", pick), field("Title", title));
        const spec = b.spec ?? charts.find((c) => c.id === b.chartId);
        if (spec) {
          const f = filterEditor(r, b, spec.pivot?.sheetId ?? spec.range.sheetId);
          if (f) card.append(f);
        }
        break;
      }
      case "pageBreak":
        card.classList.add("report-block--break");
        break;
    }
    return card;
  }

  function render() {
    if (mode === "start" || !rep) {
      mode = "start";
      renderStart();
      return;
    }
    const r = rep;
    const scroll = editor.scrollTop;
    editor.replaceChildren(renderTop(r));
    const blocks = el("section", "an-section report-blocks");
    const bh = el("div", "an-section__head");
    bh.append(el("h3", "an-section__title", "Contents"), el("span", "an-hint", `${r.blocks.length} block${r.blocks.length === 1 ? "" : "s"}, printed in this order`));
    blocks.append(bh);
    r.blocks.forEach((b, i) => blocks.append(blockEditor(r, b, i)));
    if (!r.blocks.length) {
      const empty = el("div", "an-empty");
      empty.append(el("p", undefined, "An empty page. Add a heading, some text with live figures, a table or a chart below."));
      blocks.append(empty);
    }
    const add = el("div", "report-add");
    add.setAttribute("role", "group");
    add.setAttribute("aria-label", "Add to the report");
    for (const kind of ["heading", "paragraph", "table", "chart", "pageBreak"] as BlockKind[]) {
      const btn = el("button", "report-add__btn");
      btn.type = "button";
      btn.title = BLOCK_HINT[kind];
      btn.append(icon("plus", { size: 12 }), el("span", undefined, BLOCK_LABEL[kind]));
      btn.addEventListener("click", () => {
        const nb = newBlock(kind, r.sheetId);
        if (nb.kind === "table") Object.assign(nb, { source: "pivot", pivot: defaultPivot(r.sheetId) });
        r.blocks.push(nb);
        changed(true);
        requestAnimationFrame(() => {
          const cards = editor.querySelectorAll<HTMLElement>(".report-block");
          const last = cards[cards.length - 1];
          last?.scrollIntoView({ block: "nearest" });
          last?.querySelector<HTMLElement>("input, textarea, select")?.focus();
        });
      });
      add.append(btn);
    }
    blocks.append(add);
    editor.append(blocks, renderAdvanced(r));
    editor.scrollTop = scroll;
    renderActions(r);
  }

  // ---- running
  let lastRuns: RenderedReport[] = [];
  const currentReport = (): Report => (mode === "start" || !rep ? starterReport(starter, sheetInfo) : rep);
  const runs = (r = currentReport()): RenderedReport[] => (r.runFor ? runBook(r, env) : [runReport(r, env)]);

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
    const scroll = previewBox.scrollTop;
    const fit = fitPage(shown, currentReport().page ?? { size: "A4", landscape: false });
    previewBox.innerHTML = reportHtml(shown, fit);
    if (all.length > shown.length) previewBox.append(el("p", "an-hint report-more", `Showing ${shown.length} of ${all.length} reports here. The PDF has them all.`));
    drawCharts(previewBox, shown);
    scalePages();
    previewBox.scrollTop = scroll;
    const warn = [...new Set(all.flatMap((r) => r.warnings))];
    if (fit.note) warn.push(fit.note);
    previewNote.hidden = !warn.length;
    previewNote.replaceChildren();
    if (warn.length) previewNote.append(icon("warning"), el("span", undefined, warn.length === 1 ? warn[0] : `${warn.length} things to check: ${warn.slice(0, 3).join(" · ")}`));
  }

  /** Show each page whole: scale it down to the pane's width (never up). */
  function scalePages() {
    const room = previewBox.clientWidth - 32;
    for (const page of previewBox.querySelectorAll<HTMLElement>(".report-page")) {
      page.style.zoom = "";
      const w = page.offsetWidth;
      if (room > 0 && w > room) page.style.zoom = String(Math.max(0.3, room / w));
    }
  }
  new ResizeObserver(() => scalePages()).observe(previewBox);

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
    if (!rep) return;
    await save();
    let all: RenderedReport[];
    try {
      all = runs(rep);
    } catch (e) {
      toast({ kind: "error", title: "Couldn't run the report", text: (e as Error).message });
      return;
    }
    const progress = toast({ text: `Writing ${all.length} report${all.length === 1 ? "" : "s"} to PDF…`, duration: 0 });
    const page = rep.page ?? { size: "A4", landscape: false };
    try {
      const bytes = await reportPdf(all, { title: rep.title, size: page.size, landscape: page.landscape, footer: rep.title }, paintChart);
      const name = `${safeName(all.length === 1 ? all[0].title : rep.title)}.pdf`;
      download(bytes, name);
      const pages = (new TextDecoder("latin1").decode(bytes).match(/\/Type \/Page\b/g) ?? []).length;
      progress.close();
      toast({ kind: "success", text: `Saved ${name}: ${all.length} report${all.length === 1 ? "" : "s"}, ${pages} page${pages === 1 ? "" : "s"}` });
    } catch (e) {
      progress.close();
      toast({ kind: "error", title: "Couldn't write the PDF", text: (e as Error).message });
    }
  }

  function print() {
    preview();
    const host = el("div", "report-print report-doc");
    const page = currentReport().page ?? { size: "A4", landscape: false };
    const fit = fitPage(lastRuns, page);
    host.innerHTML = reportHtml(lastRuns, fit);
    drawCharts(host, lastRuns);
    // the paper the preview showed (landscape when a wide table needs it)
    const paper = el("style");
    paper.textContent = `@page { size: ${page.size} ${fit.landscape ? "landscape" : "portrait"}; }`;
    document.head.append(paper);
    document.body.append(host);
    document.body.classList.add("report-printing");
    const done = () => {
      document.body.classList.remove("report-printing");
      host.remove();
      paper.remove();
      removeEventListener("afterprint", done);
    };
    addEventListener("afterprint", done);
    window.print();
    // browsers that print without blocking fire afterprint; the rest return here
    setTimeout(done, 1000);
  }

  function renderActions(r: Report) {
    footer.replaceChildren();
    const start = el("div", "cf-dialog__footer-start");
    const del = makeButton("Delete report", "ghost", "trash");
    del.classList.add("btn-danger-ghost");
    del.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: `Delete the report "${r.title}"?`, text: "Undo brings it back.", confirm: "Delete report", danger: true }))) return;
      clearTimeout(saveTimer);
      const id = r.id;
      void d.run({ type: "report.set", params: { id, report: null } }).then(() => {
        const next = reportsOf(wb)[0];
        if (next) openReport(next);
        else {
          rep = null;
          saved = "";
          mode = "start";
          render();
        }
        toast({ text: `Deleted the report "${r.title}". Undo (Ctrl+Z) brings it back.` });
      });
    });
    start.append(del);
    const printBtn = makeButton("Print", "secondary");
    printBtn.title = "Print the preview (the print dialog can also save a PDF)";
    printBtn.addEventListener("click", print);
    const pdf = makeButton(r.runFor ? `Export PDF book` : "Export PDF", "primary", "download");
    pdf.title = r.runFor ? `One report for each ${r.runFor.param}, with a contents page` : "Save the report as a PDF";
    pdf.addEventListener("click", () => void exportPdf());
    footer.append(start, printBtn, pdf);
  }

  render();
  if (mode === "edit") preview();
}
