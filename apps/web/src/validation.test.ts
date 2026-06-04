import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { dateToSerial } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { dvContext, invalidCells, invalidInputs } from "./dvui";
import { BlankSource, EditableSource } from "./editable";
import { allowed, errorText, subtractRange, typedValue, type DvRule } from "./validation";
import { Workbook } from "./workbook";

const cell = (row: number, col: number) => ({ top: row, left: col, bottom: row, right: col });

async function setup() {
  const workbook = new Workbook({ name: "Data", source: new EditableSource(new BlankSource(20, 4)) });
  workbook.add("Lists", new EditableSource(new BlankSource(10, 2)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  await h.run(setCells([{ row: 0, col: 0, input: "North" }, { row: 1, col: 0, input: "South" }, { row: 2, col: 0, input: "East" }], undefined, workbook.sheets[1].id));
  const sheet = workbook.sheets[0].source;
  return { h, workbook, sheet, ctx: dvContext(workbook, sheet) };
}

describe("data validation rules", () => {
  it("checks numbers, dates, text length, lists and custom formulas", async () => {
    const { sheet, ctx } = await setup();
    const rule = (r: Partial<DvRule>): DvRule => ({ id: "r", ranges: [cell(0, 0)], kind: "whole", ...r });
    const ok = (r: Partial<DvRule>, input: string | null) => allowed(rule(r), typedValue(input), 0, 0, ctx);
    expect([ok({ op: "between", a: 1, b: 10 }, "5"), ok({ op: "between", a: 1, b: 10 }, "5.5"), ok({ op: "between", a: 1, b: 10 }, "11")]).toEqual([true, false, false]);
    expect(ok({ kind: "decimal", op: ">", a: 0 }, "0.5")).toBe(true);
    expect(ok({ kind: "date", op: ">=", a: dateToSerial(2024, 1, 1) }, "2024-03-15")).toBe(true);
    expect(ok({ kind: "date", op: ">=", a: dateToSerial(2024, 1, 1) }, "2023-12-31")).toBe(false);
    expect([ok({ kind: "textLength", op: "<=", a: 3 }, "abc"), ok({ kind: "textLength", op: "<=", a: 3 }, "abcd")]).toEqual([true, false]);
    expect([ok({ kind: "list", list: ["Yes", "No"] }, "yes"), ok({ kind: "list", list: ["Yes", "No"] }, "Maybe")]).toEqual([true, false]);
    expect([ok({ kind: "list", source: "Lists!$A$1:$A$10" }, "east"), ok({ kind: "list", source: "Lists!$A$1:$A$10" }, "West")]).toEqual([true, false]);
    expect(ok({ kind: "list", list: ["Yes"] }, null)).toBe(true); // blanks allowed by default
    expect(ok({ kind: "list", list: ["Yes"], allowBlank: false }, null)).toBe(false);
    expect([ok({ kind: "checkbox" }, "TRUE"), ok({ kind: "checkbox" }, "x")]).toEqual([true, false]);
    void sheet;
  });

  it("custom formulas move to each cell", async () => {
    const { h, sheet, ctx } = await setup();
    await h.run(setCells([{ row: 0, col: 1, input: "100" }, { row: 1, col: 1, input: "5" }]));
    const rule: DvRule = { id: "c", kind: "custom", formula: "=$B1>10", ranges: [{ top: 0, left: 0, bottom: 1, right: 0 }] };
    expect([allowed(rule, "x", 0, 0, ctx), allowed(rule, "x", 1, 0, ctx)]).toEqual([true, false]);
    void sheet;
  });

  it("explains itself", () => {
    expect(errorText({ id: "1", kind: "whole", op: "between", a: 1, b: 10, ranges: [cell(0, 0)] }).message).toBe("This cell takes a whole number between 1 and 10.");
    expect(errorText({ id: "1", kind: "list", list: ["A"], ranges: [cell(0, 0)], errorStyle: "warning", errorMessage: "Pick one." })).toEqual({ title: "Check this value", message: "Pick one." });
  });

  it("subtracts ranges", () => {
    expect(subtractRange({ top: 0, left: 0, bottom: 9, right: 0 }, { top: 3, left: 0, bottom: 4, right: 0 })).toEqual([
      { top: 0, left: 0, bottom: 2, right: 0 },
      { top: 5, left: 0, bottom: 9, right: 0 },
    ]);
  });
});

describe("data validation actions", () => {
  it("adds rules (newer ones replace older on the same cells), checks inputs, finds invalid cells, saves and undoes", async () => {
    const { h, sheet, ctx } = await setup();
    await h.run({ type: "validation.add", params: { rule: { kind: "whole", op: "between", a: 1, b: 10, ranges: [{ top: 0, left: 0, bottom: 9, right: 0 }] } } });
    await h.run({ type: "validation.add", params: { rule: { kind: "list", source: "Lists!$A$1:$A$3", ranges: [cell(4, 0)] } } });
    expect(sheet.validationAt(3, 0)?.kind).toBe("whole");
    expect(sheet.validationAt(4, 0)?.kind).toBe("list");
    expect(sheet.validations[0].ranges).toEqual([
      { top: 0, left: 0, bottom: 3, right: 0 },
      { top: 5, left: 0, bottom: 9, right: 0 },
    ]);
    expect(sheet.hasDropdown(4, 0)).toBe(true);
    expect(invalidInputs(sheet, ctx, [{ row: 0, col: 0, input: "50" }, { row: 1, col: 0, input: "5" }, { row: 4, col: 0, input: "north" }]).map((x) => x.row)).toEqual([0]);

    await h.run(setCells([{ row: 0, col: 0, input: "50" }, { row: 4, col: 0, input: "West" }]));
    expect(invalidCells(sheet, ctx)).toEqual([cell(0, 0), cell(4, 0)]);

    const { state, binary } = sheet.toState();
    const back = EditableSource.fromState(new BlankSource(20, 4), 0, JSON.parse(JSON.stringify(state)), binary);
    expect(back.validations.length).toBe(2);

    await h.run({ type: "validation.clear", params: { range: { top: 0, left: 0, bottom: 19, right: 3 } } });
    expect(sheet.validations).toEqual([]);
    await h.undo();
    expect(sheet.validations.length).toBe(2);
    await h.run({ type: "rows.insert", params: { at: 0, count: 2 } });
    expect(sheet.validationAt(6, 0)?.kind).toBe("list");
    await expect(h.run({ type: "validation.add", params: { rule: { kind: "list", ranges: [cell(0, 0)] } } })).rejects.toThrow(/choices/);
  });

  it("tick boxes draw as tick boxes", async () => {
    const { h, sheet } = await setup();
    await h.run({ type: "validation.add", params: { rule: { kind: "checkbox", ranges: [cell(0, 2)] } } });
    expect(sheet.getDisplayStyle(0, 2)?.checkbox).toBe(true);
    expect(sheet.getStyle(0, 2)).toBe(null);
  });
});

describe("data validation in Excel files", () => {
  it("survives a round trip through .xlsx", async () => {
    const { readXlsx, writeXlsx } = await import("@cellforge/core");
    const { workbookFromXlsx, workbookToXlsx } = await import("./xlsxio");
    const src = new EditableSource(new BlankSource(20, 4));
    const rules: DvRule[] = [
      { id: "a", kind: "list", list: ["Open", "Say \"hi\""], ranges: [cell(0, 0)], inputTitle: "Status", inputMessage: "Pick one", dropdown: false },
      { id: "b", kind: "list", source: "Lists!$A$1:$A$3", ranges: [cell(1, 0)] },
      { id: "c", kind: "whole", op: "between", a: 1, b: 10, ranges: [{ top: 2, left: 0, bottom: 5, right: 1 }], errorStyle: "warning", errorMessage: "1 to 10 please" },
      { id: "d", kind: "date", op: ">=", a: dateToSerial(2024, 1, 1), ranges: [cell(6, 0)], allowBlank: false },
      { id: "e", kind: "custom", formula: "=$B8>0", ranges: [cell(7, 0)] },
    ];
    src.setValidations(rules);
    const wb = new Workbook({ name: "Data", source: src });
    const back = workbookFromXlsx(await readXlsx(await writeXlsx(workbookToXlsx(wb))));
    expect(back.sheets[0].source.validations.map(({ id: _id, ...r }) => r)).toEqual(rules.map(({ id: _id, ...r }) => r));
  });
});
