import { describe, expect, it } from "vitest";
import { type AskContext, actionsOf, findColumn, normalizeRequest, parse, parseNumber, validateAction } from "../src";
import { CATALOG, salesContext } from "./fixtures";

// Sales: A Region, B Date, C Amount, D Category, E Invoice Number, F Status,
// G Notes, H Customer Name; header in row 0; 200 rows; selection C5:C10.
// Imported (s2): id, amt, qty as the sheet's own column names; 50 rows.

const A = (type: string, params: Record<string, unknown>) => ({ type, params });
const sort = (...keys: [number, boolean][]) => A("rows.sortBy", { keys: keys.map(([col, descending]) => ({ col, descending })), hasHeader: true });
const filter = (col: number, condition: unknown) => A("filter.set", { col, condition });
const fmt = (range: number[], style: Record<string, unknown>) => A("format.set", { range: R(range), style });
const R = ([top, left, bottom, right]: number[]) => ({ top, left, bottom, right });
const col = (c: number) => R([1, c, 199, c]); // a column's data cells on Sales
const whole = (c: number) => [0, c, 199, c];
const RED = { fill: "#ffc7ce", color: "#9c0006" };
const cf = (rule: Record<string, unknown>, ranges: unknown[], format = RED) => A("format.conditionalAdd", { rule: { ...rule, ranges, format } });

type Expect =
  | { actions: unknown[] }
  | { ask: RegExp }
  | { command: string }
  | null;

const cases: [string, Expect][] = [
  // ---- sort
  ["sort by amount descending", { actions: [sort([2, true])] }],
  ["sort by region then date", { actions: [sort([0, false], [1, false])] }],
  ["Sort by Region, then by Amount desc", { actions: [sort([0, false], [2, true])] }],
  ["sort by region and amount descending", { actions: [sort([0, false], [2, true])] }],
  ["sort descending by amount", { actions: [sort([2, true])] }],
  ["sort amount largest first", { actions: [sort([2, true])] }],
  ["sort by customer name a to z", { actions: [sort([7, false])] }],
  ["sort by column C", { actions: [sort([2, false])] }],
  ["sort by C z to a", { actions: [sort([2, true])] }],
  ["please sort by amont descending.", { actions: [sort([2, true])] }],
  ["sort by date newest first", { actions: [sort([1, true])] }],
  ["sort by this column descending", { actions: [sort([2, true])] }],
  ["SORT BY REGION DESC", { actions: [sort([0, true])] }],
  ["sort by customer_name", { actions: [sort([7, false])] }],
  ["sort by invoice no", { actions: [sort([4, false])] }],
  ["sort by invoice", { actions: [sort([4, false])] }],
  ["order by status", { actions: [sort([5, false])] }],
  ["sort by", { ask: /which column/i }],
  ["sort", { ask: /which column/i }],
  ["sort by banana", { ask: /can't find a column called "banana"/ }],
  ["sort by regin", { actions: [sort([0, false])] }],
  // ---- filter
  ["filter region is North", { actions: [filter(0, { kind: "text", op: "equals", value: "North" })] }],
  ["filter amount > 1000", { actions: [filter(2, { kind: "number", op: ">", a: 1000 })] }],
  ["filter amount over 1,000", { actions: [filter(2, { kind: "number", op: ">", a: 1000 })] }],
  ["filter Amount >= 1k", { actions: [filter(2, { kind: "number", op: ">=", a: 1000 })] }],
  ["filter amount is at least 500", { actions: [filter(2, { kind: "number", op: ">=", a: 500 })] }],
  ["filter amount less than 20", { actions: [filter(2, { kind: "number", op: "<", a: 20 })] }],
  ["show only rows where status is not Closed", { actions: [filter(5, { kind: "text", op: "notEquals", value: "Closed" })] }],
  ["filter region is North or South", { actions: [filter(0, { kind: "values", keys: ["s:north", "s:south"] })] }],
  ["filter notes contains urgent", { actions: [filter(6, { kind: "text", op: "contains", value: "urgent" })] }],
  ["filter customer name starts with Ac", { actions: [filter(7, { kind: "text", op: "begins", value: "Ac" })] }],
  ["filter amount between 100 and 500", { actions: [filter(2, { kind: "number", op: "between", a: 100, b: 500 })] }],
  ["filter date after 2024-01-31", { actions: [filter(1, { kind: "date", op: "after", a: 45322 })] }],
  ["filter date after last week", { ask: /which date/i }],
  ["filter amount is 250", { actions: [filter(2, { kind: "number", op: "=", a: 250 })] }],
  ["filter category is blank", { actions: [filter(3, { kind: "blanks", blank: true })] }],
  ["show blanks in category", { actions: [filter(3, { kind: "blanks", blank: true })] }],
  ["show empty cells in notes", { actions: [filter(6, { kind: "blanks", blank: true })] }],
  ["hide blanks in category", { actions: [filter(3, { kind: "blanks", blank: false })] }],
  ["where region is 'East'", { actions: [filter(0, { kind: "text", op: "equals", value: "East" })] }],
  ["filter regoin is East", { actions: [filter(0, { kind: "text", op: "equals", value: "East" })] }],
  ["clear filter", { actions: [A("filter.clear", {})] }],
  ["remove all filters", { actions: [A("filter.clear", {})] }],
  ["show all rows", { actions: [A("filter.clear", {})] }],
  ["remove the filter on region", { actions: [filter(0, null)] }],
  ["filter by region", { ask: /which rows of region/i }],
  ["filter amount > lots", { ask: /what number/i }],
  ["filter colour is red", { ask: /can't find a column called "colour"/ }],
  // ---- pivot suggestions
  ["sum of amount by region", { command: "pivot" }],
  ["total amount per region", { command: "pivot" }],
  ["average amount by categry", { command: "pivot" }],
  ["count by status", { command: "pivot" }],
  ["sum of profit by region", { ask: /can't find a column called "profit"/ }],
  // ---- text styles
  ["make column B bold", { actions: [fmt(whole(1), { bold: true })] }],
  ["bold the header row", { actions: [fmt([0, 0, 0, 7], { bold: true })] }],
  ["make B2:B20 italic", { actions: [fmt([1, 1, 19, 1], { italic: true })] }],
  ["make the selection bold", { actions: [fmt([4, 2, 9, 2], { bold: true })] }],
  ["underline row 3", { actions: [fmt([2, 0, 2, 7], { underline: true })] }],
  ["make amount red", { actions: [fmt(whole(2), { color: "#c00000" })] }],
  ["fill the header row yellow", { actions: [fmt([0, 0, 0, 7], { fill: "#ffeb9c" })] }],
  ["center column F", { actions: [fmt(whole(5), { align: "center" })] }],
  ["clear formatting in column G", { actions: [A("format.clear", { range: R(whole(6)) })] }],
  ["make it pretty", null],
  // ---- number formats
  ["format C as currency", { actions: [A("format.set", { range: col(2), style: { numFmt: "$#,##0.00" } })] }],
  ["format amount as percent", { actions: [A("format.set", { range: col(2), style: { numFmt: "0.0%" } })] }],
  ["format date as date", { actions: [A("format.set", { range: col(1), style: { numFmt: "yyyy-mm-dd" } })] }],
  ["show C as a percentage", { actions: [A("format.set", { range: col(2), style: { numFmt: "0.0%" } })] }],
  ["format row 1 as text", { actions: [fmt([0, 0, 0, 7], { numFmt: "@" })] }],
  ["format amounts as whole numbers", { actions: [A("format.set", { range: col(2), style: { numFmt: "#,##0" } })] }],
  ["format C as banana", null],
  ["format Z as currency", { ask: /column Z is past the last column/i }],
  // ---- freeze
  ["freeze top row", { actions: [A("view.freeze", { rows: 1, cols: 0 })] }],
  ["please could you freeze the top row for me", { actions: [A("view.freeze", { rows: 1, cols: 0 })] }],
  ["freeze the first column", { actions: [A("view.freeze", { rows: 0, cols: 1 })] }],
  ["freeze top row and first column", { actions: [A("view.freeze", { rows: 1, cols: 1 })] }],
  ["freeze the first 2 rows", { actions: [A("view.freeze", { rows: 2, cols: 0 })] }],
  ["freeze the first three columns", { actions: [A("view.freeze", { rows: 0, cols: 3 })] }],
  ["freeze panes at C3", { actions: [A("view.freeze", { rows: 2, cols: 2 })] }],
  ["freeze panes", { actions: [A("view.freeze", { rows: 4, cols: 2 })] }],
  ["unfreeze", { actions: [A("view.freeze", { rows: 0, cols: 0 })] }],
  // ---- hide / show
  ["hide column D", { actions: [A("cols.hide", { at: 3, count: 1, hidden: true })] }],
  ["hide column d", { actions: [A("cols.hide", { at: 3, count: 1, hidden: true })] }],
  ["hide columns D to F", { actions: [A("cols.hide", { at: 3, count: 3, hidden: true })] }],
  ["hide D:F", { actions: [A("cols.hide", { at: 3, count: 3, hidden: true })] }],
  ["hide the notes column", { actions: [A("cols.hide", { at: 6, count: 1, hidden: true })] }],
  ["hide notes", { actions: [A("cols.hide", { at: 6, count: 1, hidden: true })] }],
  ["hide columns D and G", { actions: [A("cols.hide", { at: 3, count: 1, hidden: true }), A("cols.hide", { at: 6, count: 1, hidden: true })] }],
  ["unhide column D", { actions: [A("cols.hide", { at: 3, count: 1, hidden: false })] }],
  ["show column D", { actions: [A("cols.hide", { at: 3, count: 1, hidden: false })] }],
  ["unhide all columns", { actions: [A("cols.hide", { at: 0, count: 8, hidden: false })] }],
  ["hide rows 5 to 8", { actions: [A("rows.hide", { at: 4, count: 4, hidden: true })] }],
  ["hide row 12", { actions: [A("rows.hide", { at: 11, count: 1, hidden: true })] }],
  ["hide column ZZ", { ask: /past the last column/ }],
  ["hide row 900", { ask: /past the end/ }],
  // ---- insert / delete
  ["insert 3 rows above row 10", { actions: [A("rows.insert", { at: 9, count: 3 })] }],
  ["insert a row below row 4", { actions: [A("rows.insert", { at: 4, count: 1 })] }],
  ["add two new rows after row 1", { actions: [A("rows.insert", { at: 1, count: 2 })] }],
  ["insert a row", { actions: [A("rows.insert", { at: 4, count: 1 })] }],
  ["add 2 columns after Amount", { actions: [A("cols.insert", { at: 3, count: 2 })] }],
  ["insert a column before C", { actions: [A("cols.insert", { at: 2, count: 1 })] }],
  ["insert 0 rows above row 3", { ask: /how many/i }],
  ["delete rows 5 to 8", { actions: [A("rows.delete", { at: 4, count: 4 })] }],
  ["delete row 3", { actions: [A("rows.delete", { at: 2, count: 1 })] }],
  ["delete rows 3, 5 and 9", { actions: [A("rows.delete", { at: 8, count: 1 }), A("rows.delete", { at: 4, count: 1 }), A("rows.delete", { at: 2, count: 1 })] }],
  ["delete rows 8 to 5", { actions: [A("rows.delete", { at: 4, count: 4 })] }],
  ["remove the selected rows", { actions: [A("rows.delete", { at: 4, count: 6 })] }],
  ["delete column notes", { actions: [A("cols.delete", { at: 6, count: 1 })] }],
  ["delete the status column", { actions: [A("cols.delete", { at: 5, count: 1 })] }],
  ["delete row 500", { ask: /past the end of Sales/ }],
  ["delete rows", { ask: /which rows/i }],
  ["delete everything", null],
  // ---- sheets
  ["rename sheet to Bank", { actions: [A("sheet.rename", { sheet: "s1", name: "Bank" })] }],
  ["rename sheet Imported to Raw Data", { actions: [A("sheet.rename", { sheet: "s2", name: "Raw Data" })] }],
  ["rename this sheet 'Q1 Sales'", { actions: [A("sheet.rename", { sheet: "s1", name: "Q1 Sales" })] }],
  ["rename sheet to Imported", { ask: /already a sheet called "Imported"/ }],
  ["rename sheet to", { ask: /new name/ }],
  ["rename sheet to a/b", { ask: /can't contain/ }],
  ["rename sheet Nope to X", { ask: /no sheet called "Nope"/ }],
  // ---- duplicates and highlights
  ["find duplicates in invoice number", { actions: [cf({ kind: "duplicates" }, [col(4)])] }],
  ["highlight duplicate invoice numbers", { actions: [cf({ kind: "duplicates" }, [col(4)])] }],
  ["highlight duplicates in E2:E50 in yellow", { actions: [cf({ kind: "duplicates" }, [R([1, 4, 49, 4])], { fill: "#ffeb9c", color: "#9c5700" })] }],
  ["highlight amounts over 10000 in red", { actions: [cf({ kind: "cell", op: ">", a: 10000 }, [col(2)])] }],
  ["highlight amount below 0 in yellow", { actions: [cf({ kind: "cell", op: "<", a: 0 }, [col(2)], { fill: "#ffeb9c", color: "#9c5700" })] }],
  ["highlight negative amounts", { actions: [cf({ kind: "cell", op: "<", a: 0 }, [col(2)])] }],
  ["highlight top 10 amounts in green", { actions: [cf({ kind: "top", n: 10, percent: false, bottom: false }, [col(2)], { fill: "#c6efce", color: "#006100" })] }],
  ["highlight notes containing urgent", { actions: [cf({ kind: "text", op: "contains", value: "urgent" }, [col(6)])] }],
  ["highlight amounts between 10 and 20", { actions: [cf({ kind: "cell", op: "between", a: 10, b: 20 }, [col(2)])] }],
  ["highlight amounts over a lot", { ask: /what number/i }],
  // ---- dropdowns
  ["add a dropdown in E2:E100 with Open, Closed", { actions: [A("validation.add", { rule: { kind: "list", ranges: [R([1, 4, 99, 4])], list: ["Open", "Closed"], allowBlank: true } })] }],
  ["add a dropdown to status with Open, Closed and Pending", { actions: [A("validation.add", { rule: { kind: "list", ranges: [col(5)], list: ["Open", "Closed", "Pending"], allowBlank: true } })] }],
  ["create a drop-down list in F2:F20 with options: Yes or No", { actions: [A("validation.add", { rule: { kind: "list", ranges: [R([1, 5, 19, 5])], list: ["Yes", "No"], allowBlank: true } })] }],
  ["add a dropdown in E2:E100", { ask: /which choices/i }],
  // ---- undo / fill
  ["undo", { command: "undo" }],
  ["Undo that!", { command: "undo" }],
  ["redo", { command: "redo" }],
  ["fill down", { actions: [A("fill.down", { range: R([4, 2, 9, 2]) })] }],
  ["fill down to row 50", { actions: [A("fill.down", { range: R([4, 2, 49, 2]) })] }],
  ["fill C2:C50 down", { actions: [A("fill.down", { range: R([1, 2, 49, 2]) })] }],
  // ---- other sheets
  ["hide column B on sheet Imported", { actions: [A("cols.hide", { at: 1, count: 1, hidden: true, sheet: "s2" })] }],
  ["sort by amt on the Imported sheet", { actions: [A("rows.sortBy", { keys: [{ col: 1, descending: false }], hasHeader: false, sheet: "s2" })] }],
  ["sort by quantity in the Imported sheet", { actions: [A("rows.sortBy", { keys: [{ col: 2, descending: false }], hasHeader: false, sheet: "s2" })] }],
  ["filter qty > 5 in the Imported sheet", { actions: [A("filter.set", { col: 2, condition: { kind: "number", op: ">", a: 5 }, sheet: "s2" })] }],
  ["make column B bold in the Imported sheet", { actions: [A("format.set", { range: R([0, 1, 49, 1]), style: { bold: true }, sheet: "s2" })] }],
  ["bold the header row on sheet Imported", { ask: /not in a row of cells/ }],
  ["hide column D on sheet Imported", { ask: /past the last column of Imported/ }],
  ["sort by amount on sheet Nope", { ask: /no sheet called "Nope"/ }],
  ["fill down on sheet Imported", { ask: /selection is on Sales/ }],
  // ---- nonsense
  ["what's the weather like", null],
  ["", null],
  ["make me a sandwich", null],
];

describe("parse: phrasings to actions", () => {
  it("has a big table", () => expect(cases.length).toBeGreaterThanOrEqual(80));

  it.each(cases)("%s", (text, want) => {
    const got = parse(text, salesContext());
    if (want === null) {
      expect(got).toBeNull();
      return;
    }
    expect(got).not.toBeNull();
    const r = got!;
    if ("ask" in want) {
      expect(actionsOf(r)).toEqual([]);
      expect(r.missing.join(" ")).toMatch(want.ask);
      return;
    }
    expect(r.missing).toEqual([]);
    expect(r.explanation).not.toBe("");
    if ("command" in want) {
      expect(r.command).toBe(want.command);
      expect(actionsOf(r)).toEqual([]);
      return;
    }
    expect(actionsOf(r)).toEqual(want.actions);
    // whatever the parser makes must pass the schema and context checks
    for (const a of actionsOf(r)) expect(validateAction(a, CATALOG, salesContext())).toEqual([]);
    // one action → `action`; several → `actions`
    if (want.actions.length === 1) expect(r.action).toBeDefined();
    else expect(r.actions?.length).toBe(want.actions.length);
  });
});

describe("parse: confidence and explanations", () => {
  const ctx = salesContext();
  it("is less sure about fuzzy names and the selection", () => {
    const exact = parse("sort by amount", ctx)!.confidence;
    expect(parse("sort by amont", ctx)!.confidence).toBeLessThan(exact);
    expect(parse("insert a row", ctx)!.confidence).toBeLessThan(exact);
    expect(exact).toBeGreaterThan(0.9);
  });

  it("explains in plain English, naming columns by header and letter", () => {
    expect(parse("sort by amount descending", ctx)!.explanation).toMatch(/Amount \(column C\), largest .* first, keeping the header row at the top/);
    expect(parse("filter region is North", ctx)!.explanation).toMatch(/Show only the rows where Region \(column A\) is "North"/);
    expect(parse("sum of amount by region", ctx)!.explanation).toMatch(/pivot.*Region \(column A\) in Rows and Sum of Amount \(column C\) in Values/);
    expect(parse("delete rows 5 to 8", ctx)!.explanation).toMatch(/Delete rows 5 to 8/);
  });

  it("asks which column when a name fits two", () => {
    const two: AskContext = { ...ctx, sheets: [{ id: "s1", name: "Sales", columns: ["Amount Paid", "Amount Due"], headerRow: 0, rowCount: 10 }] };
    const r = parse("sort by amount", two)!;
    expect(r.missing[0]).toMatch(/Which column do you mean by "amount": Amount Paid \(column A\) or Amount Due \(column B\)/);
    expect(parse("sort by amount due", two)!.action).toEqual(A("rows.sortBy", { keys: [{ col: 1, descending: false }], hasHeader: true }));
  });

  it("asks for a selection to fill down", () => {
    const one = salesContext({ selection: { top: 3, left: 1, bottom: 3, right: 1 } });
    expect(parse("fill down", one)!.missing[0]).toMatch(/Select the cells to fill/);
  });

  it("asks what to freeze when the cursor is at A1", () => {
    const a1 = salesContext({ selection: { top: 0, left: 0, bottom: 0, right: 0 } });
    expect(parse("freeze panes", a1)!.missing[0]).toMatch(/What should stay on screen/);
  });

  it("says 'did you mean' for a close-but-not-close-enough name", () => {
    expect(parse("sort by customer id", ctx)!.missing[0]).toMatch(/Did you mean "Customer Name"/);
  });
});

describe("helpers", () => {
  it("normalizes politeness away", () => {
    expect(normalizeRequest("  Please, can you sort by amount for me?  ")).toBe("sort by amount");
    expect(normalizeRequest("I'd like you to freeze the top row, thanks.")).toBe("freeze the top row");
  });

  it("reads numbers the way people write them", () => {
    expect(parseNumber("10,000")).toBe(10000);
    expect(parseNumber("$1,200.50")).toBe(1200.5);
    expect(parseNumber("10k")).toBe(10000);
    expect(parseNumber("1.5m")).toBe(1500000);
    expect(parseNumber("(250)")).toBe(-250);
    expect(parseNumber("12%")).toBe(0.12);
    expect(parseNumber("lots")).toBeNaN();
    expect(parseNumber("1,00")).toBeNaN();
  });

  it("finds columns by name, letter, plural, typo and prefix", () => {
    const sheet = salesContext().sheets[0];
    expect(findColumn(sheet, "invoice number")).toEqual({ ok: true, col: 4, exact: true });
    expect(findColumn(sheet, "InvoiceNumber")).toEqual({ ok: true, col: 4, exact: true });
    expect(findColumn(sheet, "invoice #")).toEqual({ ok: true, col: 4, exact: true });
    expect(findColumn(sheet, "amounts")).toEqual({ ok: true, col: 2, exact: false });
    expect(findColumn(sheet, "custmer name")).toEqual({ ok: true, col: 7, exact: false });
    expect(findColumn(sheet, "customer")).toEqual({ ok: true, col: 7, exact: false });
    expect(findColumn(sheet, "column H")).toEqual({ ok: true, col: 7, exact: true });
    expect(findColumn(sheet, "H")).toEqual({ ok: true, col: 7, exact: true });
    expect(findColumn(sheet, "Q")).toEqual({ ok: false, reason: "outside", candidates: [] });
    expect(findColumn(sheet, "xyz123")).toEqual({ ok: false, reason: "unknown", candidates: [] });
  });
});
