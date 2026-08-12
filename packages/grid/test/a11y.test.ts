import { describe, expect, it } from "vitest";
import { cellAddress, describeCell, describeEdit, describeRange, GRID_KEY_HELP, isErrorText, isMenuKey, rangeAddress } from "../src/a11y";
import { contrastRatio, DARK, forcedColorsTheme, LIGHT } from "../src/theme";

describe("cell and range addresses", () => {
  it("names cells the spreadsheet way", () => {
    expect(cellAddress(0, 0)).toBe("A1");
    expect(cellAddress(4, 1)).toBe("B5");
    expect(cellAddress(99, 26)).toBe("AA100");
    expect(rangeAddress({ top: 1, left: 1, bottom: 9, right: 3 })).toBe("B2:D10");
    expect(rangeAddress({ top: 2, left: 2, bottom: 2, right: 2 })).toBe("C3");
  });
});

describe("describeCell", () => {
  it("reads address, header, shown value and formula", () => {
    expect(describeCell({ row: 4, col: 1, columnName: "Amount", shown: "1,234.50", editText: "=SUM(B2:B4)" })).toBe("B5, Amount, 1,234.50, formula =SUM(B2:B4)");
  });

  it("says blank for empty cells and skips a missing header", () => {
    expect(describeCell({ row: 0, col: 0, shown: "" })).toBe("A1, blank");
    expect(describeCell({ row: 0, col: 0, shown: "   " })).toBe("A1, blank");
  });

  it("doesn't call plain text a formula", () => {
    expect(describeCell({ row: 0, col: 0, shown: "hello", editText: "hello" })).toBe("A1, hello");
  });

  it("calls out errors", () => {
    expect(describeCell({ row: 1, col: 2, shown: "#DIV/0!", editText: "=A1/0" })).toBe("C2, error #DIV/0!, formula =A1/0");
  });
});

describe("describeRange", () => {
  it("is null for one cell", () => {
    expect(describeRange({ top: 3, left: 3, bottom: 3, right: 3 })).toBeNull();
  });

  it("gives the size", () => {
    expect(describeRange({ top: 1, left: 1, bottom: 9, right: 3 })).toBe("B2:D10 selected, 9 rows by 3 columns, 27 cells");
    expect(describeRange({ top: 0, left: 0, bottom: 0, right: 1 })).toBe("A1:B1 selected, 1 row by 2 columns, 2 cells");
    expect(describeRange({ top: 0, left: 0, bottom: 99_999, right: 0 })).toBe("A1:A100000 selected, 100,000 rows by 1 column, 100,000 cells");
  });
});

describe("describeEdit", () => {
  it("says what changed", () => {
    expect(describeEdit({ row: 4, col: 1, shown: "12" })).toBe("B5 set to 12");
    expect(describeEdit({ row: 4, col: 1, shown: "" })).toBe("B5 cleared");
    expect(describeEdit({ row: 4, col: 1, shown: "#NAME?" })).toBe("B5 now shows error #NAME?");
  });
});

describe("errors", () => {
  it("knows Excel's error values", () => {
    for (const e of ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!"]) expect(isErrorText(e)).toBe(true);
    expect(isErrorText("#hashtag")).toBe(false);
    expect(isErrorText("N/A")).toBe(false);
  });
});

describe("keys", () => {
  it("the Menu key and Shift+F10 open the cell menu", () => {
    expect(isMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: "F10", shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: "F10", shiftKey: true, ctrlKey: true })).toBe(false);
  });

  it("the key help mentions how to leave the grid", () => {
    expect(GRID_KEY_HELP).toMatch(/Escape, then Tab/);
    expect(GRID_KEY_HELP).toMatch(/Shift F10/);
  });
});

describe("theme contrast", () => {
  it("text colours pass WCAG AA (4.5:1) on both backgrounds, light and dark", () => {
    for (const t of [LIGHT, DARK]) {
      for (const bg of [t.background, t.headerBackground]) {
        for (const fg of [t.text, t.mutedText, t.accent]) expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("contrastRatio matches known values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777", "#fff")).toBeCloseTo(4.48, 2);
  });

  it("forced colours use system colours", () => {
    const t = forcedColorsTheme((n) => `sys(${n})`);
    expect(t.background).toBe("sys(Canvas)");
    expect(t.text).toBe("sys(CanvasText)");
    expect(t.accent).toBe("sys(Highlight)");
    expect(t.gridLine).toBe("sys(CanvasText)");
  });
});
