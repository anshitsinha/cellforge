import { describe, expect, it } from "vitest";
import { FUNCTION_INFO } from "@cellforge/core";
import { DocIndex, functionPassages, passagesOf, stem } from "./docsearch";

// the same files the app searches, loaded the same way
const files = import.meta.glob(["../../../docs/guide/*.md", "../../../docs/tutorials/*.md"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const pages = Object.entries(files).map(([path, text]) => ({ file: path.replace(/^.*\/docs\//, ""), text }));
const index = new DocIndex([...pages.flatMap((p) => passagesOf(p.file, p.text)), ...functionPassages(FUNCTION_INFO)]);

const top = (q: string) => index.search(q, 3).map((h) => `${h.passage.file} ${h.passage.heading}`);

describe("asking the guide", () => {
  it("stems word forms together", () => {
    expect(stem("reconciling")).toBe(stem("reconciled"));
    expect(stem("duplicates")).toBe(stem("duplicate"));
  });

  it("splits pages into passages that know their commands", () => {
    const ps = passagesOf("guide/x.md", "# Title\n\nIntro.\n\n## Doing it\n\nUse **Reconcile two sheets…** then **Bank rec statement…**.\n");
    expect(ps.map((p) => p.heading)).toEqual(["", "Doing it"]);
    expect(ps[1].commands).toEqual(["Reconcile two sheets…", "Bank rec statement…"]);
  });

  it("finds the right page for everyday questions", () => {
    expect(top("how do I reconcile the bank to the ledger").join(" ")).toMatch(/reconciliation/);
    expect(top("find duplicate invoices").join(" ")).toMatch(/audit-tests|duplicates/i);
    expect(top("add a dropdown list to a column").join(" ")).toMatch(/data-validation/);
    expect(top("password protect a file before emailing it").join(" ")).toMatch(/sharing/);
    expect(top("record a macro and run it next month").join(" ")).toMatch(/recipes/);
    expect(top("vlookup").join(" ")).toMatch(/XLOOKUP|lookups/);
    expect(top("open a pdf bank statement").join(" ")).toMatch(/bank-statements/);
  });

  it("offers the commands a passage names", () => {
    const hits = index.search("reconcile two sheets", 5);
    expect(hits.some((h) => h.passage.commands.includes("Reconcile two sheets…"))).toBe(true);
    expect(index.search("the and of")).toEqual([]);
  });
});
