import { ColumnLayout, columnLetter } from "./columns";
import { formatCell } from "./format";
import { readTheme } from "./theme";
import type { DataSource, GridOptions, Theme } from "./types";

const FONT = '13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HEADER_FONT = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const CELL_PADDING = 6;
const SCROLLBAR_SIZE = 10;
const MIN_THUMB = 24;

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

    this.updateRowHeaderWidth();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", this.onThemeChange);

    this.resize();
  }

  setSource(source: DataSource): void {
    this.source = source;
    this.columns = new ColumnLayout(source.colCount, this.defaultColumnWidth);
    this.scrollX = 0;
    this.scrollY = 0;
    this.updateRowHeaderWidth();
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
    ctx.restore();

    // --- headers -----------------------------------------------------------
    ctx.font = HEADER_FONT;
    ctx.textAlign = "center";
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, 0, this.width, headerHeight);
    ctx.fillRect(0, 0, rowHeaderWidth, this.height);

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

    this.drawScrollbars(bodyW, bodyH);
  }

  private drawScrollbars(bodyW: number, bodyH: number): void {
    const { ctx, theme } = this;
    const totalH = this.source.rowCount * this.rowHeight;
    const totalW = this.columns.totalWidth;

    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(this.width - SCROLLBAR_SIZE, 0, SCROLLBAR_SIZE, this.height);
    ctx.fillRect(0, this.height - SCROLLBAR_SIZE, this.width, SCROLLBAR_SIZE);

    ctx.fillStyle = theme.mutedText;
    ctx.globalAlpha = 0.5;

    if (totalH > bodyH) {
      // thumb can't shrink proportionally at 100M rows (it'd be 0.00001px),
      // so clamp it to a usable minimum size
      const thumbH = Math.max(MIN_THUMB, (bodyH / totalH) * bodyH);
      const thumbY = this.headerHeight + (this.scrollY / this.maxScrollY) * (bodyH - thumbH);
      roundRect(ctx, this.width - SCROLLBAR_SIZE + 2, thumbY, SCROLLBAR_SIZE - 4, thumbH);
    }
    if (totalW > bodyW) {
      const thumbW = Math.max(MIN_THUMB, (bodyW / totalW) * bodyW);
      const thumbX = this.rowHeaderWidth + (this.scrollX / this.maxScrollX) * (bodyW - thumbW);
      roundRect(ctx, thumbX, this.height - SCROLLBAR_SIZE + 2, thumbW, SCROLLBAR_SIZE - 4);
    }
    ctx.globalAlpha = 1;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(w, h) / 2);
  ctx.fill();
}
