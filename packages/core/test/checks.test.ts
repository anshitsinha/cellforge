import { describe, expect, it } from "vitest";
import {
  categorise,
  categoryRuleProblem,
  checkProblem,
  checksAllPass,
  describeCatCondition,
  describeCheck,
  learnRules,
  matchCatCondition,
  normaliseKey,
  ruleTokens,
  runChecks,
  type CatRule,
  type CheckDef,
  type CheckSource,
  type CheckTable,
  type CheckValue,
} from "../src/checks";

function table(names: string[], rows: CheckValue[][], fmts: string[] = []): CheckTable {
  return { rows: rows.length, cols: names.length, names, get: (r, c) => rows[r]?.[c] ?? null, numFmt: (c) => fmts[c] ?? "" };
}

const journal = table(
  ["Entry", "Account", "Debit", "Credit", "Date", "Code"],
  [
    ["J1", "4000", 100, null, 45000, "AB-001"],
    ["J1", "1200", null, 100, 45001, "AB-002"],
    ["J2", "5000", 50, null, "31/01/2024", "ab-003"],
    ["J2", " 9999 ", null, 49.99, "soon", "XYZ"],
    ["", "4000", "1,000", null, 45002, null],
  ],
  ["", "", "", "", "yyyy-mm-dd"],
);
const accounts = table(["Account", "Name"], [["4000", "Sales"], ["1200", "Debtors"], ["5000", "COGS"], ["0042", "Old"]]);
const source: CheckSource = { table: (s) => (s === "JE" ? journal : s === "COA" ? accounts : null) };

const run = (def: Omit<CheckDef, "id" | "sheet"> & { sheet?: string }, opts = {}) => runChecks([{ id: "x", sheet: "JE", ...def } as CheckDef], source, opts)[0];

describe("runChecks", () => {
  it("not blank lists the blank rows", () => {
    const r = run({ kind: "notBlank", col: 0 });
    expect(r.status).toBe("fail");
    expect(r.failed).toBe(1);
    expect(r.failures[0]).toMatchObject({ row: 4, col: 0 });
    expect(r.message).toMatch(/1 blank cell in Entry/);
    expect(run({ kind: "notBlank", col: 1 }).status).toBe("pass");
  });

  it("unique and duplicate keys compare normalised values", () => {
    const u = run({ kind: "unique", col: 0 });
    expect(u.failed).toBe(2);
    expect(u.failures[0].note).toMatch(/row 1/);
    const k = run({ kind: "noDuplicateKeys", cols: [0, 1] });
    expect(k.status).toBe("pass");
    expect(run({ kind: "unique", col: 5 }).status).toBe("pass");
    expect(run({ kind: "unique", col: 5, normalise: { punctuation: true, leadingZeros: true } }).status).toBe("pass");
  });

  it("type checks numbers, dates and text", () => {
    const n = run({ kind: "type", col: 2, type: "number" });
    expect(n.failed).toBe(1);
    expect(n.failures[0].note).toBe("number stored as text");
    const d = run({ kind: "type", col: 4, type: "date" });
    expect(d.failed).toBe(1);
    expect(d.failures[0].value).toBe("soon");
    const t = run({ kind: "type", col: 1, type: "text" });
    expect(t.status).toBe("pass");
    expect(run({ kind: "type", col: 5, type: "text", allowBlank: false }).failed).toBe(1);
  });

  it("range, pattern and severity", () => {
    const r = run({ kind: "range", col: 2, min: 60 });
    expect(r.failed).toBe(2); // 50 too low, "1,000" not a number
    expect(r.failures.map((f) => f.note)).toEqual(["too low", "not a number"]);
    const p = run({ kind: "pattern", col: 5, pattern: "^[A-Z]{2}-\\d{3}$" });
    expect(p.failed).toBe(2);
    expect(run({ kind: "pattern", col: 5, pattern: "^[A-Z]{2}-\\d{3}$", ignoreCase: true }).failed).toBe(1);
    expect(run({ kind: "pattern", col: 5, pattern: "^[A-Z]{2}-\\d{3}$", severity: "warn" }).status).toBe("warn");
  });

  it("master list lookups normalise values", () => {
    const r = run({ kind: "inList", col: 1, listSheet: "COA", listCol: 0 });
    expect(r.failed).toBe(1);
    expect(r.failures[0].value).toBe(" 9999 ");
    expect(r.message).toMatch(/4 entries/);
    const missing = run({ kind: "inList", col: 1, listSheet: "Nope", listCol: 0 });
    expect(missing.status).toBe("fail");
    expect(missing.problem).toMatch(/Nope/);
  });

  it("totals: debits = credits, control totals and tolerance", () => {
    const r = run({ kind: "totalsEqual", col: 2, otherCol: 3 });
    expect(r.status).toBe("fail");
    expect(r.totals).toEqual({ left: 150, right: 149.99, difference: 0.01 });
    expect(r.message).toMatch(/text value not added/);
    expect(run({ kind: "totalsEqual", col: 2, otherCol: 3, tolerance: 0.01 }).status).toBe("pass");
    expect(run({ kind: "totalsEqual", col: 2, control: 150 }).status).toBe("pass");
    expect(run({ kind: "totalsEqual", col: 2, otherCol: 0, otherSheet: "COA" }).totals?.right).toBe(0);
  });

  it("row count counts rows with any value", () => {
    expect(run({ kind: "rowCount", min: 5 }).status).toBe("pass");
    const r = run({ kind: "rowCount", max: 3 });
    expect(r.status).toBe("fail");
    expect(r.failures[0]).toMatchObject({ value: 5, note: "too many rows" });
  });

  it("formula checks call back per row", () => {
    const seen: number[] = [];
    const r = run({ kind: "formula", formula: "=C2>0" }, { evalFormula: (_f: string, _s: string, row: number) => (seen.push(row), row !== 3) });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(r.failed).toBe(1);
    expect(r.failures[0].row).toBe(3);
    expect(run({ kind: "formula", formula: "=1" }).problem).toMatch(/formulas/);
  });

  it("caps failures, skips disabled checks and reports problems", () => {
    const r = runChecks([{ id: "a", sheet: "JE", kind: "type", col: 0, type: "number" }], source, { maxFailures: 2 })[0];
    expect(r.failed).toBe(4);
    expect(r.failures).toHaveLength(2);
    expect(runChecks([{ id: "a", sheet: "JE", kind: "notBlank", col: 0, enabled: false }], source)).toEqual([]);
    expect(checkProblem({ id: "a", sheet: "JE", kind: "pattern", col: 0, pattern: "(" })).toMatch(/valid pattern/);
    expect(checkProblem({ id: "a", sheet: "JE", kind: "range", col: 0 })).toMatch(/lowest/);
    expect(run({ kind: "notBlank", col: 40 }).problem).toMatch(/isn't in the sheet/);
    expect(checksAllPass([run({ kind: "notBlank", col: 1 }), run({ kind: "pattern", col: 5, pattern: "x", severity: "warn" })])).toBe(true);
    expect(checksAllPass([run({ kind: "notBlank", col: 0 })])).toBe(false);
  });

  it("describes checks and uses the name when given", () => {
    expect(describeCheck({ id: "a", sheet: "JE", kind: "range", col: 2, min: 0, max: 10 }, journal.names)).toBe("Debit is between 0 and 10");
    expect(run({ kind: "notBlank", col: 0, name: "Every line has an entry" }).name).toBe("Every line has an entry");
    expect(run({ kind: "totalsEqual", col: 2, otherCol: 3 }).name).toBe("total of Debit = total of Credit");
  });

  it("normaliseKey", () => {
    expect(normaliseKey("  Smith   & Co. ", { punctuation: true })).toBe("smith co");
    expect(normaliseKey("00042", { leadingZeros: true })).toBe("42");
    expect(normaliseKey("A-0042", { leadingZeros: true })).toBe("a-42");
    expect(normaliseKey("ABC", { ignoreCase: false })).toBe("ABC");
  });
});

describe("categorise", () => {
  const rules: CatRule[] = [
    { id: "uber", condition: { kind: "contains", text: "uber" }, category: "Travel" },
    { id: "eats", condition: { kind: "contains", text: "uber eats" }, category: "Meals", priority: 10 },
    { id: "big", condition: { kind: "all", conditions: [{ kind: "startsWith", text: "INV" }, { kind: "amount", min: 10000 }] }, category: "Capital" },
    { id: "re", condition: { kind: "regex", pattern: "^aws\\b" }, category: "IT" },
    { id: "off", condition: { kind: "equals", text: "rent" }, category: "Rent", enabled: false },
  ];
  const rows = [
    { text: "UBER TRIP 123", amount: 20 },
    { text: "Uber Eats London", amount: 15 },
    { text: "INV 1001 Machine", amount: 25000 },
    { text: "INV 1002 Toner", amount: 50 },
    { text: "AWS EMEA", amount: 300 },
    { text: "UBER TRIP 9", amount: 12, category: "Client recharge" },
    { text: "rent", amount: 1000 },
  ];

  it("applies rules by priority, keeps manual categories and reports gaps and conflicts", () => {
    const r = categorise(rows, rules);
    expect(r.categories).toEqual(["Travel", "Meals", "Capital", null, "IT", "Client recharge", null]);
    expect(r.ruleOf).toEqual(["uber", "eats", "big", null, "re", null, null]);
    expect(r.changed).toEqual([0, 1, 2, 4]);
    expect(r.uncategorised).toEqual([3, 6]);
    expect(r.conflicts).toEqual([{ row: 1, categories: ["Meals", "Travel"], rules: ["eats", "uber"] }]);
    expect(r.keptManual).toEqual([5]);
    expect(r.hits.uber).toBe(3);
    expect(r.counts[0]).toEqual({ category: "Capital", rows: 1 });
  });

  it("overwrites only when asked", () => {
    const r = categorise(rows, rules, { overwrite: true });
    expect(r.categories[5]).toBe("Travel");
    expect(r.changed).toContain(5);
  });

  it("matches conditions", () => {
    expect(matchCatCondition({ kind: "contains", text: "car", word: true }, { text: "CARD payment" })).toBe(false);
    expect(matchCatCondition({ kind: "contains", text: "car", word: true }, { text: "hire car ltd" })).toBe(true);
    expect(matchCatCondition({ kind: "amount", max: 0 }, { text: "", amount: null })).toBe(false);
    expect(matchCatCondition({ kind: "regex", pattern: "(" }, { text: "(" })).toBe(false);
    expect(describeCatCondition(rules[2].condition)).toBe('starts with "INV" and amount ≥ 10,000');
    expect(categoryRuleProblem({ condition: { kind: "contains", text: " " }, category: "X" })).toMatch(/text/);
    expect(categoryRuleProblem({ condition: { kind: "contains", text: "a" }, category: "" })).toMatch(/category/);
  });
});

describe("learnRules", () => {
  const tagged = [
    { text: "TESCO STORES 2231", category: "Groceries" },
    { text: "Tesco Express", category: "Groceries" },
    { text: "TESCO PETROL", category: "Fuel" },
    { text: "SHELL 0042 PETROL", category: "Fuel" },
    { text: "Shell garage", category: "Fuel" },
    { text: "BP petrol station", category: "Fuel" },
    { text: "Sainsbury's", category: "Groceries" },
    { text: "Unknown thing" },
    { text: "Card payment AMAZON", category: "Office" },
    { text: "AMAZON MKTP", category: "Office" },
  ];

  it("proposes words that mostly mean one category, with support and confidence", () => {
    const l = learnRules(tagged, { minConfidence: 0.6 });
    const by = Object.fromEntries(l.map((x) => [(x.rule.condition as { text: string }).text, x]));
    expect(by.petrol.rule.category).toBe("Fuel");
    expect(by.petrol.support).toBe(3);
    expect(by.petrol.confidence).toBe(1);
    expect(by.shell.support).toBe(2);
    expect(by.tesco.rule.category).toBe("Groceries");
    expect(by.tesco.confidence).toBeCloseTo(2 / 3);
    expect(by.tesco.against).toBe(1);
    expect(by.amazon.coverage).toBe(1);
    expect(by.payment).toBeUndefined(); // filler words are skipped
    expect(by["tesco petrol"]).toBeUndefined(); // only one row
    expect(l[0].rule.source).toBe("learned");
    expect(l[0].examples.length).toBeGreaterThan(0);
  });

  it("respects confidence and skips rules that already exist", () => {
    const strict = learnRules(tagged);
    expect(strict.some((x) => (x.rule.condition as { text: string }).text === "tesco")).toBe(false);
    const existing: CatRule[] = [{ id: "p", condition: { kind: "contains", text: "Petrol" }, category: "fuel" }];
    expect(learnRules(tagged, { existing }).some((x) => (x.rule.condition as { text: string }).text === "petrol")).toBe(false);
    // the learned rules then categorise the tagged rows they came from
    const r = categorise(
      tagged.map((t) => ({ text: t.text })),
      strict.map((x) => x.rule),
    );
    expect(r.categories[3]).toBe("Fuel");
  });

  it("tokens", () => {
    expect(ruleTokens("Card payment to TESCO-Stores 2231 ref 99a")).toEqual(["tesco", "stores"]);
  });
});
