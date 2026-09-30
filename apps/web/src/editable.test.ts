import { describe, expect, it } from "vitest";
import { BlankSource, EditableSource, parseInput } from "./editable";

const set = (s: EditableSource, row: number, col: number, text: string) =>
  s.setCell(row, col, parseInput(text));

describe("EditableSource formulas", () => {
  it("evaluates formulas and recalculates after an edit", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "2"); // A1
    set(s, 1, 0, "3"); // A2
    set(s, 2, 0, "=A1*A2"); // A3
    expect(s.getCell(2, 0)).toBe(6);
    set(s, 0, 0, "10");
    expect(s.getCell(2, 0)).toBe(30);
  });

  it("shows the formula text for editing, the result for display", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "=1+1");
    expect(s.getCell(0, 0)).toBe(2);
    expect(s.getEditText(0, 0)).toBe("=1+1");
  });

  it("reports cycles instead of blowing the stack", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "=B1");
    set(s, 0, 1, "=A1");
    expect(s.getCell(0, 0)).toBe("#CYCLE!");
  });

  it("keeps unparseable formulas around as #ERROR!", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "=1+");
    expect(s.getCell(0, 0)).toBe("#ERROR!");
    expect(s.getEditText(0, 0)).toBe("=1+");
  });

  it("fills a formula down with relative refs moving and $refs staying", () => {
    const s = new EditableSource(new BlankSource(100, 4));
    for (let r = 0; r < 100; r++) set(s, r, 0, String(r + 1)); // A = 1..100
    set(s, 0, 1, "10"); // B1 = 10
    set(s, 0, 2, "=A1*$B$1"); // C1
    const { template, origin } = s.getTemplate(0, 2);
    const fill = s.addFill(2, 1, 99, template, origin);
    expect(s.isCompiled(fill)).toBe(true);
    expect(s.getCell(0, 2)).toBe(10);
    expect(s.getCell(4, 2)).toBe(50);
    expect(s.getCell(99, 2)).toBe(1000);
    expect(s.getEditText(4, 2)).toBe("=A5*$B$1");
  });

  it("gives the same answers compiled or interpreted, including fallback rows", () => {
    const s = new EditableSource(new BlankSource(50, 4));
    for (let r = 0; r < 50; r++) set(s, r, 0, r % 7 === 0 ? "" : r % 11 === 0 ? "text" : String(r - 20));
    set(s, 0, 1, "=IF(A1>0, 100/A1, SQRT(A1))");
    const { template, origin } = s.getTemplate(0, 1);
    s.addFill(1, 1, 49, template, origin);
    const compiled = Array.from({ length: 50 }, (_, r) => s.getCell(r, 1));

    // same thing with one explicit formula per cell (always interpreted)
    const t = new EditableSource(new BlankSource(50, 4));
    for (let r = 0; r < 50; r++) set(t, r, 0, r % 7 === 0 ? "" : r % 11 === 0 ? "text" : String(r - 20));
    for (let r = 0; r < 50; r++) set(t, r, 1, `=IF(A${r + 1}>0, 100/A${r + 1}, SQRT(A${r + 1}))`);
    const interpreted = Array.from({ length: 50 }, (_, r) => t.getCell(r, 1));

    expect(compiled).toEqual(interpreted);
    expect(interpreted).toContain("#NUM!"); // sqrt of a negative
    expect(interpreted).toContain("#VALUE!"); // text > 0 compares as text -> FALSE -> SQRT("text")
  });

  it("recomputes a fill after an input changes, and edits override fills", () => {
    const s = new EditableSource(new BlankSource(10, 3));
    for (let r = 0; r < 10; r++) set(s, r, 0, "1");
    set(s, 0, 1, "=A1+1");
    const { template, origin } = s.getTemplate(0, 1);
    s.addFill(1, 1, 9, template, origin);
    expect(s.getCell(5, 1)).toBe(2);
    set(s, 5, 0, "41");
    expect(s.getCell(5, 1)).toBe(42);
    set(s, 5, 1, "override");
    expect(s.getCell(5, 1)).toBe("override");
  });

  it("interprets fills that read their own column (no kernel)", () => {
    const s = new EditableSource(new BlankSource(10, 2));
    for (let r = 0; r < 10; r++) set(s, r, 0, "1");
    set(s, 0, 1, "=A1");
    set(s, 1, 1, "=B1+A2"); // running total
    const { template, origin } = s.getTemplate(1, 1);
    const fill = s.addFill(1, 2, 9, template, origin);
    expect(s.isCompiled(fill)).toBe(false);
    expect(s.getCell(9, 1)).toBe(10);
  });

  it("reverts edits back to the underlying value", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "5");
    s.revertCell(0, 0);
    expect(s.getCell(0, 0)).toBe(null);
    expect(s.editCount).toBe(0);
  });
});
