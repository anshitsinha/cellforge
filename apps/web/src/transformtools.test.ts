import { describe, expect, it } from "vitest";
import { dateToSerial, parseTyped, Table, type ColumnData } from "@cellforge/core";
import { readSheet } from "./audittools";
import { EditableSource, parseInput } from "./editable";
import { buildColumns, cellText, dedupePlan, extractPlan, parseCellRef, pivotPlan, seekOnClone, splitPlan, targetRows, toInput, unpivotPlan } from "./transformtools";

const text = (name: string, values: (string | null)[]): ColumnData => {
  const dict: string[] = [];
  const codes = Uint32Array.from(values, (v) => {
    if (v === null) return 0;
    let i = dict.indexOf(v);
    if (i < 0) i = dict.push(v) - 1;
    return i + 1;
  });
  return { kind: "string", name, codes, dict };
};
const num = (name: string, values: (number | null)[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values, (v) => v ?? NaN) });

/** What typing `input` into a cell stores (as cells.set does it). */
function typed(input: string | null): unknown {
  if (input === null) return null;
  const t = !input.trim().startsWith("=") && !input.startsWith("'") ? parseTyped(input) : null;
  return t ? t.value : parseInput(input);
}

describe("transform tools: helpers", () => {
  it("parses cell references", () => {
    expect(parseCellRef("B3")).toEqual({ row: 2, col: 1 });
    expect(parseCellRef(" $aa$10 ")).toEqual({ row: 9, col: 26 });
    expect(parseCellRef("B0")).toBeNull();
    expect(parseCellRef("B3:C4")).toBeNull();
    expect(parseCellRef("")).toBeNull();
  });

  it("turns values into input that types back as the same value", () => {
    expect(toInput(null)).toBeNull();
    expect(toInput("007", "text")).toBe("'007");
    expect(typed(toInput("007", "text"))).toBe("007");
    expect(typed(toInput("=SUM(A1)", "text"))).toBe("=SUM(A1)");
    expect(typed(toInput(1234.5))).toBe(1234.5);
    expect(typed(toInput(-0.1))).toBe(-0.1);
    const d = dateToSerial(2024, 1, 15);
    expect(toInput(d, "date")).toBe("2024-01-15");
    expect(typed(toInput(d, "date"))).toBe(d);
    expect(typed(toInput(d + 0.5, "date"))).toBeCloseTo(d + 0.5, 6);
    expect(toInput(0.125, "number", "0.0%")).toBe("12.5%");
    expect(typed(toInput(0.125, "number", "0.0%"))).toBeCloseTo(0.125, 12);
    expect(toInput(true)).toBe("TRUE");
    expect(toInput(NaN)).toBeNull();
  });

  it("builds typed result columns", () => {
    const { columns, numFmts } = buildColumns(
      ["A", "B", "C"],
      [
        [1, "x", null],
        [null, 2, null],
      ],
      ["0.00", "0.00", "@"],
    );
    expect(columns.map((c) => c.kind)).toEqual(["number", "string", "number"]);
    expect(numFmts).toEqual(["0.00", "", "@"]);
    const t = new Table(columns);
    expect(t.getCell(0, 0)).toBe(1);
    expect(t.getCell(1, 0)).toBeNull();
    expect(t.getCell(1, 1)).toBe("2");
  });

  it("reads dates as ISO text", () => {
    const src = new EditableSource(new Table([num("D", [dateToSerial(2024, 3, 1)])]), 2);
    src.styles.apply(0, "all", { numFmt: "d/m/yyyy" });
    expect(cellText(src, 0, 0)).toBe("2024-03-01");
    expect(cellText(src, 0, 1)).toBe("");
  });

  it("works on the selected rows when more than one is selected", () => {
    const src = new EditableSource(new Table([text("A", ["a", "b", "c", "d"])]), 2);
    const data = readSheet(src);
    expect(targetRows(data, { top: 1, bottom: 1, left: 0, right: 0 })).toEqual([0, 1, 2, 3]);
    expect(targetRows(data, { top: 1, bottom: 2, left: 0, right: 0 })).toEqual([1, 2]);
  });
});

describe("transform tools: remove duplicates", () => {
  const src = new EditableSource(
    new Table([text("Vendor", ["Acme", "acme", "Bolt", "Acme"]), num("Amount", [10, 10, 5, 10]), text("Note", ["a", "b", "c", "d"])]),
    5,
  );
  src.styles.apply(1, "all", { numFmt: "#,##0.00" });
  const data = readSheet(src);

  it("keeps the first of each set on a new sheet", () => {
    const p = dedupePlan(data, "Sheet1", [0, 1], {});
    expect(p.removed).toBe(1);
    expect(p.groups).toBe(1);
    expect(p.sheets.length).toBe(1);
    expect(p.sheets[0].name).toBe("Sheet1 unique");
    expect(p.sheets[0].header).toEqual(["Vendor", "Amount", "Note"]);
    expect(p.sheets[0].rows).toEqual([
      ["Acme", 10, "a"],
      ["acme", 10, "b"],
      ["Bolt", 5, "c"],
    ]);
    expect(p.sheets[0].numFmts).toEqual(["", "#,##0.00", ""]);
  });

  it("lists the removed rows with their sheet row numbers", () => {
    const p = dedupePlan(data, "S", [0, 1], { ignoreCase: true, keep: "last" }, true);
    expect(p.removed).toBe(2);
    expect(p.sheets[0].rows.map((r) => r[2])).toEqual(["c", "d"]);
    expect(p.sheets[1].header.slice(0, 2)).toEqual(["Row", "Same as row"]);
    expect(p.sheets[1].rows).toEqual([
      [1, 4, "Acme", 10, "a"],
      [2, 4, "acme", 10, "b"],
    ]);
  });

  it("never changes the original sheet", () => {
    dedupePlan(data, "S", [0], {});
    expect(src.editCount).toBe(0);
  });
});

describe("transform tools: text to columns", () => {
  it("writes typed columns to the right, with headers when the first row names the columns", () => {
    const src = new EditableSource(new Table([text("", ["Detail", "Rent,1200.50,2024-01-15", "Rates,(30.00),2024-02-01", "0042,7,"])]), 5);
    const data = readSheet(src);
    expect(data.first).toBe(1);
    const w = splitPlan(src, data, 0, targetRows(data, { top: 0, bottom: 0, left: 0, right: 0 }), { mode: "delimited", delimiters: [","] });
    expect(w.columns).toBe(3);
    expect(w.overwrite).toBe(0);
    expect(w.addColumns).toBe(0);
    const at = (row: number, col: number) => w.cells.find((c) => c.row === row && c.col === col)?.input;
    expect(at(0, 1)).toBe("'Detail 1");
    expect(at(1, 1)).toBe("'Rent");
    expect(at(3, 1)).toBe("'0042");
    expect(at(1, 2)).toBe("1200.5");
    expect(at(2, 2)).toBe("-30");
    expect(at(1, 3)).toBe("2024-01-15");
    expect(at(3, 3)).toBeUndefined(); // blank into an empty cell: nothing to write
    expect(w.preview[0]).toEqual(["Detail", "B: Detail 1", "C: Detail 2", "D: Detail 3"]);
    expect(w.preview[1]).toEqual(["Rent,1200.50,2024-01-15", "Rent", "1200.5", "2024-01-15"]);
  });

  it("counts filled cells it would overwrite and columns it must add", () => {
    const src = new EditableSource(new Table([text("A", ["a b c", "d e"]), text("B", ["keep", null])]), 1);
    const data = readSheet(src);
    const w = splitPlan(src, data, 0, [0, 1], { mode: "delimited", delimiters: [" "] });
    expect(w.overwrite).toBe(1);
    expect(w.addColumns).toBe(1); // A + 3 new columns, the sheet has 3 (2 + 1 spare)
    // a blank piece over a filled cell clears it, so it's written
    expect(w.cells.filter((c) => c.col === 3).map((c) => c.input)).toEqual(["'c"]);
  });

  it("writes text into Text-formatted cells without the apostrophe", () => {
    const src = new EditableSource(new Table([text("A", ["x;007"])]), 3);
    src.styles.apply(2, "all", { numFmt: "@" });
    const w = splitPlan(src, readSheet(src), 0, [0], { mode: "delimited", delimiters: [";"] });
    expect(w.cells).toEqual([
      { row: 0, col: 1, input: "'x" },
      { row: 0, col: 2, input: "007" },
    ]);
  });

  it("splits at fixed widths", () => {
    const src = new EditableSource(new Table([text("Line", ["AB  12", "CD  34"])]), 5);
    const w = splitPlan(src, readSheet(src), 0, [0, 1], { mode: "fixed", breaks: [4] });
    expect(w.cells.map((c) => c.input)).toEqual(["'AB", "'CD", "12", "34"]);
  });

  it("refuses a write that's too big", () => {
    const n = 600_000;
    const src = new EditableSource(new Table([text("A", Array.from({ length: n }, () => "a,b"))]), 5);
    expect(() => splitPlan(src, readSheet(src), 0, Array.from({ length: n }, (_, i) => i), { mode: "delimited", delimiters: [","] })).toThrow(/most at once/);
  });
});

describe("transform tools: extract", () => {
  const src = new EditableSource(new Table([text("Narrative", ["PAYMENT INV-2024-001 ACME", "Refund ref: R77", null, "nothing"]), text("Next", [null, "x", null, null])]), 5);
  const data = readSheet(src);

  it("writes what it finds next to the source", () => {
    const w = extractPlan(src, data, 0, [0, 1, 2, 3], { kind: "code" });
    expect(w.found).toBe(2);
    expect(w.overwrite).toBe(1);
    // nothing found in an empty cell: nothing to write
    expect(w.cells).toEqual([
      { row: 0, col: 1, input: "'INV-2024-001" },
      { row: 1, col: 1, input: "'R77" },
    ]);
    expect(w.preview[0]).toEqual(["Narrative", "B: code"]);
  });

  it("adds a found column and dates as dates", () => {
    const s2 = new EditableSource(new Table([text("", ["Memo", "paid 15/03/2024", "none"])]), 5);
    const d2 = readSheet(s2);
    const w = extractPlan(s2, d2, 0, [0, 1], { kind: "date" }, { flag: true });
    expect(w.columns).toBe(2);
    expect(w.cells).toEqual([
      { row: 0, col: 1, input: "'Memo date" },
      { row: 0, col: 2, input: "'date found" },
      { row: 1, col: 1, input: "2024-03-15" },
      { row: 1, col: 2, input: "TRUE" },
      { row: 2, col: 2, input: "FALSE" },
    ]);
  });

  it("takes the reference after a keyword", () => {
    const w = extractPlan(src, data, 0, [0, 1, 2, 3], { kind: "after", keyword: "ref" });
    expect(w.found).toBe(1);
    expect(w.cells.find((c) => c.row === 1)?.input).toBe("'R77");
  });
});

describe("transform tools: unpivot and pivot", () => {
  const src = new EditableSource(new Table([text("Account", ["Sales", "Rent"]), num("Jan", [100, 50]), num("Feb", [120, null])]), 5);
  src.styles.apply(1, "all", { numFmt: "#,##0" });
  src.styles.apply(2, "all", { numFmt: "#,##0" });
  const data = readSheet(src);

  it("unpivots into a new sheet, keeping the shared format", () => {
    const out = unpivotPlan(data, "TB", [0], [1, 2], { nameColumn: "Month", valueColumn: "Amount" });
    expect(out.name).toBe("TB unpivoted");
    expect(out.header).toEqual(["Account", "Month", "Amount"]);
    expect(out.rows).toEqual([
      ["Sales", "Jan", 100],
      ["Sales", "Feb", 120],
      ["Rent", "Jan", 50],
    ]);
    expect(out.numFmts).toEqual(["", "", "#,##0"]);
  });

  it("pivots the unpivoted table back", () => {
    const long = unpivotPlan(data, "TB", [0], [1, 2], {});
    const s2 = new EditableSource(new Table(buildColumns(long.header, long.rows, long.numFmts).columns), 5);
    const out = pivotPlan(readSheet(s2), "Long", [0], 1, 2, "sum");
    expect(out.header).toEqual(["Account", "Jan", "Feb"]);
    expect(out.rows).toEqual([
      ["Sales", 100, 120],
      ["Rent", 50, null],
    ]);
    expect(out.skipped).toBe(0);
    expect(pivotPlan(readSheet(s2), "Long", [0], 1, 2, "count").rows[1]).toEqual(["Rent", 1, 0]);
  });
});

describe("transform tools: goal seek", () => {
  function sheet() {
    // A1 rate, A2 = loan payment on 1000 over 12 periods, A3 = A2 * 12
    const src = new EditableSource(new Table([num("", [0.01, null, null])]), 3);
    src.setCell(1, 0, parseInput("=1000*A1/(1-(1+A1)^-12)"));
    src.setCell(2, 0, parseInput("=A2*12"));
    src.setCell(0, 1, parseInput("=A1+1"));
    src.setCell(1, 1, "text");
    return src;
  }

  it("finds the input on a copy and leaves the sheet alone", () => {
    const src = sheet();
    const before = src.getCell(2, 0);
    const r = seekOnClone(src, { row: 2, col: 0 }, { row: 0, col: 0 }, 1080);
    expect(r.converged).toBe(true);
    expect(r.start).toBe(0.01);
    expect(r.value).toBeCloseTo(1080, 4);
    expect(src.getCell(0, 0)).toBe(0.01);
    expect(src.getCell(2, 0)).toBe(before);
    // applying the answer gives the target
    src.setCell(0, 0, r.x);
    expect(src.getCell(2, 0) as number).toBeCloseTo(1080, 4);
  });

  it("explains bad cells", () => {
    const src = sheet();
    expect(() => seekOnClone(src, { row: 0, col: 0 }, { row: 0, col: 0 }, 1)).toThrow(/has no formula/);
    expect(() => seekOnClone(src, { row: 2, col: 0 }, { row: 1, col: 0 }, 1)).toThrow(/holds a formula/);
    expect(() => seekOnClone(src, { row: 2, col: 0 }, { row: 1, col: 1 }, 1)).toThrow(/holds text/);
  });

  it("says when the formula doesn't use the changing cell", () => {
    const src = sheet();
    const r = seekOnClone(src, { row: 0, col: 1 }, { row: 2, col: 2 }, 5);
    expect(r.converged).toBe(false);
    expect(r.reason).toMatch(/doesn't change/);
  });

  it("starts from 0 when the changing cell is empty", () => {
    const src = new EditableSource(new Table([num("", [null, null])]), 1);
    src.setCell(1, 0, parseInput("=A1*3-6"));
    const r = seekOnClone(src, { row: 1, col: 0 }, { row: 0, col: 0 }, 0);
    expect(r.start).toBe(0);
    expect(r.x).toBeCloseTo(2, 9);
  });
});
