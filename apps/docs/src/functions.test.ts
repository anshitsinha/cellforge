import { describe, expect, it } from "vitest";
import { FUNCTION_INFO, FUNCTIONS, SPECIAL_NAMES } from "@cellforge/core";
import { ARRAY_FUNCTIONS, functionIndex, functionPages, GROUPS } from "./functions";

/** Every function the engine can run, whether defined in lib/ or handled by evaluate itself. */
const engine = [...Object.keys(FUNCTIONS), ...SPECIAL_NAMES].sort();
const pages = functionPages();
const headings = (md: string) => [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1]);

describe("the generated function reference", () => {
  it("has a page for every group", () => {
    expect(pages.map((p) => p.slug)).toEqual(GROUPS.map((g) => `functions-${g.key}`));
    for (const p of pages) expect(headings(p.markdown).length, p.slug).toBeGreaterThan(0);
  });

  it("has an entry for every function the engine supports, on exactly one page", () => {
    const documented = pages.flatMap((p) => headings(p.markdown)).sort();
    const missing = engine.filter((n) => !documented.includes(n));
    expect(missing, `functions with no reference entry: ${missing.join(", ")}`).toEqual([]);
    expect(documented).toEqual(engine); // and nothing twice, nothing made up
  });

  it("lists every function in the A to Z index", () => {
    const index = functionIndex().markdown;
    for (const n of engine) expect(index, n).toContain(`| [${n}](#/reference/`);
  });

  it("shows each function's signature, arguments, examples and notes", () => {
    const all = pages.map((p) => p.markdown).join("\n");
    for (const f of Object.values(FUNCTION_INFO)) {
      for (const a of f.args) expect(all, `${f.name} ${a.name}`).toContain("`" + a.name + "`");
      for (const [formula] of f.examples) expect(all, formula).toContain("`" + formula + "`");
      if (f.notes) expect(all).toContain(f.notes);
    }
  });

  it("only puts real functions on the array page", () => {
    for (const n of ARRAY_FUNCTIONS) expect(FUNCTION_INFO[n], n).toBeDefined();
  });
});
