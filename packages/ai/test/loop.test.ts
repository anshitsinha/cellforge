import type { Action, JsonSchema } from "@cellforge/actions";
import { describe, expect, it } from "vitest";
import { type LoopDeps, type Model, buildPrompt, runRequest } from "../src";
import { CATALOG, salesContext } from "./fixtures";

/** A fake model: answers from a script, and remembers what it was asked. */
function scripted(...answers: string[]): Model & { prompts: string[]; grammars: JsonSchema[] } {
  const prompts: string[] = [];
  const grammars: JsonSchema[] = [];
  return {
    prompts,
    grammars,
    async propose(prompt, grammar) {
      prompts.push(prompt);
      grammars.push(grammar);
      const a = answers.shift();
      if (a === undefined) throw new Error("script ran out");
      return a;
    },
  };
}

function deps(over: Partial<LoopDeps> = {}): LoopDeps & { ran: Action[]; undos: number } {
  const ran: Action[] = [];
  const d = {
    ran,
    undos: 0,
    catalog: () => CATALOG,
    context: () => salesContext(),
    run: async (a: Action) => {
      ran.push(a);
      return true;
    },
    ...over,
  };
  d.undo = over.undo ?? (async () => void d.undos++);
  return d;
}

const freeze = JSON.stringify({ type: "view.freeze", params: { rows: 1, cols: 0 } });

describe("runRequest", () => {
  it("uses the parser first and never calls the model for known phrasings", async () => {
    const model = scripted();
    const d = deps({ model });
    const t = await runRequest("freeze top row", d);
    expect(t.status).toBe("done");
    expect(d.ran).toEqual([{ type: "view.freeze", params: { rows: 1, cols: 0 } }]);
    expect(model.prompts).toEqual([]);
    expect(t.steps.map((s) => s.kind)).toEqual(["context", "parsed", "ran", "verified"]);
    expect(t.explanation).toMatch(/top row/);
  });

  it("runs several parser actions in order", async () => {
    const d = deps();
    const t = await runRequest("delete rows 3 and 5", d);
    expect(t.status).toBe("done");
    expect(d.ran.map((a) => (a.params as { at: number }).at)).toEqual([4, 2]);
  });

  it("returns questions instead of guessing", async () => {
    const d = deps({ model: scripted() });
    const t = await runRequest("sort by banana", d);
    expect(t.status).toBe("ask");
    expect(t.missing?.[0]).toMatch(/banana/);
    expect(d.ran).toEqual([]);
  });

  it("hands commands back to the caller", async () => {
    const t = await runRequest("undo", deps());
    expect(t).toMatchObject({ status: "command", command: "undo" });
    const p = await runRequest("sum of amount by region", deps());
    expect(p).toMatchObject({ status: "command", command: "pivot" });
  });

  it("says unknown without a model", async () => {
    const t = await runRequest("make the numbers look nicer", deps());
    expect(t.status).toBe("unknown");
  });

  it("asks the model with a grammar from the catalog when the parser can't", async () => {
    const model = scripted(freeze);
    const d = deps({ model });
    const t = await runRequest("keep the headings visible", d);
    expect(t.status).toBe("done");
    expect(d.ran).toEqual([JSON.parse(freeze)]);
    expect(model.grammars[0]).toMatchObject({ anyOf: expect.any(Array) });
    expect(model.prompts[0]).toMatch(/Request: keep the headings visible/);
    expect(model.prompts[0]).toMatch(/2 = C "Amount"/);
    expect(model.prompts[0]).toMatch(/view\.freeze: Freeze panes/);
  });

  it("retries with the problems when the first answer is wrong", async () => {
    const model = scripted(
      "not json at all",
      JSON.stringify({ type: "view.freeze", params: { rows: 1 } }),
      JSON.stringify({ type: "cols.hide", params: { at: 30, hidden: true } }),
      freeze,
    );
    const d = deps({ model, maxTries: 4 });
    const t = await runRequest("keep the headings visible", d);
    expect(t.status).toBe("done");
    expect(model.prompts).toHaveLength(4);
    expect(model.prompts[1]).toMatch(/not valid JSON/);
    expect(model.prompts[2]).toMatch(/view\.freeze: cols is missing/);
    expect(model.prompts[3]).toMatch(/column AE .* only 8 columns/);
    expect(model.prompts[3]).toMatch(/Your previous answer was:\n\{"type":"cols.hide"/);
    expect(d.ran).toEqual([JSON.parse(freeze)]);
    expect(t.steps.filter((s) => s.kind === "invalid")).toHaveLength(3);
  });

  it("retries when running fails, with the app's error", async () => {
    const model = scripted(JSON.stringify({ type: "rows.delete", params: { at: 0, count: 5 } }), freeze);
    let n = 0;
    const d = deps({
      model,
      run: async (a) => {
        if (n++ === 0) throw new Error("Sorting needs merged cells to be unmerged first.");
        return a;
      },
    });
    const t = await runRequest("tidy the top", d);
    expect(t.status).toBe("done");
    expect(model.prompts[1]).toMatch(/unmerged first/);
  });

  it("verifies, undoes a wrong change and retries", async () => {
    const model = scripted(JSON.stringify({ type: "view.freeze", params: { rows: 2, cols: 0 } }), freeze);
    const d = deps({
      model,
      verify: (a) => ((a.params as { rows: number }).rows === 1 ? [] : ["Only the header row should be frozen."]),
    });
    const t = await runRequest("keep the headings visible", d);
    expect(t.status).toBe("done");
    expect(d.undos).toBe(1);
    expect(t.steps.map((s) => s.kind)).toEqual(["context", "prompt", "proposed", "ran", "rejected", "undone", "prompt", "proposed", "ran", "verified"]);
    expect(model.prompts[1]).toMatch(/Only the header row/);
    expect(t.actions).toEqual([JSON.parse(freeze)]);
  });

  it("gives up after N tries", async () => {
    const model = scripted("{}", "{}", "{}", "{}");
    const d = deps({ model, maxTries: 3 });
    const t = await runRequest("do something clever", d);
    expect(t.status).toBe("gave-up");
    expect(model.prompts).toHaveLength(3);
    expect(t.problems?.[0]).toMatch(/needs a "type"/);
    expect(d.ran).toEqual([]);
  });

  it("survives a model that throws", async () => {
    const model: Model = { propose: async () => Promise.reject(new Error("out of memory")) };
    const t = await runRequest("do something clever", deps({ model, maxTries: 2 }));
    expect(t.status).toBe("gave-up");
    expect(t.problems?.[0]).toMatch(/out of memory/);
  });

  it("falls back to the model when a parsed action fails to run", async () => {
    const model = scripted(freeze);
    let first = true;
    const d = deps({
      model,
      run: async () => {
        if (first) {
          first = false;
          throw new Error("At least one column has to stay visible.");
        }
        return true;
      },
    });
    const t = await runRequest("hide column D", d);
    expect(t.status).toBe("done");
    expect(model.prompts[0]).toMatch(/At least one column/);
    expect(model.prompts[0]).toMatch(/Your previous answer was:\n\{"type":"cols.hide"/);
  });

  it("reports the failure when there is no model", async () => {
    const d = deps({ run: async () => false });
    const t = await runRequest("hide column D", d);
    expect(t.status).toBe("gave-up");
    expect(t.problems?.[0]).toMatch(/didn't run/);
  });

  it("can skip the parser, to evaluate a model alone", async () => {
    const model = scripted(freeze);
    const t = await runRequest("freeze top row", deps({ model, noParser: true }));
    expect(t.status).toBe("done");
    expect(model.prompts).toHaveLength(1);
  });

  it("builds a prompt with the context and the catalog", () => {
    const p = buildPrompt("hide notes", salesContext(), CATALOG);
    expect(p).toMatch(/Sheets: s1 "Sales" \(on screen\), s2 "Imported"/);
    expect(p).toMatch(/Rows: 200 \(0-based\); row 0 is the header/);
    expect(p).toMatch(/Selection: rows 4-9, columns 2-2/);
    expect(p).not.toMatch(/previous answer/);
  });
});
