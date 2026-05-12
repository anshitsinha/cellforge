import { describe, expect, it } from "vitest";
import { readXlsx, writeXlsx, type XWorkbook } from "../src";
import { excelFormula } from "../src/xlsx/write";
import { cleanFormula } from "../src/xlsx/read";
import { unzip, text } from "../src/xlsx/zip";

const sample: XWorkbook = {
  styles: [{}, { bold: true, fill: "#ffeeaa", align: "center" }, { numFmt: "#,##0.00;[Red](#,##0.00)", borderBottom: { style: "double", color: "#000000" } }, { italic: true, size: 14, color: "#c00000", wrap: true, valign: "top" }],
  names: [{ name: "Revenue", formula: "Sales!$B$2:$B$4" }],
  sheets: [
    {
      name: "Sales",
      cells: [
        { row: 0, col: 0, value: "Region", style: 1 },
        { row: 0, col: 1, value: "Amount", style: 1 },
        { row: 1, col: 0, value: "North & East <1>", style: 0 },
        { row: 1, col: 1, value: 1234.5, style: 2 },
        { row: 2, col: 0, value: true, style: 0 },
        { row: 2, col: 1, value: -20, style: 2 },
        { row: 3, col: 1, value: 1214.5, formula: "SUM(B2:B3)", style: 2 },
        { row: 4, col: 0, value: null, error: "#N/A", formula: "XLOOKUP(\"x\", A2:A3, B2:B3)", style: 0 },
        { row: 5, col: 0, value: "note", style: 3 },
      ],
      merges: [{ top: 7, left: 0, bottom: 7, right: 2 }],
      colWidths: [[0, 180]],
      hiddenCols: [3],
      rowHeights: [[5, 40]],
      hiddenRows: [6],
      frozen: { rows: 1, cols: 0 },
      rows: 8,
      cols: 3,
    },
    { name: "Hidden notes", hidden: true, cells: [{ row: 0, col: 0, value: "x", style: 0 }], merges: [], colWidths: [], hiddenCols: [], rowHeights: [], hiddenRows: [], frozen: { rows: 0, cols: 0 }, rows: 1, cols: 1 },
  ],
};

describe("xlsx", () => {
  it("round-trips values, formulas, styles and layout", async () => {
    const bytes = await writeXlsx(sample);
    const back = await readXlsx(bytes);
    const s = back.sheets[0];
    const cell = (r: number, c: number) => s.cells.find((x) => x.row === r && x.col === c)!;
    expect(back.sheets.map((x) => [x.name, !!x.hidden])).toEqual([["Sales", false], ["Hidden notes", true]]);
    expect(cell(1, 0).value).toBe("North & East <1>");
    expect(cell(1, 1).value).toBe(1234.5);
    expect(cell(2, 0).value).toBe(true);
    expect(cell(3, 1).formula).toBe("SUM(B2:B3)");
    expect(cell(4, 0).formula).toBe('XLOOKUP("x", A2:A3, B2:B3)');
    expect(cell(4, 0).error).toBe("#N/A");
    expect(back.styles[cell(0, 0).style]).toEqual({ bold: true, fill: "#ffeeaa", align: "center" });
    expect(back.styles[cell(1, 1).style]).toEqual({ numFmt: "#,##0.00;[Red](#,##0.00)", borderBottom: { style: "double", color: "#000000" } });
    expect(back.styles[cell(5, 0).style]).toEqual({ italic: true, size: 14, color: "#c00000", wrap: true, valign: "top" });
    expect(s.merges).toEqual([{ top: 7, left: 0, bottom: 7, right: 2 }]);
    expect(s.colWidths).toEqual([[0, 180]]);
    expect(s.hiddenCols).toEqual([3]);
    expect(s.rowHeights).toEqual([[5, 40]]);
    expect(s.hiddenRows).toEqual([6]);
    expect(s.frozen).toEqual({ rows: 1, cols: 0 });
    expect(back.names).toEqual([{ name: "Revenue", formula: "Sales!$B$2:$B$4" }]);
  });

  it("writes newer functions with Excel's prefixes and reads them back clean", async () => {
    expect(excelFormula('XLOOKUP(A1, B:B, C:C)+SUM(FILTER(D:D, E:E="XLOOKUP("))')).toBe('_xlfn.XLOOKUP(A1, B:B, C:C)+SUM(_xlfn._xlws.FILTER(D:D, E:E="XLOOKUP("))');
    expect(cleanFormula("_xlfn.LET(_xlpm.x, 1, _xlpm.x+1)")).toBe("LET(x, 1, x+1)");
    const files = await unzip(await writeXlsx(sample));
    expect(text(files.get("xl/worksheets/sheet1.xml"))).toContain("<f>_xlfn.XLOOKUP(");
  });

  it("expands shared formulas", async () => {
    // what Excel writes for B1:B3 = A1*2, A2*2, A3*2
    const { readSheet } = await import("../src/xlsx/read");
    const xml = `<worksheet><sheetData><row r="1"><c r="B1"><f t="shared" ref="B1:B3" si="0">A1*2</f><v>2</v></c></row><row r="2"><c r="B2"><f t="shared" si="0"/><v>4</v></c></row><row r="3"><c r="B3"><f t="shared" si="0"/><v>6</v></c></row></sheetData></worksheet>`;
    const s = readSheet(xml, "S", []);
    expect(s.cells.map((c) => c.formula)).toEqual(["A1*2", "A2*2", "A3*2"]);
  });
});
