import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { Table } from "@cellforge/core";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { BlankSource, EditableSource } from "./editable";
import { explainCell, writeUp } from "./lineage";
import { Workbook } from "./workbook";

describe("explaining where a number came from", () => {
  it("walks formulas to typed and imported values, with origins and row provenance", async () => {
    const imported = new EditableSource(
      new Table([
        { kind: "string", name: "source file", codes: Uint32Array.from([1, 2]), dict: ["jan.csv", "feb.csv"] },
        { kind: "number", name: "Amount", values: Float64Array.from([100, 250]) },
      ]),
    );
    const workbook = new Workbook({ name: "Summary", source: new EditableSource(new BlankSource(20, 4)) });
    workbook.add("Data", imported, undefined, undefined, { origin: "Combined 2 files: jan.csv, feb.csv" });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(
      setCells([
        { row: 0, col: 0, input: "0.2" },
        { row: 1, col: 0, input: "=Data!B1+Data!B2" },
        { row: 2, col: 0, input: "=A2*A1" },
        { row: 3, col: 0, input: "=SUM(A1:A3)*A1" },
      ]),
    );
    const sid = workbook.sheets[0].id;
    const at = Date.UTC(2026, 10, 16, 9, 30);
    const tree = explainCell(workbook, sid, 2, 0, { lastEdit: (s, r, c) => (s === sid && r === 0 && c === 0 ? { at, text: "0.2" } : undefined) });
    expect(tree.kind).toBe("formula");
    expect(tree.formula).toBe("=A2*A1");
    expect(tree.value).toBe("70");
    expect(tree.children.map((c) => [c.label, c.kind])).toEqual([
      ["A2", "formula"],
      ["A1", "typed"],
    ]);
    const data = tree.children[0].children;
    expect(data.map((c) => [c.label, c.value, c.kind, c.provenance])).toEqual([
      ["Data!B1", "100", "imported", "source file jan.csv"],
      ["Data!B2", "250", "imported", "source file feb.csv"],
    ]);
    expect(data[0].origin).toBe("Combined 2 files: jan.csv, feb.csv");

    const text = writeUp(tree);
    expect(text.split("\n")[0]).toBe("A3 is 70, worked out as =A2*A1 (A2 times A1).");
    expect(text).toContain("Data!B2 is 250, from the data as imported (Combined 2 files: jan.csv, feb.csv); this row: source file feb.csv.");
    expect(text).toContain("A1 is 0.2, typed in on");

    // a repeated cell is explained once
    const twice = explainCell(workbook, sid, 3, 0);
    expect(twice.children.some((c) => c.kind === "range" || c.label === "A1")).toBe(true);
    const labels: string[] = [];
    const walk = (n: typeof twice) => {
      labels.push(n.label + (n.repeat ? "*" : ""));
      n.children.forEach(walk);
    };
    walk(twice);
    expect(labels.filter((l) => l === "A1").length).toBe(1);
    expect(labels).toContain("A1*");
  });

  it("summarises big ranges instead of listing every cell", async () => {
    const workbook = new Workbook({ name: "S", source: new EditableSource(new BlankSource(200, 2)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells([...Array.from({ length: 100 }, (_, i) => ({ row: i, col: 0, input: "2" })), { row: 0, col: 1, input: "=SUM(A1:A100)" }]));
    const tree = explainCell(workbook, workbook.sheets[0].id, 0, 1);
    expect(tree.children).toEqual([expect.objectContaining({ kind: "range", label: "A1:A100", range: { cells: 100, numbers: 100, total: 200 } })]);
  });
});

describe("spilled results", () => {
  it("point back to the formula that spilled them", async () => {
    const workbook = new Workbook({ name: "S", source: new EditableSource(new BlankSource(20, 3)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(setCells([{ row: 0, col: 0, input: "=SEQUENCE(3)" }, { row: 0, col: 1, input: "=A3*10" }]));
    const tree = explainCell(workbook, workbook.sheets[0].id, 0, 1);
    expect(tree.children[0]).toMatchObject({ label: "A3", kind: "spill", value: "3" });
    expect(tree.children[0].children[0]).toMatchObject({ label: "A1", kind: "formula", formula: "=SEQUENCE(3)" });
    expect(writeUp(tree)).toContain("A3 is 3, part of the result of the formula in A1.");
  });
});

describe("formulas read in plain English", () => {
  it("names a column block by its heading", async () => {
    const workbook = new Workbook({ name: "Sales", source: new EditableSource(new BlankSource(20, 4)) });
    const ctx: SheetCtx = { workbook, activeSheet: workbook.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    await h.run(
      setCells([
        { row: 0, col: 0, input: "Region" },
        { row: 0, col: 1, input: "Amount" },
        { row: 1, col: 0, input: "North" },
        { row: 1, col: 1, input: "10" },
        { row: 2, col: 0, input: "South" },
        { row: 2, col: 1, input: "30" },
        { row: 5, col: 3, input: '=SUMIF(A2:A3,"North",B2:B3)' },
      ]),
    );
    const tree = explainCell(workbook, workbook.sheets[0].id, 5, 3);
    expect(tree.words).toBe('The total of Amount (B2:B3) where Region (A2:A3) is "North".');
    expect(writeUp(tree).split("\n")[0]).toBe('D6 is 10, worked out as =SUMIF(A2:A3, "North", B2:B3) (the total of Amount (B2:B3) where Region (A2:A3) is "North").');
  });
});
