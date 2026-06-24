/**
 * Excel files in and out of the workbook. Values go into columnar storage
 * (numbers in Float64Arrays, text dictionary-coded) so a big sheet stays
 * small; formulas, TRUE/FALSE and odd cells go in as edits.
 */
import { cfFromXlsx, cfToXlsx } from "./cfxlsx";
import { dvFromXlsx, dvToXlsx } from "./dvxlsx";
import { safeLink } from "./links";
import { readXlsx, Table, writeXlsx, type ColumnData, type XCell, type XStyle, type XWorkbook } from "@cellforge/core";
import type { CellStyle } from "@cellforge/grid";
import { EditableSource, parseInput, type Stored } from "./editable";
import { sheetNameProblem, Workbook, type Sheet } from "./workbook";

const EXCEL_ROWS = 1_048_576;
const ERROR_TEXT = /^#(N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|NULL!|SPILL!|CALC!|CYCLE!|ERROR!)$/;

/** An Excel workbook as a cellforge workbook. */
export function workbookFromXlsx(x: XWorkbook): Workbook {
  const sheets: Sheet[] = [];
  const used = new Set<string>();
  x.sheets.forEach((xs, i) => {
    const rows = Math.max(xs.rows + 100, 1000);
    const cols = Math.max(xs.cols + 5, 26);
    // per column: numbers or text, whichever the column holds
    const byCol = new Map<number, XCell[]>();
    for (const c of xs.cells) {
      const list = byCol.get(c.col);
      if (list) list.push(c);
      else byCol.set(c.col, [c]);
    }
    const columns: ColumnData[] = [];
    const edits: { row: number; col: number; value: Stored }[] = [];
    for (let c = 0; c < cols; c++) {
      const cells = byCol.get(c) ?? [];
      const plain = cells.filter((cell) => !cell.formula && !cell.error && (typeof cell.value === "number" || typeof cell.value === "string"));
      const textual = plain.some((cell) => typeof cell.value === "string");
      const name = "";
      if (!textual) {
        const values = new Float64Array(rows).fill(NaN);
        for (const cell of plain) values[cell.row] = cell.value as number;
        columns.push({ kind: "number", name, values });
      } else {
        const codes = new Uint32Array(rows);
        const dict: string[] = [];
        const lookup = new Map<string, number>();
        for (const cell of plain) {
          if (typeof cell.value === "number") {
            edits.push({ row: cell.row, col: c, value: cell.value });
            continue;
          }
          const s = cell.value as string;
          if (s === "") continue;
          let code = lookup.get(s);
          if (code === undefined) {
            dict.push(s);
            code = dict.length;
            lookup.set(s, code);
          }
          codes[cell.row] = code;
        }
        columns.push({ kind: "string", name, codes, dict });
      }
      for (const cell of cells) {
        if (cell.formula) edits.push({ row: cell.row, col: c, value: parseInput("=" + cell.formula) });
        else if (cell.error) edits.push({ row: cell.row, col: c, value: cell.error });
        else if (typeof cell.value === "boolean") edits.push({ row: cell.row, col: c, value: cell.value });
      }
    }
    const src = new EditableSource(new Table(columns));
    src.loadEdits(edits);
    // formatting: one run per column per stretch of rows with the same style
    const styled = xs.cells.filter((cell) => cell.style).sort((a, b) => a.col - b.col || a.row - b.row);
    for (let k = 0; k < styled.length; ) {
      const { col, style } = styled[k];
      let top = styled[k].row;
      let bottom = top;
      let j = k + 1;
      while (j < styled.length && styled[j].col === col && styled[j].style === style && styled[j].row === bottom + 1) bottom = styled[j++].row;
      const xstyle = x.styles[style];
      if (xstyle && Object.keys(xstyle).length) src.styles.apply(col, [[top, bottom]], xstyle as CellStyle);
      k = j;
      top = bottom;
    }
    src.merges = xs.merges.map((m) => ({ ...m }));
    if (xs.condFormats?.length) src.setCondFormats(cfFromXlsx(xs.condFormats).rules);
    if (xs.validations?.length) src.setValidations(dvFromXlsx(xs.validations).rules);
    for (const n of xs.notes ?? []) if (n.row < rows && n.col < cols) src.setExtra(n.row, n.col, { note: n.text });
    for (const l of xs.links ?? []) if (l.row < rows && l.col < cols && safeLink(l.target)) src.setExtra(l.row, l.col, { link: l.target });
    for (const [c, w] of xs.colWidths) if (c < cols) src.setColWidths([c], w);
    for (const [r, h] of xs.rowHeights) if (r < rows) src.setRowHeights(r, 1, h);
    for (const r of xs.hiddenRows) if (r < rows) src.setRowsHidden(r, 1, true);
    src.setColsHidden(xs.hiddenCols.filter((c) => c < cols), true);
    src.frozen = { ...xs.frozen };
    // sheet names: Excel's rules are ours, but guard against duplicates
    let name = xs.name;
    if (sheetNameProblem(name) || used.has(name.toLowerCase())) name = `Sheet${i + 1}`;
    used.add(name.toLowerCase());
    sheets.push({ id: `s${i + 1}`, name, source: src, ...(xs.hidden ? { hidden: true } : {}) });
  });
  if (!sheets.length) throw new Error("That workbook has no sheets cellforge can open.");
  if (sheets.every((s) => s.hidden)) delete sheets[0].hidden;
  const wb = Workbook.restore(sheets);
  for (const n of x.names) {
    try {
      wb.setName(n);
    } catch {
      // a name cellforge can't represent: skip it rather than fail the whole file
    }
  }
  return wb;
}

/** A cellforge workbook as an Excel workbook. */
export function workbookToXlsx(wb: Workbook): XWorkbook {
  const styles: XStyle[] = [{}];
  const styleIndex = new Map<string, number>([["{}", 0]]);
  const styleOf = (s: CellStyle | null): number => {
    if (!s) return 0;
    const key = JSON.stringify(s);
    let i = styleIndex.get(key);
    if (i === undefined) {
      i = styles.push({ ...(s as XStyle) }) - 1;
      styleIndex.set(key, i);
    }
    return i;
  };
  const sheets = wb.sheets.map((sheet) => {
    const src = sheet.source;
    const { rows, cols } = src.usedRange();
    if (rows > EXCEL_ROWS) throw new Error(`"${sheet.name}" has ${rows.toLocaleString()} rows; Excel files hold at most ${EXCEL_ROWS.toLocaleString()}. Save it as a .cellforge file instead.`);
    const cells: XCell[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const style = styleOf(src.getStyle(r, c));
        const text = src.getEditText(r, c);
        const shown = src.getCell(r, c);
        if (text.startsWith("=")) {
          const formula = text.slice(1);
          if (typeof shown === "string" && ERROR_TEXT.test(shown)) cells.push({ row: r, col: c, value: null, error: shown, formula, style });
          else cells.push({ row: r, col: c, value: shown, formula, style });
          continue;
        }
        const stored = src.getStored(r, c);
        const value = typeof stored === "boolean" ? stored : shown;
        if (value === null && !style) continue;
        cells.push({ row: r, col: c, value, style });
      }
    }
    const hiddenRows: number[] = [];
    for (const [a, b] of src.hiddenRowIntervals()) for (let r = a; r <= Math.min(b, EXCEL_ROWS - 1); r++) hiddenRows.push(r);
    return {
      name: sheet.name,
      ...(sheet.hidden ? { hidden: true } : {}),
      cells,
      merges: src.merges.map((m) => ({ ...m })),
      ...(src.condFormats.length ? { condFormats: cfToXlsx(src.condFormats) } : {}),
      ...(src.validations.length ? { validations: dvToXlsx(src.validations) } : {}),
      ...xlsxExtras(src),
      colWidths: [...src.columnWidths],
      hiddenCols: [...src.hiddenColumns],
      rowHeights: [...src.rowHeightsByView()],
      hiddenRows,
      frozen: { ...src.frozen },
      rows,
      cols,
    };
  });
  return { sheets, styles, names: wb.definedNames.map((n) => ({ name: n.name, formula: n.formula })) };
}

export async function openXlsx(buf: ArrayBuffer): Promise<Workbook> {
  return workbookFromXlsx(await readXlsx(buf));
}

export async function saveXlsx(wb: Workbook): Promise<Blob> {
  const bytes = await writeXlsx(workbookToXlsx(wb));
  return new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** A sheet's notes and links in Excel's terms. */
function xlsxExtras(src: EditableSource): { notes?: { row: number; col: number; text: string }[]; links?: { row: number; col: number; target: string }[] } {
  const all = src.allExtras().filter((x) => x.row < EXCEL_ROWS);
  const notes = all.flatMap((x) => (x.extra.note ? [{ row: x.row, col: x.col, text: x.extra.note }] : []));
  const links = all.flatMap((x) => (x.extra.link ? [{ row: x.row, col: x.col, target: x.extra.link }] : []));
  return { ...(notes.length ? { notes } : {}), ...(links.length ? { links } : {}) };
}
