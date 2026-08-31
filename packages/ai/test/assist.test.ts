import { describe, expect, it } from "vitest";
import { explainFormula, looseKey, refsIn, suggestCategories, suggestMerges, type Model } from "../src";

/** a stand-in model that answers from a script, and records its prompts */
const scripted = (...answers: unknown[]): Model & { prompts: string[] } => {
  const prompts: string[] = [];
  let i = 0;
  return { prompts, propose: async (p) => (prompts.push(p), JSON.stringify(answers[Math.min(i++, answers.length - 1)])) };
};

const facts = { formula: '=SUMIFS(C:C,A:A,"North")', words: 'The total of C:C where A:A is "North".', value: "12,500" };

describe("explain with a model", () => {
  it("uses the plain version when there's no model", async () => {
    expect(await explainFormula(facts)).toEqual({ value: facts.words, by: "rules" });
  });

  it("uses the model's version when it sticks to the facts", async () => {
    const m = scripted({ explanation: "Adds up the amounts in column C for North rows only, giving 12,500." });
    const r = await explainFormula(facts, m);
    expect(r.by).toBe("model");
    expect(m.prompts[0]).toContain(facts.formula);
  });

  it("rejects an explanation with a number that isn't in the facts", async () => {
    const r = await explainFormula(facts, scripted({ explanation: "Adds the North sales, about 14,000 a month." }));
    expect(r.by).toBe("rules");
    expect(r.rejected).toMatch(/14000/);
  });

  it("rejects an explanation that names a cell the formula doesn't use", async () => {
    const r = await explainFormula(facts, scripted({ explanation: "Adds the North rows of column C, then subtracts D7." }));
    expect(r.rejected).toMatch(/D7/);
  });

  it("falls back when the model's answer doesn't fit the shape", async () => {
    const r = await explainFormula(facts, scripted({ explanation: "" }));
    expect(r.by).toBe("rules");
    expect(r.rejected).toMatch(/too short/);
  });

  it("finds cell references in text", () => {
    expect(refsIn("Rates!A:C and $B$7, not Q4 or ABC")).toEqual(["Rates!A:C", "$B$7", "Q4"]);
  });
});

describe("clean: spelling variants", () => {
  const col = ["Acme Ltd", "Acme Ltd", "ACME LTD.", " acme ltd", "Beta Inc", "Beta Incorporated", "IBM", "IBM", "Intl Business Machines", "Gamma"];

  it("merges spellings that differ only in case, spacing and punctuation into the commonest", async () => {
    const { merges } = await suggestMerges(col);
    expect(merges).toContainEqual({ from: ["ACME LTD.", " acme ltd"], to: "Acme Ltd", cells: 2, by: "rules" });
    expect(merges.find((m) => m.to === "Beta Inc" || m.to === "Beta Incorporated")?.cells).toBe(1);
    expect(merges.some((m) => m.to === "IBM")).toBe(false);
  });

  it("adds the model's pairs, kept to values in the column and merged into the commoner spelling", async () => {
    const m = scripted({ pairs: [{ variant: "IBM", same_as: "Intl Business Machines" }, { variant: "Gamma", same_as: "Gamma" }] });
    const { merges } = await suggestMerges(col, m);
    expect(merges).toContainEqual({ from: ["Intl Business Machines"], to: "IBM", cells: 1, by: "model" });
    expect(merges.filter((x) => x.by === "rules").length).toBe(2);
  });

  it("keeps the rules' merges when the model fails", async () => {
    const r = await suggestMerges(col, { propose: async () => "not json" });
    expect(r.merges.length).toBe(2);
    expect(r.rejected).toBeTruthy();
  });

  it("loose keys", () => {
    expect(looseKey("  ACME   Limited. ")).toBe("acme ltd");
    expect(looseKey("A&B Co")).toBe(looseKey("a and b company"));
  });
});

describe("category suggestions from tagged rows", () => {
  const tagged = [
    { text: "UBER TRIP 123", category: "Travel" },
    { text: "SHELL FUEL", category: "Travel" },
    { text: "OFFICEWORKS PAPER", category: "Office" },
  ];

  it("asks once per untagged row, offering only categories in use", async () => {
    const m = scripted({ category: "Travel" }, { category: "not sure" });
    const r = await suggestCategories(m, [{ text: "LYFT RIDE" }, { text: "MYSTERY 42" }], tagged);
    expect(r).toEqual({ suggestions: [{ row: 0, category: "Travel" }], unsure: 1, failed: 0 });
    expect(m.prompts[0]).toContain("UBER TRIP 123 → Travel");
  });

  it("counts answers outside the categories as failed, not suggestions", async () => {
    const r = await suggestCategories(scripted({ category: "Meals" }), [{ text: "CAFE" }], tagged);
    expect(r).toEqual({ suggestions: [], unsure: 0, failed: 1 });
  });
});
