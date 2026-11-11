import { describe, expect, it } from "vitest";
import { Table } from "@cellforge/core";
import { readSheet } from "./audittools";
import { EditableSource } from "./editable";

describe("audit tools: reading the sheet", () => {
  it("uses the column names and keeps grid row numbers", () => {
    const src = new EditableSource(
      new Table([
        { kind: "string", name: "Vendor", codes: Uint32Array.from([1, 2, 0]), dict: ["Acme", "Bolt"] },
        { kind: "number", name: "Amount", values: Float64Array.from([10, NaN, 30]) },
      ]),
      5,
    );
    const data = readSheet(src);
    expect(data.names.slice(0, 2)).toEqual(["A: Vendor", "B: Amount"]);
    expect(data.first).toBe(0);
    expect(data.rows).toBe(3);
    expect(data.col(0)).toEqual(["Acme", "Bolt", null]);
    expect(data.col(1)).toEqual([10, null, 30]);
    expect(data.sheetRow(0)).toBe(1);
    expect(data.nonBlank()).toEqual([0, 1, 2]);
  });

  it("takes names from the first row when the sheet has none", () => {
    const src = new EditableSource(
      new Table([
        { kind: "string", name: "", codes: Uint32Array.from([1, 2, 3]), dict: ["Invoice", "INV-1", "INV-3"] },
        { kind: "string", name: "", codes: Uint32Array.from([1, 0, 0]), dict: ["Amount"] },
      ]),
      5,
    );
    const data = readSheet(src);
    expect(data.names.slice(0, 2)).toEqual(["A: Invoice", "B: Amount"]);
    expect(data.first).toBe(1);
    expect(data.rows).toBe(2);
    expect(data.col(0)).toEqual(["INV-1", "INV-3"]);
    expect(data.sheetRow(0)).toBe(2);
  });
});

describe("audit tests on the audit sample's journal", () => {
  it("tests gaps over distinct entry numbers when the lines of an entry share its number", async () => {
    const { auditSample } = await import("./samples");
    const { looksLikeEntryLines, sequenceTest } = await import("./audittools");
    const s = auditSample();
    const entries = s.lines.map((l) => l.entry);
    expect(looksLikeEntryLines(entries)).toBe(true);
    // line by line, nearly every entry number looks "used more than once"
    const lines = sequenceTest(entries, false);
    expect(lines.series[0].duplicates.length).toBeGreaterThan(700);
    // by entry: just the planted gap
    const r = sequenceTest(entries, true);
    expect(r.entries).toBe(new Set(entries).size);
    expect(r.series).toHaveLength(1);
    expect(r.series[0].missingCount).toBe(s.gaps.length);
    expect(r.series[0].missing.map((g) => [g.from, g.to])).toEqual([[s.gaps[0], s.gaps[s.gaps.length - 1]]]);
    expect(r.series[0].duplicates).toEqual([]);
    expect(r.series[0].outOfOrder).toEqual([]);
    // a number that comes back after other entries is still a duplicate, on its sheet row
    const again = [...entries, entries[0]];
    const d = sequenceTest(again, true);
    expect(d.series[0].duplicates).toEqual([{ number: entries[0], rows: [0, again.length - 1] }]);
    expect(looksLikeEntryLines([1, 2, 3, 4, 5, 6])).toBe(false);
  });

  it("records each test on Results, and a rerun updates it", async () => {
    const { ActionHistory, BlobStore } = await import("@cellforge/actions");
    const { sheetActions } = await import("./actions");
    const { sampleWorkbook } = await import("./samples");
    const { recordOnResults, resultsSheet } = await import("./audittools");
    const { workbook: wb } = await sampleWorkbook("audit");
    const ctx = { workbook: wb, activeSheet: wb.byName("Population")!.id, blobs: new BlobStore(), sortRows: async () => null };
    const h = new ActionHistory(sheetActions(), () => ctx);
    const run = (a: Parameters<typeof h.run>[0]) => h.run(a);
    expect(resultsSheet(wb)?.name).toBe("Results");
    const res = wb.byName("Results")!.source;
    expect(res.getCell(2, 1)).toBe("Not started");
    await recordOnResults(wb, run, { test: "sequence", exceptions: 760, detail: "first run" }, "Population gaps");
    expect([res.getCell(2, 1), res.getCell(2, 2), res.getCell(2, 5)]).toEqual(["Done: exceptions", 760, "first run"]);
    expect(res.extraAt(2, 5)?.link).toBe("#'Population gaps'!A1");
    await recordOnResults(wb, run, { test: "sequence", exceptions: 2, detail: "by entry" });
    expect([res.getCell(2, 1), res.getCell(2, 2), res.getCell(2, 5)]).toEqual(["Done: exceptions", 2, "by entry"]);
    await recordOnResults(wb, run, { test: "duplicates", exceptions: 0, detail: "none" });
    expect(res.getCell(1, 1)).toBe("Done: no exceptions");
    await recordOnResults(wb, run, { test: "sample", exceptions: null, status: "In progress", label: "Sample (seed 154)", detail: "25 items" });
    expect([res.getCell(6, 0), res.getCell(6, 1), res.getCell(6, 2)]).toEqual(["Sample (seed 154)", "In progress", null]);
    // the conclusion stays the auditor's
    expect(res.getCell(2, 3)).toBe(null);
    // the Results figures are formatted and use total debits
    expect(res.getStyle(9, 1)?.numFmt).toBe("#,##0");
    expect(res.getCell(10, 1) as number).toBeGreaterThan(0);
  });
});
