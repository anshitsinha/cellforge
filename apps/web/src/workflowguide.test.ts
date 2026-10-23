import { describe, expect, it } from "vitest";
import { ActionHistory, BlobStore, type Action } from "@cellforge/actions";
import { setCells, sheetActions } from "./actions";
import { guessMap } from "./recondialog";
import { outstandingCells, prepareBankRec, recTargets } from "./openitemsdialog";
import { sampleWorkbook } from "./samples";
import { buildTemplate } from "./templates";
import { buildGuide, guideKindOf, type GuideDeps } from "./workflowguide";
import type { Workbook } from "./workbook";

function deps(wb: Workbook) {
  const calls: string[] = [];
  const ctx = { workbook: wb, activeSheet: wb.sheets[0].id, blobs: new BlobStore(), sortRows: async () => null };
  const h = new ActionHistory(sheetActions(), () => ctx);
  const d: GuideDeps = {
    workbook: () => wb,
    activeSheet: () => ctx.activeSheet,
    showSheet: (id) => {
      ctx.activeSheet = id;
      calls.push(`show ${wb.get(id).name}`);
    },
    goTo: (id, row, col) => calls.push(`go ${wb.get(id).name} ${row} ${col}`),
    run: (a: Action) => h.run(a),
    runCommand: (id) => calls.push(`run ${id}`),
    focusGrid: () => undefined,
  };
  return { d, calls, h };
}

describe("workflow guide", () => {
  it("knows each sample and template by its sheets", async () => {
    for (const [kind, guide] of [["bank-rec", "bankrec"], ["close", "close"], ["audit", "audit"], ["big", "big"]] as const) {
      expect(guideKindOf((await sampleWorkbook(kind)).workbook)).toBe(guide);
    }
    expect(guideKindOf(await buildTemplate("bankrec"))).toBe("bankrec");
  });

  it("bank rec: steps tick themselves as the workbook gets there, and buttons open the right tool on the right sheet", async () => {
    const { workbook: wb } = await sampleWorkbook("bank-rec");
    const { d, calls, h } = deps(wb);
    let g = buildGuide("bankrec", wb, d);
    expect(g.steps.map((s) => [s.id, s.state])).toEqual([
      ["data", "done"],
      ["match", "todo"],
      ["statement", "todo"],
      ["ties", "todo"],
      ["checks", "todo"],
      ["sign", "todo"],
    ]);
    expect(g.steps.find((s) => s.id === "ties")!.status).toMatch(/^Difference \([\d,]+\.\d\d\)$/);
    g.steps.find((s) => s.id === "statement")!.actions[0].run();
    expect(calls).toEqual(["show Cash book", "run openitems-bankstatement"]);

    // what "Fill Outstanding and Rec" does
    const t = recTargets(wb);
    const cash = wb.byName("Cash book")!.source;
    const bank = wb.byName("Bank statement")!.source;
    const x = prepareBankRec({ ledger: cash, bank, ledgerMap: guessMap(cash), bankMap: guessMap(bank), bankBalance: t.bankBalance!, ledgerBalance: t.ledgerBalance! });
    await h.run(setCells(outstandingCells(x.rows, t.outstanding!.source), "fill", t.outstanding!.id));
    g = buildGuide("bankrec", wb, d);
    expect(g.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done", "todo"]);
    expect(g.steps.find((s) => s.id === "ties")!.status).toBe("Difference 0.00");

    await h.run({ type: "review.signoff", params: { role: "prepared", by: "PR", sheet: wb.byName("Rec")!.id } });
    g = buildGuide("bankrec", wb, d);
    expect(g.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("close: names the unmapped account, maps its code for you and counts the explanations", async () => {
    const { workbook: wb } = await sampleWorkbook("close");
    const { d, calls } = deps(wb);
    let g = buildGuide("close", wb, d);
    const map = g.steps.find((s) => s.id === "map")!;
    expect(map.status).toBe("1 account not mapped: 6420 Software subscriptions");
    expect(map.actions[0].label).toBe("Map 6420");
    await (map.actions[0].run as () => Promise<void>)();
    await new Promise((r) => setTimeout(r, 0));
    const mapping = wb.byName("Mapping")!.source;
    const row = calls.find((c) => c.startsWith("go Mapping"))!.split(" ")[2];
    expect(mapping.getCell(Number(row), 0)).toBe(6420);
    expect(g.steps.find((s) => s.id === "explain")!.status).toMatch(/^0 of \d+ explained$/);
    g = buildGuide("close", wb, d);
    expect(g.steps.find((s) => s.id === "pivot")!.state).toBe("info");
  });
});
