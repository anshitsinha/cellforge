import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { Table, type ColumnData } from "@cellforge/core";
import { readPdfText } from "../../../../packages/core/src/pdf/read";
import { sheetActions, type SheetCtx } from "../actions";
import { buildChart } from "../charts/data";
import { pivotChartSpec, savePivot } from "../charts/pivotspec";
import { chartInput, pivotGrid } from "../charts/pivotchart";
import { defaultSpec } from "../charts/model";
import { BlankSource, EditableSource, parseInput } from "../editable";
import { emptyLayout, pivotChartForLayout, placeField, readSheetColumns, toSpec } from "../pivotpanel";
import { Workbook } from "../workbook";
import { registerReportActions, reportsOf } from "./actions";
import { expandText, paramLiteral, parseTemplate, rollForward, rollPeriod, runBook, runForValues, runReport, substituteFormula, workbookEnv } from "./engine";
import { newBlock, newReport, reportProblem, type Report } from "./model";
import { reportHtml, reportPdf, toSection } from "./output";

function text(name: string, values: (string | null)[]): ColumnData {
  const dict: string[] = [];
  const codes = Uint32Array.from(values, (v) => {
    if (!v) return 0;
    const i = dict.indexOf(v);
    return i >= 0 ? i + 1 : dict.push(v);
  });
  return { kind: "string", name, codes, dict };
}
const num = (name: string, values: number[]): ColumnData => ({ kind: "number", name, values: Float64Array.from(values) });

function sales(): EditableSource {
  const src = new EditableSource(
    new Table([text("Region", ["North", "South", "North", "South", "North"]), text("Product", ["A", "A", "B", "B", "A"]), num("Amount", [10, 20, 30, 40, 50])]),
    5,
  );
  src.styles.apply(2, "all", { numFmt: "#,##0.00" });
  return src;
}

function setup() {
  const wb = new Workbook({ name: "Sales", source: sales() });
  const summary = wb.add("Summary", new EditableSource(new BlankSource(20, 5)));
  const put = (row: number, col: number, t: string) => summary.source.setCell(row, col, parseInput(t));
  put(0, 0, "Revenue");
  put(0, 1, "100");
  put(1, 0, "Last year");
  put(1, 1, "80");
  put(2, 0, "Total");
  put(2, 1, "=B1+B2");
  const sales_ = wb.sheets[0];
  return { wb, env: workbookEnv(wb), salesId: sales_.id, summaryId: summary.id };
}

function report(sheetId: string, extra: Partial<Report> = {}): Report {
  return { ...newReport(sheetId, "Sales report"), ...extra };
}

describe("templates", () => {
  it("splits text into plain parts, parameters and formulas (braces and strings inside formulas are fine)", () => {
    expect(parseTemplate('Hi {{ entity }}: {{=TEXT(B1,"{0}")}} and {{=SUM({1,2})}}!')).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "param", text: "entity" },
      { kind: "text", text: ": " },
      { kind: "formula", text: 'TEXT(B1,"{0}")' },
      { kind: "text", text: " and " },
      { kind: "formula", text: "SUM({1,2})" },
      { kind: "text", text: "!" },
    ]);
    expect(parseTemplate("no {{=end")).toEqual([{ kind: "text", text: "no {{=end" }]);
    expect(parseTemplate("{{not a name}}")).toEqual([{ kind: "text", text: "{{not a name}}" }]);
  });

  it("puts parameters into formulas as values", () => {
    expect(paramLiteral({ value: "North" })).toBe('"North"');
    expect(paramLiteral({ value: 'Say "hi"' })).toBe('"Say ""hi"""');
    expect(paramLiteral({ value: "2026" })).toBe("2026");
    expect(paramLiteral({ value: "2026-03-31" })).toBe("DATE(2026,3,31)");
    expect(paramLiteral({ value: "x", all: true })).toBe('"*"');
    const p = { entity: { value: "North" } };
    expect(substituteFormula('SUMIFS(C:C,A:A,{entity})&"{entity}"&SUM({1,2})', p)).toBe('SUMIFS(C:C,A:A,"North")&"{entity}"&SUM({1,2})');
    expect(substituteFormula("{ENTITY}", p)).toBe('"North"');
  });

  it("works out formulas against the workbook, with cross-sheet references and parameters", () => {
    const { env, salesId } = setup();
    const problems: string[] = [];
    const params = { entity: { value: "North" } };
    const out = expandText('{{entity}} sold {{=SUMIFS(C:C,A:A,{entity})}}; growth {{=TEXT(Summary!B1/Summary!B2-1,"0%")}}; {{=1/0}} {{missing}}', params, (f) => env.evaluate(f, salesId), problems);
    expect(out).toBe("North sold 90; growth 25%; #DIV/0! {{missing}}");
    expect(problems).toHaveLength(2);
    expect(expandText("{{=Summary!B3}} {{=2/3}} {{=\"a\"&\"b\"}} {{=1>0}}", {}, (f) => env.evaluate(f, salesId))).toBe("180 0.67 ab TRUE");
    expect(expandText("{{=SUM(}}", {}, (f) => env.evaluate(f, salesId))).toBe("#ERROR!");
  });
});

describe("roll forward", () => {
  it("moves periods on in the same style", () => {
    expect(rollPeriod("2026-03-31")).toBe("2026-04-30");
    expect(rollPeriod("2026-01-31")).toBe("2026-02-28");
    expect(rollPeriod("2026-01-15", -2)).toBe("2025-11-15");
    expect(rollPeriod("2026-12")).toBe("2027-01");
    expect(rollPeriod("Dec 2026")).toBe("Jan 2027");
    expect(rollPeriod("March 2026")).toBe("April 2026");
    expect(rollPeriod("Q4 2026")).toBe("Q1 2027");
    expect(rollPeriod("2026-Q2")).toBe("2026-Q3");
    expect(rollPeriod("FY2026")).toBe("FY2027");
    expect(rollPeriod("FY26", -1)).toBe("FY25");
    expect(rollPeriod("2026")).toBe("2027");
    expect(rollPeriod("North")).toBeNull();
  });

  it("rolls the report's period parameters, not the entity", () => {
    const r = report("s", { params: [{ name: "entity", value: "2026" }, { name: "period", value: "2026-03-31" }, { name: "note", value: "hello" }], runFor: { param: "entity", list: ["2026"] } });
    const { report: next, changed } = rollForward(r);
    expect(changed).toEqual(["period"]);
    expect(next.params.map((p) => p.value)).toEqual(["2026", "2026-04-30", "hello"]);
    expect(rollForward(r, 1, "entity").report.params[0].value).toBe("2027");
  });
});

describe("running a report", () => {
  it("runs headings, text, range tables, pivot tables and charts", () => {
    const { wb, env, salesId, summaryId } = setup();
    const data = readSheetColumns(wb.get(salesId).source);
    let layout = placeField(emptyLayout(), data, 0, "rows");
    layout = placeField(layout, data, 2, "values");
    const pivot = savePivot(toSpec(layout), data.names);
    wb.charts = [pivotChartSpec("c1", salesId, pivot, "column", "By region")];
    const r = report(salesId, {
      params: [{ name: "entity", value: "North" }],
      blocks: [
        { id: "1", kind: "heading", text: "{{entity}}", level: 1 },
        { id: "2", kind: "paragraph", text: "Sales {{=SUMIFS(C:C,A:A,{entity})}}" },
        { id: "3", kind: "table", source: "range", sheetId: summaryId, range: "A1:B3", headerRow: false },
        { id: "4", kind: "table", source: "pivot", sheetId: salesId, pivot },
        { id: "5", kind: "chart", chartId: "c1" },
        { id: "6", kind: "chart", chartId: "gone" },
        { id: "7", kind: "pageBreak" },
      ],
    });
    const out = runReport(r, env);
    expect(out.title).toBe("Sales report");
    const [h, p, t1, t2, c1, c2, pb] = out.blocks;
    expect(h).toEqual({ kind: "heading", text: "North", level: 1 });
    expect(p).toEqual({ kind: "paragraph", text: "Sales 90" });
    expect(t1.kind === "table" && t1.rows.map((x) => x.cells)).toEqual([
      ["Revenue", "100"],
      ["Last year", "80"],
      ["Total", "180"],
    ]);
    expect(t1.kind === "table" && t1.align).toEqual(["left", "right"]);
    expect(t1.kind === "table" && t1.rows[2].bold).toBe(true);
    expect(t2.kind === "table" && t2.rows.map((x) => x.cells)).toEqual([
      ["North", "90.00"],
      ["South", "60.00"],
      ["Grand total", "150.00"],
    ]);
    expect(t2.kind === "table" && t2.rows[2].bold).toBe(true);
    expect(c1.kind === "chart" && "data" in c1 && c1.data.categories).toEqual(["North", "South"]);
    expect(c2.kind === "chart" && "error" in c2 && c2.error).toMatch(/deleted/);
    expect(pb.kind).toBe("pageBreak");
    expect(out.warnings).toEqual([]);
  });

  it("filters tables and charts to the entity, and drops the filter when consolidated", () => {
    const { wb, env, salesId } = setup();
    const data = readSheetColumns(wb.get(salesId).source);
    let layout = placeField(emptyLayout(), data, 1, "rows");
    layout = placeField(layout, data, 2, "values");
    const pivot = savePivot(toSpec(layout), data.names);
    const rangeChart = { ...defaultSpec("rc", { sheetId: salesId, top: 0, left: 1, bottom: 4, right: 2 }), names: false, labels: true };
    const r = report(salesId, {
      params: [{ name: "entity", value: "North" }],
      runFor: { param: "entity", sheetId: salesId, column: 0, consolidated: true, allLabel: "Group" },
      blocks: [
        { id: "a", kind: "table", source: "range", sheetId: salesId, range: "A1:C6", headerRow: true, filter: { param: "entity", column: 0 } },
        { id: "b", kind: "table", source: "pivot", sheetId: salesId, pivot, filter: { param: "entity", column: 0 } },
        { id: "c", kind: "chart", spec: rangeChart, filter: { param: "entity", column: 0 } },
        { id: "d", kind: "paragraph", text: "{{entity}}: {{=SUMIFS(C:C,A:A,{entity})}}" },
      ],
    });
    expect(runForValues(r, env)).toEqual(["North", "South"]);
    const book = runBook(r, env);
    expect(book).toHaveLength(3);
    const [all, north, south] = book;
    const rows = (x: typeof all, i: number) => {
      const b = x.blocks[i];
      return b.kind === "table" ? b.rows.map((row) => row.cells) : null;
    };
    expect(rows(all, 0)).toHaveLength(5);
    expect(rows(north, 0)).toEqual([
      ["North", "A", "10.00"],
      ["North", "B", "30.00"],
      ["North", "A", "50.00"],
    ]);
    expect(rows(south, 1)).toEqual([
      ["A", "20.00"],
      ["B", "40.00"],
      ["Grand total", "60.00"],
    ]);
    expect(rows(all, 1)).toEqual([
      ["A", "80.00"],
      ["B", "70.00"],
      ["Grand total", "150.00"],
    ]);
    const chart = north.blocks[2];
    expect(chart.kind === "chart" && "data" in chart && Array.from(chart.data.series[0].values)).toEqual([10, 30, 50]);
    // SUMIFS with "*" adds up everything for the consolidated run
    expect(all.blocks[3]).toEqual({ kind: "paragraph", text: "Group: 150" });
    expect(south.blocks[3]).toEqual({ kind: "paragraph", text: "South: 60" });
  });

  it("says what's wrong instead of failing", () => {
    const { env, salesId } = setup();
    const r = report(salesId, {
      blocks: [
        { id: "a", kind: "table", source: "range", sheetId: salesId, range: "nonsense", headerRow: true },
        { id: "b", kind: "table", source: "range", sheetId: "nope", range: "A1", headerRow: true },
        { id: "c", kind: "table", source: "range", sheetId: salesId, range: "A1:C6", headerRow: true, filter: { param: "who", column: 0 } },
      ],
    });
    const out = runReport(r, env);
    expect(out.blocks[0]).toMatchObject({ kind: "error" });
    expect(out.blocks[1]).toMatchObject({ kind: "error", text: expect.stringMatching(/deleted/) });
    expect(out.warnings.some((w) => /who/.test(w))).toBe(true);
  });
});

describe("pivot charts", () => {
  it("chart the pivot's leaf rows and recompute when the sheet changes", () => {
    const { wb, salesId } = setup();
    const src = wb.get(salesId).source;
    const data = readSheetColumns(src);
    let layout = placeField(emptyLayout(), data, 0, "rows");
    layout = placeField(layout, data, 1, "cols");
    layout = placeField(layout, data, 2, "values");
    const spec = pivotChartForLayout(layout, data, salesId, "bar")!;
    expect(spec.pivot?.sheetId).toBe(salesId);
    expect(spec.title).toBe("Sum of Amount by Region and Product");
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
    const draw = () => {
      const input = chartInput(spec, (id) => (wb.has(id) ? wb.get(id).source : null))!;
      return buildChart(input.src, input.spec);
    };
    let chart = draw();
    expect(chart.horizontal).toBe(true);
    expect(chart.categories).toEqual(["North", "South"]);
    expect(chart.series.map((s) => s.name)).toEqual(["A", "B"]);
    expect(chart.series.map((s) => Array.from(s.values))).toEqual([
      [60, 20],
      [30, 40],
    ]);
    src.setCell(1, 2, 1000); // South A: 20 -> 1000
    chart = draw();
    expect(Array.from(chart.series[0].values)).toEqual([60, 1000]);
    // no chart without a value and a field to group by
    expect(pivotChartForLayout(placeField(emptyLayout(), data, 2, "values"), data, salesId)).toBeNull();
  });

  it("find their fields by name after a column moves, and say when one is gone", () => {
    const { wb, salesId } = setup();
    const data = readSheetColumns(wb.get(salesId).source);
    let layout = placeField(emptyLayout(), data, 0, "rows");
    layout = placeField(layout, data, 2, "values");
    const saved = savePivot(toSpec(layout), data.names);
    const moved = new EditableSource(new Table([num("Amount", [1, 2]), text("Region", ["X", "Y"])]), 5);
    const g = pivotGrid(moved, saved);
    expect(g.getCell(1, 0)).toBe("X");
    expect(g.getCell(2, 1)).toBe(2);
    const gone = new EditableSource(new Table([num("Amount", [1, 2])]), 5);
    expect(() => pivotGrid(gone, saved)).toThrow(/Region/);
  });

  it("leave ordinary charts alone", () => {
    const { wb, salesId } = setup();
    const spec = defaultSpec("x", { sheetId: salesId, top: 0, left: 1, bottom: 5, right: 2 });
    const input = chartInput(spec, (id) => wb.get(id).source)!;
    expect(input.spec).toBe(spec);
  });
});

describe("report.set", () => {
  it("adds, changes and removes reports with undo", async () => {
    const wb = new Workbook({ name: "Sheet1", source: new EditableSource(new BlankSource(10, 5)) });
    const ctx: SheetCtx = { workbook: wb, activeSheet: wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
    const registry = sheetActions();
    registerReportActions(registry);
    const history = new ActionHistory(registry, () => ctx);
    const r = report(wb.sheets[0].id, { blocks: [newBlock("heading", "x"), newBlock("table", wb.sheets[0].id)] });
    await history.run({ type: "report.set", params: { id: r.id, report: r } });
    expect(reportsOf(wb)).toHaveLength(1);
    await history.run({ type: "report.set", params: { id: r.id, report: { ...r, title: "Renamed" } } });
    expect(reportsOf(wb)[0].title).toBe("Renamed");
    await history.undo();
    expect(reportsOf(wb)[0].title).toBe("Sales report");
    await history.run({ type: "report.set", params: { id: r.id, report: null } });
    expect(reportsOf(wb)).toHaveLength(0);
    await history.undo();
    expect(reportsOf(wb)[0].id).toBe(r.id);
    await expect(history.run({ type: "report.set", params: { id: "bad", report: { ...r, params: [{ name: "1x", value: "" }] } } })).rejects.toThrow(/parameter name/);
    expect(JSON.parse(JSON.stringify(reportsOf(wb)))).toEqual(reportsOf(wb));
  });

  it("checks reports", () => {
    expect(reportProblem(null)).toMatch(/object/);
    expect(reportProblem(report("s", { params: [{ name: "a", value: "" }, { name: "A", value: "" }] }))).toMatch(/twice/);
    expect(reportProblem(report("s"))).toBeNull();
  });
});

describe("output", () => {
  it("writes HTML with escaped text and chart placeholders", () => {
    const { env, salesId } = setup();
    const r = report(salesId, {
      title: "<b>Q1</b>",
      blocks: [{ id: "a", kind: "paragraph", text: "A & B" }, { id: "b", kind: "chart", spec: defaultSpec("x", { sheetId: salesId, top: 0, left: 1, bottom: 5, right: 2 }) }, { id: "c", kind: "table", source: "range", sheetId: salesId, range: "A1:C3", headerRow: true }],
    });
    const html = reportHtml([runReport(r, env)]);
    expect(html).toContain("<h1>&lt;b&gt;Q1&lt;/b&gt;</h1>");
    expect(html).toContain("<p>A &amp; B</p>");
    expect(html).toContain('data-chart="0:1"');
    expect(html).toContain('<th class="num">Amount</th>');
    expect(html).toContain('<td class="num">10.00</td>');
  });

  it("writes a report book PDF: contents, one section per entity, tables read back", async () => {
    const { env, salesId } = setup();
    const r = report(salesId, {
      title: "Sales for {{entity}}",
      params: [{ name: "entity", value: "North" }],
      runFor: { param: "entity", sheetId: salesId, column: 0, consolidated: true },
      blocks: [
        { id: "h", kind: "heading", text: "Lines", level: 1 },
        { id: "a", kind: "table", source: "range", sheetId: salesId, range: "A1:C6", headerRow: true, filter: { param: "entity", column: 0 } },
        { id: "c", kind: "chart", spec: defaultSpec("x", { sheetId: salesId, top: 0, left: 1, bottom: 5, right: 2 }) },
      ],
    });
    const book = runBook(r, env);
    let painted = 0;
    const paint = () => {
      painted++;
      return { width: 2, height: 1, rgb: new Uint8Array(6).fill(128) };
    };
    expect(toSection(book[1], paint).blocks.map((b) => b.kind)).toEqual(["heading", "table", "image"]);
    const pdf = await reportPdf(book, { size: "A4" }, paint);
    const pages = await readPdfText(pdf);
    expect(pages[0].items[0].text).toBe("Contents");
    const contents = pages[0].items.map((i) => i.text);
    expect(contents).toContain("Sales for All");
    expect(contents).toContain("Sales for North");
    expect(contents).toContain("Sales for South");
    const southPage = pages.slice(1).find((p) => p.items.some((i) => i.text === "Sales for South"))!;
    const amounts = southPage.items.filter((i) => /^\d+\.00$/.test(i.text)).map((i) => i.text);
    expect(amounts).toEqual(["20.00", "40.00"]);
    expect(painted).toBeGreaterThanOrEqual(4);
  });
});
