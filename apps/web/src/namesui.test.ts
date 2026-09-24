import { describe, expect, it } from "vitest";
import { nameProblem } from "./namesui";

describe("name checks before saving", () => {
  it("accepts ordinary names, including accented letters", () => {
    for (const n of ["Revenue", "Opening_balance", "_rate", "FY2026.Total", "Umsatz_ä"]) expect(nameProblem(n), n).toBeNull();
  });

  it("explains what's wrong with a bad name", () => {
    expect(nameProblem("  ")).toMatch(/Give it a name/);
    expect(nameProblem("Opening balance")).toMatch(/spaces/);
    expect(nameProblem("1st")).toMatch(/Start with a letter/);
    expect(nameProblem("Q1")).toMatch(/cell address/);
    expect(nameProblem("AB12")).toMatch(/cell address/);
    expect(nameProblem("R1C1")).toMatch(/cell address/);
  });
});
