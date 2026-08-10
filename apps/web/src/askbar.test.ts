import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { EXAMPLES, actionsOf, parse, runRequest, validateAction } from "@cellforge/ai";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { askContext, planFor, sheetInfo, suggestCommands } from "./askbar";
import { BlankSource, EditableSource } from "./editable";
import type { Command } from "./palette";
import { Workbook } from "./workbook";

async function sortRows(sheet: EditableSource, col: number, descending: boolean) {
  const rows = Array.from({ length: sheet.rowCount }, (_, i) => i);
  const key = (r: number) => sheet.getCell(r, col);
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === y) return a - b;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * (descending ? -1 : 1);
  });
  return Uint32Array.from(rows);
}

const HEADER = ["Region", "Date", "Amount", "Category", "Invoice Number", "Status", "Notes", "Customer Name"];
const DATA: (string | number)[][] = [
  ["North", "2024-01-05", 1200, "Travel", "INV-1", "Open", "", "Acme"],
  ["South", "2024-01-06", 50, "", "INV-2", "Closed", "urgent", "Bolt"],
  ["North", "2024-01-07", 15000, "Meals", "INV-2", "Open", "", "Cargo"],
  ["East", "2024-01-08", 700, "Travel", "INV-4", "Closed", "", "Delta"],
];

async function setup() {
  const workbook = new Workbook({ name: "Sales", source: new EditableSource(new BlankSource(120, 8)) });
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows };
  const registry = sheetActions();
  const history = new ActionHistory(registry, () => ctx);
  const cells = [HEADER, ...DATA].flatMap((row, r) => row.map((v, c) => ({ row: r, col: c, input: v === "" ? null : String(v) })));
  await history.run(setCells(cells));
  const sheet = workbook.sheets[0];
  let selection = { top: 1, left: 2, bottom: 4, right: 2 };
  const deps = {
    catalog: () => registry.catalog(),
    context: () => askContext(workbook, ctx.activeSheet, selection),
    commands: () => COMMANDS,
    run: (a: { type: string; params: unknown }) => history.run(a).then(() => true),
  };
  return { workbook, ctx, registry, history, sheet, src: sheet.source, deps, select: (s: typeof selection) => (selection = s) };
}

const noop = () => undefined;
const COMMANDS: Command[] = [
  { id: "undo", title: "Undo", keys: "Ctrl Z", run: noop },
  { id: "redo", title: "Redo", keys: "Ctrl Y", run: noop },
  { id: "pivot", title: "Pivot table…", hint: "pivot summarise group by subtotal crosstab drill down slicer sum count", run: noop },
  { id: "sort-dialog", title: "Sort by several columns…", hint: "multi-level sort order custom sort", run: noop },
  { id: "chart", title: "Insert chart…", hint: "graph plot bar line pie", run: noop },
  { id: "remove-dupes", title: "Remove duplicate rows…", hint: "dedupe unique", run: noop },
  { id: "trim", title: "Clean up: trim spaces", hint: "whitespace tidy", run: noop },
];

describe("ask bar context", () => {
  it("reads the header row and the sheet's size", async () => {
    const { workbook, src } = await setup();
    const info = sheetInfo(workbook.sheets[0].id, "Sales", src);
    expect(info.headerRow).toBe(0);
    expect(info.columns).toEqual(HEADER);
    expect(info.rowCount).toBe(120);
  });

  it("has no header when the first row is numbers or blank", () => {
    const src = new EditableSource(new BlankSource(5, 3));
    expect(sheetInfo("s", "Blank", src)).toMatchObject({ headerRow: -1, columns: [] });
  });

  it("orders a backwards selection", async () => {
    const { workbook } = await setup();
    expect(askContext(workbook, workbook.sheets[0].id, { top: 4, left: 3, bottom: 1, right: 0 }).selection).toEqual({ top: 1, left: 0, bottom: 4, right: 3 });
  });
});

describe("the parser against the real catalog", () => {
  const phrasings = [
    ...EXAMPLES,
    "sort by amount, then by customer name descending",
    "filter amount between 100 and 2000",
    "filter date after 2024-01-06",
    "filter region is North or East",
    "filter notes contains urgent",
    "remove the filter on region",
    "make B2:B5 italic",
    "format amount as percent",
    "fill the header row yellow",
    "make amount red",
    "center column F",
    "clear formatting in column G",
    "freeze panes at C3",
    "unfreeze",
    "unhide all columns",
    "hide rows 3 to 4",
    "insert a column before C",
    "delete column notes",
    "highlight negative amounts",
    "highlight top 3 amounts in green",
    "highlight notes containing urgent",
    "highlight amounts between 10 and 20",
  ];

  it.each(phrasings.filter((p) => !["undo", "sum of amount by region", "fill down"].includes(p)))("%s → valid actions", async (text) => {
    const { deps } = await setup();
    const plan = planFor(text, deps);
    expect(plan.kind, JSON.stringify(plan)).toBe("ready");
    if (plan.kind !== "ready") return;
    for (const a of plan.actions) expect(validateAction(a, deps.catalog(), deps.context())).toEqual([]);
  });
});

describe("ask bar plans", () => {
  it("finds palette commands for undo and pivot", async () => {
    const { deps } = await setup();
    expect(planFor("undo", deps)).toMatchObject({ kind: "command", id: "undo", command: { id: "undo" } });
    expect(planFor("sum of amount by region", deps)).toMatchObject({ kind: "command", id: "pivot", explanation: expect.stringMatching(/pivot/) });
  });

  it("asks rather than guessing", async () => {
    const { deps } = await setup();
    expect(planFor("sort by profit", deps)).toMatchObject({ kind: "ask", questions: [expect.stringMatching(/can't find a column called "profit"/)] });
  });

  it("reports problems from the real catalog in plain English", async () => {
    const { deps } = await setup();
    const problems = validateAction({ type: "cols.hide", params: { at: 8, hidden: true } }, deps.catalog(), deps.context());
    expect(problems[0]).toMatch(/column I .* only 8 columns/);
    expect(validateAction({ type: "view.freeze", params: { rows: 1 } }, deps.catalog(), deps.context())).toEqual(["view.freeze: cols is missing."]);
  });

  it("says what it can do and suggests commands when it doesn't understand", async () => {
    const { deps } = await setup();
    const plan = planFor("draw me a chart of the amounts", deps);
    expect(plan).toMatchObject({ kind: "unknown", canAskModel: false });
    if (plan.kind === "unknown") expect(plan.suggestions[0].id).toBe("chart");
    const dupes = planFor("get rid of duplicate rows", deps);
    if (dupes.kind === "unknown") expect(dupes.suggestions[0].id).toBe("remove-dupes");
    expect(planFor("", deps)).toEqual({ kind: "empty" });
  });

  it("offers the model when one is loaded", async () => {
    const { deps } = await setup();
    const plan = planFor("draw me a chart", { ...deps, model: () => ({ propose: async () => "{}" }) });
    expect(plan).toMatchObject({ kind: "unknown", canAskModel: true });
  });

  it("ranks command suggestions by shared words", () => {
    expect(suggestCommands("trim the spaces", COMMANDS)[0].id).toBe("trim");
    expect(suggestCommands("sort on several columns", COMMANDS)[0].id).toBe("sort-dialog");
    expect(suggestCommands("xyzzy", COMMANDS)).toEqual([]);
  });
});

describe("ask bar end to end (parse → run through history)", () => {
  const run = async (text: string, s: Awaited<ReturnType<typeof setup>>) => {
    const r = parse(text, s.deps.context());
    expect(r?.missing ?? ["no parse"]).toEqual([]);
    for (const a of actionsOf(r)) await s.history.run(a);
  };

  it("sorts with the header kept on top", async () => {
    const s = await setup();
    await run("sort by amount descending", s);
    expect(Array.from({ length: 5 }, (_, r) => s.src.getCell(r, 2))).toEqual(["Amount", 15000, 1200, 700, 50]);
  });

  it("filters by header name", async () => {
    const s = await setup();
    await run("filter region is north", s);
    expect(s.src.filter?.conditions).toEqual([{ col: 0, cond: { kind: "text", op: "equals", value: "north" } }]);
  });

  it("freezes, hides, renames, adds a dropdown and highlights duplicates", async () => {
    const s = await setup();
    await run("freeze top row", s);
    expect(s.src.frozen).toEqual({ rows: 1, cols: 0 });
    await run("hide column D", s);
    expect(s.src.hiddenColumns.has(3)).toBe(true);
    await run("rename sheet to Bank", s);
    expect(s.workbook.sheets[0].name).toBe("Bank");
    await run("add a dropdown in F2:F5 with Open, Closed", s);
    expect(s.src.validations).toHaveLength(1);
    await run("find duplicates in invoice number", s);
    expect(s.src.condFormats[0]).toMatchObject({ kind: "duplicates", ranges: [{ top: 1, left: 4, bottom: 119, right: 4 }] });
    await run("format C as currency", s);
    expect(s.src.getStyle(2, 2)?.numFmt).toBe("$#,##0.00");
  });

  it("fills down the selection and inserts rows", async () => {
    const s = await setup();
    s.select({ top: 1, left: 7, bottom: 4, right: 7 });
    await run("fill down", s);
    expect(Array.from({ length: 4 }, (_, r) => s.src.getCell(r + 1, 7))).toEqual(["Acme", "Acme", "Acme", "Acme"]);
    await run("insert 2 rows above row 2", s);
    expect(s.src.getCell(3, 0)).toBe("North");
  });

  it("runs through the tool loop with the real registry", async () => {
    const s = await setup();
    const t = await runRequest("hide rows 3 to 4", { catalog: s.deps.catalog, context: s.deps.context, run: s.deps.run });
    expect(t.status).toBe("done");
    expect(s.history.canUndo).toBe(true);
  });
});
