import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { CondFormatter, spliceRules, type CfRule, type CfRuleBody } from "./condformat";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

const col = (r: number, c = 0) => ({ top: r, left: c, bottom: r + 9, right: c });

async function setup(values: (string | null)[][]) {
  const workbook = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(20, 4)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const history = new ActionHistory(sheetActions(), () => ctx);
  await history.run(setCells(values.flatMap((r, row) => r.map((input, c) => ({ row, col: c, input })))));
  return { history, sheet: workbook.sheets[0].source };
}

describe("conditional formatting rules", () => {
  it("highlights by value, text, blanks, duplicates, top N and average", async () => {
    const { sheet } = await setup([["10"], ["50"], ["apple"], [null], ["50"], ["30"]]);
    const red = { fill: "#ffc7ce" };
    const at = (rule: CfRuleBody, row: number) =>
      new CondFormatter(sheet, [{ id: "x", ranges: [{ top: 0, left: 0, bottom: 5, right: 0 }], format: red, ...rule } as CfRule]).apply(row, 0)?.style.fill ?? null;
    expect(at({ kind: "cell", op: ">", a: 20 }, 1)).toBe("#ffc7ce");
    expect(at({ kind: "cell", op: ">", a: 20 }, 0)).toBe(null);
    expect(at({ kind: "cell", op: "between", a: 5, b: 15 }, 0)).toBe("#ffc7ce");
    expect(at({ kind: "text", op: "contains", value: "PP" }, 2)).toBe("#ffc7ce");
    expect(at({ kind: "blanks" }, 3)).toBe("#ffc7ce");
    expect([1, 4, 0].map((r) => at({ kind: "duplicates" }, r))).toEqual(["#ffc7ce", "#ffc7ce", null]);
    expect([1, 5, 0].map((r) => at({ kind: "top", n: 3 }, r))).toEqual(["#ffc7ce", "#ffc7ce", null]);
    expect([0, 1].map((r) => at({ kind: "average", below: true }, r))).toEqual(["#ffc7ce", null]); // average 35
  });

  it("moves a formula rule to each cell like Excel, and stops at stop-if-true", async () => {
    const { sheet } = await setup([
      ["a", "5"],
      ["b", "500"],
    ]);
    const rules: CfRule[] = [
      { id: "1", kind: "formula", formula: "=$B1>100", ranges: [{ top: 0, left: 0, bottom: 1, right: 1 }], format: { bold: true }, stopIfTrue: true },
      { id: "2", kind: "noBlanks", ranges: [{ top: 0, left: 0, bottom: 1, right: 1 }], format: { fill: "#eeeeee" } },
    ];
    const f = new CondFormatter(sheet, rules);
    expect(f.apply(1, 0)?.style).toEqual({ bold: true }); // stopped: no fill
    expect(f.apply(1, 1)?.style).toEqual({ bold: true });
    expect(f.apply(0, 0)?.style).toEqual({ fill: "#eeeeee" });
  });

  it("colours scales, data bars and icons by position in the range", async () => {
    const { sheet } = await setup([["0"], ["50"], ["100"], ["-50"]]);
    const range = [{ top: 0, left: 0, bottom: 2, right: 0 }];
    const scale = new CondFormatter(sheet, [{ id: "s", kind: "scale", ranges: range, min: { type: "min" }, max: { type: "max" }, colors: ["#000000", "#ffffff"] }]);
    expect([0, 1, 2].map((r) => scale.apply(r, 0)?.style.fill)).toEqual(["#000000", "#808080", "#ffffff"]);
    const bars = new CondFormatter(sheet, [{ id: "b", kind: "bar", color: "#638ec6", ranges: [{ top: 0, left: 0, bottom: 3, right: 0 }] }]);
    expect(bars.apply(2, 0)?.bar).toEqual({ from: 1 / 3, to: 1, color: "#638ec6" }); // -50..100, zero at a third
    expect(bars.apply(3, 0)?.bar).toEqual({ from: 0, to: 1 / 3, color: "#d93025" });
    const icons = new CondFormatter(sheet, [{ id: "i", kind: "icons", set: "arrows3", ranges: range }]);
    expect([0, 1, 2].map((r) => icons.apply(r, 0)?.icon?.glyph)).toEqual(["▼", "▶", "▲"]);
  });

  it("dates relative to today", async () => {
    const { sheet } = await setup([["2024-03-14"], ["2024-03-15"], ["2024-02-20"]]);
    const f = (when: "today" | "lastMonth" | "yesterday") =>
      new CondFormatter(sheet, [{ id: "d", kind: "date", when, ranges: [col(0)], format: { bold: true } }], () => new Date(2024, 2, 15, 9));
    expect([0, 1, 2].map((r) => !!f("today").apply(r, 0))).toEqual([false, true, false]);
    expect([0, 1, 2].map((r) => !!f("yesterday").apply(r, 0))).toEqual([true, false, false]);
    expect([0, 1, 2].map((r) => !!f("lastMonth").apply(r, 0))).toEqual([false, false, true]);
  });

  it("ranges follow inserted and deleted rows", () => {
    const rule: CfRule = { id: "1", kind: "blanks", ranges: [{ top: 2, left: 0, bottom: 5, right: 1 }], format: { bold: true } };
    expect(spliceRules([rule], "row", 0, 0, 2)[0].ranges).toEqual([{ top: 4, left: 0, bottom: 7, right: 1 }]);
    expect(spliceRules([rule], "row", 3, 0, 2)[0].ranges).toEqual([{ top: 2, left: 0, bottom: 7, right: 1 }]);
    expect(spliceRules([rule], "row", 3, 2, 0)[0].ranges).toEqual([{ top: 2, left: 0, bottom: 3, right: 1 }]);
    expect(spliceRules([rule], "row", 2, 4, 0)).toEqual([]);
  });
});

describe("conditional formatting actions", () => {
  it("add, edit, reorder and delete are undoable and saved with the sheet", async () => {
    const { history, sheet } = await setup([["5"], ["15"]]);
    const range = { top: 0, left: 0, bottom: 1, right: 0 };
    await history.run({ type: "format.conditionalAdd", params: { rule: { kind: "cell", op: ">", a: 10, ranges: [range], format: { fill: "#ffc7ce" } } } });
    expect(sheet.getDisplayStyle(1, 0)?.fill).toBe("#ffc7ce");
    expect(sheet.getStyle(1, 0)).toBe(null); // the cell's own formatting is unchanged
    await history.run({ type: "format.conditionalAdd", params: { rule: { kind: "noBlanks", ranges: [range], format: { fill: "#c6efce" } }, first: true } });
    expect(sheet.getDisplayStyle(1, 0)?.fill).toBe("#c6efce"); // first rule wins
    const id = sheet.condFormats[1].id;
    await history.run({ type: "format.conditionalMove", params: { id, to: 0 } });
    expect(sheet.getDisplayStyle(1, 0)?.fill).toBe("#ffc7ce");
    await history.run({ type: "format.conditionalUpdate", params: { id, rule: { kind: "cell", op: "<", a: 10, ranges: [range], format: { fill: "#ffeb9c" } } } });
    expect(sheet.getDisplayStyle(0, 0)?.fill).toBe("#ffeb9c");

    const { state, binary } = sheet.toState();
    const back = EditableSource.fromState(new BlankSource(20, 4), 0, JSON.parse(JSON.stringify(state)), binary);
    expect(back.condFormats.length).toBe(2);

    await history.run({ type: "format.conditionalDelete", params: {} });
    expect(sheet.condFormats.length).toBe(0);
    await history.undo();
    expect(sheet.condFormats.length).toBe(2);
    await expect(history.run({ type: "format.conditionalAdd", params: { rule: { kind: "cell", op: ">", a: 1, ranges: [range] } } })).rejects.toThrow(/look/);
    await expect(history.run({ type: "format.conditionalAdd", params: { rule: { kind: "formula", formula: "=SUM(", ranges: [range], format: { bold: true } } } })).rejects.toThrow(/formula/);
  });

  it("moves with inserted rows", async () => {
    const { history, sheet } = await setup([["1"], ["2"]]);
    await history.run({ type: "format.conditionalAdd", params: { rule: { kind: "noBlanks", ranges: [{ top: 0, left: 0, bottom: 1, right: 0 }], format: { bold: true } } } });
    await history.run({ type: "rows.insert", params: { at: 0, count: 3 } });
    expect(sheet.condFormats[0].ranges[0]).toEqual({ top: 3, left: 0, bottom: 4, right: 0 });
    expect(sheet.getDisplayStyle(3, 0)?.bold).toBe(true);
  });
});
