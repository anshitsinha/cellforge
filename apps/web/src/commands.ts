/**
 * The command registry: every user-facing thing cellforge can do, with a
 * group, a one-line description, an icon and its shortcut. The command
 * palette, the menu bar, the left rail's hub panels, the start screen and
 * the ask bar all read this one list, so a command added here shows up
 * everywhere.
 *
 * The list is built fresh each time (buildCommands) because some titles
 * and entries depend on the selection ("Edit note…" vs "Add a note…").
 * app.ts supplies the app's state and actions through CommandDeps.
 *
 * Titles are referenced by the in-app guide (docs/guide, **Title…**), so
 * change a title only together with the guide pages that mention it.
 */
import type { Action, ActionRegistry } from "@cellforge/actions";
import { type CellRange, type Grid, columnLetter } from "@cellforge/grid";
import type { Command } from "./palette";
import type { EditableSource } from "./editable";
import type { Workbook } from "./workbook";
import type { RecipeRecorder } from "./recipe";
import { NUMBER_FORMATS } from "./formatbar";
import { openAuditTool, type AuditToolKind } from "./audittools";
import { openRecon } from "./recondialog";
import { openSql } from "./sqlpanel";
import { openCategorise, openChecks } from "./checksui";
import { openTimeTool, type TimeToolKind } from "./timetools";
import { openOpenItems } from "./openitemsdialog";
import { openTransform } from "./transformtools";
import { openJeTool, type JeToolKind } from "./jetools";
import { openPivot } from "./pivotpanel";
import { openRecipes } from "./recipepanel";
import { openLineage } from "./lineagepanel";
import { reviewCommands } from "./reviewui";
import { openScenarios } from "./scenariosui";
import { openReports } from "./reports/reportpanel";
import { openDocuments } from "./docviewer";
import { openAskGuide } from "./askguide";
import { openVariants } from "./variants";
import { openShareCheck } from "./sharingui";
import { openVerifyPack } from "./evidencepack";
import { openRunOnFiles } from "./recipefiles";
import { openCompare, openGlTie, openJoin, openMapping, openTbCompare } from "./joindialog";
import { cellLink, extraAction } from "./links";
import { openProfiles } from "./profilepanel";
import { dvContext, invalidCells, openValidationDialog } from "./dvui";
import { openChart } from "./charts/panel";
import { openFindReplace } from "./finddialog";
import { editRule, openCfManager } from "./cfmanager";
import { openSortDialog } from "./sortdialog";
import { openCombine } from "./combinedialog";
import { openTbMapper } from "./tbdialog";
import { importStatement, pickStatement } from "./statement";
import { openCleanup } from "./cleanupdialog";
import { LOCALE_CHOICES, chooseLocale } from "./locale";
import type { IconName } from "./ui/icons";

// ---------------------------------------------------------------- model --

export const COMMAND_GROUPS = ["File", "Edit", "View", "Insert", "Format", "Data", "Analyse", "Reconcile", "Audit", "Evidence & review", "Reports", "AI", "Help"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** The icon a command gets when it doesn't name its own. */
export const GROUP_ICONS: Record<CommandGroup, IconName> = {
  File: "document",
  Edit: "copy",
  View: "sidebar",
  Insert: "plus",
  Format: "settings",
  Data: "table",
  Analyse: "pivot",
  Reconcile: "reconcile",
  Audit: "audit",
  "Evidence & review": "shield",
  Reports: "report",
  AI: "sparkles",
  Help: "help",
};

export interface AppCommand extends Command {
  group: CommandGroup;
  description: string;
  icon: IconName;
  /** commands in the same section sit together in a menu, between separators */
  section?: string;
  /** shown inside a submenu with this title (e.g. "Number format") */
  submenu?: string;
  /** false: palette only, not in the menu bar */
  menu?: boolean;
  /** greyed out in menus (still listed so people learn where it lives) */
  disabled?: boolean;
}

export type ThemeChoice = "system" | "light" | "dark";

type DepsOf<F extends (...args: never[]) => unknown> = Parameters<F>[0];

/** What the commands need from the app. */
export interface CommandDeps {
  workbook: () => Workbook;
  activeSheet: () => string;
  source: () => EditableSource;
  grid: Grid;
  registry: ActionRegistry<unknown>;
  recorder: RecipeRecorder;
  run: (a: Action) => Promise<unknown>;
  putBlob: (v: unknown) => string;
  /** a result, warning or error for the user (shown as a toast) */
  status: (t: string) => void;
  focusGrid: () => void;
  goTo: (sheetId: string, row: number, col: number) => void;
  showSheet: (id: string) => void;

  // history
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // file
  newWorkbook: () => void;
  showStartScreen: () => void;
  openFile: () => void;
  saveFile: (saveAs?: boolean) => Promise<void>;
  exportExcel: () => Promise<void>;
  exportCsv: () => Promise<void>;
  saveProtected: () => Promise<void>;
  clearLocal: () => Promise<void>;
  startTemplate: () => Promise<void>;
  openSample: (kind: "bank-rec" | "close" | "audit" | "big") => void;
  saveEvidencePack: () => void;

  // edit
  fillDown: () => Promise<void>;
  sortBy: (descending: boolean) => Promise<void>;
  pasteCopied: (mode: "all" | "values" | "formulas" | "formats") => Promise<unknown>;
  insertRows: (below: boolean) => Promise<void>;
  deleteRows: () => Promise<void>;
  insertCols: (right: boolean) => Promise<void>;
  deleteCols: () => Promise<void>;
  hideRows: (hidden: boolean) => Promise<void>;
  hideCols: (hidden: boolean) => Promise<void>;
  fitRows: () => Promise<void>;
  editCellExtra: (kind: "note" | "link") => Promise<void>;

  // filter
  filterShowing: () => boolean;
  toggleFilterButtons: () => void;
  filterActiveColumn: () => void;

  // panels
  toggleHistory: () => void;
  historyOpen: () => boolean;
  toggleInspect: () => void;
  names: { makeTable: () => unknown; defineName: () => unknown; manager: () => unknown };
  askBar: (text?: string) => void;
  /** open the AI side panel (aipanel.ts) */
  openAi: () => void;
  aiModelKiln: NonNullable<DepsOf<typeof openVariants>["model"]>;
  showShortcuts: () => void;

  // view
  theme: () => ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  localeChanged: () => void;
  railCollapsed: () => boolean;
  toggleRail: () => void;

  // tool deps the app already builds for its own shortcuts
  /** run, putBlob, status, focusGrid: what most tools share */
  statementDeps: () => { run: (a: Action) => Promise<unknown>; putBlob: (v: unknown) => string; status: (t: string) => void; focusGrid: () => void };
  findDeps: () => DepsOf<typeof openFindReplace>;
  lineageDeps: () => DepsOf<typeof openLineage>;
  docDeps: () => DepsOf<typeof openDocuments>;
  recipeFilesDeps: () => DepsOf<typeof openRunOnFiles>;
  dvDeps: () => DepsOf<typeof openValidationDialog>;
  cfDeps: () => DepsOf<typeof openCfManager>;
  filterDeps: () => Omit<DepsOf<typeof openSortDialog>, "activeCol">;
  chartDeps: DepsOf<typeof openChart>;
}

/** Developer mode (?dev=1, or localStorage cellforge.dev = 1) shows the raw engine actions in the palette. */
export function devMode(search = typeof location === "undefined" ? "" : location.search): boolean {
  if (/[?&]dev=1\b/.test(search)) return true;
  try {
    return localStorage.getItem("cellforge.dev") === "1";
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ the list --

type Def = Omit<AppCommand, "icon"> & { icon?: IconName };

/** Every command, for the state the app is in right now. */
export function buildCommands(d: CommandDeps): AppCommand[] {
  const src = d.source();
  const wb = d.workbook();
  const { row, col } = d.grid.selection;
  const range = (): CellRange => d.grid.range;
  const sheetName = () => d.workbook().get(d.activeSheet()).name;
  const base = () => ({ workbook: d.workbook, activeSheet: d.activeSheet, run: d.run, putBlob: d.putBlob, status: d.status, focusGrid: d.focusGrid, goTo: d.goTo });
  const fmt = (style: Record<string, unknown>) => () => d.run({ type: "format.set", params: { range: range(), style } });
  const toggle = (prop: "bold" | "italic" | "underline" | "strike" | "wrap") => () => fmt({ [prop]: d.source().getStyle(row, col)?.[prop] ? null : true })();
  const border = (which: string) => () => d.run({ type: "format.borders", params: { range: range(), which, line: { style: "thin", color: "auto" } } });
  const extra = src.extraAt(row, col);
  const filterOn = d.filterShowing();

  const list: Def[] = [
    // ---------------------------------------------------------- File --
    { group: "File", section: "new", id: "new", title: "New workbook", description: "Start again from the start screen: a blank sheet, a workflow or sample data", icon: "plus", hint: "blank start screen", run: d.showStartScreen },
    { group: "File", section: "new", id: "template", title: "New from a template (monthly close, bank rec, audit tests)…", description: "A ready-made workbook laid out for a common job", icon: "document", hint: "template starter new workbook monthly close bank reconciliation audit tests", run: d.startTemplate },
    { group: "File", section: "open", id: "open", title: "Open…", keys: "Ctrl O", description: "A .cellforge workbook, Excel, CSV, JSON, Parquet or a PDF bank statement", icon: "open", hint: "import csv file cellforge excel xlsx", run: d.openFile },
    { group: "File", section: "open", id: "statement", title: "Import a bank statement (PDF or CSV)…", description: "Read a statement's transactions onto a new sheet", icon: "upload", hint: "bank statement pdf transactions balance reconcile import", run: () => void pickStatement().then((f) => f && importStatement(f, d.statementDeps())) },
    ...[false, true].map((folder): Def => ({
      group: "File",
      section: "open",
      id: folder ? "combine-folder" : "combine-files",
      title: folder ? "Combine all files in a folder…" : "Combine several files…",
      description: folder ? "Stack every export in a folder into one sheet" : "Stack monthly exports with the same columns into one sheet",
      icon: "upload",
      hint: "append stack merge union monthly exports csv excel folder import",
      run: () => void openCombine({ run: d.run, putBlob: d.putBlob, status: d.status, focusGrid: d.focusGrid }, folder),
    })),
    { group: "File", section: "save", id: "save", title: "Save", keys: "Ctrl S", description: "Save the workbook as a .cellforge file", icon: "save", hint: "file cellforge", run: () => d.saveFile() },
    { group: "File", section: "save", id: "save-as", title: "Save as…", keys: "Ctrl Shift S", description: "Save a copy under a new name", icon: "save", run: () => d.saveFile(true) },
    { group: "File", section: "save", id: "save-protected", title: "Save a password-protected copy…", description: "An encrypted .cellforge file that needs the password to open", icon: "shield", hint: "encrypt password protect secure share aes", run: d.saveProtected },
    { group: "File", section: "export", id: "export-xlsx", title: "Export Excel (.xlsx)", description: "Download the whole workbook as an Excel file", icon: "download", hint: "download save excel xlsx", run: d.exportExcel },
    { group: "File", section: "export", id: "export", title: "Export CSV", description: "Download this sheet as a CSV file", icon: "download", hint: "download save csv", run: d.exportCsv },
    { group: "File", section: "share", id: "share-check", title: "Before you share: check for hidden content…", description: "Hidden sheets, rows, notes and personal data to deal with before sending", icon: "share", hint: "share safely hidden sheets rows notes personal data pii history versions privacy", run: () => openShareCheck(d.workbook(), d.showSheet) },
    { group: "File", section: "privacy", id: "clear-local", title: "Clear all data cellforge keeps in this browser…", description: "Forget the autosave, documents and models stored on this computer", icon: "trash", hint: "privacy delete local storage autosave forget clear data", run: d.clearLocal },

    // ---------------------------------------------------------- Edit --
    { group: "Edit", section: "undo", id: "undo", title: "Undo", keys: "Ctrl Z", description: "Take back the last change", icon: "undo", disabled: !d.canUndo(), run: d.undo },
    { group: "Edit", section: "undo", id: "redo", title: "Redo", keys: "Ctrl Y", description: "Put back the change you undid", icon: "redo", disabled: !d.canRedo(), run: d.redo },
    { group: "Edit", section: "find", id: "find", title: "Find…", keys: "Ctrl F", description: "Search the workbook for text, numbers or a pattern", icon: "search", hint: "search look for regex", run: () => openFindReplace(d.findDeps(), "find") },
    { group: "Edit", section: "find", id: "replace", title: "Find and replace…", keys: "Ctrl H", description: "Replace text in values or formulas", icon: "search", hint: "replace all substitute regex formulas", run: () => openFindReplace(d.findDeps(), "replace") },
    { group: "Edit", section: "paste", id: "paste-values", title: "Paste values only", keys: "Ctrl Shift V", description: "Paste results, without formulas or formats", icon: "copy", run: () => d.pasteCopied("values") },
    { group: "Edit", section: "paste", id: "paste-formulas", title: "Paste formulas only", description: "Paste formulas, keeping this range's formats", icon: "formula", run: () => d.pasteCopied("formulas") },
    { group: "Edit", section: "paste", id: "paste-formats", title: "Paste formats only", description: "Copy the look of the copied cells onto these", icon: "copy", run: () => d.pasteCopied("formats") },
    { group: "Edit", section: "fill", id: "fill-down", title: "Fill down", keys: "Ctrl D", description: "Copy the top cell down through the selection", icon: "chevron-down", hint: "copy down", run: d.fillDown },
    { group: "Edit", section: "rows", id: "delete-rows", title: "Delete rows", keys: "Ctrl Alt −", description: "Remove the selected rows", icon: "trash", run: d.deleteRows },
    { group: "Edit", section: "rows", id: "delete-cols", title: "Delete columns", description: "Remove the selected columns", icon: "trash", run: d.deleteCols },
    { group: "Edit", section: "calc", id: "iterative", title: wb.iterative ? "Turn off iterative calculation" : "Turn on iterative calculation (for circular references)", description: "Let formulas that refer to themselves settle on a value", icon: "formula", hint: "circular cycle", run: () => d.run({ type: "calc.iterative", params: { enabled: !wb.iterative } }) },

    // ---------------------------------------------------------- View --
    { group: "View", section: "panels", id: "history", title: "Show history and versions", keys: "Ctrl Shift H", description: "Every change this session, named versions and compare", icon: "history", hint: "timeline compare changes audit", run: d.toggleHistory },
    { group: "View", section: "panels", id: "version-save", title: "Save a version…", description: "Name this moment so you can come back to it", icon: "history", hint: "name snapshot checkpoint", run: () => { if (!d.historyOpen()) d.toggleHistory(); document.querySelector<HTMLInputElement>(".hp-version-form input")?.focus(); } },
    { group: "View", section: "panels", id: "inspect", title: "Inspect this cell", keys: "Ctrl [", description: "Its formula step by step, what it uses and what uses it", icon: "search", hint: "trace precedents dependents evaluate formula audit", run: d.toggleInspect },
    { group: "View", section: "panels", id: "profiles", title: "Column profiles", description: "Blanks, distinct values, ranges and patterns of every column", icon: "chart", hint: "profile columns distinct blanks min max median histogram patterns data quality", run: () => openProfiles({ source: d.source, sheetName, focusGrid: d.focusGrid }) },
    { group: "View", section: "freeze", id: "freeze-here", title: `Freeze panes above row ${row + 1}${col ? ` and left of ${columnLetter(col)}` : ""}`, description: "Keep the rows above and the columns left of this cell in view", icon: "table", run: () => d.run({ type: "view.freeze", params: { rows: row, cols: col } }) },
    { group: "View", section: "freeze", id: "freeze-row", title: "Freeze top row", description: "Keep the header row in view while you scroll", icon: "table", run: () => d.run({ type: "view.freeze", params: { rows: 1, cols: 0 } }) },
    { group: "View", section: "freeze", id: "freeze-col", title: "Freeze first column", description: "Keep the first column in view while you scroll", icon: "table", run: () => d.run({ type: "view.freeze", params: { rows: 0, cols: 1 } }) },
    { group: "View", section: "freeze", id: "unfreeze", title: "Unfreeze panes", description: "Scroll everything again", icon: "table", run: () => d.run({ type: "view.freeze", params: { rows: 0, cols: 0 } }) },
    { group: "View", section: "hide", id: "hide-rows", title: "Hide rows", keys: "Ctrl 9", description: "Hide the selected rows", icon: "sidebar", run: () => d.hideRows(true) },
    { group: "View", section: "hide", id: "unhide-rows", title: "Unhide rows", keys: "Ctrl Shift 9", description: "Show hidden rows inside the selection", icon: "sidebar", run: () => d.hideRows(false) },
    { group: "View", section: "hide", id: "hide-cols", title: "Hide columns", keys: "Ctrl 0", description: "Hide the selected columns", icon: "sidebar", run: () => d.hideCols(true) },
    { group: "View", section: "hide", id: "unhide-cols", title: "Unhide columns", keys: "Ctrl Shift 0", description: "Show hidden columns inside the selection", icon: "sidebar", run: () => d.hideCols(false) },
    ...(["system", "light", "dark"] as const).map((t): Def => ({
      group: "View",
      section: "look",
      submenu: "Theme",
      id: `theme-${t}`,
      title: `Theme: ${t === "system" ? "match the system" : t === "light" ? "light" : "dark"}${d.theme() === t ? " ✓" : ""}`,
      description: t === "system" ? "Follow the computer's light or dark setting" : `Always use the ${t} theme`,
      icon: "settings",
      hint: "theme dark mode light mode appearance colours",
      run: () => d.setTheme(t),
    })),
    ...LOCALE_CHOICES.map((l): Def => ({
      group: "View",
      section: "look",
      submenu: "Locale",
      id: `locale-${l.id}`,
      title: `Locale: ${l.name}`,
      description: `Numbers and dates like ${l.sample}`,
      icon: "settings",
      hint: `locale language country decimal separator comma ${l.sample}`,
      run: () => {
        chooseLocale(l.id);
        d.localeChanged();
      },
    })),
    { group: "View", section: "look", id: "rail-toggle", title: d.railCollapsed() ? "Show labels on the side bar" : "Collapse the side bar", description: "Make the left bar of jobs narrower or wider", icon: "sidebar", hint: "rail sidebar collapse expand", run: d.toggleRail },

    // -------------------------------------------------------- Insert --
    { group: "Insert", section: "rows", id: "insert-rows", title: "Insert rows above", keys: "Ctrl Alt =", description: "New empty rows above the selection", icon: "plus", run: () => d.insertRows(false) },
    { group: "Insert", section: "rows", id: "insert-rows-below", title: "Insert rows below", description: "New empty rows below the selection", icon: "plus", run: () => d.insertRows(true) },
    { group: "Insert", section: "rows", id: "insert-cols", title: "Insert columns left", description: "New empty columns left of the selection", icon: "plus", run: () => d.insertCols(false) },
    { group: "Insert", section: "rows", id: "insert-cols-right", title: "Insert columns right", description: "New empty columns right of the selection", icon: "plus", run: () => d.insertCols(true) },
    { group: "Insert", section: "objects", id: "chart", title: "Insert chart…", description: "Column, line, pie, waterfall, Pareto and more from the selection", icon: "chart", hint: "graph plot column bar line pie scatter histogram waterfall pareto benford ageing", run: () => void openChart(d.chartDeps) },
    { group: "Insert", section: "objects", id: "table", title: "Make a table from the selection", keys: "Ctrl T", description: "A named table you can refer to by column name", icon: "table", hint: "format as table structured", run: () => d.names.makeTable() },
    { group: "Insert", section: "cell", id: "note", title: extra?.note ? "Edit note…" : "Add a note…", keys: "Shift F2", description: "A note on this cell, shown when you point at it", icon: "document", hint: "note comment annotation", run: () => d.editCellExtra("note") },
    ...(extra?.note ? [{ group: "Insert", section: "cell", id: "note-delete", title: "Delete note", description: "Remove this cell's note", icon: "trash", hint: "remove note comment", run: () => d.run(extraAction("note", { row, col }, "")) } as Def] : []),
    { group: "Insert", section: "cell", id: "link", title: extra?.link ? "Edit link…" : "Insert link…", description: "A link to a web page or another place in the workbook", icon: "export", hint: "hyperlink url web address go to sheet", run: () => d.editCellExtra("link") },
    ...(extra?.link ? [{ group: "Insert", section: "cell", id: "link-remove", title: "Remove link", description: "Remove this cell's link", icon: "trash", hint: "hyperlink", run: () => d.run(extraAction("link", { row, col }, "")) } as Def] : []),
    ...(cellLink(src, row, col) ? [{ group: "Insert", section: "cell", id: "link-open", title: "Open link", keys: "Ctrl click", description: "Follow this cell's link", icon: "export", hint: "follow hyperlink go", run: () => d.grid.onCellCtrlClick?.({ row, col }) } as Def] : []),
    { group: "Insert", section: "names", id: "define-name", title: "Define a name for the selection…", description: "Refer to this range by a name in formulas", icon: "formula", hint: "named range", run: () => d.names.defineName() },
    { group: "Insert", section: "names", id: "name-manager", title: "Names and tables…", keys: "Ctrl F3", description: "Every name and table in the workbook", icon: "formula", hint: "name manager", run: () => d.names.manager() },

    // -------------------------------------------------------- Format --
    { group: "Format", section: "text", id: "bold", title: "Bold", keys: "Ctrl B", description: "Make the text bold", icon: "settings", run: toggle("bold") },
    { group: "Format", section: "text", id: "italic", title: "Italic", keys: "Ctrl I", description: "Make the text italic", icon: "settings", run: toggle("italic") },
    { group: "Format", section: "text", id: "underline", title: "Underline", keys: "Ctrl U", description: "Underline the text", icon: "settings", run: toggle("underline") },
    { group: "Format", section: "text", id: "strike", title: "Strikethrough", keys: "Ctrl 5", description: "Strike through the text", icon: "settings", run: toggle("strike") },
    { group: "Format", section: "text", id: "wrap", title: "Wrap text", description: "Show long text on several lines", icon: "settings", run: toggle("wrap") },
    { group: "Format", section: "align", submenu: "Align", id: "align-left", title: "Align left", description: "Line up the text on the left", icon: "settings", run: fmt({ align: "left" }) },
    { group: "Format", section: "align", submenu: "Align", id: "align-center", title: "Align centre", description: "Centre the text in the cell", icon: "settings", hint: "center", run: fmt({ align: "center" }) },
    { group: "Format", section: "align", submenu: "Align", id: "align-right", title: "Align right", description: "Line up the text on the right", icon: "settings", run: fmt({ align: "right" }) },
    { group: "Format", section: "align", submenu: "Align", id: "center-across", title: "Centre across selection", description: "Centre over several cells without merging them", icon: "settings", hint: "center across", run: fmt({ align: "centerAcross" }) },
    { group: "Format", section: "align", submenu: "Borders", id: "borders-all", title: "Borders: all", description: "A thin line round every cell", icon: "table", run: border("all") },
    { group: "Format", section: "align", submenu: "Borders", id: "borders-outline", title: "Borders: outline", description: "A thin line round the selection", icon: "table", run: border("outline") },
    { group: "Format", section: "align", submenu: "Borders", id: "borders-none", title: "Borders: none", description: "Remove the borders", icon: "table", run: border("none") },
    { group: "Format", section: "align", submenu: "Merge", id: "merge", title: "Merge cells", description: "Join the selected cells into one", icon: "table", run: () => d.run({ type: "cells.merge", params: { range: range() } }) },
    { group: "Format", section: "align", submenu: "Merge", id: "merge-center", title: "Merge and centre", description: "Join the cells and centre the text", icon: "table", hint: "center", run: () => d.run({ type: "cells.merge", params: { range: range(), center: true } }) },
    { group: "Format", section: "align", submenu: "Merge", id: "merge-across", title: "Merge across", description: "Join the cells in each row separately", icon: "table", run: () => d.run({ type: "cells.merge", params: { range: range(), across: true } }) },
    { group: "Format", section: "align", submenu: "Merge", id: "unmerge", title: "Unmerge cells", description: "Split merged cells back apart", icon: "table", run: () => d.run({ type: "cells.unmerge", params: { range: range() } }) },
    { group: "Format", section: "rules", id: "cf-new", title: "Conditional formatting: new rule for the selection…", description: "Highlight values, colour scales, data bars and icons", icon: "chart", hint: "highlight cells greater than duplicates top 10 colour scale data bar icon set", run: () => void editRule(d.cfDeps(), null).then((rule) => rule && d.run({ type: "format.conditionalAdd", params: { rule } })) },
    { group: "Format", section: "rules", id: "cf-manager", title: "Conditional formatting: manage rules…", description: "Every highlight rule on this sheet", icon: "chart", hint: "highlight rules colour scale data bars icons", run: () => openCfManager(d.cfDeps()) },
    { group: "Format", section: "size", id: "fit-rows", title: "Fit row height", description: "Make the rows just tall enough for their contents", icon: "table", hint: "autofit", run: d.fitRows },
    { group: "Format", section: "size", id: "clear-format", title: "Clear formatting", keys: "Ctrl \\", description: "Back to plain cells", icon: "close", run: () => d.run({ type: "format.clear", params: { range: range() } }) },

    // ---------------------------------------------------------- Data --
    { group: "Data", section: "sort", id: "sort-asc", title: "Sort A→Z by this column", description: "Smallest or earliest first, every row moving together", icon: "sort", hint: "ascending smallest", run: () => d.sortBy(false) },
    { group: "Data", section: "sort", id: "sort-desc", title: "Sort Z→A by this column", description: "Largest or latest first, every row moving together", icon: "sort", hint: "descending largest", run: () => d.sortBy(true) },
    { group: "Data", section: "sort", id: "sort-dialog", title: "Sort by several columns…", description: "Sort on more than one column, in your own order", icon: "sort", hint: "multi-level sort order custom sort", run: () => openSortDialog({ ...d.filterDeps(), activeCol: () => d.grid.selection.col }) },
    { group: "Data", section: "filter", id: "filter-toggle", title: filterOn ? "Turn off filter" : "Filter (show filter buttons)", keys: "Ctrl Shift L", description: "Filter buttons on every column header", icon: "filter", hint: "autofilter filter buttons dropdown", run: d.toggleFilterButtons },
    { group: "Data", section: "filter", id: "filter-column", title: "Filter this column…", description: "Show only the rows you pick by value or condition", icon: "filter", hint: "autofilter values blanks condition", run: d.filterActiveColumn },
    ...(src.filter
      ? ([
          { group: "Data", section: "filter", id: "filter-reapply", title: "Reapply filter", keys: "Ctrl Alt L", description: "Filter again after the data changed", icon: "filter", hint: "refresh filter", run: () => d.run({ type: "filter.reapply", params: {} }) },
          { group: "Data", section: "filter", id: "filter-clear", title: "Clear filter (show all rows)", description: "Show every row again", icon: "filter", hint: "remove filter show all", run: () => d.run({ type: "filter.clear", params: {} }) },
        ] as Def[])
      : []),
    ...src.filterViews.map((v): Def => ({ group: "Data", section: "filter", id: `view:${v.name}`, title: `Switch to view: ${v.name}`, description: "A saved filter view", icon: "filter", hint: "filter view saved", menu: false, run: () => d.run({ type: "filter.applyView", params: { name: v.name } }) })),
    { group: "Data", section: "clean", id: "cleanup", title: "Clean up this sheet (messy export)…", description: "Unwrap report headers, drop totals, fix dates and numbers stored as text", icon: "wand", hint: "unwrap report header totals footers dates numbers text to numbers type", run: () => openCleanup({ source: d.source, run: d.run, goTo: (r, c) => d.goTo(d.activeSheet(), r, c), focusGrid: d.focusGrid }) },
    { group: "Data", section: "clean", id: "variants", title: "Fix spelling variants in this column…", description: "Merge \"ACME Ltd\" and \"Acme Limited\" into one name", icon: "merge", hint: "clean spelling variants duplicates names vendors customers case spaces typos abbreviations merge normalise standardise", run: () => void openVariants({ source: d.source, activeSheet: d.activeSheet, col: () => d.grid.selection.col, run: d.run, status: d.status, focusGrid: d.focusGrid, model: d.aiModelKiln, goTo: d.goTo }) },
    ...transforms(d, sheetName),
    { group: "Data", section: "rules", id: "validation", submenu: "Validation", title: "Data validation (dropdown list, allowed values)…", description: "Limit what can be typed: lists, ranges, dates, tick boxes", icon: "dropdown", hint: "validation dropdown list choices allowed values restrict input checkbox tick box", run: () => openValidationDialog(d.dvDeps()) },
    { group: "Data", section: "rules", id: "validation-tick", submenu: "Validation", title: "Tick boxes in the selection", description: "Turn the selected cells into tick boxes", icon: "checkbox", hint: "checkbox check box tick boxes true false column type", run: () => d.run({ type: "validation.add", params: { rule: { kind: "checkbox", ranges: [range()] } } }) },
    {
      group: "Data",
      section: "rules",
      submenu: "Validation",
      id: "validation-circle",
      title: "Circle invalid data",
      description: "Ring every cell that breaks its validation rule",
      icon: "warning",
      hint: "validation invalid circles check",
      run: () => {
        const bad = invalidCells(d.source(), dvContext(d.workbook(), d.source()));
        d.grid.setHighlights(bad.map((r) => ({ range: r, color: "#d93025" })));
        d.status(bad.length ? `${bad.length.toLocaleString()} cell${bad.length === 1 ? " breaks" : "s break"} a validation rule (circled in red)` : "Every cell keeps its validation rule.");
      },
    },
    { group: "Data", section: "rules", id: "validation-uncircle", submenu: "Validation", title: "Clear validation circles", description: "Remove the red rings", icon: "close", hint: "validation invalid circles remove", run: () => d.grid.setHighlights([]) },
    { group: "Data", section: "rules", id: "data-checks", title: "Data checks…", description: "Rules the data must pass (not blank, unique, debits = credits) before export", icon: "list-check", hint: "checks rules validate not blank unique master list lookup debits equal credits control total tolerance row count duplicate keys checklist gate export", run: () => openChecks({ ...base(), goTo: d.goTo }) },
    { group: "Data", section: "rules", id: "categorise", title: "Categorise…", description: "Tag rows by rules that learn from you (and the AI, if loaded)", icon: "sparkles", hint: "categorise categorize category tag bulk tagging rules learn uncategorised queue coding expenses", run: () => openCategorise({ ...base(), source: d.source, range, model: d.aiModelKiln }) },
    { group: "Data", section: "join", id: "join-sheets", title: "Join two sheets…", description: "Bring columns from another sheet across by a key, like XLOOKUP", icon: "table", hint: "join merge lookup vlookup xlookup match keys doctor orphans duplicates fuzzy why don't these match", run: () => openJoin(base()) },
    { group: "Data", section: "join", id: "compare-versions", title: "Compare two versions by key…", description: "What was added, removed or changed between two sheets", icon: "table", hint: "compare diff versions changed added removed old new key file compare", run: () => openCompare(base()) },
    { group: "Data", section: "join", id: "mapping-table", title: "Apply a mapping table…", description: "Standardise values with a lookup list, with suggested pairs", icon: "table", hint: "mapping table map values standardise names fuzzy names suggest pairs lookup replace", run: () => openMapping(base()) },
    {
      group: "Data",
      section: "recipes",
      id: "recipes",
      title: "Recipes: this session's steps and saved recipes…",
      description: "Record what you did and replay it on next month's file",
      icon: "play",
      hint: "recipe macro record replay steps automate repeat monthly",
      run: () =>
        openRecipes({
          sessionSteps: () => d.recorder.steps,
          recipes: () => d.workbook().recipes,
          registry: d.registry,
          run: d.run,
          showAfter: async (count) => {
            while (d.recorder.steps.length > count && d.canUndo()) await d.undo();
            while (d.recorder.steps.length < count && d.canRedo()) await d.redo();
          },
          status: d.status,
          focusGrid: d.focusGrid,
          runOnFiles: (recipe) => openRunOnFiles(d.recipeFilesDeps(), recipe),
        }),
    },
    ...wb.recipes.map((r): Def => ({ group: "Data", section: "recipes", submenu: "Run a recipe", id: `recipe:${r.name}`, title: `Run recipe: ${r.name}`, description: "Replay these saved steps here", icon: "play", hint: "recipe run replay", run: () => d.run({ type: "recipe.run", params: { name: r.name, steps: r.steps } }) })),
    ...wb.recipes.map((r): Def => ({ group: "Data", section: "recipes", submenu: "Run a recipe", id: `recipe-files:${r.name}`, title: `Run recipe on files: ${r.name}`, description: "Replay these steps on several files", icon: "play", hint: "recipe run files folder batch", run: () => openRunOnFiles(d.recipeFilesDeps(), r) })),

    // ------------------------------------------------------- Analyse --
    { group: "Analyse", section: "summarise", id: "pivot", title: "Pivot table…", description: "Summarise by any columns, drill into the rows behind a number", icon: "pivot", hint: "pivot summarise group by subtotal crosstab drill down slicer sum count", run: () => openPivot({ ...d.statementDeps(), source: d.source, sheetName, sheetId: d.activeSheet, addChart: (spec) => void d.run({ type: "chart.set", params: { id: spec.id, spec } }) }) },
    { group: "Analyse", section: "summarise", id: "sql", title: "SQL query…", description: "Ask the workbook in SQL: joins, group by, windows", icon: "database", hint: "sql query select join group by where sum count left join unmatched duplicates running balance window", run: () => openSql(base()) },
    ...timeTools(d, sheetName, range),
    { group: "Analyse", section: "whatif", id: "scenarios", title: "Scenarios (what-if: base, best, worst)…", description: "Save sets of inputs and compare what they do to the results", icon: "scale", hint: "scenario what if manager best worst case compare sensitivity", run: () => openScenarios({ ...base(), range }) },

    // ----------------------------------------------------- Reconcile --
    { group: "Reconcile", section: "match", id: "reconcile", title: "Reconcile two sheets…", description: "Match a bank statement to the ledger (or any two lists) and see what's left", icon: "reconcile", hint: "reconciliation bank rec match ledger statement unmatched mismatched tolerance fuzzy why don't these match", run: () => openRecon(base()) },
    ...openItems(base),
    { group: "Reconcile", section: "tb", id: "tb-map", title: "Map this sheet as a trial balance…", description: "Say which columns are account, debit and credit", icon: "table", hint: "trial balance tb debit credit account code prior year import mapper", run: () => openTbMapper({ ...d.statementDeps(), source: d.source, sheetName, goTo: (r, c) => d.goTo(d.activeSheet(), r, c) }) },
    { group: "Reconcile", section: "tb", id: "tb-compare", title: "Compare trial balances…", description: "This period against the last: movements and missing accounts", icon: "reconcile", hint: "trial balance tb compare prior period movement missing accounts", run: () => openTbCompare(base()) },
    { group: "Reconcile", section: "tb", id: "gl-tb-tie", title: "Tie the GL out to the TB…", description: "Check every account's ledger total against the trial balance", icon: "reconcile", hint: "general ledger trial balance tie out reconcile account totals differences", run: () => openGlTie(base()) },

    // --------------------------------------------------------- Audit --
    ...auditTools(d, sheetName),
    ...jeTools(d, sheetName, range),

    // --------------------------------------------- Evidence & review --
    { group: "Evidence & review", section: "explain", id: "explain", title: "Explain this number (where it came from)…", keys: "Ctrl Shift E", description: "Trace a figure back to its sources, edits and documents", icon: "search", hint: "explain lineage trace source provenance where from audit trail write up working paper", run: () => openLineage(d.lineageDeps()) },
    { group: "Evidence & review", section: "documents", id: "documents", title: "Supporting documents (attach, link cells as evidence)…", description: "Invoices, letters and statements kept with the workbook", icon: "document", hint: "evidence documents attach pdf invoice bank letter confirmation link support vouch", run: () => openDocuments(d.docDeps()) },
    ...(extra?.evidence
      ? ([
          { group: "Evidence & review", section: "documents", id: "evidence-open", title: "Show this cell's evidence", description: "Open the document linked to this cell", icon: "document", hint: "evidence document link open", run: () => openDocuments(d.docDeps(), extra.evidence) },
          { group: "Evidence & review", section: "documents", id: "evidence-unlink", title: "Remove this cell's evidence link", description: "Unlink the document from this cell", icon: "trash", hint: "evidence unlink", run: () => d.run({ type: "evidence.link", params: { row, col, link: null } }) },
        ] as Def[])
      : []),
    { group: "Evidence & review", section: "pack", id: "evidence-pack", title: "Save an evidence pack…", description: "The workbook, its change log and inputs, sealed with a hash", icon: "shield", hint: "evidence pack audit trail log hash fingerprint working papers review sign off", run: d.saveEvidencePack },
    { group: "Evidence & review", section: "pack", id: "evidence-verify", title: "Verify an evidence pack…", description: "Check that a pack hasn't been changed since it was saved", icon: "shield", hint: "verify evidence pack hash chain tamper check", run: () => openVerifyPack(d.workbook(), d.status) },
    ...reviewCommands({ ...base(), range, cell: () => ({ ...d.grid.selection }), goTo: d.goTo }).map(reviewMeta),

    // ------------------------------------------------------- Reports --
    { group: "Reports", section: "reports", id: "reports", title: "Reports…", description: "Rec packs, close packs and findings as a printable PDF", icon: "report", hint: "report pdf print narrative book contents entity consolidation roll forward period pack board", run: () => openReports(base()) },
    { group: "Reports", section: "reports", id: "chart-report", title: "Chart the selection…", description: "A chart for a report or a slide", icon: "chart", hint: "graph chart report", menu: false, run: () => void openChart(d.chartDeps) },

    // ------------------------------------------------------------ AI --
    { group: "AI", section: "ask", id: "ai-panel", title: "AI: set up and manage the local model…", description: "A private AI that runs on this computer: pick, download and manage the model", icon: "sparkles", hint: "ai assistant local model llm gguf download load remove qwen llama offline private setup", run: d.openAi },
    { group: "AI", section: "ask", id: "ask", title: "Ask or do…", keys: "Ctrl /", description: "Type what you want done (\"sum of Amount by Vendor\")", icon: "sparkles", hint: "ai natural language type what you want plain english", run: () => d.askBar() },

    // ---------------------------------------------------------- Help --
    { group: "Help", section: "help", id: "ask-guide", title: "Ask the guide (how do I…)…", keys: "F1", description: "Search the guide in plain words; it can run what it suggests", icon: "help", hint: "help how do i question guide docs documentation search", run: () => openAskGuide(() => buildCommands(d), d.focusGrid) },
    { group: "Help", section: "help", id: "shortcuts", title: "Keyboard shortcuts", description: "Every shortcut, on one page", icon: "help", hint: "keys keyboard shortcuts hotkeys cheat sheet", run: d.showShortcuts },
    { group: "Help", section: "start", id: "start-screen", title: "Start screen", description: "Workflows, sample data and recent ways to begin", icon: "play", hint: "home welcome start", run: d.showStartScreen },
    ...(
      [
        ["bank-rec", "Try the sample: bank reconciliation", "A cash book and bank statement with planted exceptions"],
        ["close", "Try the sample: month-end close", "Two trial balances and a mapping, ready to explain"],
        ["audit", "Try the sample: journal entry tests", "A month of journals with planted red flags"],
        ["big", "Try the sample: 100M-line ledger", "Scroll, sort and pivot 100 million lines"],
      ] as const
    ).map(([kind, title, description]): Def => ({ group: "Help", section: "samples", submenu: "Sample data", id: `sample-${kind}`, title, description, icon: "play", hint: "sample demo example data try", run: () => d.openSample(kind) })),
  ];

  for (const [name, code, example] of NUMBER_FORMATS) {
    list.push({ group: "Format", section: "number", submenu: "Number format", id: `numfmt:${name}`, title: `Number format: ${name}`, description: `Shows like ${example}`, icon: "settings", hint: example, run: fmt({ numFmt: code || null }) });
  }
  return list.map((c) => ({ ...c, icon: c.icon ?? GROUP_ICONS[c.group] }));
}

function auditTools(d: CommandDeps, sheetName: () => string): Def[] {
  const tools: [AuditToolKind, string, string, IconName, string][] = [
    ["duplicates", "Find duplicates…", "Exact and near-duplicate payments, invoices or entries", "copy", "audit duplicate exact near fuzzy similar vendor invoice double payment"],
    ["sequence", "Find gaps in a sequence…", "Missing, repeated or out-of-order invoice and cheque numbers", "audit", "audit sequence gap missing invoice cheque number duplicate out of order"],
    ["benford", "Benford's law test…", "First-digit test for made-up or manipulated amounts", "chart", "audit benford first digit two digits chi-square mad fraud"],
    ["stratify", "Stratify values into bands…", "How many items and how much value in each size band", "chart", "audit stratify strata bands value ranges profile"],
    ["topn", "Largest items (top N)…", "The biggest items, for a quick look at what matters", "sort", "audit top n largest biggest items"],
    ["pareto", "Pareto analysis…", "Which few vendors or customers make up most of the value", "chart", "audit pareto 80/20 cumulative share vendor customer concentration"],
    ["ageing", "Ageing buckets…", "Receivables or payables by days overdue: 30, 60, 90+", "calendar", "audit ageing aging days overdue receivables payables 30 60 90"],
    ["sample", "Pick a sample…", "Random, systematic, stratified or monetary-unit sampling, repeatable", "audit", "audit sample sampling random systematic stratified monetary unit mus seed"],
  ];
  return tools.map(([kind, title, description, icon, hint]) => ({
    group: "Audit",
    section: kind === "duplicates" || kind === "sequence" || kind === "benford" ? "tests" : kind === "sample" ? "sample" : "analytics",
    id: `audit-${kind}`,
    title,
    description,
    icon,
    hint,
    run: () => openAuditTool(kind, { ...d.statementDeps(), source: d.source, sheetName, goTo: d.goTo, activeSheet: d.activeSheet }),
  }));
}

function jeTools(d: CommandDeps, sheetName: () => string, range: () => CellRange): Def[] {
  const tools: [JeToolKind, string, string, string, IconName, string][] = [
    ["journal", "Journal entry tests…", "Weekend, late-night, round-sum, unbalanced and unusual-user entries, scored", "tests", "audit", "audit je journal entries testing manual weekend holiday after hours round amounts approval limit threshold backdated keywords unusual user seldom account period end duplicate score"],
    ["overlaps", "Red-flag overlaps (vendor vs employee)…", "Vendors who share a bank account, address or phone with staff", "tests", "warning", "audit overlap vendor employee master same bank account address phone tax id similar names fraud"],
    ["footing", "Foot and cross-foot this range…", "Check that the rows and columns add up to their totals", "schedules", "list-check", "audit footing cross-footing cast add up totals check schedule"],
    ["rollforward", "Roll-forward check…", "Opening + movements = closing, for fixed assets and provisions", "schedules", "scale", "audit roll forward opening movements closing balance fixed assets provisions"],
    ["pii", "PII scan and safe copy…", "Find personal data and make a masked copy to share", "privacy", "shield", "privacy personal data pii gdpr mask hash pseudonymise anonymise redact share safely email phone iban card ssn"],
  ];
  return tools.map(([kind, title, description, section, icon, hint]) => ({
    group: "Audit",
    section,
    id: `je-${kind}`,
    title,
    description,
    icon,
    hint,
    run: () => openJeTool(kind, { ...d.statementDeps(), workbook: d.workbook, source: d.source, activeSheet: d.activeSheet, range, sheetName, goTo: d.goTo }),
  }));
}

function openItems(base: () => Parameters<typeof openOpenItems>[1]): Def[] {
  const tools: ["bankstatement" | "rollforward" | "openitems" | "statementrec", string, string, string][] = [
    ["bankstatement", "Bank rec statement…", "The formal rec: deposits in transit, outstanding cheques, adjusting entries", "bank rec reconciliation statement deposits in transit outstanding cheques unpresented adjusting entries journal fees interest"],
    ["rollforward", "Roll forward outstanding items…", "Carry last month's open items into this month and clear what came through", "roll forward outstanding items cleared unpresented cheques deposits in transit stale ageing prior period"],
    ["openitems", "Open-item matching (one account)…", "Clear debits against credits in a suspense or control account", "open item matching suspense clearing account ar ap control debits credits clear ageing"],
    ["statementrec", "Supplier / customer statement rec…", "Match a supplier's statement to your ledger, invoice by invoice", "supplier customer statement reconciliation vendor creditor debtor invoice credit note payment in transit"],
  ];
  return tools.map(([kind, title, description, hint]) => ({ group: "Reconcile", section: kind === "statementrec" ? "statements" : "match", id: `openitems-${kind}`, title, description, icon: "reconcile", hint, run: () => openOpenItems(kind, base()) }));
}

function transforms(d: CommandDeps, sheetName: () => string): Def[] {
  const tools: ["dedupe" | "split" | "unpivot" | "pivot" | "extract" | "goalseek", string, string, string][] = [
    ["dedupe", "Remove duplicates…", "Keep one of each row, by the columns you choose", "remove delete duplicates unique distinct dedupe"],
    ["split", "Text to columns…", "Split one column by a delimiter or fixed widths", "text to columns split delimiter comma fixed width parse"],
    ["unpivot", "Unpivot (columns to rows)…", "Turn month columns into rows, for pivots and SQL", "unpivot melt columns to rows long format months"],
    ["pivot", "Pivot (rows to columns)…", "Spread rows out into columns", "pivot wider rows to columns cross tab sum count"],
    ["extract", "Extract by pattern…", "Pull invoice numbers, emails or amounts out of text", "extract pattern regex email phone url amount date invoice code reference"],
    ["goalseek", "Goal Seek…", "Find the input that gives the result you want", "goal seek what-if solve target backsolve"],
  ];
  return tools.map(([kind, title, description, hint]) => ({
    group: kind === "goalseek" ? "Analyse" : "Data",
    section: kind === "goalseek" ? "whatif" : kind === "dedupe" ? "clean" : "shape",
    // the reshaping tools share one submenu so the Data menu fits on screen
    ...(kind === "goalseek" || kind === "dedupe" ? {} : { submenu: "Reshape" }),
    id: `transform-${kind}`,
    title,
    description,
    icon: kind === "goalseek" ? "scale" : kind === "dedupe" ? "merge" : "table",
    hint,
    run: () => openTransform(kind, { ...d.statementDeps(), source: d.source, activeSheet: d.activeSheet, sheetName, range: () => d.grid.range, selection: () => d.grid.selection }),
  }));
}

function timeTools(d: CommandDeps, sheetName: () => string, range: () => CellRange): Def[] {
  const tools: [TimeToolKind, string, string, IconName, string][] = [
    ["periods", "Period comparison (MoM / YoY / rolling)…", "Month on month, year on year, YTD and rolling averages", "chart", "month on month year on year mom yoy qoq ytd qtd rolling average trend period summary"],
    ["bva", "Budget vs actual…", "Variances against budget, favourable and unfavourable", "chart", "budget actual variance favourable unfavourable forecast plan cost centre"],
    ["fiscal", "Fiscal periods…", "Add fiscal year, quarter and period columns (4-4-5 too)", "calendar", "fiscal year quarter period 4-4-5 445 week calendar financial year column"],
    ["currency", "Convert currency…", "Convert at the right rates and see the revaluation", "scale", "currency fx exchange rate convert revalue revaluation gain loss triangulate closing rate"],
    ["schedule", "Accrual / prepayment schedule…", "Spread a cost over months, with the journals", "calendar", "accrual prepayment deferred income amortisation schedule straight line daily month end journal"],
    ["journal", "Journal export template…", "Journals in the layout your accounting system imports", "export", "journal export import template csv debit credit accounting system upload"],
  ];
  return tools.map(([kind, title, description, icon, hint]) => ({
    group: kind === "journal" ? "Reports" : "Analyse",
    section: kind === "journal" ? "export" : kind === "periods" || kind === "bva" ? "compare" : "periods",
    id: `time-${kind}`,
    title,
    description,
    icon,
    hint,
    run: () => openTimeTool(kind, { ...d.statementDeps(), workbook: d.workbook, source: d.source, activeSheet: d.activeSheet, range, selection: () => d.grid.selection, sheetName }),
  }));
}

/** Group, description and icon for the review commands reviewui.ts provides. */
function reviewMeta(c: { id: string; title: string; hint: string; run: () => unknown }): Def {
  const meta: Record<string, [string, IconName, string]> = {
    "review-note": ["A reviewer's question on this cell, open until cleared", "signoff", "notes"],
    "review-clear": ["Mark this review note as dealt with", "success", "notes"],
    "review-reopen": ["Open this review note again", "signoff", "notes"],
    "review-status": ["Sign-offs and open notes for every sheet", "signoff", "signoff"],
    "sign-prepared": ["Record who prepared this sheet, and when", "signoff", "signoff"],
    "unsign-prepared": ["Take the preparer's sign-off off this sheet", "signoff", "signoff"],
    "sign-reviewed": ["Record who reviewed this sheet, and when", "signoff", "signoff"],
    "unsign-reviewed": ["Take the reviewer's sign-off off this sheet", "signoff", "signoff"],
    "wp-ref": ["The workpaper index for this sheet, like B-3", "document", "signoff"],
    "mark-legend": ["A sheet explaining every tick mark used", "list-check", "marks"],
  };
  if (c.id.startsWith("mark:")) return { ...c, group: "Evidence & review", section: "marks", submenu: "Tick marks", description: "Mark the selection as agreed, footed, traced or vouched", icon: "audit" };
  const [description, icon, section] = meta[c.id] ?? ["Review this workbook", "signoff", "signoff"];
  return { ...c, group: "Evidence & review", section, description, icon };
}

// ------------------------------------------------------- suggestions --

/** What the shell knows about the sheet on screen, for suggestions. */
export interface SheetContext {
  sheetCount: number;
  /** nothing typed or loaded */
  empty: boolean;
  /** header names (row 1 or the column names), lower case */
  headers: string[];
  rows: number;
}

const has = (headers: string[], re: RegExp) => headers.some((h) => re.test(h));

/** Command ids worth suggesting for this sheet, best first. */
export function suggestedCommandIds(ctx: SheetContext): string[] {
  if (ctx.empty) return ctx.sheetCount > 1 ? ["reconcile", "open", "statement", "join-sheets"] : ["open", "statement", "combine-files", "template", "ai-panel"];
  const out: string[] = [];
  const amount = has(ctx.headers, /amount|debit|credit|value|total|balance|net|gross/);
  const journal = has(ctx.headers, /^(je|journal|entry)|user|posted|account/);
  const party = has(ctx.headers, /vendor|supplier|customer|payee|name|description/);
  if (ctx.sheetCount > 1) out.push("reconcile");
  if (journal && amount) out.push("je-journal");
  if (amount) out.push("audit-duplicates");
  if (amount) out.push("pivot");
  if (amount) out.push("audit-benford");
  if (party) out.push("variants");
  if (ctx.sheetCount > 1) out.push("join-sheets");
  out.push("cleanup", "profiles", "data-checks");
  return [...new Set(out)].slice(0, 5);
}

/**
 * Nothing typed or loaded on a sheet. Cheap at any size (usedRange() walks
 * every edit and, on a sorted sheet, the whole row order).
 */
export function sheetIsBlank(src: EditableSource): boolean {
  return src.editCount === 0 && src.getColumnName(0) === undefined && src.getCell(0, 0) === null;
}

/** The context for suggestions, read cheaply from a sheet (row 1 or column names; never scans data). */
export function sheetContext(wb: Workbook, src: EditableSource): SheetContext {
  const empty = sheetIsBlank(src);
  const headers: string[] = [];
  for (let c = 0; c < (empty ? 0 : Math.min(src.colCount, 40)); c++) {
    const name = src.getColumnName(c) ?? src.getCell(0, c);
    if (name !== null && name !== undefined && name !== "") headers.push(String(name).toLowerCase());
  }
  return { sheetCount: wb.sheets.length, empty, headers, rows: src.rowCount };
}
