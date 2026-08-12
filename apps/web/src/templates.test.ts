import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore } from "@cellforge/actions";
import { setCells, sheetActions, type SheetCtx } from "./actions";
import { runWorkbookChecks } from "./checksui";
import { buildTemplate, TEMPLATES } from "./templates";
import type { Workbook } from "./workbook";

function driver(wb: Workbook) {
  const ctx: SheetCtx = { workbook: wb, activeSheet: wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  const on = (name: string) => (ctx.activeSheet = wb.byName(name)!.id);
  const cell = (name: string, r: number, c: number) => wb.byName(name)!.source.getCell(r, c);
  return { h, on, cell };
}

describe("templates", () => {
  it("every template builds, with instructions, a legend and checks", async () => {
    for (const t of TEMPLATES) {
      const wb = await buildTemplate(t.kind);
      expect(wb.sheets[0].name).toBe("Start here");
      expect(wb.byName("Tick-mark legend")).toBeTruthy();
      expect(wb.checks.length).toBeGreaterThan(0);
      expect(wb.evidence.log).toEqual([]);
    }
  });

  it("monthly close: flux flags big changes, unmapped accounts show, checks follow the data", async () => {
    const wb = await buildTemplate("close");
    const { h, on, cell } = driver(wb);
    on("TB current");
    await h.run(setCells([
      { row: 1, col: 0, input: "1000" }, { row: 1, col: 1, input: "Bank" }, { row: 1, col: 2, input: "50000" },
      { row: 2, col: 0, input: "4000" }, { row: 2, col: 1, input: "Sales" }, { row: 2, col: 3, input: "50000" },
    ]));
    on("TB prior");
    await h.run(setCells([{ row: 1, col: 0, input: "1000" }, { row: 1, col: 1, input: "Bank" }, { row: 1, col: 2, input: "30000" }]));
    on("Mapping");
    await h.run(setCells([{ row: 1, col: 0, input: "1000" }, { row: 1, col: 1, input: "Cash" }, { row: 1, col: 2, input: "Asset" }]));
    expect(cell("TB current", 2, 4)).toBe(-50000);
    expect([cell("Flux", 1, 2), cell("Flux", 1, 5), cell("Flux", 1, 7)]).toEqual(["Cash", 20000, "Explain"]);
    expect(cell("Flux", 2, 2)).toBe("(not mapped)");
    expect(cell("Flux", 3, 0)).toBe(""); // empty rows stay empty
    const results = runWorkbookChecks(wb, wb.checks);
    const status = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(status["This month's TB balances (debits = credits)"]).toBe("pass");
    expect(status["Every account is mapped"]).toBe("fail");
    expect(status["Every flagged change is explained"]).toBe("warn");
  });

  it("bank rec: the statement adds up from the outstanding items", async () => {
    const wb = await buildTemplate("bankrec");
    const { h, on, cell } = driver(wb);
    on("Cash book");
    await h.run(setCells([{ row: 1, col: 3, input: "1000" }, { row: 2, col: 3, input: "-200" }]));
    on("Outstanding");
    await h.run(setCells([
      { row: 1, col: 0, input: "Deposit in transit" }, { row: 1, col: 3, input: "300" },
      { row: 2, col: 0, input: "Outstanding payment" }, { row: 2, col: 3, input: "150" },
      { row: 3, col: 0, input: "Bank only (fee, interest)" }, { row: 3, col: 3, input: "-50" },
    ]));
    on("Rec");
    await h.run(setCells([{ row: 2, col: 1, input: "600" }]));
    expect([cell("Rec", 6, 1), cell("Rec", 11, 1), cell("Rec", 13, 1)]).toEqual([750, 750, 0]);
    expect(runWorkbookChecks(wb, wb.checks).find((r) => r.name === "The reconciliation has no difference")?.status).toBe("pass");
  });

  it("audit tests: the results sheet counts the population", async () => {
    const wb = await buildTemplate("audit");
    const { h, on, cell } = driver(wb);
    on("Population");
    await h.run(setCells([{ row: 1, col: 0, input: "J1" }, { row: 1, col: 6, input: "100" }, { row: 2, col: 0, input: "J2" }, { row: 2, col: 6, input: "250.5" }]));
    expect([cell("Results", 9, 1), cell("Results", 10, 1)]).toEqual([2, 350.5]);
  });
});
