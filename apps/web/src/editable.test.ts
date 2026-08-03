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

  it("reverts edits back to the underlying value", () => {
    const s = new EditableSource(new BlankSource());
    set(s, 0, 0, "5");
    s.revertCell(0, 0);
    expect(s.getCell(0, 0)).toBe(null);
    expect(s.editCount).toBe(0);
  });
});
