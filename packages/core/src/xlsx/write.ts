/** .xlsx writer: XWorkbook -> zip bytes Excel opens. */
import { PREFIXED, pxToPoints, pxToWidth, toA1, WORKSHEET_PREFIXED, type XBorder, type XCondFormat, type XDxf, type XRange, type XSheet, type XStyle, type XWorkbook } from "./model";
import { zip } from "./zip";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// characters XML 1.0 can't carry at all
// eslint-disable-next-line no-control-regex
const xmlSafe = (s: string) => esc(s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""));

/** Our formula text to Excel's file form: newer functions get their _xlfn. prefix. */
export function excelFormula(f: string): string {
  let out = "";
  let i = 0;
  while (i < f.length) {
    if (f[i] === '"') {
      const j = f.indexOf('"', i + 1);
      const end = j < 0 ? f.length : j + 1;
      out += f.slice(i, end);
      i = end;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*(?=\()/.exec(f.slice(i));
    if (m && (i === 0 || !/[A-Za-z0-9_.]/.test(f[i - 1]))) {
      const name = m[0].toUpperCase();
      out += (WORKSHEET_PREFIXED.has(name) ? "_xlfn._xlws." : PREFIXED.has(name) ? "_xlfn." : "") + m[0];
      i += m[0].length;
      continue;
    }
    out += f[i++];
  }
  return out;
}

const argb = (c: string | undefined) => {
  if (!c || c === "auto") return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `FF${m[1].toUpperCase()}` : undefined;
};

function stylesXml(styles: XStyle[], dxfs: string[] = []): string {
  const numFmts = new Map<string, number>();
  const fonts: string[] = [];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders: string[] = [];
  const xfs: string[] = [];
  const index = (list: string[], item: string) => {
    let i = list.indexOf(item);
    if (i < 0) i = list.push(item) - 1;
    return i;
  };
  const borderSide = (tag: string, b: XBorder | undefined) => {
    if (!b) return `<${tag}/>`;
    const style = b.style === "dashed" ? "dashed" : b.style;
    const c = argb(b.color);
    return `<${tag} style="${style}">${c ? `<color rgb="${c}"/>` : '<color auto="1"/>'}</${tag}>`;
  };
  for (const s of styles) {
    const font =
      "<font>" +
      (s.bold ? "<b/>" : "") +
      (s.italic ? "<i/>" : "") +
      (s.strike ? "<strike/>" : "") +
      (s.underline ? "<u/>" : "") +
      `<sz val="${s.size ?? 11}"/>` +
      (argb(s.color) ? `<color rgb="${argb(s.color)}"/>` : '<color theme="1"/>') +
      `<name val="${esc(s.font ?? "Calibri")}"/><family val="2"/></font>`;
    const fontId = index(fonts, font);
    const fill = argb(s.fill);
    const fillId = fill ? index(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = `<border>${borderSide("left", s.borderLeft)}${borderSide("right", s.borderRight)}${borderSide("top", s.borderTop)}${borderSide("bottom", s.borderBottom)}<diagonal/></border>`;
    const borderId = index(borders, border);
    let numFmtId = 0;
    if (s.numFmt) {
      if (!numFmts.has(s.numFmt)) numFmts.set(s.numFmt, 164 + numFmts.size);
      numFmtId = numFmts.get(s.numFmt)!;
    }
    const h = s.align === "centerAcross" ? "centerContinuous" : s.align;
    const v = s.valign === "middle" ? "center" : s.valign;
    const align = h || v || s.wrap ? `<alignment${h ? ` horizontal="${h}"` : ""}${v ? ` vertical="${v}"` : ""}${s.wrap ? ' wrapText="1"' : ""}/>` : "";
    xfs.push(
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
        `${numFmtId ? ' applyNumberFormat="1"' : ""}${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${borderId ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1">' + align + "</xf>" : "/>"}`,
    );
  }
  const fmtXml = numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    fmtXml +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="${fills.length}">${fills.join("")}</fills>` +
    `<borders count="${borders.length}">${borders.join("")}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    (dxfs.length ? `<dxfs count="${dxfs.length}">${dxfs.join("")}</dxfs>` : "") +
    "</styleSheet>"
  );
}

/** A conditional format's look as Excel's dxf XML. */
function dxfXml(d: XDxf): string {
  const font =
    d.bold || d.italic || d.strike || d.color
      ? `<font>${d.bold ? "<b/>" : ""}${d.italic ? "<i/>" : ""}${d.strike ? "<strike/>" : ""}${argb(d.color) ? `<color rgb="${argb(d.color)}"/>` : ""}</font>`
      : "";
  const fill = argb(d.fill) ? `<fill><patternFill><bgColor rgb="${argb(d.fill)}"/></patternFill></fill>` : "";
  return `<dxf>${font}${fill}</dxf>`;
}

/** A sheet's conditional formatting XML; looks are added to dxfs (shared by all sheets). */
function condFormatsXml(list: readonly XCondFormat[] | undefined, dxfs: string[], priority: { n: number }): string {
  if (!list?.length) return "";
  const ref = (r: XRange) => (r.top === r.bottom && r.left === r.right ? toA1(r.top, r.left) : `${toA1(r.top, r.left)}:${toA1(r.bottom, r.right)}`);
  return list
    .map((cf) => {
      let dxfId = "";
      if (cf.dxf) {
        const x = dxfXml(cf.dxf);
        let i = dxfs.indexOf(x);
        if (i < 0) i = dxfs.push(x) - 1;
        dxfId = ` dxfId="${i}"`;
      }
      const at =
        ` type="${esc(cf.type)}"${dxfId} priority="${++priority.n}"` +
        (cf.stopIfTrue ? ' stopIfTrue="1"' : "") +
        (cf.operator ? ` operator="${esc(cf.operator)}"` : "") +
        (cf.text !== undefined ? ` text="${esc(cf.text)}"` : "") +
        (cf.timePeriod ? ` timePeriod="${esc(cf.timePeriod)}"` : "") +
        (cf.rank !== undefined ? ` rank="${cf.rank}"` : "") +
        (cf.percent ? ' percent="1"' : "") +
        (cf.bottom ? ' bottom="1"' : "") +
        (cf.aboveAverage === false ? ' aboveAverage="0"' : "") +
        (cf.equalAverage ? ' equalAverage="1"' : "");
      const cfvo = (cf.cfvos ?? []).map((v) => `<cfvo type="${esc(v.type)}"${v.val !== undefined ? ` val="${esc(v.val)}"` : ""}/>`).join("");
      const colors = (cf.colors ?? []).map((c) => `<color rgb="${argb(c)}"/>`).join("");
      const show = cf.showValue === false ? ' showValue="0"' : "";
      let inner = cf.formulas.map((f) => `<formula>${esc(excelFormula(f))}</formula>`).join("");
      if (cf.type === "colorScale") inner = `<colorScale>${cfvo}${colors}</colorScale>`;
      else if (cf.type === "dataBar") inner = `<dataBar${show}>${cfvo}${colors}</dataBar>`;
      else if (cf.type === "iconSet") inner = `<iconSet iconSet="${esc(cf.iconSet ?? "3TrafficLights1")}"${cf.reverse ? ' reverse="1"' : ""}${show}>${cfvo}</iconSet>`;
      return `<conditionalFormatting sqref="${cf.ranges.map(ref).join(" ")}"><cfRule${at}>${inner}</cfRule></conditionalFormatting>`;
    })
    .join("");
}

function sheetXml(sheet: XSheet, strings: Map<string, number>, dxfs: string[] = [], priority = { n: 0 }): string {
  const str = (s: string) => {
    let i = strings.get(s);
    if (i === undefined) strings.set(s, (i = strings.size));
    return i;
  };
  const byRow = new Map<number, XSheet["cells"]>();
  for (const c of sheet.cells) {
    const list = byRow.get(c.row);
    if (list) list.push(c);
    else byRow.set(c.row, [c]);
  }
  const heights = new Map(sheet.rowHeights);
  const hiddenRows = new Set(sheet.hiddenRows);
  const rowNums = [...new Set([...byRow.keys(), ...heights.keys(), ...hiddenRows])].sort((a, b) => a - b);
  const rows: string[] = [];
  for (const r of rowNums) {
    const cells = (byRow.get(r) ?? []).sort((a, b) => a.col - b.col);
    const ht = heights.get(r);
    const attrs = `r="${r + 1}"${ht ? ` ht="${pxToPoints(ht)}" customHeight="1"` : ""}${hiddenRows.has(r) ? ' hidden="1"' : ""}`;
    const cx = cells.map((c) => {
      const ref = toA1(c.row, c.col);
      const s = c.style ? ` s="${c.style}"` : "";
      const f = c.formula ? `<f>${esc(excelFormula(c.formula))}</f>` : "";
      if (c.error) return `<c r="${ref}"${s} t="e">${f}<v>${esc(c.error)}</v></c>`;
      if (typeof c.value === "number") return `<c r="${ref}"${s}>${f}<v>${c.value}</v></c>`;
      if (typeof c.value === "boolean") return `<c r="${ref}"${s} t="b">${f}<v>${c.value ? 1 : 0}</v></c>`;
      if (typeof c.value === "string") {
        if (c.formula) return `<c r="${ref}"${s} t="str">${f}<v>${xmlSafe(c.value)}</v></c>`;
        return `<c r="${ref}"${s} t="s"><v>${str(c.value)}</v></c>`;
      }
      return `<c r="${ref}"${s}>${f}</c>`;
    });
    rows.push(`<row ${attrs}>${cx.join("")}</row>`);
  }
  const widths = new Map(sheet.colWidths);
  const hiddenCols = new Set(sheet.hiddenCols);
  const colNums = [...new Set([...widths.keys(), ...hiddenCols])].sort((a, b) => a - b);
  const cols = colNums.length
    ? `<cols>${colNums
        .map((c) => {
          const w = widths.get(c);
          return `<col min="${c + 1}" max="${c + 1}" width="${w ? pxToWidth(w) : 8.43}"${w ? ' customWidth="1"' : ""}${hiddenCols.has(c) ? ' hidden="1"' : ""}/>`;
        })
        .join("")}</cols>`
    : "";
  const { rows: fr, cols: fc } = sheet.frozen;
  const pane =
    fr || fc
      ? `<pane${fc ? ` xSplit="${fc}"` : ""}${fr ? ` ySplit="${fr}"` : ""} topLeftCell="${toA1(fr, fc)}" activePane="${fr && fc ? "bottomRight" : fr ? "bottomLeft" : "topRight"}" state="frozen"/>`
      : "";
  const merges = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${toA1(m.top, m.left)}:${toA1(m.bottom, m.right)}"/>`).join("")}</mergeCells>`
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    `<sheetData>${rows.join("")}</sheetData>` +
    merges +
    condFormatsXml(sheet.condFormats, dxfs, priority) +
    "</worksheet>"
  );
}

/** Write an .xlsx file. */
export async function writeXlsx(wb: XWorkbook): Promise<Uint8Array> {
  const strings = new Map<string, number>();
  const dxfs: string[] = [];
  const sheets = wb.sheets.map((s) => sheetXml(s, strings, dxfs, { n: 0 }));
  const sst =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.size}" uniqueCount="${strings.size}">` +
    [...strings.keys()].map((s) => `<si><t xml:space="preserve">${xmlSafe(s)}</t></si>`).join("") +
    "</sst>";
  const names = wb.names.length
    ? `<definedNames>${wb.names.map((n) => `<definedName name="${esc(n.name)}">${esc(excelFormula(n.formula))}</definedName>`).join("")}</definedNames>`
    : "";
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<bookViews><workbookView/></bookViews><sheets>${wb.sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`)
      .join("")}</sheets>${names}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${wb.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${wb.sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    "</Relationships>";
  const types =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  return zip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", rels],
    ["xl/styles.xml", stylesXml(wb.styles.length ? wb.styles : [{}], dxfs)],
    ["xl/sharedStrings.xml", sst],
    ...sheets.map((x, i) => [`xl/worksheets/sheet${i + 1}.xml`, x] as [string, string]),
  ]);
}
