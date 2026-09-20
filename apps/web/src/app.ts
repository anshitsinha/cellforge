import "./style.css";
import "./shell.css";
import type { ChartSpec } from "./charts/model";
import { type CellRange, Grid, columnLetter } from "@cellforge/grid";
import { parseTsv, rangeSize, rangeToTsv } from "./clipboard";
import { computeStats } from "./stats";
import { SyntheticSource } from "./demo";
import { sampleFromUrl, sampleWorkbook, type SampleKind } from "./samples";
import { type Action, ActionHistory, type ActionRegistry, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource, isFormula, type Fill } from "./editable";
import { download, exportCsv } from "./exporter";
import { SheetTabs } from "./tabs";
import { setupFormatBar } from "./formatbar";
import { attachFormulaAssist } from "./formulaassist";
import { setupNamesUi } from "./namesui";
import { setupInspectPanel } from "./inspectpanel";
import { openXlsx, saveXlsx } from "./xlsxio";
import { askCsvOptions } from "./importdialog";
import { importStatement, pickStatement } from "./statement";
import { closeFilterMenu, openFilterMenu } from "./filtermenu";
import { openFindReplace } from "./finddialog";
import { bindSqlStore, registerSqlActions } from "./sqlpanel";
import { bindChecksStore, gateExport, registerCheckActions } from "./checksui";
import { RecipeRecorder, unbindAction, usedMemory } from "./recipe";
import { openLineage } from "./lineagepanel";
import { askContext, setupAskBar } from "./askbar";
import { registerReportActions } from "./reports/actions";
import { openAskGuide } from "./askguide";
import { aiStatus, currentModel, onAiStatus } from "./localmodel";
import { aiBadge, AI_PANEL_ID, openAiPanel, toggleAiPanel, watchAiToasts, type AiPanelDeps } from "./aipanel";
import { buildTemplate, pickTemplate, TEMPLATES, type TemplateKind } from "./templates";
import { clearLocalData, decryptFile, encryptFile, isEncrypted } from "./sharing";
import { askPassword, confirmClear } from "./sharingui";
import { allMarks } from "./review";
import { appendLog, fingerprint, onFileRead, type Fingerprint, type LogEntry } from "./evidence";
import { saveEvidencePack } from "./evidencepack";
import type { Workbook as WorkbookT } from "./workbook";
import { cellLink, editExtra, extraAction, followLink, showNoteTip } from "./links";
import { askAboutInvalid, closeDropdown, dvContext, invalidInputs, openDropdown, showInputMessage } from "./dvui";
import { chartSpecs, closeChart, openChart, refreshCharts } from "./charts/panel";
import { registerFindActions } from "./findreplace";
import { delocalizeFormula, jsonToColumns, localizeFormula, readParquet, Table } from "@cellforge/core";
import { installA11y } from "./a11y";
import { startLocale } from "./locale";
import { setupPalette } from "./palette";
import { setupHistoryPanel, type TrailEntry } from "./historypanel";
import { AutoSaver, fromFile, OpfsStore, packWorkbook, toFile, unpackWorkbook, type JournalEntry } from "./persist";
import { sheetNameProblem, Workbook } from "./workbook";
import { extractKeys, sortInWorker } from "./sort";
import { formatBytes, importCsv } from "./importer";
import { confirmDialog } from "./ui/confirm";
import { openDialog } from "./ui/dialog";
import { icon } from "./ui/icons";
import { mountSidePanelHost, onSidePanelChange } from "./ui/sidepanel";
import { buildCommands, COMMAND_GROUPS, devMode, sheetContext, sheetIsBlank, suggestedCommandIds, type AppCommand, type CommandDeps, type ThemeChoice } from "./commands";
import { buildMenuModel, menuButton, menuEntries, setupMenuBar } from "./menubar";
import { setupRail } from "./rail";
import { setupStartScreen } from "./startscreen";
import { createNotifier } from "./messages";

/** Results, warnings and errors for the user: toasts (messages.ts). */
const notify = createNotifier();

const statementDeps = () => ({
  run: (a: Action) => run(a),
  putBlob: (v: unknown) => blobs.put(v),
  status: notify,
  focusGrid: () => grid.focus(),
});

const DEMO_ROWS = 100_000_000;

const sheet = document.getElementById("sheet")!;
const statusLeft = document.getElementById("status-left")!;
const statusRight = document.getElementById("status-right")!;
const fileName = document.getElementById("file-name")!;
const cellRef = document.getElementById("cell-ref")!;
const formulaInput = document.getElementById("formula-input") as HTMLInputElement;

const rowFormat = new Intl.NumberFormat();

// /app.html?demo=1 (the landing page's "try the demo" link) opens the 100M
// row dataset; otherwise start with an empty sheet like any spreadsheet app
// /app.html?sample=bank-rec|close|audit|big opens a finance sample (samples.ts)
const startSample = sampleFromUrl(location.search);
const startWithDemo = new URLSearchParams(location.search).has("demo") || startSample === "big";

// imported/demo data gets a few empty columns after it, for calculated columns
const SPARE_COLUMNS = 10;

/** A file name made into a valid sheet name ("sales/2026.csv" → "sales_2026"). */
function sheetNameFrom(file: string): string {
  const name = file
    .replace(/.(csv|tsv|txt)$/i, "")
    .replace(/[\/?*[]:]/g, "_")
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  return name && !sheetNameProblem(name) ? name : "Sheet1";
}

let workbook = startWithDemo
  ? new Workbook({ name: "Demo", source: new EditableSource(new SyntheticSource(DEMO_ROWS), SPARE_COLUMNS) })
  : new Workbook();
let activeId = workbook.sheets[0].id;
/** the sheet on screen */
let source = workbook.sheets[0].source;
let currentName = startWithDemo ? "demo — 100M-line general ledger" : "Untitled";
// each sheet keeps its own selection when you switch away and back
const selections = new Map<string, CellRange>();
// Fingers need bigger targets than a mouse, and iOS zooms the page when an
// input with <16px text gets focus.
const coarsePointer = matchMedia("(pointer: coarse)").matches;
// the number format and separators people expect where they are, and keyboard / screen reader support in dialogs
startLocale();
installA11y();
const grid = new Grid(
  sheet,
  source,
  coarsePointer ? { rowHeight: 32, headerHeight: 30, defaultColumnWidth: 120, editorFontSize: 16 } : {},
);
// formulas are edited with the locale's argument separator (; in German and French)
grid.editTextFilter = (t) => localizeFormula(t);
// the one side panel sits beside the grid; the grid watches its own size
mountSidePanelHost(sheet);

/** The sheet's size, quietly, on the left of the status bar. */
function updateStatus() {
  statusLeft.textContent = !sheetIsBlank(source) ? `${rowFormat.format(source.rowCount)} row${source.rowCount === 1 ? "" : "s"} · ${source.colCount} column${source.colCount === 1 ? "" : "s"}` : "";
}

function syncFormulaBar() {
  const { row, col } = grid.selection;
  cellRef.textContent = `${columnLetter(col)}${row + 1}`;
  formulaInput.value = localizeFormula(source.getEditText(row, col));
}

// --- status bar (right side) ----------------------------------------------------
// Shows selection stats when more than one cell is selected, otherwise
// the last background job's note (a compiled column's speed).

let infoText = "";
let statsToken = 0;
const numFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function setInfo(text: string) {
  infoText = text;
  updateSelectionStats();
}

async function updateSelectionStats() {
  const token = ++statsToken;
  const range = grid.range;
  if (rangeSize(range) <= 1) {
    statusRight.textContent = infoText;
    return;
  }
  const stats = await computeStats(
    source,
    range,
    () => token !== statsToken,
    (f) => (statusRight.textContent = `Calculating… ${Math.round(f * 100)}%`),
  );
  if (!stats || token !== statsToken) return;
  const parts = [];
  if (stats.numbers) {
    parts.push(`Sum <b>${numFormat.format(stats.sum)}</b>`);
    parts.push(`Average <b>${numFormat.format(stats.sum / stats.numbers)}</b>`);
  }
  parts.push(`Count <b>${rowFormat.format(stats.count)}</b>`);
  statusRight.innerHTML = parts.join('<span class="status-sep"></span>');
}

// keep the name box, formula bar and stats in sync with the selection
grid.onSelectionChange = () => {
  closeDropdown();
  {
    const { row, col } = grid.selection;
    const rule = source.validationAt(row, col);
    const r = rule?.inputMessage || rule?.inputTitle ? grid.cellPageRect(row, col) : null;
    showInputMessage(rule, r?.x ?? 0, (r?.y ?? 0) + (r?.height ?? 0));
  }
  showHint();
  syncFormulaBar();
  updateSelectionStats();
  formatBar.sync();
  historyPanel.render();
  inspectPanel.render();
};

// a lookup that found nothing for a fixable reason explains itself here
const hintBox = document.getElementById("status-hint")!;
hintBox.className = "status-hint";
function showHint() {
  const { row, col } = grid.selection;
  const hint = source.hintAt(row, col);
  hintBox.replaceChildren();
  if (!hint) return;
  const msg = document.createElement("span");
  msg.textContent = hint.message;
  hintBox.append(msg);
  const fix = hint.fix;
  if (fix) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = fix.label;
    b.addEventListener("click", () => {
      const sheet = fix.sheet ? workbook.byName(fix.sheet)?.id : activeId;
      if (!sheet) return;
      void run({ type: fix.kind === "trim" ? "cells.trim" : "cells.toNumber", params: { range: fix.range, sheet } }).then(() => {
        showHint();
        grid.focus();
      });
    });
    hintBox.append(b);
  }
}

// drag a row border (or double-click it to fit): resize that row, or every
// selected row when the drag is on one of several selected whole rows
grid.onRowResize = (row, height) => {
  const r = grid.range;
  const wholeRows = r.left === 0 && r.right === source.colCount - 1;
  const inside = wholeRows && row >= r.top && row <= r.bottom;
  void run({ type: "rows.height", params: { at: inside ? r.top : row, count: inside ? r.bottom - r.top + 1 : 1, height } });
};

// the fill handle: drag to continue a series, double-click to fill down
// alongside the neighbouring data
async function fillRange(sourceRange: CellRange, target: CellRange) {
  const down = target.top === sourceRange.top && target.bottom > sourceRange.bottom;
  const oneRow = sourceRange.top === sourceRange.bottom;
  let allFormulas = oneRow;
  for (let c = sourceRange.left; allFormulas && c <= sourceRange.right; c++) {
    allFormulas = source.getEditText(sourceRange.top, c).startsWith("=");
  }
  // a formula row filled down a long way: one fill block, instant at any size
  const action: Action =
    down && allFormulas && target.bottom - target.top > 10_000
      ? { type: "fill.down", params: { range: target } }
      : { type: "fill.series", params: { source: sourceRange, target } };
  if (await run(action)) grid.selectRange(target);
}

grid.onFill = (s, t) => void fillRange(s, t);
grid.onFillDoubleClick = (r) => {
  // fill down as far as the column beside the selection has data (Excel's rule)
  const side = r.left > 0 && source.getCell(r.bottom + 1, r.left - 1) !== null ? r.left - 1 : r.right + 1 < source.colCount ? r.right + 1 : -1;
  if (side < 0) return;
  const limit = Math.min(source.rowCount - 1, r.bottom + 5_000_000);
  let end = r.bottom;
  while (end < limit && source.getCell(end + 1, side) !== null) end++;
  if (end > r.bottom) void fillRange(r, { ...r, bottom: end });
};

// same for column borders: every selected whole column when dragging one of them
grid.onColumnResize = (col, width) => {
  const r = grid.range;
  const wholeCols = r.top === 0 && r.bottom === source.rowCount - 1;
  const inside = wholeCols && col >= r.left && col <= r.right;
  void run({ type: "cols.width", params: { at: inside ? r.left : col, count: inside ? r.right - r.left + 1 : 1, width } });
};

// function suggestions and argument hints in the formula bar and the cell editor
attachFormulaAssist(formulaInput);
attachFormulaAssist(grid.editorInput);

const formatBar = setupFormatBar({
  root: document.getElementById("format-bar")!,
  grid,
  source: () => source,
  run: (a) => run(a),
  status: notify,
  gridHasFocus: () => gridHasFocus(),
  sheetElement: sheet,
});

// --- edits + undo/redo -------------------------------------------------------------

// Every change goes through an action (see actions.ts): validated, undoable,
// and recordable into recipes later. Sorting runs in a worker, so actions
// can be async; the history applies them one at a time.

const undoButton = document.getElementById("btn-undo") as HTMLButtonElement;
const redoButton = document.getElementById("btn-redo") as HTMLButtonElement;

const registry = sheetActions();
registerFindActions(registry);
registerCheckActions(registry);
registerReportActions(registry);
registerSqlActions(registry);
bindSqlStore({ getQueries: () => workbook.sqlQueries, setQueries: (q) => (workbook.sqlQueries = q) });
bindChecksStore({
  workbook: () => workbook,
  getChecks: () => workbook.checks,
  setChecks: (c) => (workbook.checks = c),
  getRules: () => workbook.categoryRules,
  setRules: (r) => (workbook.categoryRules = r),
});
const blobs = new BlobStore();
let cancelSort: (() => void) | null = null;

/** Sort keys are read on the main thread in slices; the radix sort runs in a worker. */
async function sortRows(target: EditableSource, col: number, descending: boolean): Promise<Uint32Array | null> {
  cancelSort?.();
  const name = target.getColumnName(col) ?? columnLetter(col);
  let cancelled = false;
  cancelSort = () => (cancelled = true);
  notify(`Sorting by ${name}: reading values…`);
  const { keys, kinds } = await extractKeys(target, col, descending, (f) => {
    notify(`Sorting by ${name}: reading values… ${Math.round(f * 100)}%`);
  });
  if (cancelled) return null;
  const job = sortInWorker({ keys, kinds, descending }, (f) => {
    notify(`Sorting by ${name}… ${Math.round(f * 100)}%`);
  });
  cancelSort = job.cancel;
  try {
    return (await job.result).order;
  } catch {
    return null; // cancelled
  } finally {
    cancelSort = null;
  }
}

// a sheet that an action just added or restored is shown once it finishes
let pendingShow: string | null = null;
const ctx = (): SheetCtx => ({
  workbook,
  activeSheet: activeId,
  blobs,
  sortRows,
  onSheetShown: (id) => (pendingShow = id),
});
const history = new ActionHistory(registry, ctx);

const lineageDeps = () => ({
  workbook: () => workbook,
  model: () => currentModel(),
  sheetId: () => activeId,
  cell: () => ({ ...grid.selection }),
  lastEdit: (sheetId: string, row: number, col: number) => {
    if (!workbook.has(sheetId)) return undefined;
    const list = trail.get(`${sheetId}:${workbook.get(sheetId).source.toBase(row)}:${col}`);
    return list?.[list.length - 1];
  },
  goTo: (sheetId: string, row: number, col: number) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  status: notify,
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "e" && gridHasFocus()) {
    e.preventDefault();
    openLineage(lineageDeps());
  }
});
// the evidence log: every change, chained by SHA-256, written in order
let logQueue: Promise<unknown> = Promise.resolve();
function logEvidence(entry: Pick<LogEntry, "kind" | "label" | "sheet" | "action">) {
  const wb = workbook;
  logQueue = logQueue.then(() => appendLog(wb.evidence.log, entry)).catch(() => undefined);
}
function noteInput(file: File, kind: Fingerprint["kind"]) {
  const wb = workbook;
  logQueue = logQueue
    .then(async () => {
      const fp = await fingerprint(file, kind);
      wb.evidence.inputs.push(fp);
      await appendLog(wb.evidence.log, { kind: kind === "open" ? "open" : "import", label: `${kind === "open" ? "opened" : "read"} ${file.name} (SHA-256 ${fp.sha256.slice(0, 12)}…)` });
    })
    .catch(() => undefined);
}
onFileRead((file, kind) => noteInput(file, kind));

/** Where attached documents' bytes live: the browser's private storage (null where it isn't available). */
// documents are stored by fingerprint, so any tab can use the storage (no autosave lock needed)
let docStore: Awaited<ReturnType<typeof OpfsStore.open>> = null;
void OpfsStore.open("documents").then((st) => (docStore = st)).catch(() => undefined);
const docBytes = () => (docStore ? { read: (n: string) => docStore!.read(n), write: (n: string, d: Uint8Array) => docStore!.write(n, d) } : null);
const docDeps = () => ({
  workbook: () => workbook,
  activeSheet: () => activeId,
  cell: () => ({ ...grid.selection }),
  store: docBytes,
  run: (a: Action) => run(a),
  goTo: findDeps().goTo,
  status: notify,
});

const recipeFilesDeps = () => ({
  registry,
  addSheets: async (wb: WorkbookT, prefix: string) => {
    for (const s of wb.sheets) await run({ type: "sheet.insert", params: { name: `${prefix} ${s.name}`.slice(0, 31), source: blobs.put(s.source) } });
  },
  status: notify,
  focusGrid: () => grid.focus(),
});

// this session's recordable steps, for recipes (kept in step with undo / redo)
const recorder = new RecipeRecorder();

/** Run a user action; problems are reported in the status bar, not thrown. */
async function run(action: Action) {
  try {
    const sheetName = workbook.has(activeId) ? workbook.get(activeId).name : "";
    const mem0 = usedMemory();
    const t0 = performance.now();
    const applied = await history.run(action);
    if (applied) {
      journal({ op: "run", action });
      recordTrail(action);
      logEvidence({ kind: action.type === "recipe.run" ? "recipe" : "run", label: registry.describe(action), sheet: sheetName, action });
      const def = registry.get(action.type);
      if (def?.recordable && !def.internal) {
        const mem1 = usedMemory();
        recorder.record({
          action: unbindAction(action, (id) => (workbook.has(id) ? workbook.get(id).name : undefined)),
          sheet: sheetName,
          label: registry.describe(action),
          ms: performance.now() - t0,
          ...(mem0 !== undefined && mem1 !== undefined ? { memory: mem1 - mem0 } : {}),
        });
      }
    }
    refresh();
    return applied;
  } catch (e) {
    notify.error((e as Error).message);
    return null;
  }
}

/** Show another sheet. Switching is view state, so it isn't undoable (as in Excel). */
function showSheet(id: string) {
  if (id === activeId) return;
  selections.set(activeId, grid.range);
  const sheet = workbook.get(id);
  activeId = id;
  source = sheet.source;
  attachKernelReporting(source);
  grid.setSource(source);
  const saved = selections.get(id);
  grid.selectRange(saved ?? { top: 0, left: 0, bottom: 0, right: 0 });
  tabs.render();
  refresh();
}

/** Keep the view on a sheet that exists and is visible after any action. */
function settleActiveSheet() {
  if (pendingShow && workbook.has(pendingShow)) {
    const id = pendingShow;
    pendingShow = null;
    showSheet(id);
    return;
  }
  pendingShow = null;
  if (!workbook.has(activeId) || workbook.get(activeId).hidden) {
    const next = workbook.visible[Math.min(workbook.visible.length - 1, 0)] ?? workbook.sheets[0];
    showSheet(next.id);
  }
  // the sheet on screen was replaced (going back to a version): show the new one
  const current = workbook.get(activeId).source;
  if (current !== source) {
    source = current;
    attachKernelReporting(source);
    grid.setSource(source);
  }
}

// sheets whose filter buttons are showing (a filtered sheet always shows them)
const filterButtonsOn = new Set<string>();

function syncFilterButtons() {
  const buttons = new Map<number, boolean>();
  if (source.filter || filterButtonsOn.has(activeId)) {
    const active = new Set(source.filter?.conditions.map((c) => c.col) ?? []);
    const cols = Math.max(1, source.usedRange().cols);
    for (let c = 0; c < cols; c++) buttons.set(c, active.has(c));
  }
  grid.setFilterButtons(buttons);
}

// charts live on the workbook; their windows follow it after every action (so undo works)
let syncingCharts = false;
const chartDeps = {
  source: (id: string) => (workbook.has(id) ? workbook.get(id).source : null),
  activeSheet: () => activeId,
  range: () => grid.range,
  onChange: (id: string, spec: ChartSpec | null) => {
    if (!syncingCharts) void run({ type: "chart.set", params: { id, spec } });
  },
};
function syncCharts() {
  syncingCharts = true;
  try {
    // a chart shows on the sheet its data is on, like Excel's charts on a worksheet
    const want = new Map(workbook.charts.filter((c) => c.range.sheetId === activeId).map((c) => [c.id, c]));
    for (const open of chartSpecs()) if (!want.has(open.id)) closeChart(open.id);
    const open = new Map(chartSpecs().map((c) => [c.id, JSON.stringify(c)]));
    for (const c of want.values()) if (open.get(c.id) !== JSON.stringify(c)) openChart(chartDeps, c);
  } finally {
    syncingCharts = false;
  }
  refreshCharts();
}
const findDeps = () => ({
  workbook: () => workbook,
  activeSheet: () => activeId,
  range: () => grid.range,
  selection: () => grid.selection,
  run: (a: Action) => run(a),
  goTo: (sheetId: string, row: number, col: number) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  focusGrid: () => grid.focus(),
});
// Excel: Ctrl+F finds, Ctrl+H replaces
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const k = e.key.toLowerCase();
  if (k !== "f" && k !== "h") return;
  if (document.querySelector(".palette-backdrop")) return;
  e.preventDefault();
  openFindReplace(findDeps(), k === "f" ? "find" : "replace");
});
const dvDeps = () => ({ workbook: () => workbook, source: () => source, range: () => grid.range, selection: () => grid.selection, run: (a: Action) => run(a), focusGrid: () => grid.focus() });
const cfDeps = () => ({ source: () => source, range: () => grid.range, run: (a: Action) => run(a), focusGrid: () => grid.focus() });
const filterDeps = () => ({ source: () => source, run: (a: Action) => run(a), focusGrid: () => grid.focus() });

/** Open the active column's filter, under its header. */
function filterActiveColumn() {
  filterButtonsOn.add(activeId);
  syncFilterButtons();
  const col = grid.selection.col;
  const r = sheet.getBoundingClientRect();
  openFilterMenu(filterDeps(), col, r.left + 60, r.top + 30);
}

grid.onFilterButton = (col, x, y) => openFilterMenu(filterDeps(), col, x, y);

function toggleFilterButtons() {
  if (source.filter) {
    void run({ type: "filter.clear", params: {} });
    filterButtonsOn.delete(activeId);
  } else if (filterButtonsOn.has(activeId)) filterButtonsOn.delete(activeId);
  else filterButtonsOn.add(activeId);
  closeFilterMenu();
  syncFilterButtons();
}

/** Repaint and update everything that shows cell contents. */
function refresh() {
  settleActiveSheet();
  if (startScreen?.visible && !isEmptyWorkbook()) startScreen.hide();
  syncFilterButtons();
  source.invalidateCondFormats();
  // tick marks look the same on every sheet (custom ones come from the workbook)
  {
    const looks = new Map(allMarks(workbook.review).map((m) => [m.id, { glyph: m.glyph, color: m.color }]));
    for (const s of workbook.sheets) s.source.markLook = (id) => looks.get(id) ?? { glyph: "?", color: "#5f6368" };
  }
  syncCharts();
  showHint();
  tabs.render();
  grid.syncShape();
  grid.setHiddenRows(source.hiddenRowIntervals());
  grid.setHiddenColumns(source.hiddenColumns);
  grid.setColumnWidths(source.columnWidths, `${activeId}:${source.columnWidthsVersion}:${source.colCount}`);
  grid.setRowHeights(source.rowHeightsByView());
  grid.setFrozen(source.frozen.rows, source.frozen.cols);
  grid.setMerges(source.getMerges());
  grid.invalidate();
  syncFormulaBar();
  formatBar.sync();
  historyPanel.render();
  inspectPanel.render();
  updateStatus();
  updateSelectionStats();
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
}

type CellInput = { row: number; col: number; input: string | null };

/** Write several cells (as typed text, or null to empty) as one undoable step. */
function writeCells(cells: CellInput[], label: string) {
  if (cells.length === 0) return;
  void run(setCells(cells, label));
}

async function undo() {
  try {
    const label = await history.undo();
    if (label) {
      journal({ op: "undo" });
      recorder.undo(label);
      logEvidence({ kind: "undo", label });
    }
    refresh();
  } catch (e) {
    notify(`Couldn't undo: ${(e as Error).message}`);
  }
}

async function redo() {
  try {
    const label = await history.redo();
    if (label) {
      journal({ op: "redo" });
      recorder.redo(label);
      logEvidence({ kind: "redo", label });
    }
    refresh();
  } catch (e) {
    notify(`Couldn't redo: ${(e as Error).message}`);
  }
}

undoButton.addEventListener("click", () => {
  void undo();
  grid.focus();
});
redoButton.addEventListener("click", () => {
  void redo();
  grid.focus();
});

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  // leave text inputs alone so ctrl+z inside the formula bar undoes typing
  if (document.activeElement instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) {
    e.preventDefault();
    void undo();
  } else if (k === "y" || (k === "z" && e.shiftKey)) {
    e.preventDefault();
    void redo();
  }
});

// --- sorting ---------------------------------------------------------------------
// Peak memory is ~17 bytes/row (8 key + 1 kind + 2x4 index), so the 100M demo
// needs ~1.7GB free.

async function sortBy(descending: boolean) {
  const { col } = grid.selection;
  const name = source.getColumnName(col) ?? columnLetter(col);
  const started = performance.now();
  const applied = await run({ type: "rows.sort", params: { col, descending } });
  if (!applied) return; // cancelled by a newer sort, or failed
  notify(`Sorted ${rowFormat.format(source.rowCount)} rows by ${name} in ${(
    (performance.now() - started) / 1000
  ).toFixed(2)}s`);
}


// --- fill down (Ctrl+D) -------------------------------------------------------------
// Copies the top row of the selection into every row below it. On an
// unsorted sheet each column becomes a single Fill object - O(1) storage no
// matter how many rows - whose formula gets compiled to a typed-array kernel.

async function fillDown() {
  const range = grid.range;
  if (range.bottom === range.top) {
    notify("Select the cell to copy and the cells below it, then fill down (Ctrl+D).");
    return;
  }
  const rows = range.bottom - range.top;
  // sorted sheets fill cell by cell (rows adjacent in the view are scattered
  // in the data), which goes through the sparse edit map
  if (source.rowOrder && rows * (range.right - range.left + 1) > MAX_BULK_CELLS) {
    notify(`Fill down on a sorted sheet is limited to ${rowFormat.format(MAX_BULK_CELLS)} cells.`);
    return;
  }
  const target = source;
  const applied = await run({ type: "fill.down", params: { range } });
  if (!applied) return;

  // unsorted fills are one compiled-or-interpreted Fill per column: say which
  let how = "";
  const inverse = applied.inverse;
  if (inverse?.type === "fill.remove") {
    const fills = blobs.get<Fill[]>((inverse.params as { fills: string }).fills);
    const compiled = fills.filter((f) => target.isCompiled(f)).length;
    const formulaFills = fills.filter((f) => isFormula(f.template)).length;
    how =
      formulaFills === 0 ? "" : compiled === formulaFills ? " · compiled" : compiled === 0 ? " · interpreted" : ` · ${compiled}/${formulaFills} columns compiled`;
  }
  notify(`Filled ${rowFormat.format(rows)} rows${how}`);
}


document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "d") return;
  if (document.activeElement instanceof HTMLInputElement) return;
  e.preventDefault(); // otherwise the browser opens "bookmark this page"
  void fillDown();
});

function attachKernelReporting(s: EditableSource) {
  // Kernels run per 64K-row chunk as rows are needed, so report throughput
  // over the last second rather than one message per chunk.
  let rows = 0;
  let ms = 0;
  let timer = 0;
  s.onKernelRun = (run) => {
    rows += run.rows;
    ms += run.ms;
    const name = s.getColumnName(run.col) ?? columnLetter(run.col);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const perSec = ms > 0 ? (rows / ms) * 1000 : 0;
      setInfo(
        `${name}: compiled kernel computed ${rowFormat.format(rows)} rows in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` +
          (perSec ? ` (${rowFormat.format(Math.round(perSec / 1e6))}M rows/s)` : ""),
      );
      rows = 0;
      ms = 0;
    }, 150);
  };
}
attachKernelReporting(source);

grid.onCellEdit = async ({ row, col }, text) => {
  text = delocalizeFormula(text);
  // data validation: a value that breaks the cell's rule is stopped, or asked about
  const bad = invalidInputs(source, dvContext(workbook, source), [{ row, col, input: text }]);
  if (bad.length && !(await askAboutInvalid(bad[0].rule))) {
    grid.select(row, col);
    grid.focus();
    if ((bad[0].rule.errorStyle ?? "stop") !== "info") grid.startEditing(text); // try again, as Excel's Retry
    return;
  }
  writeCells([{ row, col, input: text }], `edit in ${columnLetter(col)}${row + 1}`);
};

// notes show when the pointer rests on a cell; Ctrl+click follows a link
grid.onCellHover = (cell, x, y) => showNoteTip(source, cell, x, y);
grid.onCellCtrlClick = (cell) => {
  const link = cellLink(source, cell.row, cell.col);
  if (!link) return false;
  followLink(link, workbook, activeId, (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  }, notify);
  return true;
};
async function editCellExtra(kind: "note" | "link") {
  const cell = { ...grid.selection };
  const current = source.extraAt(cell.row, cell.col)?.[kind] ?? "";
  const text = await editExtra(kind, current, `${columnLetter(cell.col)}${cell.row + 1}`);
  grid.focus();
  if (text !== null && text !== current) await run(extraAction(kind, cell, text));
}
// Excel: Shift+F2 edits the cell's note
document.addEventListener("keydown", (e) => {
  if (e.key === "F2" && e.shiftKey && !e.ctrlKey && !e.altKey && gridHasFocus()) {
    e.preventDefault();
    void editCellExtra("note");
  }
});

// list cells' dropdowns and tick boxes
const pickFromList = (cell: { row: number; col: number }, x: number, y: number) =>
  openDropdown(source, dvContext(workbook, source), cell, x, y, (v) => void grid.onCellEdit?.(cell, v), () => grid.focus());
const toggleTick = (cell: { row: number; col: number }) => {
  const on = source.getCell(cell.row, cell.col) === "TRUE";
  writeCells([{ row: cell.row, col: cell.col, input: on ? "FALSE" : "TRUE" }], on ? "untick" : "tick");
};
grid.onCellButton = (cell, kind, x, y) => (kind === "checkbox" ? toggleTick(cell) : pickFromList(cell, x, y));
document.addEventListener(
  "keydown",
  (e) => {
    if (!gridHasFocus() || grid.isEditing) return;
    const { row, col } = grid.selection;
    const rule = source.validationAt(row, col);
    if (!rule) return;
    if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && rule.kind === "checkbox") {
      e.preventDefault();
      e.stopPropagation();
      toggleTick({ row, col });
    } else if (e.altKey && e.key === "ArrowDown" && source.hasDropdown(row, col)) {
      e.preventDefault();
      e.stopPropagation();
      const r = grid.cellPageRect(row, col);
      pickFromList({ row, col }, r.x, r.y + r.height);
    }
  },
  true,
);

// Clearing goes cell by cell into the sparse edit map, so a whole 100M row
// column would mean 100M map entries. Cap it until there's a column-level op.
const MAX_BULK_CELLS = 1_000_000;

grid.onClearRange = (range) => {
  if (rangeSize(range) > MAX_BULK_CELLS) {
    notify(`Clearing more than ${rowFormat.format(MAX_BULK_CELLS)} cells at once isn't supported yet.`);
    return;
  }
  const cells: CellInput[] = [];
  for (let row = range.top; row <= range.bottom; row++) {
    for (let col = range.left; col <= range.right; col++) {
      if (source.getCell(row, col) !== null) cells.push({ row, col, input: null });
    }
  }
  writeCells(cells, "clear");
};

// --- clipboard ------------------------------------------------------------------
// Only handle copy/paste when the grid itself has focus, so the formula bar
// and cell editor keep normal text clipboard behaviour.

function gridHasFocus() {
  const el = document.activeElement;
  return el instanceof HTMLCanvasElement && sheet.contains(el);
}

function copySelection(e: ClipboardEvent): boolean {
  const range = grid.range;
  if (rangeSize(range) > MAX_BULK_CELLS) {
    notify(`Copying more than ${rowFormat.format(MAX_BULK_CELLS)} cells isn't supported yet.`);
    e.preventDefault();
    return false;
  }
  const text = rangeToTsv(source, range);
  e.clipboardData?.setData("text/plain", text);
  e.preventDefault();
  // remember it: pasting it back here moves formulas and keeps formats
  copied = { sheet: activeId, range, text };
  return true;
}

/** The last range copied in this tab, so a paste of it can be a real copy. */
let copied: { sheet: string; range: CellRange; text: string } | null = null;

/** "all" pastes formulas and formats from cellforge; "values" pastes results only. */
type PasteMode = "all" | "values";
let defaultPaste: PasteMode = (() => {
  try {
    return localStorage.getItem("cellforge.pasteMode") === "values" ? "values" : "all";
  } catch {
    return "all";
  }
})();
function setDefaultPaste(mode: PasteMode) {
  defaultPaste = mode;
  try {
    localStorage.setItem("cellforge.pasteMode", mode);
  } catch {
    // private mode: the setting lasts for this tab
  }
}

/** Ctrl+Shift+V pastes values only (the paste event can't tell, so remember the keys). */
let pasteValuesNext = false;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") pasteValuesNext = true;
});

async function pasteCopied(mode: "all" | "values" | "formulas" | "formats") {
  if (!copied || !workbook.has(copied.sheet)) return false;
  const { row, col } = grid.selection;
  const r = copied.range;
  const ok = await run({ type: "cells.paste", params: { from: r, fromSheet: copied.sheet, to: { row, col }, mode } });
  if (ok) {
    grid.selectRange({
      top: row,
      left: col,
      bottom: Math.min(source.rowCount - 1, row + r.bottom - r.top),
      right: Math.min(source.colCount - 1, col + r.right - r.left),
    });
  }
  return true;
}

document.addEventListener("copy", (e) => {
  if (gridHasFocus()) copySelection(e);
});

document.addEventListener("cut", (e) => {
  if (gridHasFocus() && copySelection(e)) grid.onClearRange?.(grid.range);
});

document.addEventListener("paste", (e) => {
  if (!gridHasFocus()) return;
  const text = e.clipboardData?.getData("text/plain");
  const valuesOnly = pasteValuesNext || defaultPaste === "values";
  pasteValuesNext = false;
  if (!text) return;
  e.preventDefault();
  // our own copy: paste it properly (formulas moved, formats kept)
  if (copied && text.replace(/\r?\n$/, "") === copied.text) {
    void pasteCopied(valuesOnly ? "values" : "all");
    return;
  }

  const rows = parseTsv(text.replace(/\r?\n$/, "")); // Excel adds a trailing newline
  const { row: top, col: left } = grid.selection;
  const cells: CellInput[] = [];
  let right = left;
  for (let i = 0; i < rows.length && top + i < source.rowCount; i++) {
    for (let j = 0; j < rows[i].length && left + j < source.colCount; j++) {
      cells.push({ row: top + i, col: left + j, input: rows[i][j] });
      right = Math.max(right, left + j);
    }
  }
  writeCells(cells, "paste");
  // select what was pasted so it's obvious where it went
  grid.selectRange({
    top,
    left,
    bottom: Math.min(source.rowCount - 1, top + rows.length - 1),
    right,
  });
});

// formula bar: enter commits to the active cell, escape throws the edit away
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    grid.onCellEdit?.(grid.selection, formulaInput.value);
    grid.focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    syncFormulaBar();
    grid.focus();
  }
});

// mirror what's being typed in the cell editor into the formula bar
sheet.addEventListener("input", (e) => {
  if (e.target instanceof HTMLInputElement) formulaInput.value = e.target.value;
});

function workbookEdited() {
  return workbook.sheets.length > 1 || workbook.sheets.some((x) => x.source.editCount > 0);
}

const tabs = new SheetTabs(document.getElementById("sheet-tabs")!, {
  workbook: () => workbook,
  active: () => activeId,
  switchTo: (id) => {
    showSheet(id);
    grid.focus();
  },
  run: (action) => run(action),
});
tabs.render();

// Ctrl+PgUp / Ctrl+PgDn: previous / next sheet (capture, before the grid's own PgUp/PgDn)
document.addEventListener(
  "keydown",
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || (e.key !== "PageUp" && e.key !== "PageDown")) return;
    if (document.activeElement instanceof HTMLInputElement && !sheet.contains(document.activeElement)) return;
    e.preventDefault();
    e.stopPropagation();
    const visible = workbook.visible;
    const i = visible.findIndex((x) => x.id === activeId);
    const next = visible[(i + (e.key === "PageDown" ? 1 : -1) + visible.length) % visible.length];
    showSheet(next.id);
    grid.focus();
  },
  true,
);

// --- inserting and deleting rows -----------------------------------------------

function selectedCols() {
  const r = grid.range;
  return { left: r.left, count: r.right - r.left + 1 };
}

async function insertCols(right: boolean) {
  const { left, count } = selectedCols();
  const at = right ? left + count : left;
  grid.spliceColumns(at, 0, count); // move widths before the data moves
  if (await run({ type: "cols.insert", params: { at, count } })) {
    grid.selectRange({ top: grid.range.top, left: at, bottom: grid.range.bottom, right: at + count - 1 });
  } else {
    grid.spliceColumns(at, count, 0);
  }
}

async function deleteCols() {
  const { left, count } = selectedCols();
  const top = grid.range.top;
  grid.spliceColumns(left, count, 0); // move widths with the data
  if (await run({ type: "cols.delete", params: { at: left, count } })) {
    const col = Math.min(left, source.colCount - 1);
    grid.selectRange({ top, left: col, bottom: top, right: col });
  } else {
    grid.spliceColumns(left, 0, count);
  }
}

function selectedRows() {
  const r = grid.range;
  return { top: r.top, count: r.bottom - r.top + 1 };
}

async function insertRows(below: boolean) {
  const { top, count } = selectedRows();
  const at = below ? top + count : top;
  if (await run({ type: "rows.insert", params: { at, count } })) {
    grid.selectRange({ top: at, left: grid.range.left, bottom: at + count - 1, right: grid.range.right });
  }
}

async function deleteRows() {
  const { top, count } = selectedRows();
  if (await run({ type: "rows.delete", params: { at: top, count } })) {
    const row = Math.min(top, source.rowCount - 1);
    grid.selectRange({ top: row, left: grid.range.left, bottom: row, right: grid.range.left });
  }
}

/** Hide the selected rows or columns, or show the hidden ones inside the selection. */
async function hideRows(hidden: boolean) {
  const { top, count } = selectedRows();
  if (hidden && count >= source.rowCount) {
    notify("At least one row has to stay visible.");
    return;
  }
  await run({ type: "rows.hide", params: { at: top, count, hidden } });
}

async function hideCols(hidden: boolean) {
  const { left, count } = selectedCols();
  await run({ type: "cols.hide", params: { at: left, count, hidden } });
}

// Excel: Ctrl+9 hides rows, Ctrl+Shift+9 shows them, Ctrl+0 hides columns,
// Ctrl+Shift+0 shows them (by code, so Shift doesn't turn 9 into "(").
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !gridHasFocus()) return;
  if (e.code === "Digit9") {
    e.preventDefault();
    void hideRows(!e.shiftKey);
  } else if (e.code === "Digit0") {
    e.preventDefault();
    void hideCols(!e.shiftKey);
  }
});

// Excel's Ctrl++ / Ctrl+- insert rows above the selection and delete them.
// Browsers may keep Ctrl+- for page zoom, so Google Sheets' Ctrl+Alt+= /
// Ctrl+Alt+- work too.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !gridHasFocus()) return;
  if (e.key === "+" || (e.key === "=" && (e.shiftKey || e.altKey))) {
    e.preventDefault();
    void insertRows(false);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    void deleteRows();
  }
});

/** Fit the selected rows to their contents (one undo step). */
async function fitRows() {
  const { top, count } = selectedRows();
  const rows = Math.min(count, 5000); // measuring is per row; keep it quick
  const heights: (number | null)[] = [];
  for (let r = top; r < top + rows; r++) {
    const h = grid.fitRowHeight(r);
    heights.push(h === grid.defaultRowHeight ? null : h);
  }
  await run({ type: "rows.height", params: { at: top, heights } });
}

let cellMenu: HTMLElement | null = null;
function closeCellMenu() {
  cellMenu?.remove();
  cellMenu = null;
}
document.addEventListener("pointerdown", (e) => {
  if (cellMenu && !cellMenu.contains(e.target as Node)) closeCellMenu();
});
sheet.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  closeCellMenu();
  const kind = grid.selectForMenu(e.clientX, e.clientY);
  if (!kind) return;
  const { count } = selectedRows();
  const rows = count === 1 ? "row" : `${count.toLocaleString()} rows`;
  const nCols = selectedCols().count;
  const cols = nCols === 1 ? "column" : `${nCols} columns`;
  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.setAttribute("role", "menu");
  const item = (label: string, keys: string, act: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu-item";
    b.setAttribute("role", "menuitem");
    b.innerHTML = `<span>${label}</span><kbd>${keys}</kbd>`;
    b.addEventListener("click", () => {
      closeCellMenu();
      act();
      grid.focus();
    });
    menu.append(b);
  };
  // a row header shows only row actions, a column header only column ones
  if (kind !== "cols") {
    item(`Insert ${rows} above`, "Ctrl Alt =", () => void insertRows(false));
    item(`Insert ${rows} below`, "", () => void insertRows(true));
    item(`Delete ${rows}`, "Ctrl Alt −", () => void deleteRows());
    item(`Hide ${rows}`, "Ctrl 9", () => void hideRows(true));
    item("Unhide rows", "Ctrl Shift 9", () => void hideRows(false));
    item(`Fit ${count === 1 ? "row height" : "row heights"}`, "", () => void fitRows());
  }
  const sep = () => {
    const d = document.createElement("div");
    d.className = "menu-sep";
    menu.append(d);
  };
  if (kind === "cell") sep();
  if (kind !== "rows") {
    item(`Insert ${cols} left`, "", () => void insertCols(false));
    item(`Insert ${cols} right`, "", () => void insertCols(true));
    item(`Delete ${cols}`, "", () => void deleteCols());
    item(`Hide ${cols}`, "Ctrl 0", () => void hideCols(true));
    item("Unhide columns", "Ctrl Shift 0", () => void hideCols(false));
  }
  // paste options, for a range copied in cellforge
  if (kind === "cell" && copied && workbook.has(copied.sheet)) {
    sep();
    item("Paste", "Ctrl V", () => void pasteCopied("all"));
    item("Paste values only", "Ctrl Shift V", () => void pasteCopied("values"));
    item("Paste formulas only", "", () => void pasteCopied("formulas"));
    item("Paste formats only", "", () => void pasteCopied("formats"));
    item(defaultPaste === "values" ? "Ctrl V pastes: values only ✓ (switch to everything)" : "Ctrl V pastes: everything ✓ (switch to values only)", "", () =>
      setDefaultPaste(defaultPaste === "values" ? "all" : "values"),
    );
  }
  if (kind === "cell") {
    sep();
    item("Inspect this cell", "Ctrl [", () => inspectPanel.toggle());
    item("Make a table", "Ctrl T", () => void namesUi.makeTable());
    item("Define a name…", "", () => namesUi.defineName());
    item("Names and tables…", "Ctrl F3", () => namesUi.manager());
  }
  // merging, for a selection of more than one cell
  const sel = grid.range;
  const touchesMerge = source.getMerges().some((m) => m.top <= sel.bottom && sel.top <= m.bottom && m.left <= sel.right && sel.left <= m.right);
  if (kind === "cell" && (sel.top !== sel.bottom || sel.left !== sel.right)) {
    sep();
    if (touchesMerge) item("Unmerge cells", "", () => void run({ type: "cells.unmerge", params: { range: sel } }));
    item("Merge cells", "", () => void run({ type: "cells.merge", params: { range: sel } }));
    item("Merge and centre", "", () => void run({ type: "cells.merge", params: { range: sel, center: true } }));
    if (sel.bottom > sel.top) item("Merge across", "", () => void run({ type: "cells.merge", params: { range: sel, across: true } }));
    if (sel.right > sel.left) item("Centre across selection (no merge)", "", () => void run({ type: "format.set", params: { range: sel, style: { align: "centerAcross" } } }));
  }
  // freeze panes, as in Excel: rows above and columns left of the active cell
  sep();
  const { row: ar, col: acol } = grid.selection;
  const frozen = source.frozen.rows > 0 || source.frozen.cols > 0;
  if (frozen) item("Unfreeze panes", "", () => void run({ type: "view.freeze", params: { rows: 0, cols: 0 } }));
  if (kind === "cell" && (ar > 0 || acol > 0)) {
    item(`Freeze above row ${ar + 1}${acol > 0 ? ` and left of ${columnLetter(acol)}` : ""}`, "", () => void run({ type: "view.freeze", params: { rows: ar, cols: acol } }));
  }
  if (kind !== "cols") item("Freeze top row", "", () => void run({ type: "view.freeze", params: { rows: 1, cols: 0 } }));
  if (kind !== "rows") item("Freeze first column", "", () => void run({ type: "view.freeze", params: { rows: 0, cols: 1 } }));
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  cellMenu = menu;
});

fileName.textContent = currentName;
statusRight.textContent = infoText;
syncFormulaBar();
updateStatus();
grid.focus();

// --- saving -------------------------------------------------------------------
// Autosave: every change goes into a journal in the browser's private file
// system (OPFS) as it happens, with a full snapshot now and then. After a
// crash or a closed tab, the next start loads the snapshot and replays the
// journal. Save / Open write and read one .cellforge file.

const saveState = document.getElementById("save-state")!;
let saver: AutoSaver | null = null;
let replaying = false;
// how many journal entries an undo / redo can still be expressed against;
// past that (undoing something from before the last snapshot) we snapshot
let journalRuns = 0;
let journalUndone = 0;
let snapshotTimer = 0;

/** The save state beside the file name: only claims "saved" once there is something saved. */
function showSaved(text: string) {
  const state = text === "saved" ? "saved" : text === "saving…" ? "saving" : /not saved|off|unavailable/.test(text) ? "warn" : "info";
  if (state === "saved" && currentName === "Untitled" && !workbookEdited()) {
    saveState.replaceChildren();
    delete saveState.dataset.state;
    return;
  }
  saveState.dataset.state = state;
  const label = state === "saved" ? "Saved on this computer" : state === "saving" ? "Saving…" : text.charAt(0).toUpperCase() + text.slice(1);
  saveState.replaceChildren(icon(state === "saved" ? "check" : state === "warn" ? "warning" : "history", { size: 14 }), label);
  saveState.title = state === "warn" ? "Changes in this tab aren't being kept in the browser" : "Every change is kept in this browser as you work. Save (Ctrl+S) writes a .cellforge file.";
}

async function snapshotNow() {
  if (!saver) return;
  window.clearTimeout(snapshotTimer);
  showSaved("saving…");
  try {
    await saver.snapshot(workbook, activeId, currentName);
    journalRuns = 0;
    journalUndone = 0;
    showSaved("saved");
  } catch (e) {
    showSaved("not saved");
    notify(`Autosave failed: ${(e as Error).message}`);
  }
}

function journal(entry: JournalEntry) {
  if (!saver || replaying) return;
  if (entry.op === "run") {
    journalRuns++;
    journalUndone = 0;
  } else if (entry.op === "undo") {
    if (journalRuns === 0) return void snapshotNow();
    journalRuns--;
    journalUndone++;
  } else {
    if (journalUndone === 0) return void snapshotNow();
    journalUndone--;
    journalRuns++;
  }
  showSaved("saving…");
  saver.record(entry).then(
    () => showSaved("saved"),
    (e) => {
      showSaved("not saved");
      notify(`Autosave failed: ${(e as Error).message}`);
    },
  );
  // compact now and then: a snapshot after a quiet spell or many changes
  window.clearTimeout(snapshotTimer);
  if (saver.pending >= 200) void snapshotNow();
  else snapshotTimer = window.setTimeout(() => void snapshotNow(), 20_000);
}

/** Start autosave; bring back the last session unless a demo was asked for. */
async function startAutosave() {
  // one tab owns the autosave; others still work, they just don't save
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks) {
    const got = await new Promise<boolean>((resolve) => {
      void locks.request("cellforge-autosave", { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        return lock ? new Promise<void>(() => undefined) : undefined; // hold it for the page's life
      });
    });
    if (!got) {
      showSaved("autosave is on in another tab");
      return;
    }
  }
  const store = await OpfsStore.open();
  if (!store) {
    showSaved("autosave unavailable");
    return;
  }
  saver = new AutoSaver(store);
  if (startWithDemo || startSample) return void snapshotNow();
  try {
    const last = await AutoSaver.load(store);
    if (!last) return void snapshotNow();
    loadWorkbook(last.workbook, last.active, last.name);
    replaying = true;
    for (const e of last.journal) {
      if (e.op === "run") await history.run(e.action);
      else if (e.op === "undo") await history.undo();
      else await history.redo();
    }
    replaying = false;
    refresh();
    notify("Picked up where you left off.");
    void snapshotNow();
  } catch (e) {
    replaying = false;
    // don't overwrite what's there: it may be recoverable by a later version
    saver = null;
    showSaved("autosave off");
    notify(`Couldn't restore the last session (${(e as Error).message}); autosave is off for this tab.`);
  }
}

void startAutosave().then(() => {
  if (!startWithDemo && !startSample && isEmptyWorkbook()) startScreen.show();
});
// a sample from the landing page's links (the big one is the demo, above)
if (startSample && startSample !== "big") {
  void sampleWorkbook(startSample).then((s) => {
    loadWorkbook(s.workbook, s.active, s.name);
    void snapshotNow();
    notify("Sample data (fictional): read \"Start here\" first.");
  });
}

// Save / Save as: one .cellforge file, via the File System Access API where
// the browser has it (so Ctrl+S saves in place), a download otherwise
let fileHandle: FileSystemFileHandle | null = null;
type SavePicker = (opts: unknown) => Promise<FileSystemFileHandle>;

async function saveFile(saveAs = false) {
  const name = `${currentName.replace(/\.(csv|tsv|txt|cellforge)$/i, "") || "workbook"}.cellforge`;
  let blob: Blob;
  try {
    blob = toFile(packWorkbook(workbook, activeId, currentName));
  } catch (e) {
    notify(`Couldn't save: ${(e as Error).message}`);
    return;
  }
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (!picker) {
    download(blob, name);
    notify(`Downloaded ${name}`);
    return;
  }
  try {
    if (!fileHandle || saveAs) {
      fileHandle = await picker({
        suggestedName: name,
        types: [{ description: "cellforge workbook", accept: { "application/x-cellforge": [".cellforge"] } }],
      });
    }
    const w = await fileHandle.createWritable();
    await w.write(blob);
    await w.close();
    notify(`Saved ${fileHandle.name}`);
  } catch (e) {
    if ((e as DOMException).name !== "AbortError") notify(`Couldn't save: ${(e as Error).message}`);
  }
}


async function exportExcel() {
  try {
    notify("Writing the Excel file…");
    const blob = await saveXlsx(workbook);
    const name = `${currentName.replace(/\.(csv|tsv|txt|cellforge|xlsx|xlsm)$/i, "") || "workbook"}.xlsx`;
    download(blob, name);
    notify(`Downloaded ${name}`);
  } catch (e) {
    notify(`Couldn't export: ${(e as Error).message}`);
  }
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "s") {
    e.preventDefault();
    void saveFile(e.shiftKey);
  } else if (k === "o" && !e.shiftKey) {
    e.preventDefault();
    openFilePicker();
  }
});

// --- history panel ------------------------------------------------------------

// what was typed into each cell this session, by row identity so it follows sorts
const trail = new Map<string, TrailEntry[]>();
function recordTrail(action: Action) {
  if (action.type !== "cells.set") return;
  const p = action.params as { cells: { row: number; col: number; input: string | null }[]; sheet?: string };
  const sheetId = p.sheet ?? activeId;
  if (!workbook.has(sheetId)) return;
  const src = workbook.get(sheetId).source;
  const at = Date.now();
  for (const c of p.cells.slice(0, 500)) {
    const key = `${sheetId}:${src.toBase(c.row)}:${c.col}`;
    const list = trail.get(key) ?? [];
    list.push({ at, text: c.input ?? "" });
    if (list.length > 50) list.shift();
    trail.set(key, list);
  }
}

const historyPanel = setupHistoryPanel({
  root: document.getElementById("history-panel")!,
  workbook: () => workbook,
  activeSheet: () => activeId,
  selection: () => grid.selection,
  timeline: () => history.timeline,
  undo,
  redo,
  run: (a) => run(a),
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  trail: (sheetId, rowId, col) => trail.get(`${sheetId}:${rowId}:${col}`) ?? [],
});

const inspectPanel = setupInspectPanel({
  root: document.getElementById("inspect-panel")!,
  workbook: () => workbook,
  activeSheet: () => activeId,
  selection: () => grid.selection,
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  highlight: (list) => grid.setHighlights(list),
  onOpen: () => {
    if (historyPanel.open) historyPanel.toggle();
  },
});

// Ctrl+[ inspects the cell (Excel's "go to precedents" key)
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "[") {
    e.preventDefault();
    inspectPanel.toggle();
  }
});
// Excel: Ctrl+T makes a table, Ctrl+F3 opens the name manager
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !gridHasFocus()) return;
  if (e.key.toLowerCase() === "t" && !e.shiftKey) {
    e.preventDefault();
    void namesUi.makeTable();
  } else if (e.key === "F3") {
    e.preventDefault();
    namesUi.manager();
  }
});
// Excel: Ctrl+Shift+L turns the filter on or off, Ctrl+Alt+L reapplies it, Alt+Down opens a column's filter
document.addEventListener("keydown", (e) => {
  if (!gridHasFocus()) return;
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    toggleFilterButtons();
  } else if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    void run({ type: "filter.reapply", params: {} });
  } else if (e.altKey && e.key === "ArrowDown" && (source.filter || filterButtonsOn.has(activeId))) {
    e.preventDefault();
    filterActiveColumn();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
    e.preventDefault();
    historyPanel.toggle();
  }
});

// --- names and tables -----------------------------------------------------------
const namesUi = setupNamesUi({
  workbook: () => workbook,
  sheetName: () => workbook.get(activeId).name,
  range: () => grid.range,
  run: (a) => run(a),
  focusGrid: () => grid.focus(),
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
});

// --- command palette (Ctrl+K) -------------------------------------------------

const palette = setupPalette({
  commands: () => commands(),
  catalog: () => registry.catalog(),
  run: (a) => run(a),
  range: () => grid.range,
  focusGrid: () => grid.focus(),
  suggested: () => suggestedCommandIds(sheetContext(workbook, source)),
  askAi: (text) => askBar.open(text),
  dev: () => devMode(),
  groups: COMMAND_GROUPS,
});

// the ask bar (Ctrl+/): plain-English requests turned into actions; requests it doesn't know go to the local AI when one is loaded
const askBar = setupAskBar({
  catalog: () => registry.catalog(),
  context: () => askContext(workbook, activeId, grid.range),
  run: (a) => run(a),
  commands: () => commands(),
  focusGrid: () => grid.focus(),
  // the local model, when one is loaded; one kept from last time loads in the background on first use
  model: () => currentModel(),
  ai: { status: aiStatus, subscribe: (cb) => onAiStatus(() => cb()), setup: () => openAiPanel(aiPanelDeps()) },
});

/** What the AI panel needs from the app (also for the shell's "Ask AI" button). */
function aiPanelDeps(): AiPanelDeps {
  return {
    askBar: (text) => askBar.open(text),
    commands: () => commands(),
    askGuide: (q) => openAskGuide(() => commands(), () => grid.focus(), q),
    focusGrid: () => grid.focus(),
  };
}

// --- the shell: commands, menus, top bar, rail, start screen -------------------

async function saveProtected() {
  const password = await askPassword("Password for the copy", true);
  if (!password) return grid.focus();
  notify("Encrypting…");
  const book = toFile(packWorkbook(workbook, activeId, currentName));
  const locked = await encryptFile(new Uint8Array(await book.arrayBuffer()), password);
  download(new Blob([locked as BlobPart], { type: "application/octet-stream" }), `${currentName} (protected).cellforge`);
  notify("Saved a password-protected copy. Open it in cellforge with the password.");
  grid.focus();
}

async function clearLocal() {
  if (!(await confirmClear())) return grid.focus();
  const n = (await clearLocalData(saver?.store ?? (await OpfsStore.open()))) + (await clearLocalData(docStore));
  notify(`Cleared ${n} stored item${n === 1 ? "" : "s"}. Reload the page to start fresh.`);
}

// --- theme: View > Theme (system, light, dark); the grid and charts repaint
const THEME_KEY = "cellforge.theme";
function currentTheme(): ThemeChoice {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}
function setTheme(t: ThemeChoice) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {
    // remembered for this tab only
  }
  // the canvas reads its colours once; charts redraw from the CSS variables
  requestAnimationFrame(() => {
    grid.refreshTheme();
    refreshCharts();
  });
}

/** Every shortcut, grouped, from the registry (Help > Keyboard shortcuts). */
function showShortcuts() {
  const extra: [string, string][] = [
    ["Search commands and tools", "Ctrl K"],
    ["Focus the menu bar", "Alt or F10"],
    ["Next / previous sheet", "Ctrl PgDn / PgUp"],
    ["Paste values only", "Ctrl Shift V"],
    ["Open a list cell's dropdown", "Alt ↓"],
    ["Edit the cell", "F2"],
  ];
  const body = document.createElement("div");
  body.className = "cf-shortcuts";
  const groups = new Map<string, [string, string][]>();
  groups.set("General", extra);
  for (const c of commands()) {
    if (!c.keys) continue;
    const list = groups.get(c.group) ?? [];
    if (!list.some(([, k]) => k === c.keys)) list.push([c.title.replace(/…$/, ""), c.keys]);
    groups.set(c.group, list);
  }
  for (const [g, list] of groups) {
    const sec = document.createElement("section");
    const h = document.createElement("h3");
    h.textContent = g;
    sec.append(h);
    for (const [t, k] of list) {
      const row = document.createElement("div");
      row.className = "cf-shortcuts__row";
      const span = document.createElement("span");
      span.textContent = t;
      const kbd = document.createElement("kbd");
      kbd.textContent = k;
      row.append(span, kbd);
      sec.append(row);
    }
    body.append(sec);
  }
  openDialog({ title: "Keyboard shortcuts", subtitle: "The ones Excel users expect work here too", size: "lg", body, actions: [{ label: "Close", kind: "primary", dismiss: true }] });
}

const commandDeps: CommandDeps = {
  workbook: () => workbook,
  activeSheet: () => activeId,
  source: () => source,
  grid,
  registry: registry as unknown as ActionRegistry<unknown>,
  recorder,
  run: (a) => run(a),
  putBlob: (v) => blobs.put(v),
  status: notify,
  focusGrid: () => grid.focus(),
  goTo: (sheetId, row, col) => {
    showSheet(sheetId);
    grid.select(row, col);
    grid.focus();
  },
  showSheet: (id) => showSheet(id),
  undo,
  redo,
  canUndo: () => history.canUndo,
  canRedo: () => history.canRedo,
  newWorkbook: () => void newWorkbook(),
  showStartScreen: () => startScreen.show(),
  openFile: () => openFilePicker(),
  saveFile: (saveAs) => saveFile(saveAs),
  exportExcel: async () => void (await gateExport(() => exportExcel())),
  exportCsv: async () => void (await gateExport(exportCsvFile)),
  saveProtected,
  clearLocal,
  startTemplate: () => startTemplate(),
  openSample: (kind) => void openSample(kind),
  saveEvidencePack: () => void logQueue.then(() => saveEvidencePack(workbook, workbook.get(activeId).name, notify, docBytes())),
  fillDown,
  sortBy,
  pasteCopied,
  insertRows,
  deleteRows,
  insertCols,
  deleteCols,
  hideRows,
  hideCols,
  fitRows,
  editCellExtra,
  filterShowing: () => !!source.filter || filterButtonsOn.has(activeId),
  toggleFilterButtons,
  filterActiveColumn,
  toggleHistory: () => historyPanel.toggle(),
  historyOpen: () => historyPanel.open,
  toggleInspect: () => inspectPanel.toggle(),
  names: namesUi,
  askBar: (text) => askBar.open(text),
  openAi: () => openAiPanel(aiPanelDeps()),
  aiModelKiln: () => currentModel(),
  showShortcuts,
  theme: currentTheme,
  setTheme,
  localeChanged: () => {
    grid.invalidate();
    syncFormulaBar();
  },
  railCollapsed: () => rail.collapsed(),
  toggleRail: () => rail.toggle(),
  statementDeps,
  findDeps,
  lineageDeps,
  docDeps,
  recipeFilesDeps,
  dvDeps,
  cfDeps,
  filterDeps,
  chartDeps,
};

/** The command registry for the state the app is in now (palette, menus, rail, ask bar). */
function commands(): AppCommand[] {
  return buildCommands(commandDeps);
}

// menu bar
const menubar = setupMenuBar(document.getElementById("menubar")!, { commands, focusGrid: () => grid.focus() });
void menubar;

// top bar
{
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
  undoButton.append(icon("undo"));
  redoButton.append(icon("redo"));
  const search = btn("btn-search");
  search.prepend(icon("search"));
  search.addEventListener("click", () => palette.open());
  const open = btn("btn-open");
  open.prepend(icon("open"));
  open.addEventListener("click", () => openFilePicker());
  // Save and Share are menus of registry commands
  const pick = (ids: (string | null)[]) => () => {
    const byId = new Map(commands().map((c) => [c.id, c]));
    const list: AppCommand[] = [];
    let section = 0;
    for (const id of ids) {
      if (id === null) section++;
      else if (byId.has(id)) list.push({ ...byId.get(id)!, section: String(section), submenu: undefined });
    }
    return menuEntries(list);
  };
  const save = btn("btn-save");
  save.prepend(icon("save"));
  save.append(icon("chevron-down", { className: "topbar__caret" }));
  menuButton(save, pick(["save", "save-as", null, "export-xlsx", "export", null, "save-protected"]));
  const share = btn("btn-share");
  share.prepend(icon("share"));
  share.append(icon("chevron-down", { className: "topbar__caret" }));
  menuButton(share, pick(["share-check", "je-pii", null, "save-protected", "evidence-pack", null, "export-xlsx"]));
  const help = btn("btn-help");
  help.append(icon("help"));
  menuButton(help, () => buildMenuModel(commands()).find((m) => m.name === "Help")!.items);

  // Ask AI, with the local model's status (aipanel.ts)
  const ai = btn("btn-ai");
  ai.prepend(icon("ai"));
  const dot = ai.querySelector<HTMLElement>(".ai-dot")!;
  const chip = ai.querySelector<HTMLElement>(".ai-chip")!;
  ai.addEventListener("click", () => toggleAiPanel(aiPanelDeps()));
  const paint = () => {
    const b = aiBadge();
    dot.dataset.state = b.dot;
    chip.textContent = b.text;
    chip.hidden = !b.text;
    ai.title = `${b.title} (Ctrl+/ to ask)`;
    ai.setAttribute("aria-label", `Ask AI. ${b.title}`);
  };
  onAiStatus(paint);
  paint();
  watchAiToasts();
  onSidePanelChange((id) => ai.classList.toggle("is-active", id === AI_PANEL_ID));
}

// the rail: one button per job, each opening a hub in the side panel
const rail = setupRail(document.getElementById("rail")!, {
  commands,
  context: () => sheetContext(workbook, source),
  openAi: () => toggleAiPanel(aiPanelDeps()),
  aiPanelId: AI_PANEL_ID,
  decorateAi: (b) => {
    const dot = b.querySelector<HTMLElement>(".ai-dot")!;
    const paint = () => {
      const s = aiBadge();
      dot.dataset.state = s.dot;
      b.title = `AI · ${s.title}`;
    };
    onAiStatus(paint);
    paint();
  },
});

/** Nothing in the workbook yet (one sheet, nothing typed or loaded). */
function isEmptyWorkbook() {
  return workbook.sheets.length === 1 && sheetIsBlank(workbook.sheets[0].source);
}

// the start screen: for a new or empty workbook, instead of a blank grid
const startHost = document.createElement("section");
sheet.append(startHost); // over the grid only: the rail and the side panel stay usable
const startScreen = setupStartScreen(startHost, {
  openFile: () => openFilePicker(),
  importStatement: () => void pickStatement().then((f) => f && importStatement(f, statementDeps())),
  openSample: (kind) => void openSample(kind),
  startTemplate: (kind) => void startTemplate(kind),
  blank: () => {
    if (isEmptyWorkbook()) {
      startScreen.hide();
      grid.focus();
    } else void newWorkbook().then((ok) => ok && startScreen.hide());
  },
  dismiss: () => {
    startScreen.hide();
    grid.focus();
  },
  openAi: () => openAiPanel(aiPanelDeps()),
  aiBadge,
  onAiStatus: (cb) => onAiStatus(() => cb()),
});

function loadSource(next: EditableSource, name: string) {
  const wb = new Workbook({ name: sheetNameFrom(name), source: next });
  if (/.w+$/.test(name)) wb.sheets[0].origin = `Imported from ${name}`;
  loadWorkbook(wb, wb.sheets[0].id, name);
  void snapshotNow();
}

/** Replace the whole workbook (open, new, restore). */
/** The file being opened, fingerprinted into the workbook it becomes. */
let openingFile: File | null = null;

function loadWorkbook(next: Workbook, active: string, name: string) {
  trail.clear();
  workbook = next;
  recorder.clear();
  if (openingFile) {
    noteInput(openingFile, "open");
    openingFile = null;
  }
  activeId = active;
  selections.clear();
  source = workbook.get(active).source;
  currentName = name;
  attachKernelReporting(source);
  cancelSort?.();
  history.clear();
  blobs.clear();
  grid.setSource(source);
  fileName.textContent = name;
  document.title = name === "Untitled" ? "cellforge" : `${name} · cellforge`;
  startScreen.hide();
  refresh();
  grid.focus();
}

/** Start over: a blank workbook (asks first when there's work to lose). */
async function newWorkbook(): Promise<boolean> {
  if (workbookEdited() && !(await confirmDialog({ title: "Start a new workbook?", text: "Your changes to this workbook will be discarded.", confirm: "Discard and start new", danger: true }))) return false;
  fileHandle = null;
  loadSource(new EditableSource(new BlankSource()), "Untitled");
  return true;
}

/** Open one of the finance samples (samples.ts). */
async function openSample(kind: SampleKind) {
  if (workbookEdited() && !(await confirmDialog({ title: "Open the sample?", text: "Your changes to this workbook will be discarded.", confirm: "Discard and open sample", danger: true }))) return;
  notify("Opening the sample…");
  const s = await sampleWorkbook(kind);
  fileHandle = null;
  loadWorkbook(s.workbook, s.active, s.name);
  void snapshotNow();
  notify(kind === "big" ? "Opened 100 million lines of a fictional general ledger. Scroll, sort or pivot it." : 'Sample data (fictional) opened: read "Start here" first.');
}

/** Start from a template (empty workbook laid out for the job). */
async function startTemplate(kind?: TemplateKind) {
  const k = kind ?? (await pickTemplate());
  if (!k) return grid.focus();
  if (workbookEdited() && !(await confirmDialog({ title: "Start from the template?", text: "Your changes to this workbook will be discarded.", confirm: "Discard and start", danger: true }))) return;
  notify("Building the template…");
  const wb = await buildTemplate(k);
  fileHandle = null;
  loadWorkbook(wb, wb.sheets[0].id, TEMPLATES.find((t) => t.kind === k)!.title);
  void snapshotNow();
  notify('Started from the template: read "Start here" first.');
}

// --- CSV export ---------------------------------------------------------------

// Above this we warn first: the 100M demo would be several GB of CSV.
const LARGE_EXPORT_ROWS = 5_000_000;
let exporting = false;

async function exportCsvFile() {
  if (exporting) return;
  const { rows, cols } = source.usedRange();
  if (rows === 0 || cols === 0) {
    notify("Nothing to export yet — the sheet is empty.");
    return;
  }
  if (
    rows > LARGE_EXPORT_ROWS &&
    !(await confirmDialog({ title: "Export a very large CSV?", text: `This will build a CSV with ${rowFormat.format(rows)} rows, which can take a while and a lot of memory.`, confirm: "Export" }))
  ) {
    return;
  }

  exporting = true;
  // blank sheets have no header row; imported/demo data has column names
  const includeHeader = source.getColumnName(0) !== undefined;
  try {
    const blob = await exportCsv(source, rows, cols, includeHeader, (done) => {
      notify(`Exporting… ${Math.round((done / rows) * 100)}%`);
    });
    const base = currentName.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^\w.-]+/g, "_");
    download(blob, `${base || "sheet"}.csv`);
    notify(`Exported ${formatBytes(blob.size)}`);
  } finally {
    exporting = false;
    updateStatus();
  }
}

// --- CSV import ---------------------------------------------------------------

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".cellforge,.xlsx,.xlsm,.pdf,.csv,.tsv,.txt,.json,.jsonl,.ndjson,.parquet,text/csv,text/tab-separated-values";
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) openFile(file);
  fileInput.value = ""; // so picking the same file again still fires change
});
function openFilePicker() {
  fileInput.click();
}

let cancelImport: (() => void) | null = null;

async function openFile(file: File) {
  // fingerprinted into the workbook it becomes (see loadWorkbook); forgotten if it never loads
  openingFile = file;
  try {
    await openFileInto(file);
  } finally {
    openingFile = null;
  }
}

async function openFileInto(file: File) {
  cancelImport?.();
  if (/\.pdf$/i.test(file.name)) {
    // a PDF is read as a bank statement; its transactions go on a new sheet
    await importStatement(file, statementDeps());
    return;
  }
  if (/\.xls[xm]$/i.test(file.name)) {
    try {
      notify(`Opening ${file.name}…`);
      const wb = await openXlsx(await file.arrayBuffer());
      for (const s of wb.sheets) s.origin ??= `Imported from ${file.name}, sheet "${s.name}"`;
      fileHandle = null;
      loadWorkbook(wb, (wb.visible[0] ?? wb.sheets[0]).id, file.name.replace(/\.xls[xm]$/i, ""));
      void snapshotNow();
      notify(`Opened ${file.name}: ${wb.sheets.length} sheet${wb.sheets.length === 1 ? "" : "s"}`);
    } catch (e) {
      notify(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
    return;
  }
  if (/\.cellforge$/i.test(file.name)) {
    try {
      notify(`Opening ${file.name}…`);
      let raw: Uint8Array = new Uint8Array(await file.arrayBuffer());
      if (isEncrypted(raw)) {
        const password = await askPassword(`"${file.name}" is password-protected`, false);
        if (password === null) {
          notify("Ready");
          return;
        }
        raw = await decryptFile(raw, password);
      }
      const packed = fromFile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
      const opened = await unpackWorkbook(packed.meta, async (n) => {
        const data = packed.files.get(n);
        if (data === undefined) throw new Error(`The file is missing ${n}.`);
        return data;
      });
      fileHandle = null;
      loadWorkbook(opened.workbook, opened.active, file.name.replace(/\.cellforge$/i, ""));
      void snapshotNow();
      notify(`Opened ${file.name}`);
    } catch (e) {
      notify(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
    return;
  }
  if (/\.parquet$/i.test(file.name)) {
    try {
      notify(`Opening ${file.name}…`);
      const { columns, dateColumns } = await readParquet(await file.arrayBuffer());
      const table = new Table(columns);
      const src = new EditableSource(table, SPARE_COLUMNS);
      // dates and timestamps arrive as serial numbers: show them as dates
      for (const d of dateColumns) src.styles.apply(d.col, "all", { numFmt: d.withTime ? "yyyy-mm-dd hh:mm:ss" : "yyyy-mm-dd" });
      loadSource(src, file.name);
      notify(`Opened ${table.rowCount.toLocaleString()} rows from ${file.name}`);
    } catch (e) {
      notify(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
    return;
  }
  if (/\.(json|jsonl|ndjson)$/i.test(file.name)) {
    try {
      const table = new Table(jsonToColumns(await file.text()));
      loadSource(new EditableSource(table, SPARE_COLUMNS), file.name);
      notify(`Opened ${table.rowCount.toLocaleString()} records from ${file.name}`);
    } catch (e) {
      notify(`Couldn't open ${file.name}: ${(e as Error).message}`);
    }
    return;
  }
  // a text file: show what was detected and let the user adjust it first
  const options = await askCsvOptions(file);
  if (!options) {
    notify("Ready");
    return;
  }
  notify(`Opening ${file.name}…`);

  const job = importCsv(file, ({ bytes, total, rows }) => {
    const pct = total ? Math.round((bytes / total) * 100) : 0;
    notify(`Importing ${file.name} — ${pct}% (${formatBytes(bytes)} of ${formatBytes(total)}, ` +
      `${rowFormat.format(rows)} rows)`);
  }, options);
  cancelImport = job.cancel;

  try {
    const { table, ms } = await job.result;
    loadSource(new EditableSource(table, SPARE_COLUMNS), file.name);
    notify(`Imported ${formatBytes(file.size)} in ${(ms / 1000).toFixed(2)}s`);
  } catch (err) {
    // a newer import cancelling this one isn't an error worth showing
    if ((err as Error).message !== "Import cancelled") {
      notify(`Couldn't open ${file.name}: ${(err as Error).message}`);
    }
  } finally {
    if (cancelImport === job.cancel) cancelImport = null;
  }
}

// drag a file anywhere onto the window
const dropOverlay = document.getElementById("drop-overlay")!;
let dragDepth = 0; // dragenter/leave fire for every child element, so count them

window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener("dragover", (e) => e.preventDefault()); // required to allow drop
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files[0];
  if (file) openFile(file);
});

// handy for poking at things from devtools
declare global {
  interface Window {
    grid: Grid;
  }
}
window.grid = grid;

// offline use: the built app registers a service worker that keeps its own files cached
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}

// F1: ask the guide
document.addEventListener("keydown", (e) => {
  if (e.key === "F1" && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openAskGuide(() => commands(), () => grid.focus());
  }
});
