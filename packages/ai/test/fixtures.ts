import { type JsonSchema, s } from "@cellforge/actions";
import type { AskContext } from "../src";
import type { CatalogEntry } from "../src/validate";

/** Sales (on screen, header in row 1) and Imported (its own column names). */
export function salesContext(over: Partial<AskContext> = {}): AskContext {
  return {
    sheets: [
      {
        id: "s1",
        name: "Sales",
        columns: ["Region", "Date", "Amount", "Category", "Invoice Number", "Status", "Notes", "Customer Name"],
        headerRow: 0,
        rowCount: 200,
      },
      { id: "s2", name: "Imported", columns: ["id", "amt", "qty"], headerRow: -1, rowCount: 50 },
    ],
    activeSheet: "s1",
    selection: { top: 4, left: 2, bottom: 9, right: 2 },
    ...over,
  };
}

// A catalog with the same shapes as apps/web/src/actions.ts, for the parts the parser uses.
const sheet = s.string("sheet id; defaults to the sheet on screen");
const withSheet = (props: Record<string, JsonSchema>, required: string[]) => s.object({ ...props, sheet }, required);
const range = s.object({ top: s.int(undefined, 0), left: s.int(undefined, 0), bottom: s.int(undefined, 0), right: s.int(undefined, 0) });
const nullable = (x: JsonSchema) => s.anyOf(x, s.null());
const cond = s.anyOf(
  s.object({ kind: s.string(undefined, { enum: ["values"] }), keys: s.array(s.string()) }),
  s.object({ kind: s.string(undefined, { enum: ["text"] }), op: s.string(undefined, { enum: ["contains", "notContains", "begins", "ends", "equals", "notEquals"] }), value: s.string() }),
  s.object(
    { kind: s.string(undefined, { enum: ["number"] }), op: s.string(undefined, { enum: [">", ">=", "<", "<=", "=", "!=", "between", "top", "bottom", "aboveAverage", "belowAverage"] }), a: s.number(), b: s.number() },
    ["kind", "op"],
  ),
  s.object({ kind: s.string(undefined, { enum: ["date"] }), op: s.string(undefined, { enum: ["before", "after", "on", "between"] }), a: s.number(), b: s.number() }, ["kind", "op", "a"]),
  s.object({ kind: s.string(undefined, { enum: ["blanks"] }), blank: s.bool() }),
);
const style = s.object(
  { bold: nullable(s.bool()), italic: nullable(s.bool()), underline: nullable(s.bool()), strike: nullable(s.bool()), color: nullable(s.string()), fill: nullable(s.string()), align: nullable(s.string(undefined, { enum: ["left", "center", "right", "centerAcross"] })), wrap: nullable(s.bool()), numFmt: nullable(s.string(undefined, { maxLength: 255 })) },
  [],
);
const cfRule = s.object(
  {
    kind: s.string(undefined, { enum: ["cell", "text", "date", "blanks", "noBlanks", "errors", "noErrors", "duplicates", "unique", "top", "average", "formula", "scale", "bar", "icons"] }),
    ranges: s.array(range, undefined, 1),
    op: s.string(),
    a: s.anyOf(s.number(), s.string()),
    b: s.number(),
    value: s.string(),
    formula: s.string(),
    n: s.number(),
    percent: s.bool(),
    bottom: s.bool(),
    format: s.object({ fill: s.string(), color: s.string(), bold: s.bool() }, []),
  },
  ["kind", "ranges"],
);
const dv = s.object(
  { kind: s.string(undefined, { enum: ["list", "whole", "decimal", "date", "textLength", "custom", "checkbox"] }), ranges: s.array(range, undefined, 1), list: s.array(s.string()), allowBlank: s.bool() },
  ["kind", "ranges"],
);

export const CATALOG: CatalogEntry[] = [
  { type: "rows.sortBy", title: "Sort rows by several columns", schema: withSheet({ keys: s.array(s.object({ col: s.int(undefined, 0), descending: s.bool() }, ["col"]), undefined, 1, 16), hasHeader: s.bool() }, ["keys"]) },
  { type: "filter.set", title: "Filter rows by a column", schema: withSheet({ col: s.int(undefined, 0), condition: s.anyOf(cond, s.null()), headerRow: s.int(undefined, -1) }, ["col", "condition"]) },
  { type: "filter.clear", title: "Remove the filter", schema: withSheet({}, []) },
  { type: "format.set", title: "Format a range", schema: withSheet({ range, style }, ["range", "style"]) },
  { type: "format.clear", title: "Remove all formatting", schema: withSheet({ range }, ["range"]) },
  { type: "view.freeze", title: "Freeze panes", schema: withSheet({ rows: s.int(undefined, 0, 1000), cols: s.int(undefined, 0, 100) }, ["rows", "cols"]) },
  { type: "cols.hide", title: "Hide or unhide columns", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1, 16384), hidden: s.bool() }, ["at", "hidden"]) },
  { type: "rows.hide", title: "Hide or unhide rows", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1), hidden: s.bool() }, ["at", "hidden"]) },
  { type: "rows.insert", title: "Insert rows", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1, 1_000_000) }, ["at"]) },
  { type: "rows.delete", title: "Delete rows", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1, 1_000_000) }, ["at"]) },
  { type: "cols.insert", title: "Insert columns", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1, 16384) }, ["at"]) },
  { type: "cols.delete", title: "Delete columns", schema: withSheet({ at: s.int(undefined, 0), count: s.int(undefined, 1, 16384) }, ["at"]) },
  { type: "sheet.rename", title: "Rename a sheet", schema: s.object({ sheet: s.string(), name: s.string(undefined, { minLength: 1, maxLength: 31 }) }) },
  { type: "format.conditionalAdd", title: "Add a conditional formatting rule", schema: withSheet({ rule: cfRule, first: s.bool() }, ["rule"]) },
  { type: "validation.add", title: "Add a data validation rule", schema: withSheet({ rule: dv }, ["rule"]) },
  { type: "fill.down", title: "Fill down", schema: withSheet({ range }, ["range"]) },
];
