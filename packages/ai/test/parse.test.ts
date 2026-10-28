import { describe, expect, it } from "vitest";
import { type AskContext, actionsOf, findColumn, normalizeRequest, parse, parseNumber, validateAction } from "../src";
import { CATALOG, salesContext } from "./fixtures";
import { A, cases } from "./cases";

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
    if ("figure" in want) {
      expect(r.figure).toMatchObject(want.figure);
      expect(r.figure?.sheet).toBe(want.figure.sheet);
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

describe("parse: single figures", () => {
  it("gives the formula and a label, and changes nothing", () => {
    const r = parse("what is the total amount", salesContext())!;
    expect(r.figure).toEqual({ fn: "SUM", col: 2, range: { top: 1, left: 2, bottom: 199, right: 2 }, label: "Total of Amount (column C)", formula: "=SUM(C2:C200)" });
    expect(actionsOf(r)).toEqual([]);
    expect(r.explanation).toMatch(/nothing on the sheet changes/i);
  });
  it("says which rows a journal flag will highlight", () => {
    const r = parse("flag weekend postings over 10,000", salesContext())!;
    expect(r.explanation).toMatch(/Saturday or Sunday.*Amount \(column C\) over 10,000/);
  });
});
