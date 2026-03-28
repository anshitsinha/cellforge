import { CellEditor, type EditorRect } from "./CellEditor";
import { RowVisibility } from "./rows";
import { RowLayout } from "./rowlayout";
import type { BorderLine, BorderStyle, CellStyle } from "./types";
import { ColumnLayout, columnLetter } from "./columns";
import { formatCell } from "./format";
import { readTheme } from "./theme";
import type { CellRange, CellRef, DataSource, GridOptions, Theme } from "./types";

const FONT = '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HEADER_FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CELL_PADDING = 6;
const SCROLLBAR_SIZE = 10;
const MIN_THUMB = 24;
const RESIZE_HANDLE = 4; // px either side of a column border that counts as "grab"
const MIN_COLUMN_WIDTH = 30;
const MIN_ROW_HEIGHT = 8;
const MAX_ROW_HEIGHT = 409; // Excel's limit, in px here
const TOUCH_SCROLLBAR_ZONE = 28; // px from the right edge that grabs the scrollbar
const TAP_SLOP = 8; // px a finger can move and still count as a tap
const DOUBLE_TAP_MS = 350;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DEFAULT_PX = 13;

/** Canvas font string for a style (sizes are in points, as in Excel). */
function fontFor(style: CellStyle | null): string {
  if (!style || (!style.bold && !style.italic && !style.size && !style.font)) return FONT;
  const px = style.size ? Math.round((style.size * 4) / 3) : DEFAULT_PX;
  const family = style.font ? `"${style.font}", ${FONT_FAMILY}` : FONT_FAMILY;
  return `${style.italic ? "italic " : ""}${style.bold ? "bold " : ""}${px}px ${family}`;
}

/** Break text into lines that fit `width`, at spaces where possible. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? line + " " + word : word;
      if (!line || ctx.measureText(next).width <= width) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const BORDER_WIDTH: Record<BorderStyle, number> = { thin: 1, medium: 2, thick: 3, dashed: 1, dotted: 1, double: 1 };

interface TouchState {
  id: number;
  startX: number;
  startY: number;
  scrollX: number;
  scrollY: number;
  panning: boolean;
  samples: { t: number; x: number; y: number }[];
}

interface Thumb {
  start: number; // px along the track where the thumb begins
  size: number;
  trackStart: number;
  trackSize: number;
}

type Drag =
  | { kind: "select" }
  | { kind: "resize"; col: number; startX: number; startWidth: number }
  | { kind: "rowresize"; row: number; startY: number; startHeight: number; height: number }
  | { kind: "vscroll" | "hscroll"; startPos: number; startScroll: number };

/**
 * Canvas-based spreadsheet grid.
 *
 * Why not a big scrollable <div>? Browsers clamp element sizes (Chrome tops out
 * around 33.5M px), and 100M rows * 24px is 2.4 billion px. So instead of
 * relying on native scrolling we keep our own scroll offsets and only paint the
 * cells that intersect the viewport. Cost per frame is O(visible cells),
 * independent of how many rows the sheet has.
 */
export class Grid {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;

  private source: DataSource;
  private columns: ColumnLayout;
  private theme: Theme;

  private readonly rowHeight: number;
  /** hidden rows; drawing works in display positions, rows keep real numbers */
  private readonly hidden = new RowVisibility();
  /** hidden columns, with the width each had, to restore on unhide */
  private hiddenCols = new Map<number, number>();
  /** row heights that differ from the default, by real row */
  private customHeights = new Map<number, number>();
  private readonly rowLayout: RowLayout;
  private layoutKey = "";
  private hiddenVersion = 0;
  private heightsVersion = 0;
  /** rows 0..frozenRows-1 and columns 0..frozenCols-1 stay put when scrolling */
  private frozenRows = 0;
  private frozenCols = 0;
  private readonly headerHeight: number;
  private readonly defaultColumnWidth: number;
  private readonly touchEnabled: boolean;
  private readonly editorFontSize: number;
  private rowHeaderWidth = 50;

  private touch: TouchState | null = null;
  private momentumFrame = 0;
  private lastTap = { time: 0, row: -1, col: -1 };
  private lastTouchEnd = -Infinity;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private scrollX = 0;
  private scrollY = 0;
  private pendingFrame = 0;

  // A selection is the active cell (where typing goes, also the anchor when
  // extending) plus an extent - the opposite corner of the selected range.
  // For a single-cell selection they're the same cell.
  private active: CellRef = { row: 0, col: 0 };
  private extent: CellRef = { row: 0, col: 0 };
  private drag: Drag | null = null;

  /** Called whenever the selection changes (click, keyboard, or select()). */
  onSelectionChange: ((cell: CellRef) => void) | null = null;
  /** A row was resized by dragging its border or auto-fitted (height in px). */
  onRowResize: ((row: number, height: number) => void) | null = null;

  /** Called when the user asks to clear the selected range (Delete key). */
  onClearRange: ((range: CellRange) => void) | null = null;

  /**
   * Called when the user finishes editing a cell. The grid doesn't own the
   * data, so it's up to the caller to store the value and call invalidate().
   * An empty string means "clear the cell".
   */
  onCellEdit: ((cell: CellRef, text: string) => void) | null = null;

  private readonly editor: CellEditor;

  constructor(
    private readonly container: HTMLElement,
    source: DataSource,
    options: GridOptions = {},
  ) {
    this.rowHeight = options.rowHeight ?? 24;
    this.rowLayout = new RowLayout(this.rowHeight);
    this.headerHeight = options.headerHeight ?? 24;
    this.defaultColumnWidth = options.defaultColumnWidth ?? 110;
    this.touchEnabled = options.touch ?? true;
    this.editorFontSize = options.editorFontSize ?? 13;

    this.source = source;
    this.columns = new ColumnLayout(source.colCount, this.defaultColumnWidth);
    this.theme = readTheme(container);

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.tabIndex = 0; // so it can take keyboard focus later
    // We do our own panning for touch, so the browser mustn't also scroll or
    // zoom the page. Decorative grids leave vertical page scrolling alone.
    this.canvas.style.touchAction = this.touchEnabled ? "none" : "pan-y";
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;

    this.editor = new CellEditor(container);
    this.editor.onCommit = (text, move) => {
      this.onCellEdit?.(this.selection, text);
      const { row, col } = this.active;
      if (move === "down") this.select(row + 1, col);
      else if (move === "up") this.select(row - 1, col);
      else if (move === "right") this.select(row, col + 1);
      else if (move === "left") this.select(row, col - 1);
      if (move !== "none") this.canvas.focus();
      this.invalidate();
    };
    this.editor.onCancel = () => this.canvas.focus();

    this.updateRowHeaderWidth();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("keydown", this.onKeyDown);
    this.canvas.addEventListener("dblclick", this.onDoubleClick);
    this.canvas.addEventListener("mousemove", this.onHover);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", this.onThemeChange);

    this.resize();
  }

  setSource(source: DataSource): void {
    this.source = source;
    this.columns = new ColumnLayout(source.colCount, this.defaultColumnWidth);
    this.scrollX = 0;
    this.scrollY = 0;
    this.active = { row: 0, col: 0 };
    this.extent = { row: 0, col: 0 };
    this.updateRowHeaderWidth();
    this.invalidate();
    this.onSelectionChange?.(this.active);
  }

  /**
   * Columns were inserted or removed in the data: keep the other columns'
   * widths with them. (setSource would reset scroll and selection.)
   */
  spliceColumns(at: number, remove: number, insert: number): void {
    this.columns = this.columns.splice(at, remove, insert, this.defaultColumnWidth);
    // hidden columns move with their neighbours
    const moved = new Map<number, number>();
    for (const [c, w] of this.hiddenCols) {
      if (c < at) moved.set(c, w);
      else if (c >= at + remove) moved.set(c - remove + insert, w);
    }
    this.hiddenCols = moved;
    this.clampSelection();
    this.invalidate();
  }

  /**
   * Bring the layout in line with the data's column and row counts after a
   * change the grid didn't hear about (undo, redo, another sheet's action).
   */
  syncShape(): void {
    if (this.columns.count !== this.source.colCount) {
      this.columns = this.columns.resized(this.source.colCount, this.defaultColumnWidth);
    }
    this.clampSelection();
  }

  private clampSelection(): void {
    const maxRow = Math.max(0, this.source.rowCount - 1);
    const maxCol = Math.max(0, this.source.colCount - 1);
    const clamp = (c: CellRef) => ({ row: Math.min(c.row, maxRow), col: Math.min(c.col, maxCol) });
    this.active = clamp(this.active);
    this.extent = clamp(this.extent);
  }

  /** Rows with their own height (px), by real row; every other row is the default. */
  setRowHeights(heights: ReadonlyMap<number, number>): void {
    this.customHeights = new Map(heights);
    this.heightsVersion++;
    this.clampScroll();
    this.invalidate();
  }

  /** Height of a real row in px. */
  rowHeightOf(row: number): number {
    return this.customHeights.get(row) ?? this.rowHeight;
  }

  get defaultRowHeight(): number {
    return this.rowHeight;
  }

  /** Keep the top `rows` rows and left `cols` columns in place while scrolling. */
  setFrozen(rows: number, cols: number): void {
    this.frozenRows = Math.max(0, rows);
    this.frozenCols = Math.max(0, cols);
    this.clampScroll();
    this.invalidate();
  }

  get frozen(): { rows: number; cols: number } {
    return { rows: this.frozenRows, cols: this.frozenCols };
  }

  /** Row geometry, rebuilt only when heights, hidden rows or the row count change. */
  private get layout(): RowLayout {
    const key = `${this.hiddenVersion}:${this.heightsVersion}:${this.displayRows}`;
    if (key !== this.layoutKey) {
      this.rowLayout.update(this.customHeights, this.hidden, this.displayRows);
      this.layoutKey = key;
    }
    return this.rowLayout;
  }

  /** Frozen display rows / columns and their size in px. */
  private frozenGeometry(): { fd: number; fc: number; fh: number; fw: number } {
    const layout = this.layout;
    const fd = Math.min(this.hidden.toDisplay(Math.min(this.frozenRows, this.source.rowCount)), layout.count);
    const fc = Math.min(this.frozenCols, this.columns.count);
    return { fd, fc, fh: layout.top(fd), fw: this.columns.left(fc) };
  }

  /** Screen y of display row d (frozen rows don't scroll). */
  private rowScreenY(d: number): number {
    const fd = this.frozenRows ? this.frozenGeometry().fd : 0;
    return this.headerHeight + this.layout.top(d) - (d < fd ? 0 : this.scrollY);
  }

  private colScreenX(c: number): number {
    return this.rowHeaderWidth + this.columns.left(c) - (c < this.frozenCols ? 0 : this.scrollX);
  }

  /** A y offset inside the body (0 = just under the header) to a content offset. */
  private contentY(y: number): number {
    const fh = this.frozenRows ? this.frozenGeometry().fh : 0;
    return y < fh ? y : y + this.scrollY;
  }

  private contentX(x: number): number {
    const fw = this.frozenCols ? this.columns.left(Math.min(this.frozenCols, this.columns.count)) : 0;
    return x < fw ? x : x + this.scrollX;
  }

  /** Hide exactly these rows (inclusive intervals of real row numbers). */
  setHiddenRows(intervals: readonly [number, number][]): void {
    this.hidden.set(intervals);
    this.hiddenVersion++;
    this.snapActiveToVisible();
    this.clampScroll();
    this.invalidate();
  }

  /** Hide exactly these columns. */
  setHiddenColumns(cols: Iterable<number>): void {
    const next = new Set(cols);
    for (const [c, w] of this.hiddenCols) {
      if (!next.has(c) && c < this.columns.count) this.columns.setWidth(c, w);
    }
    const kept = new Map<number, number>();
    for (const c of next) {
      if (c >= this.columns.count) continue;
      kept.set(c, this.hiddenCols.get(c) ?? this.columns.width(c));
      this.columns.setWidth(c, 0);
    }
    this.hiddenCols = kept;
    this.snapActiveToVisible();
    this.clampScroll();
    this.invalidate();
  }

  isRowHidden(row: number): boolean {
    return this.hidden.isHidden(row);
  }

  isColumnHidden(col: number): boolean {
    return this.hiddenCols.has(col);
  }

  private get displayRows(): number {
    return Math.max(0, this.source.rowCount - this.hidden.hiddenCount);
  }

  /** Move the active cell off a row or column that just got hidden. */
  private snapActiveToVisible(): void {
    const row = this.hidden.nearest(this.active.row, 1, this.source.rowCount) ?? this.hidden.nearest(this.active.row, -1, this.source.rowCount);
    const col = this.visibleCol(this.active.col, 1) ?? this.visibleCol(this.active.col, -1);
    if (row !== null && col !== null && (row !== this.active.row || col !== this.active.col)) {
      this.active = { row, col };
      this.extent = { row, col };
    }
  }

  private visibleCol(col: number, dir: 1 | -1): number | null {
    for (let c = col; c >= 0 && c < this.columns.count; c += dir) if (!this.hiddenCols.has(c)) return c;
    return null;
  }

  /** The active cell. */
  get selection(): CellRef {
    return { ...this.active };
  }

  /** The full selected rectangle (just the active cell if nothing's extended). */
  get range(): CellRange {
    return {
      top: Math.min(this.active.row, this.extent.row),
      bottom: Math.max(this.active.row, this.extent.row),
      left: Math.min(this.active.col, this.extent.col),
      right: Math.max(this.active.col, this.extent.col),
    };
  }

  /**
   * Move the active cell (collapsing any range), or with `extend` grow the
   * range from the active cell to (row, col). Scrolls the moved corner into
   * view.
   */
  select(row: number, col: number, extend = false): void {
    row = clamp(row, 0, this.source.rowCount - 1);
    col = clamp(col, 0, this.columns.count - 1);
    const target = { row, col };
    if (extend) {
      this.setSelection(this.active, target);
    } else {
      this.setSelection(target, target);
    }
    this.scrollIntoView(row, col);
  }

  /** Select a whole rectangle, e.g. after a paste. Doesn't scroll. */
  selectRange(range: CellRange): void {
    const maxRow = this.source.rowCount - 1;
    const maxCol = this.columns.count - 1;
    this.setSelection(
      { row: clamp(range.top, 0, maxRow), col: clamp(range.left, 0, maxCol) },
      { row: clamp(range.bottom, 0, maxRow), col: clamp(range.right, 0, maxCol) },
    );
  }

  private setSelection(active: CellRef, extent: CellRef): void {
    const same =
      active.row === this.active.row &&
      active.col === this.active.col &&
      extent.row === this.extent.row &&
      extent.col === this.extent.col;
    if (same) return;
    this.active = { ...active };
    this.extent = { ...extent };
    this.invalidate();
    this.onSelectionChange?.(this.selection);
  }

  focus(): void {
    this.canvas.focus();
  }

  get isEditing(): boolean {
    return this.editor.isEditing;
  }

  /**
   * Open the in-cell editor on the active cell. With no argument it starts
   * from the cell's current text (F2 / double click); with a string it
   * replaces the contents (user just started typing).
   */
  startEditing(initialText?: string): void {
    const { row, col } = this.active;
    this.scrollIntoView(row, col);
    const text =
      initialText ?? this.source.getEditText?.(row, col) ?? formatCell(this.source.getCell(row, col));
    this.editor.open(this.cellRect(row, col), text, this.theme, this.editorFontSize);
  }

  /** Cell bounds in css px relative to the container. */
  private cellRect(row: number, col: number): EditorRect {
    const d = this.hidden.toDisplay(row);
    return {
      x: this.colScreenX(col),
      y: this.rowScreenY(d),
      width: this.columns.width(col) + 1,
      height: this.layout.height(d) + 1,
    };
  }

  scrollIntoView(row: number, col: number): void {
    // frozen rows and columns are always on screen; the rest must fit
    // between the frozen part and the far edge
    const { fd, fh, fw } = this.frozenGeometry();
    const d = this.hidden.toDisplay(row);
    if (d >= fd) {
      const top = this.layout.top(d);
      const bottom = top + this.layout.height(d);
      if (top < this.scrollY + fh) this.scrollY = top - fh;
      else if (bottom > this.scrollY + this.bodyHeight) this.scrollY = bottom - this.bodyHeight;
    }
    if (col >= this.frozenCols) {
      const left = this.columns.left(col);
      const right = left + this.columns.width(col);
      if (left < this.scrollX + fw) this.scrollX = left - fw;
      else if (right > this.scrollX + this.bodyWidth) this.scrollX = right - this.bodyWidth;
    }

    this.clampScroll();
    this.invalidate();
  }

  /** Schedule a repaint. Multiple calls in the same frame collapse into one. */
  invalidate(): void {
    if (this.pendingFrame) return;
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.draw();
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.pendingFrame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.endTouch();
    cancelAnimationFrame(this.momentumFrame);
    this.canvas.removeEventListener("keydown", this.onKeyDown);
    this.canvas.removeEventListener("dblclick", this.onDoubleClick);
    this.canvas.removeEventListener("mousemove", this.onHover);
    this.endDrag();
    this.editor.destroy();
    matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", this.onThemeChange);
    this.canvas.remove();
  }

  // ---------------------------------------------------------------------------
  // geometry

  private get bodyWidth(): number {
    return Math.max(0, this.width - this.rowHeaderWidth - SCROLLBAR_SIZE);
  }

  private get bodyHeight(): number {
    return Math.max(0, this.height - this.headerHeight - SCROLLBAR_SIZE);
  }

  private get maxScrollX(): number {
    return Math.max(0, this.columns.totalWidth - this.bodyWidth);
  }

  private get maxScrollY(): number {
    return Math.max(0, this.layout.total - this.bodyHeight);
  }

  private updateRowHeaderWidth(): void {
    // Size the row number gutter to fit the biggest row number, e.g.
    // "100000000" needs a lot more room than "100".
    this.ctx.font = HEADER_FONT;
    const widest = this.ctx.measureText(String(this.source.rowCount)).width;
    this.rowHeaderWidth = Math.ceil(Math.max(40, widest + CELL_PADDING * 2));
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.clampScroll();
    // draw synchronously so there's no blank frame while resizing
    this.draw();
  }

  private clampScroll(): void {
    this.scrollX = Math.min(Math.max(0, this.scrollX), this.maxScrollX);
    this.scrollY = Math.min(Math.max(0, this.scrollY), this.maxScrollY);
  }

  // ---------------------------------------------------------------------------
  // events

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // deltaMode 1 = lines (Firefox with a mouse wheel), 2 = pages
    const unit = e.deltaMode === 1 ? this.rowHeight : e.deltaMode === 2 ? this.bodyHeight : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    // shift+wheel scrolls sideways on Windows mice that only have one wheel
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    this.scrollX += dx;
    this.scrollY += dy;
    this.clampScroll();
    this.invalidate();
  };

  // ---------------------------------------------------------------------------
  // touch: swipe to pan (with momentum), tap to select, double-tap to edit

  private onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") this.onTouchDown(e);
    else this.onMouseDown(e);
  };

  private onTouchDown(e: PointerEvent): void {
    if (!this.touchEnabled || this.touch) return; // one finger at a time
    cancelAnimationFrame(this.momentumFrame);
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // The scrollbar is 10px wide, too thin for a finger, so give it a wider
    // touch zone. Dragging the thumb is the only sane way to cross 100M rows.
    if (x >= this.width - TOUCH_SCROLLBAR_ZONE && y >= this.headerHeight && this.verticalThumb()) {
      e.preventDefault();
      this.onScrollbarDown("vscroll", y, e.clientY);
      return;
    }

    this.touch = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollX: this.scrollX,
      scrollY: this.scrollY,
      panning: false,
      samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
    };
    window.addEventListener("pointermove", this.onTouchMove);
    window.addEventListener("pointerup", this.onTouchUp);
    window.addEventListener("pointercancel", this.onTouchCancel);
  }

  private onTouchMove = (e: PointerEvent): void => {
    const t = this.touch;
    if (!t || e.pointerId !== t.id) return;
    const dx = e.clientX - t.startX;
    const dy = e.clientY - t.startY;
    // a few px of wobble is still a tap
    if (!t.panning && Math.hypot(dx, dy) > TAP_SLOP) t.panning = true;
    if (!t.panning) return;

    this.scrollX = t.scrollX - dx;
    this.scrollY = t.scrollY - dy;
    this.clampScroll();
    this.invalidate();
    t.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    // only the last ~100ms matter for the release velocity
    while (t.samples.length > 2 && e.timeStamp - t.samples[0].t > 100) t.samples.shift();
  };

  private onTouchUp = (e: PointerEvent): void => {
    const t = this.touch;
    if (!t || e.pointerId !== t.id) return;
    this.endTouch();
    this.lastTouchEnd = e.timeStamp;

    if (t.panning) {
      // fling: carry on at the release velocity and let friction stop it
      const first = t.samples[0];
      const dt = e.timeStamp - first.t;
      if (dt > 0 && dt < 150) {
        this.startMomentum((first.x - e.clientX) / dt, (first.y - e.clientY) / dt);
      }
      return;
    }

    // it was a tap
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (y < this.headerHeight || x < this.rowHeaderWidth) {
      this.onHeaderDown(x, y, false);
      return;
    }
    const cell = this.hitTest(x, y);
    if (!cell) return;
    const prev = this.lastTap;
    const isDoubleTap =
      e.timeStamp - prev.time < DOUBLE_TAP_MS && prev.row === cell.row && prev.col === cell.col;
    this.lastTap = { time: isDoubleTap ? 0 : e.timeStamp, row: cell.row, col: cell.col };
    this.select(cell.row, cell.col);
    // Focusing the canvas doesn't pop up the on-screen keyboard (it isn't a
    // text field), which is what we want for a plain tap. A double tap opens
    // the real <input> editor, and that brings the keyboard up.
    if (isDoubleTap) this.startEditing();
    else this.canvas.focus({ preventScroll: true });
  };

  private onTouchCancel = (): void => this.endTouch();

  private endTouch(): void {
    this.touch = null;
    window.removeEventListener("pointermove", this.onTouchMove);
    window.removeEventListener("pointerup", this.onTouchUp);
    window.removeEventListener("pointercancel", this.onTouchCancel);
  }

  /** Keep scrolling after a fling, decaying exponentially (velocity in px/ms). */
  private startMomentum(vx: number, vy: number): void {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      this.scrollX += vx * dt;
      this.scrollY += vy * dt;
      // ~0.95 per 16ms frame, made frame-rate independent
      const decay = Math.pow(0.95, dt / 16);
      vx *= decay;
      vy *= decay;
      const beforeX = this.scrollX;
      const beforeY = this.scrollY;
      this.clampScroll();
      // hitting an edge kills the velocity in that direction
      if (this.scrollX !== beforeX) vx = 0;
      if (this.scrollY !== beforeY) vy = 0;
      this.draw();
      if (Math.abs(vx) > 0.02 || Math.abs(vy) > 0.02) this.momentumFrame = requestAnimationFrame(step);
    };
    this.momentumFrame = requestAnimationFrame(step);
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // row border in the row header -> resize the row
    const resizeRow = this.rowResizeHandleAt(x, y);
    if (resizeRow !== null) {
      e.preventDefault();
      const h = this.rowHeightOf(resizeRow);
      this.startDrag({ kind: "rowresize", row: resizeRow, startY: e.clientY, startHeight: h, height: h });
      return;
    }

    // column border in the header -> start resizing
    const resizeCol = this.resizeHandleAt(x, y);
    if (resizeCol !== null) {
      e.preventDefault();
      this.startDrag({
        kind: "resize",
        col: resizeCol,
        startX: e.clientX,
        startWidth: this.columns.width(resizeCol),
      });
      return;
    }

    // scrollbars
    if (x >= this.width - SCROLLBAR_SIZE && y >= this.headerHeight) {
      e.preventDefault();
      this.onScrollbarDown("vscroll", y, e.clientY);
      return;
    }
    if (y >= this.height - SCROLLBAR_SIZE && x >= this.rowHeaderWidth) {
      e.preventDefault();
      this.onScrollbarDown("hscroll", x, e.clientX);
      return;
    }

    // header clicks select whole columns / rows (corner = everything)
    if (y < this.headerHeight || x < this.rowHeaderWidth) {
      e.preventDefault();
      this.canvas.focus();
      this.onHeaderDown(x, y, e.shiftKey);
      return;
    }

    const cell = this.hitTest(x, y);
    if (!cell) return;
    // stop the browser from moving focus elsewhere / starting a text selection
    e.preventDefault();
    this.canvas.focus();
    this.select(cell.row, cell.col, e.shiftKey);
    this.startDrag({ kind: "select" });
  };

  private onHeaderDown(x: number, y: number, extend: boolean): void {
    const lastRow = this.source.rowCount - 1;
    const lastCol = this.columns.count - 1;
    const { active } = this;

    if (x < this.rowHeaderWidth && y < this.headerHeight) {
      this.setSelection({ row: 0, col: 0 }, { row: lastRow, col: lastCol });
      return;
    }
    if (y < this.headerHeight) {
      const col = this.columns.indexAt(this.contentX(x - this.rowHeaderWidth));
      if (extend) this.setSelection({ row: 0, col: active.col }, { row: lastRow, col });
      else this.setSelection({ row: 0, col }, { row: lastRow, col });
      return;
    }
    const cy = this.contentY(y - this.headerHeight);
    if (cy >= this.layout.total) return;
    const d = this.layout.indexAt(cy);
    const row = this.hidden.toRow(d);
    if (extend) this.setSelection({ row: active.row, col: 0 }, { row, col: lastCol });
    else this.setSelection({ row, col: 0 }, { row, col: lastCol });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const { row, col } = this.active;
    const pageRows = Math.max(1, Math.floor(this.bodyHeight / this.rowHeight) - 1);
    const lastRow = this.source.rowCount - 1;
    const lastCol = this.columns.count - 1;
    // ctrl on windows/linux, cmd on mac - jumps to the edge of the sheet.
    // (Excel jumps to the edge of the current data block; we don't track
    // emptiness yet so the sheet edge will do.)
    const jump = e.ctrlKey || e.metaKey;

    // editing shortcuts first
    if (e.key === "F2") {
      e.preventDefault();
      this.startEditing();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (this.onClearRange) this.onClearRange(this.range);
      else this.onCellEdit?.(this.selection, "");
      this.invalidate();
      return;
    }
    if (jump && e.key.toLowerCase() === "a") {
      e.preventDefault();
      this.setSelection({ row: 0, col: 0 }, { row: lastRow, col: lastCol });
      return;
    }
    // any printable character starts editing and replaces the cell, which is
    // how Excel/Sheets behave. key.length === 1 filters out "Shift", "F5" etc.
    if (e.key.length === 1 && !jump && !e.altKey) {
      e.preventDefault();
      this.startEditing(e.key);
      return;
    }

    // shift + navigation keys extend the range, moving its far corner
    const extend = e.shiftKey && e.key !== "Tab" && e.key !== "Enter";
    const { row: r, col: c } = extend ? this.extent : this.active;

    let next: CellRef | null = null;
    switch (e.key) {
      case "ArrowUp":
        next = { row: jump ? 0 : r - 1, col: c };
        break;
      case "ArrowDown":
        next = { row: jump ? lastRow : r + 1, col: c };
        break;
      case "ArrowLeft":
        next = { row: r, col: jump ? 0 : c - 1 };
        break;
      case "ArrowRight":
        next = { row: r, col: jump ? lastCol : c + 1 };
        break;
      case "Tab":
        next = { row, col: e.shiftKey ? col - 1 : col + 1 };
        break;
      case "Enter":
        next = { row: e.shiftKey ? row - 1 : row + 1, col };
        break;
      case "PageUp":
        next = { row: this.hidden.toRow(Math.max(0, this.hidden.toDisplay(r) - pageRows)), col: c };
        break;
      case "PageDown":
        next = { row: this.hidden.toRow(Math.min(this.displayRows - 1, this.hidden.toDisplay(r) + pageRows)), col: c };
        break;
      case "Home":
        next = jump ? { row: 0, col: 0 } : { row: r, col: 0 };
        break;
      case "End":
        next = jump ? { row: lastRow, col: lastCol } : { row: r, col: lastCol };
        break;
    }
    if (!next) return;
    e.preventDefault();
    // skip hidden rows and columns in the direction of travel
    const from = extend ? this.extent : this.active;
    const rows = this.source.rowCount;
    const nr = clamp(next.row, 0, rows - 1);
    const rowDir: 1 | -1 = nr >= from.row ? 1 : -1;
    const toRow = this.hidden.nearest(nr, rowDir, rows) ?? this.hidden.nearest(nr, rowDir === 1 ? -1 : 1, rows) ?? from.row;
    const nc = clamp(next.col, 0, this.columns.count - 1);
    const colDir: 1 | -1 = nc >= from.col ? 1 : -1;
    const toCol = this.visibleCol(nc, colDir) ?? this.visibleCol(nc, colDir === 1 ? -1 : 1) ?? from.col;
    this.select(toRow, toCol, extend);
  };

  private onScrollbarDown(kind: "vscroll" | "hscroll", pos: number, clientPos: number): void {
    const thumb = kind === "vscroll" ? this.verticalThumb() : this.horizontalThumb();
    if (!thumb) return;
    const page = kind === "vscroll" ? this.bodyHeight : this.bodyWidth;

    if (pos < thumb.start) {
      // clicked the track above/left of the thumb -> page back
      if (kind === "vscroll") this.scrollY -= page;
      else this.scrollX -= page;
    } else if (pos > thumb.start + thumb.size) {
      if (kind === "vscroll") this.scrollY += page;
      else this.scrollX += page;
    } else {
      this.startDrag({
        kind,
        startPos: clientPos,
        startScroll: kind === "vscroll" ? this.scrollY : this.scrollX,
      });
      return;
    }
    this.clampScroll();
    this.invalidate();
  }

  // Drags listen on window, not the canvas, so they keep working when the
  // mouse leaves the grid (which it always does when resizing near an edge).
  // Pointer events rather than mouse events so a finger on the scrollbar uses
  // the same drag code as a mouse.
  private startDrag(drag: Drag): void {
    this.drag = drag;
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.endDrag);
    window.addEventListener("pointercancel", this.endDrag);
  }

  private onDragMove = (e: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;

    if (drag.kind === "select") {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // dragging past an edge scrolls that way, proportional to how far out
      // the pointer is. Only happens on mousemove, which is good enough.
      const bottom = this.headerHeight + this.bodyHeight;
      const right = this.rowHeaderWidth + this.bodyWidth;
      if (y > bottom) this.scrollY += y - bottom;
      else if (y < this.headerHeight) this.scrollY -= this.headerHeight - y;
      if (x > right) this.scrollX += x - right;
      else if (x < this.rowHeaderWidth) this.scrollX -= this.rowHeaderWidth - x;
      this.clampScroll();
      this.setSelection(this.active, this.cellAtClamped(x, y));
    } else if (drag.kind === "resize") {
      const width = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + e.clientX - drag.startX);
      this.columns.setWidth(drag.col, width);
    } else if (drag.kind === "rowresize") {
      // preview locally; the owner records the final height on release
      drag.height = Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, drag.startHeight + e.clientY - drag.startY)));
      this.customHeights.set(drag.row, drag.height);
      this.heightsVersion++;
    } else {
      const vertical = drag.kind === "vscroll";
      const thumb = vertical ? this.verticalThumb() : this.horizontalThumb();
      if (!thumb) return;
      // one px of thumb movement = (scrollable distance / free track) px of
      // content. At 100M rows that's ~thousands of rows per pixel, which is
      // fine - nobody drags the thumb to find row 48,213,977.
      const free = thumb.trackSize - thumb.size;
      const max = vertical ? this.maxScrollY : this.maxScrollX;
      const delta = (vertical ? e.clientY : e.clientX) - drag.startPos;
      const next = drag.startScroll + (free > 0 ? (delta / free) * max : 0);
      if (vertical) this.scrollY = next;
      else this.scrollX = next;
    }
    this.clampScroll();
    this.invalidate();
  };

  private endDrag = (): void => {
    const drag = this.drag;
    this.drag = null;
    if (drag?.kind === "rowresize" && drag.height !== drag.startHeight) this.onRowResize?.(drag.row, drag.height);
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.endDrag);
    window.removeEventListener("pointercancel", this.endDrag);
  };

  /** Just updates the cursor so users can tell column borders are draggable. */
  private onHover = (e: MouseEvent): void => {
    if (this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    this.canvas.style.cursor =
      this.resizeHandleAt(x, y) !== null ? "col-resize" : this.rowResizeHandleAt(x, y) !== null ? "row-resize" : "default";
  };

  /** If (x, y) is on a row's bottom border inside the row header, return that (real) row. */
  private rowResizeHandleAt(x: number, y: number): number | null {
    if (x > this.rowHeaderWidth || y < this.headerHeight) return null;
    const cy = this.contentY(y - this.headerHeight);
    const layout = this.layout;
    if (layout.count === 0) return null;
    const d = layout.indexAt(cy);
    const top = layout.top(d);
    const bottom = top + layout.height(d);
    if (Math.abs(cy - bottom) <= RESIZE_HANDLE) return this.hidden.toRow(d);
    if (d > 0 && Math.abs(cy - top) <= RESIZE_HANDLE) return this.hidden.toRow(d - 1);
    return null;
  }

  /** The height a row needs to show all its text (wrapped cells grow it). */
  fitRowHeight(row: number): number {
    const { ctx } = this;
    let need = this.rowHeight;
    const cols = Math.min(this.columns.count, 4096);
    for (let c = 0; c < cols; c++) {
      const value = this.source.getCell(row, c);
      if (value === null) continue;
      const style = this.source.getStyle?.(row, c) ?? null;
      const px = style?.size ? Math.round((style.size * 4) / 3) : DEFAULT_PX;
      const lineH = Math.round(px * 1.3);
      let lines = 1;
      if (style?.wrap) {
        ctx.font = fontFor(style);
        const text = this.source.formatValue ? this.source.formatValue(value, style).text : formatCell(value);
        lines = wrapLines(ctx, text, this.columns.width(c) - 2 * CELL_PADDING).length;
      }
      need = Math.max(need, lines * lineH + 8);
    }
    return Math.min(MAX_ROW_HEIGHT, need);
  }

  /** The width a column needs for the text in the rows on screen. */
  fitColumnWidth(col: number): number {
    const { ctx } = this;
    const layout = this.layout;
    const from = layout.indexAt(this.scrollY);
    const to = Math.min(layout.count - 1, layout.indexAt(this.scrollY + this.bodyHeight));
    let need = MIN_COLUMN_WIDTH;
    ctx.font = HEADER_FONT;
    need = Math.max(need, ctx.measureText(this.source.getColumnName?.(col) ?? columnLetter(col)).width + 2 * CELL_PADDING);
    for (let d = Math.min(from, this.frozenRows); d <= to; d++) {
      const row = this.hidden.toRow(d);
      const value = this.source.getCell(row, col);
      if (value === null) continue;
      const style = this.source.getStyle?.(row, col) ?? null;
      if (style?.wrap) continue;
      ctx.font = fontFor(style);
      const text = this.source.formatValue ? this.source.formatValue(value, style).text : formatCell(value);
      need = Math.max(need, ctx.measureText(text).width + 2 * CELL_PADDING + 2);
    }
    return Math.min(1000, Math.ceil(need));
  }

  /** If (x, y) is on a column border inside the header, return that column. */
  private resizeHandleAt(x: number, y: number): number | null {
    if (y > this.headerHeight || x < this.rowHeaderWidth) return null;
    const contentX = this.contentX(x - this.rowHeaderWidth);
    const col = this.columns.indexAt(contentX);
    const right = this.columns.left(col) + this.columns.width(col);
    if (Math.abs(contentX - right) <= RESIZE_HANDLE) return col;
    // also grab when we're just past the left border of col (= right of col-1)
    if (col > 0 && Math.abs(contentX - this.columns.left(col)) <= RESIZE_HANDLE) return col - 1;
    return null;
  }

  private onDoubleClick = (e: MouseEvent): void => {
    // touch double-taps are handled in onTouchUp; some browsers also send a
    // dblclick for them, which would open the editor twice
    if (e.timeStamp - this.lastTouchEnd < 600) return;
    const rect = this.canvas.getBoundingClientRect();
    // double-click a border: fit the row or column to its contents
    const bx = e.clientX - rect.left;
    const by = e.clientY - rect.top;
    const fitRow = this.rowResizeHandleAt(bx, by);
    if (fitRow !== null) {
      const h = this.fitRowHeight(fitRow);
      if (h !== this.rowHeightOf(fitRow)) this.onRowResize?.(fitRow, h);
      return;
    }
    const fitCol = this.resizeHandleAt(bx, by);
    if (fitCol !== null) {
      this.columns.setWidth(fitCol, this.fitColumnWidth(fitCol));
      this.clampScroll();
      this.invalidate();
      return;
    }
    if (this.hitTest(e.clientX - rect.left, e.clientY - rect.top)) {
      this.startEditing();
    }
  };

  /** Map a point (css px, relative to the canvas) to a body cell, or null. */
  /**
   * For a right-click at viewport point (clientX, clientY): select what's
   * under it unless it's already inside the selection, as Excel does, and
   * say whether it was a row header, a column header or a cell.
   */
  selectForMenu(clientX: number, clientY: number): "rows" | "cols" | "cell" | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (y < this.headerHeight && x < this.rowHeaderWidth) return null;
    const r = this.range;
    if (y < this.headerHeight) {
      const col = this.columns.indexAt(this.contentX(x - this.rowHeaderWidth));
      if (col < r.left || col > r.right || r.top !== 0 || r.bottom !== this.source.rowCount - 1) this.onHeaderDown(x, y, false);
      return "cols";
    }
    if (x < this.rowHeaderWidth) {
      const cell = this.cellAtClamped(this.rowHeaderWidth, y);
      if (cell.row < r.top || cell.row > r.bottom || r.left !== 0 || r.right !== this.columns.count - 1) this.onHeaderDown(x, y, false);
      return "rows";
    }
    const cell = this.hitTest(x, y);
    if (!cell) return null;
    if (cell.row < r.top || cell.row > r.bottom || cell.col < r.left || cell.col > r.right) this.select(cell.row, cell.col);
    return "cell";
  }

  private hitTest(x: number, y: number): CellRef | null {
    if (x < this.rowHeaderWidth || y < this.headerHeight) return null;
    if (x > this.rowHeaderWidth + this.bodyWidth || y > this.headerHeight + this.bodyHeight) return null;
    const cy = this.contentY(y - this.headerHeight);
    const col = this.columns.indexAt(this.contentX(x - this.rowHeaderWidth));
    if (cy >= this.layout.total) return null;
    const d = this.layout.indexAt(cy);
    return { row: this.hidden.toRow(d), col };
  }

  /** Like hitTest, but snaps points outside the body to the nearest cell. */
  private cellAtClamped(x: number, y: number): CellRef {
    const cx = clamp(x, this.rowHeaderWidth, this.rowHeaderWidth + this.bodyWidth - 1);
    const cy = clamp(y, this.headerHeight, this.headerHeight + this.bodyHeight - 1);
    return {
      row: this.hidden.toRow(
        this.layout.indexAt(this.contentY(cy - this.headerHeight)),
      ),
      col: this.columns.indexAt(this.contentX(cx - this.rowHeaderWidth)),
    };
  }

  private onThemeChange = (): void => {
    this.theme = readTheme(this.container);
    this.invalidate();
  };

  // ---------------------------------------------------------------------------
  // painting

  /**
   * One cell's fill (optional) and text, in its style. The caller has
   * clipped to the column (or the cell).
   */
  private paintCell(row: number, col: number, x: number, y: number, w: number, h: number, fill: boolean): void {
    const { ctx } = this;
    const style = this.source.getStyle?.(row, col) ?? null;
    if (fill && style?.fill) {
      ctx.fillStyle = style.fill;
      ctx.fillRect(x, y, w, h);
    }
    const value = this.source.getCell(row, col);
    if (value === null) return;
    const shown = this.source.formatValue ? this.source.formatValue(value, style) : { text: formatCell(value) };
    const text = shown.text;
    ctx.font = fontFor(style);
    ctx.fillStyle = shown.color ?? style?.color ?? this.theme.text;
    const align = style?.align ?? (typeof value === "number" ? "right" : "left");
    ctx.textAlign = align;
    const tx = align === "left" ? x + CELL_PADDING : align === "right" ? x + w - CELL_PADDING : x + w / 2;
    const px = style?.size ? Math.round((style.size * 4) / 3) : DEFAULT_PX;
    const lineH = Math.round(px * 1.3);
    const lines = style?.wrap ? wrapLines(ctx, text, w - 2 * CELL_PADDING) : [text];
    if (lines.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }
    const block = lines.length * lineH;
    // too tall for the row (row heights come later): show the first lines
    const valign = block > h ? "top" : (style?.valign ?? "middle");
    let ty =
      valign === "top" ? y + lineH / 2 + 2 : valign === "bottom" ? y + h - block + lineH / 2 - 2 : y + h / 2 - block / 2 + lineH / 2;
    for (const line of lines) {
      ctx.fillText(line, tx, ty);
      if (style?.underline || style?.strike) {
        const tw = ctx.measureText(line).width;
        const lx = align === "left" ? tx : align === "right" ? tx - tw : tx - tw / 2;
        ctx.fillRect(lx, Math.round(ty + (style.underline ? px * 0.45 : 0)), tw, Math.max(1, Math.round(px / 14)));
        if (style.underline && style.strike) ctx.fillRect(lx, Math.round(ty), tw, Math.max(1, Math.round(px / 14)));
      }
      ty += lineH;
    }
    if (lines.length > 1) ctx.restore();
  }

  private strokeBorder(line: BorderLine, x0: number, y0: number, x1: number, y1: number): void {
    const { ctx } = this;
    const width = BORDER_WIDTH[line.style] ?? 1;
    // "auto" follows the theme, so default borders show in light and dark
    ctx.strokeStyle = line.color === "auto" ? this.theme.text : line.color;
    ctx.lineWidth = width;
    ctx.setLineDash(line.style === "dashed" ? [4, 2] : line.style === "dotted" ? [1, 2] : []);
    // crisp lines: odd widths sit on half pixels
    const off = width % 2 ? 0.5 : 0;
    const vertical = x0 === x1;
    const draw = (shift: number) => {
      ctx.beginPath();
      if (vertical) {
        const x = Math.round(x0 + shift) + off;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      } else {
        const y = Math.round(y0 + shift) + off;
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    };
    if (line.style === "double") {
      draw(-1);
      draw(1);
    } else draw(0);
  }

  private draw(): void {
    const { ctx, theme, columns, headerHeight, rowHeaderWidth } = this;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.width === 0 || this.height === 0 || columns.count === 0) return;

    const bodyW = this.bodyWidth;
    const bodyH = this.bodyHeight;
    const hidden = this.hidden;
    const layout = this.layout;
    const displayRows = layout.count;
    const realRow = (d: number) => hidden.toRow(d);
    const dispTop = (r: number) => hidden.toDisplay(r);
    const dispBottom = (r: number) => hidden.toDisplay(r + 1) - 1;
    const rowY = (d: number) => this.rowScreenY(d);
    const colX = (c: number) => this.colScreenX(c);
    const rowH = (d: number) => layout.height(d);

    // panes: frozen rows/columns first (if any), then the scrolling part
    const { fd, fc, fh, fw } = this.frozenGeometry();
    type Span = { from: number; to: number; start: number; size: number };
    const rowSpans: Span[] = [];
    if (fd > 0) rowSpans.push({ from: 0, to: fd - 1, start: headerHeight, size: Math.min(fh, bodyH) });
    if (fh < bodyH && fd < displayRows) {
      const from = Math.max(fd, layout.indexAt(this.scrollY + fh));
      let to = from;
      while (to < displayRows - 1 && rowY(to + 1) < headerHeight + bodyH) to++;
      rowSpans.push({ from, to, start: headerHeight + fh, size: bodyH - fh });
    }
    const colSpans: Span[] = [];
    if (fc > 0) colSpans.push({ from: 0, to: fc - 1, start: rowHeaderWidth, size: Math.min(fw, bodyW) });
    if (fw < bodyW && fc < columns.count) {
      const from = Math.max(fc, columns.indexAt(this.scrollX + fw));
      let to = from;
      while (to < columns.count - 1 && colX(to + 1) < rowHeaderWidth + bodyW) to++;
      colSpans.push({ from, to, start: rowHeaderWidth + fw, size: bodyW - fw });
    }

    const range = this.range;
    const sel = { top: dispTop(range.top), bottom: dispBottom(range.bottom), left: range.left, right: range.right };
    const multi = range.top !== range.bottom || range.left !== range.right;
    const { row: activeRow, col: ac } = this.active;
    const ar = hidden.isHidden(activeRow) ? -1 : dispTop(activeRow);

    ctx.font = FONT;
    ctx.textBaseline = "middle";

    for (const rs of rowSpans) {
      for (const cs of colSpans) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(cs.start, rs.start, cs.size, rs.size);
        ctx.clip();
        const yTop = rs.start;
        const yBottom = rs.start + rs.size;
        const xLeft = cs.start;
        const xRight = cs.start + cs.size;

        // cells: clip once per column so long text stays in its column
        for (let c = cs.from; c <= cs.to; c++) {
          const x = colX(c);
          const w = columns.width(c);
          if (w === 0) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, yTop, w, rs.size);
          ctx.clip();
          for (let d = rs.from; d <= rs.to; d++) this.paintCell(realRow(d), c, x, rowY(d), w, rowH(d), true);
          ctx.restore();
        }

        // grid lines, one path
        ctx.beginPath();
        for (let c = cs.from; c <= cs.to + 1; c++) {
          const x = Math.round(colX(Math.min(c, columns.count))) + 0.5;
          ctx.moveTo(x, yTop);
          ctx.lineTo(x, yBottom);
        }
        for (let d = rs.from; d <= rs.to + 1; d++) {
          const y = Math.round(rowY(d)) + 0.5;
          ctx.moveTo(xLeft, y);
          ctx.lineTo(xRight, y);
        }
        ctx.strokeStyle = theme.gridLine;
        ctx.lineWidth = 1;
        ctx.stroke();

        // cell borders, over the grid lines
        if (this.source.getStyle) {
          for (let c = cs.from; c <= cs.to; c++) {
            const w = columns.width(c);
            if (w === 0) continue;
            const x = colX(c);
            for (let d = rs.from; d <= rs.to; d++) {
              const st = this.source.getStyle(realRow(d), c);
              if (!st || !(st.borderTop || st.borderRight || st.borderBottom || st.borderLeft)) continue;
              const y = rowY(d);
              const h = rowH(d);
              if (st.borderTop) this.strokeBorder(st.borderTop, x, y, x + w, y);
              if (st.borderBottom) this.strokeBorder(st.borderBottom, x, y + h, x + w, y + h);
              if (st.borderLeft) this.strokeBorder(st.borderLeft, x, y, x, y + h);
              if (st.borderRight) this.strokeBorder(st.borderRight, x + w, y, x + w, y + h);
            }
          }
          ctx.setLineDash([]);
        }

        // selection: a range can be 100M rows tall, so edges outside this
        // pane are pinned just outside it rather than computed in pixels
        const visTop = Math.max(sel.top, rs.from);
        const visBottom = Math.min(sel.bottom, rs.to);
        const visLeft = Math.max(sel.left, cs.from);
        const visRight = Math.min(sel.right, cs.to);
        if (multi && visTop <= visBottom && visLeft <= visRight) {
          const x0 = sel.left < cs.from ? xLeft - 4 : colX(sel.left);
          const x1 = sel.right > cs.to ? xRight + 4 : colX(sel.right) + columns.width(sel.right);
          const y0 = sel.top < rs.from ? yTop - 4 : rowY(sel.top);
          const y1 = sel.bottom > rs.to ? yBottom + 4 : rowY(sel.bottom) + rowH(sel.bottom);
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = theme.accent;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
          ctx.restore();
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0));
        }

        // active cell
        if (ar >= rs.from && ar <= rs.to && ac >= cs.from && ac <= cs.to && !this.hiddenCols.has(ac)) {
          const x = colX(ac);
          const y = rowY(ar);
          const w = columns.width(ac);
          const h = rowH(ar);
          if (multi) {
            // inside a range the active cell shows as unfilled, like Excel
            ctx.fillStyle = theme.background;
            ctx.globalAlpha = 0.6;
            ctx.fillRect(x + 1, y + 1, w - 1, h - 1);
            ctx.globalAlpha = 1;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            this.paintCell(activeRow, ac, x, y, w, h, false);
            ctx.restore();
          }
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 2;
          ctx.strokeRect(Math.round(x) + 1, Math.round(y) + 1, w - 1, h - 1);
        }
        ctx.restore();
      }
    }

    // the lines under frozen rows and beside frozen columns
    ctx.fillStyle = theme.mutedText;
    if (fd > 0 && fh < bodyH) ctx.fillRect(rowHeaderWidth, headerHeight + fh - 1, bodyW, 2);
    if (fc > 0 && fw < bodyW) ctx.fillRect(rowHeaderWidth + fw - 1, headerHeight, 2, bodyH);

    // --- headers -----------------------------------------------------------
    ctx.font = HEADER_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, 0, this.width, headerHeight);
    ctx.fillRect(0, 0, rowHeaderWidth, this.height);

    for (const cs of colSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cs.start, 0, cs.size, headerHeight);
      ctx.clip();
      // tint the selected columns' headers
      const l = Math.max(sel.left, cs.from);
      const r = Math.min(sel.right, cs.to);
      if (l <= r) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = theme.accent;
        ctx.fillRect(colX(l), 0, colX(r) + columns.width(r) - colX(l), headerHeight);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = theme.mutedText;
      for (let c = cs.from; c <= cs.to; c++) {
        if (this.hiddenCols.has(c)) {
          // a hidden column: a thicker line where it sits, like Excel
          ctx.fillRect(colX(c) - 1, 0, 2, headerHeight);
          continue;
        }
        const label = this.source.getColumnName?.(c) ?? columnLetter(c);
        ctx.fillText(label, colX(c) + columns.width(c) / 2, headerHeight / 2);
      }
      ctx.restore();
    }

    for (const rs of rowSpans) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, rs.start, rowHeaderWidth, rs.size);
      ctx.clip();
      const t = Math.max(sel.top, rs.from);
      const b = Math.min(sel.bottom, rs.to);
      if (t <= b) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = theme.accent;
        ctx.fillRect(0, rowY(t), rowHeaderWidth, rowY(b) + rowH(b) - rowY(t));
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = theme.mutedText;
      for (let d = rs.from; d <= rs.to; d++) {
        const row = realRow(d);
        ctx.fillText(String(row + 1), rowHeaderWidth / 2, rowY(d) + rowH(d) / 2);
        // a hidden block just above: a thicker line, like Excel
        if (row > 0 && hidden.isHidden(row - 1)) ctx.fillRect(0, rowY(d) - 1, rowHeaderWidth, 2);
      }
      ctx.restore();
    }

    // header borders
    ctx.beginPath();
    ctx.moveTo(0, headerHeight + 0.5);
    ctx.lineTo(this.width, headerHeight + 0.5);
    ctx.moveTo(rowHeaderWidth + 0.5, 0);
    ctx.lineTo(rowHeaderWidth + 0.5, this.height);
    ctx.strokeStyle = theme.gridLine;
    ctx.stroke();

    this.drawScrollbars();

    // keep the floating editor glued to its cell if we scrolled mid-edit
    if (this.editor.isEditing) {
      this.editor.place(this.cellRect(activeRow, ac));
    }
  }

  private drawScrollbars(): void {
    const { ctx, theme } = this;

    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(this.width - SCROLLBAR_SIZE, 0, SCROLLBAR_SIZE, this.height);
    ctx.fillRect(0, this.height - SCROLLBAR_SIZE, this.width, SCROLLBAR_SIZE);

    ctx.fillStyle = theme.mutedText;
    ctx.globalAlpha = this.drag && this.drag.kind !== "resize" ? 0.8 : 0.5;

    const v = this.verticalThumb();
    if (v) roundRect(ctx, this.width - SCROLLBAR_SIZE + 2, v.start, SCROLLBAR_SIZE - 4, v.size);
    const h = this.horizontalThumb();
    if (h) roundRect(ctx, h.start, this.height - SCROLLBAR_SIZE + 2, h.size, SCROLLBAR_SIZE - 4);
    ctx.globalAlpha = 1;
  }

  private verticalThumb(): Thumb | null {
    return thumbFor(
      this.layout.total,
      this.bodyHeight,
      this.scrollY,
      this.maxScrollY,
      this.headerHeight,
    );
  }

  private horizontalThumb(): Thumb | null {
    return thumbFor(
      this.columns.totalWidth,
      this.bodyWidth,
      this.scrollX,
      this.maxScrollX,
      this.rowHeaderWidth,
    );
  }
}

function thumbFor(
  content: number,
  viewport: number,
  scroll: number,
  maxScroll: number,
  trackStart: number,
): Thumb | null {
  if (content <= viewport || maxScroll <= 0) return null;
  // the thumb can't shrink proportionally at 100M rows (it'd be a fraction of
  // a pixel), so it's clamped to a usable minimum size
  const size = Math.max(MIN_THUMB, (viewport / content) * viewport);
  const start = trackStart + (scroll / maxScroll) * (viewport - size);
  return { start, size, trackStart, trackSize: viewport };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  ctx.fill();
}
