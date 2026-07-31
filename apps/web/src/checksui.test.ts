import { beforeEach, describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { readSheet } from "./audittools";
import {
  bindChecksStore,
  blankCheck,
  bulkTagCells,
  categoryCells,
  categoryInput,
  checksPass,
  failingChecks,
  failureCell,
  gateExport,
  getCategoryRules,
  getChecks,
  guessCatColumns,
  moveItem,
  readCatRows,
  registerCheckActions,
  ruleToRow,
  rowToRule,
  runWorkbookChecks,
  setChecks,
  uncategorisedFilter,
} from "./checksui";
import { categorise, type CheckDef } from "@cellforge/core";
import { BlankSource, EditableSource } from "./editable";
import { Workbook } from "./workbook";

function setup() {
  const workbook = new Workbook({ name: "JE", source: new EditableSource(new BlankSource(100, 10)) });
  workbook.add("COA", new EditableSource(new BlankSource(100, 10)));
  const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const registry = sheetActions();
  registerCheckActions(registry);
  const history = new ActionHistory(registry, () => ctx);
  const [je, coa] = workbook.sheets;
  return { ctx, history, workbook, je, coa };
}

async function type(history: ActionHistory<SheetCtx>, sheet: string, rows: (string | null)[][]) {
  const cells = rows.flatMap((r, row) => r.map((input, col) => ({ row, col, input })).filter((c) => c.input !== null));
  await history.run(setCells(cells, undefined, sheet));
}

async function journal() {
  const s = setup();
  await type(s.history, s.je.id, [
    ["Entry", "Account", "Debit", "Credit", "Description"],
    ["J1", "4000", "100", null, "UBER TRIP"],
    ["J1", "1200", null, "100", "Tesco stores"],
    ["J2", "9999", "50", null, "uber trip home"],
    ["J2", "4000", null, "40", ""],
  ]);
  await type(s.history, s.coa.id, [["Account"], ["4000"], ["1200"]]);
  return s;
}

beforeEach(() => {
  let checks: CheckDef[] = [];
  let rules: ReturnType<typeof getCategoryRules> = [];
  bindChecksStore({ getChecks: () => checks, setChecks: (c) => (checks = c), getRules: () => rules, setRules: (r) => (rules = r) });
});

describe("check actions", () => {
  it("checks.set replaces the checks and undoes", async () => {
    const { history, je } = setup();
    const a: CheckDef = { id: "a", sheet: je.id, kind: "notBlank", col: 0 };
    await history.run({ type: "checks.set", params: { checks: [a] } });
    expect(getChecks()).toEqual([a]);
    await history.run({ type: "checks.set", params: { checks: [a, { ...a, id: "b" }] } });
    expect(getChecks()).toHaveLength(2);
    await history.undo();
    expect(getChecks()).toEqual([a]);
    await history.undo();
    expect(getChecks()).toEqual([]);
    await history.redo();
    expect(getChecks()).toEqual([a]);
    await expect(history.run({ type: "checks.set", params: { checks: [{ kind: "notBlank" }] } })).rejects.toThrow(/id/);
  });

  it("categories.setRules replaces the rules and undoes", async () => {
    const { history } = setup();
    const rule = { id: "r", condition: { kind: "contains", text: "uber" }, category: "Travel" };
    await history.run({ type: "categories.setRules", params: { rules: [rule] } });
    expect(getCategoryRules()).toEqual([rule]);
    await history.undo();
    expect(getCategoryRules()).toEqual([]);
  });
});

describe("running checks on the workbook", () => {
  it("runs checks, master lists across sheets and formula checks", async () => {
    const { workbook, je, coa } = await journal();
    setChecks([
      { id: "acct", sheet: je.id, kind: "inList", col: 1, listSheet: "COA", listCol: 0 },
      { id: "dc", sheet: je.id, kind: "totalsEqual", col: 2, otherCol: 3 },
      { id: "f", sheet: "JE", kind: "formula", formula: "=OR(C2>0,D2>0)" },
      { id: "desc", sheet: je.id, kind: "notBlank", col: 4, severity: "warn" },
    ]);
    const r = runWorkbookChecks(workbook);
    expect(r.map((x) => x.status)).toEqual(["fail", "fail", "pass", "warn"]);
    expect(r[0].failures[0]).toMatchObject({ row: 2, value: 9999 });
    expect(r[1].totals).toEqual({ left: 150, right: 140, difference: 10 });
    expect(failingChecks(r).map((x) => x.id)).toEqual(["acct", "dc"]);
    // links: data row 2 is sheet row 3 (0-based), the account column
    expect(failureCell(workbook, r[0], r[0].failures[0])).toEqual({ sheetId: je.id, row: 3, col: 1 });
    expect(failureCell(workbook, r[1], r[1].failures[0])).toEqual({ sheetId: je.id, row: 5, col: 2 });
    expect(checksPass(workbook)).toBe(false);
    expect(coa.name).toBe("COA");
  });

  it("formula checks catch failing rows", async () => {
    const { workbook, je } = await journal();
    setChecks([{ id: "f", sheet: je.id, kind: "formula", formula: "=C2>0" }]);
    const [r] = runWorkbookChecks(workbook);
    expect(r.failed).toBe(2);
    expect(r.failures.map((f) => f.row)).toEqual([1, 3]);
  });

  it("gates export only when a check fails", async () => {
    const { workbook, je } = await journal();
    let exported = 0;
    expect(await gateExport(() => exported++, workbook)).toBe(true); // no checks
    setChecks([{ id: "a", sheet: je.id, kind: "notBlank", col: 0 }]);
    expect(checksPass(workbook)).toBe(true);
    expect(await gateExport(() => exported++, workbook)).toBe(true);
    setChecks([{ id: "a", sheet: je.id, kind: "notBlank", col: 0, enabled: false }]);
    expect(checksPass(workbook)).toBe(true);
    expect(exported).toBe(2);
  });
});

describe("check list helpers", () => {
  it("moves items and makes blank checks", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
    const t = blankCheck("totalsEqual", "s", 4);
    expect(t).toMatchObject({ kind: "totalsEqual", col: 0, otherCol: 1, sheet: "s" });
    expect(blankCheck("noDuplicateKeys", "s", 3)).toMatchObject({ cols: [0] });
    expect(blankCheck("rowCount", "s", 1).id).not.toBe(blankCheck("rowCount", "s", 1).id);
  });
});

describe("categorisation helpers", () => {
  it("turns rule rows into rules and back", () => {
    const r = rowToRule({ match: "word", text: "uber", min: "10", max: "", category: " Travel ", priority: "5" }, "x");
    expect(r).toEqual({ id: "x", condition: { kind: "all", conditions: [{ kind: "contains", text: "uber", word: true }, { kind: "amount", min: 10 }] }, category: "Travel", priority: 5 });
    expect(ruleToRow(r)).toEqual({ match: "word", text: "uber", min: "10", max: "", category: "Travel", priority: "5" });
    expect(rowToRule({ match: "regex", text: "^aws", min: "", max: "", category: "IT", priority: "" }, "y").condition).toEqual({ kind: "regex", pattern: "^aws" });
    expect(rowToRule({ match: "none", text: "", min: "", max: "0", category: "Refunds", priority: "" }, "z").condition).toEqual({ kind: "amount", max: 0 });
    expect(ruleToRow({ id: "q", category: "X", condition: { kind: "all", conditions: [{ kind: "contains", text: "a" }, { kind: "startsWith", text: "b" }] } })).toBeNull();
  });

  it("keeps category text as text", () => {
    expect(categoryInput("Travel")).toBe("Travel");
    expect(categoryInput("2024")).toBe("'2024");
    expect(categoryInput("=x")).toBe("'=x");
    expect(categoryInput("TRUE")).toBe("'TRUE");
  });

  it("reads rows, applies rules into one cell edit, bulk tags and filters the queue", async () => {
    const { history, workbook, je } = await journal();
    const data = readSheet(je.source);
    const cols = guessCatColumns(data.names);
    expect(cols).toEqual({ text: 4, amount: 2, category: 5 });
    const rows = readCatRows(data, cols);
    expect(rows[0]).toEqual({ text: "UBER TRIP", amount: 100, category: null });
    const result = categorise(rows, [{ id: "u", condition: { kind: "contains", text: "uber" }, category: "Travel" }]);
    const cells = categoryCells(data, cols.category, result);
    expect(cells).toEqual([
      { row: 0, col: 5, input: "Category" },
      { row: 1, col: 5, input: "Travel" },
      { row: 3, col: 5, input: "Travel" },
    ]);
    await history.run(setCells(cells, "categorise", je.id));
    const after = readSheet(je.source);
    expect(after.col(5)).toEqual(["Travel", null, "Travel", null]);
    // a manual tag is kept on a second run
    await history.run(setCells([{ row: 3, col: 5, input: "Personal" }], undefined, je.id));
    const again = categorise(readCatRows(readSheet(je.source), cols), [{ id: "u", condition: { kind: "contains", text: "uber" }, category: "Travel" }]);
    expect(again.changed).toEqual([]);
    expect(again.keptManual).toEqual([2]);
    // bulk tag: header row and rows past the data are left out
    const tag = bulkTagCells(after, { top: 0, bottom: 50 }, 5, "Misc");
    expect(tag.map((c) => c.row)).toEqual([1, 2, 3, 4]);
    expect(bulkTagCells(after, { top: 2, bottom: 2 }, 5, "")).toEqual([{ row: 2, col: 5, input: null }]);
    // the uncategorised queue
    const f = uncategorisedFilter(je.id, after, 5);
    expect(f).toEqual({ type: "filter.set", params: { sheet: je.id, col: 5, condition: { kind: "blanks", blank: true }, headerRow: 0 } });
    await history.run(f);
    expect(workbook.get(je.id).source.filter?.conditions).toEqual([{ col: 5, cond: { kind: "blanks", blank: true } }]);
  });
});
