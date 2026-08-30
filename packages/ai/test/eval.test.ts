import { describe, expect, it } from "vitest";
import { answerMatches, formatReport, loopAnswerer, parserAnswerer, runEval, type Model } from "../src";
import { evalCases } from "./cases";
import { CATALOG, salesContext } from "./fixtures";

describe("eval harness", () => {
  it("covers every category of the phrasing set", () => {
    const cats = new Set(evalCases.map((c) => c.category));
    expect(cats.size).toBeGreaterThanOrEqual(10);
    expect(cats).toContain("sort");
    expect(cats).toContain("nonsense");
  });

  it("the parser gets every case right, fast, in every category", async () => {
    const r = await runEval("parser", evalCases, parserAnswerer(salesContext));
    if (r.failures.length) console.log(formatReport(r));
    expect(r.failures).toEqual([]);
    expect(r.accuracy).toBe(1);
    for (const c of r.categories) expect(c.correct).toBe(c.cases);
    // time-to-answer: well under a frame per request
    expect(r.meanMs).toBeLessThan(16);
  });

  it("the ask loop (parser first) scores the same with no model", async () => {
    const r = await runEval("ask loop", evalCases, loopAnswerer({ context: salesContext, catalog: () => CATALOG }));
    // the loop only differs where the parser's actions fail the catalog check; there should be none
    expect(r.failures).toEqual([]);
  });

  it("scores a model on its own, and reports its misses per category", async () => {
    // a stand-in model that always freezes the top row: right for "freeze" requests only
    const model: Model = { propose: async () => JSON.stringify({ type: "view.freeze", params: { rows: 1, cols: 0 } }) };
    const r = await runEval("model alone", evalCases, loopAnswerer({ context: salesContext, catalog: () => CATALOG, model, noParser: true }));
    expect(r.accuracy).toBeLessThan(0.5);
    expect(r.failures.length).toBe(r.cases - r.correct);
    const md = formatReport(r);
    expect(md).toContain("| Category | Cases | Right |");
    expect(md).toContain("Misses:");
  });

  it("matches answers by what they would do", () => {
    expect(answerMatches(null, null)).toBe(true);
    expect(answerMatches({ ask: /which column/ }, { ask: "which column do you mean?" })).toBe(true);
    expect(answerMatches({ command: "undo" }, { command: "redo" })).toBe(false);
    expect(answerMatches({ actions: [{ type: "a", params: { x: 1 } }] }, { actions: [{ type: "a", params: { x: 1, y: undefined } }] })).toBe(true);
    expect(answerMatches({ actions: [] }, null)).toBe(false);
  });

  it("times each answer with the clock it's given", async () => {
    let t = 0;
    const r = await runEval("clock", evalCases.slice(0, 3), () => null, () => (t += 5));
    expect(r.categories[0].totalMs).toBe(15);
    expect(r.categories[0].maxMs).toBe(5);
  });
});

// `npm run eval` writes the report to docs/dev/eval-report.md (left out of the normal run: timings vary)
describe.runIf((import.meta as { env?: { MODE?: string } }).env?.MODE === "eval")("eval report", () => {
  it("writes docs/dev/eval-report.md", async () => {
    const fs = await import("node:fs");
    const parser = await runEval("Parser", evalCases, parserAnswerer(salesContext));
    const loop = await runEval("Ask loop, no model", evalCases, loopAnswerer({ context: salesContext, catalog: () => CATALOG }));
    const md = [
      "# Ask bar eval",
      "",
      `The phrasing set (${evalCases.length} requests on a sample Sales sheet, from packages/ai/test/cases.ts) run through each answerer.`,
      "A local model is scored the same way with loopAnswerer({ model, noParser: true }).",
      "Regenerate with `npm run eval`.",
      "",
      formatReport(parser),
      "",
      formatReport(loop),
      "",
    ].join("\n");
    fs.writeFileSync(new URL("../../../docs/dev/eval-report.md", import.meta.url), md);
    expect(parser.accuracy).toBe(1);
  });
});
