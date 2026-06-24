/**
 * .xlsx reader: zip -> XWorkbook. XML is scanned with regular expressions
 * rather than a DOM, which keeps big sheets fast and works anywhere
 * (browser, worker, tests).
 */
import { moveFormula } from "../formula/move";
import { parseFormula } from "../formula/parser";
import { formatFormula } from "../formula/print";
import { parseA1, pointsToPx, widthToPx, type XBorder, type XCell, type XCondFormat, type XDxf, type XRange, type XSheet, type XStyle, type XValidation, type XWorkbook } from "./model";
import { text, unzip } from "./zip";

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e],
  );
}

export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].replace(/^\w+:/, (p) => (p === "r:" ? "r:" : ""))] = unescapeXml(m[3] ?? m[4] ?? "");
  return out;
}

/** Every <tag ...>inner</tag> or <tag .../> in xml, as [attributes, inner]. */
export function* each(xml: string, tag: string): Generator<[Record<string, string>, string]> {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, "g");
  for (const m of xml.matchAll(re)) yield [attrs(m[1]), m[2] ?? ""];
}

const first = (xml: string, tag: string) => each(xml, tag).next().value as [Record<string, string>, string] | undefined;

/** Text of <t> runs (shared strings and inline strings, with rich-text runs joined). */
function stringOf(xml: string): string {
  let out = "";
  for (const [, inner] of each(xml, "t")) out += unescapeXml(inner);
  return out;
}

const THEME = ["#FFFFFF", "#000000", "#E7E6E6", "#44546A", "#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47"];
const INDEXED: Record<number, string> = { 8: "#000000", 9: "#FFFFFF", 10: "#FF0000", 11: "#00FF00", 12: "#0000FF", 13: "#FFFF00", 14: "#FF00FF", 15: "#00FFFF", 64: "#000000" };

function colorOf(a: Record<string, string> | undefined): string | undefined {
  if (!a) return undefined;
  if (a.rgb) return "#" + a.rgb.slice(-6).toLowerCase();
  if (a.theme !== undefined) return THEME[Number(a.theme)]?.toLowerCase();
  if (a.indexed !== undefined) return INDEXED[Number(a.indexed)]?.toLowerCase();
  return undefined;
}

const BUILTIN_FORMATS: Record<number, string> = {
  1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
  14: "m/d/yyyy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
  22: "m/d/yyyy h:mm", 37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)', 45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
};

const BORDER_STYLES: Record<string, XBorder["style"]> = {
  thin: "thin", hair: "thin", medium: "medium", thick: "thick", dashed: "dashed", mediumDashed: "dashed", dotted: "dotted", double: "double",
  dashDot: "dashed", mediumDashDot: "dashed", dashDotDot: "dotted", mediumDashDotDot: "dotted", slantDashDot: "dashed",
};

export function readStyles(xml: string): XStyle[] {
  const fmts = new Map<number, string>();
  for (const [a] of each(xml, "numFmt")) fmts.set(Number(a.numFmtId), a.formatCode);
  const fonts = [...each(first(xml, "fonts")?.[1] ?? "", "font")].map(([, inner]) => {
    const f: XStyle = {};
    if (/<b\b(?![^>]*val="(0|false)")/.test(inner)) f.bold = true;
    if (/<i\b(?![^>]*val="(0|false)")/.test(inner)) f.italic = true;
    if (/<u\b(?![^>]*val="none")/.test(inner)) f.underline = true;
    if (/<strike\b(?![^>]*val="(0|false)")/.test(inner)) f.strike = true;
    const sz = first(inner, "sz")?.[0].val;
    if (sz && Number(sz) !== 11) f.size = Number(sz);
    const name = first(inner, "name")?.[0].val;
    if (name && name !== "Calibri" && name !== "Aptos Narrow") f.font = name;
    const c = colorOf(first(inner, "color")?.[0]);
    if (c && c !== "#000000") f.color = c;
    return f;
  });
  const fills = [...each(first(xml, "fills")?.[1] ?? "", "fill")].map(([, inner]) => {
    const p = first(inner, "patternFill");
    if (!p || p[0].patternType !== "solid") return undefined;
    return colorOf(first(p[1], "fgColor")?.[0]);
  });
  const borders = [...each(first(xml, "borders")?.[1] ?? "", "border")].map(([, inner]) => {
    const b: XStyle = {};
    for (const [side, key] of [["top", "borderTop"], ["right", "borderRight"], ["bottom", "borderBottom"], ["left", "borderLeft"]] as const) {
      const e = first(inner, side);
      const style = e?.[0].style && BORDER_STYLES[e[0].style];
      if (style) b[key] = { style, color: colorOf(first(e[1], "color")?.[0]) ?? "auto" };
    }
    return b;
  });
  return [...each(first(xml, "cellXfs")?.[1] ?? "", "xf")].map(([a, inner]) => {
    const s: XStyle = { ...(fonts[Number(a.fontId ?? 0)] ?? {}), ...(borders[Number(a.borderId ?? 0)] ?? {}) };
    const fill = fills[Number(a.fillId ?? 0)];
    if (fill) s.fill = fill;
    const id = Number(a.numFmtId ?? 0);
    const code = fmts.get(id) ?? BUILTIN_FORMATS[id];
    if (id !== 0 && code && code !== "General") s.numFmt = code;
    const al = first(inner, "alignment")?.[0];
    if (al) {
      if (al.horizontal === "left" || al.horizontal === "center" || al.horizontal === "right") s.align = al.horizontal;
      if (al.horizontal === "centerContinuous") s.align = "centerAcross";
      if (al.vertical === "top" || al.vertical === "bottom") s.valign = al.vertical;
      if (al.vertical === "center") s.valign = "middle";
      if (al.wrapText === "1" || al.wrapText === "true") s.wrap = true;
    }
    return s;
  });
}

/** Excel's formula text to ours: drop _xlfn./_xlws./_xlpm. prefixes. */
export function cleanFormula(f: string): string {
  return f.replace(/_xlfn\.|_xlws\.|_xlpm\./g, "");
}

function rangeOf(ref: string): XRange {
  const [a, b] = ref.split(":");
  const [r0, c0] = parseA1(a);
  const [r1, c1] = b ? parseA1(b) : [r0, c0];
  return { top: Math.min(r0, r1), left: Math.min(c0, c1), bottom: Math.max(r0, r1), right: Math.max(c0, c1) };
}

/** The looks conditional formats refer to by dxfId. */
export function readDxfs(xml: string): XDxf[] {
  return [...each(first(xml, "dxfs")?.[1] ?? "", "dxf")].map(([, inner]) => {
    const d: XDxf = {};
    const font = first(inner, "font")?.[1] ?? "";
    if (/<b\b(?![^>]*val="(0|false)")/.test(font)) d.bold = true;
    if (/<i\b(?![^>]*val="(0|false)")/.test(font)) d.italic = true;
    if (/<strike\b(?![^>]*val="(0|false)")/.test(font)) d.strike = true;
    const color = colorOf(first(font, "color")?.[0]);
    if (color) d.color = color;
    const fill = first(inner, "fill")?.[1] ?? "";
    // a dxf's solid fill colour is its bgColor (fgColor in some writers)
    const bg = colorOf(first(fill, "bgColor")?.[0]) ?? colorOf(first(fill, "fgColor")?.[0]);
    if (bg) d.fill = bg;
    return d;
  });
}

const bool = (v: string | undefined) => v === "1" || v === "true";

/** A sheet's conditional formatting, highest priority first. */
export function readCondFormats(xml: string, dxfs: XDxf[]): XCondFormat[] {
  const out: (XCondFormat & { priority: number })[] = [];
  for (const [a, inner] of each(xml, "conditionalFormatting")) {
    const ranges = (a.sqref ?? "").split(/\s+/).filter(Boolean).map(rangeOf);
    if (!ranges.length) continue;
    for (const [r, body] of each(inner, "cfRule")) {
      const cf: XCondFormat & { priority: number } = {
        ranges,
        type: r.type,
        formulas: [...each(body, "formula")].map(([, f]) => cleanFormula(unescapeXml(f))),
        priority: Number(r.priority ?? 1e9),
      };
      if (r.operator) cf.operator = r.operator;
      if (r.text !== undefined) cf.text = r.text;
      if (r.timePeriod) cf.timePeriod = r.timePeriod;
      if (r.rank) cf.rank = Number(r.rank);
      if (bool(r.percent)) cf.percent = true;
      if (bool(r.bottom)) cf.bottom = true;
      if (r.aboveAverage !== undefined) cf.aboveAverage = bool(r.aboveAverage);
      if (bool(r.equalAverage)) cf.equalAverage = true;
      if (bool(r.stopIfTrue)) cf.stopIfTrue = true;
      if (r.dxfId !== undefined && dxfs[Number(r.dxfId)]) cf.dxf = { ...dxfs[Number(r.dxfId)] };
      const scale = first(body, "colorScale") ?? first(body, "dataBar") ?? first(body, "iconSet");
      if (scale) {
        cf.cfvos = [...each(scale[1], "cfvo")].map(([v]) => ({ type: v.type, ...(v.val !== undefined ? { val: v.val } : {}) }));
        const colors = [...each(scale[1], "color")].map(([c]) => colorOf(c)).filter((c): c is string => !!c);
        if (colors.length) cf.colors = colors;
        if (scale[0].showValue !== undefined) cf.showValue = bool(scale[0].showValue);
        if (scale[0].iconSet) cf.iconSet = scale[0].iconSet;
        if (cf.type === "iconSet" && !cf.iconSet) cf.iconSet = "3TrafficLights1"; // Excel's default
        if (bool(scale[0].reverse)) cf.reverse = true;
      }
      out.push(cf);
    }
  }
  return out.sort((x, y) => x.priority - y.priority).map(({ priority: _p, ...cf }) => cf);
}

/** A sheet's data validation rules. */
export function readValidations(xml: string): XValidation[] {
  const out: XValidation[] = [];
  for (const [a, inner] of each(first(xml, "dataValidations")?.[1] ?? "", "dataValidation")) {
    const ranges = (a.sqref ?? "").split(/\s+/).filter(Boolean).map(rangeOf);
    if (!ranges.length) continue;
    const v: XValidation = { ranges, type: a.type ?? "none" };
    if (a.operator) v.operator = a.operator;
    const f1 = first(inner, "formula1")?.[1];
    const f2 = first(inner, "formula2")?.[1];
    if (f1 !== undefined) v.formula1 = cleanFormula(unescapeXml(f1));
    if (f2 !== undefined) v.formula2 = cleanFormula(unescapeXml(f2));
    // Excel's default when the attribute is missing is to not allow blanks
    v.allowBlank = bool(a.allowBlank);
    if (bool(a.showDropDown)) v.dropdown = false;
    if (a.promptTitle) v.promptTitle = a.promptTitle;
    if (a.prompt) v.prompt = a.prompt;
    if (a.errorStyle) v.errorStyle = a.errorStyle;
    if (a.errorTitle) v.errorTitle = a.errorTitle;
    if (a.error) v.error = a.error;
    out.push(v);
  }
  return out;
}

export function readSheet(xml: string, name: string, shared: string[], dxfs: XDxf[] = []): XSheet {
  const cells: XCell[] = [];
  const rowHeights: [number, number][] = [];
  const hiddenRows: number[] = [];
  const sharedFormulas = new Map<string, { row: number; col: number; formula: string }>();
  let rows = 0;
  let cols = 0;
  const data = /<sheetData\b[^>]*>([\s\S]*)<\/sheetData>/.exec(xml)?.[1] ?? "";
  let rowIndex = -1;
  for (const rowMatch of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rowMatch[1]);
    rowIndex = ra.r ? Number(ra.r) - 1 : rowIndex + 1;
    if (ra.customHeight === "1" && ra.ht) rowHeights.push([rowIndex, pointsToPx(Number(ra.ht))]);
    if (ra.hidden === "1" || ra.hidden === "true") hiddenRows.push(rowIndex);
    let colIndex = -1;
    for (const c of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1]);
      let row = rowIndex;
      let col = colIndex + 1;
      if (a.r) [row, col] = parseA1(a.r);
      colIndex = col;
      const inner = c[2] ?? "";
      const style = Number(a.s ?? 0);
      const fMatch = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
      let formula: string | undefined;
      if (fMatch) {
        const fa = attrs(fMatch[1]);
        const body = fMatch[2] !== undefined ? cleanFormula(unescapeXml(fMatch[2])) : "";
        if (fa.t === "shared" && fa.si !== undefined) {
          if (body) {
            sharedFormulas.set(fa.si, { row, col, formula: body });
            formula = body;
          } else {
            // a copy of the shared formula, moved to this cell
            const master = sharedFormulas.get(fa.si);
            if (master) {
              try {
                formula = formatFormula(moveFormula(parseFormula("=" + master.formula), row - master.row, col - master.col)).replace(/^=/, "");
              } catch {
                formula = undefined;
              }
            }
          }
        } else if (body) formula = body;
      }
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value: XCell["value"] = null;
      let error: string | undefined;
      switch (a.t) {
        case "s":
          value = v !== undefined ? (shared[Number(v)] ?? "") : null;
          break;
        case "inlineStr":
          value = stringOf(inner);
          break;
        case "str":
          value = v !== undefined ? unescapeXml(v) : "";
          break;
        case "b":
          value = v === "1";
          break;
        case "e":
          error = v !== undefined ? unescapeXml(v) : "#N/A";
          break;
        default:
          value = v !== undefined && v !== "" ? Number(v) : null;
      }
      if (value === null && !formula && !error && style === 0) continue;
      cells.push({ row, col, value, style, ...(formula ? { formula } : {}), ...(error ? { error } : {}) });
      rows = Math.max(rows, row + 1);
      cols = Math.max(cols, col + 1);
    }
  }
  const colWidths: [number, number][] = [];
  const hiddenCols: number[] = [];
  for (const [a] of each(first(xml, "cols")?.[1] ?? "", "col")) {
    const lo = Number(a.min) - 1;
    const hi = Math.min(Number(a.max) - 1, lo + 16_383);
    for (let c = lo; c <= hi && c < 16_384; c++) {
      if (a.width && (a.customWidth === "1" || a.customWidth === "true")) colWidths.push([c, widthToPx(Number(a.width))]);
      if (a.hidden === "1" || a.hidden === "true") hiddenCols.push(c);
      if (hi - lo > 200) break; // a style applied to thousands of columns: widths only matter near the data
    }
  }
  const merges = [...each(first(xml, "mergeCells")?.[1] ?? "", "mergeCell")].map(([a]) => rangeOf(a.ref));
  const frozen = { rows: 0, cols: 0 };
  const pane = first(xml, "pane")?.[0];
  if (pane && (pane.state === "frozen" || pane.state === "frozenSplit")) {
    frozen.rows = Number(pane.ySplit ?? 0);
    frozen.cols = Number(pane.xSplit ?? 0);
  }
  for (const m of merges) {
    rows = Math.max(rows, m.bottom + 1);
    cols = Math.max(cols, m.right + 1);
  }
  const condFormats = xml.includes("conditionalFormatting") ? readCondFormats(xml, dxfs) : [];
  const validations = xml.includes("dataValidation") ? readValidations(xml) : [];
  return {
    name,
    cells,
    merges,
    colWidths,
    hiddenCols,
    rowHeights,
    hiddenRows,
    frozen,
    rows,
    cols,
    ...(condFormats.length ? { condFormats } : {}),
    ...(validations.length ? { validations } : {}),
  };
}

/** A part's path relative to another part (../comments1.xml from xl/worksheets/sheet1.xml). */
function resolvePart(from: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = from.split("/").slice(0, -1);
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** A sheet's links (hyperlinks) and notes (comments), from its relationships. */
function readSheetExtras(sheet: XSheet, xml: string, files: Map<string, Uint8Array>, path: string): void {
  const relsPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = new Map<string, { type: string; target: string; external: boolean }>();
  for (const [a] of each(text(files.get(relsPath)), "Relationship")) rels.set(a.Id, { type: a.Type ?? "", target: a.Target ?? "", external: a.TargetMode === "External" });
  const links: NonNullable<XSheet["links"]> = [];
  for (const [a] of each(first(xml, "hyperlinks")?.[1] ?? "", "hyperlink")) {
    if (!a.ref) continue;
    const r = rangeOf(a.ref);
    const rel = a["r:id"] ? rels.get(a["r:id"]) : undefined;
    let target = rel?.target ?? "";
    if (a.location) target = target ? `${target}#${a.location}` : `#${a.location}`;
    if (target) links.push({ row: r.top, col: r.left, target });
  }
  if (links.length) sheet.links = links;
  const notes: NonNullable<XSheet["notes"]> = [];
  for (const rel of rels.values()) {
    if (!/\/comments$/.test(rel.type)) continue;
    const cx = text(files.get(resolvePart(path, rel.target)));
    const authors = [...each(first(cx, "authors")?.[1] ?? "", "author")].map(([, t]) => unescapeXml(t));
    for (const [a, inner] of each(cx, "comment")) {
      if (!a.ref) continue;
      const [row, col] = parseA1(a.ref);
      const author = authors[Number(a.authorId)];
      let body = stringOf(first(inner, "text")?.[1] ?? inner);
      // Excel starts a note with its author's name ("Ann:\n…")
      if (author && body.startsWith(author + ":")) body = body.slice(author.length + 1).replace(/^\s*\n/, "");
      notes.push({ row, col, text: body.trim(), ...(author ? { author } : {}) });
    }
  }
  if (notes.length) sheet.notes = notes;
}

/** Read an .xlsx file. */
export async function readXlsx(buf: ArrayBuffer | Uint8Array): Promise<XWorkbook> {
  const files = await unzip(buf);
  const wbXml = text(files.get("xl/workbook.xml"));
  if (!wbXml) throw new Error("This doesn't look like an Excel workbook (.xlsx).");
  const rels = new Map<string, string>();
  for (const [a] of each(text(files.get("xl/_rels/workbook.xml.rels")), "Relationship")) rels.set(a.Id, a.Target);
  const shared = [...each(text(files.get("xl/sharedStrings.xml")), "si")].map(([, inner]) => stringOf(inner));
  const stylesXml = text(files.get("xl/styles.xml"));
  const styles = readStyles(stylesXml);
  const dxfs = readDxfs(stylesXml);
  if (!styles.length) styles.push({});
  const sheets: XSheet[] = [];
  for (const [a] of each(wbXml, "sheet")) {
    let target = rels.get(a["r:id"] ?? a.id) ?? "";
    target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
    const xml = text(files.get(`xl/${target}`));
    if (!xml) continue; // chart sheets and the like
    const sheet = readSheet(xml, a.name, shared, dxfs);
    readSheetExtras(sheet, xml, files, `xl/${target}`);
    if (a.state === "hidden" || a.state === "veryHidden") sheet.hidden = true;
    sheets.push(sheet);
  }
  const names: XWorkbook["names"] = [];
  for (const [a, inner] of each(first(wbXml, "definedNames")?.[1] ?? "", "definedName")) {
    if (a.name.startsWith("_xlnm") || a.localSheetId !== undefined) continue;
    names.push({ name: a.name, formula: cleanFormula(unescapeXml(inner)) });
  }
  return { sheets, styles, names };
}
