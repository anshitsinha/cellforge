/** A neutral picture of an .xlsx workbook, between the file and the app. */

export interface XStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** points */
  size?: number;
  font?: string;
  color?: string;
  fill?: string;
  align?: "left" | "center" | "right" | "centerAcross";
  valign?: "top" | "middle" | "bottom";
  wrap?: boolean;
  numFmt?: string;
  borderTop?: XBorder;
  borderRight?: XBorder;
  borderBottom?: XBorder;
  borderLeft?: XBorder;
}

export interface XBorder {
  style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
  color: string;
}

export interface XCell {
  row: number;
  col: number;
  /** the value (for formulas, the cached result Excel saved) */
  value: number | string | boolean | null;
  /** an error value like "#N/A" */
  error?: string;
  /** without the "=" and without _xlfn. prefixes */
  formula?: string;
  /** index into XWorkbook.styles; 0 is the default */
  style: number;
}

export interface XRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A conditional format's look (Excel's "dxf"). */
export interface XDxf {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
}

/** A colour scale / data bar / icon set point. */
export interface XCfvo {
  type: string;
  val?: string;
}

/** One conditional formatting rule as Excel stores it (formulas in Excel syntax, for the range's top-left cell). */
export interface XCondFormat {
  ranges: XRange[];
  /** cellIs, expression, containsText, notContainsText, beginsWith, endsWith, timePeriod, containsBlanks, notContainsBlanks, containsErrors, notContainsErrors, duplicateValues, uniqueValues, top10, aboveAverage, colorScale, dataBar, iconSet */
  type: string;
  operator?: string;
  formulas: string[];
  text?: string;
  timePeriod?: string;
  rank?: number;
  percent?: boolean;
  bottom?: boolean;
  aboveAverage?: boolean;
  equalAverage?: boolean;
  stopIfTrue?: boolean;
  dxf?: XDxf;
  cfvos?: XCfvo[];
  colors?: string[];
  iconSet?: string;
  reverse?: boolean;
  showValue?: boolean;
}

export interface XSheet {
  name: string;
  hidden?: boolean;
  /** conditional formatting, in priority order */
  condFormats?: XCondFormat[];
  cells: XCell[];
  merges: XRange[];
  /** pixels */
  colWidths: [number, number][];
  hiddenCols: number[];
  /** pixels */
  rowHeights: [number, number][];
  hiddenRows: number[];
  frozen: { rows: number; cols: number };
  /** the last row and column with anything, for sizing */
  rows: number;
  cols: number;
}

export interface XWorkbook {
  sheets: XSheet[];
  styles: XStyle[];
  names: { name: string; formula: string }[];
}

// Excel's width unit is the width of "0" in the default font (7px) plus padding
export const widthToPx = (w: number) => Math.round(w * 7 + 5);
export const pxToWidth = (px: number) => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
export const pointsToPx = (pt: number) => Math.round((pt * 4) / 3);
export const pxToPoints = (px: number) => Math.round(px * 0.75 * 100) / 100;

/** A1 -> [row, col] (0-based). */
export function parseA1(ref: string): [number, number] {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Bad cell reference ${ref}`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]) - 1, col - 1];
}

export function toA1(row: number, col: number): string {
  let s = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${row + 1}`;
}

/** Functions Excel writes with a _xlfn. prefix in files (newer than Excel 2007). */
export const PREFIXED = new Set(
  (
    "XLOOKUP XMATCH FILTER SORT SORTBY UNIQUE SEQUENCE LET LAMBDA IFS SWITCH MAXIFS MINIFS TEXTJOIN CONCAT IFNA XOR DAYS ISOWEEKNUM " +
    "STDEV.S STDEV.P VAR.S VAR.P MODE.SNGL PERCENTILE.INC QUARTILE.INC RANK.EQ TEXTBEFORE TEXTAFTER VSTACK HSTACK TAKE DROP TOCOL TOROW " +
    "CHOOSECOLS CHOOSEROWS MAP REDUCE SCAN BYROW BYCOL MAKEARRAY NUMBERVALUE CEILING.MATH FLOOR.MATH"
  ).split(" "),
);
/** ...and these get _xlfn._xlws. */
export const WORKSHEET_PREFIXED = new Set(["FILTER", "SORT"]);
