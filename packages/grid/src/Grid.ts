import { CellEditor, type EditorRect } from "./CellEditor";
import { ColumnLayout, columnLetter } from "./columns";
import { formatCell } from "./format";
import { readTheme } from "./theme";
import type { CellRef, DataSource, GridOptions, Theme } from "./types";

const FONT = '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HEADER_FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CELL_PADDING = 6;
const SCROLLBAR_SIZE = 10;
const MIN_THUMB = 24;
const RESIZE_HANDLE = 4; // px either side of a column border that counts as "grab"
const MIN_COLUMN_WIDTH = 30;

interface Thumb {
  start: number; // px along the track where the thumb begins
  size: number;
  trackStart: number;
  trackSize: number;
}

type Drag =
  | { kind: "resize"; col: number; startX: number; startWidth: number }
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
  private readonly headerHeight: number;
  private readonly defaultColumnWidth: number;
  private rowHeaderWidth = 50;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private scrollX = 0;
  private scrollY = 0;
  private pendingFrame = 0;

  private active: CellRef = { row: 0, col: 0 };
  private drag: Drag | null = null;

  /** Called whenever the active cell changes (click, keyboard, or select()). */
  onSelectionChange: ((cell: CellRef) => void) | null = null;

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
    this.headerHeight = options.headerHeight ?? 24;
    this.defaultColumnWidth = options.defaultColumnWidth ?? 110;

    this.source = source;
    this.columns = new ColumnLayout(source.colCount, this.defaultColumnWidth);
    this.theme = readTheme(container);

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.tabIndex = 0; // so it can take keyboard focus later
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
    this.canvas.addEventListener("mousedown", this.onMouseDown);
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
    this.updateRowHeaderWidth();
    this.invalidate();
    this.onSelectionChange?.(this.active);
  }

  get selection(): CellRef {
    return { ...this.active };
  }

  /** Move the active cell, scrolling it into view if needed. */
  select(row: number, col: number): void {
    row = clamp(row, 0, this.source.rowCount - 1);
    col = clamp(col, 0, this.columns.count - 1);
    if (row === this.active.row && col === this.active.col) return;
    this.active = { row, col };
    this.scrollIntoView(row, col);
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
    const text = initialText ?? formatCell(this.source.getCell(row, col));
    this.editor.open(this.cellRect(row, col), text, this.theme);
  }

  /** Cell bounds in css px relative to the container. */
  private cellRect(row: number, col: number): EditorRect {
    const firstRow = Math.floor(this.scrollY / this.rowHeight);
    const rowShift = this.scrollY - firstRow * this.rowHeight;
    return {
      x: this.rowHeaderWidth + this.columns.left(col) - this.scrollX,
      y: this.headerHeight + (row - firstRow) * this.rowHeight - rowShift,
      width: this.columns.width(col) + 1,
      height: this.rowHeight + 1,
    };
  }

  scrollIntoView(row: number, col: number): void {
    const top = row * this.rowHeight;
    const bottom = top + this.rowHeight;
    if (top < this.scrollY) this.scrollY = top;
    else if (bottom > this.scrollY + this.bodyHeight) this.scrollY = bottom - this.bodyHeight;

    const left = this.columns.left(col);
    const right = left + this.columns.width(col);
    if (left < this.scrollX) this.scrollX = left;
    else if (right > this.scrollX + this.bodyWidth) this.scrollX = right - this.bodyWidth;

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
    this.canvas.removeEventListener("mousedown", this.onMouseDown);
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
    return Math.max(0, this.source.rowCount * this.rowHeight - this.bodyHeight);
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

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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

    const cell = this.hitTest(x, y);
    if (!cell) return;
    // stop the browser from moving focus elsewhere / starting a text selection
    e.preventDefault();
    this.canvas.focus();
    this.select(cell.row, cell.col);
  };

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
      this.onCellEdit?.(this.selection, "");
      this.invalidate();
      return;
    }
    // any printable character starts editing and replaces the cell, which is
    // how Excel/Sheets behave. key.length === 1 filters out "Shift", "F5" etc.
    if (e.key.length === 1 && !jump && !e.altKey) {
      e.preventDefault();
      this.startEditing(e.key);
      return;
    }

    let next: CellRef | null = null;
    switch (e.key) {
      case "ArrowUp":
        next = { row: jump ? 0 : row - 1, col };
        break;
      case "ArrowDown":
        next = { row: jump ? lastRow : row + 1, col };
        break;
      case "ArrowLeft":
        next = { row, col: jump ? 0 : col - 1 };
        break;
      case "ArrowRight":
        next = { row, col: jump ? lastCol : col + 1 };
        break;
      case "Tab":
        next = { row, col: e.shiftKey ? col - 1 : col + 1 };
        break;
      case "Enter":
        next = { row: e.shiftKey ? row - 1 : row + 1, col };
        break;
      case "PageUp":
        next = { row: row - pageRows, col };
        break;
      case "PageDown":
        next = { row: row + pageRows, col };
        break;
      case "Home":
        next = jump ? { row: 0, col: 0 } : { row, col: 0 };
        break;
      case "End":
        next = jump ? { row: lastRow, col: lastCol } : { row, col: lastCol };
        break;
    }
    if (!next) return;
    e.preventDefault();
    this.select(next.row, next.col);
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
  private startDrag(drag: Drag): void {
    this.drag = drag;
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.endDrag);
  }

  private onDragMove = (e: MouseEvent): void => {
    const drag = this.drag;
    if (!drag) return;

    if (drag.kind === "resize") {
      const width = Math.max(MIN_COLUMN_WIDTH, drag.startWidth + e.clientX - drag.startX);
      this.columns.setWidth(drag.col, width);
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
    this.drag = null;
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.endDrag);
  };

  /** Just updates the cursor so users can tell column borders are draggable. */
  private onHover = (e: MouseEvent): void => {
    if (this.drag) return;
    const rect = this.canvas.getBoundingClientRect();
    const onHandle = this.resizeHandleAt(e.clientX - rect.left, e.clientY - rect.top) !== null;
    this.canvas.style.cursor = onHandle ? "col-resize" : "default";
  };

  /** If (x, y) is on a column border inside the header, return that column. */
  private resizeHandleAt(x: number, y: number): number | null {
    if (y > this.headerHeight || x < this.rowHeaderWidth) return null;
    const contentX = x - this.rowHeaderWidth + this.scrollX;
    const col = this.columns.indexAt(contentX);
    const right = this.columns.left(col) + this.columns.width(col);
    if (Math.abs(contentX - right) <= RESIZE_HANDLE) return col;
    // also grab when we're just past the left border of col (= right of col-1)
    if (col > 0 && Math.abs(contentX - this.columns.left(col)) <= RESIZE_HANDLE) return col - 1;
    return null;
  }

  private onDoubleClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (this.hitTest(e.clientX - rect.left, e.clientY - rect.top)) {
      this.startEditing();
    }
  };

  /** Map a point (css px, relative to the canvas) to a body cell, or null. */
  private hitTest(x: number, y: number): CellRef | null {
    if (x < this.rowHeaderWidth || y < this.headerHeight) return null;
    if (x > this.rowHeaderWidth + this.bodyWidth || y > this.headerHeight + this.bodyHeight) return null;
    const row = Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight);
    const col = this.columns.indexAt(x - this.rowHeaderWidth + this.scrollX);
    if (row >= this.source.rowCount) return null;
    return { row, col };
  }

  private onThemeChange = (): void => {
    this.theme = readTheme(this.container);
    this.invalidate();
  };

  // ---------------------------------------------------------------------------
  // painting

  private draw(): void {
    const { ctx, theme, columns, rowHeight, headerHeight, rowHeaderWidth } = this;
    const { rowCount } = this.source;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.width === 0 || this.height === 0 || columns.count === 0) return;

    const bodyW = this.bodyWidth;
    const bodyH = this.bodyHeight;

    // visible window
    const firstRow = Math.floor(this.scrollY / rowHeight);
    const rowShift = this.scrollY - firstRow * rowHeight; // partial row at the top
    const lastRow = Math.min(rowCount - 1, firstRow + Math.ceil(bodyH / rowHeight));
    const firstCol = columns.indexAt(this.scrollX);
    let lastCol = firstCol;
    while (lastCol < columns.count - 1 && columns.left(lastCol + 1) < this.scrollX + bodyW) {
      lastCol++;
    }

    const colX = (c: number) => rowHeaderWidth + columns.left(c) - this.scrollX;
    const rowY = (r: number) => headerHeight + (r - firstRow) * rowHeight - rowShift;

    // --- cells -------------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderWidth, headerHeight, bodyW, bodyH);
    ctx.clip();

    ctx.font = FONT;
    ctx.textBaseline = "middle";
    ctx.fillStyle = theme.text;

    for (let c = firstCol; c <= lastCol; c++) {
      const x = colX(c);
      const w = columns.width(c);
      // clip once per column rather than per cell - way cheaper and still
      // stops long strings from bleeding into the next column
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, headerHeight, w, bodyH);
      ctx.clip();
      for (let r = firstRow; r <= lastRow; r++) {
        const value = this.source.getCell(r, c);
        if (value === null) continue;
        const text = formatCell(value);
        const y = rowY(r) + rowHeight / 2;
        if (typeof value === "number") {
          ctx.textAlign = "right";
          ctx.fillText(text, x + w - CELL_PADDING, y);
        } else {
          ctx.textAlign = "left";
          ctx.fillText(text, x + CELL_PADDING, y);
        }
      }
      ctx.restore();
    }

    // grid lines - one path for everything, single stroke call
    ctx.beginPath();
    for (let c = firstCol; c <= lastCol + 1; c++) {
      const x = Math.round(colX(Math.min(c, columns.count))) + 0.5;
      ctx.moveTo(x, headerHeight);
      ctx.lineTo(x, headerHeight + bodyH);
    }
    for (let r = firstRow; r <= lastRow + 1; r++) {
      const y = Math.round(rowY(r)) + 0.5;
      ctx.moveTo(rowHeaderWidth, y);
      ctx.lineTo(rowHeaderWidth + bodyW, y);
    }
    ctx.strokeStyle = theme.gridLine;
    ctx.lineWidth = 1;
    ctx.stroke();

    // active cell outline (drawn even if partly off-screen; the clip handles it)
    const { row: ar, col: ac } = this.active;
    if (ar >= firstRow && ar <= lastRow && ac >= firstCol && ac <= lastCol) {
      ctx.strokeStyle = theme.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(
        Math.round(colX(ac)) + 1,
        Math.round(rowY(ar)) + 1,
        columns.width(ac) - 1,
        rowHeight - 1,
      );
    }
    ctx.restore();

    // --- headers -----------------------------------------------------------
    ctx.font = HEADER_FONT;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, 0, this.width, headerHeight);
    ctx.fillRect(0, 0, rowHeaderWidth, this.height);

    // tint the headers of the active row/column so it's easy to find your place
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = theme.accent;
    if (ac >= firstCol && ac <= lastCol) {
      ctx.fillRect(Math.max(rowHeaderWidth, colX(ac)), 0, columns.width(ac), headerHeight);
    }
    if (ar >= firstRow && ar <= lastRow) {
      ctx.fillRect(0, Math.max(headerHeight, rowY(ar)), rowHeaderWidth, rowHeight);
    }
    ctx.restore();

    // column headers
    ctx.save();
    ctx.beginPath();
    ctx.rect(rowHeaderWidth, 0, bodyW, headerHeight);
    ctx.clip();
    ctx.fillStyle = theme.mutedText;
    for (let c = firstCol; c <= lastCol; c++) {
      const label = this.source.getColumnName?.(c) ?? columnLetter(c);
      ctx.fillText(label, colX(c) + columns.width(c) / 2, headerHeight / 2);
    }
    ctx.restore();

    // row numbers (1-based, like every other spreadsheet)
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, headerHeight, rowHeaderWidth, bodyH);
    ctx.clip();
    ctx.fillStyle = theme.mutedText;
    for (let r = firstRow; r <= lastRow; r++) {
      ctx.fillText(String(r + 1), rowHeaderWidth / 2, rowY(r) + rowHeight / 2);
    }
    ctx.restore();

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
      this.editor.place(this.cellRect(ar, ac));
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
      this.source.rowCount * this.rowHeight,
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
