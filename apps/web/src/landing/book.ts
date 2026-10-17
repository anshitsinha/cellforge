/**
 * A sample workbook, exactly as the app opens it (`sampleWorkbook`), with
 * the app's action registry and undo history around it: what the close,
 * evidence and ask demos change goes through the same actions as an edit in
 * the app. Sorting runs on this thread (the samples are small) instead of in
 * the app's worker.
 */
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { radixSortIndices } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "../actions";
import type { EditableSource } from "../editable";
import { sampleWorkbook, type SampleKind } from "../samples";
import { extractKeys } from "../sort";
import type { Workbook } from "../workbook";
import { trimmed, type LiveSheet, type SheetView } from "./sheet";
import { allMarks } from "../review";

export interface Book {
  wb: Workbook;
  ctx: SheetCtx;
  history: ActionHistory<SheetCtx>;
  registry: ReturnType<typeof sheetActions>;
  run(action: Action): Promise<boolean>;
  undo(): Promise<string | null>;
  /** type into cells, as a person would */
  type(sheetId: string, cells: { row: number; col: number; input: string | null }[]): Promise<boolean>;
  /** the sheet as the grid should see it: stopping a few rows under its data */
  view(sheetId: string): EditableSource;
  layout(sheetId: string): SheetView;
  /** rows down to the last one that shows anything, header included */
  rows(sheetId: string): number;
  /** show a sheet in a live grid, with its layout */
  show(sheet: LiveSheet, sheetId: string, keepSelection?: boolean): void;
}

export async function openBook(kind: SampleKind): Promise<Book> {
  const { workbook: wb } = await sampleWorkbook(kind);
  const registry = sheetActions();
  const ctx: SheetCtx = {
    workbook: wb,
    activeSheet: wb.sheets[0].id,
    blobs: new BlobStore(),
    sortRows: async (src, col, descending) => {
      const { keys, kinds } = await extractKeys(src, col, descending);
      return radixSortIndices(keys, kinds, descending);
    },
  };
  const history = new ActionHistory(registry, () => ctx);
  // tick marks look the same as in the app
  const looks = new Map(allMarks(wb.review).map((m) => [m.id, { glyph: m.glyph, color: m.color }]));
  for (const s of wb.sheets) s.source.markLook = (id) => looks.get(id) ?? { glyph: "?", color: "#5f6368" };

  const used = new Map<string, number>();
  const views = new Map<string, EditableSource>();
  const usedRows = (id: string) => {
    let n = used.get(id);
    if (n === undefined) {
      // templates fill formulas down 2,000 rows; the data ends where they stop showing anything
      const src = wb.get(id).source;
      const { rows, cols } = src.usedRange();
      const blank = (r: number) => {
        for (let c = 0; c < cols; c++) {
          const v = src.getCell(r, c);
          if (v !== null && v !== "") return false;
        }
        return true;
      };
      // from the top: the samples' data is one block (with the odd blank line
      // in it), so a run of blank rows means it's over; cheaper than working
      // up through 2,000 rows of formulas that show nothing
      let last = 0;
      let gap = 0;
      for (let r = 0; r < rows && gap < 8; r++) {
        if (blank(r)) gap++;
        else {
          last = r;
          gap = 0;
        }
      }
      n = last + 1;
      used.set(id, n);
    }
    return n;
  };
  const book: Book = {
    wb,
    ctx,
    history,
    registry,
    async run(action) {
      const done = await history.run(action, "user");
      used.clear();
      for (const s of wb.sheets) s.source.invalidateCondFormats();
      return !!done;
    },
    async undo() {
      const label = await history.undo();
      used.clear();
      for (const s of wb.sheets) s.source.invalidateCondFormats();
      return label;
    },
    type(sheetId, cells) {
      ctx.activeSheet = sheetId;
      return book.run(setCells(cells));
    },
    view(id) {
      let v = views.get(id);
      if (!v) {
        v = trimmed(wb.get(id).source, () => usedRows(id) + 6);
        views.set(id, v);
      }
      return v;
    },
    rows: (id) => usedRows(id),
    layout(id) {
      const src = wb.get(id).source;
      return {
        widths: src.columnWidths,
        key: `${id}:${src.columnWidthsVersion}:${src.colCount}`,
        frozenRows: src.frozen.rows,
        frozenCols: src.frozen.cols,
        merges: src.getMerges(),
        hiddenRows: src.hiddenRowIntervals(),
        hiddenCols: src.hiddenColumns,
      };
    },
    show(sheet, id, keepSelection = false) {
      ctx.activeSheet = id;
      sheet.show(book.view(id), book.layout(id), keepSelection);
    },
  };
  return book;
}
