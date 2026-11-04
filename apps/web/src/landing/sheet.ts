/**
 * The real cellforge grid, made a good citizen of a scrolling page:
 *
 * - The wheel scrolls the grid only when the pointer is meant for it: not
 *   while the page is being scrolled and the grid slides under the pointer,
 *   and not when the grid is already at its edge (then the page scrolls).
 * - On touch screens a vertical swipe scrolls the page; a tap on the sheet
 *   lets it take swipes (with a Done button to hand them back).
 * - Tab leaves the grid instead of moving between cells, so a keyboard user
 *   isn't trapped in a demo.
 * - Its colours come from the page (light or dark) and it repaints when the
 *   page's theme changes.
 *
 * Plus the frame's formula bar and status bar: the cell reference and its
 * contents, and Sum / Count / Average of the selection.
 */
import { columnLetter, Grid, type CellRange, type CellRef, type DataSource } from "@cellforge/grid";

export interface SheetView {
  widths?: ReadonlyMap<number, number> | number[];
  frozenRows?: number;
  frozenCols?: number;
  merges?: readonly CellRange[];
  hiddenRows?: [number, number][];
  hiddenCols?: Iterable<number>;
  /** a key for the widths, so the grid knows when they changed */
  key?: string;
}

export interface LiveSheetOptions {
  label: string;
  /** the frame around the grid: its .af-ref / .af-val (formula bar) and .af-status get filled in */
  frame?: HTMLElement | null;
  /** called with what was typed into a cell; return true if the sheet changed */
  onEdit?: (cell: CellRef, text: string) => boolean | void;
  onSelect?: (range: CellRange) => void;
  defaultColumnWidth?: number;
  /** status text when one cell is selected */
  idleStatus?: () => string;
}

const num = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");
const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export class LiveSheet {
  readonly grid: Grid;
  private source: DataSource;
  private readonly host: HTMLElement;
  private readonly opts: LiveSheetOptions;
  private outsideWheelAt = -Infinity;
  private aimed = false;
  private touchActive = false;
  private done: HTMLButtonElement | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(host: HTMLElement, source: DataSource, opts: LiveSheetOptions) {
    this.host = host;
    this.source = source;
    this.opts = opts;
    host.classList.add("ls");
    this.grid = new Grid(host, source, {
      wheelChaining: true,
      touch: true,
      label: opts.label,
      defaultColumnWidth: opts.defaultColumnWidth ?? 100,
      editorFontSize: coarse ? 16 : 13,
    });
    const canvas = host.querySelector("canvas")!;
    // until the sheet is tapped, a vertical swipe over it scrolls the page
    canvas.style.touchAction = "pan-y";

    this.grid.onSelectionChange = () => this.selectionChanged();
    this.grid.onCellEdit = (cell, text) => {
      if (this.opts.onEdit?.(cell, text)) this.refresh();
    };

    this.listen(host, "wheel", this.onWheel as EventListener, { capture: true, passive: true });
    this.listen(window, "wheel", ((e: WheelEvent) => {
      if (!host.contains(e.target as Node)) this.outsideWheelAt = e.timeStamp;
    }) as EventListener, { passive: true });
    this.listen(host, "mousemove", ((e: MouseEvent) => {
      // browsers send a still mouse a mousemove after the page scrolls under it
      if (e.movementX || e.movementY) this.aimed = true;
    }) as EventListener);
    this.listen(host, "mouseleave", () => (this.aimed = false));
    this.listen(host, "keydown", ((e: KeyboardEvent) => {
      if (e.key === "Tab" && !this.grid.isEditing) e.stopPropagation();
      // a read-only sheet: keys that would start typing into a cell do nothing
      else if (!opts.onEdit && !this.grid.isEditing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "F2" || e.key === "Backspace" || e.key === "Delete")) e.stopPropagation();
    }) as EventListener, { capture: true });
    if (!opts.onEdit) this.listen(host, "dblclick", ((e: MouseEvent) => e.stopPropagation()) as EventListener, { capture: true });
    this.listen(canvas, "pointerup", ((e: PointerEvent) => {
      if (e.pointerType === "touch") this.setTouchActive(true);
    }) as EventListener);
    this.listen(document, "pointerdown", ((e: PointerEvent) => {
      if (this.touchActive && !host.contains(e.target as Node)) this.setTouchActive(false);
    }) as EventListener);
    const themeWatch = new MutationObserver(() => this.grid.refreshTheme());
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    this.cleanup.push(() => themeWatch.disconnect());
    // after the constructor returns: callers often read their own sheet in idleStatus
    queueMicrotask(() => this.selectionChanged());
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }

  private onWheel = (e: WheelEvent) => {
    // the page is being scrolled and the grid just slid under a still pointer:
    // keep scrolling the page until the pointer moves
    if (!this.aimed && e.timeStamp - this.outsideWheelAt < 600) {
      this.outsideWheelAt = e.timeStamp;
      e.stopPropagation();
    }
  };

  private setTouchActive(on: boolean) {
    if (on === this.touchActive) return;
    this.touchActive = on;
    const canvas = this.host.querySelector("canvas")!;
    canvas.style.touchAction = on ? "none" : "pan-y";
    this.host.classList.toggle("ls-touch", on);
    if (on && !this.done) {
      this.done = document.createElement("button");
      this.done.type = "button";
      this.done.className = "ls-done";
      this.done.textContent = "Done";
      this.done.setAttribute("aria-label", "Done scrolling the sheet");
      this.done.addEventListener("click", () => this.setTouchActive(false));
      this.host.append(this.done);
    }
    if (this.done) this.done.hidden = !on;
  }

  /** Show a source (another sheet), with its layout. */
  show(source: DataSource, view: SheetView = {}, keepSelection = false) {
    if (source !== this.source) {
      this.source = source;
      this.grid.setSource(source);
      if (!keepSelection) {
        this.grid.selectRange({ top: 0, left: 0, bottom: 0, right: 0 });
        this.grid.scrollIntoView(0, 0);
      }
    }
    this.layout(view);
  }

  layout(view: SheetView) {
    const g = this.grid;
    g.syncShape();
    const widths = view.widths instanceof Map ? view.widths : new Map((view.widths as number[] | undefined)?.map((w, i) => [i, w]) ?? []);
    g.setColumnWidths(widths, view.key ?? `${widths.size}:${[...widths.values()].join(",")}`);
    g.setFrozen(view.frozenRows ?? 0, view.frozenCols ?? 0);
    g.setMerges(view.merges ?? []);
    g.setHiddenRows(view.hiddenRows ?? []);
    g.setHiddenColumns(view.hiddenCols ?? []);
    this.refresh();
  }

  refresh() {
    this.grid.invalidate();
    this.selectionChanged();
  }

  /**
   * Bring rows on screen with some context around them (not hard against an
   * edge), outline them, and select `select` (default: the block itself).
   */
  reveal(range: CellRange, highlight?: string, select: CellRange = range) {
    const g = this.grid;
    const last = this.source.rowCount - 1;
    g.selectRange(select);
    g.scrollIntoView(Math.min(last, range.bottom + 4), select.right);
    g.scrollIntoView(Math.max(0, range.top - 4), select.left);
    g.scrollIntoView(range.top, select.left);
    // the label column stays in view (on a phone the selection may not fit beside it)
    g.scrollIntoView(range.top, 0);
    if (highlight) g.setHighlights([{ range, color: highlight }]);
  }

  get range(): CellRange {
    return this.grid.range;
  }

  private selectionChanged() {
    const r = this.grid.range;
    const frame = this.opts.frame;
    if (frame) {
      const ref = frame.querySelector(".af-ref");
      const val = frame.querySelector(".af-val");
      const a = this.grid.selection;
      if (ref) ref.textContent = r.top === r.bottom && r.left === r.right ? `${columnLetter(a.col)}${a.row + 1}` : `${columnLetter(r.left)}${r.top + 1}:${columnLetter(r.right)}${r.bottom + 1}`;
      if (val) {
        const s = this.source;
        const text = s.getEditText?.(a.row, a.col) ?? String(s.getCell(a.row, a.col) ?? "");
        val.textContent = text;
        val.classList.toggle("is-formula", text.startsWith("="));
      }
      const status = frame.querySelector(".af-status");
      if (status) status.textContent = this.statusText(r);
    }
    this.opts.onSelect?.(r);
  }

  /** "Sum 1,234.00 · Count 3 · Average 411.33", like the app's status bar. */
  statusText(r: CellRange): string {
    if (r.top === r.bottom && r.left === r.right) return this.opts.idleStatus?.() ?? "";
    let count = 0;
    let numbers = 0;
    let sum = 0;
    let seen = 0;
    for (let row = r.top; row <= Math.min(r.bottom, this.source.rowCount - 1); row++) {
      if (this.grid.isRowHidden(row)) continue;
      for (let col = r.left; col <= Math.min(r.right, this.source.colCount - 1); col++) {
        if (++seen > 200_000) break;
        const v = this.source.getCell(row, col);
        if (v === null || v === "") continue;
        count++;
        if (typeof v === "number") {
          numbers++;
          sum += v;
        }
      }
    }
    if (!numbers) return `Count ${int.format(count)}`;
    return `Sum ${num.format(sum)} · Count ${int.format(count)} · Average ${num.format(sum / numbers)}`;
  }

  destroy() {
    for (const f of this.cleanup) f();
    this.grid.destroy();
  }
}

/** A view of a sheet that stops a few rows under its data, so a template's 2,000 empty rows don't fill the scroll. */
export function trimmed<T extends DataSource>(source: T, rows: () => number): T {
  return new Proxy(source, {
    get(target, prop) {
      if (prop === "rowCount") return Math.min(target.rowCount, rows());
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export { int };
